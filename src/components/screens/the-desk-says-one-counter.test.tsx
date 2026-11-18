// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «طلباتي» SAYS ONE COUNTER, AND ONLY WHAT THE SERVER KNOWS (C1, 18/11 — the owner: «جولة وبعدين محاولة N من 5» · «أزرار بتناقض بطاقاتها»)
 *
 * DEFINITION OF DONE it pins:
 *  1. Under «إثبات المكالمات وجدول المحاولات» (`cadenceOn`, limit 5) the «لا يرد» button prints the attempt THIS press will be — «محاولة 2 من 5» — the same words as the card’s tag; never «لا يرد 1/5»
 *     beside a tag that says 2. No second counter («ما ردّ مرّتين (2/5)») is drawn beside the server’s own line.
 *  2. The hint beside the button says only what the server told the card: `closesOnNext` under the plan; nothing under the rounds (where the arithmetic is false); the old arithmetic only under the base rule.
 *  3. THE OFF PINS: the rounds («جولة N من 3») and the base rule («N/3» and «متبقٍ …») print exactly what they did.
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

const HINT_NEXT = 'المحاولة القادمة تُغلق الطلب تلقائياً';
const nobody = () => document.body.textContent ?? '';
/** The button whose DRAWN text (not the library's name computation, which glues inline children) is exactly this. */
const buttonSaying = (text: string) => screen.getAllByRole('button').find((b) => (b.textContent ?? '').replace(/\s+/g, ' ').trim() === text);

describe('1 · under the plan: one counter, the attempt this press will be', () => {
  const PLAN = { cadenceOn: true, noAnswerLimit: 5 };

  it('count 1: the button says «محاولة 2 من 5» — not «1/5» — and the card carries the server’s line with the same words', async () => {
    phone.value = false;
    withRow({ noAnswerCount: 1, dueWords: 'محاولة 2 من 5 — جاهز الساعة 17:30', closesOnNext: false, attemptWords: 'محاولة 2 من 5' }, PLAN);
    await draw();
    expect(buttonSaying('لا يرد — محاولة 2 من 5'), 'لا يرد — محاولة 2 من 5').toBeTruthy();
    expect(nobody()).not.toMatch(/\b[0-9]\/5\b/);
    expect(screen.getByText('محاولة 2 من 5 — جاهز الساعة 17:30')).toBeTruthy();
    // no second counter beside the server's line: neither the old words nor the old «(1/5)» tag
    expect(nobody()).not.toMatch(/ما ردّ (مرّة|مرّتين|\d+ مرّات)/);
  });

  it('count 0 (a fresh order): «محاولة 1 من 5»', async () => {
    phone.value = false;
    withRow({ noAnswerCount: 0, attemptWords: 'محاولة 1 من 5' }, PLAN);
    await draw();
    expect(buttonSaying('لا يرد — محاولة 1 من 5'), 'لا يرد — محاولة 1 من 5').toBeTruthy();
  });

  it('a full plan (5 counted, still open) has no sixth: «محاولة 5 من 5» on the button and on the tag, from the same function', async () => {
    phone.value = false;
    withRow({ noAnswerCount: 5, dueWords: null, closesOnNext: true, attemptWords: 'محاولة 5 من 5' }, PLAN);
    await draw();
    expect(buttonSaying('لا يرد — محاولة 5 من 5'), 'لا يرد — محاولة 5 من 5').toBeTruthy();
    expect(screen.getAllByText('محاولة 5 من 5').length).toBeGreaterThan(0);
    expect(nobody()).not.toMatch(/\b[0-9]\/5\b/);
  });

  it('on a phone the same button says the same words', async () => {
    phone.value = true;
    withRow({ noAnswerCount: 2, dueWords: 'محاولة 3 من 5 — جاهز الساعة 18:00', closesOnNext: false, attemptWords: 'محاولة 3 من 5' }, PLAN);
    await draw();
    expect(buttonSaying('لا يرد — محاولة 3 من 5'), 'لا يرد — محاولة 3 من 5').toBeTruthy();
  });
});

describe('2 · the hint says only what the server told the card', () => {
  // 18/11 (C1 review): the hint is the SERVER's words now (`noAnswerHint`, `attempt-words.ts` — which rule says what is pinned in `attempt-words.test.ts` and in the desk door's test); the desk prints it and counts nothing.
  it('the server’s hint is printed as it came — «المحاولة القادمة تُغلق الطلب تلقائياً»', async () => {
    phone.value = false;
    withRow({ noAnswerCount: 4, closesOnNext: true, noAnswerHint: HINT_NEXT, dueWords: 'محاولة 5 من 5 — جاهز الساعة 18:00', attemptWords: 'محاولة 5 من 5' }, { cadenceOn: true, noAnswerLimit: 5 });
    await draw();
    expect(screen.getByText(HINT_NEXT)).toBeTruthy();
  });

  it('no hint from the server: none on the card, whatever the count — the plan at 4 of 5, the rounds at 2 of 3, the base rule at 2 of 3 (the old client countdown is gone)', async () => {
    phone.value = false;
    const cases: [Record<string, unknown>, Record<string, unknown>][] = [
      [{ noAnswerCount: 4, closesOnNext: false, attemptWords: 'محاولة 5 من 5' }, { cadenceOn: true, noAnswerLimit: 5 }],
      [{ noAnswerCount: 2 }, { rounds: true, noAnswerLimit: 3 }],
      [{ noAnswerCount: 2 }, { noAnswerLimit: 3 }],
    ];
    for (const [row, desk] of cases) {
      cleanup();
      withRow(row, desk);
      await draw();
      expect(screen.queryByText(HINT_NEXT)).toBeNull();
      expect(nobody()).not.toContain('متبقٍ');
      expect(nobody()).not.toContain('بلغ الحد');
    }
  });

  it('the base rule’s countdown, sent by the server, is printed word for word', async () => {
    phone.value = false;
    withRow({ noAnswerCount: 1, noAnswerHint: 'متبقٍ 2 محاولات قبل الإغلاق التلقائي' }, { noAnswerLimit: 3 });
    await draw();
    expect(screen.getByText('متبقٍ 2 محاولات قبل الإغلاق التلقائي')).toBeTruthy();
  });
  it('the call sheet: under the rounds the old arithmetic no longer warns that the next press closes the order', async () => {
    phone.value = true;
    withRow({ noAnswerCount: 2 }, { rounds: true, noAnswerLimit: 3 });
    await draw();
    ring();
    comeBack(20_000);
    expect(within(sheet()).queryByText('«ما رد» أو «مشغول» أو «مسكّر» هلق بيسكّر الطلب تلقائياً.')).toBeNull();
  });
});

