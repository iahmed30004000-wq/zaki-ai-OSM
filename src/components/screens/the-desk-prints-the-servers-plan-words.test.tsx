// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «طلباتي» PRINTS THE SERVER'S PLAN WORDS (Confirmation Center v2, step B — four string-only edits of the screen).
 *
 * With «جدول المحاولات» on, the desk answers `cadenceOn`, the limit 5, a per-card `closesOnNext` (a fact of the server's clock) and, with each press, `cadence.words`. The screen decides nothing:
 *
 *  1. The «بانتظار» tab note is the true one for the plan — «ما ردّ — بيصير جاهز بوقتو» — whenever the rounds OR the plan are on; without either it is the old «محاولة أو محاولتين — التالية تُغلق».
 *  2. The call sheet warns that the next «لا يرد» closes the order from the SERVER's `closesOnNext` first; only when the server says nothing (the switch off) the old arithmetic (count + 1 ≥ limit) decides.
 *  3. After a press the notice is exactly the sentence the server wrote (`cadence.words`); a closing press keeps the existing «أُغلق الطلب … تلقائياً بعد N محاولات» with the real N.
 *  4. No cadence module is imported by the screen (its first-load JavaScript is held under a ceiling) and no new control is drawn.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { apiJson, phone, clock } = vi.hoisted(() => ({
  apiJson: vi.fn(),
  phone: { value: true },
  clock: { now: 1_800_000_000_000 },
}));

vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a), apiFetch: vi.fn() }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/' }));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({
    locale: 'ar',
    t: {},
    currentUser: {
      id: 'u1',
      name: 'سارة',
      role: 'CONFIRMATION_AGENT',
      permissions: ['confirmation.work', 'confirmation.pull', 'orders.contact_log'],
      status: 'ACTIVE',
    },
  }),
}));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => phone.value }));
vi.mock('@/hooks/useLiveRefresh', () => ({
  useLiveRefresh: (load: () => Promise<unknown>) => {
    const latest = React.useRef(load);
    latest.current = load;
    React.useEffect(() => {
      void latest.current();
    }, []);
  },
}));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), done: vi.fn(), warn: vi.fn() }) }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/hooks/useRegions', () => ({ useRegions: () => ({ regions: [], countryName: '', currency: null }) }));
vi.mock('@/components/orders/OrderDetailModal', () => ({ OrderDetailModal: () => null }));
vi.mock('@/components/orders/CreateOrderModal', () => ({ CreateOrderModal: () => null }));
vi.mock('@/components/orders/CustomerHistory', () => ({ CustomerHistoryButton: () => null, CustomerHistoryOffer: () => null }));
vi.mock('@/components/screens/confirmation/ActionDialogs', () => ({
  ChangeRequestDialog: () => null,
  IssueDialog: () => null,
  PostponeDialog: () => <div role="dialog" aria-label="تأجيل الطلب" />,
  RejectDialog: () => <div role="dialog" aria-label="رفض الطلب" />,
}));
vi.mock('@/components/screens/confirmation/AssistantDialog', () => ({ AssistantDialog: () => null }));
vi.mock('@/components/screens/ConfirmationPostponedScreen', () => ({ ConfirmationPostponedScreen: () => <div /> }));

import { ConfirmationMineScreen } from './ConfirmationMineScreen';

const ROW = {
  id: 'o-1',
  orderNumber: 'SY-26-1001',
  merchantRef: null,
  confirmationStatus: 'NEW',
  state: 'NEW',
  previousOrders: 0,
  version: 4,
  totalAmount: 45,
  currency: 'SYP',
  claimedAt: null,
  firstActionAt: null,
  postponedUntil: null,
  postponePreferredTime: null,
  postponeCount: 0,
  noAnswerCount: 0,
  source: 'LANDING_PAGE',
  regionId: 'r1',
  region: { name: 'دمشق' },
  moderatorId: null,
  moderator: null,
  createdBy: null,
  channel: null,
  customer: { id: 'c1', fullName: 'نور', phone: '0952554562', rawPhone: '0952554562', city: 'دمشق', address: 'شارع' },
  items: [],
  _count: { contactAttempts: 1, notes: 0 },
  risk: null,
};

