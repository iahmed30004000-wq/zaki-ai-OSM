// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { translations } from '@/lib/i18n';
import { repoFile, stripComments } from '@/lib/guard-source';
import { presetRange } from '@/components/ui/DateRange';

/**
 * «اليوم» (R9, plan 17/11 — 18/11): THREE NUMBERS, «بدّو إياك هلق», ONE CHART. EVERYTHING ELSE MOVED, NOTHING WAS LOST.
 *
 * The dashboard had grown to some thirty boxes. It opens now on the three figures, the one list and the one chart, with the date
 * box, the two order doors and «التفاصيل» — and each block that left is drawn on the performance board, the same component over
 * the same builder. This file renders both screens (jsdom; nothing behind the sign-in can be opened in a browser here).
 */

const { apiFetch, apiJson, who } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  apiJson: vi.fn(),
  who: { perms: [] as string[] },
}));

vi.mock('@/lib/api-client', async (orig) => ({
  ...(await orig<typeof import('@/lib/api-client')>()),
  apiFetch: (...a: unknown[]) => apiFetch(...a),
  apiJson: (...a: unknown[]) => apiJson(...a),
}));
vi.mock('@/context/AppContext', () => ({
  useAppOptional: () => null,
  useApp: () => ({
    t: translations.ar,
    locale: 'ar',
    isRtl: true,
    currentUser: { id: 'u1', role: 'MANAGER', status: 'ACTIVE', permissions: who.perms },
  }),
}));
vi.mock('@/lib/can', () => ({ userCan: (u: { permissions: string[] } | null, p: string) => !!u?.permissions.includes(p) }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/hooks/useLiveRefresh', () => ({
  useLiveRefresh: (load: () => Promise<unknown>) => {
    React.useEffect(() => {
      void load();
    }, [load]);
  },
}));
vi.mock('@/components/shell/ThemeDecor', () => ({ ThemeDecor: () => null }));
vi.mock('@/components/orders/CreateOrderModal', () => ({ CreateOrderModal: () => null }));
vi.mock('@/components/orders/AiOrderModal', () => ({ AiOrderModal: () => null }));
vi.mock('@/components/ui/Money', () => ({ Money: ({ value }: { value: number }) => <span>{value} د.أ</span> }));
// The loss panel has its own tests over its own door; here it shows the window it was handed.
vi.mock('@/components/dashboard/LossPanel', () => ({
  LossPanel: ({ period }: { period: string }) => <p>أين نخسر الطلبات — ولماذا|{period}</p>,
}));
vi.mock('@/components/growth/ChannelScores', () => ({ ChannelScoresSection: () => null }));
vi.mock('@/components/performance/ScoreBoard', () => ({ ScoreBoard: () => null }));
vi.mock('@/components/performance/LandingAnalyticsTab', () => ({ LandingAnalyticsTab: () => null }));
vi.mock('@/components/performance/TeamPerformanceTable', () => ({ TeamPerformanceTable: () => null }));
vi.mock('@/components/performance/AttributionTable', () => ({ AttributionTable: () => null }));

import { DashboardScreen } from './DashboardScreen';
import { PerformanceScreen } from './PerformanceScreen';

const t = translations.ar;
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const ANALYTICS = {
  ordersCount: { total: 9, decided: 8, new: 2, contacting: 1, confirmed: 6, postponed: 1, rejected: 2, shipped: 3, delivered: 4 },
  rates: { confirmationRate: 75, deliveryRate: 66 },
  financials: { netProfit: 120, profitMargin: 20, deliveredRevenue: 600 },
  previous: null,
  rankings: {
    mostRequested: { id: 'p1', name: 'كريم الشعر', totalOrders: 5 },
    mostDelivered: { id: 'p2', name: 'زيت الأرغان', deliveredOrders: 3 },
  },
  productStats: [],
  outcomes: { outcomes: [{ key: 'DELIVERED', label: 'وصل وانحصّل', count: 4, closed: true }], total: 4 },
  moderatorLeaderboard: [{ id: 'm1', name: 'سامر', totalOrders: 7, confirmedOrders: 5, confirmationRate: 71, sales: 300 }],
  vitals: {
    door: { delivered: 4, failed: 1, returned: 1, decided: 6, returnRate: 17, failureRate: 17 },
    cost: { level: 'STATED', ar: 'الكلفة مسجَّلة' },
    expenses: { rows: 2 },
    outstanding: { orders: 3, money: 450, unrecordedOrders: 0 },
  },
};
const DAILY = {
  days: [{ day: '2026-11-18', created: 9, confirmed: 6, delivered: 4 }],
  totals: { created: 9, confirmed: 6, delivered: 4 },
  truncated: false,
};
const WORK = { items: [{ key: 'LATE_SHIPMENTS', ar: 'شحنة متأخّرة', count: 3, href: '/ops/tracking', icon: 'truck', tone: 'urgent' }] };

