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