/** What the desk adds to its answer, and what the contact door answers a press with. */
let deskOverride: Record<string, unknown> = {};
let pressAnswer: Record<string, unknown> = { autoClosed: false, noAnswerCount: 1 };

const CLOSING_WARNING = '«ما رد» أو «مشغول» أو «مسكّر» هلق بيسكّر الطلب تلقائياً.';

beforeEach(() => {
  vi.clearAllMocks();
  phone.value = true;
  clock.now = 1_800_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => clock.now);
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => true });
  deskOverride = {};
  pressAnswer = { autoClosed: false, noAnswerCount: 1 };
  window.localStorage.clear();
  window.sessionStorage.clear();
  apiJson.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    if (url.startsWith('/api/confirmation/mine')) {
      return {
        leadDays: 2,
        waitingLater: 0,
        noAnswerLimit: 3,
        dialCode: '963',
        serverNow: new Date(clock.now).toISOString(),
        work: [ROW],
        noAnswer: [],
        closedToday: [],
        confirmed: { day: '', q: '', page: 1, pageSize: 25, total: 0, pages: 1, rows: [] },
        ...deskOverride,
      };
    }
    if (url === '/api/confirmation/queue') {
      return { waiting: 5, owned: { total: 1, withoutAttempt: 0 }, caps: { withoutAttempt: 3, total: 10 }, leadDays: 2, canPull: true, refusal: null, autoReleased: 0, orders: null };
    }
    if (url === '/api/settings/messages') return { templates: [] };
    if (url.endsWith('/contact-attempts') && method === 'GET') return { attempts: [] };
    if (url.endsWith('/contact-attempts') && method === 'POST') {
      const body = init?.body ? JSON.parse(init.body) : {};
      return body.result === 'OPENED' ? { autoClosed: false, noAnswerCount: 0 } : pressAnswer;
    }
    return { ok: true };
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const draw = async () => {
  render(<ConfirmationMineScreen />);
  await screen.findByText('SY-26-1001');
};
const ring = () => fireEvent.click(screen.getByTitle('اتصال'));
const sheet = () => screen.getByRole('dialog', { name: 'شو صار؟' });
const comeBack = (afterMs: number) => {
  clock.now += afterMs;
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
};
const withRow = (over: Record<string, unknown>, desk: Record<string, unknown> = {}) => {
  deskOverride = { work: [{ ...ROW, ...over }], ...desk };
};

describe('the «بانتظار» tab note', () => {
  it('the plan on (and no rounds): «ما ردّ — بيصير جاهز بوقتو»', async () => {
    phone.value = false;
    withRow({}, { cadenceOn: true, noAnswerLimit: 5 });
    await draw();
    expect(screen.getAllByText('ما ردّ — بيصير جاهز بوقتو').length).toBeGreaterThan(0);
    expect(screen.queryByText('محاولة أو محاولتين — التالية تُغلق')).toBeNull();
  });

  it('the rounds on: the same note, as before', async () => {
    phone.value = false;
    withRow({}, { rounds: true });
    await draw();
    expect(screen.getAllByText('ما ردّ — بيصير جاهز بوقتو').length).toBeGreaterThan(0);
  });

  it('neither on: the old sentence', async () => {
    phone.value = false;
    await draw();
    expect(screen.getAllByText('محاولة أو محاولتين — التالية تُغلق').length).toBeGreaterThan(0);
    expect(screen.queryByText('ما ردّ — بيصير جاهز بوقتو')).toBeNull();
  });
});

