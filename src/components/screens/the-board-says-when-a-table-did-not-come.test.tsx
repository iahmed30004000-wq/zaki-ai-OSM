// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE PERFORMANCE BOARD SAYS WHEN A TABLE DID NOT COME — AND THE NEWEST ANSWER WINS (13/11 — plan PR-7, item 5).
 *
 * The team table, the moderators' and channels' tables and the couriers' table each failed into «no rows»: a timeout drew the
 * couriers as «لا شركات شحن بعد» and the team as an empty table, which reads as «nobody worked». A failure is now its own state,
 * drawn with the shared `EmptyState` and a retry (the pattern this screen already uses for the vitals). And when the window changed
 * while an old answer was still on its way, the old one used to land last and overwrite the new window's table: each loader numbers
 * its calls and applies only the newest.
 *
 * The tables themselves are stood in for by a line that says how many rows they were handed — what is under test is what the screen
 * decides to draw, not the tables.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { apiFetch, apiJson } = vi.hoisted(() => ({ apiFetch: vi.fn(), apiJson: vi.fn() }));

vi.mock('@/lib/api-client', async (orig) => ({
  ...(await orig<typeof import('@/lib/api-client')>()),
  apiFetch: (...a: unknown[]) => apiFetch(...a),
  apiJson: (...a: unknown[]) => apiJson(...a),
}));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({
    t: {},
    locale: 'ar',
    isRtl: true,
    currentUser: { id: 'u1', role: 'MANAGER', permissions: ['reports.view', 'team.monitor', 'insights.view'] },
  }),
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
// A button that moves the window, so the test can change `dateQuery` the way a person does.
vi.mock('@/components/ui/DateRange', () => ({
  DateRange: ({ onChange }: { onChange: (r: { from: string; to: string }) => void }) => (
    <button onClick={() => onChange({ from: '2026-10-01', to: '2026-10-07' })}>غيّر المدة</button>
  ),
}));
vi.mock('@/components/shell/ThemeDecor', () => ({ ThemeDecor: () => null }));
vi.mock('@/components/growth/ChannelScores', () => ({ ChannelScoresSection: () => null }));
vi.mock('@/components/dashboard/DetailsLinks', () => ({ BackToDashboardLink: () => null }));
vi.mock('@/components/performance/ScoreBoard', () => ({ ScoreBoard: () => null }));
vi.mock('@/components/performance/NoAnswerWatch', () => ({ NoAnswerWatch: () => null }));
vi.mock('@/components/performance/LandingAnalyticsTab', () => ({ LandingAnalyticsTab: () => null }));
vi.mock('@/components/performance/TeamPerformanceTable', () => ({
  TeamPerformanceTable: ({ rows }: { rows: unknown[] | null }) => <p>جدول الفريق: {rows === null ? 'ينتظر' : `${rows.length} صف`}</p>,
}));
vi.mock('@/components/performance/AttributionTable', () => ({
  AttributionTable: ({ rows, empty }: { rows: unknown[] | null; empty: string }) => <p>{empty}|{rows === null ? 'ينتظر' : `${rows.length} صف`}</p>,
}));
vi.mock('@/components/ui/Money', () => ({ Money: ({ value }: { value: number }) => <span>{value}</span> }));

import { PerformanceScreen } from './PerformanceScreen';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const ANALYTICS = { ordersCount: { total: 1 }, rates: {}, financials: {}, rankings: {}, productStats: [], vitals: { door: { delivered: 0, failed: 0, returned: 0, decided: 0, returnRate: null }, cost: { level: 'WITHHELD' } } };

const TEAM = { employees: [{ id: 'e1' }, { id: 'e2' }], totals: {} };
const ATTRIBUTION = { moderators: [{ id: 'm1' }], channels: [{ id: 'c1' }, { id: 'c2' }], totals: undefined };
// No courier rows: a row draws a whole score card, and what is under test is failure versus «none yet» versus an answer.
const COURIERS = { providers: [], collection: { level: 'OK' } };

