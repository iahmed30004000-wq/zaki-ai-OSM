import type { Prisma } from '@prisma/client';
import { REJECTION_REASONS } from './confirmation-workflow';
import { orderSearchOr } from './order-filters';
import { typed } from './text-search';
import { receiptCameBackWhere } from './written-off';
import { LOST_STATUSES, NEVER_WINBACK_REASONS, type WinbackRule } from './winback';

/**
 * WHAT A SUPERVISOR ASKS OF THE LOST ORDERS, WRITTEN AS THE QUESTION THE DATABASE ANSWERS.
 *
 * «استرجاع الملغى — اعملو صفحات + فلاتر + بحث». The list used to read the last
 * five hundred lost orders from the last 120 days, ask «is this one eligible?»
 * of each in memory, and show what was left — so the five hundred was cut
 * BEFORE the question, a month with six hundred lost orders silently lost the
 * oldest hundred, and there was no way to page, narrow or search what remained.
 *
 * Eligibility now lives in the query. `winbackVerdict` is still the one rule —
 * written in JS, for the row, with its reason in words — and `viewWhere` is the
 * same rule written for the database. `winback-filters.test.ts` runs the two
 * over the same orders, at every boundary, and fails the day they disagree:
 * that is the only way «جاهز (23)» stays a promise that twenty-three rows will
 * appear.
 *
 * ── THE THREE VIEWS PARTITION THE LOST ORDERS ──
 *
 *   ready   — passes everything, and the cooling is over: the work;
 *   cooling — passes everything but the cooling: would be work in a few days;
 *   skipped — fails something else: shipped and not back, back and not
 *             received, already offered, itself a second chance, a reason the
 *             rule does not call for, or no closing date.
 *
 * Disjoint and exhaustive within the look-back — an order is in exactly one,
 * and the row says which rule put it there.
 *
 * TWO KINDS SINCE 28/10 («هل بيعرض الملغي قبل الشحن وبعد ؟ … خليه يجري ع ال 2»):
 * lost before it shipped, and — while the owner's switch is on — shipped and
 * come back, received by the desk. Each kind is its own candidate with its own
 * closing date; the views are the two read side by side, and with the switch
 * off every clause below is the one it was before.
 *
 * NO NEW COLUMN. The closing date of a lost order is what it always was: the
 * LAST confirmation log row whose new value is a lost status («an order
 * rejected, re-opened and rejected again cools from the second time»), written
 * as «there is such a row, and none newer than the cooling cutoff». A return's
 * is its receipt's `inspectedAt` — one receipt per order, so one date.
 *
 * AND NO NULL REACHES A `NOT`. The database answers a comparison with an empty
 * column with «unknown», and NOT of unknown is unknown — so a clause that can
 * meet a NULL under a NOT would drop that order from every view at once. Every
 * condition below either cannot meet one or names it.
 *
 * This module imports nothing from the server: the screen reads it too.
 */

const DAY = 86_400_000;

export const VIEWS = ['ready', 'cooling', 'skipped'] as const;
export type View = (typeof VIEWS)[number];
/** Where the screen has always opened: the orders worth a call today. */
export const DEFAULT_VIEW: View = 'ready';
export const VIEW_AR: Record<View, string> = {
  ready: 'جاهز للاتصال',
  cooling: 'ما زال في المهلة',
  skipped: 'مستثنى من القاعدة',
};

/** «آخر N يوماً» — how long ago it was cancelled. */
export const PERIODS = ['7', '30', '90'] as const;
export type Period = (typeof PERIODS)[number];
export const PERIOD_AR: Record<Period, string> = { '7': 'آخر 7 أيام', '30': 'آخر 30 يوماً', '90': 'آخر 90 يوماً' };

/**
 * «الشحن» — before it shipped, or after. One fact separates the two, whether the
 * parcel ever left, so the two options hold every order of a view between them.
 */
export const SHIPPING_KINDS = ['before', 'after'] as const;
export type ShippingKind = (typeof SHIPPING_KINDS)[number];
export const SHIPPING_KIND_AR: Record<ShippingKind, string> = { before: 'قبل الشحن', after: 'بعد الشحن' };

export const isView = (v: unknown): v is View => typeof v === 'string' && (VIEWS as readonly string[]).includes(v);
export const isPeriod = (v: unknown): v is Period => typeof v === 'string' && (PERIODS as readonly string[]).includes(v);
export const isShippingKind = (v: unknown): v is ShippingKind =>
  typeof v === 'string' && (SHIPPING_KINDS as readonly string[]).includes(v);
export const isReason = (v: unknown): v is string => typeof v === 'string' && (REJECTION_REASONS as readonly string[]).includes(v);
export const MAX_PRODUCT_LENGTH = 120;
export const MAX_SEARCH_LENGTH = 100;

type Where = Prisma.OrderWhereInput;

/** A confirmation-log row recording a loss — the only rows whose date is «when it was cancelled». */
const lostLog = (extra: Prisma.OrderStatusLogWhereInput = {}): Prisma.OrderStatusLogWhereInput => ({
  statusType: 'CONFIRMATION',
  newValue: { in: [...LOST_STATUSES] },
  ...extra,
});

