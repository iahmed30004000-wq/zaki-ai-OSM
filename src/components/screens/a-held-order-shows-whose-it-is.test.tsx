// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — the marks a returning customer's order carries
 *
 * «اريد الطلب يكون ظاهر بخانة الطلبات تابع للموظف اللي كان متابع معه — باقي الموظفين يشوفوه ومايقدرو يسحبوه».
 *
 *  1. «الطلبات»: the row says «تابع لـ(س)» when the server sends `reservedFor`, and says nothing otherwise.
 *  2. The pull panel says how many orders are held for colleagues — apart from the number she may take — and says nothing when
 *     there are none.
 *  3. The supervisor's queue has a column «تابع لـ» with the name, or «—» when the order is everybody's.
 *  4. The order sheet says whose it is, and when it opens to everybody, while it is held; an unheld order says «متاح في الطابور».
 *
 * Blockers: nothing here computes anything — every mark is read from the server's `reservedFor`.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { apiJson, apiFetch, user } = vi.hoisted(() => ({
  apiJson: vi.fn(),
  apiFetch: vi.fn(),
  user: { current: null as unknown },
}));

vi.mock('@/lib/api-client', () => ({
  apiJson: (...a: unknown[]) => apiJson(...a),
  apiFetch: (...a: unknown[]) => apiFetch(...a),
}));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/',
}));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({
    locale: 'ar',
    t: { orders: 'الطلبات', export: 'تصدير CSV', quickCreateOrder: 'إدخال طلب سريع', customers: 'العملاء' },
    currentUser: user.current,
  }),
}));
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
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => <h1>الطابور</h1> }));
vi.mock('@/components/ui/Confirm', () => ({ useConfirm: () => vi.fn(async () => true), useAsk: () => vi.fn(async () => null), useTell: () => vi.fn() }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), done: vi.fn(), warn: vi.fn(), success: vi.fn() }) }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/hooks/useRegions', () => ({ useRegions: () => ({ regions: [], countryName: '', currency: null }) }));
vi.mock('@/hooks/useProducts', () => ({ useProducts: () => ({ products: [] }) }));
vi.mock('@/hooks/useCreateIntent', () => ({ useCreateIntent: () => undefined }));
vi.mock('@/components/labels/LabelSize', () => ({ useLabelSize: () => 'thermal', LabelSizePicker: () => null }));
vi.mock('@/components/labels/openWaybills', () => ({ openWaybills: vi.fn(), describeRefused: () => '', BLOCKED_WAYBILLS: 'x', WaybillError: class extends Error {} }));
vi.mock('@/components/orders/CreateOrderModal', () => ({ CreateOrderModal: () => null }));
vi.mock('@/components/orders/AiOrderModal', () => ({ AiOrderModal: () => null }));
vi.mock('@/components/orders/OrderDetailModal', () => ({ OrderDetailModal: () => null }));
vi.mock('@/components/orders/ImportOrdersDialog', () => ({ ImportOrdersDialog: () => null }));
vi.mock('@/components/orders/MigrateOrdersDialog', () => ({ MigrateOrdersDialog: () => null }));
vi.mock('@/components/scan/ScanButton', () => ({ ScanButton: () => null }));
vi.mock('@/components/ui/ProductPicker', () => ({ ProductPicker: () => <i /> }));
vi.mock('@/components/ui/SavedViews', () => ({ SavedViews: () => <i /> }));
vi.mock('@/components/orders/CustomerHistory', () => ({ CustomerHistoryButton: () => null }));
vi.mock('@/components/orders/ContactButtons', () => ({ ContactButtons: () => <i /> }));
vi.mock('@/components/orders/OrderLink', () => ({ OrderLink: ({ number }: { number: string }) => <span>{number}</span> }));
vi.mock('@/components/screens/confirmation/ActionDialogs', () => ({ ChangeRequestDialog: () => null, IssueDialog: () => null, PostponeDialog: () => null, RejectDialog: () => null }));
vi.mock('@/components/screens/confirmation/AssistantDialog', () => ({ AssistantDialog: () => null }));
vi.mock('@/components/screens/ConfirmationPostponedScreen', () => ({ ConfirmationPostponedScreen: () => <div /> }));
vi.mock('@/components/growth/AskAi', () => ({ AskAi: () => null }));

import { OrdersScreen } from './OrdersScreen';
import { ConfirmationQueueScreen } from './ConfirmationQueueScreen';
import { PullPanel, useQueue, type QueueResponse } from '@/components/confirmation/PullPanel';
import { OrderResponsibility } from '@/components/orders/OrderResponsibility';

beforeEach(() => {
  vi.clearAllMocks();
  user.current = { id: 'u1', name: 'هدى', role: 'SUPER_ADMIN', permissions: ['orders.view', 'orders.create'], status: 'ACTIVE' };
});
afterEach(cleanup);

/* ═══════════════════════ «الطلبات» ═══════════════════════ */

