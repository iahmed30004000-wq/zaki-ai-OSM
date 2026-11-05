// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE REFUSAL'S LINK TAKES HER DOWN TO THE CARD, NOT INTO THE ORDER.
 *
 * The owner, 5/11: «بدي لما يضغطوها ينزلهم لتحت ع الطلب الي للشغل ما يدخلهم ع
 * الطلب». On «طلباتي» the pull panel's «افتح الطلب … وسجّل محاولة» now scrolls
 * to the order's card — on the tab that holds it — and rings it; it no longer
 * reloads the page into the order window. An order on no card of hers still
 * opens in its window, and the link's address is unchanged for every other
 * page (the-order-she-holds-opens-on-her-desk.test.tsx).
 * ═══════════════════════════════════════════════════════════════════════
 */

const { api, scrolled } = vi.hoisted(() => ({ api: vi.fn(), scrolled: [] as string[] }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/confirmation/mine',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));
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

const order = (id: string, over: Record<string, unknown> = {}) => ({
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

const deskWith = (work: unknown[], noAnswer: unknown[] = []) => ({
  leadDays: 2, waitingLater: 0, noAnswerLimit: 3, serverNow: '2026-11-05T08:00:00.000Z',
  work, noAnswer, closedToday: [],
  confirmed: { day: '', q: '', page: 1, pageSize: 25, total: 0, pages: 1, rows: [] },
});
const pool = (orderId: string) => ({
  waiting: 2, owned: { total: 3, withoutAttempt: 1 }, caps: { withoutAttempt: 40, total: 300 }, leadDays: 2,
  canPull: false, autoReleased: 0, orders: null,
  refusal: { code: 'UNTOUCHED_ORDER', message: `سجّل محاولة اتصال على الطلب JO-${orderId} قبل سحب طلب جديد.`, orderId, orderNumber: `JO-${orderId}` },
});

function serve(desk: unknown, refusalFor: string) {
  api.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/confirmation/mine')) return desk;
    if (url === '/api/confirmation/queue') return pool(refusalFor);
    throw new Error(`unexpected ${url}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  scrolled.length = 0;
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this.id);
  };
});
afterEach(cleanup);

describe('«افتح الطلب … وسجّل محاولة» on «طلباتي»', () => {
  it('scrolls to the card on «للشغل» and rings it — no order window', async () => {
    serve(deskWith([order('a'), order('b'), order('c')]), 'c');
    render(<ConfirmationMineScreen />);
    const link = await screen.findByRole('link', { name: /افتح الطلب JO-c/ });
    // The address is unchanged: anywhere else the link is still an ordinary one.
    expect(link.getAttribute('href')).toBe('/confirmation/mine?open=c');
    fireEvent.click(link);
    await waitFor(() => expect(scrolled).toEqual(['desk-order-c']));
    expect(document.getElementById('desk-order-c')?.className).toContain('ring-2');
    expect(document.getElementById('desk-order-a')?.className).not.toContain('ring-2');
    expect(screen.queryByTestId('order-window')).toBeNull();
  });

  it('moves to «لا يرد» when the card is there', async () => {
    serve(deskWith([order('a')], [order('n', { noAnswerCount: 1 })]), 'n');
    render(<ConfirmationMineScreen />);
    fireEvent.click(await screen.findByRole('link', { name: /افتح الطلب JO-n/ }));
    await waitFor(() => expect(scrolled).toEqual(['desk-order-n']));
    expect(screen.queryByTestId('order-window')).toBeNull();
  });

  it('NEGATIVE: an order on no card of hers still opens in its window, and nothing scrolls', async () => {
    serve(deskWith([order('a')]), 'gone');
    render(<ConfirmationMineScreen />);
    fireEvent.click(await screen.findByRole('link', { name: /افتح الطلب JO-gone/ }));
    const win = await screen.findByTestId('order-window');
    expect(win.getAttribute('data-order')).toBe('gone');
    expect(scrolled).toEqual([]);
  });
});
