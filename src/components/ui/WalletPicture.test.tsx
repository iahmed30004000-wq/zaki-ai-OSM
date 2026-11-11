// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import React from 'react';
import { RiCoinsLine, RiMoneyDollarCircleLine, RiWallet3Line } from '@remixicon/react';
import { WALLET_ICON_KEYS, defaultWalletColorKey } from '@/lib/wallet-look';
import { WALLET_ICON_COMPONENT, WalletPicture, walletGlyph } from './WalletPicture';

/**
 * A WALLET'S FACE: THE OWNER'S PICTURE, OR THE ICON IN ITS COLOUR — drawn from `walletLook`, never decided here.
 *
 * What is held: the default face (nothing chosen) is the currency's icon in the id's colour; what was chosen wins; a picture
 * is an `<img>` with an EMPTY alt (the name is beside it) and falls back to the icon when it cannot load, and tries a new
 * address afresh; the face carries no word of its own; the colour is a theme variable, never a hex.
 */

afterEach(() => cleanup());

const KEY = 'companies/4f1c2a8e-7b3d-4e56-9a10-5c2d8e7f6a31/products/9d0e6b12-3c45-4f78-8a9b-0c1d2e3f4a5b/0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d.webp';
const KEY_2 = KEY.replace('0a1b2c3d', '1a1a1a1a');
const W = { id: '9d0e6b12-3c45-4f78-8a9b-0c1d2e3f4a5b', currencyCode: 'USD' };

const face = (container: HTMLElement) => container.querySelector('[data-wallet-picture]') as HTMLElement;

describe('the face of a wallet with nothing chosen', () => {
  it('is the icon its currency says, in the colour its id picks, with no picture and no word', () => {
    const { container } = render(<WalletPicture wallet={W} />);
    const el = face(container);
    expect(el.dataset.icon).toBe('dollar');
    expect(el.dataset.color).toBe(defaultWalletColorKey(W.id));
    expect(el.dataset.hasImage).toBe('false');
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('svg')).not.toBeNull();
    expect(el.textContent).toBe('');
  });

  it('wears the colour as a theme variable — never a hex, never a class of its own', () => {
    const { container } = render(<WalletPicture wallet={{ ...W, colorKey: 'warning' }} />);
    const el = face(container);
    const style = el.getAttribute('style') ?? '';
    expect(style).toContain('var(--sys-warning)');
    expect(style).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(el.className).not.toMatch(/\b(?:bg|text|border)-(?:red|green|blue|amber|violet|rose)/);
  });

  it('is decoration: hidden from a screen reader, since the name is always written beside it', () => {
    const { container } = render(<WalletPicture wallet={W} />);
    expect(face(container).getAttribute('aria-hidden')).toBe('true');
  });

  it('is the same face every time it is drawn, and two wallets of one currency are told apart by their colour', () => {
    const a = render(<WalletPicture wallet={W} />);
    const b = render(<WalletPicture wallet={W} />);
    expect(face(a.container).dataset.color).toBe(face(b.container).dataset.color);
    const colours = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6'].map((id) => {
      const { container } = render(<WalletPicture wallet={{ id, currencyCode: 'USD' }} />);
      return face(container).dataset.color;
    });
    expect(new Set(colours).size).toBeGreaterThan(2);
  });
});

