import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE DRAWER OF ONE PERSON SAYS WHAT THE ROW OF THE TABLE SAYS (plan 17/11, R14a).
 *
 * `GET /api/orders/confirmation/team/[userId]` takes the person out of the SAME answer the table is made from
 * (`lib/confirmation-team-answer.ts`). What is held here: (1) the row of the drawer equals the row of the table for the same days —
 * if the two ever read different sources this is the test that parts; (2) your own row needs no key and somebody else's needs
 * `team.monitor`, the refusal before anything is read; (3) only the one row leaves, never the team's; (4) a person with no work in the
 * window is a 404 with a sentence, not a row of invented zeros.
 */

const { db, requireContext, teamPerformance, attendance, held } = vi.hoisted(() => ({
  db: { user: { findMany: vi.fn() } },
  requireContext: vi.fn(),
  teamPerformance: vi.fn(),
  attendance: vi.fn(),
  held: { keys: [] as string[] },
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ can: (_u: unknown, k: string) => held.keys.includes(k) }));
vi.mock('@/lib/team-performance', () => ({ teamPerformance: (...a: unknown[]) => teamPerformance(...a) }));
vi.mock('@/lib/attendance', () => ({ attendance: (...a: unknown[]) => attendance(...a) }));

import { GET as ONE } from './route';
import { GET as TEAM } from '../route';

const COUNTRY = { workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5], timezone: 'Asia/Amman' };
const QUERY = 'period=7d';
const as = (id: string, ...keys: string[]) => {
  held.keys = keys;
  requireContext.mockResolvedValue({ user: { id, role: 'CONFIRMATION_AGENT' }, companyId: 'c1', storeId: 's1', country: COUNTRY });
};
const one = (id: string) => ONE(new Request(`http://x/api/orders/confirmation/team/${id}?${QUERY}`), { params: Promise.resolve({ userId: id }) });
const team = () => TEAM(new Request(`http://x/api/orders/confirmation/team?${QUERY}`));

const row = (id: string, claimed: number) => ({
  id, name: id, role: 'CONFIRMATION_AGENT', claimed, confirmed: claimed - 1, rejected: 1, noAnswer: 0, decided: claimed, openNow: 2,
  confirmationRate: 70, medianConfirmMinutes: 6, medianGapMinutes: 9, medianFirstActionMinutes: 3, attempts: 5, attemptsPerDecision: 1.2,
});

beforeEach(() => {
  vi.clearAllMocks();
  held.keys = [];
  teamPerformance.mockResolvedValue({
    employees: [row('e1', 10), row('e2', 4)],
    totals: { claimed: 14, confirmed: 12, rejected: 2, decided: 14, confirmationRate: 86, medianConfirmMinutes: 6 },
  });
  attendance.mockResolvedValue(new Map([['e1', { daysPresent: 5, daysLate: 1, totalLateMinutes: 20, avgPresentMinutes: 400, daysWithoutWork: 0, daysLateEstimated: 0 }]]));
  db.user.findMany.mockResolvedValue([]);
});

describe('the drawer of one person', () => {
  it('is the same row as the table for the same days — figure for figure, attendance included', async () => {
    as('boss', 'team.monitor');
    const fromTable = (await (await team()).json()).employees.find((e: { id: string }) => e.id === 'e1');
    const fromDrawer = (await (await one('e1')).json()).employee;
    expect(fromDrawer).toEqual(fromTable);
    expect(fromDrawer).toMatchObject({ claimed: 10, daysPresent: 5, daysLate: 1 });
  });

  it('sends only that person’s row, with the whole desk’s totals beside it', async () => {
    as('boss', 'team.monitor');
    const body = await (await one('e2')).json();
    expect(Object.keys(body).sort()).toEqual(['employee', 'team', 'window']);
    expect(body.employee.id).toBe('e2');
    expect(body.team.claimed).toBe(14);
    expect(body.window.start).toBeTruthy();
  });

  it('your OWN row needs no key', async () => {
    as('e1');
    const res = await one('e1');
    expect(res.status).toBe(200);
    expect((await res.json()).employee.id).toBe('e1');
  });

  it('NEGATIVE: somebody else’s row without team.monitor is a 403, and nothing is read on the way to it', async () => {
    as('e2', 'users.view');
    const res = await one('e1');
    expect(res.status).toBe(403);
    expect(teamPerformance).not.toHaveBeenCalled();
    expect(attendance).not.toHaveBeenCalled();
  });

  it('NEGATIVE: asking for your own row never lets a colleague’s leave with it', async () => {
    as('e1');
    const text = JSON.stringify(await (await one('e1')).json());
    expect(text).not.toContain('"e2"');
  });

  it('a person with no work in the window is a 404 with a sentence, not a row of zeros', async () => {
    as('boss', 'team.monitor');
    const res = await one('ghost');
    expect(res.status).toBe(404);
    expect((await res.json()).errorAr).toMatch(/[؀-ۿ]/);
  });
});
