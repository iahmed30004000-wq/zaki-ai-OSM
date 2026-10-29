import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE MOMENT A MEASUREMENT BECOMES MONEY.
 *
 * Proposing is arithmetic and runs on a schedule. Deciding takes money from
 * a real person and is always a human with their name on it. Every test
 * below guards that line, or the line beside it: that a deduction is
 * undone by a linked opposite row and never by a delete or a flipped flag.
 */

const { db, attendance } = vi.hoisted(() => ({
  db: {
    penaltyRule: { findMany: vi.fn() },
    penalty: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
  },
  attendance: vi.fn(),
}));

vi.mock('./db', () => ({ db }));
vi.mock('./attendance', () => ({ attendance: (...a: unknown[]) => attendance(...a) }));

import {
  applyPenalty,
  penaltiesOwed,
  proposePenalties,
  recordProposals,
  reversePenalty,
  waivePenalty,
  PenaltyRefused,
} from './penalty-service';

const CALENDAR = { workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6], timezone: 'UTC' };
const SCOPE = {
  companyId: 'c1',
  storeId: 's1',
  start: new Date('2026-09-01T00:00:00Z'),
  end: new Date('2026-10-01T00:00:00Z'),
  calendar: CALENDAR,
};
const PEOPLE = [{ id: 'u1', role: 'CONFIRMATION_AGENT', shift: { shiftStart: null, shiftEnd: null, restDays: null } }];

const RULE = {
  id: 'r1',
  kind: 'LATE',
  storeId: null,
  role: null,
  perUnit: 2,
  grace: 10,
  periodCap: null,
  currencyCode: 'SYP',
  effectiveFrom: new Date('2026-01-01'),
  effectiveTo: null,
  isActive: true,
  createdAt: new Date('2026-01-01'),
};

/** A Wednesday. */
const day = (over: Record<string, unknown> = {}) => ({
  date: '2026-09-23',
  arrivedAt: new Date('2026-09-23T09:40:00Z'),
  leftAt: null,
  presentMinutes: 0,
  workStartedAt: null,
  workEndedAt: null,
  workedMinutes: null,
  lateMinutes: 40,
  leftEarly: false,
  checkedOut: false,
  arrivalFromWork: false,
  ...over,
});

const marksWith = (d: Record<string, unknown>) =>
  attendance.mockResolvedValue(new Map([['u1', { userId: 'u1', days: [d] }]]));

beforeEach(() => {
  vi.resetAllMocks();
  db.penaltyRule.findMany.mockResolvedValue([RULE]);
  db.penalty.findMany.mockResolvedValue([]);
  marksWith(day());
});

