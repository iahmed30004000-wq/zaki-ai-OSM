// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@/lib/guard-source';

/**
 * A BOARD THAT HAS NOT BEEN ANSWERED YET DRAWS A WAITING STATE — NOT ZEROS.
 *
 * The owner: «الأرقام بشاشة التحكم ما بتظهر غير بعد وقت». `loading` was written on every
 * request and read by nobody, so until the first answer the dashboard painted «٠ طلب»،
 * «٠٪»، «٠ دينار» from its fallbacks and then changed them. A zero is a statement about
 * the shop; «we have not asked yet» is not.
 *
 * (A refusal and a failure already have their own card — a-refused-board-is-not-drawn-as-
 * zeros owns those. This file owns the interval BEFORE any answer, and that no figure is
 * drawn before the server has sent it.)
 */

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));

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
    currentUser: { id: 'u1', role: 'MANAGER', permissions: ['dashboard.view', 'reports.view', 'insights.view'] },
  }),
}));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
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

/** A request that stays open until the test answers it. */
function pending() {
  let answer!: (r: Response) => void;
  const promise = new Promise<Response>((resolve) => {
    answer = resolve;
  });
  return { promise, answer };
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

describe('the dashboard before its first answer', () => {
  it('draws a waiting state and none of the figures — no «٠ طلب», no tiles', async () => {
    const wait = pending();
    apiFetch.mockReturnValue(wait.promise);
    const { container } = render(<DashboardScreen />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    // said once for the whole block, and marked busy
    expect(screen.getByRole('status', { name: 'جارٍ التحميل' })).toBeTruthy();
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();
    // none of what the fallbacks used to paint
    expect(screen.queryByText('الأكثر طلباً')).toBeNull();
    expect(screen.queryByText('0 طلب')).toBeNull();
    expect(screen.queryByText('ترتيب المنتجات والأرباح')).toBeNull();
    expect(container.textContent ?? '').not.toMatch(/%|0 طلب|0 توصيل|0 رفض/);
    // the page itself is there: the title and the period choice do not wait for the numbers
    expect(screen.getByText('لوحة التحكم')).toBeTruthy();
    expect(screen.getByText('اليوم')).toBeTruthy();
  });

  it('then the figures replace the waiting state, with the server’s numbers', async () => {
    const wait = pending();
    apiFetch.mockReturnValue(wait.promise);
    render(<DashboardScreen />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(screen.queryByText('4 طلب')).toBeNull();
    await act(async () => wait.answer(json(200, GOOD)));
    await waitFor(() => expect(screen.getByText('4 طلب')).toBeTruthy());
    expect(screen.getByText('الأكثر طلباً')).toBeTruthy();
    expect(screen.queryByRole('status', { name: 'جارٍ التحميل' })).toBeNull();
  });

  it('and a failure still says so instead of waiting for ever', async () => {
    const wait = pending();
    apiFetch.mockReturnValue(wait.promise);
    render(<DashboardScreen />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    await act(async () => wait.answer(json(500, { error: 'x', errorAr: 'حدث خطأ داخلي. أعد المحاولة.' })));
    expect(await screen.findByText('تعذّر تحميل أرقام لوحة التحكم')).toBeTruthy();
    expect(screen.queryByRole('status', { name: 'جارٍ التحميل' })).toBeNull();
  });
});

describe('the performance board before its first answer', () => {
  it('draws a waiting state and none of the headlines', async () => {
    const wait = pending();
    apiFetch.mockReturnValue(wait.promise);
    const { container } = render(<PerformanceScreen />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(screen.getByRole('status', { name: 'جارٍ التحميل' })).toBeTruthy();
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();
    expect(screen.queryByText('الأكثر طلباً')).toBeNull();
    expect(container.textContent ?? '').not.toMatch(/0 طلب|0 موصَّل/);
  });

  it('then the headlines arrive', async () => {
    const wait = pending();
    apiFetch.mockReturnValue(wait.promise);
    render(<PerformanceScreen />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    await act(async () => wait.answer(json(200, GOOD)));
    await waitFor(() => expect(screen.getByText('الأكثر طلباً')).toBeTruthy());
    expect(screen.queryByRole('status', { name: 'جارٍ التحميل' })).toBeNull();
  });
});

describe('the source: a loading flag that is written is read', () => {
  const screens = join(process.cwd(), 'src', 'components', 'screens');
  for (const file of ['DashboardScreen.tsx', 'PerformanceScreen.tsx']) {
    it(`${file} reads its \`loading\` and holds the figures back while there is no analytics`, () => {
      const src = stripComments(readFileSync(join(screens, file), 'utf8'));
      expect(src).toMatch(/aria-busy=\{loading\}/);
      expect(src).toContain('<SkeletonRows');
    });
  }

  it('the dashboard’s test is `no analytics and no refusal` — a refusal keeps its own card', () => {
    const src = stripComments(readFileSync(join(screens, 'DashboardScreen.tsx'), 'utf8'));
    expect(src).toMatch(/const waiting = !analytics && !refusal;/);
  });
});
