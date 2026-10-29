import type { Prisma } from '@prisma/client';
import { db } from './db';
import { attendance } from './attendance';
import { shiftCalendar, type PersonShift } from './employee-shift';
import type { BusinessCalendar } from './business-calendar';
import { chargeFor, mayMove, ruleFor, type PenaltyStatus, type RuleRow } from './penalties';
import { NOT_THE_ONE_AR, SHORTFALL_KIND, mayCarryShortfall } from './shortfall';

type Tx = Prisma.TransactionClient | typeof db;

/**
 * PROPOSING A DEDUCTION, AND DECIDING ONE.
 *
 * The split is the whole design. Proposing is arithmetic and runs on a
 * schedule; deciding takes money and is always a person, with their name on
 * it. Nothing in this file moves a deduction from PROPOSED to APPLIED
 * without a `decidedById`, and nothing deletes one — a wrong charge is
 * reversed by a linked opposite row, the same way every financial record in
 * this system is undone.
 */

export class PenaltyRefused extends Error {
  constructor(
    public reason:
      | 'NO_RULE'
      | 'NOT_FOUND'
      | 'BAD_TRANSITION'
      | 'REASON_REQUIRED'
      | 'ALREADY_PAID'
      | 'ESTIMATED'
      | 'SELF_DECISION'
      | 'NOT_SHORTFALL'
      | 'BAD_TARGET'
      | 'CHANGED',
    message?: string
  ) {
    super(message ?? reason);
  }
}

export interface ProposeScope {
  companyId: string;
  storeId: string;
  start: Date;
  /** Exclusive. */
  end: Date;
  calendar: BusinessCalendar;
}

export interface Proposal {
  userId: string;
  kind: string;
  occurredOn: Date;
  units: number;
  chargedUnits: number;
  amount: number;
  currencyCode: string;
  ruleId: string;
  note: string | null;
}

/** yyyy-MM-dd → a UTC midnight Date, which is what a DATE column holds. */
const dayDate = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);

/**
 * What the days in this window would cost, if somebody agreed.
 *
 * Reads attendance — which now measures each person against THEIR shift —
 * and turns the days into charges through the rules. It writes nothing on
 * its own and it never returns a charge for a measurement that attendance
 * itself flagged as an estimate.
 */
export async function proposePenalties(
  tx: Tx,
  scope: ProposeScope,
  people: { id: string; role: string; shift: PersonShift }[]
): Promise<Proposal[]> {
  if (people.length === 0) return [];

  const rules = (await tx.penaltyRule.findMany({
    where: { companyId: scope.companyId, isActive: true },
  })) as unknown as RuleRow[];
  if (rules.length === 0) return [];

  const shifts = new Map(people.map((p) => [p.id, p.shift]));
  const marks = await attendance({
    companyId: scope.companyId,
    storeId: scope.storeId,
    userIds: people.map((p) => p.id),
    calendar: scope.calendar,
    shifts,
    start: scope.start,
    end: scope.end,
  });

  // What each rule has already taken from each person in this window, so the
  // cap is a cap on the period rather than on the day.
  const charged = new Map<string, number>();
  for (const row of await tx.penalty.findMany({
    where: {
      companyId: scope.companyId,
      userId: { in: people.map((p) => p.id) },
      status: { in: ['PROPOSED', 'APPLIED'] },
      occurredOn: { gte: scope.start, lt: scope.end },
    },
    select: { userId: true, kind: true, amount: true, occurredOn: true },
  })) {
    const key = `${row.userId}:${row.kind}`;
    charged.set(key, (charged.get(key) ?? 0) + Number(row.amount));
    // A day already charged is never charged again, whatever the rule says.
    charged.set(`day:${row.userId}:${row.kind}:${row.occurredOn.toISOString().slice(0, 10)}`, 1);
  }

  const out: Proposal[] = [];

  for (const person of people) {
    const row = marks.get(person.id);
    if (!row) continue;
    const cal = shiftCalendar(person.shift, scope.calendar);
    const rest = new Set(cal.weekendDays ?? []);

    for (const day of row.days) {
      const on = dayDate(day.date);
      // A rest day costs nothing. Charging somebody for a day they were
      // never expected is the fastest way to make the whole system a joke.
      if (rest.has(new Date(day.date).getUTCDay())) continue;

      const add = (kind: string, units: number, estimated: boolean, note: string | null) => {
        if (charged.has(`day:${person.id}:${kind}:${day.date}`)) return;
        const rule = ruleFor(rules, { kind, storeId: scope.storeId, role: person.role, on });
        if (!rule) return;
        const charge = chargeFor(rule, {
          units,
          estimated,
          alreadyCharged: charged.get(`${person.id}:${kind}`) ?? 0,
        });
        if (charge.refused || charge.amount <= 0) return;
        charged.set(`${person.id}:${kind}`, (charged.get(`${person.id}:${kind}`) ?? 0) + charge.amount);
        out.push({
          userId: person.id,
          kind,
          occurredOn: on,
          units: charge.units,
          chargedUnits: charge.chargedUnits,
          amount: charge.amount,
          currencyCode: rule.currencyCode,
          ruleId: rule.id,
          note,
        });
      };

      if (day.lateMinutes && day.lateMinutes > 0) {
        // `arrivalFromWork` means nobody marked an arrival and it was taken
        // from their first order — an upper bound. chargeFor refuses it; the
        // flag is passed rather than filtered here so the refusal has one
        // home and one test.
        add('LATE', day.lateMinutes, day.arrivalFromWork, null);
      }

      if (!day.arrivedAt && !day.workStartedAt) {
        add('ABSENT', 1, false, null);
      }

      // Only a pressed check-out. Without one, "left early" is really "we
      // stopped seeing work", which is not the same thing at all.
      if (day.leftEarly && day.checkedOut && day.leftAt) {
        const endMinutes = Number(cal.workHoursEnd.slice(0, 2)) * 60 + Number(cal.workHoursEnd.slice(3, 5));
        const leftMinutes = day.leftAt.getUTCHours() * 60 + day.leftAt.getUTCMinutes();
        add('EARLY_LEAVE', Math.max(0, endMinutes - leftMinutes), false, null);
      }
    }
  }

  return out;
}

