// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';

/**
 * «أكّدتها» OFFERS NO «طلب تعديل» FOR AN ORDER ON AN OPEN TROLLEY (the owner's ruling 4/11).
 *
 * The raising door refuses every ask of an order on a trolley still being filled (ON_OPEN_TROLLEY). The row reads the
 * trolley the API now sends beside it (`shippingBatch.status`, optional) and says so instead of drawing a press that
 * would fail — the whole sentence on hover. After the handover, and off any trolley, the press is the one it always was.
 */

const { apiJson, user, phone } = vi.hoisted(() => ({
  apiJson: vi.fn(),
  user: { current: null as unknown },
  phone: { value: false },
}));

vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a), apiFetch: vi.fn() }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/' }));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ locale: 'ar', t: {}, currentUser: user.current }) }));
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
vi.mock('@/components/orders/OrderDetailModal', () => ({ OrderDetailModal: () => null }));
vi.mock('@/components/orders/CustomerHistory', () => ({ CustomerHistoryButton: () => null, CustomerHistoryOffer: () => null }));
vi.mock('@/components/orders/OrderLink', () => ({ OrderLink: ({ number }: { number: string }) => <span>{number}</span> }));
vi.mock('@/components/orders/ContactButtons', () => ({ ContactButtons: () => <i data-contact /> }));
vi.mock('@/components/screens/confirmation/ActionDialogs', () => ({ ChangeRequestDialog: () => null, IssueDialog: () => null, PostponeDialog: () => null, RejectDialog: () => null }));
vi.mock('@/components/screens/confirmation/AssistantDialog', () => ({ AssistantDialog: () => null }));
vi.mock('@/components/confirmation/PullPanel', () => ({ PullPanel: () => null, useQueue: () => ({ reload: vi.fn() }) }));

import { ON_TROLLEY_AR } from '@/lib/order-seal';
import { ConfirmationMineScreen } from './ConfirmationMineScreen';

const LINES = [
  { id: 'l1', productName: 'كريم مرطب', quantity: 3, freeQuantity: 1, lineTotal: 30 },
  { id: 'l2', productName: 'صابون', quantity: 1, freeQuantity: 0, lineTotal: 5 },
];
const ADD_ONS = [{ id: 'a1', productName: 'شامبو', quantity: 2, total: 15 }];

const base = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  orderNumber: `ORD-${id}`,
  merchantRef: null,
  confirmationStatus: 'NEW',
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
  source: 'LANDING_PAGE',
  moderatorId: null,
  moderator: null,
  createdBy: null,
  channel: null,
  deliveryAddress: 'شارع الجلاء بناء 4',
  region: { name: 'دمشق' },
  internalNotes: 'عميل قديم',
  customerNotes: 'اتصلوا بعد العصر',
  customer: { id: `c-${id}`, fullName: `زبون ${id}`, phone: '0790000001', rawPhone: '0790000001', city: 'المزة', address: 'عنوان الزبون', totalOrders: 1 },
  items: LINES,
  addOns: ADD_ONS,
  _count: { contactAttempts: 1, notes: 0 },
  ...over,
});

const desk = (over: Record<string, unknown> = {}) => ({
  leadDays: 2,
  waitingLater: 0,
  noAnswerLimit: 3,
  serverNow: '2026-10-30T08:00:00.000Z',
  work: [base('W1')],
  noAnswer: [base('N1', { noAnswerCount: 1 })],
  closedToday: [],
  confirmed: { day: '2026-10-30', q: '', page: 1, pageSize: 25, total: 1, pages: 1, rows: [base('C1', { confirmationStatus: 'CONFIRMED', state: 'CONFIRMED' })] },
  ...over,
});

