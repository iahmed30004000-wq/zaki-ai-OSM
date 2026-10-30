import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE TWO TEAM TABLES ON THE CONFIRMATION DESK ASK ONE KEY (perm-plan PR-10): `team.monitor`.
 *
 * `GET /api/orders/confirmation/team` (everybody's numbers) and `GET /api/orders/confirmation/performance?employeeId=`
 * (somebody else's numbers) read `users.view` OR three role NAMES, so the owner could not give a person the people list and
 * keep the scoreboard from them, and a role that was not on the list of names could never be given the table. They ask
 * `team.monitor` now — the key the team scoreboard already asks. The migration 20261030170000_costs_insights_keys gave it
 * to everybody who passed either door, and the replay of that migration is `the-visibility-keys-keep-every-door.test.ts`.
 *
 * What is asked here is the REFUSAL: a role name opens nothing any more, `users.view` opens nothing any more, and the
 * refusal comes before anything is read. Your OWN numbers need nothing.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, teamPerformance, attendance, held } = vi.hoisted(() => ({
  db: {
    user: { findMany: vi.fn() },
    order: { count: vi.fn() },
    orderContactAttempt: { count: vi.fn() },
    orderStatusLog: { count: vi.fn() },
  },
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

import { GET as TEAM } from './team/route';
import { GET as ONE } from './performance/route';

const COUNTRY = { workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5], timezone: 'Asia/Amman' };
const as = (role: string, ...keys: string[]) => {
  held.keys = keys;
  requireContext.mockResolvedValue({ user: { id: 'me', role }, companyId: 'c1', storeId: 's1', country: COUNTRY });
};
const team = () => TEAM(new Request('http://x/api/orders/confirmation/team?period=all'));
const one = (id: string) => ONE(new Request(`http://x/api/orders/confirmation/performance?employeeId=${id}`));

beforeEach(() => {
  vi.clearAllMocks();
  held.keys = [];
  teamPerformance.mockResolvedValue({ employees: [{ id: 'e1', claimed: 3, decided: 2, confirmed: 2, rejected: 0, noAnswer: 0, openNow: 1, medianConfirmMinutes: 4, confirmationRate: 100 }], totals: {} });
  attendance.mockResolvedValue(new Map());
  db.user.findMany.mockResolvedValue([]);
  db.order.count.mockResolvedValue(0);
  db.orderContactAttempt.count.mockResolvedValue(0);
  db.orderStatusLog.count.mockResolvedValue(0);
});

describe('the table of the whole team', () => {
  it('opens with team.monitor — whatever the role is called', async () => {
    as('SOME_CUSTOM_ROLE', 'team.monitor');
    const res = await team();
    expect(res.status).toBe(200);
    expect((await res.json()).employees).toHaveLength(1);
  });

  it('NEGATIVE: users.view alone opens nothing any more, and nothing is read on the way to the refusal', async () => {
    as('MODERATOR', 'users.view');
    const res = await team();
    expect(res.status).toBe(403);
    expect(teamPerformance).not.toHaveBeenCalled();
    expect(db.user.findMany).not.toHaveBeenCalled();
  });

  it('NEGATIVE: the three role NAMES open nothing any more — a manager, a company admin, a super admin without the key', async () => {
    for (const role of ['MANAGER', 'COMPANY_ADMIN', 'SUPER_ADMIN']) {
      as(role);
      expect((await team()).status, role).toBe(403);
    }
    expect(teamPerformance).not.toHaveBeenCalled();
  });

  it('the refusal says so in Arabic (the English `error` is the old one — this change adds no new English refusal)', async () => {
    as('MANAGER');
    const body = await (await team()).json();
    expect(body.errorAr).toMatch(/[؀-ۿ]/);
  });
});

describe('somebody else’s numbers', () => {
  it('open with team.monitor', async () => {
    as('SOME_CUSTOM_ROLE', 'team.monitor');
    expect((await one('e1')).status).toBe(200);
  });

  it('NEGATIVE: users.view alone, and the three role names, open nothing any more', async () => {
    as('MODERATOR', 'users.view');
    expect((await one('e1')).status).toBe(403);
    for (const role of ['MANAGER', 'COMPANY_ADMIN', 'SUPER_ADMIN']) {
      as(role);
      expect((await one('e1')).status, role).toBe(403);
    }
    expect(teamPerformance).not.toHaveBeenCalled();
  });

  it('your OWN numbers need nothing at all — by default and by naming yourself', async () => {
    as('CONFIRMATION_AGENT');
    expect((await ONE(new Request('http://x/api/orders/confirmation/performance'))).status).toBe(200);
    expect((await one('me')).status).toBe(200);
  });
});