const OWNER = ['dashboard.view', 'reports.view', 'finance.view', 'insights.view', 'orders.create', 'team.monitor', 'users.view'];

beforeEach(() => {
  vi.clearAllMocks();
  who.perms = OWNER;
  apiFetch.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/analytics/daily?')) return json(200, DAILY);
    if (url.startsWith('/api/analytics')) return json(200, ANALYTICS);
    if (url === '/api/me/work') return json(200, WORK);
    return json(200, {});
  });
  apiJson.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/growth/intelligence')) return { byFamily: { queue: { total: 2, alarm: 1 } } };
    if (url.includes('/shipping/performance')) return { providers: [], collection: { level: 'OK' } };
    return {};
  });
});
afterEach(cleanup);

const analyticsCalls = () => apiFetch.mock.calls.map((c) => String(c[0])).filter((u) => /^\/api\/analytics\?/.test(u));
const dailyCalls = () => apiFetch.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith('/api/analytics/daily?'));

describe('«اليوم» draws three figures, one list, one chart — and nothing else', () => {
  it('the three figures, the list «بدّو إياك هلق», the chart, the date box, the two order doors and «التفاصيل»', async () => {
    const { container } = render(<DashboardScreen />);
    await screen.findByText(t.netProfit);
    expect(screen.getByText(t.confirmationRate)).toBeTruthy();
    expect(screen.getByText(t.deliveryRate)).toBeTruthy();
    expect(screen.getByText('75%')).toBeTruthy();
    expect(screen.getByText('66%')).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'بدّو إياك هلق' })).toBeTruthy();
    expect((await screen.findAllByText('الطلبات كل يوم')).length).toBeGreaterThan(0);
    expect(container.querySelector('button[aria-expanded]')).toBeTruthy();
    expect(screen.getByText('طلب سريع')).toBeTruthy();
    expect(screen.getByText('إدخال بالذكاء الاصطناعي')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'التفاصيل' }).getAttribute('href')).toBe('/growth/performance');
  });

  it('NEGATIVE: none of what moved is drawn here', async () => {
    render(<DashboardScreen />);
    await screen.findByText(t.netProfit);
    await screen.findAllByText('الطلبات كل يوم');
    for (const gone of [
      t.deliveredRevenue,
      'نسبة الإرجاع',
      'لم يُحصَّل بعد',
      'حالات الطلبات — كل التاريخ',
      'ترتيب المنتجات والأرباح',
      'الأكثر طلباً',
      t.moderatorLeaderboard,
      'ما يحتاج تدخّلاً',
      'هذا الشهر',
      'الكل',
    ]) {
      expect(screen.queryByText(gone), gone).toBeNull();
    }
    expect(screen.queryByText(/أين نخسر الطلبات/)).toBeNull();
  });

  it('without «عرض المالية» the profit card is not drawn, and the row is two', async () => {
    who.perms = ['dashboard.view', 'reports.view'];
    const { container } = render(<DashboardScreen />);
    await screen.findByText(t.confirmationRate);
    expect(screen.queryByText(t.netProfit)).toBeNull();
    expect(container.querySelector('.md\\:grid-cols-2')).toBeTruthy();
    expect(container.querySelector('.md\\:grid-cols-3')).toBeNull();
    // and without «إنشاء طلب» the two order doors are not offered
    expect(screen.queryByText('طلب سريع')).toBeNull();
  });

  it('a person with the dashboard but not the reports key reads the refusal, not zeros', async () => {
    who.perms = ['dashboard.view'];
    apiFetch.mockImplementation(async () => json(403, { errorAr: 'لا تملك صلاحية.' }));
    render(<DashboardScreen />);
    expect(await screen.findByText('لا تملك صلاحية «عرض التقارير»')).toBeTruthy();
    expect(screen.queryByText('0%')).toBeNull();
  });

  it('one column on a phone: the row starts at one column and the chart has no pixel width', async () => {
    const { container } = render(<DashboardScreen />);
    await screen.findByText(t.netProfit);
    await screen.findByRole('img');
    expect(screen.getByText(t.netProfit).closest('.grid')?.className).toMatch(/^grid grid-cols-1 /);
    expect(screen.getByRole('img').className).toContain('w-full');
    expect(container.innerHTML).not.toMatch(/(?<![\w-])w-\[\d+px\]/);
  });
});

