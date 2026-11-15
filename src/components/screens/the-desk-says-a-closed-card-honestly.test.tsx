// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «طلباتي» PRINTS A CLOSED-TODAY CARD HONESTLY (RV2391, the planner's ruling 9 — three string-level edits of the screen, no import, no element).
 *
 * The server decides whether the count on a closed card is the close's (`closedWords`, only under the plan and only below the limit); the screen prints what it is told:
 *
 *  1. `closedWords` present → the header and the footer both say it («بعد عدّة محاولات بلا رد»), and neither prints a number («ما ردّ 0 مرّات», «5 محاولات»).
 *  2. Absent → the count as always: «ما ردّ N مرّات» and «أُغلق بعد N محاولات بلا رد» with the CARD's own N — the footer used to print the desk's limit, which was wrong the day the switch went off (5 lines, limit 3).
 *  3. Where count and limit agree (every normal close) the text is exactly what it was.
 *  4. The closed card still has no footer buttons and no plan chip; the screen imports no plan logic.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { apiJson, phone } = vi.hoisted(() => ({
  apiJson: vi.fn(),
  phone: { value: false },
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
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => <h1>طلباتي</h1> }));
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

const CLOSED = {
  id: 'o-9',
  orderNumber: 'SY-26-2009',
  merchantRef: null,
  confirmationStatus: 'CANCELLED',
  state: 'CANCELLED',
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
  _count: { contactAttempts: 3, notes: 0 },
  risk: null,
};

let deskOverride: Record<string, unknown> = {};

beforeEach(() => {
  vi.clearAllMocks();
  phone.value = false;
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => true });
  deskOverride = {};
  window.localStorage.clear();
  window.sessionStorage.clear();
  apiJson.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/confirmation/mine')) {
      return {
        leadDays: 2,
        waitingLater: 0,
        noAnswerLimit: 3,
        dialCode: '963',
        serverNow: new Date(1_800_000_000_000).toISOString(),
        work: [],
        noAnswer: [],
        closedToday: [CLOSED],
        confirmed: { day: '', q: '', page: 1, pageSize: 25, total: 0, pages: 1, rows: [] },
        ...deskOverride,
      };
    }
    if (url === '/api/confirmation/queue') {
      return { waiting: 5, owned: { total: 1, withoutAttempt: 0 }, caps: { withoutAttempt: 3, total: 10 }, leadDays: 2, canPull: true, refusal: null, autoReleased: 0, orders: null };
    }
    if (url === '/api/settings/messages') return { templates: [] };
    return { ok: true };
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Closed cards are drawn only inside the «بانتظار» tab. */
const draw = async (closed: Record<string, unknown>, desk: Record<string, unknown> = {}) => {
  deskOverride = { closedToday: [{ ...CLOSED, ...closed }], ...desk };
  render(<ConfirmationMineScreen />);
  fireEvent.click(await screen.findByRole('tab', { name: /بانتظار/ }));
  await screen.findByText('SY-26-2009');
};
const header = (text: string) => screen.queryByText(text);
const footer = header;
const FOOT_TAIL = '. إعادةُ فتحِه من مركز التأكيد، بيد مَن يملك ذلك.';

describe('the server says the count is not the close’s (`closedWords`)', () => {
  it('the header and the footer both print the sentence, and neither prints a number', async () => {
    await draw({ noAnswerCount: 0, closedWords: 'بعد عدّة محاولات بلا رد' }, { cadenceOn: true, noAnswerLimit: 5 });
    expect(header('أُغلق اليوم تلقائيّاً — بعد عدّة محاولات بلا رد')).toBeTruthy();
    expect(footer(`للقراءة فقط — أُغلق بعد عدّة محاولات بلا رد${FOOT_TAIL}`)).toBeTruthy();
    expect(document.body.textContent).not.toContain('ما ردّ 0 مرّات');
    expect(document.body.textContent).not.toMatch(/\d+ محاولات بلا رد/);
  });
});

describe('no `closedWords`: the count as always, with the CARD’s own number', () => {
  it('the plan switched off after it closed the order (5 lines, limit 3): «ما ردّ 5 مرّات» and «أُغلق بعد 5 محاولات» — the footer no longer says 3', async () => {
    await draw({ noAnswerCount: 5 }, { noAnswerLimit: 3 });
    expect(header('أُغلق اليوم تلقائيّاً — ما ردّ 5 مرّات')).toBeTruthy();
    expect(footer(`للقراءة فقط — أُغلق بعد 5 محاولات بلا رد${FOOT_TAIL}`)).toBeTruthy();
    expect(document.body.textContent).not.toContain('بعد 3 محاولات');
  });

  it('a normal legacy close (3 of 3) and a normal plan close (5 of 5) read exactly as before', async () => {
    await draw({ noAnswerCount: 3 }, { noAnswerLimit: 3 });
    expect(header('أُغلق اليوم تلقائيّاً — ما ردّ 3 مرّات')).toBeTruthy();
    expect(footer(`للقراءة فقط — أُغلق بعد 3 محاولات بلا رد${FOOT_TAIL}`)).toBeTruthy();
    cleanup();
    await draw({ noAnswerCount: 5 }, { cadenceOn: true, noAnswerLimit: 5 });
    expect(header('أُغلق اليوم تلقائيّاً — ما ردّ 5 مرّات')).toBeTruthy();
    expect(footer(`للقراءة فقط — أُغلق بعد 5 محاولات بلا رد${FOOT_TAIL}`)).toBeTruthy();
  });
});

describe('what did not change', () => {
  it('a closed card has no footer buttons and no plan chip, with or without the sentence', async () => {
    await draw({ noAnswerCount: 0, closedWords: 'بعد عدّة محاولات بلا رد', dueWords: 'لا يرد راجع — محاولة 3 من 5' }, { cadenceOn: true, noAnswerLimit: 5 });
    expect(screen.queryByTitle('اتصال')).toBeNull();
    expect(screen.queryByText('لا يرد راجع — محاولة 3 من 5')).toBeNull();
    expect(screen.queryByRole('button', { name: /^لا يرد/ })).toBeNull();
  });

  it('the screen still imports no plan logic, and the three edits are string-level (the `closedWords` read, the card’s own count)', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/screens/ConfirmationMineScreen.tsx'), 'utf8');
    expect(src).not.toMatch(/no-answer-cadence/);
    expect(src).not.toMatch(/from ['"]@\/lib\/work-first['"]/);
    expect(src).toMatch(/closedWords\?: string;/);
    expect(src).toMatch(/order\.closedWords \?\? noAnswerWords\(order\.noAnswerCount\)/);
    expect(src).toMatch(/order\.closedWords \?\? `بعد \$\{order\.noAnswerCount\} محاولات بلا رد`/);
  });
});
