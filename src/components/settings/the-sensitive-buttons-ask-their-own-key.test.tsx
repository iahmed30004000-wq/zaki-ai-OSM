// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE SENSITIVE BUTTONS ASK THEIR OWN DOOR'S KEY (RV168).
 *
 * The settings pages all open on «عرض الإعدادات». The doors behind the
 * sensitive buttons — the scheduled jobs, a courier's account and its link,
 * the ad accounts, the AI provider and its routing, the penalty rules, the
 * thresholds, the post-order window, the message templates — ask
 * «الإعدادات الحسّاسة». So everybody who reached the page was offered the
 * buttons, and only the server said no, in its own words: a control that is
 * visible and refuses reads as a broken system, not as a boundary.
 *
 * Each case below renders the real component twice: for somebody who has
 * only «عرض الإعدادات» (the buttons are not there), and for somebody who also
 * holds the key (they are). The server is unchanged; this is what is OFFERED.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { app, api } = vi.hoisted(() => ({
  app: { value: {} as Record<string, unknown> },
  api: { answers: {} as Record<string, unknown>, calls: [] as string[] },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/settings/system',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/context/AppContext', () => ({ useApp: () => app.value }));
vi.mock('@/lib/api-client', () => ({
  apiJson: async (url: string) => {
    api.calls.push(url);
    const hit = Object.keys(api.answers).find((p) => url === p || url.startsWith(`${p}?`));
    if (!hit) throw new Error(`unexpected request ${url}`);
    return api.answers[hit];
  },
}));
vi.mock('@/components/ui/Confirm', () => ({ useConfirm: () => vi.fn(async () => true), useTell: () => vi.fn() }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), success: vi.fn(), done: vi.fn() }) }));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => <h1>المهام</h1> }));
vi.mock('@/hooks/useLiveRefresh', () => ({
  // Loads once on mount — never on an interval, never per render.
  useLiveRefresh: (load: () => unknown) => {
    const latest = React.useRef(load);
    latest.current = load;
    React.useEffect(() => {
      void latest.current();
    }, []);
  },
}));

import { JobsScreen } from '@/components/screens/JobsScreen';
import { AiSettingsScreen } from '@/components/screens/AiSettingsScreen';
import { AssistantsTable } from '@/components/screens/ai/AssistantsTable';
import { CourierCredentials } from './CourierCredentials';
import { CourierWebhook } from './CourierWebhook';
import { PostOrderOfferCard } from './PostOrderOfferCard';
import { PerformanceSettingsCard } from './PerformanceSettingsCard';
import { PenaltyRulesCard } from './PenaltyRulesCard';
import { MessageTemplatesCard } from './MessageTemplatesCard';
import { AdAccountsCard } from './AdAccountsCard';

function signedIn(holdsTheKey: boolean) {
  app.value = {
    locale: 'ar',
    isRtl: true,
    t: {},
    currentUser: {
      id: 'u0',
      name: 'موظف',
      role: 'COMPANY_ADMIN',
      status: 'ACTIVE',
      permissions: holdsTheKey ? ['settings.view', 'settings.manage'] : ['settings.view'],
    },
  };
}

