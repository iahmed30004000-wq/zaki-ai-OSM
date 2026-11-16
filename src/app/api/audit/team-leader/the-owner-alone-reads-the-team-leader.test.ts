import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * ═════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — ONLY THE OWNER READS THE TEAM LEADER (step H2)
 *
 *  1. A hard 403 with an Arabic sentence for EVERYBODY who is not the owner — the team leader herself, a supervisor, a company admin, an accountant — and it is asked FIRST: nothing
 *     is read before it (no context, no database).
 *  2. The check is on the ACCOUNT (`SUPER_ADMIN`), not on a key somebody can be ticked with: holding every permission key does not open it.
 *  3. The owner gets her submitted figures against the system's (frozen when she sent them) with the variance, her action log of the day, and a sample of ten rejected orders.
 *  4. No customer name, phone or address leaves the door; read only.
 * ═════════════════════════════════════════════════════════════════
 */
const { requireAuth, requireContext, db, sample } = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  requireContext: vi.fn(async () => ({ companyId: 'c1', storeId: 's1', country: { code: 'SY', timezone: 'UTC' } })),
  sample: vi.fn(async (..._a: unknown[]) => [{ orderId: 'o1', orderNumber: 'ORD-1', reason: 'FAKE_ORDER', reasonAr: 'طلب وهميّ', agent: 'سارة', phoneValid: false }]),
  db: {
    user: { findMany: vi.fn(async () => [{ id: 'dalia', name: 'داليا' }]) },
    confirmationEodReport: { findUnique: vi.fn(async () => null as unknown) },
    auditLog: { findMany: vi.fn(async () => [{ action: 'ORDER_TRANSFERRED', entity: 'Order', entityId: 'o1', createdAt: new Date('2026-11-10T09:00:00Z') }]) },
  },
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/auth', () => ({ requireAuth: () => requireAuth() }));
vi.mock('@/lib/geo-context', () => ({ requireContext: () => requireContext() }));
vi.mock('@/lib/eod-report', async (orig) => ({ ...((await orig()) as object), sampleRejected: (...a: unknown[]) => sample(...a) }));

import { GET } from './route';

const as = (role: string, status = 'ACTIVE') => requireAuth.mockResolvedValue({ id: 'u', role, status });
const get = (q = '?day=2026-11-10') => GET(new Request(`http://x/api/audit/team-leader${q}`));

beforeEach(() => {
  vi.clearAllMocks();
  as('SUPER_ADMIN');
  db.confirmationEodReport.findUnique.mockResolvedValue(null);
});

describe('who may read it', () => {
  it.each(['TEAM_LEADER', 'CONFIRMATION_SUPERVISOR', 'COMPANY_ADMIN', 'MANAGER', 'ACCOUNTANT', 'CONFIRMATION_AGENT'])('%s gets a 403 in Arabic and nothing is read', async (role) => {
    as(role);
    const res = await get();
    expect(res.status).toBe(403);
    expect((await res.json()).errorAr).toMatch(/[؀-ۿ]/);
    expect(requireContext).not.toHaveBeenCalled();
    expect(db.user.findMany).not.toHaveBeenCalled();
    expect(db.auditLog.findMany).not.toHaveBeenCalled();
    expect(sample).not.toHaveBeenCalled();
  });

  it('is asked of the account, not of a key: a person with every permission but not the owner is refused too', async () => {
    requireAuth.mockResolvedValue({ id: 'u', role: 'COMPANY_ADMIN', status: 'ACTIVE', permissions: ['*', 'audit.view', 'team.monitor', 'payroll.view'] });
    expect((await get()).status).toBe(403);
    const src = readFileSync('src/app/api/audit/team-leader/route.ts', 'utf8');
    expect(src).toContain('userHasFullAccess(user)');
    expect(src).not.toContain('requirePermission');
  });

  it('the owner gets in', async () => {
    expect((await get()).status).toBe(200);
  });
});

describe('what the owner reads', () => {
  it('with no report: the leader, her action log of the day and the sample; the report is null', async () => {
    const body = await (await get()).json();
    expect(body.day).toBe('2026-11-10');
    expect(body.leader).toEqual({ id: 'dalia', name: 'داليا' });
    expect(body.report).toBeNull();
    expect(body.actions).toHaveLength(1);
    expect(body.sample).toEqual([{ orderId: 'o1', orderNumber: 'ORD-1', reason: 'FAKE_ORDER', reasonAr: 'طلب وهميّ', agent: 'سارة', phoneValid: false }]);
    const where = (db.auditLog.findMany.mock.calls[0] as unknown as [{ where: Record<string, any> }])[0].where;
    expect(where).toMatchObject({ companyId: 'c1', userId: 'dalia' });
    expect(where.createdAt.gte.toISOString()).toBe('2026-11-10T00:00:00.000Z');
    expect(where.createdAt.lt.toISOString()).toBe('2026-11-11T00:00:00.000Z');
  });

  it('with a report: her figures against the frozen system numbers, with the variance', async () => {
    db.confirmationEodReport.findUnique.mockResolvedValue({
      submittedAt: new Date('2026-11-10T20:00:00Z'),
      payload: { agents: [{ userId: 'u1', claims: 12, confirmed: 3, rejected: 1, noAnswer: 4, winback: 0, stuck: 0 }], biggestProblem: 'ازدحام', tip: 'ابدأوا بالمتأخر' },
      system: [{ userId: 'u1', name: 'سارة', claims: 10, confirmed: 3, rejected: 1, noAnswer: 4, winback: 0, stuck: 0, rejectedByReason: {}, winbackConverted: 0 }],
    });
    const body = await (await get()).json();
    expect(body.report.biggestProblem).toBe('ازدحام');
    expect(body.report.tip).toBe('ابدأوا بالمتأخر');
    expect(body.report.comparison[0].metrics.claims).toEqual({ percent: 20, submitted: 12, system: 10 });
    expect(body.report.comparison[0].metrics.confirmed.percent).toBe(0);
  });

  it('reads the report of the leader asked for, within this company and store', async () => {
    db.user.findMany.mockResolvedValueOnce([{ id: 'a', name: 'أ' }, { id: 'b', name: 'ب' }]);
    await get('?day=2026-11-10&leaderId=b');
    const key = (db.confirmationEodReport.findUnique.mock.calls[0] as unknown as [{ where: { companyId_storeId_day_userId: Record<string, string> } }])[0].where.companyId_storeId_day_userId;
    expect(key).toEqual({ companyId: 'c1', storeId: 's1', day: '2026-11-10', userId: 'b' });
  });

  it('a day that is not a day is refused; nobody holding the role is an answer, not an error', async () => {
    expect((await get('?day=nonsense')).status).toBe(400);
    db.user.findMany.mockResolvedValueOnce([]);
    const body = await (await get()).json();
    expect(body.leader).toBeNull();
    expect(body.report).toBeNull();
    expect(body.actions).toEqual([]);
  });

  it('carries no customer field and writes nothing', () => {
    // comments aside: the header's prose says what the door does NOT carry
    const src = readFileSync('src/app/api/audit/team-leader/route.ts', 'utf8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.trim().startsWith('/*'))
      .join('\n');
    expect(src).not.toMatch(/\.(create|update|upsert|delete)\w*\(/);
    expect(src).not.toMatch(/customer|rawPhone|address/i);
    expect(src).not.toMatch(/export async function (POST|PUT|PATCH|DELETE)/);
  });
});
