import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «القياس كل أسبوع» (`?part=weekly`, request C3) OPENS WITH THE SAME KEY AS THE REST OF THE TAB, SAYS THE SAME REFUSAL, AND TOUCHES NOTHING BEFORE IT.
 *
 * `team.monitor`, the team table's own words — no new key, no new door. The company, the store and the calendar are the session's; the
 * week is `this` unless the query says `last`. The part is its own question: it never reads the board, the report, the flow or the
 * measurement, and none of them reads it — their answers are what they were.
 */

const { requireContext, board, report, flow, measure, weekly, held, touched } = vi.hoisted(() => ({
  requireContext: vi.fn(),
  board: vi.fn(),
  report: vi.fn(),
  flow: vi.fn(),
  measure: vi.fn(),
  weekly: vi.fn(),
  held: { keys: [] as string[] },
  touched: [] as string[],
}));

vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ can: (_u: unknown, k: string) => held.keys.includes(k) }));
// A database that records every touch: the refusal must come before any of them.
vi.mock('@/lib/db', () => ({
  db: new Proxy({}, { get: (_t, k) => (typeof k === 'string' && k !== 'then' ? (touched.push(k), {}) : undefined) }),
}));
vi.mock('@/lib/no-answer-watch', () => ({
  FRESH_NEW_HOURS: 2,
  REPORT_DEFAULT_DAYS: 14,
  STUCK_BUSINESS_DAYS: 2,
  noAnswerBoard: (...a: unknown[]) => board(...a),
  answerRateReport: (...a: unknown[]) => report(...a),
}));
vi.mock('@/lib/held-flow-read', () => ({ heldFlow: (...a: unknown[]) => flow(...a) }));
vi.mock('@/lib/no-answer-measure', () => ({ readMeasure: (...a: unknown[]) => measure(...a) }));
vi.mock('@/lib/weekly-measures-read', () => ({ weeklyMeasures: (...a: unknown[]) => weekly(...a) }));

import { GET } from './route';

const COUNTRY = { workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6], timezone: 'Asia/Amman' };
const as = (role: string, ...keys: string[]) => {
  held.keys = keys;
  requireContext.mockResolvedValue({ user: { id: 'me', role }, companyId: 'c1', storeId: 's1', country: COUNTRY });
};
const get = (q = '') => GET(new Request(`http://x/api/orders/confirmation/no-answer${q}`));

const WEEKLY = { figures: { truncated: false }, tiles: [{ key: 'firstCall' }], checks: [], truncated: false };
const WINDOW = {
  week: 'this',
  start: new Date('2026-11-10T21:00:00.000Z'),
  end: new Date('2026-11-17T21:00:00.000Z'),
  fromDay: '2026-11-11',
  toDay: '2026-11-17',
  timezone: 'Asia/Amman',
};

beforeEach(() => {
  vi.clearAllMocks();
  touched.length = 0;
  board.mockResolvedValue({ agents: [], totals: {}, team: {}, truncated: false });
  report.mockResolvedValue({ byHour: [], byAttempt: [], total: {}, numbering: { mode: 'CALLS', fromDay: null }, truncated: false });
  flow.mockResolvedValue({ window: { key: '24h' } });
  measure.mockResolvedValue({ rows: [], rule: 'قاعدة', thresholds: [30] });
  weekly.mockImplementation(async (a: { week: string }) => ({ weekly: WEEKLY, window: { ...WINDOW, week: a.week } }));
});

describe('who opens it', () => {
  it('team.monitor: 200 with { weekly, window } and nothing else; the session’s company, store and calendar', async () => {
    as('SOME_CUSTOM_ROLE', 'team.monitor');
    const res = await get('?part=weekly&companyId=evil&storeId=evil');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(['weekly', 'window']);
    expect(body.weekly).toEqual(WEEKLY);
    expect(body.window).toEqual({
      week: 'this',
      start: '2026-11-10T21:00:00.000Z',
      end: '2026-11-17T21:00:00.000Z',
      fromDay: '2026-11-11',
      toDay: '2026-11-17',
      timezone: 'Asia/Amman',
      words: 'آخر 7 أيام: من 2026-11-11 لـ 2026-11-17',
    });
    expect(weekly).toHaveBeenCalledTimes(1);
    expect(weekly.mock.calls[0][0]).toMatchObject({ companyId: 'c1', storeId: 's1', week: 'this', calendar: COUNTRY });
    for (const other of [board, report, flow, measure]) expect(other).not.toHaveBeenCalled();
  });

  it('`week=last` asks for the week before; anything else is this week', async () => {
    as('MANAGER', 'team.monitor');
    await get('?part=weekly&week=last');
    await get('?part=weekly&week=whatever');
    expect(weekly.mock.calls.map((c) => (c[0] as { week: string }).week)).toEqual(['last', 'this']);
  });

  it('NEGATIVE: without the key — the team table’s refusal, the reader never called and the database never touched', async () => {
    for (const [role, keys] of [['CONFIRMATION_AGENT', ['confirmation.work']], ['MANAGER', ['users.view']], ['SUPER_ADMIN', []]] as const) {
      as(role, ...keys);
      const res = await get('?part=weekly');
      expect(res.status, role).toBe(403);
      expect((await res.json()).errorAr).toBe('أداء الفريق للمشرف وحده.');
    }
    expect(weekly).not.toHaveBeenCalled();
    expect(touched).toEqual([]);
  });
});

describe('the other parts answer as before', () => {
  it('board, report, flow and measure never read the weekly part, and their bodies keep main’s keys', async () => {
    as('MANAGER', 'team.monitor');
    const q = '&startDate=2026-11-01&endDate=2026-11-05';
    const keys = async (part: string) => Object.keys(await (await get(`?part=${part}${q}`)).json()).sort();
    expect(await keys('board')).toEqual(['board', 'rules', 'window']);
    expect(await keys('report')).toEqual(['report', 'rules', 'window']);
    expect(await keys('flow')).toEqual(['flow']);
    expect(await keys('measure')).toEqual(['measure', 'window']);
    expect(weekly).not.toHaveBeenCalled();
  });

  it('the report is handed the country’s calendar (the plan numbers the attempts with it) and passed through as it came', async () => {
    as('MANAGER', 'team.monitor');
    const body = await (await get('?part=report')).json();
    expect(report.mock.calls[0][0]).toMatchObject({ companyId: 'c1', storeId: 's1', timezone: 'Asia/Amman', calendar: COUNTRY });
    expect(body.report).toEqual({ byHour: [], byAttempt: [], total: {}, numbering: { mode: 'CALLS', fromDay: null }, truncated: false });
  });
});