/** What each endpoint answers; a test overrides one. */
const answers: Record<string, () => Promise<unknown>> = {};

beforeEach(() => {
  vi.clearAllMocks();
  apiFetch.mockResolvedValue(json(200, ANALYTICS));
  answers.team = async () => TEAM;
  answers.attribution = async () => ATTRIBUTION;
  answers.couriers = async () => COURIERS;
  apiJson.mockImplementation(async (url: string) => {
    if (url.includes('/confirmation/team')) return answers.team();
    if (url.includes('/growth/attribution')) return answers.attribution();
    if (url.includes('/shipping/performance')) return answers.couriers();
    return {};
  });
});
afterEach(cleanup);

const calls = (part: string) => apiJson.mock.calls.filter((c) => String(c[0]).includes(part));

describe('a table that did not come is not an empty table', () => {
  it('the team: a rejected call says the table did not come and offers a retry — it is NOT drawn as a table with no rows', async () => {
    answers.team = async () => {
      throw new Error('timeout');
    };
    render(<PerformanceScreen />);
    expect(await screen.findByText('تعذّر تحميل جدول الفريق')).toBeTruthy();
    expect(screen.queryByText(/جدول الفريق:/), 'الجدول انرسم فاضي').toBeNull();
    // the other tables are untouched by the team's failure
    await waitFor(() => expect(screen.getByText(/لا طلبات منسوبة لمودريتر في هذه المدة\.\|1 صف/)).toBeTruthy());
  });

  it('…and the retry asks again and draws the table when it works', async () => {
    answers.team = async () => {
      throw new Error('timeout');
    };
    render(<PerformanceScreen />);
    await screen.findByText('تعذّر تحميل جدول الفريق');
    const before = calls('/confirmation/team').length;
    answers.team = async () => TEAM;
    fireEvent.click(screen.getAllByText('إعادة المحاولة')[0]);
    await waitFor(() => expect(screen.getByText('جدول الفريق: 2 صف')).toBeTruthy());
    expect(calls('/confirmation/team').length).toBe(before + 1);
    expect(screen.queryByText('تعذّر تحميل جدول الفريق')).toBeNull();
  });

  it('the moderators and the channels: one failed call is two failure states, one retry fixes both', async () => {
    answers.attribution = async () => {
      throw new Error('timeout');
    };
    render(<PerformanceScreen />);
    expect(await screen.findByText('تعذّر تحميل أرقام المودريتورية')).toBeTruthy();
    expect(screen.getByText('تعذّر تحميل أرقام القنوات')).toBeTruthy();
    answers.attribution = async () => ATTRIBUTION;
    fireEvent.click(screen.getAllByText('إعادة المحاولة')[0]);
    await waitFor(() => expect(screen.getByText(/لا طلبات مرتبطة بقناة في هذه المدة\.\|2 صف/)).toBeTruthy());
    expect(screen.queryByText('تعذّر تحميل أرقام المودريتورية')).toBeNull();
    expect(screen.queryByText('تعذّر تحميل أرقام القنوات')).toBeNull();
  });

  it('the couriers: a rejected call is NOT «لا شركات شحن بعد.»', async () => {
    answers.couriers = async () => {
      throw new Error('timeout');
    };
    render(<PerformanceScreen />);
    expect(await screen.findByText('تعذّر تحميل شركات الشحن')).toBeTruthy();
    expect(screen.queryByText('لا شركات شحن بعد.')).toBeNull();
  });

  it('and a real «no couriers yet» is still said as it was — an answer that is empty is not a failure', async () => {
    answers.couriers = async () => ({ providers: [], collection: null });
    render(<PerformanceScreen />);
    expect(await screen.findByText('لا شركات شحن بعد.')).toBeTruthy();
    expect(screen.queryByText('تعذّر تحميل شركات الشحن')).toBeNull();
  });

  it('and when all three answer, no failure is drawn at all', async () => {
    render(<PerformanceScreen />);
    await waitFor(() => expect(screen.getByText('جدول الفريق: 2 صف')).toBeTruthy());
    expect(screen.queryByText(/تعذّر تحميل (جدول الفريق|أرقام المودريتورية|أرقام القنوات|شركات الشحن)/)).toBeNull();
  });
});

