import type { Prisma } from '@prisma/client';
import type { db as Db } from './db';
import { zonedParts, zonedTimeToInstant, type BusinessCalendar } from './business-calendar';

type Client = Prisma.TransactionClient | typeof Db;

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE PRIVATE WIN-BACK LIST — the owner's ruling 25/11 («A + 1 (modified). Proceed.»).
 *
 *   · Every agent picked by the bulk run gets her OWN list: the win-back orders handed to her. She holds each one (`claimedById`, so
 *     every door she works an order through — the call, the confirmation, the edit — opens as for any order she holds) and the
 *     order carries `winbackListUserId` = her. That mark puts the row OUTSIDE her hand: the cap (`ownedCounts`), the contact-first
 *     gate, the 90-minute release, the idle / rounds releases, the returns of «لا يرد» and the manager's «رجّع كومة لا يرد» never
 *     read a row that carries it (`notOnAPrivateList`), and «طلباتي» does not list it — she opens her list herself.
 *   · It is never pulled. «اسحب التالي» reads only the pool, and no list order — live or let go — is in the pool
 *     (`notAWinbackListOrder` in `claimableWhere`): NEW orders always come first, the list is worked in idle time.
 *   · Three days from the hand-out (`winbackListAt`, never reset by an auto-move), what is still UNTOUCHED leaves her list for the
 *     win-back pool: unclaimed, unlisted, still marked «انعرض من قبل» (`winbackListAt` kept). Never the general pull, never a second
 *     order for its source (the source's `replacedBy` is set). A manager may hand it out again.
 *   · A list nobody touched for one FULL SHIFT — the store country's whole last business day — moves its untouched rows to the active
 *     agent with the fewest open list rows. «Active» = she recorded a contact attempt in that shift in this store. Nobody active, nothing
 *     moves. The 3-day clock is not reset.
 *
 * «UNTOUCHED» = still NEW and no contact attempt on the order at all. Only untouched rows ever move, so «since it reached her» and «ever»
 * are the same question for them.
 *
 * The 165 win-back orders handed out by hand on 25/11 (made by the single press, then transferred) carry NO list mark: nothing here reads
 * or writes them, and their SOURCE orders are out of the bulk pool because they are already offered (`replacedBy`).
 * ═══════════════════════════════════════════════════════════════════════
 */

/** Days a hand-out stays on an agent's list before what is untouched goes back to the win-back pool. */
export const LIST_DAYS = 3;
const DAY_MS = 86_400_000;

/** Every POOL reader: a win-back list order — on a list, or let go («انعرض من قبل») — is never in the general pull. */
export const notAWinbackListOrder = { winbackListAt: null } satisfies Prisma.OrderWhereInput;

/** Every reader that weighs an agent's HAND (cap, gate, releases, «طلباتي»): a row of a private list is outside it. */
export const notOnAPrivateList = { winbackListUserId: null } satisfies Prisma.OrderWhereInput;

/** Untouched: still NEW, and nobody tried to reach the customer on it. */
export const untouchedWhere = { confirmationStatus: 'NEW', contactAttempts: { none: {} } } satisfies Prisma.OrderWhereInput;

/** The open statuses a list row is worked in (the same open list as the queue's). */
const OPEN = ['NEW', 'IN_PROGRESS', 'NO_ANSWER', 'FOLLOW_UP_REQUIRED', 'POSTPONED'];

/** HER list: the open orders handed to her, which she still holds. */
export function listRowsWhere(scope: { companyId: string; storeId: string }, userId: string): Prisma.OrderWhereInput {
  return { ...scope, winbackListUserId: userId, claimedById: userId, confirmationStatus: { in: OPEN }, shippingStatus: 'NOT_READY' };
}

/** The win-back pool: list orders let go untouched — «انعرض من قبل» — that a manager may hand out again. */
export function offeredBeforeWhere(scope: { companyId: string; storeId: string }): Prisma.OrderWhereInput {
  return {
    ...scope,
    winbackListAt: { not: null },
    winbackListUserId: null,
    claimedById: null,
    confirmationStatus: 'NEW',
    shippingStatus: 'NOT_READY',
  };
}

/**
 * HAND ONE ORDER TO HER LIST — one conditional write: only a fresh win-back order nobody holds (`fresh`), or one let go from a list
 * (`rehand`). The clock starts here (a re-hand is a new hand-out). Never the cancelled source: only the new order is written.
 */
export async function handToList(
  client: Client,
  input: { companyId: string; storeId: string; orderId: string; agentId: string; byUserId: string; now: Date; rehand?: boolean }
): Promise<boolean> {
  const won = await client.order.updateMany({
    where: {
      id: input.orderId,
      companyId: input.companyId,
      storeId: input.storeId,
      claimedById: null,
      assignedToId: null,
      confirmationStatus: 'NEW',
      shippingStatus: 'NOT_READY',
      winbackListUserId: null,
      ...(input.rehand ? { winbackListAt: { not: null } } : { winbackListAt: null }),
    },
    data: {
      claimedById: input.agentId,
      claimedAt: input.now,
      currentOwnerId: input.agentId,
      winbackListUserId: input.agentId,
      winbackListAt: input.now,
      winbackListSince: input.now,
      version: { increment: 1 },
    },
  });
  if (won.count !== 1) return false;
  await client.orderActivity.create({
    data: {
      companyId: input.companyId,
      orderId: input.orderId,
      userId: input.byUserId,
      action: 'WINBACK_LISTED',
      metadata: JSON.stringify({ agentId: input.agentId, rehand: input.rehand === true }),
    },
  });
  return true;
}

/** THREE DAYS: what is still untouched leaves the list for the win-back pool, keeping «انعرض من قبل». Idempotent. */
export async function expireLists(client: Client, scope: { companyId: string; storeId: string }, now: Date): Promise<number> {
  const r = await client.order.updateMany({
    where: {
      ...scope,
      winbackListUserId: { not: null },
      winbackListAt: { lte: new Date(now.getTime() - LIST_DAYS * DAY_MS) },
      shippingStatus: 'NOT_READY',
      ...untouchedWhere,
    },
    data: {
      claimedById: null,
      claimedAt: null,
      currentOwnerId: null,
      signatureStatus: 'UNSIGNED',
      winbackListUserId: null,
      winbackListSince: null,
      version: { increment: 1 },
    },
  });
  return r.count;
}

/**
 * THE LAST FULL SHIFT — the store country's last whole business day before today (local), as an instant window. A weekend day is
 * skipped; null when the calendar cannot say (a broken zone).
 */
export function lastFullShift(cal: BusinessCalendar, now: Date): { start: Date; end: Date } | null {
  try {
    const today = zonedParts(now, cal.timezone);
    const [sh, sm] = cal.workHoursStart.split(':').map(Number);
    const [eh, em] = cal.workHoursEnd.split(':').map(Number);
    // Walk back from yesterday (local noon keeps the date arithmetic away from a midnight edge) to a working day.
    let probe = zonedTimeToInstant(cal.timezone, today.year, today.month, today.day, 12, 0);
    for (let i = 0; i < 14; i++) {
      probe = new Date(probe.getTime() - DAY_MS);
      const p = zonedParts(probe, cal.timezone);
      if (cal.weekendDays.includes(p.weekday)) continue;
      const start = zonedTimeToInstant(cal.timezone, p.year, p.month, p.day, sh || 0, sm || 0);
      const end = zonedTimeToInstant(cal.timezone, p.year, p.month, p.day, eh || 0, em || 0);
      if (end.getTime() > start.getTime() && end.getTime() <= now.getTime()) return { start, end };
    }
    return null;
  } catch {
    return null;
  }
}

export interface MovePlan {
  from: string;
  rows: string[];
}

/**
 * WHO MOVES, TO WHOM — pure. `idle`: the holders who touched nothing in the shift, each with her untouched rows (received before the
 * shift began). `active`: the agents who worked in the shift and may receive, each with her open list count. Each row goes, one by
 * one, to the active agent with the fewest open rows at that moment (ties: the order given). Nobody active: nothing moves.
 */
export function planMoves(
  idle: ReadonlyArray<{ userId: string; rows: string[] }>,
  active: ReadonlyArray<{ userId: string; open: number }>
): Array<{ orderId: string; from: string; to: string }> {
  const load = active.map((a) => ({ ...a }));
  const out: Array<{ orderId: string; from: string; to: string }> = [];
  for (const holder of idle) {
    for (const orderId of holder.rows) {
      const choices = load.filter((a) => a.userId !== holder.userId);
      if (choices.length === 0) continue;
      const to = choices.reduce((best, a) => (a.open < best.open ? a : best));
      to.open += 1;
      out.push({ orderId, from: holder.userId, to: to.userId });
    }
  }
  return out;
}

/**
 * ONE FULL SHIFT UNTOUCHED → MOVE. `eligible`: the agents of this store who may be handed an order (the bulk run's own list). Idempotent:
 * a moved row's `winbackListSince` is now, after the shift, so it is not read again for the same shift; the 3-day clock is kept.
 */
export async function autoMoveIdleLists(
  client: Client,
  scope: { companyId: string; storeId: string },
  cal: BusinessCalendar,
  now: Date,
  eligible: readonly string[]
): Promise<number> {
  const shift = lastFullShift(cal, now);
  if (!shift || eligible.length === 0) return 0;

  const waiting = await client.order.findMany({
    where: { ...scope, winbackListUserId: { not: null }, winbackListSince: { lt: shift.start }, shippingStatus: 'NOT_READY', ...untouchedWhere },
    orderBy: [{ winbackListAt: 'asc' }, { id: 'asc' }],
    select: { id: true, winbackListUserId: true },
    take: 5000,
  });
  if (waiting.length === 0) return 0;
  const holders = [...new Set(waiting.map((w) => w.winbackListUserId!))];

  // Who worked in the shift, in this store — a contact attempt on any order of the store. One read for every holder and every candidate.
  const worked = await client.orderContactAttempt.findMany({
    where: { companyId: scope.companyId, createdAt: { gte: shift.start, lt: shift.end }, order: { storeId: scope.storeId } },
    select: { employeeId: true, order: { select: { winbackListUserId: true } } },
    take: 50_000,
  });
  // A holder touched her list if she recorded an attempt on one of HER list orders, or decided one (a status line by her on it).
  const touchedList = new Set(worked.filter((w) => w.order?.winbackListUserId === w.employeeId).map((w) => w.employeeId));
  const decided = await client.orderStatusLog.findMany({
    where: { companyId: scope.companyId, createdAt: { gte: shift.start, lt: shift.end }, changedById: { in: holders }, order: { storeId: scope.storeId, winbackListUserId: { in: holders } } },
    select: { changedById: true, order: { select: { winbackListUserId: true } } },
    take: 50_000,
  });
  for (const d of decided) if (d.order?.winbackListUserId === d.changedById) touchedList.add(d.changedById);

  const idleHolders = holders.filter((h) => !touchedList.has(h));
  if (idleHolders.length === 0) return 0;
  const activeIds = [...new Set(worked.map((w) => w.employeeId))].filter((id) => eligible.includes(id));
  if (activeIds.length === 0) return 0;

  const open = await client.order.groupBy({
    by: ['winbackListUserId'],
    where: { ...scope, winbackListUserId: { in: activeIds }, confirmationStatus: { in: OPEN } },
    _count: { _all: true },
  });
  const openOf = new Map(open.map((g) => [g.winbackListUserId as string, g._count._all]));
  const moves = planMoves(
    idleHolders.map((h) => ({ userId: h, rows: waiting.filter((w) => w.winbackListUserId === h).map((w) => w.id) })),
    activeIds.map((id) => ({ userId: id, open: openOf.get(id) ?? 0 }))
  );

  let moved = 0;
  for (const m of moves) {
    const won = await client.order.updateMany({
      where: { id: m.orderId, ...scope, winbackListUserId: m.from, claimedById: m.from, ...untouchedWhere },
      data: { claimedById: m.to, claimedAt: now, currentOwnerId: m.to, winbackListUserId: m.to, winbackListSince: now, version: { increment: 1 } },
    });
    if (won.count !== 1) continue;
    moved += 1;
    await client.orderActivity.create({
      data: { companyId: scope.companyId, orderId: m.orderId, userId: null, action: 'WINBACK_LIST_MOVED', metadata: JSON.stringify({ from: m.from, to: m.to }) },
    });
  }
  return moved;
}
