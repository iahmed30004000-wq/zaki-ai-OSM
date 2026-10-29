import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE LIFE OF A «فرق تحصيل» AFTER THE APPROVAL PROPOSED IT.
 *
 *   PROPOSED «بانتظار قرار المالك أو المحاسب»
 *     → WAIVED «التفسير مقبول — على الشركة»   (a reason is required)
 *     → APPLIED «يُخصم»
 *   APPLIED → REVERSED until a payslip stamps the row
 *   re-targeting = WAIVED «ليس المسؤول» + a new PROPOSED row for the same line
 *
 * And the one rule above them all: nobody decides a deduction taken from themselves.
 */

const { db } = vi.hoisted(() => ({
  db: {
    penaltyRule: { findMany: vi.fn() },
    penalty: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    user: { findFirst: vi.fn() },
  },
}));

vi.mock('./db', () => ({ db }));
vi.mock('./attendance', () => ({ attendance: vi.fn() }));

import { applyPenalty, reversePenalty, retargetShortfall, waivePenalty, PenaltyRefused } from './penalty-service';
import { mayMove } from './penalties';

const AMOUNT = { negated: () => -2 };
const SHORTFALL = {
  id: 'p1', status: 'PROPOSED', payslipId: null, amount: AMOUNT, companyId: 'c1', storeId: 's1', userId: 'u-sara',
  ruleId: null, kind: 'SHORTFALL', occurredOn: new Date('2026-10-18T00:00:00Z'), units: 1, chargedUnits: 1,
  currencyCode: 'USD', note: 'ORD-1 · ST-1 · خصم', settlementMatchId: 'm1',
};
const DECIDER = { penaltyId: 'p1', decidedById: 'u-accountant' };

beforeEach(() => {
  vi.resetAllMocks();
  db.penalty.updateMany.mockResolvedValue({ count: 1 });
  db.penalty.create.mockResolvedValue({ id: 'p2', userId: 'u-mona' });
});

describe('the states a shortfall moves through', () => {
  it('PROPOSED can be waived or applied, APPLIED can be reversed — and nothing else moves', () => {
    expect(mayMove('PROPOSED', 'WAIVED')).toBe(true);
    expect(mayMove('PROPOSED', 'APPLIED')).toBe(true);
    expect(mayMove('APPLIED', 'REVERSED')).toBe(true);
    expect(mayMove('PROPOSED', 'REVERSED')).toBe(false);
    expect(mayMove('WAIVED', 'APPLIED')).toBe(false);
    expect(mayMove('REVERSED', 'APPLIED')).toBe(false);
  });

  it('WAIVED «التفسير مقبول — على الشركة» needs a reason: an explanation accepted without a word is a favour', async () => {
    db.penalty.findUnique.mockResolvedValue(SHORTFALL);
    await expect(waivePenalty(db as never, DECIDER)).rejects.toMatchObject({ reason: 'REASON_REQUIRED' });
    await waivePenalty(db as never, { ...DECIDER, note: 'التفسير مقبول — خصم أعطاه الموظف' });
    expect(db.penalty.updateMany.mock.calls[0][0].data).toMatchObject({ status: 'WAIVED', decidedById: 'u-accountant' });
  });

  it('APPLIED «يُخصم» stamps the decider', async () => {
    db.penalty.findUnique.mockResolvedValue(SHORTFALL);
    await applyPenalty(db as never, DECIDER);
    expect(db.penalty.updateMany.mock.calls[0][0].data).toMatchObject({ status: 'APPLIED', decidedById: 'u-accountant' });
  });

  it('APPLIED → REVERSED before a payslip: a linked opposite row, nothing deleted', async () => {
    db.penalty.findUnique.mockResolvedValue({ ...SHORTFALL, status: 'APPLIED' });
    await reversePenalty(db as never, { ...DECIDER, note: 'ظهر أن الفرق خطأ بالكشف' });
    expect(db.penalty.create.mock.calls[0][0].data).toMatchObject({ reversesId: 'p1', status: 'REVERSED', amount: -2, kind: 'SHORTFALL' });
    expect(db.penalty.updateMany.mock.calls[0][0].data.status).toBe('REVERSED');
  });

  it('NEGATIVE: AFTER a payslip stamped the row it cannot be reversed — that money left', async () => {
    db.penalty.findUnique.mockResolvedValue({ ...SHORTFALL, status: 'APPLIED', payslipId: 'slip1' });
    await expect(reversePenalty(db as never, { ...DECIDER, note: 'خطأ' })).rejects.toMatchObject({ reason: 'ALREADY_PAID' });
    expect(db.penalty.create).not.toHaveBeenCalled();
  });
});

