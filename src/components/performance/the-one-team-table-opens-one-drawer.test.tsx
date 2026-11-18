// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@/lib/guard-source';

/**
 * «جدول واحد لأداء الموظفين بدل السبعة» — R14a1 (plan 17/11, built 18/11).
 *
 *   · ONE confirmation-employee table on the board, fed only by `GET /api/orders/confirmation/team` with the board's query;
 *   · a name in that table, or in «سكور الموظفين», opens ONE drawer, which asks `team/[userId]` with the table's EXACT query and prints
 *     the row's figures with the table's own words and the door's own definitions — a 404 or a 403 is the door's sentence, never zeros;
 *   · under it the score, which lives on another door, with its own window said beside it;
 *   · the doors that take no window say theirs beside their numbers;
 *   · the range: the address wins over the stored key, the key over today; a storage that throws is today and no crash; `?tab=` still opens.
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
    currentUser: { id: 'boss', role: 'MANAGER', permissions: ['reports.view', 'team.monitor', 'insights.view'] },
  }),
}));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/hooks/useLiveRefresh', () => ({
  useLiveRefresh: (load: () => Promise<unknown>, opts?: { key?: unknown }) => {
    const latest = React.useRef(load);
    latest.current = load;
    React.useEffect(() => {
      void latest.current();
    }, [opts?.key]);
  },
}));
vi.mock('@/components/growth/IntelligenceStrip', () => ({ IntelligenceStrip: () => null }));
vi.mock('@/components/dashboard/LossPanel', () => ({ LossPanel: () => null }));
vi.mock('@/components/dashboard/DetailsLinks', () => ({ BackToDashboardLink: () => null }));
vi.mock('@/components/performance/NoAnswerWatch', () => ({ NoAnswerWatch: () => <p>شاشة لا رد</p> }));
vi.mock('@/components/performance/LandingAnalyticsTab', () => ({ LandingAnalyticsTab: () => null }));
vi.mock('@/components/performance/EodReportForm', () => ({ EodReportForm: () => null }));
vi.mock('@/components/performance/AgentScorecard', () => ({ AgentScorecard: () => null }));
vi.mock('@/components/performance/CommissionPreview', () => ({ CommissionPreview: () => null }));
vi.mock('@/components/ui/Money', () => ({ Money: ({ value }: { value: number }) => <span>{value}</span> }));
vi.mock('@/components/ui/HealthChip', () => ({ HealthChip: () => null }));
// A button that moves the window, the way a person does with the date box.
vi.mock('@/components/ui/DateRange', () => ({
  todayRange: () => ({ from: '2026-11-18', to: '2026-11-18' }),
  DateRange: ({ onChange, value }: { onChange: (r: { from: string; to: string }) => void; value: { from: string; to: string } }) => (
    <button type="button" onClick={() => onChange({ from: '2026-11-01', to: '2026-11-07' })}>
      المدة {value.from} {value.to}
    </button>
  ),
}));

import { PerformanceScreen } from '@/components/screens/PerformanceScreen';
import { TeamPerformanceTable, rowFigures, type TeamRow } from './TeamPerformanceTable';
import { TeamMemberDrawer } from './TeamMemberDrawer';
import { REPORT_RANGE_KEY } from '@/lib/report-range';

const ROW: TeamRow = {
  id: 'a1', name: 'ليلى', role: 'CONFIRMATION_AGENT',
  claimed: 40, confirmed: 28, rejected: 6, noAnswer: 5, decided: 34, openNow: 12,
  confirmationRate: 82, medianConfirmMinutes: 95, medianGapMinutes: 0, medianFirstActionMinutes: 7,
  attempts: 61, attemptsPerDecision: 1.8,
  daysPresent: 6, daysLate: 2, totalLateMinutes: 75, avgPresentMinutes: 470, daysWithoutWork: 1, daysLateEstimated: 1,
};
const SUP: TeamRow = { ...ROW, id: 's1', name: 'هدى', role: 'CONFIRMATION_SUPERVISOR', claimed: 9, confirmationRate: null, attemptsPerDecision: null, daysLate: 0, daysLateEstimated: 0, daysWithoutWork: 0 };
const DEFS = { claimed: 'تعريف السحب من الباب', confirmationRate: 'تعريف النسبة من الباب', openNow: 'تعريف المفتوح من الباب' };

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const ANALYTICS = { ordersCount: { total: 1 }, rates: {}, financials: {}, rankings: {}, productStats: [], vitals: { door: { delivered: 0, failed: 0, returned: 0, decided: 0, returnRate: null }, cost: { level: 'WITHHELD' } } };
const SCORE = { window: { start: '', end: '', period: 'WEEKLY' }, bars: { deliveryRate: 0.6, issuesRate: 0.1 }, minSample: 10, roles: [{ role: 'CONFIRMATION_AGENT', ar: 'موظفو التأكيد', people: [{ id: 'a1', name: 'ليلى', rank: 1, of: 1, score: { total: 70, possible: 100, bands: [], sample: 30, minSample: 10, reason: null } }] }] };
const CARD = { person: { id: 'a1', name: 'ليلى', role: 'CONFIRMATION_AGENT' }, window: { start: '', end: '', period: 'MONTHLY' }, bars: { deliveryRate: 0.6, issuesRate: 0.1 }, score: null, rank: null, owed: null, currency: 'USD' };
const CHANNELS = { channels: [], shop: { orders: 0, delivered: 0, collected: 0, withoutChannel: 0, withoutChannelShare: null, collection: { level: 'OK', ar: '' } } };

/** What `team/[userId]` answers; a test overrides it. */
let member: (url: string) => Promise<unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  window.history.replaceState(null, '', '/growth/performance');
  member = async () => ({ employee: ROW, team: {}, window: { start: '2026-11-01T00:00:00', end: '2026-11-07T23:59:59' } });
  apiFetch.mockResolvedValue(json(200, ANALYTICS));
  apiJson.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/orders/confirmation/team/')) return member(url);
    if (url.startsWith('/api/orders/confirmation/team?')) return { employees: [ROW, SUP], totals: null, definitions: DEFS };
    if (url.startsWith('/api/growth/attribution')) return { moderators: [{ id: 'm1', name: 'سامر', kind: 'MODERATOR', brought: 3, confirmed: 2, rejected: 0, decided: 2, delivered: 1, returned: 0, confirmationRate: 100, deliveryRate: 50, revenue: 10, revenuePerOrder: 3 }], channels: [], totals: undefined };
    if (url.startsWith('/api/orders/shipping/performance')) return { providers: [], collection: { level: 'OK' } };
    if (url.startsWith('/api/settings/channels/performance')) return CHANNELS;
    if (url.startsWith('/api/performance/team')) return SCORE;
    if (url.startsWith('/api/performance/card')) return CARD;
    return {};
  });
});
afterEach(cleanup);

