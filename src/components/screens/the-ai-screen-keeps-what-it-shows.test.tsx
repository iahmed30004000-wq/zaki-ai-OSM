// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «الذكاء الاصطناعي والنصوص» KEEPS EVERY CONTROL IT HAD WHEN IT MOVED ONTO THE KIT (R15g, 18/11)
 *
 * Written and measured against osm/main BEFORE the screen changed, then kept green after: the same fixture, the same
 * presses, the same number of buttons, ticks, fields, key boxes and folds at every step — the provider tab with the
 * installation's accounts open, the words tab with one job and one group of customer messages open, the assistants
 * tab, and a person who may only look (no key of the screen, the installation's accounts refused).
 * And every key box is EMPTY after the load: nothing of a saved key comes back to the screen.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { apiJson, who, fetchMock } = vi.hoisted(() => ({
  apiJson: vi.fn(),
  who: { permissions: ['settings.view', 'settings.manage', 'settings.messages'] as string[] },
  fetchMock: vi.fn(),
}));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a) }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/settings/ai',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ currentUser: { id: 'u1', role: 'MODERATOR', status: 'ACTIVE', permissions: who.permissions }, t: {}, locale: 'ar' }),
}));
vi.mock('@/hooks/useLiveRefresh', () => ({
  useLiveRefresh: (load: () => unknown) => {
    const latest = React.useRef(load);
    latest.current = load;
    React.useEffect(() => {
      void latest.current();
    }, []);
  },
}));

import { AiSettingsScreen } from './AiSettingsScreen';
import { ToastProvider } from '@/components/ui/Toast';
import { ConfirmProvider } from '@/components/ui/Confirm';

const PROVIDERS = [
  { id: 'ANTHROPIC', label: 'المزوّد الأول', defaultModel: 'm1', models: ['m1', 'm2'], keyHelp: 'من لوحة المزوّد' },
  { id: 'LOCAL', label: 'خادمك', defaultModel: 'l1', models: ['l1'], keyHelp: 'غالباً بلا مفتاح', needsEndpoint: true, keyOptional: true },
  { id: 'OPENAI_COMPATIBLE', label: 'خادم متوافق', defaultModel: '', models: [], keyHelp: 'مفتاح خادمك', needsHttpsEndpoint: true },
];

const SETTINGS = {
  provider: 'ANTHROPIC',
  model: 'm1',
  prompt: '',
  prompts: { daily_summary: 'نص معدّل بلا سياق' },
  promptHistory: { daily_summary: [{ text: 'نص قديم', at: '2026-11-01T10:00:00.000Z', by: 'المالك' }] },
  hasKey: true,
  intelligenceScopes: ['orders'],
  assistants: {},
  spendCap: { dailyTokens: 1000, monthlyTokens: null },
};

const JOBS = [
  { key: 'daily_summary', label: 'الملخّص اليومي', where: 'كل يوم', note: 'من أرقام اليوم', slots: ['{context}'], default: 'الأصل {context}' },
  { key: 'assistant', label: 'المساعد', where: 'لوحة المساعد', note: 'ملاحظة', slots: [], default: 'أصل المساعد' },
];

const SYSTEM = {
  provider: 'ANTHROPIC',
  model: 'm1',
  providerKeys: { ANTHROPIC: { configured: true, savedAt: '2026-11-10T08:00:00.000Z' }, LOCAL: { configured: false, savedAt: null } },
  localBaseUrl: 'http://localhost:11434',
  compat: { baseUrl: 'https://models.example.com/v1', host: 'models.example.com', model: 'my-model' },
  savedAt: '2026-11-10T08:00:00.000Z',
  savedBy: 'المالك',
  encryptionAvailable: true,
};

const MESSAGES = {
  templates: [
    { id: 't1', name: 'تأكيد', channel: 'BOTH', body: 'أهلاً {اسم_الزبون}', situation: 'confirmation', lang: 'ar', active: true },
    { id: 't2', name: 'تأكيد ثاني', channel: 'SMS', body: 'مرحبا', situation: 'confirmation', lang: 'ar', active: false },
  ],
  vars: [{ key: 'اسم_الزبون', label: 'اسم الزبون' }, { key: 'رقم_الطلب', label: 'رقم الطلب' }],
  languages: [{ code: 'ar', label: 'العربية' }, { code: 'en', label: 'الإنجليزية' }],
  sample: { orderNumber: 'X-1', customerName: 'زبون' },
};