describe('what was chosen wins', () => {
  it('an icon and a colour that were chosen replace the defaults', () => {
    const { container } = render(<WalletPicture wallet={{ ...W, iconKey: 'bank', colorKey: 'chart-3' }} />);
    expect(face(container).dataset.icon).toBe('bank');
    expect(face(container).dataset.color).toBe('chart-3');
  });

  it('an icon or a colour that is not allowed is drawn as if unset — never as nothing', () => {
    const { container } = render(<WalletPicture wallet={{ ...W, iconKey: 'rocket', colorKey: 'hotpink' }} />);
    expect(face(container).dataset.icon).toBe('dollar');
    expect(face(container).dataset.color).toBe(defaultWalletColorKey(W.id));
    expect(face(container).querySelector('svg')).not.toBeNull();
  });

  it('every icon key of the list has its own component', () => {
    const seen = new Set<unknown>();
    for (const key of WALLET_ICON_KEYS) {
      expect(typeof WALLET_ICON_COMPONENT[key], key).toBe('function');
      seen.add(WALLET_ICON_COMPONENT[key]);
    }
    expect(seen.size).toBe(WALLET_ICON_KEYS.length);
    for (const key of WALLET_ICON_KEYS) {
      const { container } = render(<WalletPicture wallet={{ ...W, iconKey: key }} />);
      expect(face(container).dataset.icon).toBe(key);
      expect(face(container).querySelector('svg'), key).not.toBeNull();
    }
  });

  it('the glyph of a currency is still answered by the old name: a dollar, coins, a wallet', () => {
    expect(walletGlyph('USD')).toBe(RiMoneyDollarCircleLine);
    expect(walletGlyph('SYP')).toBe(RiCoinsLine);
    expect(walletGlyph('DINAR')).toBe(RiWallet3Line);
  });
});

describe('the picture', () => {
  it('is an <img> with an EMPTY alt, served from the media door, lazy, covering the face', () => {
    const { container } = render(<WalletPicture wallet={{ ...W, imageKey: KEY, iconKey: 'bank' }} />);
    const el = face(container);
    const img = el.querySelector('img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe(`/api/media/${KEY}`);
    expect(img.getAttribute('alt')).toBe('');
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(el.dataset.hasImage).toBe('true');
    // The icon is not drawn under it, but the colour stays as the picture's edge.
    expect(el.querySelector('svg')).toBeNull();
    expect(el.getAttribute('style')).toContain('border-color');
    expect(el.textContent).toBe('');
  });

  it('NEGATIVE: a value that is not a key of ours (a URL, a path) is never put in an <img>', () => {
    for (const imageKey of ['https://example.com/logo.png', '/api/media/' + KEY, '../../x.png', 'javascript:alert(1)']) {
      const { container, unmount } = render(<WalletPicture wallet={{ ...W, imageKey }} />);
      expect(container.querySelector('img'), imageKey).toBeNull();
      expect(face(container).querySelector('svg')).not.toBeNull();
      unmount();
    }
  });

  it('falls back to the icon in the colour when it will not load — and a NEW picture is tried afresh', () => {
    const { container, rerender } = render(<WalletPicture wallet={{ ...W, imageKey: KEY, iconKey: 'bank', colorKey: 'success' }} />);
    fireEvent.error(container.querySelector('img') as HTMLImageElement);
    const el = face(container);
    expect(el.querySelector('img')).toBeNull();
    expect(el.dataset.hasImage).toBe('false');
    expect(el.dataset.icon).toBe('bank');
    expect(el.dataset.color).toBe('success');
    expect(el.querySelector('svg')).not.toBeNull();

    // The same address stays failed on a redraw; another address is a new chance.
    rerender(<WalletPicture wallet={{ ...W, imageKey: KEY, iconKey: 'bank', colorKey: 'success' }} />);
    expect(container.querySelector('img')).toBeNull();
    rerender(<WalletPicture wallet={{ ...W, imageKey: KEY_2, iconKey: 'bank', colorKey: 'success' }} />);
    expect((container.querySelector('img') as HTMLImageElement).getAttribute('src')).toBe(`/api/media/${KEY_2}`);
  });
});

describe('the size', () => {
  it('is 32 in a chip or a row, 44 on a card and 64 in the editor — a square, set in pixels', () => {
    for (const [size, px] of [['sm', 32], ['md', 44], ['lg', 64]] as const) {
      const { container, unmount } = render(<WalletPicture wallet={W} size={size} />);
      const el = face(container);
      expect(el.style.width, size).toBe(`${px}px`);
      expect(el.style.height, size).toBe(`${px}px`);
      unmount();
    }
    const { container } = render(<WalletPicture wallet={W} />);
    expect(face(container).style.width).toBe('44px');
  });
});