const asked = (part: string) => apiJson.mock.calls.map((c) => String(c[0])).filter((u) => u.includes(part));

/** The text of every cell of one person's row, as the table draws it. */
function tableCells(row: TeamRow): string[] {
  const { container, unmount } = render(<TeamPerformanceTable rows={[row]} totals={null} />);
  const tr = [...container.querySelectorAll('tbody tr')].find((r) => r.textContent?.includes(row.name))!;
  const cells = [...tr.querySelectorAll('td')].map((td) => (td.textContent ?? '').replace(/\s+/g, ' ').trim());
  unmount();
  return cells;
}

describe('the drawer — one person, from the same door as the row', () => {
  it('asks team/[userId] with the table’s exact query, and prints the row’s figures exactly as the row does', async () => {
    render(<TeamMemberDrawer person={{ id: 'a1', name: 'ليلى' }} query="startDate=2026-11-01&endDate=2026-11-07" definitions={DEFS} onClose={() => {}} />);
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('سحب');
    expect(asked('/confirmation/team/')).toEqual(['/api/orders/confirmation/team/a1?startDate=2026-11-01&endDate=2026-11-07']);
    // Differential: every figure the drawer prints is the very text of the row's cell, in the same order (the name cell aside).
    const values = rowFigures(ROW).map((f) => f.value);
    expect(values).toEqual(tableCells(ROW).slice(1));
    for (const v of values) expect(dialog.textContent).toContain(v);
    // The door's own words under the figures it defines; the table's hint where the door has none.
    expect(dialog.textContent).toContain('تعريف السحب من الباب');
    expect(dialog.textContent).toContain('تعريف النسبة من الباب');
    expect(dialog.textContent).toContain('مرفوض أو ملغى');
    expect(dialog.textContent).toContain('المدة: 2026-11-01 إلى 2026-11-07');
  });

  it('the score sits under it with its OWN window said beside it, from its own door', async () => {
    render(<TeamMemberDrawer person={{ id: 'a1', name: 'ليلى' }} query="period=all" definitions={null} onClose={() => {}} />);
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('السكور على الأسبوع أو الشهر اللي حدده المالك — ما بيتبع المدة المختارة.');
    await waitFor(() => expect(asked('/api/performance/card')).toEqual(['/api/performance/card?userId=a1']));
    expect(asked('/confirmation/team/')).toEqual(['/api/orders/confirmation/team/a1?period=all']);
  });

  it('NEGATIVE: nobody in the window → the door’s 404 sentence, not a row of zeros', async () => {
    member = async () => {
      throw Object.assign(new Error('ما في شغل مسجّل لهذا الموظف بالمدة المختارة.'), { status: 404 });
    };
    render(<TeamMemberDrawer person={{ id: 'z9', name: 'سلمى' }} query="startDate=2026-11-01&endDate=2026-11-07" onClose={() => {}} />);
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('ما في شغل مسجّل لهذا الموظف بالمدة المختارة.')).toBeTruthy();
    expect(within(dialog).getByText('ما في صف بهالمدة')).toBeTruthy();
    expect(within(dialog).queryByText('سحب')).toBeNull();
    expect(within(dialog).queryByText('إعادة المحاولة')).toBeNull();
  });

  it('NEGATIVE: a refusal → the door’s 403 sentence — never an empty drawer', async () => {
    member = async () => {
      throw Object.assign(new Error('أرقام زميلك للمشرف وحده. أرقامك أنت مفتوحة لك.'), { status: 403 });
    };
    render(<TeamMemberDrawer person={{ id: 'b2', name: 'رنا' }} query="period=all" onClose={() => {}} />);
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('أرقام زميلك للمشرف وحده. أرقامك أنت مفتوحة لك.')).toBeTruthy();
    expect(within(dialog).getByText('هالأرقام مش إلك')).toBeTruthy();
    expect(within(dialog).queryByText('سحب')).toBeNull();
  });

  it('a failure that is not the door’s answer offers a retry, which asks again', async () => {
    let n = 0;
    member = async () => {
      n++;
      if (n === 1) throw new Error('timeout');
      return { employee: ROW, window: { start: null, end: null } };
    };
    render(<TeamMemberDrawer person={{ id: 'a1', name: 'ليلى' }} query="period=all" onClose={() => {}} />);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(await within(dialog).findByText('إعادة المحاولة'));
    expect(await within(dialog).findByText('سحب')).toBeTruthy();
    expect(asked('/confirmation/team/').length).toBe(2);
    expect(dialog.textContent).toContain('المدة: كل المدة');
  });

  it('a span over ninety days: the caption names the window the door answered for, and says it was cut', async () => {
    member = async () => ({ employee: ROW, window: { start: '2026-08-20T00:00:00', end: '2026-11-18T23:59:59' } });
    render(<TeamMemberDrawer person={{ id: 'a1', name: 'ليلى' }} query="startDate=2026-01-01&endDate=2026-11-18" onClose={() => {}} />);
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('سحب');
    expect(dialog.textContent).toContain('المدة: 2026-08-20 إلى 2026-11-18 — المدة أطول من 90 يوم، فالباب قصّها.');
  });

  it('closed, it asks nothing and draws nothing', () => {
    render(<TeamMemberDrawer person={null} query="period=all" onClose={() => {}} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(apiJson).not.toHaveBeenCalled();
  });
});