describe('the date box drives both doors', () => {
  it('opens on «اليوم»: the figures by name, the chart by the day', async () => {
    render(<DashboardScreen />);
    await screen.findByText(t.netProfit);
    expect(analyticsCalls()[0]).toBe('/api/analytics?period=today');
    const today = presetRange('today')!;
    expect(dailyCalls()[0]).toBe(`/api/analytics/daily?from=${today.from}&to=${today.to}`);
  });

  it('«آخر 7 أيام» sends its seven days beside the name, to both doors', async () => {
    const { container } = render(<DashboardScreen />);
    await screen.findByText(t.netProfit);
    fireEvent.click(container.querySelector('button[aria-expanded]')!);
    fireEvent.click(screen.getByRole('button', { name: 'آخر 7 أيام' }));
    const week = presetRange('7d')!;
    await waitFor(() =>
      expect(analyticsCalls()).toContain(`/api/analytics?period=7d&startDate=${week.from}&endDate=${week.to}`)
    );
    await waitFor(() => expect(dailyCalls()).toContain(`/api/analytics/daily?from=${week.from}&to=${week.to}`));
  });

  it('«أمس» travels by name, as it always did', async () => {
    const { container } = render(<DashboardScreen />);
    await screen.findByText(t.netProfit);
    fireEvent.click(container.querySelector('button[aria-expanded]')!);
    fireEvent.click(screen.getByRole('button', { name: 'أمس' }));
    await waitFor(() => expect(analyticsCalls()).toContain('/api/analytics?period=yesterday'));
  });

  it('offers the plan’s five, and not «هذا الشهر»', async () => {
    const { container } = render(<DashboardScreen />);
    await screen.findByText(t.netProfit);
    fireEvent.click(container.querySelector('button[aria-expanded]')!);
    for (const o of ['اليوم', 'أمس', 'آخر 7 أيام', 'آخر 30 يوم']) expect(screen.getByRole('button', { name: o })).toBeTruthy();
    expect(screen.getByText('تاريخ محدد')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'هذا الشهر' })).toBeNull();
  });

  it('clearing the box goes back to «اليوم» — never the whole history', async () => {
    render(<DashboardScreen />);
    await screen.findByText(t.netProfit);
    fireEvent.click(screen.getByRole('button', { name: 'امسح التاريخ' }));
    await waitFor(() => expect(analyticsCalls().length).toBeGreaterThan(0));
    expect(analyticsCalls().every((u) => u.startsWith('/api/analytics?period=today'))).toBe(true);
    expect(analyticsCalls().some((u) => u.includes('period=all'))).toBe(false);
  });
});