export interface WinbackScope {
  companyId: string;
  storeId?: string | null;
}

/** A parcel that left and came back — `returnedAfterShipping` in `winback.ts`, written for the database. */
const cameBack = (): Where => ({ shippingStatus: 'RETURNED', shippedAt: { not: null } });

/**
 * EVERY LOST ORDER THE RULE READS — and nothing wider.
 *
 * The company and store are the person's; the lost words, the switch and the
 * look-back are the rule's. An order made longer ago than the look-back is not
 * in any view, which is also what the offer's verdict says of it (`TOO_OLD`) —
 * by when the order was made, for a return as for a cancellation.
 *
 * With the switch on, «lost» is «lost before it shipped, OR shipped and came
 * back»: a return that nobody has received yet is read too, so the screen can
 * say why it is not called yet instead of hiding it. With it off, the base is
 * exactly what it was.
 */
export function baseWhere(scope: WinbackScope, rule: WinbackRule, now: Date): Where {
  const lost: Where = { confirmationStatus: { in: [...LOST_STATUSES] } };
  return {
    companyId: scope.companyId,
    ...(scope.storeId ? { storeId: scope.storeId } : {}),
    // At the top as an OR, never as an AND: the page and the counts spread this and add an `AND` of their own.
    ...(rule.afterShipping === true ? { OR: [lost, cameBack()] } : lost),
    createdAt: { gte: new Date(now.getTime() - rule.lookbackDays * DAY) },
  };
}

/**
 * Lost before it shipped, and passes every refusal in `winbackVerdict` except the cooling — written for the database.
 *
 * `not: null` beside the reasons is not decoration. An order with no reason on record answers `IN (…)` with
 * «unknown», and `skipped` is the NOT of this clause — so without it the order was in no view at all, while
 * the verdict calls it «أُلغي بلا سببٍ مُسجَّل» and `winback-list.test.ts` counts it among the refused.
 */
const candidate = (rule: WinbackRule): Where => ({
  shippedAt: null,
  replacedBy: null,
  replacesOrderId: null,
  rejectionReason: { in: [...rule.reasons], not: null },
  // It HAS a closing date: at least one loss was logged. No row, no date, no call.
  statusLogs: { some: lostLog() },
});

/** The latest loss is newer than the cutoff ⟺ some loss row is. */
const stillCooling = (rule: WinbackRule, now: Date): Where => ({
  statusLogs: { some: lostLog({ createdAt: { gt: new Date(now.getTime() - rule.coolingDays * DAY) } }) },
});

/**
 * Shipped, came back and RECEIVED, and passes every refusal in `winbackVerdict` except the cooling.
 *
 * No reason gates it — the courier's feed records none — except the four nobody may ring. A return usually
 * carries no reason at all, and a NULL is never `notIn` anything, so NULL is named on its own.
 */
const returnCandidate = (): Where => ({
  ...cameBack(),
  // A receipt that says nothing came back (a zero count, a write-off) closes the order; nobody holds goods to resell.
  returnReceipt: { is: receiptCameBackWhere() },
  replacedBy: null,
  replacesOrderId: null,
  OR: [{ rejectionReason: null }, { rejectionReason: { notIn: [...NEVER_WINBACK_REASONS] } }],
});

/** A return cools from its receipt: the same strict line as a loss, `received > now - days`, and its opposite. */
const returnCutoff = (rule: WinbackRule, now: Date) => new Date(now.getTime() - rule.coolingDays * DAY);
const returnCooling = (rule: WinbackRule, now: Date): Where => ({ returnReceipt: { is: { inspectedAt: { gt: returnCutoff(rule, now) } } } });
const returnCooled = (rule: WinbackRule, now: Date): Where => ({ returnReceipt: { is: { inspectedAt: { lte: returnCutoff(rule, now) } } } });

/** The before-shipping kind's three views — exactly the clauses the screen was built on. */
function lostView(view: View, rule: WinbackRule, now: Date): Where {
  switch (view) {
    case 'ready':
      return { AND: [candidate(rule), { NOT: stillCooling(rule, now) }] };
    case 'cooling':
      return { AND: [candidate(rule), stillCooling(rule, now)] };
    case 'skipped':
      return { NOT: candidate(rule) };
  }
}

/**
 * THE DATABASE'S READING OF EACH VIEW.
 *
 * `ready` is «a candidate, and not cooling»; `cooling` is «a candidate, and
 * cooling»; `skipped` is «not a candidate». The cutoff is `gt`, strictly, the
 * same line `winbackVerdict` draws: cooling is `now < closed + days`, which is
 * `closed > now - days`.
 *
 * With the switch on, «a candidate» is either kind, and each kind cools from
 * its own date. The two candidates cannot overlap — one needs `shippedAt`
 * empty and the other needs it set — so an order is still in exactly one view.
 */