describe('proposing', () => {
  it('turns lateness past the grace into a charge', async () => {
    const out = await proposePenalties(db as never, SCOPE, PEOPLE);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'LATE', units: 40, chargedUnits: 30, amount: 60, currencyCode: 'SYP' });
  });

  it('proposes NOTHING when no rule exists — silence is never a charge', async () => {
    db.penaltyRule.findMany.mockResolvedValue([]);
    expect(await proposePenalties(db as never, SCOPE, PEOPLE)).toEqual([]);
  });

  it('and never charges an ESTIMATED arrival, however late it looks', async () => {
    // Nobody marked an arrival; it was taken from their first order, which
    // is an upper bound on when they actually sat down.
    marksWith(day({ lateMinutes: 240, arrivalFromWork: true }));
    expect(await proposePenalties(db as never, SCOPE, PEOPLE)).toEqual([]);
  });

  it('never charges a rest day', async () => {
    // 2026-09-25 is a Friday, and Friday is a weekend day here.
    marksWith(day({ date: '2026-09-25', lateMinutes: 120 }));
    expect(await proposePenalties(db as never, SCOPE, PEOPLE)).toEqual([]);
  });

  it('and never charges a day that already carries a live charge', async () => {
    db.penalty.findMany.mockResolvedValue([
      { userId: 'u1', kind: 'LATE', amount: 60, occurredOn: new Date('2026-09-23T00:00:00Z') },
    ]);
    expect(await proposePenalties(db as never, SCOPE, PEOPLE)).toEqual([]);
  });

  it('counts what was already charged against the cap of the period', async () => {
    db.penaltyRule.findMany.mockResolvedValue([{ ...RULE, periodCap: 70 }]);
    db.penalty.findMany.mockResolvedValue([
      { userId: 'u1', kind: 'LATE', amount: 50, occurredOn: new Date('2026-09-10T00:00:00Z') },
    ]);
    const out = await proposePenalties(db as never, SCOPE, PEOPLE);
    expect(out[0].amount).toBe(20);
  });

  it('writes nothing by itself', async () => {
    await proposePenalties(db as never, SCOPE, PEOPLE);
    expect(db.penalty.create).not.toHaveBeenCalled();
    expect(db.penalty.updateMany).not.toHaveBeenCalled();
  });

  it('and what it writes is PROPOSED, never applied', async () => {
    const out = await proposePenalties(db as never, SCOPE, PEOPLE);
    db.penalty.create.mockResolvedValue({});
    await recordProposals(db as never, SCOPE, out);
    expect(db.penalty.create.mock.calls[0][0].data.status).toBe('PROPOSED');
    expect(db.penalty.create.mock.calls[0][0].data.decidedById).toBeUndefined();
  });

  it('running twice does not double a deduction', async () => {
    const out = await proposePenalties(db as never, SCOPE, PEOPLE);
    // The partial unique index refuses the second write.
    db.penalty.create.mockRejectedValue(new Error('unique constraint'));
    expect(await recordProposals(db as never, SCOPE, out)).toBe(0);
  });
});

describe('early leaving', () => {
  it('is charged only when they actually pressed the button', async () => {
    db.penaltyRule.findMany.mockResolvedValue([{ ...RULE, kind: 'EARLY_LEAVE', grace: 0 }]);
    // Left early, but nobody pressed check-out: "left early" here really
    // means "we stopped seeing work", which is not the same thing.
    marksWith(day({ lateMinutes: 0, leftEarly: true, checkedOut: false, leftAt: new Date('2026-09-23T15:00:00Z') }));
    expect(await proposePenalties(db as never, SCOPE, PEOPLE)).toEqual([]);

    marksWith(day({ lateMinutes: 0, leftEarly: true, checkedOut: true, leftAt: new Date('2026-09-23T15:00:00Z') }));
    const out = await proposePenalties(db as never, SCOPE, PEOPLE);
    expect(out[0]).toMatchObject({ kind: 'EARLY_LEAVE', units: 120 });
  });
});

describe('deciding', () => {
  const PROPOSED = { id: 'p1', status: 'PROPOSED', payslipId: null, amount: { negated: () => -60 }, companyId: 'c1', storeId: 's1', userId: 'u1', ruleId: 'r1', kind: 'LATE', occurredOn: new Date(), units: 40, chargedUnits: 30, currencyCode: 'SYP' };

  it('applying stamps who decided it — money never moves anonymously', async () => {
    db.penalty.findUnique.mockResolvedValue(PROPOSED);
    db.penalty.updateMany.mockResolvedValue({ count: 1 });
    await applyPenalty(db as never, { penaltyId: 'p1', decidedById: 'boss' });
    expect(db.penalty.updateMany.mock.calls[0][0].data).toMatchObject({ status: 'APPLIED', decidedById: 'boss' });
  });

  it('applying twice is refused', async () => {
    db.penalty.findUnique.mockResolvedValue({ ...PROPOSED, status: 'APPLIED' });
    await expect(applyPenalty(db as never, { penaltyId: 'p1', decidedById: 'boss' })).rejects.toMatchObject({
      reason: 'BAD_TRANSITION',
    });
  });

  it('applying something already waived is refused — that decision was taken', async () => {
    db.penalty.findUnique.mockResolvedValue({ ...PROPOSED, status: 'WAIVED' });
    await expect(applyPenalty(db as never, { penaltyId: 'p1', decidedById: 'boss' })).rejects.toBeInstanceOf(
      PenaltyRefused
    );
  });

  it('waiving without a reason is refused — a favour and a decision must not look alike', async () => {
    db.penalty.findUnique.mockResolvedValue(PROPOSED);
    await expect(waivePenalty(db as never, { penaltyId: 'p1', decidedById: 'boss' })).rejects.toMatchObject({
      reason: 'REASON_REQUIRED',
    });
    await expect(
      waivePenalty(db as never, { penaltyId: 'p1', decidedById: 'boss', note: '   ' })
    ).rejects.toMatchObject({ reason: 'REASON_REQUIRED' });
  });

  it('waiving with one is allowed', async () => {
    db.penalty.findUnique.mockResolvedValue(PROPOSED);
    db.penalty.updateMany.mockResolvedValue({ count: 1 });
    await waivePenalty(db as never, { penaltyId: 'p1', decidedById: 'boss', note: 'كان في عزاء' });
    expect(db.penalty.updateMany.mock.calls[0][0].data).toMatchObject({ status: 'WAIVED', decisionNote: 'كان في عزاء' });
  });
});

