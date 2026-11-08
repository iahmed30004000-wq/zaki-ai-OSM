// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — «طلباتي» says the work comes first (the owner, 8/11: «الشغل أول»)
 *
 * «لازم تجبرها ترن ع طلبات لا يرد» — and the screen must make it obvious what she pulled and that she has work now.
 *
 *  1. The tabs are «اتصلي هلّق» · «بانتظار» · «أكّدتها» (they were «للشغل» · «لا يرد»), each with a note that says what it holds.
 *  2. A banner at the top of HER desk: «عندك N طلبات لازم ترني عليهم هلّق», or «خلّصتي. اسحبي التالي» when nothing is owed and
 *     a pull is possible. Not on a colleague's desk; not on a response that does not say.
 *  3. The pull button stays pressable while she owes calls, says «اسحب طلب جديد — خلّصي اللي فوق أول», and a press OPENS the
 *     oldest owed order instead of asking the server for another. With nothing owed it is the pull it was — and what she pulls
 *     is under «اتصلي هلّق» at once.
 *  4. The cards say what they are: «جديد — سحبتيه هلّق» · «لا يرد راجع — جولة n من 3» · «الزبون طلب نكلمو هلّق», and a waiting
 *     card says «جاهز الساعة HH:MM». The WORDS are the server's (`dueWords`, written on the store's clock — route and pure tests
 *     hold them); the screen prints the line it is sent and ships no wording logic (its first-load JavaScript is held under a ceiling).
 *  5. A pull the server refuses with WORK_FIRST anyway (a stale tab) reads the desk again and opens the order it names.
 *
 * Blockers: no money, no permission, no order creation.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { api, scrolled, toast } = vi.hoisted(() => ({
  api: vi.fn(),
  scrolled: [] as string[],
  toast: { failed: vi.fn(), done: vi.fn(), warn: vi.fn() },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/confirmation/mine',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => toast }));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({
    currentUser: {
      id: 'u1', name: 'سارة', role: 'CONFIRMATION_AGENT', status: 'ACTIVE',
      permissions: ['confirmation.work', 'confirmation.pull', 'orders.contact_log'],
    },
    t: {},
    locale: 'ar',
  }),
}));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => false }));
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
vi.mock('@/components/orders/OrderDetailModal', () => ({
  OrderDetailModal: ({ orderId }: { orderId: string }) => <div data-testid="order-window" data-order={orderId} />,
}));
vi.mock('@/components/orders/CustomerHistory', () => ({ CustomerHistoryButton: () => null, CustomerHistoryOffer: () => null }));
vi.mock('@/components/orders/ContactButtons', () => ({ ContactButtons: () => <i data-testid="contact-strip" /> }));
vi.mock('@/components/screens/confirmation/ActionDialogs', () => ({
  ChangeRequestDialog: () => null,
  IssueDialog: () => null,
  PostponeDialog: () => null,
  RejectDialog: () => null,
}));
vi.mock('@/components/screens/confirmation/AssistantDialog', () => ({ AssistantDialog: () => null }));

import { ConfirmationMineScreen } from '@/components/screens/ConfirmationMineScreen';
import { dueSentence, dueTag } from '@/lib/work-first';

type Row = Record<string, unknown>;
const order = (id: string, over: Row = {}): Row => ({
  id,
  orderNumber: `JO-${id}`,
  merchantRef: null,
  confirmationStatus: 'IN_PROGRESS',
  state: 'NEW',
  previousOrders: 0,
  version: 1,
  totalAmount: 45,
  currency: 'JOD',
  claimedAt: null,
  firstActionAt: null,
  postponedUntil: null,
  postponePreferredTime: null,
  postponeCount: 0,
  noAnswerCount: 0,
  source: 'MANUAL',
  moderatorId: null,
  moderator: null,
  createdBy: null,
  channel: null,
  deliveryAddress: 'شارع الجلاء',
  regionId: 'r1',
  region: { id: 'r1', name: 'عمّان' },
  customerNotes: null,
  customer: { id: `c-${id}`, fullName: 'زبون', phone: '0790000001', rawPhone: '0790000001', city: 'عمّان', address: 'عنوان' },
  items: [{ id: `l-${id}`, productName: 'كريم', quantity: 1, freeQuantity: 0, lineTotal: 45 }],
  addOns: [],
  _count: { contactAttempts: 0, notes: 0 },
  ...over,
});
/** A card the server says is owed (`dueNow`), with the reason and the line it wrote for it. */
const owed = (id: string, reason: 'NEW' | 'ROUND' | 'PROMISE', over: Row = {}) =>
  order(id, {
    dueNow: true,
    dueReason: reason,
    dueAt: null,
    dueWords: dueTag(reason, Number(over.noAnswerCount ?? 0), 3),
    _count: { contactAttempts: reason === 'NEW' ? 0 : 2, notes: 0 },
    ...over,
  });
