// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * A REFUSED BOARD SAYS «لا تملك صلاحية» — IT DOES NOT DRAW ZEROS.
 *
 * The dashboard and the performance board read their numbers with `if (res.ok)` and
 * nothing else. A 403 (the person's key was taken, or the two doors were asked with
 * different keys) left `analytics` null, and every tile fell back to «٠»: «٠ طلب،
 * ٠٪ تأكيد» is a statement about the shop, and a refusal is not. P13a of the money
 * and permissions plan.
 *
 * Each case is the same screen twice: refused → the sentence and none of the tiles;
 * allowed → the tiles — so a fix that simply blanked the page fails.
 */

const { apiFetch, may, who } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  who: { perms: ['dashboard.view', 'reports.view', 'insights.view'] as string[] },
  may: { yes: ((_p: string) => true) as (p: string) => boolean },
}));

vi.mock('@/lib/api-client', async (orig) => ({
  ...(await orig<typeof import('@/lib/api-client')>()),
  apiFetch: (...a: unknown[]) => apiFetch(...a),
  apiJson: vi.fn(async () => ({})),
}));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({
    t: { dashboard: 'لوحة التحكم' },
    locale: 'ar',
    isRtl: true,
    currentUser: { id: 'u1', role: 'MANAGER', permissions: who.perms },
  }),
}));
vi.mock('@/hooks/useMayOpen', () => ({
  useMayOpen: () => (target: string | { path: string }) => may.yes(typeof target === 'string' ? target : target.path),
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
vi.mock('@/components/shell/ThemeDecor', () => ({ ThemeDecor: () => null }));
vi.mock('@/components/orders/CreateOrderModal', () => ({ CreateOrderModal: () => null }));
vi.mock('@/components/orders/AiOrderModal', () => ({ AiOrderModal: () => null }));
vi.mock('@/components/growth/IntelligenceStrip', () => ({ IntelligenceStrip: () => null }));
vi.mock('@/components/growth/ChannelScores', () => ({ ChannelScoresSection: () => null }));
vi.mock('@/components/dashboard/LossPanel', () => ({ LossPanel: () => null }));
vi.mock('@/components/dashboard/WorkToday', () => ({ WorkToday: () => null }));
vi.mock('@/components/dashboard/DetailsLinks', () => ({ DetailsLink: () => null, BackToDashboardLink: () => null }));
vi.mock('@/components/performance/ScoreBoard', () => ({ ScoreBoard: () => null }));
vi.mock('@/components/performance/LandingAnalyticsTab', () => ({ LandingAnalyticsTab: () => null }));
vi.mock('@/components/performance/TeamPerformanceTable', () => ({ TeamPerformanceTable: () => null }));
vi.mock('@/components/performance/AttributionTable', () => ({ AttributionTable: () => null }));
vi.mock('@/components/ui/Money', () => ({ Money: ({ value }: { value: number }) => <span>{value}</span> }));

import { DashboardScreen } from './DashboardScreen';
import { PerformanceScreen } from './PerformanceScreen';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const GOOD = {
  ordersCount: { total: 7, new: 1, contacting: 0, confirmed: 3, postponed: 0, rejected: 1, shipped: 2, delivered: 2 },
  rates: { confirmationRate: 60, deliveryRate: 70 },
  financials: {},
  rankings: { mostRequested: { id: 'p1', name: 'كريم الشعر', totalOrders: 4 } },
  productStats: [],
  outcomes: { outcomes: [], total: 0 },
};

beforeEach(() => {
  vi.clearAllMocks();
  may.yes = () => true;
  who.perms = ['dashboard.view', 'reports.view', 'insights.view'];
});
afterEach(cleanup);

describe('the dashboard', () => {
  it('REFUSED: says it, and draws none of the tiles', async () => {
    apiFetch.mockResolvedValue(json(403, { error: 'Forbidden', errorAr: 'لا تملك صلاحية «عرض لوحة التحكم». اطلبها من مدير النظام.' }));
    render(<DashboardScreen />);
    // The key that refused is «عرض التقارير» (the dashboard screen's own key opens none of the numbers).
    expect(await screen.findByText('لا تملك صلاحية «عرض التقارير»')).toBeTruthy();
    expect(screen.getByText('أرقام لوحة التحكم تُقرأ بصلاحية «عرض التقارير». اطلبها من مدير النظام.')).toBeTruthy();
    // a refusal has no «إعادة المحاولة»: trying again cannot change the key
    expect(screen.queryByText('إعادة المحاولة')).toBeNull();
    // none of the tiles that would have said «٠»
    expect(screen.queryByText('الأكثر طلباً')).toBeNull();
    expect(screen.queryByText('الأكثر توصيلاً')).toBeNull();
    expect(apiFetch.mock.calls[0][0]).toContain('/api/analytics?period=');
  });

  it('FAILED (not a refusal): says the numbers did not come — and still no zeros', async () => {
    apiFetch.mockResolvedValue(json(500, { error: 'x', errorAr: 'حدث خطأ داخلي. أعد المحاولة.' }));
    render(<DashboardScreen />);
    expect(await screen.findByText('تعذّر تحميل أرقام لوحة التحكم')).toBeTruthy();
    expect(screen.queryByText('لا تملك صلاحية «عرض التقارير»')).toBeNull();
    expect(screen.queryByText('الأكثر طلباً')).toBeNull();
  });

  it('NETWORK DOWN: the catch says it too — no zeros — and «إعادة المحاولة» asks again and draws the tiles when it works', async () => {
    apiFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    render(<DashboardScreen />);
    expect(await screen.findByText('تعذّر تحميل أرقام لوحة التحكم')).toBeTruthy();
    // an English browser message is never shown: the Arabic sentence stands in
    expect(screen.getByText('تعذّر الاتصال. تحقق من الشبكة وأعد المحاولة.')).toBeTruthy();
    expect(screen.queryByText('Failed to fetch')).toBeNull();
    expect(screen.queryByText('الأكثر طلباً')).toBeNull();
    apiFetch.mockResolvedValue(json(200, GOOD));
    fireEvent.click(screen.getByText('إعادة المحاولة'));
    await waitFor(() => expect(screen.getByText('الأكثر طلباً')).toBeTruthy());
  });

  it('an answer without a body still says something (the fallback sentence)', async () => {
    apiFetch.mockResolvedValue(new Response('', { status: 502 }));
    render(<DashboardScreen />);
    expect(await screen.findByText('تعذّر تحميل أرقام لوحة التحكم. أعد المحاولة بعد قليل.')).toBeTruthy();
    expect(screen.getByText('إعادة المحاولة')).toBeTruthy();
  });

  it('ALLOWED: draws the tiles, and no refusal', async () => {
    apiFetch.mockResolvedValue(json(200, GOOD));
    render(<DashboardScreen />);
    await waitFor(() => expect(screen.getByText('الأكثر طلباً')).toBeTruthy());
    expect(screen.queryByText('لا تملك صلاحية «عرض التقارير»')).toBeNull();
  });
});

describe('PR-10: the smart cards are drawn for insights.view only', () => {
  it('the dashboard: without the key there is no ranking and no loss panel — but the tiles are there', async () => {
    who.perms = ['dashboard.view', 'reports.view'];
    apiFetch.mockResolvedValue(json(200, GOOD));
    render(<DashboardScreen />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText('تعذّر تحميل أرقام لوحة التحكم')).toBeNull());
    expect(screen.queryByText('الأكثر طلباً')).toBeNull();
    expect(screen.queryByText('ترتيب المنتجات والأرباح')).toBeNull();
  });

  it('NEGATIVE (the test of the test): the same dashboard WITH the key draws the ranking', async () => {
    apiFetch.mockResolvedValue(json(200, GOOD));
    render(<DashboardScreen />);
    await waitFor(() => expect(screen.getByText('الأكثر طلباً')).toBeTruthy());
    expect(screen.getByText('ترتيب المنتجات والأرباح')).toBeTruthy();
  });

  it('the performance board: without the key there are no headlines', async () => {
    who.perms = ['dashboard.view', 'reports.view'];
    apiFetch.mockResolvedValue(json(200, GOOD));
    render(<PerformanceScreen />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText('تعذّر تحميل أرقام لوحة الأداء')).toBeNull());
    expect(screen.queryByText('الأكثر طلباً')).toBeNull();
    expect(screen.queryByText('الأكثر توصيلاً')).toBeNull();
  });
});

describe('the performance board', () => {
  it('asks its OWN answer, not the dashboard’s — and REFUSED says so', async () => {
    apiFetch.mockResolvedValue(json(403, { error: 'Forbidden', errorAr: 'لا تملك صلاحية «عرض التقارير».' }));
    render(<PerformanceScreen />);
    expect(await screen.findByText('لا تملك صلاحية «عرض التقارير»')).toBeTruthy();
    expect(screen.getByText('أرقام لوحة الأداء تُقرأ بصلاحية «عرض التقارير». اطلبها من مدير النظام.')).toBeTruthy();
    expect(screen.queryByText('إعادة المحاولة')).toBeNull();
    const asked = apiFetch.mock.calls.map((c) => String(c[0]));
    expect(asked.some((u) => u.startsWith('/api/analytics/performance?'))).toBe(true);
    expect(asked.some((u) => /^\/api\/analytics\?/.test(u))).toBe(false);
  });

  it('FAILED: says the numbers did not come, without the refusal sentence', async () => {
    apiFetch.mockResolvedValue(json(500, { error: 'x' }));
    render(<PerformanceScreen />);
    expect(await screen.findByText('تعذّر تحميل أرقام لوحة الأداء')).toBeTruthy();
    expect(screen.queryByText('لا تملك صلاحية «عرض التقارير»')).toBeNull();
  });

  it('NETWORK DOWN: says the numbers did not come, with «إعادة المحاولة» — no zeros', async () => {
    apiFetch.mockRejectedValue(new Error('انتهت مهلة الطلب. تحقق من الاتصال وحاول مجدداً.'));
    render(<PerformanceScreen />);
    expect(await screen.findByText('تعذّر تحميل أرقام لوحة الأداء')).toBeTruthy();
    // an Arabic message from apiFetch (timeout) is shown as it is
    expect(screen.getByText('انتهت مهلة الطلب. تحقق من الاتصال وحاول مجدداً.')).toBeTruthy();
    expect(screen.getByText('إعادة المحاولة')).toBeTruthy();
    expect(screen.queryByText('الأكثر طلباً')).toBeNull();
  });

  it('ALLOWED: draws the board, and no refusal', async () => {
    apiFetch.mockResolvedValue(json(200, GOOD));
    render(<PerformanceScreen />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText('لا تملك صلاحية «عرض التقارير»')).toBeNull());
    expect(screen.queryByText('تعذّر تحميل أرقام لوحة الأداء')).toBeNull();
    expect(screen.getByText('الأكثر طلباً')).toBeTruthy();
  });
});
