// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «+ إنشاء طلب» ON «طلباتي» (T-06 — the owner, 2/11: «بنات التأكيد و المشرفة يظهرلهم انشاء طلب وتحت في خيار انو طلب مؤكد»).
 *
 * Her desk is where she works, so the new-order form — with its «الزبون على الخط — أكّده الآن» box — opens from there, for whoever
 * holds «إنشاء طلبات». Not on a colleague's desk she is only reading, and not for somebody without the key (the door refuses
 * her anyway). After an order is made the desk reloads: an order she typed with the box is hers and belongs on it.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { apiJson, apiFetch, user } = vi.hoisted(() => ({
  apiJson: vi.fn(),
  apiFetch: vi.fn(),
  user: { current: null as unknown },
}));

vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a), apiFetch: (...a: unknown[]) => apiFetch(...a) }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/' }));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ locale: 'ar', t: {}, currentUser: user.current }) }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => false }));
vi.mock('@/hooks/useRegions', () => ({
  useRegions: () => ({ regions: [{ id: 'r-dam', name: 'دمشق' }], countryName: 'سوريا', currency: null, loading: false }),
}));
// Reloads when its key changes, as the real hook does — that is how choosing a desk reaches the door.
vi.mock('@/hooks/useLiveRefresh', () => ({
  useLiveRefresh: (load: () => Promise<unknown>, opts?: { key?: string }) => {
    const latest = React.useRef(load);
    latest.current = load;
    React.useEffect(() => {
      void latest.current();
    }, [opts?.key]);
  },
}));
// The title draws what it is handed — the button lives in it.
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: ({ children }: { children?: React.ReactNode }) => <header><h1>طلباتي</h1>{children}</header> }));
// The form itself is tested on its own (`confirm-now-in-the-new-order-form.test.tsx`); here: is it opened, and what happens after.
vi.mock('@/components/orders/CreateOrderModal', () => ({
  CreateOrderModal: ({ isOpen, onSuccess }: { isOpen: boolean; onSuccess: () => void }) =>
    isOpen ? <div role="dialog" aria-label="نموذج الطلب"><button onClick={() => onSuccess()}>تم</button></div> : null,
}));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), done: vi.fn(), warn: vi.fn() }) }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/components/orders/OrderDetailModal', () => ({ OrderDetailModal: () => null }));
vi.mock('@/components/orders/CustomerHistory', () => ({ CustomerHistoryButton: () => null, CustomerHistoryOffer: () => null }));
vi.mock('@/components/orders/ContactButtons', () => ({ ContactButtons: () => <i data-testid="contact-strip" /> }));
vi.mock('@/components/screens/confirmation/AssistantDialog', () => ({ AssistantDialog: () => null }));
vi.mock('@/components/screens/ConfirmationPostponedScreen', () => ({ ConfirmationPostponedScreen: () => <i data-testid="postponed-list" /> }));
vi.mock('@/components/confirmation/PullPanel', () => ({ PullPanel: () => <i data-testid="pull-panel" />, useQueue: () => ({ reload: vi.fn() }) }));

import { ConfirmationMineScreen } from './ConfirmationMineScreen';

const order = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  orderNumber: id,
  merchantRef: null,
  confirmationStatus: 'IN_PROGRESS',
  state: 'NEW',
  previousOrders: 0,
  version: 4,
  totalAmount: 45,
  currency: 'JOD',
  claimedAt: null,
  firstActionAt: null,
  postponedUntil: null,
  postponePreferredTime: null,
  postponeCount: 0,
  noAnswerCount: 0,
  source: 'MANUAL',
  // A moderator's order, so «إدخال إشكال» would be drawn on her own desk.
  moderatorId: 'mod-1',
  moderator: { id: 'mod-1', name: 'مودريتور' },
  createdBy: null,
  channel: null,
  deliveryAddress: 'شارع الجلاء',
  // No governorate, so the save-the-governorate box would be drawn on her own desk.
  regionId: null,
  region: null,
  customerNotes: null,
  customer: { id: 'c1', fullName: 'زبون', phone: '0790000001', rawPhone: '0790000001', city: 'دمشق', address: 'عنوان' },
  items: [{ id: 'l1', productName: 'كريم', quantity: 1, freeQuantity: 0, lineTotal: 45 }],
  addOns: [],
  _count: { contactAttempts: 1, notes: 0 },
  ...over,
});