/** Write the proposals. Re-running is safe: one live row per person, kind and day. */
export async function recordProposals(tx: Tx, scope: ProposeScope, proposals: Proposal[]): Promise<number> {
  let written = 0;
  for (const p of proposals) {
    try {
      await tx.penalty.create({
        data: {
          companyId: scope.companyId,
          storeId: scope.storeId,
          userId: p.userId,
          ruleId: p.ruleId,
          kind: p.kind,
          occurredOn: p.occurredOn,
          units: p.units,
          chargedUnits: p.chargedUnits,
          amount: p.amount,
          currencyCode: p.currencyCode,
          status: 'PROPOSED',
          note: p.note,
        },
      });
      written++;
    } catch {
      // The partial unique index refused it: this day already carries a live
      // charge of this kind. A proposer that ran twice must not double a
      // deduction, and swallowing this is the point of the index.
    }
  }
  return written;
}

/**
 * THE WRITE THAT DECIDES — CONDITIONAL ON WHAT WAS READ.
 *
 * Every decision first READS the row, checks it may move, then writes. Between the two a payment can stamp the row
 * with its payslip, or another person can decide it: an unconditional `update` would then write WAIVED over a
 * deduction the salary has already taken (or APPLIED over one somebody waived). So the write itself carries the
 * state it expects and the payslip it expects to be absent, and exactly one row must answer. Anything else — the
 * state moved, a payslip stamped it — refuses with `CHANGED` and writes nothing: the caller's transaction rolls back
 * whatever came before it.
 */
async function moveFrom(tx: Tx, row: { id: string; status: string }, data: Prisma.PenaltyUpdateManyMutationInput) {
  const done = await tx.penalty.updateMany({ where: { id: row.id, status: row.status, payslipId: null }, data });
  if (done.count !== 1) throw new PenaltyRefused('CHANGED');
}

export interface Decision {
  penaltyId: string;
  decidedById: string;
  note?: string | null;
}

/**
 * Apply a proposed deduction. This is the moment it becomes money.
 *
 * Refused for anything not currently PROPOSED — applying twice, or applying
 * something already waived, would charge somebody for a decision that had
 * already been taken in their favour.
 */
export async function applyPenalty(tx: Tx, input: Decision) {
  const row = await tx.penalty.findUnique({ where: { id: input.penaltyId } });
  if (!row) throw new PenaltyRefused('NOT_FOUND');
  if (!mayMove(row.status, 'APPLIED')) throw new PenaltyRefused('BAD_TRANSITION');
  // Nobody decides a deduction taken from themselves: not to apply it and not to wave it away.
  if (row.userId === input.decidedById) throw new PenaltyRefused('SELF_DECISION');

  const data = {
    status: 'APPLIED',
    decidedById: input.decidedById,
    decidedAt: new Date(),
    decisionNote: input.note ?? null,
  };
  await moveFrom(tx, row, data);
  return { ...row, ...data };
}

/**
 * Waive a proposed deduction — it never becomes money.
 *
 * A reason is required. A deduction cancelled with no reason written down
 * is indistinguishable from a favour, and the person it was cancelled for
 * is the one who suffers when that is questioned later.
 */
export async function waivePenalty(tx: Tx, input: Decision) {
  const row = await tx.penalty.findUnique({ where: { id: input.penaltyId } });
  if (!row) throw new PenaltyRefused('NOT_FOUND');
  if (!mayMove(row.status, 'WAIVED')) throw new PenaltyRefused('BAD_TRANSITION');
  if (!input.note?.trim()) throw new PenaltyRefused('REASON_REQUIRED');
  if (row.userId === input.decidedById) throw new PenaltyRefused('SELF_DECISION');

  const data = {
    status: 'WAIVED',
    decidedById: input.decidedById,
    decidedAt: new Date(),
    decisionNote: input.note.trim(),
  };
  await moveFrom(tx, row, data);
  return { ...row, ...data };
}

