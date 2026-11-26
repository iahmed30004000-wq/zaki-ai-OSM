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

/**
 * Every POOL reader: a NEW order that carries the win-back mark — handed out, or let go («انعرض من قبل») — is never in the general pull.
 * THE MARK SPEAKS ONLY WHILE THE ORDER IS NEW (the review of 25/11): an order of any other status that still carries it is in the normal
 * flow for its status (a postponed one is pulled on its date, a «لا يرد» one by the rounds). So no exit — a release, a hand-back, an issue,
 * a stand-down, a release after a claim by id — can leave a row in no queue. Written as an OR of two plain clauses (no NOT, no NULL under a
 * NOT). It sits at the top of `claimableWhere`: the one spread that sets its own `OR` after it, `duePostponedWhere`, asks POSTPONED —
 * never NEW — so the mark is inert there anyway.
 */
export const notAWinbackListOrder = { OR: [{ winbackListAt: null }, { confirmationStatus: { not: 'NEW' } }] } satisfies Prisma.OrderWhereInput;

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
    // an order with an open issue is not handed out until the moderator corrects it (the hand-out asks the same)
    issues: { none: { status: 'OPEN' } },
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
      confirmationStatus: 'NEW',
      shippingStatus: 'NOT_READY',
      winbackListUserId: null,
      // A fresh bulk-run order is born marked (`winbackListAt`); a re-hand takes one a list let go. Never an ordinary order.
      winbackListAt: { not: null },
      // Never an order with an open issue: it waits for the moderator's correction first.
      issues: { none: { status: 'OPEN' } },
    },
    data: {
      // Whatever name a transfer or a claim left on it goes: the pool asks for none, and the hand-out writes none.
      assignedToId: null,
      assignedAt: null,
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
      // a transfer named her (`assignedToId`); the pool and the re-hand both ask for nobody's name
      assignedToId: null,
      assignedAt: null,
      signatureStatus: 'UNSIGNED',
      winbackListUserId: null,
      winbackListSince: null,
      version: { increment: 1 },
    },
  });
  return r.count;
}

/**
 * THE LAST FULL SHIFT — the store's last whole WORKING DAY before today, in its own time zone: local 00:00 to the next local 00:00
 * (the coordinator's «شيك», 25/11). Not the configured work hours: agents here work past them — into the evening — and the list is
 * worked in idle time, so an attempt at 19:00 is work on that day. A weekend day is skipped; the day counts once it has ended (it ends
 * before today began, by construction). Local midnights are read from the zone, so a day of 23 or 25 hours (a DST change) is whole.
 * Null when the calendar cannot say (a broken zone).
 */
export function lastFullShift(cal: BusinessCalendar, now: Date): { start: Date; end: Date } | null {
  try {
    const today = zonedParts(now, cal.timezone);
    // Calendar arithmetic on the DATE (UTC noon of the local date), never on instants: a DST day is not 24 hours long.
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day, 12));
    for (let i = 0; i < 14; i++) {
      date.setUTCDate(date.getUTCDate() - 1);
      if (cal.weekendDays.includes(date.getUTCDay())) continue;
      const next = new Date(date.getTime() + DAY_MS);
      const start = zonedTimeToInstant(cal.timezone, date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), 0, 0);
      const end = zonedTimeToInstant(cal.timezone, next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0);
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

/**
 * LEAVING THE LIST — every way an order leaves a private list by somebody's hand (a release, a pull-back, a forced take, a hand-back, an
 * issue, a stand-down, a colleague taking it for the customer on the line, a claim by id) takes it OFF THE LIST: no list holder, no list
 * clock. The win-back mark (`winbackListAt`) STAYS, and the order's status decides (the review of 25/11):
 *   · still NEW and nobody holds it (a release, a pull-back, an issue raised) → it is «انعرض من قبل»: never pulled, handed out by a manager
 *     (and not while an issue is open);
 *   · dated or not NEW (a postponed hand-back, a stand-down, a «لا يرد») → the mark is inert and the order is in the normal flow for its
 *     status;
 *   · taken and held (the customer on the line, a claim by id, a forced take) → it is ordinary work in that hand; let go again, the same
 *     two rules apply.
 * A row that is on no list writes nothing new: an ordinary order's write is what it was.
 */
export const OFF_THE_LIST = { winbackListUserId: null, winbackListSince: null } as const;
export function offTheListIf(row: { winbackListUserId?: string | null } | null | undefined) {
  return row && row.winbackListUserId ? OFF_THE_LIST : {};
}
