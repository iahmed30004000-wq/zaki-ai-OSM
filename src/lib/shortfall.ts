import type { Prisma } from '@prisma/client';
import type { db } from './db';
import { roundMinor } from './money';
import { SHORTFALL_KIND_INFO } from './penalties';

type Tx = Prisma.TransactionClient | typeof db;

/**
 * THE COLLECTION SHORTFALL — WHAT THE COMPANY PAID LESS THAN WE EXPECTED, AND WHO CARRIES IT.
 *
 * «ممكن عادي صار خصم، بس يعتمد رقم الشركة.» When a person accepts the company's figure on a line that came in
 * LOWER than ours, the money is gone — and it is the employee who collected the parcel who carries the
 * difference, unless the owner or the accountant accepts the explanation. The statement's approval is the one
 * moment that decides it, so this is written there, in the same transaction, and nowhere else.
 *
 * ── THE MEASURE ──
 *
 *   s = (expectedAmount + expectedFee) − (statementAmount + statementFee)     in the currency's minor unit
 *
 * Both sides are the GROSS, what the customer handed over at the door: a courier that keeps a bigger fee and
 * pays a smaller net for it has collected exactly what we expected, so s is zero and no employee is charged
 * for the courier's price list. Only s > 0 charges anyone.
 *
 * ── WHO ──
 *
 * The person on the LATEST delivered (or partly delivered) attempt made before the statement was imported —
 * the door recorded it, so it names the one who stood there. The owner and the managers never carry it. If the
 * door has none, the approver names a person per line or says «على الشركة». Never the confirmer and never the
 * moderator: they sold the order, they did not follow the parcel.
 *
 * Every figure here is rounded by `roundMinor`, the one rounding the whole system uses.
 */

export const SHORTFALL_KIND = SHORTFALL_KIND_INFO.key;
export const SHORTFALL_AR = SHORTFALL_KIND_INFO.ar;
/** What the approver writes beside a line the company carries instead of a person. */
export const ON_THE_COMPANY = 'COMPANY';

/** The owner and the managers: never charged for a parcel they did not collect. */
export const NEVER_CHARGED_ROLES = ['SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER', 'DELIVERY_MANAGER'] as const;

/** The results of a delivery attempt that mean «the parcel reached the customer and money was taken». */
export const DOOR_RESULTS = ['DELIVERED', 'PARTIALLY_DELIVERED'] as const;

/** The parcels coming back: a line of zero for one of them is not a shortfall, it is a return. */
const COMING_BACK = ['RETURN_REQUESTED', 'RETURNED'];

export const SHORTFALL_STATUS_AR = {
  PROPOSED: 'بانتظار قرار المالك أو المحاسب',
  WAIVED: 'التفسير مقبول — على الشركة',
  APPLIED: 'يُخصم',
  REVERSED: 'أُعيد',
} as const;

export const UNDECIDED_AT_PAYDAY_AR = 'لم يُعتمد تفسيره — سيُخصم';
export const NOT_THE_ONE_AR = 'ليس المسؤول';

export function mayCarryShortfall(role: string | null | undefined): boolean {
  return !!role && !(NEVER_CHARGED_ROLES as readonly string[]).includes(role);
}

type Num = Prisma.Decimal | number | string | null | undefined;
const num = (v: Num): number | null => (v === null || v === undefined ? null : Number(v));

export interface ShortfallFigures {
  expectedAmount: Num;
  expectedFee?: Num;
  statementAmount: Num;
  statementFee?: Num;
  /**
   * The line pays what is left of an earlier claim on the company («رقمنا هو المعتمد» on an approved statement).
   * Its expectation is already that remainder, and the fee was settled with the first payment, so net is
   * measured against net and no fee enters.
   */
  claimPayment?: boolean;
}

/**
 * THE SHORTFALL OF ONE LINE, in the currency's minor unit — 0 when there is none.
 *
 * A figure the line lacks (no expected or no stated amount) is no measure at all, and 0. A fee the company did
 * not state is taken as the fee we expected: the courier's silence about its fee is not a loss to an employee.
 */
export function shortfallOf(f: ShortfallFigures, minorUnit: number): number {
  const expected = num(f.expectedAmount);
  const stated = num(f.statementAmount);
  if (expected === null || stated === null) return 0;

  let s: number;
  if (f.claimPayment) {
    s = expected - stated;
  } else {
    const expectedFee = num(f.expectedFee) ?? 0;
    const statedFee = num(f.statementFee) ?? expectedFee;
    s = expected + expectedFee - (stated + statedFee);
  }
  const rounded = roundMinor(s, minorUnit);
  return rounded > 0 ? rounded : 0;
}

/** «طلب · كشف · التفسير» — the note written on the charge, so nobody needs to open the statement to read it. */
export function shortfallNote(p: { orderNumber: string; reference: string; explanation: string | null }): string {
  return `${p.orderNumber} · ${p.reference} · ${p.explanation?.trim() || '—'}`;
}

