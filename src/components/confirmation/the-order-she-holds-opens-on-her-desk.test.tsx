// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE ORDER SHE HOLDS OPENS ON HER OWN DESK — FROM EVERY PLACE THAT NAMES IT.
 *
 * With «عرض الطلبات» unticked an agent cannot open «الطلبات», and three
 * places sent her there or nowhere: the pull panel's «افتح الطلب … وسجّل
 * محاولة» pointed at `/orders/<id>`, and an order number on her postponed tab
 * or in a customer's history was plain text. Each now lands on «طلباتي» with
 * the order in its window (`?open=`), and nothing else becomes a link:
 *
 *   · the desk opens `?open=<id>` once, and only an id-shaped value;
 *   · `OrderLink` keeps `/orders/<id>` for whoever may open the list, opens
 *     her desk only where the screen vouches the order is hers, and is text
 *     otherwise;
 *   · her postponed list (no «whose hands» facet — the server scoped it to her)
 *     links her numbers there; a supervisor's list does not;
 *   · in a customer's history only the order she holds opens, not a
 *     colleague's;
 *   · and «سحبه منه» — giving it back — is drawn for the holder on its own key,
 *     not on the transfer door, which still asks «عرض الطلبات».
 * ═══════════════════════════════════════════════════════════════════════
 */

const { api, params, user, may } = vi.hoisted(() => ({
  api: vi.fn(),
  params: { current: new URLSearchParams() },
  user: {
    current: {
      id: 'u1', name: 'سارة', role: 'CONFIRMATION_AGENT', status: 'ACTIVE',
      permissions: ['confirmation.work', 'confirmation.pull', 'orders.release'],
    } as Record<string, unknown>,
  },
  may: { orders: false },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/confirmation/mine',
  useSearchParams: () => params.current,
}));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ currentUser: user.current, t: {}, locale: 'ar' }),
}));
// «may she open the orders screen» is the one question here; every other route answers yes.
vi.mock('@/hooks/useMayOpen', () => ({
  useMayOpen: () => (target: string) => (String(target).startsWith('/orders') ? may.orders : true),
}));
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
vi.mock('@/components/screens/confirmation/ActionDialogs', () => ({
  ChangeRequestDialog: () => null,
  IssueDialog: () => null,
  PostponeDialog: () => null,
  RejectDialog: () => null,
}));
vi.mock('@/components/screens/confirmation/AssistantDialog', () => ({ AssistantDialog: () => null }));

import { ConfirmationMineScreen } from '@/components/screens/ConfirmationMineScreen';
import { ConfirmationPostponedScreen } from '@/components/screens/ConfirmationPostponedScreen';
import { CustomerHistoryModal } from '@/components/orders/CustomerHistory';
import { OrderLink } from '@/components/orders/OrderLink';
import { OrderResponsibility } from '@/components/orders/OrderResponsibility';

const EMPTY_DESK = {
  leadDays: 2, waitingLater: 0, noAnswerLimit: 3, serverNow: '2026-10-28T08:00:00.000Z',
  work: [], noAnswer: [], closedToday: [],
  confirmed: { day: '', q: '', page: 1, pageSize: 25, total: 0, pages: 1, rows: [] },
};
const POOL = {
  waiting: 2, owned: { total: 1, withoutAttempt: 1 }, caps: { withoutAttempt: 40, total: 120 }, leadDays: 2,
  canPull: false, autoReleased: 0, orders: null,
  refusal: { code: 'UNTOUCHED_ORDER', message: 'سجّل محاولة اتصال على الطلب JO-7 قبل سحب طلب جديد.', orderId: 'o-7', orderNumber: 'JO-7' },
};

