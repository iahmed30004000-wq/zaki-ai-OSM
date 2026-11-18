// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@/lib/guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «الربط» ON THE KIT (R15f, 18/11)
 *
 * The page and its five cards moved onto the kit: the frame (`PageShell`, the registry's name, the narrow width), the kit's
 * buttons (the icon-only ones named), the route of «واتساب بعد لا يرد» as a two-choice bar, and the captions in the caption
 * size. What must stay exactly as it was, and is held here:
 *
 *   · THE SECRETS — every value box is an empty password box after load, whatever the server sends; a value the server
 *     ever sent back by mistake is not drawn anywhere; only the last four of a saved value are shown;
 *   · every press sends what it sent before: reconnect and test, the webhook, a group switched off and on, a group removed
 *     (asked first), the per-country route saved with the same body;
 *   · no kit button submits a form by accident (the kit sets no default `type`);
 *   · a phone (375px) gets no fixed width beyond the screen, and the add-a-group form is one column there.
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
import { PAGE_WIDTHS } from '@/components/ui/PageShell';
import { routeLabel } from '@/lib/route-registry';

/** A value a server must never send back — and if it ever did, the screen must not draw it. */
const LEAK = 'LEAKED-full-secret-value-0000';
const TG_LEAK = 'LEAKED-bot-token-1111';

const ITEMS = [
  { key: 'WHATSAPP_ACCESS_TOKEN', group: 'whatsapp', label: 'رمز الوصول', help: 'من ميتا', source: 'site', hint: '9f3a', envSet: false, unreadable: false, value: LEAK },
  { key: 'WHATSAPP_PHONE_NUMBER_ID', group: 'whatsapp', label: 'معرّف الرقم', help: 'أرقام', source: 'env', hint: null, envSet: true, unreadable: false },
  { key: 'TELEGRAM_BOT_TOKEN', group: 'telegram', label: 'رمز البوت', help: 'من البوت الأب', source: 'site', hint: 'k7Qz', envSet: false, unreadable: false, value: TG_LEAK },
  { key: 'TELEGRAM_WEBHOOK_SECRET', group: 'telegram', label: 'سر الويبهوك', help: 'أي قيمة', source: 'none', hint: null, envSet: false, unreadable: false },
];

const SOURCES = [
  { id: 'g1', chatId: '-1001', chatType: 'supergroup', chatTitle: 'طلبات الصفحة', topicId: null, topicName: null, isActive: true, ordersCount: 12, lastMessageAt: null, storeName: 'متجر واحد' },
  { id: 'g2', chatId: '-1002', chatType: 'group', chatTitle: 'مجموعة موقوفة', topicId: null, topicName: null, isActive: false, ordersCount: 0, lastMessageAt: null, storeName: null },
];

let botConfigured = true;

beforeEach(() => {
  vi.clearAllMocks();
  botConfigured = true;
  who.permissions = ['whatsapp.manage', 'telegram.connect', 'settings.manage'];
  screenApi.mockImplementation(async (url: string) => {
    if (url === '/api/whatsapp/connection') {
      return { status: 'CONNECTED', envConfigured: true, accessToken: LEAK, connection: { displayName: 'الشركة', phoneNumber: '+10000000000', accessToken: LEAK } };
    }
    if (url === '/api/telegram/status') {
      return { botConfigured, botApiOk: true, webhookSecretConfigured: true, appUrlConfigured: true, botUsername: 'demo_bot', webhookUrl: 'https://x.test/api/webhooks/telegram', telegramWebhookSet: false, botToken: TG_LEAK };
    }
    if (url === '/api/telegram/sources') return { sources: SOURCES };
    return { ok: true };
  });
  apiJson.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
    if (url === '/api/settings/integrations' && !init?.method) return { items: ITEMS };
    if (url === '/api/settings/whatsapp-after-no-answer') {
      if (init?.method === 'PUT') return { setting: JSON.parse(init.body!) };
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
  await screen.findByText('متصل');
  await screen.findByText('رمز الوصول');
  await screen.findByText('الأردن');
  await screen.findByText('@demo_bot');
  await screen.findByText('رمز البوت');
  await screen.findAllByText('مجموعة موقوفة');
  return out;
};

const callsTo = (fn: ReturnType<typeof vi.fn>, url: string, method: string) =>
  fn.mock.calls.filter(([u, i]) => u === url && (i?.method ?? 'GET') === method);

describe('the frame', () => {
  it('one h1, the registry’s name, and the narrow width the page always had', async () => {
    const { container } = await draw();
    const h1 = screen.getAllByRole('heading', { level: 1 });
    expect(h1).toHaveLength(1);
    expect(h1[0].textContent).toBe(routeLabel('/settings/links'));
    expect(h1[0].textContent).toBe('الربط');
    const root = container.querySelector('#whatsapp')!.parentElement!.parentElement!;
    expect(root.className).toContain(PAGE_WIDTHS.narrow);
  });

  it('the two cards keep their anchors, and each holds its values card', async () => {
    const { container } = await draw();
    expect(within(container.querySelector<HTMLElement>('#whatsapp')!).getByText('رمز الوصول')).toBeTruthy();
    expect(within(container.querySelector<HTMLElement>('#telegram')!).getByText('رمز البوت')).toBeTruthy();
  });
});

describe('the secrets', () => {
  it('every value box is an empty password box after load, with no autofill', async () => {
    const { container } = await draw();
    const boxes = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="password"]'));
    expect(boxes).toHaveLength(4);
    for (const b of boxes) {
      expect(b.value).toBe('');
      expect(b.getAttribute('autocomplete')).toBe('off');
    }
  });

  it('NEGATIVE: a full value the server sent back by mistake is drawn nowhere — not as text, not in a box, not in an attribute', async () => {
    const { container } = await draw();
    const everything = container.innerHTML + Array.from(container.querySelectorAll('input')).map((i) => i.value).join('|');
    expect(everything).not.toContain(LEAK);
    expect(everything).not.toContain(TG_LEAK);
    // only the last four of a saved value
    expect(screen.getByText('9f3a')).toBeTruthy();
    expect(screen.getByText('k7Qz')).toBeTruthy();
  });

  it('a typed value is sent once and the box is emptied again', async () => {
    await draw();
    const box = screen.getByLabelText('سر الويبهوك') as HTMLInputElement;
    fireEvent.change(box, { target: { value: 'typed-new' } });
    const save = within(document.getElementById('telegram')!).getAllByRole('button', { name: 'حفظ' }).find((b) => !(b as HTMLButtonElement).disabled)!;
    fireEvent.click(save);
    await waitFor(() => expect(callsTo(apiJson, '/api/settings/integrations', 'PUT')).toHaveLength(1));
    expect(JSON.parse(callsTo(apiJson, '/api/settings/integrations', 'PUT')[0][1].body)).toEqual({ key: 'TELEGRAM_WEBHOOK_SECRET', value: 'typed-new' });
    await waitFor(() => expect((screen.getByLabelText('سر الويبهوك') as HTMLInputElement).value).toBe(''));
  });
});

describe('the presses send what they sent before', () => {
  it('WhatsApp: test and reconnect post to their doors, and both lock while one runs', async () => {
    let release!: () => void;
    await draw();
    screenApi.mockImplementation(async (url: string) => {
      if (url === '/api/whatsapp/connection/reconnect') {
        await new Promise<void>((r) => { release = r; });
        return { ok: true };
      }
      if (url === '/api/whatsapp/connection') return { status: 'CONNECTED', connection: {} };
      return { ok: true };
    });
    fireEvent.click(screen.getByRole('button', { name: /إعادة الاتصال/ }));
    await waitFor(() => expect((screen.getByRole('button', { name: /اختبار الاتصال/ }) as HTMLButtonElement).disabled).toBe(true));
    expect((screen.getByRole('button', { name: /إعادة الاتصال/ }) as HTMLButtonElement).disabled).toBe(true);
    release();
    await screen.findByText('تمت إعادة الاتصال بنجاح');
    expect(screenApi.mock.calls.some(([u, i]) => u === '/api/whatsapp/connection/reconnect' && i?.method === 'POST')).toBe(true);
    expect(screenApi.mock.calls.some(([u]) => u === '/api/whatsapp/connection/test')).toBe(false);
  });

  it('Telegram: the webhook button registers, and is off while the bot has no token', async () => {
    await draw();
    fireEvent.click(screen.getByRole('button', { name: 'تسجيل / تحديث الويبهوك' }));
    await waitFor(() => expect(screenApi.mock.calls.some(([u, i]) => u === '/api/telegram/webhook/setup' && i?.method === 'POST')).toBe(true));
    cleanup();
    botConfigured = false;
    render(<ToastProvider><ConfirmProvider><LinksSettingsScreen /></ConfirmProvider></ToastProvider>);
    await screen.findByText('@demo_bot');
    expect((screen.getByRole('button', { name: 'تسجيل / تحديث الويبهوك' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a group: the named switch sends the opposite of what the group is now', async () => {
    await draw();
    fireEvent.click(screen.getAllByRole('button', { name: 'تعطيل' })[0]);
    await waitFor(() => expect(screenApi.mock.calls.some(([u, i]) => u === '/api/telegram/sources/g1' && i?.method === 'PATCH')).toBe(true));
    const off = screenApi.mock.calls.find(([u, i]) => u === '/api/telegram/sources/g1' && i?.method === 'PATCH')!;
    expect(JSON.parse(off[1].body)).toEqual({ isActive: false });
    fireEvent.click(screen.getAllByRole('button', { name: 'تفعيل' })[0]);
    await waitFor(() => expect(screenApi.mock.calls.some(([u, i]) => u === '/api/telegram/sources/g2' && i?.method === 'PATCH')).toBe(true));
    const on = screenApi.mock.calls.find(([u, i]) => u === '/api/telegram/sources/g2' && i?.method === 'PATCH')!;
    expect(JSON.parse(on[1].body)).toEqual({ isActive: true });
  });

  it('NEGATIVE: removing a group asks first; declined, nothing is sent', async () => {
    await draw();
    fireEvent.click(screen.getAllByRole('button', { name: 'حذف' })[0]);
    await screen.findByText(/حذف الربط مع «طلبات الصفحة»/);
    fireEvent.click(screen.getByRole('button', { name: 'إلغاء' }));
    await waitFor(() => expect(screen.queryByText(/حذف الربط مع «طلبات الصفحة»/)).toBeNull());
    expect(screenApi.mock.calls.some(([, i]) => i?.method === 'DELETE')).toBe(false);
  });

  it('the test of a group asks its own door', async () => {
    await draw();
    fireEvent.click(screen.getAllByRole('button', { name: 'اختبار' })[0]);
    await waitFor(() => expect(screenApi.mock.calls.some(([u, i]) => u === '/api/telegram/sources/g1/test' && i?.method === 'POST')).toBe(true));
  });

  it('«واتساب بعد لا يرد»: each country is a two-choice bar, and «احفظ» sends the same body as before', async () => {
    await draw();
    const syria = screen.getByRole('radiogroup', { name: /سوريا/ });
    const jordan = screen.getByRole('radiogroup', { name: /الأردن/ });
    expect(within(jordan).getByRole('radio', { name: 'من رقم الشركة' }).getAttribute('aria-checked')).toBe('true');
    expect(within(syria).getByRole('radio', { name: 'من واتساب الموظفة' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(within(syria).getByRole('radio', { name: 'من رقم الشركة' }));
    fireEvent.click(within(jordan).getByRole('radio', { name: 'من واتساب الموظفة' }));
    fireEvent.click(screen.getByRole('button', { name: 'احفظ' }));
    await waitFor(() => expect(callsTo(apiJson, '/api/settings/whatsapp-after-no-answer', 'PUT')).toHaveLength(1));
    expect(JSON.parse(callsTo(apiJson, '/api/settings/whatsapp-after-no-answer', 'PUT')[0][1].body)).toEqual({
      byDialCode: { '962': 'AGENT', '963': 'COMPANY' },
      templateName: 'no_answer',
      templateLang: 'ar',
      templateParams: 'name',
    });
  });

  it('NEGATIVE: without the sensitive-settings key the bars are locked and a press changes nothing', async () => {
    who.permissions = ['whatsapp.manage', 'telegram.connect'];
    await draw();
    const syria = screen.getByRole('radiogroup', { name: /سوريا/ });
    const company = within(syria).getByRole('radio', { name: 'من رقم الشركة' }) as HTMLButtonElement;
    expect(company.disabled).toBe(true);
    fireEvent.click(company);
    expect(company.getAttribute('aria-checked')).toBe('false');
    expect(screen.queryByRole('button', { name: 'احفظ' })).toBeNull();
  });
});

describe('the buttons', () => {
  it('every button on the page and in the add-a-group dialog says it is a button, so none submits a form', async () => {
    const { container } = await draw();
    const untyped = Array.from(container.querySelectorAll('button')).filter((b) => b.getAttribute('type') !== 'button');
    expect(untyped.map((b) => b.textContent || b.getAttribute('aria-label'))).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: /إضافة مصدر/ }));
    const dialog = await screen.findByRole('dialog');
    // The dialog's own «إغلاق» belongs to the shared `Modal` frame, not to this card: only the card's form is held here.
    const form = within(dialog).getByLabelText('Chat ID *').closest('div.space-y-4')!;
    const inDialog = Array.from(form.querySelectorAll('button')).filter((b) => b.getAttribute('type') !== 'button');
    expect(form.querySelectorAll('button').length).toBeGreaterThanOrEqual(2);
    expect(inDialog.map((b) => b.textContent || b.getAttribute('aria-label'))).toEqual([]);
  });

  it('every icon-only button has an Arabic name', async () => {
    await draw();
    for (const name of ['تحديث حالة تلجرام', 'اختبار', 'تعطيل', 'تفعيل', 'حذف']) {
      expect(screen.getAllByRole('button', { name }).length, name).toBeGreaterThan(0);
    }
  });

  it('the six files carry no old look names and no hand-written button', () => {
    const files = [
      'src/components/screens/LinksSettingsScreen.tsx',
      'src/components/screens/WhatsAppSettingsScreen.tsx',
      'src/components/screens/TelegramSettingsScreen.tsx',
      'src/components/settings/IntegrationFieldsCard.tsx',
      'src/components/settings/TelegramSourcesCard.tsx',
      'src/components/settings/WhatsAppAfterNoAnswerCard.tsx',
    ];
    for (const f of files) {
      const src = stripComments(readFileSync(join(process.cwd(), f), 'utf8'));
      expect(src, f).not.toMatch(/variant="(outline|ghost|success)"/);
      expect(src, f).not.toMatch(/<button[\s>]/);
      expect(src, f).not.toMatch(/type="radio"/);
    }
  });
});

describe('a phone, 375px', () => {
  // Built from pieces so the stylesheet scanner never reads a class name here.
  const fixedWide = new RegExp(`\\b(min-)?w-\\[(\\d{3,})px\\]`);
  const twoColumnsAlways = new RegExp(`(^|\\s)grid-cols-${2}(\\s|$)`);

  it('no element is wider than the screen by a fixed width, and nothing is two columns without a breakpoint', async () => {
    const { container } = await draw();
    fireEvent.click(screen.getByRole('button', { name: /إضافة مصدر/ }));
    const dialog = await screen.findByRole('dialog');
    for (const el of [...Array.from(container.querySelectorAll('*')), ...Array.from(dialog.querySelectorAll('*'))]) {
      const cls = typeof el.className === 'string' ? el.className : '';
      const wide = cls.match(fixedWide);
      if (wide) expect(Number(wide[2]), cls).toBeLessThanOrEqual(375);
      expect(cls, 'عمودين على الموبايل').not.toMatch(twoColumnsAlways);
    }
  });

  it('the add-a-group form is one column on a phone: its two short boxes sit in a one-column grid', async () => {
    await draw();
    fireEvent.click(screen.getByRole('button', { name: /إضافة مصدر/ }));
    const dialog = await screen.findByRole('dialog');
    const topic = within(dialog).getByLabelText('Topic ID (اختياري)');
    const grid = topic.closest('.grid')!;
    expect(grid.className.split(/\s+/)).toContain(['grid', 'cols', '1'].join('-'));
  });

  it('the rows that hold a name and a button wrap instead of pushing past the edge', async () => {
    const { container } = await draw();
    const status = screen.getByText('متصل').closest('div.border')!;
    expect(status.className.split(/\s+/)).toContain(['flex', 'wrap'].join('-'));
    const webhookRow = screen.getByRole('button', { name: 'تسجيل / تحديث الويبهوك' }).parentElement!;
    expect(webhookRow.className.split(/\s+/)).toContain(['flex', 'wrap'].join('-'));
    expect(container.querySelector('#telegram')).not.toBeNull();
  });
});
