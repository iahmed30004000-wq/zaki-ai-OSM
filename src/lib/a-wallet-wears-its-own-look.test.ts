import { describe, expect, it } from 'vitest';
import { SYSTEM_THEMES, SYS_VARS } from './system-themes';
import {
  WALLET_COLOR_KEYS,
  WALLET_ICON_KEYS,
  WALLET_ICON_LABEL,
  WALLET_IMAGE_BAD_TYPE,
  WALLET_IMAGE_NOT_OURS,
  WALLET_IMAGE_TOO_BIG,
  defaultWalletColorKey,
  defaultWalletIconKey,
  isOwnWalletImageKey,
  isWalletImageKey,
  parseWalletImageKey,
  walletColorVar,
  walletLook,
} from './wallet-look';

/**
 * «كل محفظة لازم تكون مميزة» — A WALLET WEARS A LOOK, AND ONE FUNCTION SAYS WHICH.
 *
 * What these hold:
 *   · the allowed lists are what the brief named, and every colour is a variable EVERY theme declares (nothing invented);
 *   · what is set wins; what is not set — or is not allowed — falls back to the default and never fails;
 *   · the default is STABLE (the same id, the same colour) and SPREAD (a defensible share of any two wallets differ);
 *   · a picture is only ever a key of the shape the door writes, and OWN only for this company and this wallet.
 */

const COMPANY = '4f1c2a8e-7b3d-4e56-9a10-5c2d8e7f6a31';
const WALLET = '9d0e6b12-3c45-4f78-8a9b-0c1d2e3f4a5b';
const FILE = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d.webp';
const KEY = `companies/${COMPANY}/products/${WALLET}/${FILE}`;

/** A deterministic stream of v4-shaped ids (xorshift32), so «a sample of 200» is the same 200 on every machine. */
function sampleIds(n: number): string[] {
  let s = 0x9e3779b9 | 0;
  const next = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return s >>> 0;
  };
  const hex = (len: number) => Array.from({ length: len }, () => ((next() >>> 8) & 15).toString(16)).join('');
  return Array.from({ length: n }, () => `${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}`);
}