/** A waiting card: when it falls due, and the line the server wrote for it. */
const waits = (id: string, words: string, over: Row = {}) => order(id, { noAnswerCount: 1, dueNow: false, dueReason: null, dueAt: '2026-11-02T13:00:00.000Z', dueWords: words, ...over });

/** Monday 2 November 2026, 14:00 in Amman. */
const SERVER_NOW = '2026-11-02T11:00:00.000Z';

const desk = (over: Row = {}) => ({
  leadDays: 2, waitingLater: 0, noAnswerLimit: 3, rounds: true, serverNow: SERVER_NOW,
  work: [], noAnswer: [], closedToday: [],
  due: { count: 0, first: null, sentence: 'خلّصتي. اسحبي التالي', button: null },
  confirmed: { day: '', q: '', page: 1, pageSize: 25, total: 0, pages: 1, rows: [] },
  ...over,
});
/** The desk with `works` owed, the oldest first. */
const deskOwing = (works: Row[], waiting: Row[] = [], over: Row = {}) =>
  desk({
    work: works,
    noAnswer: waiting,
    due: works.length
      ? { count: works.length, first: { id: works[0].id, orderNumber: works[0].orderNumber }, sentence: dueSentence(works.length), button: 'اسحب طلب جديد — خلّصي اللي فوق أول' }
      : { count: 0, first: null, sentence: 'خلّصتي. اسحبي التالي', button: null },
    ...over,
  });
const pool = (over: Row = {}) => ({
  waiting: 5, owned: { total: 3, withoutAttempt: 0 }, caps: { withoutAttempt: 40, total: 500 }, leadDays: 2,
  canPull: true, refusal: null, autoReleased: 0, orders: null, ...over,
});

const state = { desk: desk() as unknown, pool: pool() as unknown, pulled: null as null | { next: unknown }, pullFails: null as null | Error };
const posts = () => api.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'POST' && c[0] === '/api/confirmation/pull');

beforeEach(() => {
  vi.clearAllMocks();
  scrolled.length = 0;
  state.desk = desk();
  state.pool = pool();
  state.pulled = null;
  state.pullFails = null;
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this.id);
  };
  api.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST' && url === '/api/confirmation/pull') {
      if (state.pullFails) {
        // The world as the server knows it is what the next read of the desk returns.
        if (state.pulled) state.desk = state.pulled.next;
        throw state.pullFails;
      }
      if (state.pulled) state.desk = state.pulled.next;
      return { order: { id: 'new' } };
    }
    if (url.startsWith('/api/confirmation/mine')) return state.desk;
    if (url === '/api/confirmation/queue') return state.pool;
    throw new Error(`unexpected ${init?.method ?? 'GET'} ${url}`);
  });
});
afterEach(cleanup);

const tab = (name: RegExp) => screen.getByRole('tab', { name });

describe('1 · the tabs', () => {
  it('are «اتصلي هلّق» · «بانتظار» · «أكّدتها», with a note that says what each holds — and the old names are gone', async () => {
    state.desk = deskOwing([owed('a', 'NEW')], [waits('w', 'جاهز الساعة 16:00')]);
    render(<ConfirmationMineScreen />);
    await screen.findByRole('tab', { name: /اتصلي هلّق/ });
    expect(tab(/اتصلي هلّق/).getAttribute('title')).toBe('اللي لازم ترني عليه هلّق');
    expect(tab(/بانتظار/).getAttribute('title')).toBe('ما ردّ — بيصير جاهز بوقتو');
    expect(tab(/أكّدتها/)).toBeTruthy();
    expect(screen.queryByRole('tab', { name: /للشغل/ })).toBeNull();
    expect(screen.queryByRole('tab', { name: /^لا يرد/ })).toBeNull();
    // The count is on the tab, from the same list the cards come from.
    expect(within(tab(/اتصلي هلّق/)).getByText('1')).toBeTruthy();
    expect(within(tab(/بانتظار/)).getByText('1')).toBeTruthy();
  });

  it('with «نظام الجولات» off «بانتظار» keeps the old sentence: nothing falls due by the clock, so it must not promise a time', async () => {
    state.desk = desk({ rounds: undefined, noAnswer: [order('w', { noAnswerCount: 1 })] });
    render(<ConfirmationMineScreen />);
    await screen.findByRole('tab', { name: /بانتظار/ });
    expect(tab(/بانتظار/).getAttribute('title')).toBe('محاولة أو محاولتين — التالية تُغلق');
  });
});

