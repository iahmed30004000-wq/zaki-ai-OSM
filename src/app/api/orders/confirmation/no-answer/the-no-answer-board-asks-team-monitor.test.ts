import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «لا رد والطلبات المحجوزة» OPENS WITH THE TEAM TABLE'S KEY, AND SAYS THE TEAM TABLE'S REFUSAL.
 *
 * `team.monitor` — the key `GET /api/orders/confirmation/team` asks (PR-10). No new key: the same people read both.
 * Without it the refusal comes before anything is read. With it the company and store are the session's own, never
 * the query string's, and the report's window defaults to the last fourteen days.
 */

const { requireContext, board, report, held } = vi.hoisted(() => ({
  requireContext: vi.fn(),
  board: vi.fn(),
  report: vi.fn(),
  held: { keys: [] as string[] },
}));

vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ can: (_u: unknown, k: string) => held.keys.includes(k) }));
vi.mock('@/lib/no-answer-watch', () => ({
  FRESH_NEW_HOURS: 2,
  REPORT_DEFAULT_DAYS: 14,
  STUCK_BUSINESS_DAYS: 2,
  noAnswerBoard: (...a: unknown[]) => board(...a),
  answerRateReport: (...a: unknown[]) => report(...a),
}));

import { GET } from './route';

const COUNTRY = { workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6], timezone: 'Asia/Amman' };
const as = (role: string, ...keys: string[]) => {
  held.keys = keys;
  requireContext.mockResolvedValue({ user: { id: 'me', role }, companyId: 'c1', storeId: 's1', country: COUNTRY });
};
const get = (q = '') => GET(new Request(`http://x/api/orders/confirmation/no-answer${q}`));

beforeEach(() => {
  vi.clearAllMocks();
  board.mockResolvedValue({ agents: [], totals: {}, team: {}, truncated: false });
  report.mockResolvedValue({ byHour: [], byAttempt: [], total: {}, truncated: false });
});

describe('who opens it', () => {
  it('team.monitor opens it, whatever the role is called', async () => {
    as('SOME_CUSTOM_ROLE', 'team.monitor');
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ board: { agents: [] }, report: { byHour: [] } });
  });

  it('NEGATIVE: without it — the team table’s refusal, and nothing is read on the way', async () => {
    for (const [role, keys] of [['CONFIRMATION_AGENT', ['confirmation.supervise', 'confirmation.work']], ['MANAGER', ['users.view']], ['SUPER_ADMIN', []]] as const) {
      as(role, ...keys);
      const res = await get();
      expect(res.status, role).toBe(403);
      expect((await res.json()).errorAr).toBe('أداء الفريق للمشرف وحده.');
    }
    expect(board).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
  });
});

describe('what it is asked about', () => {
  it('the session’s company and store, never the query string’s', async () => {
    as('MANAGER', 'team.monitor');
    await get('?storeId=s9&companyId=c9');
    expect(board.mock.calls[0][0]).toMatchObject({ companyId: 'c1', storeId: 's1', calendar: COUNTRY });
    expect(report.mock.calls[0][0]).toMatchObject({ companyId: 'c1', storeId: 's1', timezone: 'Asia/Amman' });
  });

  it('?part=report reads the report only — moving the dates never recomputes the board', async () => {
    as('MANAGER', 'team.monitor');
    const body = await (await get('?part=report&startDate=2026-09-01&endDate=2026-09-03')).json();
    expect(board).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledTimes(1);
    expect(body.board).toBeUndefined();
    expect(body.report).toBeDefined();
  });

  it('?part=board reads the board only', async () => {
    as('MANAGER', 'team.monitor');
    const body = await (await get('?part=board')).json();
    expect(report).not.toHaveBeenCalled();
    expect(board).toHaveBeenCalledTimes(1);
    expect(body.report).toBeUndefined();
    expect(body.board).toBeDefined();
  });

  it('no dates: the last fourteen days, today included', async () => {
    as('MANAGER', 'team.monitor');
    await get();
    const { start, end } = report.mock.calls[0][0] as { start: Date; end: Date };
    const days = Math.round((end.getTime() - start.getTime()) / 86_400_000);
    expect(days).toBe(14);
    expect(end.getTime()).toBeGreaterThanOrEqual(Date.now());
  });

  it('picked dates are whole local days', async () => {
    as('MANAGER', 'team.monitor');
    await get('?startDate=2026-09-01&endDate=2026-09-03');
    const { start, end } = report.mock.calls[0][0] as { start: Date; end: Date };
    expect([start.getDate(), start.getHours(), end.getDate(), end.getHours()]).toEqual([1, 0, 3, 23]);
  });
});