const json = (ok: boolean, body: unknown) => ({ ok, json: async () => body });

beforeEach(() => {
  vi.clearAllMocks();
  who.permissions = ['settings.view', 'settings.manage', 'settings.messages'];
  fetchMock.mockImplementation(async (url: string) => {
    if (url === '/api/settings/ai') {
      return json(true, {
        settings: SETTINGS,
        usage: { dayTokens: 10, monthTokens: 200 },
        providers: PROVIDERS,
        jobs: JOBS,
        routes: { advisor: { provider: 'ANTHROPIC', model: 'm1', keyFrom: 'system', baseUrl: null } },
        defaultRoute: { provider: 'ANTHROPIC', model: 'm1', keyFrom: 'system', baseUrl: null },
      });
    }
    if (url === '/api/settings/ai/system') {
      return who.permissions.includes('settings.manage') ? json(true, { system: SYSTEM, providers: PROVIDERS }) : json(false, {});
    }
    return json(true, {});
  });
  vi.stubGlobal('fetch', fetchMock);
  apiJson.mockImplementation(async (url: string) => {
    if (url === '/api/settings/messages?sample=1') return MESSAGES;
    return {};
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const draw = async () => {
  const out = render(
    <ToastProvider>
      <ConfirmProvider>
        <AiSettingsScreen />
      </ConfirmProvider>
    </ToastProvider>
  );
  await screen.findByText('اختبار الاتصال');
  if (who.permissions.includes('settings.manage')) await screen.findByText('مفتاح محفوظ');
  if (who.permissions.includes('settings.messages')) await screen.findByText('احفظ القوالب');
  return out;
};

const tally = (root: HTMLElement) => ({
  buttons: root.querySelectorAll('button').length,
  ticks: root.querySelectorAll('input[type="checkbox"]').length,
  fields: root.querySelectorAll('input:not([type="checkbox"]), select, textarea').length,
  secrets: root.querySelectorAll('input[type="password"]').length,
  folds: root.querySelectorAll('summary').length,
  h1: root.querySelectorAll('h1').length,
});

describe('«الذكاء الاصطناعي والنصوص» keeps every control (measured on main before the kit)', () => {
  it('the provider tab, every key of the screen, the installation accounts open', async () => {
    const { container } = await draw();
    expect(tally(container)).toEqual({ buttons: 22, ticks: 0, fields: 9, secrets: 3, folds: 0, h1: 1 });
    // Nothing of a saved key is drawn back: every key box is empty after the load.
    const boxes = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="password"]'));
    expect(boxes.every((b) => b.value === '')).toBe(true);
  });

  it('the words tab with one job and one group of customer messages open', async () => {
    const { container } = await draw();
    fireEvent.click(screen.getByRole(screen.queryAllByRole('radio').length ? 'radio' : 'button', { name: 'النصوص والقوالب' }));
    fireEvent.click(screen.getByRole('button', { name: /الملخّص اليومي/ }));
    fireEvent.click(screen.getByRole('button', { name: /^التأكيد/ }));
    await screen.findByText('النسخ السابقة (1)');
    expect(tally(container)).toEqual({ buttons: 31, ticks: 2, fields: 20, secrets: 3, folds: 1, h1: 1 });
  });

  it('the assistants tab', async () => {
    const { container } = await draw();
    fireEvent.click(screen.getByRole(screen.queryAllByRole('radio').length ? 'radio' : 'button', { name: 'المساعدون' }));
    await screen.findByText('ما يقرؤه مركز الذكاء');
    expect(tally(container)).toEqual({ buttons: 22, ticks: 5, fields: 29, secrets: 3, folds: 0, h1: 1 });
  });

  it('a person who may only look: no save, the installation accounts refused and not drawn', async () => {
    who.permissions = ['settings.view'];
    const { container } = await draw();
    await waitFor(() => expect(screen.queryByText(/حسابات المزوّدين تُضبط على مستوى النظام/)).not.toBeNull());
    expect(tally(container)).toEqual({ buttons: 6, ticks: 0, fields: 3, secrets: 0, folds: 0, h1: 1 });
    expect(screen.queryByText('احفظ الإعدادات والنصوص')).toBeNull();
    expect(screen.queryByText('احفظ حسابات النظام')).toBeNull();
  });
});