describe('a decision is a CONDITIONAL write — a payment or another decision in between wins, and nothing is written', () => {
  const CHANGED = { reason: 'CHANGED' };
  const NOBODY = { count: 0 };
  const decision = { ...DECIDER, note: 'سبب واضح' };

  it('WAIVE: the write names the state it read and a payslip that must be absent', async () => {
    db.penalty.findUnique.mockResolvedValue(SHORTFALL);
    await waivePenalty(db as never, decision);
    expect(db.penalty.updateMany.mock.calls[0][0].where).toEqual({ id: 'p1', status: 'PROPOSED', payslipId: null });
  });

  it('APPLY: the same, from PROPOSED', async () => {
    db.penalty.findUnique.mockResolvedValue(SHORTFALL);
    await applyPenalty(db as never, decision);
    expect(db.penalty.updateMany.mock.calls[0][0].where).toEqual({ id: 'p1', status: 'PROPOSED', payslipId: null });
  });

  it('REVERSE: from APPLIED, with no payslip', async () => {
    db.penalty.findUnique.mockResolvedValue({ ...SHORTFALL, status: 'APPLIED' });
    await reversePenalty(db as never, decision);
    expect(db.penalty.updateMany.mock.calls[0][0].where).toEqual({ id: 'p1', status: 'APPLIED', payslipId: null });
  });

  it('RETARGET: the old row is waived by the same conditional write', async () => {
    db.penalty.findUnique.mockResolvedValue(SHORTFALL);
    db.user.findFirst.mockResolvedValue({ id: 'u-mona', role: 'FOLLOW_UP_AGENT' });
    await retargetShortfall(db as never, { ...decision, companyId: 'c1', toUserId: 'u-mona' });
    expect(db.penalty.updateMany.mock.calls[0][0].where).toEqual({ id: 'p1', status: 'PROPOSED', payslipId: null });
  });

  it('NEGATIVE WAIVE: the row was stamped by a payslip (APPLIED) between the read and the write → refused, nothing else written', async () => {
    db.penalty.findUnique.mockResolvedValue(SHORTFALL);
    db.penalty.updateMany.mockResolvedValue(NOBODY);
    await expect(waivePenalty(db as never, decision)).rejects.toMatchObject(CHANGED);
    expect(db.penalty.create).not.toHaveBeenCalled();
  });

  it('NEGATIVE APPLY: somebody waived it in between → refused', async () => {
    db.penalty.findUnique.mockResolvedValue(SHORTFALL);
    db.penalty.updateMany.mockResolvedValue(NOBODY);
    await expect(applyPenalty(db as never, decision)).rejects.toMatchObject(CHANGED);
  });

  it('NEGATIVE REVERSE: a payslip stamped it in between → refused, and no opposite row is written', async () => {
    db.penalty.findUnique.mockResolvedValue({ ...SHORTFALL, status: 'APPLIED' });
    db.penalty.updateMany.mockResolvedValue(NOBODY);
    await expect(reversePenalty(db as never, decision)).rejects.toMatchObject(CHANGED);
    expect(db.penalty.create).not.toHaveBeenCalled();
  });

  it('NEGATIVE RETARGET: it moved in between → refused, and no new row is written for the other person', async () => {
    db.penalty.findUnique.mockResolvedValue(SHORTFALL);
    db.user.findFirst.mockResolvedValue({ id: 'u-mona', role: 'FOLLOW_UP_AGENT' });
    db.penalty.updateMany.mockResolvedValue(NOBODY);
    await expect(retargetShortfall(db as never, { ...decision, companyId: 'c1', toUserId: 'u-mona' })).rejects.toMatchObject(CHANGED);
    expect(db.penalty.create).not.toHaveBeenCalled();
  });

  it('the refusal is a PenaltyRefused', async () => {
    db.penalty.findUnique.mockResolvedValue(SHORTFALL);
    db.penalty.updateMany.mockResolvedValue(NOBODY);
    await expect(waivePenalty(db as never, decision)).rejects.toBeInstanceOf(PenaltyRefused);
  });
});

describe('nobody decides a deduction taken from themselves', () => {
  const self = { penaltyId: 'p1', decidedById: 'u-sara', note: 'سبب' };

  it('NEGATIVE: not to apply it', async () => {
    db.penalty.findUnique.mockResolvedValue(SHORTFALL);
    await expect(applyPenalty(db as never, self)).rejects.toMatchObject({ reason: 'SELF_DECISION' });
    expect(db.penalty.updateMany).not.toHaveBeenCalled();
  });

  it('NEGATIVE: not to wave it away', async () => {
    db.penalty.findUnique.mockResolvedValue(SHORTFALL);
    await expect(waivePenalty(db as never, self)).rejects.toMatchObject({ reason: 'SELF_DECISION' });
    expect(db.penalty.updateMany).not.toHaveBeenCalled();
  });

  it('NEGATIVE: not to reverse it', async () => {
    db.penalty.findUnique.mockResolvedValue({ ...SHORTFALL, status: 'APPLIED' });
    await expect(reversePenalty(db as never, self)).rejects.toMatchObject({ reason: 'SELF_DECISION' });
    expect(db.penalty.create).not.toHaveBeenCalled();
  });

  it('and it holds for a deduction of any kind, not only a shortfall (lateness was exposed the same way)', async () => {
    db.penalty.findUnique.mockResolvedValue({ ...SHORTFALL, kind: 'LATE', settlementMatchId: null });
    await expect(applyPenalty(db as never, self)).rejects.toMatchObject({ reason: 'SELF_DECISION' });
  });

  it('another person decides it without a word about it', async () => {
    db.penalty.findUnique.mockResolvedValue(SHORTFALL);
    await expect(applyPenalty(db as never, DECIDER)).resolves.toBeDefined();
  });
});