const desk = (rows: ReturnType<typeof order>[], extra: Record<string, unknown> = {}) => ({
  leadDays: 2,
  waitingLater: 0,
  noAnswerLimit: 3,
  serverNow: '2026-11-02T08:00:00.000Z',
  work: rows,
  noAnswer: [],
  closedToday: [],
  confirmed: { day: '2026-11-02', q: '', page: 1, pageSize: 25, total: 1, pages: 1, rows: [order(`${rows[0]?.id ?? 'X'}-DONE`, { confirmationStatus: 'CONFIRMED', changeRequests: [] })] },
  ...extra,
});


const AGENT = {
  id: 'abeer', name: 'عبير', role: 'CONFIRMATION_AGENT', status: 'ACTIVE',
  permissions: ['confirmation.work', 'confirmation.pull', 'confirmation.supervise', 'orders.contact_log', 'orders.confirm', 'orders.view', 'orders.create', 'products.view'],
};
const NO_CREATE = { ...AGENT, id: 'hind', permissions: AGENT.permissions.filter((k) => k !== 'orders.create') };

let viewing: Record<string, unknown> | undefined;
function serve() {
  apiJson.mockImplementation(async (url: string) => {
    if (url === '/api/confirmation/desks') throw Object.assign(new Error('ممنوع'), { status: 403 });
    if (url.startsWith('/api/confirmation/mine')) return desk([order('MINE-1')], viewing ? { viewing } : {});
    throw new Error(`unexpected ${url}`);
  });
  apiFetch.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({}), clone() { return this; } }));
}
const deskLoads = () => apiJson.mock.calls.filter(([u]) => String(u).startsWith('/api/confirmation/mine')).length;

beforeEach(() => {
  vi.clearAllMocks();
  viewing = undefined;
});
afterEach(cleanup);

describe('«إنشاء طلب» on her desk', () => {
  it('drawn for «إنشاء طلبات», and opens the new-order form', async () => {
    user.current = AGENT;
    serve();
    render(<ConfirmationMineScreen />);
    await screen.findByText('MINE-1');
    expect(screen.queryByRole('dialog', { name: 'نموذج الطلب' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /إنشاء طلب/ }));
    expect(screen.getByRole('dialog', { name: 'نموذج الطلب' })).toBeTruthy();
  });

  it('an order made from it reloads the desk — the order she typed with the box is hers', async () => {
    user.current = AGENT;
    serve();
    render(<ConfirmationMineScreen />);
    await screen.findByText('MINE-1');
    const before = deskLoads();
    fireEvent.click(screen.getByRole('button', { name: /إنشاء طلب/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'تم' }));
    });
    await waitFor(() => expect(deskLoads()).toBe(before + 1));
  });

  it('NEGATIVE: not drawn without «إنشاء طلبات»', async () => {
    user.current = NO_CREATE;
    serve();
    render(<ConfirmationMineScreen />);
    await screen.findByText('MINE-1');
    expect(screen.queryByRole('button', { name: /إنشاء طلب/ })).toBeNull();
  });

  it('NEGATIVE: not drawn on a desk she is only reading', async () => {
    user.current = AGENT;
    viewing = { id: 'sara', name: 'سارة', readOnly: true };
    serve();
    render(<ConfirmationMineScreen />);
    await screen.findByText('MINE-1');
    expect(screen.queryByRole('button', { name: /إنشاء طلب/ })).toBeNull();
  });
});