const postponedRow = (id: string, claimer = { id: 'u1', name: 'سارة' }) => ({
  id, orderNumber: `JO-${id}`, totalAmount: 10, currency: 'JOD', dueAt: '2026-10-29T10:00:00.000Z',
  daysRemaining: 1, postponePreferredTime: null, postponeCount: 1, followUpReason: null, actionable: false,
  customer: { fullName: 'سعاد', phone: '0790000000', city: 'عمّان' }, claimer,
});
const facts = (agents: { id: string; name: string; count: number }[] | null) => ({
  total: 1,
  whens: { now: 0, overdue: 0, soon: 1, week: 0, later: 0 },
  kinds: { postponed: 1, followup: 0 },
  times: { once: 1, many: 0 },
  agents,
});

const AGENT_KEYS = ['confirmation.work', 'confirmation.pull', 'orders.release'];

beforeEach(() => {
  vi.clearAllMocks();
  params.current = new URLSearchParams();
  may.orders = false;
  user.current = { id: 'u1', name: 'سارة', role: 'CONFIRMATION_AGENT', status: 'ACTIVE', permissions: AGENT_KEYS };
  api.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/confirmation/mine')) return EMPTY_DESK;
    if (url === '/api/confirmation/queue') return POOL;
    throw new Error(`unexpected ${url}`);
  });
});
afterEach(cleanup);

describe('«طلباتي» opens `?open=<id>` in its own order window', () => {
  it('the order the address names, once the desk is drawn', async () => {
    params.current = new URLSearchParams('open=11111111-1111-4111-8111-111111111111');
    render(<ConfirmationMineScreen />);
    const window = await screen.findByTestId('order-window');
    expect(window.getAttribute('data-order')).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('and the pull panel above it points there, not at «الطلبات»', async () => {
    render(<ConfirmationMineScreen />);
    const link = await screen.findByRole('link', { name: /افتح الطلب JO-7/ });
    expect(link.getAttribute('href')).toBe('/confirmation/mine?open=o-7');
  });

  it('NEGATIVE: no `?open=`, no window', async () => {
    render(<ConfirmationMineScreen />);
    await screen.findByRole('tab', { name: /للشغل/ });
    expect(screen.queryByTestId('order-window')).toBeNull();
  });

  it('NEGATIVE: a value that is not an id is not put into a request path', async () => {
    params.current = new URLSearchParams('open=../../api/users');
    render(<ConfirmationMineScreen />);
    await screen.findByRole('tab', { name: /للشغل/ });
    expect(screen.queryByTestId('order-window')).toBeNull();
  });
});

describe('an order number — `OrderLink`', () => {
  it('opens «الطلبات» for whoever may open it, as before', () => {
    may.orders = true;
    render(<OrderLink id="o1" number="JO-1" opensOnHerDesk />);
    expect(screen.getByRole('link', { name: 'JO-1' }).getAttribute('href')).toBe('/orders/o1');
  });

  it('opens her desk where the screen vouches the order is hers', () => {
    render(<OrderLink id="o1" number="JO-1" opensOnHerDesk />);
    expect(screen.getByRole('link', { name: 'JO-1' }).getAttribute('href')).toBe('/confirmation/mine?open=o1');
  });

  it('NEGATIVE: and is the number as text for anything else', () => {
    render(<OrderLink id="o1" number="JO-1" />);
    expect(screen.getByText('JO-1')).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });
});

describe('her postponed list', () => {
  const list = (agents: { id: string; name: string; count: number }[] | null) =>
    api.mockImplementation(async () => ({
      orders: [postponedRow('P1')],
      pagination: { total: 1, page: 1, limit: 25, totalPages: 1 },
      leadDays: 2,
      facts: facts(agents),
    }));

  // `Rows` draws the desk's table and the phone's card from one definition, so a row is there twice.
  it('— an agent’s own (no «whose hands» facet) — opens each number on her desk', async () => {
    list(null);
    render(<ConfirmationPostponedScreen embedded />);
    const links = await screen.findAllByRole('link', { name: 'JO-P1' });
    for (const link of links) expect(link.getAttribute('href')).toBe('/confirmation/mine?open=P1');
  });

  it('NEGATIVE: a supervisor’s list is anybody’s, so without «الطلبات» its numbers stay text', async () => {
    list([{ id: 'u1', name: 'سارة', count: 1 }]);
    render(<ConfirmationPostponedScreen embedded />);
    expect((await screen.findAllByText('JO-P1')).length).toBeGreaterThan(0);
    expect(screen.queryAllByRole('link', { name: 'JO-P1' })).toEqual([]);
  });
});

describe('a customer’s history', () => {
  beforeEach(() => {
    api.mockImplementation(async () => ({
      customer: { fullName: 'سعاد', rawPhone: '0790000000', totalOrders: 3, deliveredOrders: 1, cancelledOrders: 0 },
      risk: { tier: 'SAFE', returnRate: 0, orders: 3, returns: 0, requiresPrepaymentOrApproval: false },
      orders: [
        { id: 'o-hers', orderNumber: 'JO-HERS', claimedById: 'u1', createdAt: '2026-10-27T10:00:00.000Z', state: 'CLAIMED',
          totalAmount: 25, currency: 'JOD', rejectionReason: null, returnReason: null, store: null, items: [] },
        { id: 'o-theirs', orderNumber: 'JO-THEIRS', claimedById: 'u2', createdAt: '2026-10-26T10:00:00.000Z', state: 'CLAIMED',
          totalAmount: 25, currency: 'JOD', rejectionReason: null, returnReason: null, store: null, items: [] },
      ],
    }));
  });

  it('opens the order she holds on her desk — and a colleague’s stays text', async () => {
    render(<CustomerHistoryModal customerId="cu1" holderId="u1" onClose={() => {}} />);
    const hers = await screen.findByRole('link', { name: 'JO-HERS' });
    expect(hers.getAttribute('href')).toBe('/confirmation/mine?open=o-hers');
    expect(screen.getByText('JO-THEIRS')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'JO-THEIRS' }), 'رابط لطلب زميلتها').toBeNull();
  });

  it('NEGATIVE: and without her id (no «العمل على طلباتي») nothing becomes a link', async () => {
    render(<CustomerHistoryModal customerId="cu1" onClose={() => {}} />);
    await screen.findByText('JO-HERS');
    expect(screen.queryByRole('link')).toBeNull();
  });
});