/**
 * Undo an applied deduction with a linked opposite row.
 *
 * Never a delete and never a status flipped back: the record must show
 * that money was taken and that it was given back, because somebody will
 * ask, and "it was never taken" is not an answer when it was.
 *
 * A deduction already settled against a payout is refused — that money has
 * left; correcting it is a new movement, not a rewritten history.
 */
export async function reversePenalty(tx: Tx, input: Decision) {
  const row = await tx.penalty.findUnique({ where: { id: input.penaltyId } });
  if (!row) throw new PenaltyRefused('NOT_FOUND');
  if (!mayMove(row.status, 'REVERSED')) throw new PenaltyRefused('BAD_TRANSITION');
  if (!input.note?.trim()) throw new PenaltyRefused('REASON_REQUIRED');
  if (row.payslipId) throw new PenaltyRefused('ALREADY_PAID');
  if (row.userId === input.decidedById) throw new PenaltyRefused('SELF_DECISION');

  const now = new Date();
  await moveFrom(tx, row, { status: 'REVERSED', decidedById: input.decidedById, decidedAt: now, decisionNote: input.note.trim() });

  return tx.penalty.create({
    data: {
      companyId: row.companyId,
      storeId: row.storeId,
      userId: row.userId,
      ruleId: row.ruleId,
      kind: row.kind,
      occurredOn: row.occurredOn,
      units: row.units,
      chargedUnits: row.chargedUnits,
      // The opposite sign: the pair sums to nothing, which is what "undone"
      // means in a ledger.
      amount: row.amount.negated(),
      currencyCode: row.currencyCode,
      status: 'REVERSED',
      decidedById: input.decidedById,
      decidedAt: now,
      decisionNote: input.note.trim(),
      reversesId: row.id,
    },
  });
}

export interface Retarget extends Decision {
  /** The company: a person from another company is not a person this penalty can be moved to. */
  companyId: string;
  toUserId: string;
}

/**
 * MOVE A «فرق تحصيل» TO THE PERSON WHO REALLY COLLECTED THE PARCEL.
 *
 * The door can name the wrong one (two people share a phone, a colleague pressed it for another). The charge is
 * never edited to another name — that would rewrite who was accused. It is WAIVED «ليس المسؤول», which says it
 * was a mistake and whose, and a NEW PROPOSED row for the same line, amount and day is written for the other
 * person. Both in one transaction, the old one first: the database allows one live charge per line.
 *
 * Only a shortfall, only while it is still PROPOSED, never onto oneself, never onto the owner or a manager.
 */
export async function retargetShortfall(tx: Tx, input: Retarget) {
  const row = await tx.penalty.findUnique({ where: { id: input.penaltyId } });
  if (!row || row.companyId !== input.companyId) throw new PenaltyRefused('NOT_FOUND');
  if (row.kind !== SHORTFALL_KIND || !row.settlementMatchId) throw new PenaltyRefused('NOT_SHORTFALL');
  if (!mayMove(row.status, 'WAIVED')) throw new PenaltyRefused('BAD_TRANSITION');
  if (row.userId === input.decidedById) throw new PenaltyRefused('SELF_DECISION');
  if (input.toUserId === row.userId) throw new PenaltyRefused('BAD_TARGET');

  const target = await tx.user.findFirst({
    where: { id: input.toUserId, companyId: input.companyId, status: 'ACTIVE' },
    select: { id: true, role: true },
  });
  if (!target || !mayCarryShortfall(target.role) || target.id === input.decidedById) throw new PenaltyRefused('BAD_TARGET');

  const now = new Date();
  await moveFrom(tx, row, { status: 'WAIVED', decidedById: input.decidedById, decidedAt: now, decisionNote: NOT_THE_ONE_AR });

  return tx.penalty.create({
    data: {
      companyId: row.companyId,
      storeId: row.storeId,
      userId: target.id,
      ruleId: null,
      kind: row.kind,
      occurredOn: row.occurredOn,
      units: row.units,
      chargedUnits: row.chargedUnits,
      amount: row.amount,
      currencyCode: row.currencyCode,
      status: 'PROPOSED',
      note: row.note,
      settlementMatchId: row.settlementMatchId,
    },
  });
}

/** What has actually been charged to this person and not yet settled. */
export async function penaltiesOwed(
  tx: Tx,
  params: { companyId: string; userId: string }
): Promise<{ currencyCode: string; amount: number; ids: string[] }[]> {
  const rows = await tx.penalty.findMany({
    where: { companyId: params.companyId, userId: params.userId, status: 'APPLIED', payslipId: null },
    select: { id: true, amount: true, currencyCode: true },
  });

  const byCurrency = new Map<string, { currencyCode: string; amount: number; ids: string[] }>();
  for (const r of rows) {
    const e = byCurrency.get(r.currencyCode) ?? { currencyCode: r.currencyCode, amount: 0, ids: [] };
    e.amount += Number(r.amount);
    e.ids.push(r.id);
    byCurrency.set(r.currencyCode, e);
  }
  return [...byCurrency.values()];
}

export type { PenaltyStatus };
