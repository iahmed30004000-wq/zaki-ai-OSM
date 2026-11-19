// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «الذكاء الاصطناعي والنصوص» ON THE KIT (R15g, 18/11)
 *
 * The frame changed and nothing it sends did: the title from the registry, the three sections as one bar of choices on
 * the same variable, every press sending the same body to the same door, every key box empty after a load and after a
 * save (and a key the server returned by mistake drawn nowhere), the local server's fields with their own ids and
 * values, the save buttons only for who holds the key, every button `type="button"`, and one column on a phone.
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
import { routeLabel } from '@/lib/route-registry';

/** A key the server must never send — if it ever does, the screen still must not draw it. */
const LEAK = 'sk-leaked-0000-9f3a';
const LEAK2 = 'sk-api-key-leaked-7c1d';

const PROVIDERS = [
  { id: 'ANTHROPIC', label: 'المزوّد الأول', defaultModel: 'm1', models: ['m1', 'm2'], keyHelp: 'من لوحة المزوّد' },
  { id: 'LOCAL', label: 'خادمك', defaultModel: 'l1', models: ['l1'], keyHelp: 'غالباً بلا مفتاح', needsEndpoint: true, keyOptional: true },
  { id: 'OPENAI_COMPATIBLE', label: 'خادم متوافق', defaultModel: '', models: [], keyHelp: 'مفتاح خادمك', needsHttpsEndpoint: true },
];
const SETTINGS = {
  provider: 'ANTHROPIC', model: 'm1', prompt: '', prompts: { daily_summary: 'نص معدّل بلا سياق' },
  promptHistory: { daily_summary: [{ text: 'نص قديم', at: '2026-11-01T10:00:00.000Z', by: 'المالك' }] },
  hasKey: true, intelligenceScopes: ['orders'], assistants: { advisor: { provider: 'ANTHROPIC' } },
  spendCap: { dailyTokens: 1000, monthlyTokens: null },
  apiKey: LEAK,
};
const JOBS = [
  { key: 'daily_summary', label: 'الملخّص اليومي', where: 'كل يوم', note: 'من أرقام اليوم', slots: ['{context}'], default: 'الأصل {context}' },
];
const SYSTEM = {
  provider: 'ANTHROPIC', model: 'm1',
  providerKeys: {
    // 19/11 (review of #390): `apiKey` is the field name a vendor key would carry if the server ever leaked it.
    ANTHROPIC: { configured: true, savedAt: '2026-11-10T08:00:00.000Z', key: LEAK, apiKey: LEAK2 },
  },
  localBaseUrl: 'http://localhost:11434',
  compat: { baseUrl: 'https://models.example.com/v1', host: 'models.example.com', model: 'my-model' },
  savedAt: '2026-11-10T08:00:00.000Z', savedBy: 'المالك', encryptionAvailable: true,
};
const MESSAGES = {
  templates: [{ id: 't1', name: 'تأكيد', channel: 'BOTH', body: 'أهلاً', situation: 'confirmation', lang: 'ar', active: true }],
  vars: [{ key: 'اسم_الزبون', label: 'اسم الزبون' }],
  languages: [{ code: 'ar', label: 'العربية' }],
  sample: { orderNumber: 'X-1', customerName: 'زبون' },
};
let routes: Record<string, unknown> = {};
let defaultRoute: Record<string, unknown> = { provider: 'ANTHROPIC', model: 'm1', keyFrom: 'system', baseUrl: null };

const res = (ok: boolean, body: unknown) => ({ ok, json: async () => body });

beforeEach(() => {
  vi.clearAllMocks();
  who.permissions = ['settings.view', 'settings.manage', 'settings.messages'];
  defaultRoute = { provider: 'ANTHROPIC', model: 'm1', keyFrom: 'system', baseUrl: null };
  routes = {};
  fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (url === '/api/settings/ai' && !init?.method) {
      return res(true, { settings: SETTINGS, usage: { dayTokens: 10, monthTokens: 200 }, providers: PROVIDERS, jobs: JOBS, routes, defaultRoute });
    }
    if (url === '/api/settings/ai/system') {
      if (init?.method === 'PUT') return res(true, { system: SYSTEM });
      return who.permissions.includes('settings.manage') ? res(true, { system: SYSTEM, providers: PROVIDERS }) : res(false, {});
    }
    if (url === '/api/settings/ai/test') return res(true, { ok: true, reply: 'نعم', provider: 'ANTHROPIC', model: 'm1', keyFrom: 'system' });
    return res(true, {});
  });
  vi.stubGlobal('fetch', fetchMock);
  apiJson.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
    if (url === '/api/settings/messages?sample=1') return MESSAGES;
    if (url === '/api/settings/messages' && init?.method === 'PUT') return { templates: JSON.parse(init.body!).templates };
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

