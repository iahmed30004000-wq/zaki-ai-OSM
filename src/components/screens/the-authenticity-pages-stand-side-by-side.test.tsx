// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const here = { path: '/settings/authenticity' };
vi.mock('next/navigation', () => ({ usePathname: () => here.path, useSearchParams: () => new URLSearchParams() }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/components/shell/ScreenGuide', () => ({ GuideButton: () => null }));
vi.mock('@/lib/db', () => ({ db: {} }));
vi.mock('@/components/settings/AuthenticityCodesCard', () => ({ AuthenticityCodesCard: () => <div data-card="AuthenticityCodesCard" /> }));
vi.mock('@/components/settings/PostOrderOfferCard', () => ({ PostOrderOfferCard: () => <div data-card="PostOrderOfferCard" /> }));

import { AuthenticityScreen } from './AuthenticityScreen';
import { SystemSettingsScreen } from './SystemSettingsScreen';
import { ICONS } from '@/components/shell/icons';
import { NAV, ALL_ROUTES, findRoute, canAccessRoute } from '@/lib/route-registry';
import { GUIDED_PATHS } from '@/lib/route-guide';
import { GUIDE_TEXTS } from '@/lib/route-guide-texts';
import { SETTINGS_CARDS } from '@/lib/settings-home';
import { attachGrants, can } from '@/lib/authorization';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «رموز الأصالة» AND «باركود المنتجات» — TWO PAGES, SIDE BY SIDE (25/11, the owner)
 *
 *  1. Both are registry routes on exactly `settings.view` (the key of «إعدادات النظام», where the codes card came from),
 *     adjacent, right after «إعدادات النظام» in «الإدارة», each with a page that asks the guard for its own address.
 *  2. The codes card is drawn on «رموز الأصالة» and on no other screen — «إعدادات النظام» no longer draws it.
 *  3. The settings door has one card for both; both have their ⓘ.
 * ═══════════════════════════════════════════════════════════════════════
 */
const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n');
const marks = (root: ParentNode) => [...root.querySelectorAll('[data-card]')].map((n) => n.getAttribute('data-card'));
const PAGES = [
  ['/settings/authenticity', 'رموز الأصالة', 'AuthenticityScreen'],
  ['/settings/product-barcodes', 'باركود المنتجات', 'ProductBarcodesScreen'],
] as const;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('1 · who opens them, and where they sit', () => {
  const userWith = (keys: string[]) =>
    attachGrants({ id: 'u', role: 'MODERATOR', status: 'ACTIVE', permissions: keys } as never, { fullAccess: false, grants: Object.fromEntries(keys.map((k) => [k, { scope: 'ALL_COMPANY' }])) });

  it.each(PAGES)('%s is «%s» on exactly settings.view, with an icon the menu knows', (path, label) => {
    const r = findRoute(path)!;
    expect(r.label).toBe(label);
    expect(r.permissions).toEqual(['settings.view']);
    expect(ICONS[r.icon], r.icon).toBeTruthy();
    expect(ALL_ROUTES.filter((x) => x.path === path)).toHaveLength(1);
    expect(canAccessRoute(userWith(['settings.view']), r, can)).toBe(true);
    expect(canAccessRoute(userWith(['settings.edit']), r, can)).toBe(false);
  });

  it('they stand together, right after «إعدادات النظام», codes first', () => {
    const paths = NAV.find((g) => g.key === 'admin')!.routes.map((r) => r.path);
    const at = paths.indexOf('/settings/system');
    expect(paths.slice(at, at + 3)).toEqual(['/settings/system', '/settings/authenticity', '/settings/product-barcodes']);
  });

  it.each(PAGES)('%s has a page that asks the guard for ITS address and draws its screen', (path, _label, screenName) => {
    const file = `src/app/(system)/(shell)${path}/page.tsx`;
    expect(existsSync(join(process.cwd(), file))).toBe(true);
    const page = read(file);
    expect(page).toContain(`guardRoute('${path}')`);
    expect(page).toContain(`<${screenName} />`);
  });
});

describe('2 · the codes card moved', () => {
  it('«رموز الأصالة» draws it, under its own title', () => {
    const { container } = render(<AuthenticityScreen />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('رموز الأصالة');
    expect(marks(container)).toEqual(['AuthenticityCodesCard']);
  });

  it('NEGATIVE: «إعدادات النظام» no longer draws it', async () => {
    here.path = '/settings/system';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ company: { name: 'شركة' } }), { status: 200 })));
    const { container } = render(<SystemSettingsScreen />);
    await waitFor(() => expect(screen.getByDisplayValue('شركة')).toBeTruthy());
    expect(marks(container)).toEqual(['PostOrderOfferCard']);
  });

  it('NEGATIVE: no other source file draws or imports the card', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir)) {
        const full = join(dir, e);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e)) {
          const rel = full.slice(process.cwd().length + 1).replace(/\\/g, '/');
          if (rel === 'src/components/screens/AuthenticityScreen.tsx' || rel === 'src/components/settings/AuthenticityCodesCard.tsx') continue;
          if (/<AuthenticityCodesCard\b|import \{[^}]*\bAuthenticityCodesCard\b/.test(readFileSync(full, 'utf8'))) offenders.push(rel);
        }
      }
    };
    walk(join(process.cwd(), 'src'));
    expect(offenders).toEqual([]);
  });
});

describe('3 · the door and the guides', () => {
  it('ONE settings card holds both, right after «النظام»', () => {
    const cards = SETTINGS_CARDS.filter((c) => c.paths.some((p) => PAGES.some(([path]) => path === p)));
    expect(cards.map((c) => c.key)).toEqual(['authenticity']);
    expect(cards[0].paths).toEqual(['/settings/authenticity', '/settings/product-barcodes']);
    const at = SETTINGS_CARDS.findIndex((c) => c.key === 'system');
    expect(SETTINGS_CARDS[at + 1].key).toBe('authenticity');
  });

  it.each(PAGES)('%s has its ⓘ', (path) => {
    expect(GUIDED_PATHS).toContain(path);
    expect(GUIDE_TEXTS[path]?.steps.length).toBeGreaterThan(0);
  });
});
