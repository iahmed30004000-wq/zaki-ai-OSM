// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { handCategoriesFor, handMovementRefusal } from '@/lib/hand-movement-rules';

/**
 * «حركة جديدة» — THE DIALOG AND THE DOOR AGREE.
 *
 * A courier collection typed here was written a second time when its statement was approved. The dialog now
 * offers only the categories the door accepts for the chosen direction, switching direction keeps the pair
 * valid, and one short line under the box says where courier money is recorded.
 */

vi.mock('next/navigation', () => ({ usePathname: () => '/finance/wallets', useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));
vi.mock('@/components/ui/Confirm', () => ({ useConfirm: () => vi.fn(async () => true), useTell: () => vi.fn() }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ show: vi.fn(), push: vi.fn(), failed: vi.fn() }) }));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => <h1>المحافظ</h1> }));

import { WalletsScreen } from './WalletsScreen';

const WALLET = {
  id: 'w1', name: 'شام كاش دولار', currencyCode: 'USD', isActive: true, opening: 0, in: 0, out: 0, balance: 0,
  movements: 0, country: { id: 'c1', name: 'سوريا' }, openingCount: null,
};

let sent: { url: string; body: any }[] = [];

beforeEach(() => {
  sent = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      if ((init?.method ?? 'GET') !== 'GET') {
        sent.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
        return json({ movement: { id: 'm1' } }, 201);
      }
      if (url.includes('/movements')) return json({ movements: [] });
      return json({ wallets: [WALLET] });
    })
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openDialog() {
  render(<WalletsScreen />);
  fireEvent.click(await screen.findByText('حركة جديدة'));
  return screen.findByRole('dialog');
}

const optionsOf = (dialog: HTMLElement) =>
  within(dialog)
    .getAllByRole('option')
    .map((o) => (o as HTMLOptionElement).value);

describe('the category box', () => {
  it('opens on «صادر» offering expense, commission, adjustment and other — never a collection or a transfer', async () => {
    const dialog = await openDialog();
    expect(optionsOf(dialog)).toEqual(['COMMISSION', 'EXPENSE', 'ADJUSTMENT', 'OTHER']);
    expect(optionsOf(dialog)).toEqual(
      ['COMMISSION', 'EXPENSE', 'ADJUSTMENT', 'OTHER'].filter((c) => handCategoriesFor('OUT').includes(c))
    );
    expect((within(dialog).getByRole('combobox') as HTMLSelectElement).value).toBe('EXPENSE');
  });

  it('on «وارد» offers only adjustment and other, and moves off a category that cannot come in', async () => {
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'وارد' }));

    await waitFor(() => expect(optionsOf(dialog)).toEqual(['ADJUSTMENT', 'OTHER']));
    // «مصروف» was chosen and cannot be incoming: the pair moved to one the door accepts.
    expect((within(dialog).getByRole('combobox') as HTMLSelectElement).value).toBe('ADJUSTMENT');
  });

  it('coming back to «صادر» offers the expense again', async () => {
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'وارد' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'صادر' }));
    await waitFor(() => expect(optionsOf(dialog)).toContain('EXPENSE'));
  });

  it('says in one line where courier money is recorded', async () => {
    const dialog = await openDialog();
    expect(within(dialog).getByText(/تحصيل شركة الشحن لا يُكتب هنا/)).toBeTruthy();
    expect(within(dialog).getByText(/استلمت منه/)).toBeTruthy();
  });

  it('and every pair the dialog can send is a pair the door accepts', async () => {
    const dialog = await openDialog();
    for (const direction of ['وارد', 'صادر']) {
      fireEvent.click(within(dialog).getByRole('button', { name: direction }));
      const dir = direction === 'وارد' ? 'IN' : 'OUT';
      for (const category of optionsOf(dialog)) {
        expect(handMovementRefusal(category, dir), `${category} ${dir}`).toBeNull();
      }
    }
  });
});