describe('undoing money that was taken', () => {
  const APPLIED = {
    id: 'p1', status: 'APPLIED', payslipId: null, amount: { negated: () => -60 },
    companyId: 'c1', storeId: 's1', userId: 'u1', ruleId: 'r1', kind: 'LATE',
    occurredOn: new Date('2026-09-23T00:00:00Z'), units: 40, chargedUnits: 30, currencyCode: 'SYP',
  };

  it('writes a linked opposite row, and deletes nothing', async () => {
    db.penalty.findUnique.mockResolvedValue(APPLIED);
    db.penalty.updateMany.mockResolvedValue({ count: 1 });
    db.penalty.create.mockResolvedValue({});
    await reversePenalty(db as never, { penaltyId: 'p1', decidedById: 'boss', note: 'خطأ في القياس' });

    const written = db.penalty.create.mock.calls[0][0].data;
    expect(written.reversesId).toBe('p1');
    expect(written.amount).toBe(-60);
    expect(written.status).toBe('REVERSED');
    // The original stays, marked.
    expect(db.penalty.updateMany.mock.calls[0][0].data.status).toBe('REVERSED');
  });

  it('needs a reason', async () => {
    db.penalty.findUnique.mockResolvedValue(APPLIED);
    await expect(reversePenalty(db as never, { penaltyId: 'p1', decidedById: 'boss' })).rejects.toMatchObject({
      reason: 'REASON_REQUIRED',
    });
  });

  it('and refuses one already settled against a payout — that money has left', async () => {
    db.penalty.findUnique.mockResolvedValue({ ...APPLIED, payslipId: 'pay1' });
    await expect(
      reversePenalty(db as never, { penaltyId: 'p1', decidedById: 'boss', note: 'خطأ' })
    ).rejects.toMatchObject({ reason: 'ALREADY_PAID' });
    expect(db.penalty.create).not.toHaveBeenCalled();
  });
});

describe('what is owed', () => {
  it('counts only what was APPLIED and not yet settled', async () => {
    db.penalty.findMany.mockResolvedValue([
      { id: 'a', amount: 60, currencyCode: 'SYP' },
      { id: 'b', amount: 40, currencyCode: 'SYP' },
      { id: 'c', amount: 10, currencyCode: 'EGP' },
    ]);
    const out = await penaltiesOwed(db as never, { companyId: 'c1', userId: 'u1' });
    expect(out).toEqual([
      { currencyCode: 'SYP', amount: 100, ids: ['a', 'b'] },
      { currencyCode: 'EGP', amount: 10, ids: ['c'] },
    ]);
    expect(db.penalty.findMany.mock.calls[0][0].where).toMatchObject({ status: 'APPLIED', payslipId: null });
  });
});
