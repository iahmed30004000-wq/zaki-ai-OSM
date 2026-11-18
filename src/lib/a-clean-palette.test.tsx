// @vitest-environment jsdom
import React from 'react';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  AUTO_DARK,
  AUTO_LIGHT,
  AUTO_THEME,
  DEFAULT_THEME,
  NEW_STAFF_THEME,
  SHEET_THEMES,
  SYSTEM_THEMES,
  SYS_VARS,
  THEME_CHOICES,
  hasDarkMenuOnLightPage,
  openingTheme,
  sanitizeTheme,
  themeByKey,
  themeStyle,
} from './system-themes';
import { DECOR_LEVELS, UNDECORATED, decorCss } from './theme-decoration';
import { SHAPES, shapeCss, shapeOf } from './theme-shape';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «نظيف» — THE FOURTEENTH PALETTE (R1, 18/11/2026) — ADDED, NOTHING MOVED.
 *
 * The Definition of Done of R1, as claims:
 *   1. it is a choice on the profile and persists through the one door that exists;
 *   2. its contrast is measured (the sweep in palette-contrast.test.ts runs over it too — no threshold moved);
 *   3. nobody else's palette changed by a digit — held here by a fingerprint of each of the thirteen older ones;
 *   4. the variable `--sys-danger`, which no palette ever defined, is gone;
 *   5. it is NOT the default, NOT an automatic pick, NOT the new staff's look (that flip is R5's), and it is
 *      not in the stylesheet — the frame writes it for the one person who chose it.
 * ═══════════════════════════════════════════════════════════════════════
 */

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const clean = () => themeByKey('clean');

/**
 * ── THE THIRTEEN OLDER PALETTES, BYTE FOR BYTE ──
 *
 * A fingerprint of (key, dark, every variable in name order) taken from `osm/main` before R1 touched the file —
 * the differential test the brief asks for, kept in the repo because CI has no `osm/main` to diff against.
 * It covers values and the dark flag, not the Arabic name or sentence (those are copy).
 *
 * TO CHANGE ONE ON PURPOSE (R5 retuning, a contrast fix): edit the palette, run this file, paste the new
 * fingerprint here with a dated comment saying which palette moved and why. Never to «make it pass».
 */
/*
 * 18/11/2026 (R4): the menu got five tokens of its own, added to EVERY palette. They are new names, not
 * changed values, so the print is taken over the names that existed before R4 and the thirteen prints below
 * did not move — which is itself the proof that no older value changed. The five are pinned in
 * `system-themes.test.ts` (menu contrast) instead.
 */
const R4_MENU_TOKENS = ['sidebar-muted', 'sidebar-border', 'sidebar-hover', 'sidebar-heading', 'sidebar-accent'];
const fingerprint = (t: { key: string; dark: boolean; vars: Record<string, string> }) =>
  createHash('sha256')
    .update(
      JSON.stringify([
        t.key,
        t.dark,
        Object.entries(t.vars)
          .filter(([n]) => !R4_MENU_TOKENS.includes(n))
          .sort(([a], [b]) => (a < b ? -1 : 1)),
      ])
    )
    .digest('hex')
    .slice(0, 16);

const OLDER: Record<string, string> = {
  ops: '906e6f5339f79dfc',
  day: '361a8c4ad3b5c79e',
  calm: '75efca6db04ccd27',
  cyber: '49ebd13e2f59d8d7',
  'islamic-epic': 'ed43850b5f7c44ee',
  'islamic-calm': '5e7d2bbb8c4c3e98',
  space: '12db9e96257a7d00',
  sea: '9a38561f1d913f31',
  city90: '5a4934d7a7ae3be3',
  'neon-coast': '9d20c94eb9a9d8e9',
  layl: '15deb4ff4e20cfa2',
  epic: '3af3685dcfacf20d',
  lux: 'd5d32e28c2bb566a',
};