const POSTPONED_ROW = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  orderNumber: `ORD-${id}`,
  totalAmount: 45,
  currency: 'JOD',
  dueAt: '2026-10-31T10:00:00.000Z',
  daysRemaining: 1,
  postponePreferredTime: null,
  postponeCount: 1,
  followUpReason: null,
  actionable: true,
  mayHandBack: true,
  deliveryAddress: 'شارع الجلاء بناء 4',
  region: { name: 'دمشق' },
  internalNotes: null,
  customerNotes: 'اتصلوا بعد العصر',
  items: LINES,
  addOns: ADD_ONS,
  customer: { id: 'c1', fullName: 'زبون مؤجل', phone: '0790000001', city: 'المزة', address: 'عنوان الزبون' },
  claimer: { id: 'u1', name: 'سارة' },
  ...over,
});
const FACTS = { total: 1, whens: { now: 1, overdue: 0, soon: 0, week: 0, later: 0 }, kinds: { postponed: 1, followup: 0 }, times: { once: 1, many: 0 }, agents: null };

let mine: ReturnType<typeof desk>;
let postponedRows: ReturnType<typeof POSTPONED_ROW>[];

beforeEach(() => {
  vi.clearAllMocks();
  phone.value = false;
  mine = desk();
  postponedRows = [POSTPONED_ROW('P1')];
  user.current = { id: 'u1', name: 'سارة', role: 'CONFIRMATION_AGENT', permissions: ['confirmation.work', 'orders.contact_log'], status: 'ACTIVE' };
  apiJson.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/confirmation/mine')) return mine;
    if (url.startsWith('/api/confirmation/postponed'))
      return { leadDays: 2, count: postponedRows.length, orders: postponedRows, pagination: { total: postponedRows.length, page: 1, limit: 25, totalPages: 1 }, facts: FACTS, applied: {} };
    throw new Error(`unexpected ${url}`);
  });
});
afterEach(cleanup);

const draw = async (first = 'ORD-W1') => {
  render(<ConfirmationMineScreen />);
  await screen.findByText(first);
};
const openTab = (label: string) => fireEvent.click(screen.getByRole('tab', { name: new RegExp(`^${label}`) }));

/** Rows draws a table and the cards both; the desk's table is the one with a header row. */
const table = () => document.querySelector('table') as HTMLElement;

const confirmedRow = (over: Record<string, unknown>) =>
  desk({ confirmed: { day: '2026-10-30', q: '', page: 1, pageSize: 25, total: 1, pages: 1, rows: [base('C1', { confirmationStatus: 'CONFIRMED', state: 'CONFIRMED', ...over })] } });

describe('the «أكّدتها» row', () => {
  it('on a READY trolley: no «طلب تعديل», and the reason in its place', async () => {
    mine = confirmedRow({ shippingBatchId: 'b1', shippingBatch: { status: 'READY' } });
    await draw();
    openTab('أكّدتها');
    const t = within(table());
    expect(t.queryByRole('button', { name: 'طلب تعديل' })).toBeNull();
    expect(t.getByTitle(ON_TROLLEY_AR)).toBeTruthy();
  });

  it('on a trolley it names but nobody can read: the same (fail closed)', async () => {
    mine = confirmedRow({ shippingBatchId: 'b1', shippingBatch: null });
    await draw();
    openTab('أكّدتها');
    expect(within(table()).queryByRole('button', { name: 'طلب تعديل' })).toBeNull();
  });

  it('NEGATIVE: after the handover, and off any trolley, «طلب تعديل» is offered as before', async () => {
    for (const over of [{ shippingBatchId: 'b1', shippingBatch: { status: 'SHIPPED' } }, { shippingBatchId: null, shippingBatch: null }]) {
      cleanup();
      mine = confirmedRow(over);
      await draw();
      openTab('أكّدتها');
      const t = within(table());
      expect(t.getByRole('button', { name: 'طلب تعديل' }), JSON.stringify(over)).toBeTruthy();
      expect(t.queryByTitle(ON_TROLLEY_AR)).toBeNull();
    }
  });
});