describe('the lists a wallet may choose from', () => {
  it('the icons are the seven the owner named and two more, each with a name a person can hear', () => {
    for (const key of ['cash', 'bank', 'wallet', 'coins', 'crypto', 'phone', 'card', 'dollar']) {
      expect(WALLET_ICON_KEYS as readonly string[]).toContain(key);
    }
    expect(WALLET_ICON_KEYS.length).toBeGreaterThanOrEqual(8);
    expect(WALLET_ICON_KEYS.length).toBeLessThanOrEqual(10);
    expect(new Set(WALLET_ICON_KEYS).size).toBe(WALLET_ICON_KEYS.length);
    for (const key of WALLET_ICON_KEYS) expect(WALLET_ICON_LABEL[key], key).toMatch(/[؀-ۿ]/);
  });

  it('the colours are six to eight, the four named hues among them, no repeats', () => {
    expect(WALLET_COLOR_KEYS.length).toBeGreaterThanOrEqual(6);
    expect(WALLET_COLOR_KEYS.length).toBeLessThanOrEqual(8);
    expect(new Set(WALLET_COLOR_KEYS).size).toBe(WALLET_COLOR_KEYS.length);
    for (const key of ['success', 'primary', 'warning', 'destructive']) {
      expect(WALLET_COLOR_KEYS as readonly string[]).toContain(key);
    }
  });

  it('NOTHING IS INVENTED: every colour is a `--sys-*` variable that every theme declares', () => {
    expect(SYSTEM_THEMES.length).toBeGreaterThan(5);
    for (const key of WALLET_COLOR_KEYS) {
      expect(SYS_VARS as readonly string[], `--sys-${key} is not a variable of the system theme`).toContain(key);
      for (const theme of SYSTEM_THEMES) {
        expect(theme.vars[key], `--sys-${key} is missing from the theme «${theme.key}»`).toMatch(/\S/);
      }
      expect(walletColorVar(key)).toBe(`var(--sys-${key})`);
    }
  });

  it('and the eight are TOLD APART in every theme: no two are the same colour, and in the default theme none is close', () => {
    // CIE76: the distance between two colours in Lab. About 2 is the least a trained eye sees; below 5 two dots read as one.
    const lab = (hex: string): [number, number, number] => {
      expect(hex).toMatch(/^#[0-9a-f]{6}$/i);
      const lin = (i: number) => {
        const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
        return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      };
      const [r, g, b] = [lin(0), lin(1), lin(2)];
      const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
      const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
      const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
      const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
      return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
    };
    const closest = (theme: (typeof SYSTEM_THEMES)[number]) => {
      let worst = { d: Infinity, pair: '' };
      for (let i = 0; i < WALLET_COLOR_KEYS.length; i++) {
        for (let j = i + 1; j < WALLET_COLOR_KEYS.length; j++) {
          const a = lab(theme.vars[WALLET_COLOR_KEYS[i]]);
          const b = lab(theme.vars[WALLET_COLOR_KEYS[j]]);
          const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
          if (d < worst.d) worst = { d, pair: `${WALLET_COLOR_KEYS[i]} ~ ${WALLET_COLOR_KEYS[j]}` };
        }
      }
      return worst;
    };
    for (const theme of SYSTEM_THEMES) {
      const { d, pair } = closest(theme);
      // Measured: the closest pair of the eight is 7.6 apart in the worst theme (`layl`), and the first pick (`chart-2`)
      // was 0 apart from `primary` in two. A swap that brings two of them together again fails here, by name.
      expect(d, `in the theme «${theme.key}» ${pair} are only ${d.toFixed(1)} apart`).toBeGreaterThan(7);
    }
    expect(closest(SYSTEM_THEMES.find((t) => t.key === 'ops')!).d).toBeGreaterThan(20);
  });

  it('the sentences the screen and the door both say are Arabic', () => {
    for (const sentence of [WALLET_IMAGE_BAD_TYPE, WALLET_IMAGE_TOO_BIG, WALLET_IMAGE_NOT_OURS]) {
      expect(sentence).toMatch(/[؀-ۿ]/);
    }
  });
});

describe('what a wallet wears when nobody chose', () => {
  it('the icon is the one its currency says: a dollar for dollars, coins for any other code of three letters, a wallet otherwise', () => {
    expect(defaultWalletIconKey('USD')).toBe('dollar');
    expect(defaultWalletIconKey(' usd ')).toBe('dollar');
    expect(defaultWalletIconKey('SYP')).toBe('coins');
    expect(defaultWalletIconKey('JOD')).toBe('coins');
    expect(defaultWalletIconKey('')).toBe('wallet');
    expect(defaultWalletIconKey('DINAR')).toBe('wallet');
    expect(defaultWalletIconKey('USDT')).toBe('wallet');
    expect(defaultWalletIconKey(null)).toBe('wallet');
    expect(defaultWalletIconKey(undefined)).toBe('wallet');
  });

  it('the colour is STABLE: the same id gives the same colour, every time, and it is one of the allowed ones', () => {
    for (const id of sampleIds(50)) {
      const first = defaultWalletColorKey(id);
      expect(WALLET_COLOR_KEYS as readonly string[]).toContain(first);
      for (let i = 0; i < 5; i++) expect(defaultWalletColorKey(id)).toBe(first);
    }
    expect(defaultWalletColorKey('')).toBe(defaultWalletColorKey(''));
    expect(WALLET_COLOR_KEYS as readonly string[]).toContain(defaultWalletColorKey(undefined));
  });

  it('the colour is SPREAD: over 200 ids every colour is used, none hogs the list, and about one pair in eight shares one', () => {
    const colours = sampleIds(200).map(defaultWalletColorKey);
    const used = new Map<string, number>();
    for (const c of colours) used.set(c, (used.get(c) ?? 0) + 1);
    // 200 ids over eight colours is 25 each; three standard deviations either side is 10 to 40.
    for (const key of WALLET_COLOR_KEYS) {
      const n = used.get(key) ?? 0;
      expect(n, `${key} was given to ${n} of 200 wallets`).toBeGreaterThanOrEqual(10);
      expect(n, `${key} was given to ${n} of 200 wallets`).toBeLessThanOrEqual(40);
    }
    let same = 0;
    let pairs = 0;
    for (let i = 0; i < colours.length; i++) {
      for (let j = i + 1; j < colours.length; j++) {
        pairs++;
        if (colours[i] === colours[j]) same++;
      }
    }
    // A fair draw of eight is 12.5%; a hash that ignored the id would be 100%, one that read a prefix of it far above 16%.
    expect(same / pairs).toBeGreaterThan(0.09);
    expect(same / pairs).toBeLessThan(0.16);
  });

  it('plain short ids, the kind a test or an old row has, are told apart too', () => {
    const colours = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6'].map(defaultWalletColorKey);
    expect(new Set(colours).size).toBeGreaterThan(2);
  });
});

describe('walletLook — what is set wins, what is not falls back', () => {
  const base = { id: WALLET, currencyCode: 'USD' };

  it('a wallet with nothing set has no picture, the icon of its currency and a colour from its id', () => {
    const look = walletLook(base);
    expect('image' in look).toBe(false);
    expect(look.icon).toBe('dollar');
    expect(look.color).toBe(defaultWalletColorKey(WALLET));
    // null is «nothing», exactly like absent.
    expect(walletLook({ ...base, imageKey: null, iconKey: null, colorKey: null })).toEqual(look);
  });

  it('what was chosen wins over the default, each part on its own', () => {
    expect(walletLook({ ...base, iconKey: 'bank' }).icon).toBe('bank');
    expect(walletLook({ ...base, iconKey: 'bank' }).color).toBe(defaultWalletColorKey(WALLET));
    expect(walletLook({ ...base, colorKey: 'warning' }).color).toBe('warning');
    expect(walletLook({ ...base, colorKey: 'warning' }).icon).toBe('dollar');
    expect(walletLook({ ...base, imageKey: KEY })).toEqual({
      image: `/api/media/${KEY}`,
      icon: 'dollar',
      color: defaultWalletColorKey(WALLET),
    });
  });

  it('an icon or a colour that is not allowed is treated as unset — a wallet always has both', () => {
    const look = walletLook({ ...base, currencyCode: 'SYP', iconKey: 'rocket', colorKey: 'hotpink' });
    expect(look.icon).toBe('coins');
    expect(look.color).toBe(defaultWalletColorKey(WALLET));
    expect(walletLook({ ...base, iconKey: '', colorKey: '' }).icon).toBe('dollar');
  });

  it('a picture is drawn only when its key is the shape the door writes — never a URL or a path', () => {
    for (const bad of [
      'https://example.com/logo.png',
      '//example.com/logo.png',
      `/api/media/${KEY}`,
      `companies/${COMPANY}/products/${WALLET}/../../x/${FILE}`,
      `companies/${COMPANY}/products/${WALLET}/logo.png`,
      `companies/${COMPANY}/products/${WALLET}/${FILE.replace('.webp', '.svg')}`,
      `companies/${COMPANY}/${WALLET}/${FILE}`,
      `javascript:alert(1)`,
      '',
    ]) {
      expect('image' in walletLook({ ...base, imageKey: bad }), bad).toBe(false);
    }
  });

  it('two different wallets of one currency are told apart by their colour (the default makes them differ at once)', () => {
    const [a, b, c] = ['9d0e6b12-3c45-4f78-8a9b-0c1d2e3f4a5b', '1b2c3d4e-5f60-4a71-8b82-93a4b5c6d7e8', 'ffeeddcc-bbaa-4998-8776-655443322110'];
    const looks = [a, b, c].map((id) => walletLook({ id, currencyCode: 'USD' }).color);
    expect(new Set(looks).size).toBeGreaterThan(1);
  });
});

describe('the key of a picture', () => {
  it('is `companies/{company}/products/{wallet}/{uuid}.{webp|png|jpg}`, taken apart', () => {
    expect(parseWalletImageKey(KEY)).toEqual({ companyId: COMPANY, walletId: WALLET, file: FILE });
    expect(isWalletImageKey(KEY.replace('.webp', '.png'))).toBe(true);
    expect(isWalletImageKey(KEY.replace('.webp', '.jpg'))).toBe(true);
  });

  it('is OWN only for the company and the wallet it was written for', () => {
    expect(isOwnWalletImageKey(KEY, { companyId: COMPANY, walletId: WALLET })).toBe(true);
    // Another company's folder — the cross-tenant case.
    expect(isOwnWalletImageKey(KEY, { companyId: 'other-company', walletId: WALLET })).toBe(false);
    // Another wallet's folder, even in the same company: a product's or the shop's picture is not a wallet's.
    expect(isOwnWalletImageKey(KEY, { companyId: COMPANY, walletId: 'another-wallet' })).toBe(false);
  });

  it('NEGATIVE: a URL, a path, a dot segment, a backslash, a wrong depth, a wrong file name and a non-string are no key at all', () => {
    const own = { companyId: COMPANY, walletId: WALLET };
    for (const bad of [
      `https://example.com/${KEY}`,
      `/api/media/${KEY}`,
      `/${KEY}`,
      `${KEY}/`,
      `${KEY}?x=1`,
      `${KEY}#frag`,
      `companies/${COMPANY}/products/${WALLET}/../${WALLET}/${FILE}`,
      `companies/${COMPANY}/products/./${FILE}`,
      `companies\\${COMPANY}\\products\\${WALLET}\\${FILE}`,
      `companies/${COMPANY}/products/${WALLET}/sub/${FILE}`,
      `companies/${COMPANY}/products/${WALLET}/${FILE.toUpperCase()}`,
      `companies/${COMPANY}/products/${WALLET}/not-a-uuid.webp`,
      `companies/${COMPANY}/products/${WALLET}/${FILE}.exe`,
      `companies/${COMPANY}/landing/${WALLET}/${FILE}`,
      `x/${COMPANY}/products/${WALLET}/${FILE}`,
      `companies/${'a'.repeat(80)}/products/${WALLET}/${FILE}`,
      `${KEY}${'x'.repeat(200)}`,
      '',
      null,
      undefined,
      42,
      {},
    ]) {
      expect(isWalletImageKey(bad), String(bad)).toBe(false);
      expect(isOwnWalletImageKey(bad, own), String(bad)).toBe(false);
    }
  });
});