/** The body of every call to `url` with `method`, parsed. */
const bodies = (url: string, method: string) =>
  fetchMock.mock.calls
    .filter(([u, init]) => u === url && (init as { method?: string } | undefined)?.method === method)
    .map(([, init]) => JSON.parse((init as { body: string }).body));

const keyBoxes = (root: HTMLElement) => Array.from(root.querySelectorAll<HTMLInputElement>('input[type="password"]'));
const section = (name: string) => screen.getByRole('radio', { name });

describe('the frame', () => {
  it('draws one title, read from the registry, at the narrow width', async () => {
    const { container } = await draw();
    const h1 = container.querySelectorAll('h1');
    expect(h1.length).toBe(1);
    expect(h1[0].textContent).toContain(routeLabel('/settings/ai'));
    expect(container.querySelector('.max-w-3xl')).not.toBeNull();
  });

  it('the three sections are one bar of choices on the same variable', async () => {
    await draw();
    const bar = screen.getByRole('radiogroup', { name: 'أقسام الشاشة' });
    expect(within(bar).getAllByRole('radio').map((r) => r.textContent)).toEqual(['المزوّد والمفتاح', 'المساعدون', 'النصوص والقوالب']);
    expect(section('المزوّد والمفتاح').getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByText('ما يقرؤه مركز الذكاء')).toBeNull();
    fireEvent.click(section('المساعدون'));
    expect(section('المساعدون').getAttribute('aria-checked')).toBe('true');
    await screen.findByText('ما يقرؤه مركز الذكاء');
    fireEvent.click(section('النصوص والقوالب'));
    expect(screen.queryByText('ما يقرؤه مركز الذكاء')).toBeNull();
  });
});

describe('the keys (decision 5): nothing of a key comes back', () => {
  it('every key box is an empty password box after the load, and a key the server leaked is drawn nowhere', async () => {
    const { container } = await draw();
    const boxes = keyBoxes(container);
    expect(boxes.length).toBe(3);
    expect(boxes.every((b) => b.value === '' && b.type === 'password' && b.getAttribute('autocomplete') === 'off')).toBe(true);
    expect(container.innerHTML).not.toContain(LEAK);
    expect(container.innerHTML).not.toContain('9f3a');
    expect(container.innerHTML).not.toContain(LEAK2);
    expect(container.innerHTML).not.toContain('7c1d');
    expect(keyBoxes(container).some((b) => b.value.includes('leaked'))).toBe(false);
  });

  it('a pasted key is sent once, alone, and the box is empty again after the save', async () => {
    const { container } = await draw();
    fireEvent.change(keyBoxes(container)[0], { target: { value: '  new-key-1  ' } });
    fireEvent.click(screen.getByRole('button', { name: /احفظ حسابات النظام/ }));
    await screen.findByText('حُفظت حسابات المزوّدين للنظام.');
    const [body] = bodies('/api/settings/ai/system', 'PUT');
    expect(body).toEqual({ providerKeys: { ANTHROPIC: 'new-key-1' }, localBaseUrl: 'http://localhost:11434' });
    expect(keyBoxes(container).every((b) => b.value === '')).toBe(true);
  });

  it('«احذف المفتاح» deletes that key and nothing else', async () => {
    await draw();
    fireEvent.click(screen.getByRole('button', { name: 'احذف المفتاح' }));
    await screen.findByText('حُذف المفتاح.');
    expect(bodies('/api/settings/ai/system', 'PUT')).toEqual([{ providerKeys: { ANTHROPIC: null } }]);
  });

  it('the local server and the compatible server keep their own fields, ids and values', async () => {
    const { container } = await draw();
    expect((container.querySelector('#ai-local-url') as HTMLInputElement).value).toBe('http://localhost:11434');
    expect((container.querySelector('#ai-compat-url') as HTMLInputElement).value).toBe('https://models.example.com/v1');
    expect((container.querySelector('#ai-compat-model') as HTMLInputElement).value).toBe('my-model');
    expect(screen.getByText(/اسم الزبون ورقمه وعنوانه ما بيوصلوه أبداً/)).not.toBeNull();
  });
});