describe('giving it back — «سحبه منه» in the order window', () => {
  const held = (claimerId: string) => ({
    id: 'o1', claimedById: claimerId, claimedAt: '2026-10-28T07:00:00.000Z',
    claimer: { id: claimerId, name: claimerId === 'u1' ? 'سارة' : 'ريم' }, owner: null,
  });

  beforeEach(() => {
    // The transfer door still asks «عرض الطلبات» — it refuses her.
    api.mockRejectedValue(new Error('الطلب غير موجود'));
  });

  it('is drawn for the holder on its own key, though the transfer door refused her', async () => {
    render(<OrderResponsibility order={held('u1')} currentUserId="u1" onChanged={() => {}} />);
    await waitFor(() => expect(api).toHaveBeenCalled());
    expect(await screen.findByRole('button', { name: /سحبه منه/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /تحويل لزميل/ }), 'زرّ تحويل مرسوم وبابه رافض').toBeNull();
  });

  it('NEGATIVE: not for an order a colleague holds', async () => {
    render(<OrderResponsibility order={held('u2')} currentUserId="u1" onChanged={() => {}} />);
    await waitFor(() => expect(api).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /سحبه منه/ })).toBeNull();
  });

  it('NEGATIVE: and not without `orders.release`', async () => {
    user.current = { ...user.current, permissions: ['confirmation.work'] };
    render(<OrderResponsibility order={held('u1')} currentUserId="u1" onChanged={() => {}} />);
    await waitFor(() => expect(api).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /سحبه منه/ })).toBeNull();
  });
});
