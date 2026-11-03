// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «شاشة موظفة» SURVIVES A REFRESH, AND HAS ITS OWN «تحديث».
 *
 * The owner, 3/11: «زر تحديث لانو بس اعمل ريفريش بيوديني ع طلباتي». The desk being
 * read is kept in the address (`?agent=<id>`), so the browser's refresh opens it
 * again — only for an id the door listed — and «تحديث» beside the picker reads the
 * desk and the picker's counts again without leaving it.
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
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => <h1>طلباتي</h1> }));
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

const OWNER = { id: 'owner', name: 'أحمد', role: 'SUPER_ADMIN', permissions: [], status: 'ACTIVE' };
const AGENT = {
  id: 'abeer', name: 'عبير', role: 'CONFIRMATION_AGENT', status: 'ACTIVE',
  permissions: ['confirmation.work', 'confirmation.pull', 'confirmation.supervise', 'confirmation.raise_issue', 'orders.contact_log', 'orders.view', 'ai.assist'],
};

function serve(opts: { desks?: 'ok' | 'refused' } = {}) {
  apiJson.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (init?.method && init.method !== 'GET') throw new Error(`a write was sent: ${init.method} ${url}`);
    if (url === '/api/confirmation/desks') {
      if (opts.desks === 'refused') throw Object.assign(new Error('ممنوع'), { status: 403 });
      return { agents: [{ id: 'sara', name: 'سارة', holding: 2 }, { id: 'hind', name: 'هند', holding: 0 }] };
    }
    if (url.startsWith('/api/confirmation/mine') && url.includes('agent=sara')) {
      return desk([order('SARA-1'), order('SARA-2')], { viewing: { id: 'sara', name: 'سارة', readOnly: true } });
    }
    if (url.startsWith('/api/confirmation/mine')) return desk([order('MINE-1')]);
    throw new Error(`unexpected ${url}`);
  });
  apiFetch.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({}), clone() { return this; } }));
}

const pick = (value: string) => fireEvent.change(screen.getByLabelText('شاشة موظفة'), { target: { value } });

const mineCalls = () => apiJson.mock.calls.filter(([u]) => String(u).startsWith('/api/confirmation/mine')).map(([u]) => String(u));
const deskCalls = () => apiJson.mock.calls.filter(([u]) => u === '/api/confirmation/desks').length;

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, '', '/confirmation/mine');
});
afterEach(cleanup);

describe('the owner, 3/11: «زر تحديث لانو بس اعمل ريفريش بيوديني ع طلباتي»', () => {
  it('choosing Sara writes ?agent=sara into the address; going back to his own desk takes it out', async () => {
    user.current = OWNER;
    serve();
    render(<ConfirmationMineScreen />);
    await screen.findByText('MINE-1');
    await screen.findByLabelText('شاشة موظفة');
    pick('sara');
    await screen.findByText('SARA-1');
    expect(new URLSearchParams(window.location.search).get('agent')).toBe('sara');
    pick('');
    await screen.findByText('MINE-1');
    expect(new URLSearchParams(window.location.search).get('agent')).toBeNull();
  });

  it('a page opened with ?agent=sara (the refresh) opens on Sara’s desk, read-only', async () => {
    window.history.replaceState(null, '', '/confirmation/mine?agent=sara');
    user.current = OWNER;
    serve();
    render(<ConfirmationMineScreen />);
    await screen.findByText('SARA-1');
    expect(screen.getByText(/عم تشوف شاشة سارة — قراءة بس/)).toBeTruthy();
    expect((screen.getByLabelText('شاشة موظفة') as HTMLSelectElement).value).toBe('sara');
  });

  it('NEGATIVE: an id the door did not list in the address opens nobody’s desk but his own', async () => {
    window.history.replaceState(null, '', '/confirmation/mine?agent=someone-else');
    user.current = OWNER;
    serve();
    render(<ConfirmationMineScreen />);
    await screen.findByText('MINE-1');
    await screen.findByLabelText('شاشة موظفة');
    expect(mineCalls().some((u) => u.includes('agent='))).toBe(false);
  });

  it('«تحديث» reads the desk on screen and the picker’s counts again — and stays on Sara’s desk', async () => {
    user.current = OWNER;
    serve();
    render(<ConfirmationMineScreen />);
    await screen.findByLabelText('شاشة موظفة');
    pick('sara');
    await screen.findByText('SARA-1');
    const before = { mine: mineCalls().length, desks: deskCalls() };
    fireEvent.click(screen.getByRole('button', { name: /تحديث/ }));
    await waitFor(() => expect(mineCalls().length).toBe(before.mine + 1));
    expect(mineCalls().at(-1)).toContain('agent=sara');
    expect(deskCalls()).toBe(before.desks + 1);
    expect(screen.getByText(/عم تشوف شاشة سارة — قراءة بس/)).toBeTruthy();
  });

  it('NEGATIVE: an agent with no picker has no «تحديث» here either', async () => {
    user.current = AGENT;
    serve({ desks: 'refused' });
    render(<ConfirmationMineScreen />);
    await screen.findByText('MINE-1');
    expect(screen.queryByRole('button', { name: /^تحديث$/ })).toBeNull();
  });
});
