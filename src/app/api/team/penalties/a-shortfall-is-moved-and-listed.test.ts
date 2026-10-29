import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE DOOR A «فرق تحصيل» IS DECIDED AT.
 *
 * `penalties.decide` is granted to the ACCOUNTANT (the owner has it through the bypass); this route is where it is
 * used. Besides apply / waive / reverse it now MOVES a shortfall to the person who really collected the parcel,
 * lists who it can be moved to (for the one who decides only), and says no to anyone deciding their own.
 */

const { db, requireContext, requirePermission, retargetShortfall, applyPenalty, waivePenalty, reversePenalty, logAudit, notify, PenaltyRefused } =
  vi.hoisted(() => ({
    db: { penalty: { findMany: vi.fn(), findFirst: vi.fn() }, user: { findMany: vi.fn() }, $transaction: vi.fn() },
    requireContext: vi.fn(),
    requirePermission: vi.fn(),
    retargetShortfall: vi.fn(),
    applyPenalty: vi.fn(),
    waivePenalty: vi.fn(),
    reversePenalty: vi.fn(),
    logAudit: vi.fn(),
    notify: vi.fn(),
    PenaltyRefused: class PenaltyRefused extends Error {
      constructor(public reason: string) {
        super(reason);
      }
    },
  }));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/notify', () => ({ notify: (...a: unknown[]) => notify(...a) }));
vi.mock('@/lib/penalty-service', () => ({
  applyPenalty: (...a: unknown[]) => applyPenalty(...a),
  waivePenalty: (...a: unknown[]) => waivePenalty(...a),
  reversePenalty: (...a: unknown[]) => reversePenalty(...a),
  retargetShortfall: (...a: unknown[]) => retargetShortfall(...a),
  PenaltyRefused,
}));

import { GET, POST } from './route';

const ID = '11111111-1111-4111-8111-111111111111';
const MONA = '22222222-2222-4222-8222-222222222222';

const get = (qs = '') => GET(new Request(`http://localhost/api/team/penalties${qs}`));
const post = (body: unknown) =>
  POST(new Request('http://localhost/api/team/penalties', { method: 'POST', body: JSON.stringify(body) }));

beforeEach(() => {
  vi.resetAllMocks();
  requireContext.mockResolvedValue({ user: { id: 'u-accountant' }, companyId: 'c1', storeId: 's1' });
  requirePermission.mockResolvedValue(undefined);
  db.penalty.findMany.mockResolvedValue([]);
  db.penalty.findFirst.mockResolvedValue({
    id: ID, userId: 'u-sara', kind: 'SHORTFALL', amount: 2, currencyCode: 'USD', status: 'PROPOSED',
  });
  db.user.findMany.mockResolvedValue([{ id: MONA, name: 'منى', role: 'FOLLOW_UP_AGENT' }]);
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
  retargetShortfall.mockResolvedValue({ id: 'p2', userId: MONA });
});

describe('the list', () => {
  it('names the new kind beside the four a rule measures', async () => {
    const body = await (await get()).json();
    expect(body.kinds.map((k: { key: string }) => k.key)).toEqual(['LATE', 'ABSENT', 'EARLY_LEAVE', 'NO_ACTION', 'SHORTFALL']);
    expect(body.kinds.at(-1).ar).toBe('فرق تحصيل');
  });

  it('and says which statement line each row is about', async () => {
    await get();
    expect(db.penalty.findMany.mock.calls[0][0].select.settlementMatchId).toBe(true);
  });

  it('the roster of people it can be moved to needs the DECIDING key too — and never lists the owner or a manager', async () => {
    const res = await get('?people=1');
    expect(requirePermission).toHaveBeenCalledWith('penalties.view');
    expect(requirePermission).toHaveBeenCalledWith('penalties.decide');
    expect(await res.json()).toEqual({ people: [{ id: MONA, name: 'منى', role: 'FOLLOW_UP_AGENT' }] });
    expect(db.user.findMany.mock.calls[0][0].where).toEqual({
      companyId: 'c1', status: 'ACTIVE', role: { notIn: ['SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER', 'DELIVERY_MANAGER'] },
    });
    expect(db.penalty.findMany).not.toHaveBeenCalled();
  });

  it('NEGATIVE: someone who may only LOOK gets no roster', async () => {
    requirePermission.mockImplementation(async (k: string) => {
      if (k === 'penalties.decide') throw new Error('Forbidden: missing required permission penalties.decide');
    });
    expect((await get('?people=1')).status).toBe(403);
    expect(db.user.findMany).not.toHaveBeenCalled();
  });
});

describe('moving a shortfall to another person', () => {
  it('needs the deciding key, and the person', async () => {
    const res = await post({ penaltyId: ID, action: 'retarget', userId: MONA });
    expect(res.status).toBe(200);
    expect(requirePermission).toHaveBeenCalledWith('penalties.decide');
    expect(retargetShortfall.mock.calls[0][1]).toMatchObject({
      penaltyId: ID, decidedById: 'u-accountant', companyId: 'c1', toUserId: MONA,
    });
  });

  it('without a person it is refused before anything is read', async () => {
    const res = await post({ penaltyId: ID, action: 'retarget' });
    expect(res.status).toBe(400);
    expect(db.penalty.findFirst).not.toHaveBeenCalled();
    expect(retargetShortfall).not.toHaveBeenCalled();
  });

  it('tells the new person once it is done — and the audit row says where it went', async () => {
    await post({ penaltyId: ID, action: 'retarget', userId: MONA });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatchObject({ companyId: 'c1', audience: { userIds: [MONA] }, actorId: 'u-accountant' });
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PENALTY_RETARGET', newData: expect.objectContaining({ movedTo: MONA, employeeId: 'u-sara' }) })
    );
  });

  it('a refusal tells nobody and audits nothing', async () => {
    retargetShortfall.mockRejectedValue(new PenaltyRefused('BAD_TARGET'));
    const res = await post({ penaltyId: ID, action: 'retarget', userId: MONA });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('BAD_TARGET');
    expect(notify).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('an ordinary decision tells nobody', async () => {
    await post({ penaltyId: ID, action: 'apply' });
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('a decision that lost the race to a payment or to another decision', () => {
  it.each(['apply', 'waive', 'reverse', 'retarget'] as const)('%s is answered «الخصم تغيّر هلّق — حدّث الصفحة», as a conflict, with no audit row and no notice', async (action) => {
    const refused = new PenaltyRefused('CHANGED');
    applyPenalty.mockRejectedValue(refused);
    waivePenalty.mockRejectedValue(refused);
    reversePenalty.mockRejectedValue(refused);
    retargetShortfall.mockRejectedValue(refused);
    const res = await post({ penaltyId: ID, action, note: 'سبب', userId: MONA });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('CHANGED');
    expect(body.error).toBe('الخصم تغيّر هلّق — حدّث الصفحة');
    expect(logAudit).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('deciding one’s own', () => {
  it('is answered in Arabic, as a conflict', async () => {
    applyPenalty.mockRejectedValue(new PenaltyRefused('SELF_DECISION'));
    const res = await post({ penaltyId: ID, action: 'apply' });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('SELF_DECISION');
    expect(body.error).toContain('عليك');
    expect(logAudit).not.toHaveBeenCalled();
  });
});