describe('the table — the same numbers as osm/main, and a name that opens', () => {
  /*
   * The differential: the cells osm/main's table drew for these two rows (taken from `git show osm/main:…TeamPerformanceTable.tsx`
   * rendered with the same rows, 18/11) — the table's numbers do not move by one character.
   */
  const MAIN_CELLS: Record<string, string[]> = {
    a1: ['ليلى', '40', '28', '6', '5', '82%', '7 د', '1 س 35 د', 'أقل من دقيقة', '1.8', '12', '6 (1 بلا شغل)', '2 (1 س 15 د) ≈', '7 س 50 د'],
    s1: ['هدى', '9', '28', '6', '5', '—', '7 د', '1 س 35 د', 'أقل من دقيقة', '—', '12', '6', '0', '7 س 50 د'],
  };

  it('every cell is osm/main’s, with or without the opener', () => {
    expect(tableCells(ROW)).toEqual(MAIN_CELLS.a1);
    expect(tableCells(SUP)).toEqual(MAIN_CELLS.s1);
    const { container } = render(<TeamPerformanceTable rows={[ROW, SUP]} totals={null} onOpen={() => {}} />);
    const rows = [...container.querySelectorAll('tbody tr')].filter((r) => r.querySelectorAll('td').length > 1);
    expect(rows.map((r) => [...r.querySelectorAll('td')].map((td) => (td.textContent ?? '').replace(/\s+/g, ' ').trim()))).toEqual([MAIN_CELLS.a1, MAIN_CELLS.s1]);
  });

  it('the name is a button only when there is a drawer to open; without one it is the plain name', () => {
    const plain = render(<TeamPerformanceTable rows={[ROW]} totals={null} />);
    expect(plain.queryAllByRole('button')).toEqual([]);
    plain.unmount();
    const opened = vi.fn();
    render(<TeamPerformanceTable rows={[ROW]} totals={null} onOpen={opened} />);
    const b = screen.getByRole('button', { name: 'ليلى' });
    expect(b.getAttribute('type')).toBe('button');
    fireEvent.click(b);
    expect(opened).toHaveBeenCalledWith(ROW);
  });
});

