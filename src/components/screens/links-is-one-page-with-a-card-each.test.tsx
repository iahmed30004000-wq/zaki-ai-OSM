// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@/lib/guard-source';
import { ALL_ROUTES, canAccessRoute, findRoute } from '@/lib/route-registry';
import { attachGrants, can } from '@/lib/authorization';

/**
 * «الربط» — WHATSAPP AND TELEGRAM, ONE PAGE, A CARD EACH, FOR WHOEVER HOLDS THE KEY.
 *
 * «إعدادات واتساب» and «إعدادات تلجرام» were two pages for the same errand — read
 * the connection status, test it, reconnect it — seen once, at set-up. They are the
 * two cards of one page now (owner, 24/10). What must stay true:
 *
 *   · a person sees the card of the key they hold and never a card whose every
 *     button the door would refuse (`whatsapp.manage` and `telegram.connect` stay
 *     two grants — the page opens for either). Telegram's card asks `telegram.connect`
 *     since T-09 (3/11): `telegram.manage` is the day's message work and opens neither
 *     the card nor the page;
 *   · the cards are the SAME two screens, drawn without their own page header
 *     (`embedded`) so the page has one title;
 *   · the old addresses redirect for good, to the card they used to be;
 *   · the links that used to jump to a settings page land on the right card.
 */

const { user, conn } = vi.hoisted(() => ({
  user: { current: { id: 'u1', role: 'MODERATOR', permissions: ['whatsapp.manage', 'telegram.connect'], status: 'ACTIVE' } as Record<string, unknown> },
  conn: { current: { status: 'CONNECTED', envConfigured: true, connection: { displayName: 'صحة', phoneNumber: '+962790000000' } } as unknown },
}));

vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ currentUser: user.current, t: {}, locale: 'ar' }),
}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/settings/links',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => <h1>الربط</h1> }));
vi.mock('@/components/settings/TelegramSourcesCard', () => ({ TelegramSourcesCard: () => null }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), done: vi.fn(), warn: vi.fn() }) }));
vi.mock('@/lib/screen-api', () => ({
  screenApi: async (url: string) => {
    if (url === '/api/whatsapp/connection') return conn.current;
    if (url === '/api/telegram/status') {
      return { botConfigured: true, botApiOk: true, webhookSecretConfigured: true, appUrlConfigured: true, botUsername: 'zaki_bot', webhookUrl: 'https://x.test/hook', telegramWebhookSet: true };
    }
    throw new Error(`unexpected ${url}`);
  },
  qs: () => '',
}));

import { LinksSettingsScreen } from './LinksSettingsScreen';

beforeEach(() => {
  user.current = { id: 'u1', role: 'MODERATOR', permissions: ['whatsapp.manage', 'telegram.connect'], status: 'ACTIVE' };
});
afterEach(cleanup);

