// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE SUPERVISOR'S QUEUE AND THE ISSUES DESK — A FAILED FIRST LOAD IS SAID.
 *
 * Both drew «جارٍ التحميل…» until the first answer, and an error as the
 * first answer left the spinner turning for ever (4/11, «بيعلقوا»). Now:
 * the error, «جرّب مرة ثانية», and a second request when it is pressed.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { apiJson } = vi.hoisted(() => ({ apiJson: vi.fn() }));

const SUPERVISOR = {
  id: 'sup', name: 'مشرفة', role: 'CONFIRMATION_SUPERVISOR', status: 'ACTIVE',
  permissions: ['confirmation.supervise', 'confirmation.issues_correct', 'orders.cancel'],
};

vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a), apiFetch: vi.fn() }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/' }));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ locale: 'ar', t: {}, currentUser: SUPERVISOR }) }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => false }));
vi.mock('@/hooks/useRegions', () => ({ useRegions: () => ({ regions: [], countryName: 'سوريا', currency: null, loading: false }) }));
vi.mock('@/hooks/useLiveRefresh', () => ({
  useLiveRefresh: (load: () => Promise<unknown>) => {
    const latest = React.useRef(load);
    latest.current = load;
    React.useEffect(() => {
      void latest.current();
    }, []);
  },
}));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => <h1>الشاشة</h1> }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), done: vi.fn(), warn: vi.fn() }) }));
vi.mock('@/components/orders/useOrderPatch', () => ({ useOrderPatch: () => vi.fn() }));
vi.mock('@/components/orders/CustomerHistory', () => ({ CustomerHistoryButton: () => null, CustomerHistoryOffer: () => null }));

import { ConfirmationQueueScreen } from './ConfirmationQueueScreen';
import { ConfirmationIssuesScreen } from './ConfirmationIssuesScreen';

const calls = (prefix: string) => apiJson.mock.calls.filter(([u]) => String(u).startsWith(prefix)).length;

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('the queue', () => {
  it('a failed first load draws the error and the button, not the spinner', async () => {
    apiJson.mockRejectedValue(new Error('تعذر تحميل الطابور'));
    render(<ConfirmationQueueScreen />);
    expect((await screen.findByRole('alert')).textContent).toContain('تعذر تحميل الطابور');
    expect(screen.queryByText('جارٍ التحميل…')).toBeNull();
  });

  it('and the button asks again, and the queue replaces the error', async () => {
    apiJson.mockRejectedValueOnce(new Error('تعذر تحميل الطابور'));
    render(<ConfirmationQueueScreen />);
    const retry = await screen.findByRole('button', { name: 'جرّب مرة ثانية' });
    apiJson.mockResolvedValue({ waiting: 0, owned: { total: 0, withoutAttempt: 0 }, caps: { withoutAttempt: 10, total: 300 }, leadDays: 2, canPull: false, refusal: null, autoReleased: 0, orders: [] });
    const before = calls('/api/confirmation/queue');
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'الشاشة' })).toBeTruthy());
    expect(calls('/api/confirmation/queue')).toBe(before + 1);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('the issues desk', () => {
  it('a failed first load draws the error and the button, not the spinner', async () => {
    apiJson.mockRejectedValue(new Error('تعذر التحميل'));
    render(<ConfirmationIssuesScreen />);
    expect((await screen.findByRole('alert')).textContent).toContain('تعذر التحميل');
    expect(screen.queryByText('جارٍ التحميل…')).toBeNull();
  });

  it('and the button asks again; the empty desk replaces the error, which does not linger', async () => {
    apiJson.mockRejectedValueOnce(new Error('تعذر التحميل'));
    render(<ConfirmationIssuesScreen />);
    const retry = await screen.findByRole('button', { name: 'جرّب مرة ثانية' });
    apiJson.mockResolvedValue({ issues: [] });
    const before = calls('/api/confirmation/issues');
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByText('لا إشكالات مفتوحة')).toBeTruthy());
    expect(calls('/api/confirmation/issues')).toBe(before + 1);
    expect(screen.queryByText('تعذر التحميل')).toBeNull();
  });
});