beforeEach(() => {
  api.answers = {};
  api.calls = [];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Render for the person without the key, then for the one with it; `check` runs against each. */
async function bothWays(mount: () => void, ready: () => Promise<void>, drawn: () => Record<string, boolean>) {
  signedIn(false);
  mount();
  await ready();
  const without = drawn();
  cleanup();
  signedIn(true);
  mount();
  await ready();
  const withIt = drawn();
  return { without, withIt };
}
const has = (text: string | RegExp) => screen.queryByText(text) !== null;
const hasLabel = (label: string | RegExp) => screen.queryByLabelText(label) !== null;

describe('the scheduled jobs', () => {
  it('«شغّلها كلَّها»، «شغّلها الآن» and «أعد تفعيلها» are not offered without the key', async () => {
    api.answers['/api/admin/jobs'] = {
      jobs: [{
        name: 'orders-sync', description: 'يزامن الطلبات', everySeconds: 60, schedule: 'كل دقيقة', last: null, lastSuccessAt: null,
        overdue: false, consecutiveFailures: 0, alerting: false, parked: true,
      }],
      recent: [],
    };
    const { without, withIt } = await bothWays(
      () => render(<JobsScreen />),
      async () => { await screen.findByText('يزامن الطلبات'); },
      () => ({ all: has('شغّلها كلَّها بالترتيب'), now: has('شغّلها الآن'), unpark: has('أعد تفعيلها') }),
    );
    expect(without).toEqual({ all: false, now: false, unpark: false });
    expect(withIt).toEqual({ all: true, now: true, unpark: true });
  });
});

describe('a courier’s account', () => {
  const STATUS = {
    providerId: 'p1', name: 'شركة', adapterCode: 'basha', apiEnabled: true, encryptionAvailable: true, hasCredentials: true,
    readable: true, savedAt: null, savedBy: null, emailHint: null, accountCompanyId: null, senderName: null, originCityId: null,
  };

  it('its test, its entry and its removal are not offered without the key', async () => {
    api.answers['/api/delivery-providers/p1/credentials'] = STATUS;
    const { without, withIt } = await bothWays(
      () => render(<CourierCredentials providerId="p1" />),
      async () => { await screen.findByText(/محفوظ ومشفَّر/); },
      () => ({ test: has('اختبر الاتصال'), enter: has('تغيير الحساب'), remove: hasLabel('حذف الحساب') }),
    );
    expect(without).toEqual({ test: false, enter: false, remove: false });
    expect(withIt).toEqual({ test: true, enter: true, remove: true });
  });

  it('and the link the courier pushes to: minting and stopping it', async () => {
    api.answers['/api/settings/couriers/p1/webhook'] = { configured: true, setAt: null, lastSeenAt: null, polled: false };
    const { without, withIt } = await bothWays(
      () => render(<CourierWebhook providerId="p1" />),
      async () => { await screen.findByText('رابط استقبال الحالات'); },
      () => ({ mint: has('رابط جديد'), stop: has('أوقف الرابط') }),
    );
    expect(without).toEqual({ mint: false, stop: false });
    expect(withIt).toEqual({ mint: true, stop: true });
  });
});

describe('the cards on «إعدادات النظام»', () => {
  it('the post-order window: the save is not offered, and the box cannot be typed in', async () => {
    api.answers['/api/settings/post-order-offer'] = { settings: { windowMinutes: 15 }, defaults: { windowMinutes: 15 }, fixed: [] };
    const box = () => screen.getByRole('spinbutton') as HTMLInputElement;
    const { without, withIt } = await bothWays(
      () => render(<PostOrderOfferCard />),
      async () => { await screen.findByRole('spinbutton'); },
      () => ({ save: has('احفظ'), locked: box().disabled, said: has(/قراءة فقط/) }),
    );
    expect(without).toEqual({ save: false, locked: true, said: true });
    expect(withIt).toEqual({ save: true, locked: false, said: false });
  });

  it('the thresholds: the save is not offered, and every box is locked', async () => {
    api.answers['/api/settings/performance'] = {
      settings: { deliveryRateBar: 0.8, issuesRateBar: 0.1, minSample: 10, period: 'WEEKLY' },
      weights: [],
    };
    const locked = () => [...screen.getAllByRole('spinbutton'), screen.getByRole('combobox')].every((e) => (e as HTMLInputElement).disabled);
    const { without, withIt } = await bothWays(
      () => render(<PerformanceSettingsCard />),
      async () => { await screen.findAllByRole('spinbutton'); },
      () => ({ save: has('احفظ العتبات'), locked: locked(), said: has(/قراءة فقط/) }),
    );
    expect(without).toEqual({ save: false, locked: true, said: true });
    expect(withIt).toEqual({ save: true, locked: false, said: false });
  });

  it('the penalty rules: neither the switch on a rule nor the form for a new one is offered', async () => {
    api.answers['/api/settings/penalty-rules'] = {
      kinds: [{ key: 'LATE', ar: 'تأخير', unitAr: 'دقيقة', sourceAr: 'من الحضور' }],
      roles: [],
      rules: [{ id: 'r1', kind: 'LATE', role: null, perUnit: 1, grace: 10, periodCap: 50, currencyCode: 'JOD', isActive: true }],
    };
    const { without, withIt } = await bothWays(
      () => render(<PenaltyRulesCard />),
      async () => { await screen.findAllByText('تأخير'); },
      () => ({ toggle: has('أوقفها'), add: has('أضف قاعدة'), said: has(/قراءة فقط/) }),
    );
    expect(without).toEqual({ toggle: false, add: false, said: true });
    expect(withIt).toEqual({ toggle: true, add: true, said: false });
  });
});

describe('the message templates', () => {
  it('without the key the card does not even ask for the sample (which the door refuses), and draws a line instead of a red box', async () => {
    api.answers['/api/settings/messages'] = { templates: [], vars: [], languages: [{ code: 'ar', label: 'العربية' }], sample: null };
    signedIn(false);
    render(<MessageTemplatesCard />);
    await screen.findByText(/قوالب الرسائل تتعدّل لمن عنده/);
    expect(api.calls, 'طلب المعاينة اللي بيرفضها الخادم').toEqual([]);
    expect(has('احفظ القوالب')).toBe(false);
    cleanup();

    signedIn(true);
    render(<MessageTemplatesCard />);
    await screen.findByText('احفظ القوالب');
    expect(api.calls).toEqual(['/api/settings/messages?sample=1']);
  });
});

describe('the ad accounts', () => {
  const ACCOUNT = {
    id: 'a1', platform: 'META', accountId: 'act_1234567890', accountName: 'حساب ميتا', tokenHint: '9f3a', status: 'CONNECTED',
    lastError: null, lastSyncAt: null, _count: { campaigns: 2 },
  };
  const PLATFORMS = [{
    platform: 'META', label: 'ميتا', short: 'ميتا', fields: [{ key: 'token', label: 'رمز الوصول', secret: true, placeholder: '' }],
    help: { url: 'https://example.com', urlLabel: 'مدير الإعلانات', steps: ['خطوة'] }, oauth: { available: true },
  }];

  it('connecting, switching and removing are not offered without the key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ accounts: [ACCOUNT], platforms: PLATFORMS }) })));
    const { without, withIt } = await bothWays(
      () => render(<AdAccountsCard />),
      async () => { await screen.findByText('حساب ميتا'); },
      () => ({
        manual: has('إدخال يدوي بالكامل'),
        switch: hasLabel('حوّله إلى يدوي'),
        remove: hasLabel('فصل'),
        said: has(/قراءة فقط/),
      }),
    );
    expect(without).toEqual({ manual: false, switch: false, remove: false, said: true });
    expect(withIt).toEqual({ manual: true, switch: true, remove: true, said: false });
  });
});

describe('the AI settings', () => {
  const PROVIDERS = [{ id: 'ANTHROPIC', label: 'مزوّد', defaultModel: 'm1', models: ['m1'], keyHelp: '' }];

  it('the table of assistants: routing and scopes are locked without the key', () => {
    const props = {
      enabled: [], onSaved: vi.fn(), providers: PROVIDERS, fallback: { provider: 'ANTHROPIC', model: 'm1' },
      routing: {}, onRouted: vi.fn(), routes: {},
    };
    const locked = () => {
      const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
      const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
      return { boxes: boxes.length > 0 && boxes.every((b) => b.disabled), selects: selects.length > 0 && selects.every((s) => s.disabled) };
    };
    signedIn(false);
    render(<AssistantsTable {...props} />);
    expect(locked()).toEqual({ boxes: true, selects: true });
    cleanup();
    signedIn(true);
    render(<AssistantsTable {...props} />);
    const open = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(open.every((b) => !b.disabled)).toBe(true);
    expect((screen.getAllByRole('combobox') as HTMLSelectElement[]).every((s) => !s.disabled)).toBe(true);
  });

  it('the screen: the save for the provider, the routing and the prompts is not offered without the key', async () => {
    api.answers['/api/settings/messages'] = { templates: [], vars: [], languages: [{ code: 'ar', label: 'العربية' }], sample: null };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).endsWith('/system')
          ? { ok: false, json: async () => ({}) }
          : {
              ok: true,
              json: async () => ({
                settings: { provider: 'ANTHROPIC', model: 'm1', prompt: '', prompts: {}, hasKey: false, intelligenceScopes: [], assistants: {} },
                providers: PROVIDERS, jobs: [], routes: {}, defaultRoute: null,
              }),
            }
      )
    );
    const { without, withIt } = await bothWays(
      () => render(<AiSettingsScreen />),
      async () => { await waitFor(() => expect(screen.queryByLabelText('المزوّد')).not.toBeNull()); },
      () => ({
        save: has('احفظ الإعدادات والنصوص'),
        locked: (screen.getByLabelText('المزوّد') as HTMLSelectElement).disabled,
        said: has(/قراءة فقط/),
      }),
    );
    expect(without).toEqual({ save: false, locked: true, said: true });
    expect(withIt).toEqual({ save: true, locked: false, said: false });
  });
});

describe('every sensitive screen asks, in its own source', () => {
  const FILES = [
    'src/components/screens/JobsScreen.tsx',
    'src/components/screens/AiSettingsScreen.tsx',
    'src/components/screens/ai/AssistantsTable.tsx',
    'src/components/settings/CourierCredentials.tsx',
    'src/components/settings/CourierWebhook.tsx',
    'src/components/settings/PostOrderOfferCard.tsx',
    'src/components/settings/PerformanceSettingsCard.tsx',
    'src/components/settings/PenaltyRulesCard.tsx',
    'src/components/settings/MessageTemplatesCard.tsx',
    'src/components/settings/AdAccountsCard.tsx',
  ];
  it.each(FILES)('%s asks for «الإعدادات الحسّاسة» before it draws a write', (file) => {
    const src = readFileSync(join(process.cwd(), file), 'utf8');
    expect(src, file).toContain("useCan('settings.manage')");
  });
});
