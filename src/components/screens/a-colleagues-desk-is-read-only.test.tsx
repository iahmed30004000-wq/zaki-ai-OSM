// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «شاشة موظفة» ON «طلباتي» — HER DESK, DRAWN WHOLE, AND NOT ONE BUTTON OF HERS.
 *
 * The owner, 2/11: «اشوف انا ك مالك شاشات البنات». A picker for whoever the door
 * lets watch (`/api/confirmation/desks`), and the chosen agent's desk drawn
 * READ-ONLY: a banner «عم تشوف شاشة <name> — قراءة بس», her orders and counts —
 * and no pull, no call strip, no call results, no confirm, no postpone, no cancel,
 * no «افتح وعدّل», no governorate save, no change request, no postponed tab.
 * The server refuses those anyway (no write door reads `agent`); this is the
 * screen not offering them.
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
// The number's copy button carries its own status line; these tests read the banner's. OrderRef itself is real: the
// confirmed list's «no opening number» check below must be able to fail.
vi.mock('@/components/orders/CopyValue', () => ({ CopyValue: () => null }));
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

const btn = (name: RegExp | string) => screen.queryByRole('button', { name });
/** Every press of HER desk, by its words. */
const HER_BUTTONS = [/تأكيد الطلب/, /^تأجيل/, /^ألغِ$/, /^لا يرد/, /مغلق أو خارج التغطية/, /افتح وعدّل/, /إدخال إشكال/, /مساعدة/, /احفظ المحافظة/];

const pick = (value: string) => fireEvent.change(screen.getByLabelText('شاشة موظفة'), { target: { value } });

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('the owner opens Sara’s desk', () => {
  it('a real select «شاشة موظفة» lists the agents the door named, and starts on his own desk', async () => {
    user.current = OWNER;
    serve();
    render(<ConfirmationMineScreen />);
    await screen.findByText('MINE-1');
    const select = (await screen.findByLabelText('شاشة موظفة')) as HTMLSelectElement;
    expect(select.tagName).toBe('SELECT');
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['شاشتي أنا', 'سارة (2)', 'هند (0)']);
    expect(select.value).toBe('');
  });

  it('choosing her asks the desk door for HER, and draws her orders under the banner «عم تشوف شاشة سارة — قراءة بس»', async () => {
    user.current = OWNER;
    serve();
    render(<ConfirmationMineScreen />);
    await screen.findByText('MINE-1');
    await screen.findByLabelText('شاشة موظفة');
    pick('sara');
    await screen.findByText('SARA-1');
    expect(screen.getByText('SARA-2')).toBeTruthy();
    expect(screen.queryByText('MINE-1')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('عم تشوف شاشة سارة — قراءة بس');
    expect(apiJson.mock.calls.some(([u]) => String(u).startsWith('/api/confirmation/mine') && String(u).includes('agent=sara'))).toBe(true);
  });

  it('and draws NONE of her presses: no pull, no call strip, no result, no confirm, no postpone, no cancel, no edit, no issue, no helper, no governorate save', async () => {
    user.current = OWNER;
    serve();
    render(<ConfirmationMineScreen />);
    await screen.findByText('MINE-1');
    // On his own desk they are all there — so their absence below is the read-only mode, not a fixture that lacks them.
    expect(screen.getByTestId('pull-panel')).toBeTruthy();
    expect(screen.getAllByTestId('contact-strip').length).toBe(1);
    for (const name of HER_BUTTONS) expect(btn(name), String(name)).not.toBeNull();

    await screen.findByLabelText('شاشة موظفة');
    pick('sara');
    await screen.findByText('SARA-1');
    expect(screen.queryByTestId('pull-panel')).toBeNull();
    expect(screen.queryByTestId('contact-strip')).toBeNull();
    for (const name of HER_BUTTONS) expect(btn(name), String(name)).toBeNull();
    expect(screen.queryByLabelText(/المحافظة — لازم قبل التأكيد/)).toBeNull();
    expect(screen.getAllByText('للقراءة فقط — هذا الطلب بيد سارة.')).toHaveLength(2);
  });

  it('her postponed tab is not drawn (it would be HIS list under her name), and «أكّدتها» has no change request and no opening number', async () => {
    user.current = OWNER;
    serve();
    render(<ConfirmationMineScreen />);
    await screen.findByText('MINE-1');
    expect(screen.getByRole('tab', { name: /المؤجلة/ })).toBeTruthy();
    await screen.findByLabelText('شاشة موظفة');
    pick('sara');
    await screen.findByText('SARA-1');
    expect(screen.queryByRole('tab', { name: /المؤجلة/ })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: /أكّدتها/ }));
    await screen.findAllByText('SARA-1-DONE');
    expect(btn('طلب تعديل')).toBeNull();
    expect(btn('SARA-1-DONE')).toBeNull();
  });

  it('nothing on her desk sends a write — every request the screen made is a read', async () => {
    user.current = OWNER;
    serve();
    render(<ConfirmationMineScreen />);
    await screen.findByText('MINE-1');
    await screen.findByLabelText('شاشة موظفة');
    pick('sara');
    await screen.findByText('SARA-1');
    for (const [, init] of apiJson.mock.calls) expect((init as { method?: string } | undefined)?.method ?? 'GET').toBe('GET');
    expect(apiFetch.mock.calls.filter(([, init]) => (init as { method?: string } | undefined)?.method)).toEqual([]);
  });

  it('«شاشتي أنا» brings back his own desk and every button on it', async () => {
    user.current = OWNER;
    serve();
    render(<ConfirmationMineScreen />);
    await screen.findByText('MINE-1');
    await screen.findByLabelText('شاشة موظفة');
    pick('sara');
    await screen.findByText('SARA-1');
    pick('');
    await screen.findByText('MINE-1');
    expect(screen.queryByRole('status')).toBeNull();
    expect(btn(/تأكيد الطلب/)).not.toBeNull();
    expect(screen.getByTestId('pull-panel')).toBeTruthy();
  });
});

describe('NEGATIVE: who gets no picker', () => {
  it('an agent (no «متابعة أداء الفريق») — the door is not even asked, and her desk is hers with every button', async () => {
    user.current = AGENT;
    serve();
    render(<ConfirmationMineScreen />);
    await screen.findByText('MINE-1');
    expect(screen.queryByLabelText('شاشة موظفة')).toBeNull();
    expect(apiJson.mock.calls.some(([u]) => u === '/api/confirmation/desks')).toBe(false);
    expect(screen.queryByRole('status')).toBeNull();
    expect(btn(/تأكيد الطلب/)).not.toBeNull();
  });

  it('a watcher the door refuses (he does not see every order) — no picker, and his own desk as before', async () => {
    user.current = { ...AGENT, id: 'lead', permissions: [...AGENT.permissions, 'team.monitor'] };
    serve({ desks: 'refused' });
    render(<ConfirmationMineScreen />);
    await screen.findByText('MINE-1');
    await waitFor(() => expect(apiJson.mock.calls.some(([u]) => u === '/api/confirmation/desks')).toBe(true));
    expect(screen.queryByLabelText('شاشة موظفة')).toBeNull();
    expect(btn(/تأكيد الطلب/)).not.toBeNull();
  });
});
