// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { defaultWalletColorKey } from '@/lib/wallet-look';

/**
 * «كل محفظة لازم تكون مميزة» — THE TRANSFER SCREEN NAMES A WALLET BY ITS FACE: IN THE CHIPS AND IN THE HISTORY.
 *
 * The two ends of a transfer are picked by looking, and the girl recognises «بينانس» by its picture before she reads its
 * name. So each chip carries the wallet's face, and each end of a row of «آخر التحويلات» carries it too (the history is
 * answered with the three fields of the look — see `the-history-names-each-wallet-with-its-look.test.ts`).
 *
 * What is held: the face is the one `walletLook` gives (the choice when there is one, the default when there is not),
 * the chip still says what it said and is still a button of its own, and the history names the same wallet with the same
 * face — and a transfer whose wallet is gone still reads as a dash.
 */

const { apiJson, phone } = vi.hoisted(() => ({ apiJson: vi.fn(), phone: { value: false } }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a) }));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => <h1>العنوان</h1> }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => phone.value }));

import { TransfersScreen } from './TransfersScreen';

const COMPANY = '4f1c2a8e-7b3d-4e56-9a10-5c2d8e7f6a31';
const PIC = `companies/${COMPANY}/products/w-bin/0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d.webp`;
const SYRIA = { id: 'SY', name: 'سوريا', minorUnit: 2 };

const wallet = (over: Record<string, unknown>) => ({
  isActive: true, balance: 0, countryId: 'SY', storeId: 'sA', store: { id: 'sA', name: 'متجر دمشق' }, country: SYRIA,
  imageKey: null, iconKey: null, colorKey: null, ...over,
});
const BINANCE = wallet({ id: 'w-bin', name: 'بينانس', currencyCode: 'USDT', imageKey: PIC, iconKey: 'crypto', colorKey: 'warning' });
const CASH = wallet({ id: 'w-cash', name: 'صندوق الدولار', currencyCode: 'USD' });
const BANK = wallet({ id: 'w-bank', name: 'حساب البنك', currencyCode: 'USD', iconKey: 'bank', colorKey: 'chart-3' });

const end = (w: Record<string, unknown>) => ({
  id: w.id, name: w.name, currencyCode: w.currencyCode, store: { name: 'متجر دمشق' },
  imageKey: w.imageKey, iconKey: w.iconKey, colorKey: w.colorKey,
});
const TRANSFER = {
  id: 't1', amountOut: 50, amountIn: 50, exchangeRate: 1, note: 'سحب', createdAt: '2026-11-11T08:00:00.000Z',
  kindLabel: 'تحويل داخلي', from: end(BINANCE), to: end(BANK),
};

beforeEach(() => {
  vi.clearAllMocks();
  phone.value = false;
  apiJson.mockImplementation(async (url: string) =>
    String(url).includes('/transfers') ? { transfers: [TRANSFER] } : { wallets: [BINANCE, CASH, BANK] }
  );
});
afterEach(() => cleanup());

const draw = async () => {
  render(<TransfersScreen />);
  await screen.findByRole('group', { name: 'من محفظة' });
  await screen.findAllByRole('button', { name: /بينانس/ });
};
const faceIn = (el: Element) => el.querySelector('[data-wallet-picture]') as HTMLElement;

describe('the chips', () => {
  it('each chip wears the face of its wallet — the choice when there is one, the default when there is not', async () => {
    await draw();
    const from = within(screen.getByRole('group', { name: 'من محفظة' }));
    const binance = from.getByRole('button', { name: /بينانس/ });
    expect(faceIn(binance).dataset.icon).toBe('crypto');
    expect(faceIn(binance).dataset.color).toBe('warning');
    expect((faceIn(binance).querySelector('img') as HTMLImageElement).getAttribute('src')).toBe(`/api/media/${PIC}`);

    const cash = from.getByRole('button', { name: /صندوق الدولار/ });
    expect(faceIn(cash).dataset.icon).toBe('dollar');
    expect(faceIn(cash).dataset.color).toBe(defaultWalletColorKey('w-cash'));
    expect(faceIn(cash).querySelector('img')).toBeNull();

    const bank = from.getByRole('button', { name: /حساب البنك/ });
    expect(faceIn(bank).dataset.icon).toBe('bank');
    expect(faceIn(bank).dataset.color).toBe('chart-3');
  });

  it('the «إلى» side wears the same faces, and a chip is still one button that picks its wallet', async () => {
    await draw();
    const to = within(screen.getByRole('group', { name: 'إلى محفظة' }));
    expect(faceIn(to.getByRole('button', { name: /بينانس/ })).dataset.icon).toBe('crypto');
    fireEvent.click(to.getByRole('button', { name: /صندوق الدولار/ }));
    expect(to.getByRole('button', { name: /صندوق الدولار/ }).getAttribute('aria-pressed')).toBe('true');
  });

  it('a picture that will not load falls back to the icon in the colour, in the chip', async () => {
    await draw();
    const binance = within(screen.getByRole('group', { name: 'من محفظة' })).getByRole('button', { name: /بينانس/ });
    fireEvent.error(binance.querySelector('img') as HTMLImageElement);
    expect(binance.querySelector('img')).toBeNull();
    expect(faceIn(binance).dataset.icon).toBe('crypto');
    expect(faceIn(binance).dataset.color).toBe('warning');
  });
});

describe('the history', () => {
  it('names each end of a transfer by the same face as its chip, beside the name and the store', async () => {
    await draw();
    const row = (await screen.findAllByText('سحب'))[0].closest('tr') as HTMLElement;
    const faces = row.querySelectorAll('[data-wallet-picture]');
    expect(faces).toHaveLength(2);
    expect((faces[0] as HTMLElement).dataset.icon).toBe('crypto');
    expect((faces[0] as HTMLElement).dataset.hasImage).toBe('true');
    expect((faces[1] as HTMLElement).dataset.icon).toBe('bank');
    expect((faces[1] as HTMLElement).dataset.color).toBe('chart-3');
    expect((faces[0] as HTMLElement).style.width).toBe('32px');
    // The words of the row are the words it had.
    expect(row.textContent).toContain('بينانس');
    expect(row.textContent).toContain('حساب البنك');
    expect(row.textContent).toContain('متجر دمشق');
  });

  it('a transfer whose wallet is gone still reads as a dash, with no face', async () => {
    apiJson.mockImplementation(async (url: string) =>
      String(url).includes('/transfers') ? { transfers: [{ ...TRANSFER, to: null }] } : { wallets: [BINANCE, CASH, BANK] }
    );
    await draw();
    const row = (await screen.findAllByText('سحب'))[0].closest('tr') as HTMLElement;
    expect(row.querySelectorAll('[data-wallet-picture]')).toHaveLength(1);
    expect(row.textContent).toContain('—');
  });

  it('a phone card draws the faces too', async () => {
    phone.value = true;
    await draw();
    const card = (await screen.findAllByText('سحب'))[0].closest('li, article, div[class*="rounded"]') as HTMLElement;
    expect(card.querySelectorAll('[data-wallet-picture]').length).toBeGreaterThanOrEqual(2);
  });
});
