// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «الربط» KEEPS EVERY CONTROL IT HAD WHEN IT MOVED ONTO THE KIT (R15f, 18/11)
 *
 * Written and measured against osm/main BEFORE the screen changed, then kept green after: the same fixture, the same
 * presses, the same number of buttons, choices, fields and links at every step — the whole page with its REAL cards
 * (WhatsApp, «واتساب بعد لا يرد», the values, Telegram, the bound groups), the add-a-group dialog open, a person who may
 * only look at «واتساب بعد لا يرد», and a person with one of the two keys.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { screenApi, apiJson, who } = vi.hoisted(() => ({
  screenApi: vi.fn(),
  apiJson: vi.fn(),
  who: { permissions: ['whatsapp.manage', 'telegram.connect', 'settings.manage'] as string[] },
}));
vi.mock('@/lib/screen-api', () => ({ screenApi: (...a: unknown[]) => screenApi(...a), qs: () => '' }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a) }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/settings/links',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ currentUser: { id: 'u1', role: 'MODERATOR', status: 'ACTIVE', permissions: who.permissions }, t: {}, locale: 'ar' }),
}));

import { LinksSettingsScreen } from './LinksSettingsScreen';
import { ConfirmProvider } from '@/components/ui/Confirm';
import { ToastProvider } from '@/components/ui/Toast';

const ITEMS = [
  { key: 'WHATSAPP_ACCESS_TOKEN', group: 'whatsapp', label: 'رمز الوصول', help: 'من ميتا', source: 'site', hint: '9f3a', envSet: false, unreadable: false },
  { key: 'WHATSAPP_PHONE_NUMBER_ID', group: 'whatsapp', label: 'معرّف الرقم', help: 'أرقام', source: 'env', hint: null, envSet: true, unreadable: false },
  { key: 'TELEGRAM_BOT_TOKEN', group: 'telegram', label: 'رمز البوت', help: 'من البوت الأب', source: 'site', hint: 'k7Qz', envSet: false, unreadable: true },
  { key: 'TELEGRAM_WEBHOOK_SECRET', group: 'telegram', label: 'سر الويبهوك', help: 'أي قيمة', source: 'none', hint: null, envSet: false, unreadable: false },
];

const SOURCES = [
  { id: 'g1', chatId: '-1001', chatType: 'supergroup', chatTitle: 'طلبات الصفحة', topicId: 7, topicName: 'الطلبات', isActive: true, ordersCount: 12, lastMessageAt: '2026-11-17T08:00:00.000Z', storeName: 'متجر واحد' },
  { id: 'g2', chatId: '-1002', chatType: 'group', chatTitle: null, topicId: null, topicName: null, isActive: false, ordersCount: 0, lastMessageAt: null, storeName: null },
];

beforeEach(() => {
  vi.clearAllMocks();
  who.permissions = ['whatsapp.manage', 'telegram.connect', 'settings.manage'];
  screenApi.mockImplementation(async (url: string) => {
    if (url === '/api/whatsapp/connection') {
      return { status: 'CONNECTED', envConfigured: true, connection: { displayName: 'الشركة', phoneNumber: '+10000000000', wabaId: 'w1', phoneNumberId: 'p1', lastWebhookAt: null, lastMessageAt: null, lastError: null } };
    }
    if (url === '/api/telegram/status') {
      return { botConfigured: true, botApiOk: true, webhookSecretConfigured: true, appUrlConfigured: true, botUsername: 'demo_bot', webhookUrl: 'https://x.test/api/webhooks/telegram', telegramWebhookSet: false };
    }
    if (url === '/api/telegram/sources') return { sources: SOURCES };
    return { ok: true };
  });
  apiJson.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (url === '/api/settings/integrations' && !init?.method) return { items: ITEMS };
    if (url === '/api/settings/whatsapp-after-no-answer' && !init?.method) {
      return {
        setting: { byDialCode: { '962': 'COMPANY' }, templateName: 'no_answer', templateLang: 'ar', templateParams: 'name' },
        countries: [{ dialCode: '962', name: 'الأردن' }, { dialCode: '963', name: 'سوريا' }],
        connected: true,
      };
    }
    return { ok: true };
  });
});
afterEach(cleanup);

const draw = async () => {
  const out = render(
    <ToastProvider>
      <ConfirmProvider>
        <LinksSettingsScreen />
      </ConfirmProvider>
    </ToastProvider>
  );
  if (who.permissions.includes('whatsapp.manage')) {
    await screen.findByText('متصل');
    await screen.findByText('رمز الوصول');
    await screen.findByText('الأردن');
  }
  if (who.permissions.includes('telegram.connect')) {
    await screen.findByText('@demo_bot');
    await screen.findByText('رمز البوت');
    await screen.findAllByText('طلبات الصفحة');
  }
  return out;
};

const tally = (root: HTMLElement) => ({
  buttons: root.querySelectorAll('button:not([role="radio"])').length,
  radios: root.querySelectorAll('[role="radio"], input[type="radio"]').length,
  fields: root.querySelectorAll('input:not([type="radio"]):not([type="checkbox"]), select, textarea').length,
  secrets: root.querySelectorAll('input[type="password"]').length,
  links: root.querySelectorAll('a[href]').length,
  h1: root.querySelectorAll('h1').length,
});

describe('«الربط» keeps every control (measured on main before the kit)', () => {
  it('the whole page, both keys and the sensitive-settings key', async () => {
    const { container } = await draw();
    expect(tally(container)).toEqual({ buttons: 31, radios: 4, fields: 7, secrets: 4, links: 2, h1: 1 });
  });

  it('the add-a-group dialog open', async () => {
    await draw();
    fireEvent.click(screen.getByRole('button', { name: /إضافة مصدر/ }));
    const dialog = await screen.findByRole('dialog');
    expect(tally(dialog)).toEqual({ buttons: 3, radios: 0, fields: 4, secrets: 0, links: 0, h1: 0 });
  });

  it('a person who may only look at «واتساب بعد لا يرد»: no «احفظ», every choice still drawn but locked', async () => {
    who.permissions = ['whatsapp.manage', 'telegram.connect'];
    const { container } = await draw();
    expect(tally(container)).toEqual({ buttons: 30, radios: 4, fields: 7, secrets: 4, links: 2, h1: 1 });
    expect(screen.queryByRole('button', { name: 'احفظ' })).toBeNull();
    const locked = Array.from(container.querySelectorAll<HTMLElement>('[role="radio"], input[type="radio"]'));
    expect(locked.every((r) => (r as HTMLInputElement | HTMLButtonElement).disabled)).toBe(true);
  });

  it('WhatsApp alone, then Telegram alone', async () => {
    who.permissions = ['whatsapp.manage', 'settings.manage'];
    const one = await draw();
    expect(tally(one.container)).toEqual({ buttons: 9, radios: 4, fields: 5, secrets: 2, links: 1, h1: 1 });
    one.unmount();
    who.permissions = ['telegram.connect'];
    const two = await draw();
    await waitFor(() => expect(tally(two.container).buttons).toBe(22));
    expect(tally(two.container)).toEqual({ buttons: 22, radios: 0, fields: 2, secrets: 2, links: 1, h1: 1 });
  });
});