describe('everything that left «اليوم» is on the performance board', () => {
  const board = async () => {
    render(<PerformanceScreen />);
    await screen.findByText('الأكثر طلباً');
  };

  it('the strip «ما يحتاج تدخّلاً»', async () => {
    await board();
    expect(await screen.findByText('ما يحتاج تدخّلاً')).toBeTruthy();
  });

  it('the three other figures, with their rules', async () => {
    await board();
    expect(screen.getByText(t.deliveredRevenue)).toBeTruthy();
    expect(screen.getByText('نسبة الإرجاع')).toBeTruthy();
    expect(screen.getByText('لم يُحصَّل بعد')).toBeTruthy();
    expect(screen.getByText('600 د.أ')).toBeTruthy();
    expect(screen.getByText('450 د.أ')).toBeTruthy();
  });

  it('NEGATIVE: and the two money figures only with «عرض المالية»', async () => {
    who.perms = ['reports.view', 'insights.view'];
    await board();
    expect(screen.queryByText(t.deliveredRevenue)).toBeNull();
    expect(screen.queryByText('لم يُحصَّل بعد')).toBeNull();
    expect(screen.getByText('نسبة الإرجاع')).toBeTruthy();
  });

  it('the seven state tiles, the rejected one with its chip', async () => {
    await board();
    for (const label of [t.NEW, t.CONTACTING, t.CONFIRMED, t.POSTPONED, t.SHIPPED, t.DELIVERED, t.REJECTED]) {
      expect(screen.getAllByText(label).length, label).toBeGreaterThan(0);
    }
  });

  it('«حالات الطلبات — كل التاريخ»', async () => {
    await board();
    expect(screen.getByText('حالات الطلبات — كل التاريخ')).toBeTruthy();
    expect(screen.getByText('وصل وانحصّل')).toBeTruthy();
  });

  it('the product ranking: the board’s headlines, whose names open the product', async () => {
    await board();
    expect(screen.getByRole('link', { name: 'كريم الشعر' }).getAttribute('href')).toBe('/products/p1');
    expect(screen.getByRole('link', { name: 'زيت الأرغان' }).getAttribute('href')).toBe('/products/p2');
  });

  it('the loss panel, over the board’s own window', async () => {
    await board();
    const today = presetRange('today')!;
    expect(screen.getByText(`أين نخسر الطلبات — ولماذا|all&startDate=${today.from}&endDate=${today.to}`)).toBeTruthy();
  });

  it('NEGATIVE: and not without the cards’ key', async () => {
    who.perms = ['reports.view', 'finance.view'];
    render(<PerformanceScreen />);
    await screen.findByText(t.deliveredRevenue);
    expect(screen.queryByText(/أين نخسر الطلبات/)).toBeNull();
  });

  it('the moderators’ leaderboard, with its names opening the person', async () => {
    await board();
    expect(screen.getByText(t.moderatorLeaderboard)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'سامر' }).getAttribute('href')).toBe('/admin/users/m1');
  });

  // The board's own key (reports.view) is one of TEAM_PERMISSIONS, so whoever opens the board may see the card; WHO is in it is
  // the server's projection (colleagues' names only to the key of a screen that shows them).
  it('NEGATIVE: and no names when the server sent none', async () => {
    apiFetch.mockImplementation(async (url: string) =>
      url.startsWith('/api/analytics') ? json(200, { ...ANALYTICS, moderatorLeaderboard: undefined }) : json(200, {})
    );
    await board();
    expect(screen.getByText(t.moderatorLeaderboard)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'سامر' })).toBeNull();
  });
});

describe('«اليوم» computes nothing new', () => {
  it('no sum, difference or ratio of the answer’s figures — only the existing arrow beside a card', () => {
    const src = stripComments(repoFile('src/components/screens/DashboardScreen.tsx'));
    // The arrow (`against`) predates R9: a direction and a «%» change beside a card, written once. Everything else prints as sent.
    const outside = src.replace(/const against = [\s\S]*?\n {2}};\n/, '');
    expect(outside.length).toBeLessThan(src.length);
    expect(outside).not.toMatch(/reduce\(|\+=|-=/);
    expect(outside).not.toMatch(/\b(?:fin|counts|rates|vitals|prevRaw)\??\.\w+\s*[-+*/]\s*[\w(]/);
    expect(outside).not.toMatch(/[-+*/]\s*\(?\s*(?:fin|counts|rates|vitals|prevRaw)\??\.\w+/);
  });
});