describe('the newest answer wins', () => {
  /** A call the test answers by hand, in any order. */
  function handCalls() {
    const waiting: Array<{ url: string; resolve: (v: unknown) => void }> = [];
    apiJson.mockImplementation(
      (url: string) =>
        new Promise((resolve) => {
          waiting.push({ url, resolve });
        })
    );
    return waiting;
  }

  it('the team: the OLD window\'s answer arriving after the NEW window\'s does not overwrite it', async () => {
    const waiting = handCalls();
    render(<PerformanceScreen />);
    await waitFor(() => expect(waiting.filter((w) => w.url.includes('/confirmation/team')).length).toBe(1));
    fireEvent.click(screen.getByText('غيّر المدة')); // the window moves while the first call is still out
    await waitFor(() => expect(waiting.filter((w) => w.url.includes('/confirmation/team')).length).toBe(2));
    const [oldCall, newCall] = waiting.filter((w) => w.url.includes('/confirmation/team'));
    expect(newCall.url).toContain('startDate=2026-10-01');
    // the NEW window answers first, with one person; then the OLD one limps in with five
    newCall.resolve({ employees: [{ id: 'n1' }], totals: {} });
    await waitFor(() => expect(screen.getByText('جدول الفريق: 1 صف')).toBeTruthy());
    oldCall.resolve({ employees: [{ id: 'o1' }, { id: 'o2' }, { id: 'o3' }, { id: 'o4' }, { id: 'o5' }], totals: {} });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByText('جدول الفريق: 1 صف'), 'جواب المدة القديمة غطّى الجديد').toBeTruthy();
  });

  it('the attribution tables and the couriers follow the same rule', async () => {
    const waiting = handCalls();
    render(<PerformanceScreen />);
    await waitFor(() => expect(waiting.filter((w) => w.url.includes('/growth/attribution')).length).toBe(1));
    fireEvent.click(screen.getByText('غيّر المدة'));
    await waitFor(() => expect(waiting.filter((w) => w.url.includes('/growth/attribution')).length).toBe(2));
    const [oldCall, newCall] = waiting.filter((w) => w.url.includes('/growth/attribution'));
    newCall.resolve({ moderators: [{ id: 'm' }], channels: [{ id: 'c' }], totals: undefined });
    await waitFor(() => expect(screen.getByText(/لا طلبات مرتبطة بقناة في هذه المدة\.\|1 صف/)).toBeTruthy());
    oldCall.resolve({ moderators: [{}, {}, {}], channels: [{}, {}, {}, {}], totals: undefined });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByText(/لا طلبات مرتبطة بقناة في هذه المدة\.\|1 صف/)).toBeTruthy();
  });

  it('an OLD window\'s FAILURE arriving late does not turn the new window\'s table into a failure either', async () => {
    const waiting: Array<{ url: string; resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];
    apiJson.mockImplementation(
      (url: string) =>
        new Promise((resolve, reject) => {
          waiting.push({ url, resolve, reject });
        })
    );
    render(<PerformanceScreen />);
    await waitFor(() => expect(waiting.filter((w) => w.url.includes('/confirmation/team')).length).toBe(1));
    fireEvent.click(screen.getByText('غيّر المدة'));
    await waitFor(() => expect(waiting.filter((w) => w.url.includes('/confirmation/team')).length).toBe(2));
    const [oldCall, newCall] = waiting.filter((w) => w.url.includes('/confirmation/team'));
    newCall.resolve({ employees: [{ id: 'n1' }], totals: {} });
    await waitFor(() => expect(screen.getByText('جدول الفريق: 1 صف')).toBeTruthy());
    oldCall.reject(new Error('timeout'));
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText('تعذّر تحميل جدول الفريق')).toBeNull();
    expect(screen.getByText('جدول الفريق: 1 صف')).toBeTruthy();
  });
});