describe('the same presses, the same bodies', () => {
  it('«اختبار الاتصال» asks the test door and says who answered', async () => {
    await draw();
    fireEvent.click(screen.getByRole('button', { name: /اختبار الاتصال/ }));
    await screen.findByText(/ردّ: «نعم»/);
    expect(fetchMock.mock.calls.some(([u, init]) => u === '/api/settings/ai/test' && (init as { method: string }).method === 'POST')).toBe(true);
  });

  it('NEGATIVE: «اختبار الاتصال» is locked when nothing would answer', async () => {
    defaultRoute = { provider: 'ANTHROPIC', model: 'm1', keyFrom: 'none', baseUrl: null };
    await draw();
    expect((screen.getByRole('button', { name: /اختبار الاتصال/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('احفظ المفتاح أو عنوان الخادم أولاً.')).not.toBeNull();
  });

  it('the screen save carries the words and the routing, and no provider nobody changed', async () => {
    await draw();
    fireEvent.click(screen.getByRole('button', { name: /احفظ الإعدادات والنصوص/ }));
    await screen.findByText('حُفظ. النصوص الجديدة مستعملة من الآن في كل طلب.');
    expect(bodies('/api/settings/ai', 'PUT')).toEqual([
      { prompts: SETTINGS.prompts, assistants: SETTINGS.assistants },
    ]);
  });

  it('a scope tick sends the scopes with it added, through the same door', async () => {
    await draw();
    fireEvent.click(section('المساعدون'));
    const finance = await screen.findByRole('checkbox', { name: /المال|الأرباح|مالي/ });
    expect((finance as HTMLInputElement).checked).toBe(false);
    fireEvent.click(finance);
    await screen.findByText('حُفظ.');
    expect(bodies('/api/settings/ai', 'PATCH')).toEqual([{ intelligenceScopes: ['orders', 'finance'] }]);
  });

  it('unticking a scope sends the scopes without it', async () => {
    await draw();
    fireEvent.click(section('المساعدون'));
    const ticked = (await screen.findAllByRole('checkbox')).filter((b) => (b as HTMLInputElement).checked);
    expect(ticked.length).toBe(1);
    fireEvent.click(ticked[0]);
    await screen.findByText('حُفظ.');
    expect(bodies('/api/settings/ai', 'PATCH')).toEqual([{ intelligenceScopes: [] }]);
  });

  it('the spend cap saves the same figures through the same door', async () => {
    await draw();
    fireEvent.change(screen.getByLabelText('السقف الشهري (رمز)'), { target: { value: '5000' } });
    fireEvent.click(screen.getByRole('button', { name: /احفظ السقف/ }));
    await screen.findByText('حُفظ السقف.');
    const put = apiJson.mock.calls.find(([u, init]) => u === '/api/settings/ai' && init?.method === 'PUT');
    expect(JSON.parse(put![1].body)).toEqual({ spendCap: { dailyTokens: 1000, monthlyTokens: 5000 } });
  });

  it('a template turned off with the switch, a placeholder clicked in, saved with the same body', async () => {
    await draw();
    fireEvent.click(section('النصوص والقوالب'));
    fireEvent.click(screen.getByRole('button', { name: /^التأكيد/ }));
    const sw = await screen.findByRole('switch', { name: 'مفعّل' });
    expect((sw as HTMLInputElement).checked).toBe(true);
    fireEvent.click(sw);
    expect((sw as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'اسم الزبون' }));
    fireEvent.click(screen.getByRole('button', { name: /احفظ القوالب/ }));
    await screen.findByText('تم الحفظ');
    const put = apiJson.mock.calls.find(([u, init]) => u === '/api/settings/messages' && init?.method === 'PUT');
    const sent = JSON.parse(put![1].body).templates;
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ id: 't1', active: false });
    expect(sent[0].body).toContain('{اسم_الزبون}');
  });

  it('the bin removes the template from what is saved', async () => {
    await draw();
    fireEvent.click(section('النصوص والقوالب'));
    fireEvent.click(screen.getByRole('button', { name: /^التأكيد/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'احذف القالب' }));
    fireEvent.click(screen.getByRole('button', { name: /احفظ القوالب/ }));
    await screen.findByText('تم الحفظ');
    const put = apiJson.mock.calls.find(([u, init]) => u === '/api/settings/messages' && init?.method === 'PUT');
    expect(JSON.parse(put![1].body).templates).toEqual([]);
  });
});