describe('2b · the red «لا يرد» follows the same fact as the hint (review of C1, 18/11)', () => {
  const red = (text: string) => (buttonSaying(text)?.className ?? '').includes('text-[var(--sys-destructive)]');

  it('the plan: red only when the server said a press now closes it — 4 of 5 with closesOnNext false is NOT red, though the old arithmetic (remaining ≤ 1) would make it red', async () => {
    phone.value = false;
    withRow({ noAnswerCount: 4, closesOnNext: false, dueWords: 'محاولة 5 من 5 — جاهز الساعة 18:00', attemptWords: 'محاولة 5 من 5' }, { cadenceOn: true, noAnswerLimit: 5 });
    await draw();
    expect(red('لا يرد — محاولة 5 من 5')).toBe(false);
    cleanup();
    withRow({ noAnswerCount: 1, closesOnNext: true, dueWords: 'محاولة 2 من 5 — جاهز الساعة 18:00', attemptWords: 'محاولة 2 من 5' }, { cadenceOn: true, noAnswerLimit: 5 });
    await draw();
    expect(red('لا يرد — محاولة 2 من 5')).toBe(true);
  });

  it('the rounds: never red (presses are not rounds); the base rule: red at one left, as always', async () => {
    phone.value = false;
    withRow({ noAnswerCount: 2 }, { rounds: true, noAnswerLimit: 3 });
    await draw();
    expect(red('لا يرد 2/3')).toBe(false);
    cleanup();
    withRow({ noAnswerCount: 2 }, { noAnswerLimit: 3 });
    await draw();
    expect(red('لا يرد 2/3')).toBe(true);
  });

  it('the plan: the count chip is not drawn beside the server’s line — neither «ما ردّ …» nor a second «محاولة N من 5» chip', async () => {
    phone.value = false;
    withRow({ noAnswerCount: 2, closesOnNext: false, dueWords: 'محاولة 3 من 5 — جاهز الساعة 18:00', attemptWords: 'محاولة 3 من 5' }, { cadenceOn: true, noAnswerLimit: 5 });
    await draw();
    // the button and the server's line — and nothing else — carry the number
    expect(screen.queryAllByText('محاولة 3 من 5')).toHaveLength(0);
    expect(nobody()).not.toMatch(/ما ردّ (مرّة|مرّتين|\d+ مرّات)/);
  });
});

describe('3 · the older generations print what they always did', () => {
  it('the rounds: «لا يرد 2/3» on the button and «جولة 2 من 3 (2/3)» on the tag', async () => {
    phone.value = false;
    withRow({ noAnswerCount: 2 }, { rounds: true, noAnswerLimit: 3 });
    await draw();
    expect(buttonSaying('لا يرد 2/3'), 'لا يرد 2/3').toBeTruthy();
    expect(screen.getByText(/جولة 2 من 3/)).toBeTruthy();
    expect(nobody()).not.toMatch(/محاولة \d من/);
  });

  it('the base rule: «لا يرد 2/3» and «ما ردّ مرّتين (2/3)»', async () => {
    phone.value = false;
    withRow({ noAnswerCount: 2 }, { noAnswerLimit: 3 });
    await draw();
    expect(buttonSaying('لا يرد 2/3'), 'لا يرد 2/3').toBeTruthy();
    expect(screen.getByText(/ما ردّ مرّتين/)).toBeTruthy();
    expect(nobody()).not.toMatch(/محاولة \d من/);
  });
});

describe('4 · the words live in one place', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
  it('the server writes the attempt through `nextAttemptWords` (the screen prints it), and neither it nor the cadence file spells «محاولة N من 5» by hand', () => {
    const screenSrc = read('src/components/screens/ConfirmationMineScreen.tsx');
    expect(screenSrc).not.toContain("from '@/lib/attempt-words'"); // the server writes the words (the desk bundle is at its ceiling)
    expect(read('src/app/api/confirmation/mine/route.ts')).toContain('nextAttemptWords(desks.get(o.id)!.counted, CADENCE_LIMIT)');
    expect(screenSrc).not.toMatch(/محاولة \$\{/);
    const cadence = read('src/lib/no-answer-cadence.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(cadence).not.toMatch(/محاولة \$\{[^}]*\} من/);
    expect(cadence).not.toMatch(/المحاولة \$\{[^}]*\} من/);
    expect(cadence).toContain('attemptWords');
    expect(cadence).toContain('nextAttemptWords');
  });
});
