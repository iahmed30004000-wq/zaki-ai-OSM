import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

/**
 * ═════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — THE REPORT IS WRITTEN ONCE AND NEVER EDITED (step H2)
 *
 *  1. The team table's key (`team.monitor`) is asked first, for both the read and the write; a refusal reads and writes nothing.
 *  2. The company, store and person are the session's, never the body's. The day is the store's local day, default today; a day that is not a day is refused; a report is for today or
 *     yesterday only.
 *  3. A form that is not valid whole is refused in Arabic and nothing is stored. A valid one is stored ONCE with the system's numbers frozen beside hers; a second one for the same day is a 409.
 *  4. The audit line says the event and the day — never the numbers (the audit screen is read by people who are not the owner).
 * ═════════════════════════════════════════════════════════════════
 */
const { requirePermission, logAudit, system, db } = vi.hoisted(() => ({
  requirePermission: vi.fn(async (_k: string) => undefined),
  logAudit: vi.fn(),
  system: vi.fn(async (..._a: unknown[]) => [{ userId: 'u1', name: 'سارة', claims: 5, confirmed: 3, rejected: 1, noAnswer: 4, winback: 0, stuck: 0, rejectedByReason: {}, winbackConverted: 0 }]),
  db: { confirmationEodReport: { findUnique: vi.fn(async (..._a: unknown[]) => null as unknown), create: vi.fn(async (..._a: unknown[]) => ({})) } },
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: async () => ({ user: { id: 'dalia' }, companyId: 'c1', storeId: 's1', country: { timezone: 'UTC' } }) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (k: string) => requirePermission(k) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/eod-report', async (orig) => ({ ...((await orig()) as object), systemNumbers: (...a: unknown[]) => system(...a) }));

import { GET, POST } from './route';
import { localDay } from '@/lib/eod-report';

const today = () => localDay(new Date(), 'UTC');
const yesterday = () => localDay(new Date(Date.now() - 86_400_000), 'UTC');
const form = (over: Record<string, unknown> = {}) => ({ agents: [{ userId: 'u1', claims: 5, confirmed: 3, rejected: 1, noAnswer: 4, winback: 0, stuck: 0 }], biggestProblem: 'ازدحام', tip: 'ابدأوا بالمتأخر', ...over });
const post = (body: unknown) => POST(new Request('http://x/api/confirmation/eod-report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
const get = (q = '') => GET(new Request(`http://x/api/confirmation/eod-report${q}`));

beforeEach(() => {
  vi.clearAllMocks();
  db.confirmationEodReport.findUnique.mockResolvedValue(null);
});

describe('who and what', () => {
  it('asks the team table\'s key first, for the read and the write, and a refusal reads and writes nothing', async () => {
    requirePermission.mockRejectedValue(Object.assign(new Error('FORBIDDEN'), { status: 403 }));
    expect((await get()).status).toBeGreaterThanOrEqual(400);
    expect((await post(form())).status).toBeGreaterThanOrEqual(400);
    requirePermission.mockResolvedValue(undefined);
    expect(requirePermission).toHaveBeenCalledWith('team.monitor');
    expect(system).not.toHaveBeenCalled();
    expect(db.confirmationEodReport.create).not.toHaveBeenCalled();
  });

  it('GET: the system\'s numbers for today of the store, whether she may report it, and what she already sent', async () => {
    const body = await (await get()).json();
    expect(body.day).toBe(today());
    expect(body.mayReport).toBe(true);
    expect(body.system[0].claims).toBe(5);
    expect(body.reasons.FAKE_ORDER).toBeTruthy();
    expect(body.submitted).toBeNull();
    const scope = (system.mock.calls[0] as unknown as [unknown, { companyId: string; storeId: string }])[1];
    expect(scope).toMatchObject({ companyId: 'c1', storeId: 's1' });
  });

  it('GET: an old day is readable but is not one she may report; a day that is not a day is refused', async () => {
    expect((await (await get('?day=2020-01-01')).json()).mayReport).toBe(false);
    expect((await get('?day=nonsense')).status).toBe(400);
  });

  it('GET: shows what she sent, looked up under HER key — the session\'s company, store and person', async () => {
    await get(`?day=${today()}`);
    const key = (db.confirmationEodReport.findUnique.mock.calls[0] as unknown as [{ where: { companyId_storeId_day_userId: Record<string, string> } }])[0].where.companyId_storeId_day_userId;
    expect(key).toEqual({ companyId: 'c1', storeId: 's1', day: today(), userId: 'dalia' });
  });
});

describe('writing it', () => {
  it('stores one report with hers and the system\'s numbers frozen together, and says only the event in the audit', async () => {
    const res = await post(form({ day: today() }));
    expect(res.status).toBe(201);
    const data = (db.confirmationEodReport.create.mock.calls[0] as unknown as [{ data: Record<string, any> }])[0].data;
    expect(data).toMatchObject({ companyId: 'c1', storeId: 's1', day: today(), userId: 'dalia' });
    expect(data.payload.agents[0]).toEqual({ userId: 'u1', claims: 5, confirmed: 3, rejected: 1, noAnswer: 4, winback: 0, stuck: 0 });
    expect(data.system[0].claims).toBe(5);
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'EOD_REPORT_SUBMITTED', userId: 'dalia', newData: { day: today() } }));
  });

  it('yesterday is allowed; two days ago is not; the body\'s company, store and person are ignored', async () => {
    expect((await post(form({ day: yesterday(), companyId: 'evil', storeId: 'evil', userId: 'evil' }))).status).toBe(201);
    const data = (db.confirmationEodReport.create.mock.calls[0] as unknown as [{ data: Record<string, any> }])[0].data;
    expect(data).toMatchObject({ companyId: 'c1', storeId: 's1', userId: 'dalia' });
    const old = await post(form({ day: '2020-01-01' }));
    expect(old.status).toBe(400);
    expect((await old.json()).code).toBe('DAY_TOO_OLD');
  });

  it('an invalid form is refused in Arabic and nothing is stored', async () => {
    for (const bad of [null, form({ agents: [] }), form({ agents: [{ userId: 'stranger', claims: 1, confirmed: 1, rejected: 1, noAnswer: 1, winback: 1, stuck: 1 }] }), form({ biggestProblem: 5 })]) {
      const res = await post(bad);
      expect(res.status).toBe(400);
      expect((await res.json()).errorAr).toMatch(/[؀-ۿ]/);
    }
    expect(db.confirmationEodReport.create).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('a second report for the same day is a 409 in Arabic, with no audit line', async () => {
    db.confirmationEodReport.create.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'x' }));
    const res = await post(form());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('ALREADY_SUBMITTED');
    expect(body.errorAr).toMatch(/[؀-ۿ]/);
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('there is no way to edit or delete a report: the door has no PUT, PATCH or DELETE', async () => {
    const mod = (await import('./route')) as Record<string, unknown>;
    expect(Object.keys(mod).sort()).toEqual(['GET', 'POST']);
  });
});