describe('2 · the banner', () => {
  it('says how many she owes — in the counting of the desk', async () => {
    state.desk = deskOwing([owed('a', 'NEW'), owed('b', 'ROUND', { noAnswerCount: 1 }), owed('c', 'PROMISE')]);
    render(<ConfirmationMineScreen />);
    expect(await screen.findByText('عندك 3 طلبات لازم ترني عليهم هلّق')).toBeTruthy();
  });

  it.each([
    [1, 'عندك طلب واحد لازم ترني عليه هلّق'],
    [2, 'عندك طلبين لازم ترني عليهم هلّق'],
    [11, 'عندك 11 طلب لازم ترني عليهم هلّق'],
  ])('%i → «%s»', async (n, sentence) => {
    const works = Array.from({ length: n }, (_, i) => owed(`o${i}`, 'ROUND', { noAnswerCount: 1 }));
    state.desk = deskOwing(works);
    render(<ConfirmationMineScreen />);
    expect(await screen.findByText(sentence)).toBeTruthy();
  });

  it('nothing owed and a pull possible: «خلّصتي. اسحبي التالي»', async () => {
    state.desk = deskOwing([], [order('w', { noAnswerCount: 1 })]);
    render(<ConfirmationMineScreen />);
    expect(await screen.findByText('خلّصتي. اسحبي التالي')).toBeTruthy();
    expect(screen.queryByText(/^عندك .+ لازم ترني/)).toBeNull();
  });

  it('NEGATIVE: nothing owed and NO pull possible (the pool is empty, or she is at a cap): no sentence about pulling', async () => {
    state.pool = pool({ waiting: 0 });
    state.desk = deskOwing([]);
    render(<ConfirmationMineScreen />);
    await screen.findByRole('tab', { name: /اتصلي هلّق/ });
    await waitFor(() => expect(api.mock.calls.some((c) => c[0] === '/api/confirmation/queue')).toBe(true));
    expect(screen.queryByText('خلّصتي. اسحبي التالي')).toBeNull();
    cleanup();
    state.pool = pool({ canPull: false, refusal: { code: 'CAP_TOTAL', message: 'بلغت الحد.' } });
    render(<ConfirmationMineScreen />);
    await screen.findByText('بلغت الحد.');
    expect(screen.queryByText('خلّصتي. اسحبي التالي')).toBeNull();
  });

  it('NEGATIVE: not on a colleague’s desk (her sentence about somebody else’s orders), and not on a response that does not say', async () => {
    state.desk = deskOwing([owed('a', 'NEW')], [], { viewing: { id: 'u2', name: 'هدى', readOnly: true } });
    render(<ConfirmationMineScreen />);
    await screen.findByText(/عم تشوف شاشة هدى/);
    expect(screen.queryByText(/^عندك .+ لازم ترني/)).toBeNull();
    cleanup();
    const old = desk();
    delete (old as Row).due;
    state.desk = { ...old, work: [order('a')] };
    render(<ConfirmationMineScreen />);
    await screen.findByRole('tab', { name: /اتصلي هلّق/ });
    expect(screen.queryByText(/^عندك .+ لازم ترني/)).toBeNull();
    expect(screen.queryByText('خلّصتي. اسحبي التالي')).toBeNull();
  });
});