export function viewWhere(view: View, rule: WinbackRule, now: Date): Where {
  if (rule.afterShipping !== true) return lostView(view, rule, now);
  switch (view) {
    case 'ready':
      return { OR: [lostView('ready', rule, now), { AND: [returnCandidate(), returnCooled(rule, now)] }] };
    case 'cooling':
      return { OR: [lostView('cooling', rule, now), { AND: [returnCandidate(), returnCooling(rule, now)] }] };
    case 'skipped':
      return { NOT: { OR: [candidate(rule), returnCandidate()] } };
  }
}

export const reasonWhere = (reason: string): Where => ({ rejectionReason: reason });
export const productWhere = (name: string): Where => ({ productNameSnapshot: name });
/**
 * Cancelled within the last N days — by the date of a loss row, not by when the order was made. With the
 * switch on, a return is «cancelled» on the day the desk received it, the same day its cooling counts from:
 * without it, «آخر 7 أيام» would hide every return whatever its date.
 */
export const periodWhere = (period: Period, now: Date, rule: WinbackRule): Where => {
  const since = new Date(now.getTime() - Number(period) * DAY);
  const lostWithin: Where = { statusLogs: { some: lostLog({ createdAt: { gte: since } }) } };
  if (rule.afterShipping !== true) return lostWithin;
  return {
    OR: [lostWithin, { ...cameBack(), returnReceipt: { is: { AND: [receiptCameBackWhere(), { inspectedAt: { gte: since } }] } } }],
  };
};
/** «قبل الشحن» is a parcel that never left, «بعد الشحن» one that did — whatever became of it since. */
export const shippingWhere = (kind: ShippingKind): Where => (kind === 'before' ? { shippedAt: null } : { shippedAt: { not: null } });

export interface WinbackFilterInput {
  now: Date;
  rule: WinbackRule;
}

export interface WinbackApplied {
  view: View;
  reason: string | null;
  product: string | null;
  period: Period | null;
  shipping: ShippingKind | null;
  q: string | null;
}

export type WinbackFilterResult =
  | { ok: true; view: View; viewClause: Where; clauses: Where[]; applied: WinbackApplied }
  | { ok: false; error: string; errorAr: string };

/**
 * THE URL'S FILTERS, READ ONCE, IN ONE PLACE.
 *
 * `all` and an absent value mean «no filter» — except the view, which is never
 * «all»: a list that mixed the work with the refused would be the screen it
 * replaced. A value this module does not know is REFUSED, in Arabic, rather
 * than ignored, because ignoring one answers a question nobody asked with a
 * list nobody filtered.
 */
export function winbackFilters(params: URLSearchParams, input: WinbackFilterInput): WinbackFilterResult {
  const refuse = (what: string, arabic: string, value: string): WinbackFilterResult => ({
    ok: false,
    error: `Unknown ${what}: ${value}`,
    errorAr: `${arabic} غير معروف: ${value}`,
  });
  const word = (name: string) => {
    const raw = params.get(name)?.trim();
    return raw && raw !== 'all' ? raw : undefined;
  };

  const rawView = word('view');
  if (rawView && !isView(rawView)) return refuse('winback view', 'العرض', rawView);
  const view: View = (rawView as View | undefined) ?? DEFAULT_VIEW;

  const applied: WinbackApplied = { view, reason: null, product: null, period: null, shipping: null, q: null };
  const clauses: Where[] = [];

  const reason = word('reason');
  if (reason) {
    if (!isReason(reason)) return refuse('rejection reason', 'سبب الإلغاء', reason);
    applied.reason = reason;
    clauses.push(reasonWhere(reason));
  }

  const product = word('product')?.slice(0, MAX_PRODUCT_LENGTH);
  if (product) {
    applied.product = product;
    clauses.push(productWhere(product));
  }

  const period = word('period');
  if (period) {
    if (!isPeriod(period)) return refuse('period', 'المدّة', period);
    applied.period = period;
    clauses.push(periodWhere(period, input.now, input.rule));
  }

  const shipping = word('shipping');
  if (shipping) {
    if (!isShippingKind(shipping)) return refuse('shipping kind', 'الشحن', shipping);
    applied.shipping = shipping;
    clauses.push(shippingWhere(shipping));
  }

  const q = params.get('q')?.trim().slice(0, MAX_SEARCH_LENGTH);
  if (q) {
    applied.q = q;
    clauses.push({ OR: [...(orderSearchOr(q) as Where[]), { productNameSnapshot: typed(q) }] });
  }

  return { ok: true, view, viewClause: viewWhere(view, input.rule, input.now), clauses, applied };
}

/**
 * Oldest ORDER first, then the id: the ones closest to falling out of the look-back are the ones to call
 * while they still can be. (Ordering by the closing date would be the better word, and a database can only
 * order by a related row's date with a raw query; the order's age is the same ordering for every order closed
 * once, which is nearly all of them.)
 */
export const WINBACK_ORDER_BY: Prisma.OrderOrderByWithRelationInput[] = [{ createdAt: 'asc' }, { id: 'asc' }];