describe('re-targeting: «ليس المسؤول»', () => {
  const MONA = { id: 'u-mona', role: 'FOLLOW_UP_AGENT' };
  const move = (over: Record<string, unknown> = {}) =>
    retargetShortfall(db as never, { ...DECIDER, companyId: 'c1', toUserId: 'u-mona', ...over });

  beforeEach(() => {
    db.penalty.findUnique.mockResolvedValue(SHORTFALL);
    db.user.findFirst.mockResolvedValue(MONA);
  });

  it('waives the first row «ليس المسؤول» and writes a NEW PROPOSED row for the other person — the old one first', async () => {
    const order: string[] = [];
    db.penalty.updateMany.mockImplementation(async () => { order.push('waive'); return { count: 1 }; });
    db.penalty.create.mockImplementation(async () => { order.push('create'); return { id: 'p2', userId: 'u-mona' }; });

    await move();

    expect(order).toEqual(['waive', 'create']);
    expect(db.penalty.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: 'p1' },
      data: { status: 'WAIVED', decidedById: 'u-accountant', decisionNote: 'ليس المسؤول' },
    });
    expect(db.penalty.create.mock.calls[0][0].data).toMatchObject({
      companyId: 'c1', storeId: 's1', userId: 'u-mona', kind: 'SHORTFALL', status: 'PROPOSED', amount: AMOUNT,
      currencyCode: 'USD', units: 1, chargedUnits: 1, settlementMatchId: 'm1', note: 'ORD-1 · ST-1 · خصم', ruleId: null,
    });
    expect(db.penalty.create.mock.calls[0][0].data.occurredOn).toEqual(new Date('2026-10-18T00:00:00Z'));
  });

  it('looks the new person up in THIS company, active only', async () => {
    await move();
    expect(db.user.findFirst.mock.calls[0][0].where).toEqual({ id: 'u-mona', companyId: 'c1', status: 'ACTIVE' });
  });

  it('NEGATIVE: only a shortfall can be moved', async () => {
    db.penalty.findUnique.mockResolvedValue({ ...SHORTFALL, kind: 'LATE', settlementMatchId: null });
    await expect(move()).rejects.toMatchObject({ reason: 'NOT_SHORTFALL' });
    expect(db.penalty.updateMany).not.toHaveBeenCalled();
  });

  it.each(['APPLIED', 'WAIVED', 'REVERSED'])('NEGATIVE: only while it is still PROPOSED — not %s', async (status) => {
    db.penalty.findUnique.mockResolvedValue({ ...SHORTFALL, status });
    await expect(move()).rejects.toMatchObject({ reason: 'BAD_TRANSITION' });
    expect(db.penalty.create).not.toHaveBeenCalled();
  });

  it('NEGATIVE: not onto the person who already carries it', async () => {
    await expect(move({ toUserId: 'u-sara' })).rejects.toMatchObject({ reason: 'BAD_TARGET' });
  });

  it('NEGATIVE: not onto oneself', async () => {
    db.user.findFirst.mockResolvedValue({ id: 'u-accountant', role: 'ACCOUNTANT' });
    await expect(move({ toUserId: 'u-accountant' })).rejects.toMatchObject({ reason: 'BAD_TARGET' });
    expect(db.penalty.updateMany).not.toHaveBeenCalled();
  });

  it('NEGATIVE: not onto the owner or a manager', async () => {
    for (const role of ['SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER', 'DELIVERY_MANAGER']) {
      db.user.findFirst.mockResolvedValue({ id: 'u-boss', role });
      await expect(move({ toUserId: 'u-boss' }), role).rejects.toMatchObject({ reason: 'BAD_TARGET' });
    }
    expect(db.penalty.create).not.toHaveBeenCalled();
  });

  it('NEGATIVE: not onto someone who is not there (another company, or not active)', async () => {
    db.user.findFirst.mockResolvedValue(null);
    await expect(move()).rejects.toMatchObject({ reason: 'BAD_TARGET' });
    expect(db.penalty.updateMany).not.toHaveBeenCalled();
  });

  it('NEGATIVE: the person whose charge it is cannot move it (they would be deciding their own)', async () => {
    await expect(move({ decidedById: 'u-sara' })).rejects.toMatchObject({ reason: 'SELF_DECISION' });
    expect(db.penalty.updateMany).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a charge of another company is not found', async () => {
    db.penalty.findUnique.mockResolvedValue({ ...SHORTFALL, companyId: 'c2' });
    await expect(move()).rejects.toMatchObject({ reason: 'NOT_FOUND' });
    expect(db.penalty.updateMany).not.toHaveBeenCalled();
  });

  it('refusals are PenaltyRefused, so the route can answer them in Arabic', async () => {
    db.user.findFirst.mockResolvedValue(null);
    await expect(move()).rejects.toBeInstanceOf(PenaltyRefused);
  });
});
