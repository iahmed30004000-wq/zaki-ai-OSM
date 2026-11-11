// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { RiCoinsLine, RiMoneyDollarCircleLine, RiWallet3Line } from '@remixicon/react';
import { WalletChip, walletGlyph } from './WalletChip';

/**
 * A WALLET AS A THING YOU TOUCH: the name, «البلد · العملة», what is in it, and a glyph chosen in one place.
 */

afterEach(() => cleanup());

const W = { id: 'w1', name: 'صندوق الدولار', currencyCode: 'USD', balance: 1234.5, country: { name: 'سوريا' } };

describe('the chip', () => {
  it('says the name, the country and the currency, and what is in it', () => {
    render(<WalletChip wallet={W} selected={false} onPick={() => {}} />);
    const chip = screen.getByRole('button');
    expect(chip.textContent).toContain('صندوق الدولار');
    expect(chip.textContent).toContain('سوريا · USD');
    expect(chip.textContent).toContain('1,234.50 USD');
  });

  it('says nothing about a balance the viewer is not shown, and no stray dot without a country', () => {
    render(<WalletChip wallet={{ id: 'w2', name: 'صندوق', currencyCode: 'JOD' }} selected={false} onPick={() => {}} />);
    const chip = screen.getByRole('button');
    expect(chip.textContent).toBe('صندوقJOD');
    expect(chip.textContent).not.toContain('·');
  });

  it('is pressed when it is the chosen one — in words for a screen reader, not in colour alone', () => {
    const { rerender } = render(<WalletChip wallet={W} selected={false} onPick={() => {}} />);
    expect(screen.getByRole('button').getAttribute('aria-pressed')).toBe('false');
    rerender(<WalletChip wallet={W} selected onPick={() => {}} />);
    const chip = screen.getByRole('button');
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    expect(chip.className).toContain('font-semibold');
  });

  it('hands back its own id when it is pressed, and is never a submit button', () => {
    const onPick = vi.fn();
    render(<WalletChip wallet={W} selected={false} onPick={onPick} />);
    const chip = screen.getByRole('button') as HTMLButtonElement;
    expect(chip.type).toBe('button');
    fireEvent.click(chip);
    expect(onPick).toHaveBeenCalledWith('w1');
  });

  it('a chip the other end already holds cannot be pressed', () => {
    const onPick = vi.fn();
    render(<WalletChip wallet={W} selected={false} disabled onPick={onPick} />);
    const chip = screen.getByRole('button') as HTMLButtonElement;
    expect(chip.disabled).toBe(true);
    fireEvent.click(chip);
    expect(onPick).not.toHaveBeenCalled();
  });

  it('is a 44px target on a phone and gives the height back on a desk', () => {
    render(<WalletChip wallet={W} selected={false} onPick={() => {}} />);
    const cls = screen.getByRole('button').className;
    expect(cls).toContain('min-h-11');
    expect(cls).toContain('md:min-h-0');
  });
});

describe('the chip wears the wallet’s own face', () => {
  const KEY = 'companies/4f1c2a8e-7b3d-4e56-9a10-5c2d8e7f6a31/products/9d0e6b12-3c45-4f78-8a9b-0c1d2e3f4a5b/0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d.webp';
  const faceOf = () => screen.getByRole('button').querySelector('[data-wallet-picture]') as HTMLElement;

  it('draws a face beside the name: the currency’s icon in a colour from its id, when nothing was chosen', () => {
    render(<WalletChip wallet={W} selected={false} onPick={() => {}} />);
    expect(faceOf().dataset.icon).toBe('dollar');
    expect(faceOf().style.width).toBe('32px');
    // A face is not a word: the chip still says exactly what it said.
    expect(screen.getByRole('button').textContent).toContain('صندوق الدولار');
  });

  it('wears what was chosen — the icon and the colour — and two wallets are told apart at a glance', () => {
    const { rerender } = render(<WalletChip wallet={{ ...W, iconKey: 'bank', colorKey: 'warning' }} selected={false} onPick={() => {}} />);
    expect(faceOf().dataset.icon).toBe('bank');
    expect(faceOf().dataset.color).toBe('warning');
    rerender(<WalletChip wallet={{ ...W, id: 'w9', iconKey: 'crypto', colorKey: 'chart-3' }} selected={false} onPick={() => {}} />);
    expect(faceOf().dataset.icon).toBe('crypto');
    expect(faceOf().dataset.color).toBe('chart-3');
  });

  it('shows the picture when there is one, and falls back to the icon when it will not load', () => {
    render(<WalletChip wallet={{ ...W, imageKey: KEY, iconKey: 'card', colorKey: 'success' }} selected={false} onPick={() => {}} />);
    const img = faceOf().querySelector('img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe(`/api/media/${KEY}`);
    expect(img.getAttribute('alt')).toBe('');
    fireEvent.error(img);
    expect(faceOf().querySelector('img')).toBeNull();
    expect(faceOf().dataset.icon).toBe('card');
    expect(faceOf().dataset.color).toBe('success');
  });

  it('pressing the face presses the chip — the face is not a control of its own', () => {
    const onPick = vi.fn();
    render(<WalletChip wallet={W} selected={false} onPick={onPick} />);
    fireEvent.click(faceOf());
    expect(onPick).toHaveBeenCalledWith('w1');
  });
});

describe('the glyph, chosen in one place', () => {
  it('a dollar for dollars, coins for any other currency, a wallet for a code that is not one', () => {
    expect(walletGlyph('USD')).toBe(RiMoneyDollarCircleLine);
    expect(walletGlyph(' usd ')).toBe(RiMoneyDollarCircleLine);
    expect(walletGlyph('SYP')).toBe(RiCoinsLine);
    expect(walletGlyph('JOD')).toBe(RiCoinsLine);
    expect(walletGlyph('')).toBe(RiWallet3Line);
    expect(walletGlyph('DINAR')).toBe(RiWallet3Line);
  });
});
