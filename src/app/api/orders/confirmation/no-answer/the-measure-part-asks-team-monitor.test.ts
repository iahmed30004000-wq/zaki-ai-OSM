import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «قياس ما ردّ» (`?part=measure`, step G1) OPENS WITH THE SAME KEY AS THE REST OF THE TAB, SAYS THE SAME REFUSAL, AND READS NOTHING BEFORE IT.
 *
 * `team.monitor`, the team table's own words — no new key. The company and the store are the session's, the dates are the report's (default fourteen days), and the part
 * is its own question: it never reads the board or the report, and neither of them reads it.
 */

const { requireContext, board, report, measure, held } = vi.hoisted(() => ({
  requireContext: vi.fn(),
  board: vi.fn(),
  report: vi.fn(),
  measure: vi.fn(),
  held: { keys: [] as string[] },
}));

vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ can: (_u: unknown, k: string) => held.keys.includes(k) }));
vi.mock('@/lib/db', () => ({ db: { marker: 'db' } }));
vi.mock('@/lib/no-answer-watch', () => ({
  FRESH_NEW_HOURS: 2,
  REPORT_DEFAULT_DAYS: 14,
  STUCK_BUSINESS_DAYS: 2,
  noAnswerBoard: (...a: unknown[]) => board(...a),
  answerRateReport: (...a: unknown[]) => report(...a),
}));
vi.mock('@/lib/no-answer-measure', () => ({ readMeasure: (...a: unknown[]) => measure(...a) }));

import { GET } from './route';

const COUNTRY = { workHoursStart: '10:00', workHoursEnd: '22:00', weekendDays: [], timezone: 'Asia/Damascus' };
const as = (role: string, ...keys: string[]) => {
  held.keys = keys;
  requireContext.mockResolvedValue({ user: { id: 'me', role }, companyId: 'c1', storeId: 's1', country: COUNTRY });
};
const get = (q = '') => GET(new Request(`http://x/api/orders/confirmation/no-answer${q}`));

beforeEach(() => {
  vi.clearAllMocks();
  measure.mockResolvedValue({ rows: [], rule: 'قاعدة', thresholds: [30, 60, 120] });
});

describe('the measurement part', () => {
  it('team.monitor opens it: the reader gets the session\'s company and store, the store\'s timezone and a fourteen-day window; nothing else is read', async () => {
    as('SOME_CUSTOM_ROLE', 'team.monitor');
    const res = await get('?part=measure');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.measure).toEqual({ rows: [], rule: 'قاعدة', thresholds: [30, 60, 120] });
    expect(body.window.timezone).toBe('Asia/Damascus');
    const [client, scope] = measure.mock.calls[0] as [unknown, { companyId: string; storeId: string; start: Date; end: Date; timezone: string }];
    expect(client).toEqual({ marker: 'db' });
    expect(scope).toMatchObject({ companyId: 'c1', storeId: 's1', timezone: 'Asia/Damascus' });
    expect(Math.round((scope.end.getTime() - scope.start.getTime()) / 86_400_000)).toBe(14);
    expect(board).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
  });

  it('asked dates become the window; a company or store in the query string is ignored', async () => {
    as('MANAGER', 'team.monitor');
    await get('?part=measure&startDate=2026-11-01&endDate=2026-11-05&companyId=evil&storeId=evil');
    const scope = measure.mock.calls[0][1] as { companyId: string; storeId: string; start: Date; end: Date };
    expect(scope.companyId).toBe('c1');
    expect(scope.storeId).toBe('s1');
    expect(scope.start.getTime()).toBeLessThan(scope.end.getTime());
  });

  it('NEGATIVE: without the key — the team table\'s refusal, and not one question asked', async () => {
    for (const [role, keys] of [['CONFIRMATION_AGENT', ['confirmation.work']], ['MANAGER', ['users.view']], ['SUPER_ADMIN', []]] as const) {
      as(role, ...keys);
      const res = await get('?part=measure');
      expect(res.status, role).toBe(403);
      expect((await res.json()).errorAr).toBe('أداء الفريق للمشرف وحده.');
    }
    expect(measure).not.toHaveBeenCalled();
  });

  it('the board and the report parts never read the measurement', async () => {
    as('MANAGER', 'team.monitor');
    board.mockResolvedValue({ agents: [] });
    report.mockResolvedValue({ byHour: [] });
    await get('?part=board');
    await get('?part=report');
    expect(measure).not.toHaveBeenCalled();
  });
});