describe('the call sheet’s closing warning', () => {
  it('the server says it will NOT close (closesOnNext false) at 4 of 5: no warning, though the old arithmetic would have said 5 ≥ 5', async () => {
    withRow({ noAnswerCount: 4, closesOnNext: false }, { cadenceOn: true, noAnswerLimit: 5 });
    await draw();
    ring();
    comeBack(20_000);
    expect(within(sheet()).queryByText(CLOSING_WARNING)).toBeNull();
  });

  it('the server says it WILL close (closesOnNext true) at a count of 1: the warning is shown — the server’s fact first', async () => {
    withRow({ noAnswerCount: 1, closesOnNext: true }, { cadenceOn: true, noAnswerLimit: 5 });
    await draw();
    ring();
    comeBack(20_000);
    expect(within(sheet()).getByText(CLOSING_WARNING)).toBeTruthy();
  });

  it('the server says nothing (the switch off): the old arithmetic decides — count + 1 ≥ limit', async () => {
    withRow({ noAnswerCount: 2 }, { noAnswerLimit: 3 });
    await draw();
    ring();
    comeBack(20_000);
    expect(within(sheet()).getByText(CLOSING_WARNING)).toBeTruthy();
    cleanup();
    withRow({ noAnswerCount: 1 }, { noAnswerLimit: 3 });
    await draw();
    ring();
    comeBack(20_000);
    expect(within(sheet()).queryByText(CLOSING_WARNING)).toBeNull();
  });
});

describe('the notice after a press', () => {
  const press = async () => {
    fireEvent.click(screen.getByRole('button', { name: /^لا يرد/ }));
  };

  it('is exactly the sentence the server wrote (cadence.words)', async () => {
    phone.value = false;
    withRow({}, { cadenceOn: true, noAnswerLimit: 5 });
    pressAnswer = {
      autoClosed: false,
      noAnswerCount: 1,
      cadence: { attempt: 1, of: 5, counted: false, dueAt: null, words: 'سجّلنا الضغطة بس ما انحسبت محاولة — لسا بدري. المحاولة 2 من 5 بتنحسب الساعة 17:30.' },
    };
    await draw();
    await press();
    expect(await screen.findByText('سجّلنا الضغطة بس ما انحسبت محاولة — لسا بدري. المحاولة 2 من 5 بتنحسب الساعة 17:30.')).toBeTruthy();
  });

  it('a closing press keeps the existing sentence with the real N, not the words', async () => {
    phone.value = false;
    withRow({}, { cadenceOn: true, noAnswerLimit: 5 });
    pressAnswer = { autoClosed: true, noAnswerCount: 5, cadence: { words: 'الكلام اللي ما لازم يظهر' } };
    await draw();
    await press();
    expect(await screen.findByText('أُغلق الطلب SY-26-1001 تلقائياً بعد 5 محاولات بلا رد.')).toBeTruthy();
    expect(screen.queryByText('الكلام اللي ما لازم يظهر')).toBeNull();
  });

  it('OFF: an answer with no cadence leaves no notice at all, as before', async () => {
    phone.value = false;
    await draw();
    await press();
    await waitFor(() => expect(apiJson.mock.calls.some(([u, i]) => String(u).endsWith('/contact-attempts') && (i as { method?: string })?.method === 'POST')).toBe(true));
    await act(async () => {});
    expect(screen.queryByText(/انحسبت|لسا بدري|أُغلق الطلب/)).toBeNull();
  });
});

describe('the screen ships no plan logic', () => {
  const src = readFileSync(join(process.cwd(), 'src/components/screens/ConfirmationMineScreen.tsx'), 'utf8');

  it('imports none of the cadence modules (nor work-first) — it prints strings and reads facts', () => {
    expect(src).not.toMatch(/no-answer-cadence/);
    expect(src).not.toMatch(/from ['"]@\/lib\/work-first['"]/);
  });

  it('the sheet’s prop reads the server’s fact first and falls back to the old arithmetic', () => {
    expect(src).toMatch(/closesOnNext=\{[^}]*\.closesOnNext \?\? \(/);
    expect(src).toMatch(/noAnswerCount \+ 1 >= data\.noAnswerLimit/);
  });
});