describe('the thirteen older palettes did not move', () => {
  it('— there are thirteen of them, and «نظيف» is the fourteenth and the last', () => {
    expect(Object.keys(OLDER)).toHaveLength(13);
    expect(SYSTEM_THEMES.map((t) => t.key)).toEqual([...Object.keys(OLDER), 'clean']);
  });

  for (const [key, print] of Object.entries(OLDER)) {
    it(`${key}: every value is the one it had on main`, () => {
      expect(fingerprint(themeByKey(key)), `${key}: لوحة قديمة تغيّرت قيمها`).toBe(print);
    });
  }

  it('and the fingerprint can tell: one digit of one value is a different print', () => {
    const t = structuredClone(themeByKey('ops'));
    t.vars.primary = '#36B5CD';
    expect(fingerprint(t)).not.toBe(OLDER.ops);
    const u = structuredClone(themeByKey('lux'));
    u.dark = !u.dark;
    expect(fingerprint(u)).not.toBe(OLDER.lux);
  });
});

describe('«نظيف» is a choice on the profile', () => {
  it('is listed with an Arabic name and a plain sentence, after the other thirteen and before «تلقائي»', () => {
    const keys = THEME_CHOICES.map((c) => c.key);
    expect(keys.indexOf('clean')).toBe(13);
    expect(keys[keys.length - 1]).toBe(AUTO_THEME);
    const c = THEME_CHOICES.find((x) => x.key === 'clean')!;
    expect(c.ar).toBe('نظيف');
    expect(c.note.length).toBeGreaterThan(20);
    // Arabic only: no Latin word on a screen.
    expect(c.ar + c.note, 'كلمة لاتينية على الشاشة').not.toMatch(/[A-Za-z]/);
  });

  it('is accepted by the door that stores it — and an unknown key still falls back to the default', () => {
    expect(sanitizeTheme('clean')).toBe('clean');
    expect(openingTheme('clean', 'ops')).toBe('clean');
    expect(sanitizeTheme('cleen')).toBe(DEFAULT_THEME);
    expect(sanitizeTheme('Clean')).toBe(DEFAULT_THEME);
  });

  it('the door itself is the existing one — /api/profile/theme asks sanitizeTheme, and there is no second door', () => {
    const route = read('src/app/api/profile/theme/route.ts');
    expect(route).toContain('sanitizeTheme(body?.theme)');
    // R1 adds no route: the folder holds the one file.
    expect(readdirSync(join(root, 'src/app/api/profile/theme'))).toEqual(['route.ts']);
    expect(read('src/components/settings/ThemePicker.tsx')).toContain("'/api/profile/theme'");
  });
});

