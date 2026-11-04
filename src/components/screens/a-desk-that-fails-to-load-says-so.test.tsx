// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «طلباتي» WHOSE FIRST LOAD FAILED — THE ERROR AND A BUTTON, NOT A SPINNER.
 *
 * The owner, 4/11: the confirmation agents «بيعلقوا» moving between screens,
 * above all after a deploy. One of the causes: the desk drew «جارٍ التحميل…»
 * until its first answer came, and when that answer was an error it drew it
 * for ever — the message sat in state where nothing showed it. Now the wait
 * ends in the screen or in the error with «جرّب مرة ثانية», and the button
 * asks again.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { apiJson, apiFetch } = vi.hoisted(() => ({ apiJson: vi.fn(), apiFetch: vi.fn() }));

const AGENT = {
  id: 'abeer', name: 'عبير', role: 'CONFIRMATION_AGENT', status: 'ACTIVE',
  permissions: ['confirmation.work', 'orders.contact_log', 'orders.view'],
};

vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a), apiFetch: (...a: unknown[]) => apiFetch(...a) }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/' }));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ locale: 'ar', t: {}, currentUser: AGENT }) }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => false }));
vi.mock('@/hooks/useRegions', () => ({
  useRegions: () => ({ regions: [{ id: 'r-dam', name: 'دمشق' }], countryName: 'سوريا', currency: null, loading: false }),
}));
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
vi.mock('@/components/orders/ContactButtons', () => ({ ContactButtons: () => null }));
vi.mock('@/components/orders/CopyValue', () => ({ CopyValue: () => null }));
vi.mock('@/components/screens/confirmation/AssistantDialog', () => ({ AssistantDialog: () => null }));
vi.mock('@/components/screens/ConfirmationPostponedScreen', () => ({ ConfirmationPostponedScreen: () => null }));
vi.mock('@/components/confirmation/PullPanel', () => ({ PullPanel: () => null, useQueue: () => ({ reload: vi.fn() }) }));

import { ConfirmationMineScreen } from './ConfirmationMineScreen';

const emptyDesk = () => ({
  leadDays: 2,
  waitingLater: 0,
  noAnswerLimit: 3,
  serverNow: '2026-11-04T08:00:00.000Z',
  work: [],
  noAnswer: [],
  closedToday: [],
  confirmed: { day: '2026-11-04', q: '', page: 1, pageSize: 25, total: 0, pages: 1, rows: [] },
});

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, '', '/');
  apiFetch.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({}), clone() { return this; } }));
});
afterEach(cleanup);

describe('«طلباتي» when the first load fails', () => {
  it('draws the error and «جرّب مرة ثانية» — not a spinner that turns for ever', async () => {
    apiJson.mockRejectedValue(new Error('انتهت مهلة الطلب. تحقق من الاتصال وحاول مجدداً.'));
    render(<ConfirmationMineScreen />);

    expect((await screen.findByRole('alert')).textContent).toContain('انتهت مهلة الطلب');
    expect(screen.getByRole('button', { name: 'جرّب مرة ثانية' })).toBeTruthy();
    expect(screen.queryByText('جارٍ التحميل…')).toBeNull();
  });

  it('and the button asks again, and the desk replaces the error when the answer comes', async () => {
    apiJson.mockRejectedValueOnce(new Error('الخادم لا يرد'));
    render(<ConfirmationMineScreen />);
    const retry = await screen.findByRole('button', { name: 'جرّب مرة ثانية' });

    apiJson.mockResolvedValue(emptyDesk());
    const before = apiJson.mock.calls.filter(([u]) => String(u).startsWith('/api/confirmation/mine')).length;
    fireEvent.click(retry);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'طلباتي' })).toBeTruthy());
    expect(apiJson.mock.calls.filter(([u]) => String(u).startsWith('/api/confirmation/mine')).length).toBe(before + 1);
    expect(screen.queryByRole('button', { name: 'جرّب مرة ثانية' })).toBeNull();
    // The failed load's message does not linger above a desk that loaded.
    expect(screen.queryByText('الخادم لا يرد')).toBeNull();
  });

  it('while it is still waiting, it says so', () => {
    apiJson.mockImplementation(() => new Promise(() => {}));
    render(<ConfirmationMineScreen />);
    expect(screen.getByText('جارٍ التحميل…')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