describe('what leaves the company is said beside the control', () => {
  const WARN = /هالمساعد بيقرا بيانات زبون — الاسم والملاحظات ما بيطلعوا لمزوّد خارجي/;

  it('an assistant that reads a customer, routed to an outside vendor, carries the warning and the way to a full answer', async () => {
    routes = { confirmation: { provider: 'ANTHROPIC', model: 'm1', keyFrom: 'system', baseUrl: null } };
    await draw();
    fireEvent.click(section('المساعدون'));
    await screen.findByText('ما يقرؤه مركز الذكاء');
    expect(screen.getAllByText(WARN).length).toBeGreaterThan(0);
    expect(screen.getAllByText('لنتيجة كاملة: نموذج على خادمك').length).toBeGreaterThan(0);
  });

  it('NEGATIVE: the same assistant on the owner\'s own server carries no warning', async () => {
    routes = { confirmation: { provider: 'LOCAL', model: 'l1', keyFrom: 'none', baseUrl: 'http://localhost:11434' } };
    await draw();
    fireEvent.click(section('المساعدون'));
    await screen.findByText('ما يقرؤه مركز الذكاء');
    expect(screen.queryAllByText(WARN)).toEqual([]);
  });
});

describe('who may press', () => {
  it('NEGATIVE: a person who may only look gets no save, no key box, and locked ticks', async () => {
    who.permissions = ['settings.view'];
    const { container } = await draw();
    await waitFor(() => expect(screen.queryByText(/حسابات المزوّدين تُضبط على مستوى النظام/)).not.toBeNull());
    expect(keyBoxes(container)).toEqual([]);
    expect(screen.queryByRole('button', { name: /احفظ/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'احذف المفتاح' })).toBeNull();
    fireEvent.click(section('المساعدون'));
    const boxes = await screen.findAllByRole('checkbox');
    expect(boxes.every((b) => (b as HTMLInputElement).disabled)).toBe(true);
  });
});

describe('every button is a button, and the page fits a phone', () => {
  it('every button on every section says type="button"', async () => {
    const { container } = await draw();
    fireEvent.click(section('النصوص والقوالب'));
    fireEvent.click(screen.getByRole('button', { name: /الملخّص اليومي/ }));
    fireEvent.click(screen.getByRole('button', { name: /^التأكيد/ }));
    await screen.findByText('النسخ السابقة (1)');
    const all = Array.from(container.querySelectorAll('button'));
    expect(all.length).toBeGreaterThan(20);
    expect(all.filter((b) => b.getAttribute('type') !== 'button').map((b) => b.textContent)).toEqual([]);
  });

  const FILES = [
    'src/components/screens/AiSettingsScreen.tsx',
    'src/components/screens/ai/AssistantsTable.tsx',
    'src/components/screens/ai/AiSpendCapCard.tsx',
    'src/components/settings/MessageTemplatesCard.tsx',
  ];
  const XS = ['text', 'xs'].join('-');
  const LEGACY = [['out', 'line'].join(''), ['gh', 'ost'].join(''), ['succ', 'ess'].join('')];
  it.each(FILES)('%s: no legacy variant, no raw tick, no hand-drawn tab, no extra-small text', (file) => {
    const src = readFileSync(join(process.cwd(), file), 'utf8');
    expect(src).not.toMatch(new RegExp('variant="(' + LEGACY.join('|') + ')"'));
    expect(src).not.toMatch(/<input\s+type="checkbox"/);
    expect(src).not.toMatch(/onClick=\{\(\) => setTab\(/);
    expect(src).not.toMatch(new RegExp(`(?<![\\w-])${XS}(?![\\w-])`));
  });

  const WIDE = new RegExp('(?:^|\\s)(?:min-)?w-\\[(\\d+)px\\]', 'g');
  const COLS = new RegExp('(?:^|\\s)' + ['grid', 'cols'].join('-') + '-[2-9]');
  it('375px: no fixed width wider than a phone, and every grid is one column before its break', async () => {
    const { container } = await draw();
    fireEvent.click(section('المساعدون'));
    await screen.findByText('ما يقرؤه مركز الذكاء');
    for (const el of Array.from(container.querySelectorAll<HTMLElement>('[class]'))) {
      const cls = el.getAttribute('class') ?? '';
      for (const m of cls.matchAll(WIDE)) expect(Number(m[1]), cls).toBeLessThanOrEqual(375);
      if (COLS.test(cls)) throw new Error(`عمودين بلا نقطة كسر: ${cls}`);
    }
  });
});