describe('«الربط» — the page', () => {
  it('draws both cards for somebody who holds both keys, under ONE title', async () => {
    render(<LinksSettingsScreen />);
    await screen.findByRole('heading', { level: 2, name: 'واتساب' });
    await screen.findByRole('heading', { level: 2, name: 'تلجرام' });
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    // the real screens' own page headers are not drawn inside it
    expect(screen.queryByText('إعدادات واتساب')).toBeNull();
    expect(screen.queryByText('إعدادات تلجرام')).toBeNull();
  });

  it('NEGATIVE: with only whatsapp.manage there is no Telegram card, and the other way round', async () => {
    user.current = { ...user.current, permissions: ['whatsapp.manage'] };
    const first = render(<LinksSettingsScreen />);
    await screen.findByRole('heading', { level: 2, name: 'واتساب' });
    expect(screen.queryByRole('heading', { level: 2, name: 'تلجرام' })).toBeNull();
    first.unmount();

    user.current = { ...user.current, permissions: ['telegram.connect'] };
    render(<LinksSettingsScreen />);
    await screen.findByRole('heading', { level: 2, name: 'تلجرام' });
    expect(screen.queryByRole('heading', { level: 2, name: 'واتساب' })).toBeNull();
    // not even the card's own «you may not» box: a card the person cannot use is NOT DRAWN,
    // rather than drawn as a refusal
    expect(screen.queryByText('ليس لديك صلاحية لإدارة واتساب')).toBeNull();
  });

  it('NEGATIVE (T-09): the day\'s message key alone draws no Telegram card — the connection is its own key', async () => {
    user.current = { ...user.current, permissions: ['whatsapp.manage', 'telegram.view', 'telegram.manage'] };
    render(<LinksSettingsScreen />);
    await screen.findByRole('heading', { level: 2, name: 'واتساب' });
    expect(screen.queryByRole('heading', { level: 2, name: 'تلجرام' })).toBeNull();
    expect(screen.queryByRole('button', { name: /تسجيل \/ تحديث الويبهوك/ })).toBeNull();
  });

  it('the cards carry the anchors the old links land on', async () => {
    const { container } = render(<LinksSettingsScreen />);
    await screen.findByRole('heading', { level: 2, name: 'واتساب' });
    expect(container.querySelector('#whatsapp')).not.toBeNull();
    expect(container.querySelector('#telegram')).not.toBeNull();
  });

  it('the WhatsApp card still reads and shows the connection, with the way to the inbox', async () => {
    render(<LinksSettingsScreen />);
    await screen.findByText('متصل');
    expect(screen.getByRole('link', { name: 'صندوق الواتساب' }).getAttribute('href')).toBe('/growth/whatsapp/inbox');
    expect(screen.getByRole('button', { name: /إعادة الاتصال/ })).toBeTruthy();
  });

  it('and the Telegram card shows the bot, with its refresh and the way to the orders', async () => {
    render(<LinksSettingsScreen />);
    await screen.findByText('@zaki_bot');
    expect(screen.getByRole('link', { name: 'طلبات تلجرام' }).getAttribute('href')).toBe('/growth/telegram/orders');
    await waitFor(() => expect(screen.getByRole('button', { name: 'تحديث حالة تلجرام' })).toBeTruthy());
  });
});

describe('the addresses', () => {
  const ROOT = process.cwd();
  const mk = (keys: string[], role = 'MODERATOR') =>
    attachGrants({ id: 'u', role, status: 'ACTIVE', permissions: keys } as any, {
      fullAccess: false,
      grants: Object.fromEntries(keys.map((k) => [k, { scope: 'ALL_COMPANY' }])),
    });

  it('the page opens for either key, and for nobody else', () => {
    const route = findRoute('/settings/links')!;
    expect(route.label).toBe('الربط');
    expect(canAccessRoute(mk(['whatsapp.manage']), route, can)).toBe(true);
    expect(canAccessRoute(mk(['telegram.connect']), route, can)).toBe(true);
    expect(canAccessRoute(mk(['settings.view']), route, can), 'settings.view وحدها ما تفتح الربط').toBe(false);
    // NEGATIVE (T-09): the day's message work does not open the connection page any more.
    expect(canAccessRoute(mk(['telegram.view', 'telegram.manage']), route, can), 'telegram.manage وحدها ما تفتح الربط').toBe(false);
  });

  it('the two old settings pages are gone and redirect permanently, each to its own card', () => {
    const config = stripComments(readFileSync(join(ROOT, 'next.config.ts'), 'utf8'));
    expect(config).toMatch(/source:\s*'\/settings\/whatsapp'\s*,\s*destination:\s*'\/settings\/links#whatsapp'\s*,\s*permanent:\s*true/);
    expect(config).toMatch(/source:\s*'\/settings\/telegram'\s*,\s*destination:\s*'\/settings\/links#telegram'\s*,\s*permanent:\s*true/);
    for (const dir of ['whatsapp', 'telegram']) {
      expect(existsSync(join(ROOT, 'src/app/(system)/(shell)/settings', dir, 'page.tsx')), dir).toBe(false);
    }
    const paths = ALL_ROUTES.map((r) => r.path);
    expect(paths).not.toContain('/settings/whatsapp');
    expect(paths).not.toContain('/settings/telegram');
  });

  it('the links that jumped to a settings page now land on the card', () => {
    const read = (f: string) => stripComments(readFileSync(join(ROOT, f), 'utf8'));
    expect(read('src/components/screens/WhatsAppInboxScreen.tsx')).toContain('href="/settings/links#whatsapp"');
    const orders = read('src/components/screens/TelegramOrdersScreen.tsx');
    expect(orders).toContain('href="/settings/links#telegram"');
    expect(orders).not.toContain('href="/settings/telegram"');
    // and the apps catalogue points its two built-ins at the page that exists
    const apps = read('src/lib/apps/registry.ts');
    expect(apps).not.toContain("settingsPath: '/settings/whatsapp'");
    expect(apps).not.toContain("settingsPath: '/settings/telegram'");
  });
});