describe('the board — one table of the confirmation desk, one drawer for both lists of people', () => {
  /** Tables whose header names a person column: the team's «الموظف» and the attribution tables' «الاسم». */
  const peopleTables = (head: string) => [...document.querySelectorAll('table')].filter((t) => [...t.querySelectorAll('th')].some((th) => th.textContent === head));

  it('the team tab: ONE confirmation-employee table and ONE moderators table — each said why in the PR', async () => {
    render(<PerformanceScreen />);
    await screen.findByRole('button', { name: 'ليلى' });
    expect(peopleTables('الموظف').length, 'جدول موظفي التأكيد').toBe(1);
    // «أداء المودريتورية» is a different population (who ENTERED the order), and it stays its own table.
    expect(screen.getByText('أداء المودريتورية')).toBeTruthy();
    expect(peopleTables('الاسم').some((t) => t.textContent?.includes('سامر'))).toBe(true);
    expect(asked('/api/orders/confirmation/team?')).toEqual(['/api/orders/confirmation/team?startDate=2026-11-18&endDate=2026-11-18']);
  });

  it('a name in the team table opens the drawer, which asks with the table’s exact query', async () => {
    render(<PerformanceScreen />);
    fireEvent.click(await screen.findByRole('button', { name: 'ليلى' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('سحب');
    const tableQuery = asked('/api/orders/confirmation/team?').at(-1)!.split('?')[1];
    expect(asked('/confirmation/team/')).toEqual([`/api/orders/confirmation/team/a1?${tableQuery}`]);
    // the door's definitions reached the drawer from the table's own answer
    expect(dialog.textContent).toContain('تعريف المفتوح من الباب');
  });

  it('after the span moves, the drawer asks the NEW span — still the table’s query', async () => {
    render(<PerformanceScreen />);
    await screen.findByRole('button', { name: 'ليلى' });
    fireEvent.click(screen.getByRole('button', { name: /^المدة/ }));
    await waitFor(() => expect(asked('/api/orders/confirmation/team?').at(-1)).toBe('/api/orders/confirmation/team?startDate=2026-11-01&endDate=2026-11-07'));
    fireEvent.click(await screen.findByRole('button', { name: 'ليلى' }));
    await screen.findByRole('dialog');
    await waitFor(() => expect(asked('/confirmation/team/')).toEqual(['/api/orders/confirmation/team/a1?startDate=2026-11-01&endDate=2026-11-07']));
  });

  it('«سكور الموظفين» keeps its own tab, says its own window, and its names open the SAME drawer', async () => {
    window.history.replaceState(null, '', '/growth/performance?tab=scores');
    render(<PerformanceScreen />);
    expect(await screen.findByText('السكور على الأسبوع اللي حدده المالك — ما بيتبع المدة المختارة فوق.')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'سكور الموظفين' }).getAttribute('aria-selected')).toBe('true');
    expect(peopleTables('الموظف').length, 'جدول السكور وحده على تبويبه').toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'ليلى' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('سحب');
    expect(asked('/confirmation/team/')).toEqual(['/api/orders/confirmation/team/a1?startDate=2026-11-18&endDate=2026-11-18']);
  });

  it('the doors that take no window say theirs beside their numbers', async () => {
    render(<PerformanceScreen />);
    expect(await screen.findByText('كل التاريخ — ما بتتبع المدة المختارة فوق.')).toBeTruthy();
    expect(await screen.findByText('آخر 90 يوم — ما بتتبع المدة المختارة فوق.')).toBeTruthy();
  });
});

describe('the shared range on the board', () => {
  it('the address wins over the stored key', async () => {
    sessionStorage.setItem(REPORT_RANGE_KEY, JSON.stringify({ from: '2026-10-01', to: '2026-10-05' }));
    window.history.replaceState(null, '', '/growth/performance?from=2026-09-01&to=2026-09-03');
    render(<PerformanceScreen />);
    await waitFor(() => expect(asked('/api/orders/confirmation/team?').at(-1)).toBe('/api/orders/confirmation/team?startDate=2026-09-01&endDate=2026-09-03'));
  });

  it('the stored key wins over today', async () => {
    sessionStorage.setItem(REPORT_RANGE_KEY, JSON.stringify({ from: '2026-10-01', to: '2026-10-05' }));
    render(<PerformanceScreen />);
    await waitFor(() => expect(asked('/api/orders/confirmation/team?').at(-1)).toBe('/api/orders/confirmation/team?startDate=2026-10-01&endDate=2026-10-05'));
    expect(String(apiFetch.mock.calls.at(-1)?.[0])).toBe('/api/analytics/performance?startDate=2026-10-01&endDate=2026-10-05');
  });

  it('nothing stored → today, the board’s own', async () => {
    render(<PerformanceScreen />);
    await screen.findByRole('button', { name: 'ليلى' });
    expect(asked('/api/orders/confirmation/team?')).toEqual(['/api/orders/confirmation/team?startDate=2026-11-18&endDate=2026-11-18']);
  });

  it('a change is written to the one key — and an address that carried a range follows it', async () => {
    window.history.replaceState(null, '', '/growth/performance?tab=scores&from=2026-09-01&to=2026-09-03');
    render(<PerformanceScreen />);
    await screen.findByText(/السكور على الأسبوع/);
    fireEvent.click(screen.getByRole('button', { name: /^المدة/ }));
    expect(JSON.parse(sessionStorage.getItem(REPORT_RANGE_KEY)!)).toEqual({ from: '2026-11-01', to: '2026-11-07' });
    expect(window.location.search).toBe('?tab=scores&from=2026-11-01&to=2026-11-07');
  });

  it('NEGATIVE: a storage that throws is today, and nothing crashes', async () => {
    const spy = vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      render(<PerformanceScreen />);
      await screen.findByRole('button', { name: 'ليلى' });
      expect(asked('/api/orders/confirmation/team?')).toEqual(['/api/orders/confirmation/team?startDate=2026-11-18&endDate=2026-11-18']);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /^المدة/ }));
      });
      await waitFor(() => expect(asked('/api/orders/confirmation/team?').at(-1)).toBe('/api/orders/confirmation/team?startDate=2026-11-01&endDate=2026-11-07'));
    } finally {
      spy.mockRestore();
    }
  });

  it('`?tab=noanswer` still opens its tab, with no date box (it carries its own)', async () => {
    window.history.replaceState(null, '', '/growth/performance?tab=noanswer');
    render(<PerformanceScreen />);
    expect(await screen.findByText('شاشة لا رد')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^المدة/ })).toBeNull();
  });
});