describe('the orders list', () => {
  const ORDER = {
    id: 'o1', orderNumber: 'ORD-26-7001', state: 'NEW',
    customer: { id: 'c1', fullName: 'نور', rawPhone: '0791234567', phone: '0791234567', city: 'عمّان' },
    region: { name: 'إربد' }, productNameSnapshot: 'منتج', quantity: 1, source: 'Sheet import', moderator: { name: 'سارة' },
    createdAt: '2026-10-20T09:00:00.000Z', totalAmount: 40, confirmationStatus: 'NEW',
  };
  const serve = (order: Record<string, unknown>) =>
    apiFetch.mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () =>
        String(url).startsWith('/api/orders?')
          ? { orders: [order], pagination: { page: 1, limit: 25, total: 1, totalPages: 1 }, currency: { code: 'JOD', minorUnit: 3 }, dialCode: '962' }
          : { orders: [], providers: [], sources: [], pagination: { page: 1, pages: 1, total: 0 } },
    }));

  it('says «تابع لـ(س)» on the order held for the agent who worked the customer, with why in its title', async () => {
    serve({ ...ORDER, reservedFor: { id: 'sara', name: 'سارة' } });
    render(<OrdersScreen />);
    await screen.findByLabelText('تحديد الطلب ORD-26-7001');
    const mark = screen.getByText('تابع لـسارة');
    expect(mark.getAttribute('title')).toContain('الموظفة اللي تعاملت معه قبل');
    expect(mark.getAttribute('title')).toContain('24 ساعة');
  });

  it('NEGATIVE: says nothing on an order nobody holds for', async () => {
    serve({ ...ORDER, reservedFor: null });
    render(<OrdersScreen />);
    await screen.findByLabelText('تحديد الطلب ORD-26-7001');
    expect(screen.queryByText(/تابع لـ/)).toBeNull();
  });

  it('NEGATIVE: says nothing on a row from an older answer that has no `reservedFor` at all', async () => {
    serve({ ...ORDER });
    render(<OrdersScreen />);
    await screen.findByLabelText('تحديد الطلب ORD-26-7001');
    expect(screen.queryByText(/تابع لـ/)).toBeNull();
  });
});

/* ═══════════════════════ the pull panel ═══════════════════════ */

describe('the pull panel', () => {
  const POOL: QueueResponse = {
    waiting: 2, owned: { total: 0, withoutAttempt: 0 }, caps: { withoutAttempt: 40, total: 300 }, leadDays: 2,
    canPull: true, refusal: null, autoReleased: 0, orders: null,
  };
  function Harness() {
    const queue = useQueue(true);
    return <PullPanel queue={queue} onPulled={() => {}} compact />;
  }

  it('says how many are held for colleagues — apart from the number she may take', async () => {
    apiJson.mockResolvedValue({ ...POOL, reservedForColleagues: 3 });
    render(<Harness />);
    await screen.findByText('2');
    expect(screen.getByText(/و3 تابعة لزميلاتك/)).toBeTruthy();
    expect(screen.getByText(/ما بتسحبها/)).toBeTruthy();
  });

  it('NEGATIVE: says nothing when none are held, or when the server did not say', async () => {
    apiJson.mockResolvedValue({ ...POOL, reservedForColleagues: 0 });
    render(<Harness />);
    await screen.findByText('2');
    expect(screen.queryByText(/تابعة لزميلاتك/)).toBeNull();
  });
});

/* ═══════════════════════ the supervisor's queue ═══════════════════════ */

describe('the supervisor’s queue', () => {
  const row = (id: string, reservedFor: { id: string; name: string } | null) => ({
    id, orderNumber: id.toUpperCase(), createdAt: '2026-10-31T09:00:00.000Z', confirmationStatus: 'NEW', postponedUntil: null,
    postponeCount: 0, totalAmount: 20, customer: { fullName: 'زبون', city: 'دمشق' }, product: { name: 'منتج' }, reservedFor,
  });

  it('has a column «تابع لـ» — the agent’s name, or «—» when the order is everybody’s', async () => {
    apiJson.mockResolvedValue({
      waiting: 2, owned: { total: 0, withoutAttempt: 0 }, caps: { withoutAttempt: 40, total: 300 }, leadDays: 2, canPull: false,
      refusal: { code: 'NOT_YOUR_DESK', message: 'السحب من عمل موظّف التأكيد — هذه الشاشة للإشراف على الطابور لا للعمل عليه.' },
      autoReleased: 0, reservedForColleagues: 0,
      orders: [row('o1', { id: 'sara', name: 'سارة' }), row('o2', null)],
    });
    render(<ConfirmationQueueScreen />);
    await screen.findAllByText('سارة');
    expect(screen.getAllByText('تابع لـ').length).toBeGreaterThan(0);
    expect(screen.getAllByText('سارة').length).toBeGreaterThan(0);
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });
});

/* ═══════════════════════ the order sheet ═══════════════════════ */

describe('the responsibility box on the order sheet', () => {
  const base = { id: 'o1', claimedById: null, claimedAt: null, claimer: null, owner: null };

  beforeEach(() => {
    apiJson.mockResolvedValue({ mayTransfer: false, candidates: [] });
    user.current = { id: 'u1', name: 'هدى', role: 'CONFIRMATION_AGENT', permissions: [], status: 'ACTIVE' };
  });

  it('says whose it is and when it opens to everybody, while it is held', async () => {
    render(<OrderResponsibility order={{ ...base, reservedFor: { id: 'sara', name: 'سارة', hoursLeft: 5 } }} currentUserId="u1" onChanged={() => {}} />);
    expect(await screen.findByText('تابع لـسارة')).toBeTruthy();
    expect(screen.getByText(/هي اللي تسحبه/)).toBeTruthy();
    expect(screen.getByText(/بعد 5 ساعة/)).toBeTruthy();
    expect(screen.queryByText('متاح في الطابور')).toBeNull();
  });

  it('NEGATIVE: an order nobody is holding for still says «متاح في الطابور»', async () => {
    render(<OrderResponsibility order={{ ...base }} currentUserId="u1" onChanged={() => {}} />);
    expect(await screen.findByText('متاح في الطابور')).toBeTruthy();
    expect(screen.queryByText(/تابع لـ/)).toBeNull();
  });
});