/** A DATE column holds a day: the UTC midnight of the moment. */
export function dayOf(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/* ───────────────────────────── the approval's half ───────────────────────────── */

export interface ShortfallCandidate {
  matchId: string;
  orderId: string;
  orderNumber: string;
  expectedAmount: Num;
  expectedFee?: Num;
  statementAmount: Num;
  statementFee?: Num;
  claimPayment?: boolean;
  /** The reason the person wrote beside «اعتُمد رقم الشركة». */
  explanation: string | null;
}

export interface ShortfallScope {
  companyId: string;
  storeId: string;
  /** The person pressing «اعتماد». */
  approverId: string;
  statement: { id: string; reference: string; currencyCode: string; importedAt: Date };
  /** The day written on a charge whose order carries no delivery date of its own. */
  fallbackDeliveredAt: Date;
  minorUnit: number;
  /** The approver's answer for the lines the door could not name: a person's id, or `COMPANY`. */
  naming?: Record<string, string>;
}

export interface ShortfallCharge {
  penaltyId: string;
  userId: string;
  userName: string;
  matchId: string;
  orderNumber: string;
  amount: number;
  currencyCode: string;
}

export interface UnnamedLine {
  matchId: string;
  orderNumber: string;
  amount: number;
  currencyCode: string;
}

export type ShortfallStop =
  | { code: 'SHORTFALL_UNNAMED'; lines: UnnamedLine[]; candidates: { id: string; name: string; role: string }[] }
  | { code: 'SHORTFALL_BAD_PERSON'; lines: { matchId: string; orderNumber: string; why: string }[] };

export interface ShortfallResult {
  charges: ShortfallCharge[];
  /** Lines the approver chose to leave on the company. */
  onCompany: { matchId: string; orderNumber: string; amount: number }[];
  /** Set when the approval cannot go on: the whole transaction is rolled back and this is the answer. */
  stop: ShortfallStop | null;
}

/**
 * WRITES THE SHORTFALL CHARGES OF ONE APPROVAL — inside the approval's transaction, after the orders are settled.
 *
 * Reads nothing when no line is short, so an approval without a shortfall is exactly what it was. Everything it
 * writes is a PROPOSED row: nothing becomes a deduction until a person decides, or payday applies it in the
 * payer's name (payroll).
 */
export async function proposeShortfalls(
  tx: Tx,
  scope: ShortfallScope,
  candidates: ShortfallCandidate[]
): Promise<ShortfallResult> {
  const result: ShortfallResult = { charges: [], onCompany: [], stop: null };

  const owing = candidates
    .map((c) => ({ c, amount: shortfallOf(c, scope.minorUnit) }))
    .filter((x) => x.amount > 0);
  if (owing.length === 0) return result;

  const orderIds = owing.map((x) => x.c.orderId);
  const orders = await tx.order.findMany({
    where: { id: { in: orderIds }, companyId: scope.companyId },
    select: { id: true, shippingStatus: true, deliveredAt: true, moderatorId: true, confirmedById: true },
  });
  const orderOf = new Map(orders.map((o) => [o.id, o]));

  // A parcel coming back is paid nothing because it was not delivered, not because somebody kept the money.
  const collected = owing.filter((x) => {
    const o = orderOf.get(x.c.orderId);
    return !!o && !COMING_BACK.includes(o.shippingStatus);
  });
  if (collected.length === 0) return result;

  // The door: the latest delivered attempt made BEFORE the import, by whoever pressed it.
  const attempts = await tx.deliveryAttempt.findMany({
    where: {
      companyId: scope.companyId,
      orderId: { in: collected.map((x) => x.c.orderId) },
      result: { in: [...DOOR_RESULTS] },
      createdAt: { lt: scope.statement.importedAt },
    },
    orderBy: { createdAt: 'desc' },
    select: { orderId: true, deliveryAgentId: true },
  });
  const doorOf = new Map<string, string | null>();
  for (const a of attempts) if (!doorOf.has(a.orderId)) doorOf.set(a.orderId, a.deliveryAgentId);

  // Everybody who could carry a line: the door's people and the ones the approver named.
  const naming = scope.naming ?? {};
  const wantedIds = new Set<string>();
  for (const x of collected) {
    const door = doorOf.get(x.c.orderId);
    if (door) wantedIds.add(door);
    const named = naming[x.c.matchId];
    if (named && named !== ON_THE_COMPANY) wantedIds.add(named);
  }
  const users = wantedIds.size
    ? await tx.user.findMany({
        where: { id: { in: [...wantedIds] }, companyId: scope.companyId, status: 'ACTIVE' },
        select: { id: true, name: true, role: true },
      })
    : [];
  const userOf = new Map(users.map((u) => [u.id, u]));

  // One live charge per line: a line that already carries one is never charged again.
  const already = await tx.penalty.findMany({
    where: {
      settlementMatchId: { in: collected.map((x) => x.c.matchId) },
      status: { in: ['PROPOSED', 'APPLIED'] },
    },
    select: { settlementMatchId: true },
  });
  const held = new Set(already.map((p) => p.settlementMatchId));

  const unnamed: UnnamedLine[] = [];
  const bad: { matchId: string; orderNumber: string; why: string }[] = [];
  const toCharge: { x: (typeof collected)[number]; user: { id: string; name: string } }[] = [];

  for (const x of collected) {
    if (held.has(x.c.matchId)) continue;
    const order = orderOf.get(x.c.orderId)!;

    // The door names the person. An owner or a manager on the door is not charged, and not replaced by the
    // attempt before it either: the line is then the approver's to name.
    const door = doorOf.get(x.c.orderId);
    const doorUser = door ? userOf.get(door) : undefined;
    if (doorUser && mayCarryShortfall(doorUser.role)) {
      toCharge.push({ x, user: doorUser });
      continue;
    }

    const named = naming[x.c.matchId];
    if (named === ON_THE_COMPANY) {
      result.onCompany.push({ matchId: x.c.matchId, orderNumber: x.c.orderNumber, amount: x.amount });
      continue;
    }
    if (!named) {
      unnamed.push({ matchId: x.c.matchId, orderNumber: x.c.orderNumber, amount: x.amount, currencyCode: scope.statement.currencyCode });
      continue;
    }

    const person = userOf.get(named);
    const why = !person
      ? 'الموظف غير موجود أو غير فعّال'
      : !mayCarryShortfall(person.role)
        ? 'المالك والمدراء لا يتحمّلون فرق التحصيل'
        : person.id === scope.approverId
          ? 'لا تسمِّ نفسك'
          : person.id === order.moderatorId || person.id === order.confirmedById
            ? 'مؤكّد الطلب أو مودريتره لا يتحمّل فرق التحصيل — هو باع ولم يتابع الطرد'
            : null;
    if (why) {
      bad.push({ matchId: x.c.matchId, orderNumber: x.c.orderNumber, why });
      continue;
    }
    toCharge.push({ x, user: person! });
  }

  if (bad.length > 0) {
    result.stop = { code: 'SHORTFALL_BAD_PERSON', lines: bad };
    return result;
  }
  if (unnamed.length > 0) {
    const candidatesList = await tx.user.findMany({
      where: { companyId: scope.companyId, status: 'ACTIVE', role: { notIn: [...NEVER_CHARGED_ROLES] }, id: { not: scope.approverId } },
      select: { id: true, name: true, role: true },
      orderBy: { name: 'asc' },
    });
    result.stop = { code: 'SHORTFALL_UNNAMED', lines: unnamed, candidates: candidatesList };
    return result;
  }

  for (const { x, user } of toCharge) {
    const order = orderOf.get(x.c.orderId)!;
    const penalty = await tx.penalty.create({
      data: {
        companyId: scope.companyId,
        storeId: scope.storeId,
        userId: user.id,
        ruleId: null,
        kind: SHORTFALL_KIND,
        occurredOn: dayOf(order.deliveredAt ?? scope.fallbackDeliveredAt),
        units: 1,
        chargedUnits: 1,
        amount: x.amount,
        currencyCode: scope.statement.currencyCode,
        status: 'PROPOSED',
        note: shortfallNote({ orderNumber: x.c.orderNumber, reference: scope.statement.reference, explanation: x.c.explanation }),
        settlementMatchId: x.c.matchId,
      },
      select: { id: true },
    });
    result.charges.push({
      penaltyId: penalty.id,
      userId: user.id,
      userName: user.name,
      matchId: x.c.matchId,
      orderNumber: x.c.orderNumber,
      amount: x.amount,
      currencyCode: scope.statement.currencyCode,
    });
    await tx.orderActivity.create({
      data: {
        companyId: scope.companyId,
        orderId: x.c.orderId,
        userId: scope.approverId,
        action: 'SHORTFALL_PROPOSED',
        metadata: JSON.stringify({
          statement: scope.statement.reference,
          amount: x.amount,
          currency: scope.statement.currencyCode,
          employee: user.id,
        }),
      },
    });
  }

  for (const c of result.onCompany) {
    const x = collected.find((y) => y.c.matchId === c.matchId)!;
    await tx.orderActivity.create({
      data: {
        companyId: scope.companyId,
        orderId: x.c.orderId,
        userId: scope.approverId,
        action: 'SHORTFALL_ON_COMPANY',
        metadata: JSON.stringify({ statement: scope.statement.reference, amount: c.amount, currency: scope.statement.currencyCode }),
      },
    });
  }

  return result;
}