describe('the source — one door for the table, no arithmetic over two', () => {
  const src = stripComments(readFileSync(join(process.cwd(), 'src/components/screens/PerformanceScreen.tsx'), 'utf8'));
  const drawer = stripComments(readFileSync(join(process.cwd(), 'src/components/performance/TeamMemberDrawer.tsx'), 'utf8'));

  it('the drawer reads only its two doors, and the screen hands it the table’s own query', () => {
    expect(drawer.match(/apiJson|apiFetch|fetch\(/g)).toEqual(['apiJson', 'apiJson']); // the import and the one call
    expect(drawer).toContain('`/api/orders/confirmation/team/${encodeURIComponent(person.id)}?${query}`');
    expect(src).toContain('<TeamMemberDrawer person={opened} query={dateQuery}');
    expect(src).toContain('`/api/orders/confirmation/team?${dateQuery}`');
  });

  it('a phone: the drawer is the kit sheet (no fixed width of its own) and the wide tables scroll inside their card', () => {
    expect(drawer).toContain('<Modal');
    expect(drawer).not.toMatch(/\b(min-)?w-\[\d+px\]/);
    const table = readFileSync(join(process.cwd(), 'src/components/performance/TeamPerformanceTable.tsx'), 'utf8');
    expect(table).toContain('overflow-x-auto');
  });
});