describe('3 · the pull button', () => {
  it('while she owes calls: stays pressable, says so — and a press OPENS the oldest owed order, it does not pull', async () => {
    state.desk = deskOwing([owed('old', 'ROUND', { noAnswerCount: 1 }), owed('new', 'NEW')]);
    // Even the pool says she cannot pull, and is empty: the button is the way to the work, not a pull.
    state.pool = pool({ canPull: false, waiting: 0, refusal: { code: 'UNTOUCHED_ORDER', message: 'سجّل محاولة اتصال.', orderId: 'x', orderNumber: 'JO-x' } });
    render(<ConfirmationMineScreen />);
    const button = (await screen.findByRole('button', { name: 'اسحب طلب جديد — خلّصي اللي فوق أول' })) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(screen.queryByRole('button', { name: 'اسحب الطلب التالي' })).toBeNull();

    fireEvent.click(button);
    await waitFor(() => expect(scrolled).toEqual(['desk-order-old']));
    expect(document.getElementById('desk-order-old')?.className).toContain('ring-2');
    expect(posts(), 'the press asked the server for another order').toHaveLength(0);
  });

  it('from another tab it takes her to the tab that holds the oldest', async () => {
    state.desk = deskOwing([owed('old', 'NEW')], [order('w', { noAnswerCount: 1 })]);
    render(<ConfirmationMineScreen />);
    fireEvent.click(await screen.findByRole('tab', { name: /بانتظار/ }));
    expect(screen.queryByText('JO-old')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'اسحب طلب جديد — خلّصي اللي فوق أول' }));
    await waitFor(() => expect(scrolled).toEqual(['desk-order-old']));
    expect(tab(/اتصلي هلّق/).getAttribute('aria-selected')).toBe('true');
  });

  it('with nothing owed it is the pull it was — and what she pulled is under «اتصلي هلّق» at once, wherever she was looking', async () => {
    state.desk = deskOwing([], [order('w', { noAnswerCount: 1 })]);
    state.pulled = { next: deskOwing([owed('fresh', 'NEW')], [order('w', { noAnswerCount: 1 })]) };
    render(<ConfirmationMineScreen />);
    fireEvent.click(await screen.findByRole('tab', { name: /بانتظار/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'اسحب الطلب التالي' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    await waitFor(() => expect(tab(/اتصلي هلّق/).getAttribute('aria-selected')).toBe('true'));
    // The card she pulled is drawn, with its tag.
    expect(await screen.findByText('جديد — سحبتيه هلّق')).toBeTruthy();
    expect(document.getElementById('desk-order-fresh')).toBeTruthy();
  });
});

describe('4 · the cards', () => {
  it('a new pull: «جديد — سحبتيه هلّق»', async () => {
    state.desk = deskOwing([owed('a', 'NEW')]);
    render(<ConfirmationMineScreen />);
    expect(await screen.findByText('جديد — سحبتيه هلّق')).toBeTruthy();
  });

  it('a returned «لا يرد»: «لا يرد راجع — جولة n من 3» — and the round is not said twice on the same card', async () => {
    state.desk = deskOwing([owed('a', 'ROUND', { noAnswerCount: 2 })]);
    render(<ConfirmationMineScreen />);
    expect(await screen.findByText('لا يرد راجع — جولة 2 من 3')).toBeTruthy();
    expect(screen.queryByText(/\(2\/3\)/), 'the old chip repeats the tag').toBeNull();
  });

  it('a returned «لا يرد» with no round counted yet (a press with no «اتصل»): the tag without a round', async () => {
    state.desk = deskOwing([owed('a', 'ROUND', { noAnswerCount: 0 })]);
    render(<ConfirmationMineScreen />);
    expect(await screen.findByText('لا يرد راجع')).toBeTruthy();
  });

  it('a date that came: «الزبون طلب نكلمو هلّق»', async () => {
    state.desk = deskOwing([owed('a', 'PROMISE', { postponedUntil: '2026-11-02T08:00:00.000Z' })]);
    render(<ConfirmationMineScreen />);
    expect(await screen.findByText('الزبون طلب نكلمو هلّق')).toBeTruthy();
  });

  it('a waiting card prints the line the server wrote for it: when it is ready', async () => {
    state.desk = deskOwing([], [waits('w', 'جاهز الساعة 16:00')]);
    render(<ConfirmationMineScreen />);
    fireEvent.click(await screen.findByRole('tab', { name: /بانتظار/ }));
    expect(await screen.findByText('جاهز الساعة 16:00')).toBeTruthy();
  });

  it('…tomorrow’s as it was sent, word for word — the screen words nothing itself', async () => {
    state.desk = deskOwing([], [waits('w', 'جاهز بكرة الساعة 10:00')]);
    render(<ConfirmationMineScreen />);
    fireEvent.click(await screen.findByRole('tab', { name: /بانتظار/ }));
    expect(await screen.findByText('جاهز بكرة الساعة 10:00')).toBeTruthy();
  });

  it('a response from before the words existed: the card is drawn with no line at all', async () => {
    state.desk = deskOwing([], [order('w', { noAnswerCount: 1, dueNow: false, dueAt: '2026-11-02T13:00:00.000Z' })]);
    render(<ConfirmationMineScreen />);
    fireEvent.click(await screen.findByRole('tab', { name: /بانتظار/ }));
    await screen.findByText('JO-w');
    expect(screen.queryByText(/جاهز (بكرة )?الساعة/)).toBeNull();
  });

  it('NEGATIVE: an order that needs a decision (owed nothing, no time) carries no tag at all', async () => {
    state.desk = deskOwing([], [order('d', { noAnswerCount: 1, dueNow: false, dueAt: null })]);
    render(<ConfirmationMineScreen />);
    fireEvent.click(await screen.findByRole('tab', { name: /بانتظار/ }));
    await screen.findByText('JO-d');
    expect(screen.queryByText(/جاهز (بكرة )?الساعة/)).toBeNull();
    expect(screen.queryByText(/سحبتيه|لا يرد راجع|نكلمو/)).toBeNull();
    // …and the old words for the count are still there, as ever.
    expect(screen.getByText(/جولة 1 من 3/)).toBeTruthy();
  });

  it('NEGATIVE: on a colleague’s desk the tags are not drawn (they speak to her)', async () => {
    state.desk = deskOwing([owed('a', 'NEW')], [], { viewing: { id: 'u2', name: 'هدى', readOnly: true } });
    render(<ConfirmationMineScreen />);
    await screen.findByText('JO-a');
    expect(screen.queryByText('جديد — سحبتيه هلّق')).toBeNull();
  });
});

describe('5 · a pull the server refuses «الشغل أول» (a stale tab)', () => {
  const refused = () =>
    Object.assign(new Error('عندك طلب واحد لازم ترني عليه هلّق قبل سحب طلب جديد — أولها الطلب JO-late.'), {
      status: 409,
      data: {
        code: 'WORK_FIRST',
        error: 'عندك طلب واحد لازم ترني عليه هلّق قبل سحب طلب جديد — أولها الطلب JO-late.',
        orderId: 'late',
        orderNumber: 'JO-late',
        count: 1,
      },
    });

  it('says why, reads the desk again and opens the order it names', async () => {
    // The screen believes nothing is owed; by the time she presses, the order's round has come.
    state.desk = deskOwing([], [waits('late', 'جاهز الساعة 13:59')]);
    state.pulled = { next: deskOwing([owed('late', 'ROUND', { noAnswerCount: 1 })]) };
    state.pullFails = refused();
    render(<ConfirmationMineScreen />);
    fireEvent.click(await screen.findByRole('button', { name: 'اسحب الطلب التالي' }));

    await waitFor(() => expect(toast.failed).toHaveBeenCalledWith('عندك طلب واحد لازم ترني عليه هلّق قبل سحب طلب جديد — أولها الطلب JO-late.'));
    await waitFor(() => expect(scrolled).toEqual(['desk-order-late']));
    // The desk now knows: the banner, the tab, the button.
    expect(await screen.findByText('عندك طلب واحد لازم ترني عليه هلّق')).toBeTruthy();
    expect(tab(/اتصلي هلّق/).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('button', { name: 'اسحب طلب جديد — خلّصي اللي فوق أول' })).toBeTruthy();
  });

  it('NEGATIVE: any other refusal only says why — the desk does not jump anywhere', async () => {
    state.desk = deskOwing([], [order('w', { noAnswerCount: 1 })]);
    state.pullFails = Object.assign(new Error('بلغت الحد الأقصى (500 طلب لديك).'), { status: 409, data: { code: 'CAP_TOTAL' } });
    render(<ConfirmationMineScreen />);
    fireEvent.click(await screen.findByRole('button', { name: 'اسحب الطلب التالي' }));
    await waitFor(() => expect(toast.failed).toHaveBeenCalledWith('بلغت الحد الأقصى (500 طلب لديك).'));
    expect(scrolled).toEqual([]);
    expect(screen.queryByTestId('order-window')).toBeNull();
  });
});

/**
 * THE WORDS ARE THE SERVER'S — AND THAT IS HELD WITHOUT A BUILD.
 *
 * «طلباتي» is the agents' first-load JavaScript, held under a ceiling gzipped (`staff-confirmation-first-load.test.ts`) with about
 * a kilobyte to spare. The banner, the caught-up line, the pull button's label and each card's line are written by the server
 * (`work-first.ts`, `/api/confirmation/mine`); the screen prints what it is sent. The day the screen imports the wording helpers
 * again (a formatter, a sentence-builder), every agent's phone downloads them — and the budget step, which needs a build, is the
 * one that says so, late.
 */
describe('the screen ships no wording logic', () => {
  it('neither the desk nor the pull panel imports the wording helpers (types are erased and cost nothing)', async () => {
    const { repoFile, stripComments } = await import('@/lib/guard-source');
    for (const file of ['src/components/screens/ConfirmationMineScreen.tsx', 'src/components/confirmation/PullPanel.tsx']) {
      const code = stripComments(repoFile(file));
      expect(code, file).not.toMatch(/import (?!type)[^;]*from '@\/lib\/work-first'/);
    }
  });
});