describe('«نظيف» is a light page with a dark menu, and it is measured', () => {
  const lum = (hex: string) => {
    const ch = (i: number) => {
      const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * ch(0) + 0.7152 * ch(1) + 0.0722 * ch(2);
  };
  const ratio = (a: string, b: string) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const v = () => clean().vars;

  it('is light for the content and the scheme of a native control', () => {
    expect(clean().dark).toBe(false);
    expect(themeStyle('clean')).toContain('color-scheme:light');
    expect(lum(v().background)).toBeGreaterThan(0.9);
    expect(v().card.toUpperCase()).toBe('#FFFFFF');
  });

  it('has a dark menu: the menu’s labels clear 4.5:1 on it, and it is darker than any text on the page', () => {
    expect(lum(v().sidebar)).toBeLessThan(0.05);
    expect(ratio(v()['sidebar-foreground'], v().sidebar)).toBeGreaterThanOrEqual(4.5);
    expect(lum(v().sidebar)).toBeLessThan(lum(v().foreground) + 0.02);
  });

  it('has its menu’s scrollbar thumb visible on the menu, and the page’s visible on the page', () => {
    expect(ratio(v()['sidebar-scrollbar'], v().sidebar)).toBeGreaterThan(1.3);
    expect(ratio(v()['sidebar-scrollbar-hover'], v().sidebar)).toBeGreaterThan(ratio(v()['sidebar-scrollbar'], v().sidebar));
    expect(ratio(v().scrollbar, v().background)).toBeGreaterThan(1.2);
  });

  it('keeps ONE action colour: the brand petrol, readable on the page, with white on it', () => {
    expect(v().primary.toUpperCase()).toBe('#1A6382');
    expect(ratio(v().primary, v().background)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(v()['primary-foreground'], v().primary)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(v().focus, v().background)).toBeGreaterThanOrEqual(3);
  });

  it('defines exactly the names every palette defines, each a six-digit colour (the depth aside)', () => {
    expect(Object.keys(v()).sort()).toEqual([...SYS_VARS].sort());
    for (const name of SYS_VARS) {
      if (name.startsWith('shadow')) continue;
      expect(v()[name], name).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it('is told apart from «نهاري» by something other than its menu: not a copy of the closest light palette', () => {
    const day = themeByKey('day').vars;
    const same = SYS_VARS.filter((n) => !n.startsWith('shadow') && day[n].toLowerCase() === v()[n].toLowerCase());
    // The brand's action colour and the three meanings are the SAME on purpose; the surfaces are not.
    for (const n of ['background', 'card', 'surface', 'border', 'sidebar', 'sidebar-foreground']) {
      expect(same, `${n} is day's value`).not.toContain(n);
    }
  });

  it('is recognised as light-with-a-dark-menu from its tokens — and no other palette is', () => {
    expect(hasDarkMenuOnLightPage(clean())).toBe(true);
    for (const t of SYSTEM_THEMES.filter((x) => x.key !== 'clean')) {
      expect(hasDarkMenuOnLightPage(t), `${t.key} reads as a light page with a dark menu`).toBe(false);
    }
    // And the test is about the tokens, not the key: a copy with a pale menu is not one.
    const pale = { ...clean(), vars: { ...clean().vars, sidebar: '#F5F7FA' } };
    expect(hasDarkMenuOnLightPage(pale)).toBe(false);
    expect(hasDarkMenuOnLightPage({ ...clean(), dark: true })).toBe(false);
  });
});

describe('«نظيف» is added, not adopted — nothing that exists changes appearance', () => {
  it('the default, the automatic pair and the new staff’s look are what they were', () => {
    expect(DEFAULT_THEME).toBe('ops');
    expect(AUTO_DARK).toBe('ops');
    expect(AUTO_LIGHT).toBe('day');
    expect(NEW_STAFF_THEME).toBe('layl');
  });

  it('is not in the stylesheet: the sheet carries the default and «تلقائي», and the frame writes «نظيف» for the one who chose it', () => {
    expect([...SHEET_THEMES]).toEqual(['ops', 'auto']);
    expect(themeStyle('clean')).toContain(`[data-sys-theme='clean']`);
    expect(themeStyle('clean')).toContain('--sys-sidebar:#1B2433');
    const css = read('src/app/(system)/system.css');
    expect(css).not.toContain(`[data-sys-theme='clean']`);
    expect(css).not.toMatch(/#1B2433/i);
  });
});

describe('«نظيف» has no decoration, by name and by test', () => {
  it('the list of themes that wear nothing is exactly «نظيف» — a second one joins only by editing this claim', () => {
    expect([...UNDECORATED]).toEqual(['clean']);
  });

  it('writes no ornament at any level, and no card shape', () => {
    for (const level of DECOR_LEVELS) expect(decorCss(clean(), level, 'clean'), level).toBe('');
    expect(shapeCss(clean())).toBe('');
    expect(shapeOf('clean')).toBe(SHAPES.clean);
    expect(SHAPES.clean.mark).toBe('');
    expect(SHAPES.clean.crown).toBe('none');
    expect(SHAPES.clean.frieze).toBeUndefined();
  });

  it('owns no picture on the disk', () => {
    const dir = join(root, 'public', 'brand', 'decor');
    expect(readdirSync(dir).filter((f) => f.startsWith('clean'))).toEqual([]);
  });

  it('and silence is not contagious: every other theme still draws, and «تلقائي» still wears its pair', () => {
    for (const t of SYSTEM_THEMES.filter((x) => x.key !== 'clean')) {
      expect(decorCss(t, 'light', t.key), t.key).not.toBe('');
    }
    expect(decorCss(themeByKey(AUTO_DARK), 'light', AUTO_THEME)).toContain('/brand/decor/ops.webp');
    expect(decorCss(themeByKey(AUTO_DARK), 'light', AUTO_THEME)).toContain('/brand/decor/day.webp');
  });
});

describe('the variable that was never defined is gone', () => {
  // Built from two halves so that this file does not contain the name it forbids.
  const NAME = '--sys-' + 'danger';
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) return walk(p);
      return /\.(tsx?|css|mjs)$/.test(n) ? [p] : [];
    });

  it('no source file reads or writes it', () => {
    const files = walk(join(root, 'src'));
    expect(files.length).toBeGreaterThan(500);
    const hits = files.filter((f) => !f.endsWith('a-clean-palette.test.tsx') && readFileSync(f, 'utf8').includes(NAME));
    expect(hits, `ما زال ${NAME} مستعملاً`).toEqual([]);
    // A walk over the whole of src/ reads ~2,500 files: give it room on a loaded machine (it took 42 s beside three other builds).
  }, 180_000);

  it('and the three places that used it now read the token every palette defines', () => {
    for (const f of [
      'src/components/screens/QueueHealthBoard.tsx',
      'src/components/screens/LeadsLane.tsx',
      'src/components/products/ProductAttributes.tsx',
    ]) {
      const src = read(f);
      expect(src, f).toContain('text-[var(--sys-destructive)]');
      expect(src, f).not.toContain(NAME);
    }
    expect([...SYS_VARS]).toContain('destructive');
    expect([...SYS_VARS]).not.toContain('danger');
  });
});

/**
 * ── THE PICKER — the profile screen’s own swatch ──
 *
 * The swatch is drawn from the palette's tokens (page, card, four dots). A light page with a dark menu would be
 * drawn as a white page and lie about half the screen, so «نظيف» draws its menu too — and nobody else does.
 */
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const apiFetch = vi.hoisted(() => vi.fn<(url: string, init: { method: string; body: string }) => Promise<{ ok: boolean }>>(async () => ({ ok: true })));
vi.mock('@/lib/api-client', () => ({ apiFetch }));

describe('the picker on the profile screen', () => {
  afterEach(() => {
    cleanup();
    apiFetch.mockClear();
  });

  it('offers fifteen buttons — fourteen palettes and «تلقائي» — and «نظيف» is one of them', async () => {
    const { ThemePicker } = await import('@/components/settings/ThemePicker');
    render(<ThemePicker initial={null} />);
    expect(screen.getByText('نظيف')).toBeTruthy();
    expect(THEME_CHOICES).toHaveLength(15);
    expect(document.querySelectorAll('section > div > button')).toHaveLength(15);
  });

  it('draws the dark menu in the swatch of «نظيف» only', async () => {
    const { ThemePicker } = await import('@/components/settings/ThemePicker');
    render(<ThemePicker initial={null} />);
    const menus = document.querySelectorAll('[data-swatch-menu]');
    expect(menus).toHaveLength(1);
    expect((menus[0] as HTMLElement).style.background.toLowerCase()).toMatch(/#1b2433|rgb\(27, 36, 51\)/);
    expect(menus[0].closest('button')!.textContent).toContain('نظيف');
  });

  it('choosing it applies the attribute at once and stores it through /api/profile/theme', async () => {
    const { ThemePicker } = await import('@/components/settings/ThemePicker');
    const frame = document.createElement('div');
    frame.setAttribute('data-sys-theme', 'ops');
    document.body.appendChild(frame);
    render(<ThemePicker initial="ops" />);
    fireEvent.click(screen.getByText('نظيف').closest('button')!);
    expect(frame.getAttribute('data-sys-theme')).toBe('clean');
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    const [url, init] = apiFetch.mock.calls[0];
    expect(url).toBe('/api/profile/theme');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ theme: 'clean' });
    frame.remove();
  });
});
