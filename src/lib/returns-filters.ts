import type { Prisma } from '@prisma/client';
import { orderSearchOr } from './order-filters';
import { SHIPPING_STATUS_AR } from './shipping-workflow';
import {
  AGES,
  AGE_AR,
  AGE_FROM,
  ageOf,
  ageWhereOn,
  daysWaitedOf,
  isAge,
  sinceOf as sinceOfColumns,
  type Age,
} from './age-piles';

/**
 * WHAT A RETURNS CLERK ASKS OF THE PARCELS COMING BACK, WRITTEN AS THE QUESTION THE DATABASE ANSWERS.
 *
 * «المرتجعات — صفحات + فلاتر + بحث». The desk already had pages (#42) and a box
 * that matched the order number, the reference and the waybill. It had no way
 * to say «only the ones the courier failed to deliver», «only this company's
 * parcels», «what has been sitting for over a week» — and no way to look back at
 * what was counted in yesterday, which is how a supervisor checks a count.
 *
 * ── TWO VIEWS, NOT ONE LIST WITH A SWITCH ──
 *
 *   pending  — the parcels announced and not yet counted in: the work. The four
 *              shipping states the desk has always listed, and no receipt.
 *   received — the ones that were: a receipt exists, whatever the order's state
 *              has become since. A record, with no button.
 *
 * ── THE AGE OF A PARCEL ──
 *
 * «منذ متى» is the moment the courier last said something about it, and the four
 * states keep that moment in four different columns: `returnedAt` once it is
 * back, `failedAt` for a failed delivery, `deliveredAt` for the part the
 * customer took, and nothing at all for a return that was only requested — so
 * `updatedAt` stands in. One word, two writings, as the postponed list does it:
 * `sinceOf` reads a row, `ageWhere` asks the database, and
 * `returns-filters.test.ts` runs both over every boundary and the fallbacks.
 *
 * ── THE SEARCH, AND WHOSE PHONE IT MAY CONFIRM ──
 *
 * The warehouse is not shown the customer's phone or address (`maySeeContact` is
 * `customers.view`). A box that matched phones for them would be an oracle: type
 * a number, see which parcel appears. So the phone clauses of the shared builder
 * are dropped when the person may not read phones; the name stays, because the
 * clerk is shown it.
 *
 * This module imports nothing from the server: the screen reads it too.
 */

export const VIEWS = ['pending', 'received'] as const;
export type View = (typeof VIEWS)[number];
/** Where the desk has always opened: the work. */
export const DEFAULT_VIEW: View = 'pending';
export const VIEW_AR: Record<View, string> = {
  pending: 'بانتظار الاستلام',
  received: 'تم استلامها',
};

/** The four shipping states of a return nobody has counted in — the list the desk has always read. */
export const RETURN_STATUSES = ['RETURN_REQUESTED', 'RETURNED', 'FAILED_DELIVERY', 'PARTIALLY_DELIVERED'] as const;
export type ReturnStatus = (typeof RETURN_STATUSES)[number];
export const STATUS_AR: Record<ReturnStatus, string> = {
  RETURN_REQUESTED: SHIPPING_STATUS_AR.RETURN_REQUESTED,
  RETURNED: SHIPPING_STATUS_AR.RETURNED,
  FAILED_DELIVERY: SHIPPING_STATUS_AR.FAILED_DELIVERY,
  PARTIALLY_DELIVERED: SHIPPING_STATUS_AR.PARTIALLY_DELIVERED,
};

/**
 * «بلا باركود» (the owner, 13/11: «وضيف للفلتر بلا باركود»): the parcels the courier gave no barcode. A BLANK barcode is no barcode — the
 * screen draws both as «—» and the copy button is OFF for both — so the question is «null or empty», the same one the tracking list and
 * the owner's closeout ask. The filter has ONE value; «all» and an absent value mean no filter.
 */
export const BARCODE_FILTERS = ['none'] as const;
export type BarcodeFilter = (typeof BARCODE_FILTERS)[number];
export const isBarcodeFilter = (v: unknown): v is BarcodeFilter => typeof v === 'string' && (BARCODE_FILTERS as readonly string[]).includes(v);

/** «Nobody» as a courier: the parcel has no delivery company on it. */
export const NO_COURIER = 'none';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isCourierFilter = (v: unknown): v is string => typeof v === 'string' && (v === NO_COURIER || UUID.test(v));

// The piles, their lines and their words are written once, in `age-piles.ts` — the shipment follow-up reads the same four.
export { AGES, AGE_AR, AGE_FROM, ageOf, daysWaitedOf, isAge };
export type { Age };

export const isView = (v: unknown): v is View => typeof v === 'string' && (VIEWS as readonly string[]).includes(v);
export const isStatus = (v: unknown): v is ReturnStatus => typeof v === 'string' && (RETURN_STATUSES as readonly string[]).includes(v);
export const MAX_SEARCH_LENGTH = 100;

// ───────────────────────── the age, read twice ─────────────────────────

/** The four columns a parcel's moment can live in, in the order they are read. `updatedAt` is never null. */
const SINCE_COLUMNS = ['returnedAt', 'failedAt', 'deliveredAt', 'updatedAt'] as const;

type DateLike = Date | string | null | undefined;
export interface SinceSource {
  returnedAt?: DateLike;
  failedAt?: DateLike;
  deliveredAt?: DateLike;
  updatedAt?: DateLike;
}

type Where = Prisma.OrderWhereInput;

/** The moment the courier last spoke of this parcel: the first of the four columns that has a date. */
export const sinceOf = (row: SinceSource): Date | null => sinceOfColumns(row, SINCE_COLUMNS);

/** The database's reading of each pile, over the same four columns in the same order. */
export const ageWhere = (age: Age, now: Date): Where => ageWhereOn(SINCE_COLUMNS, age, now);

// ───────────────────────── the scope, the words, the search ─────────────────────────

export interface ReturnsScope {
  companyId: string;
  storeId: string;
}

/**
 * EVERY PARCEL THE VIEW READS — and nothing wider.
 *
 * The company and the store are the person's; the rest is the view's. What the
 * reader chose is ANDed onto this and never replaces it.
 */
export function viewScope(view: View, scope: ReturnsScope): Where {
  const mine = { companyId: scope.companyId, storeId: scope.storeId };
  return view === 'pending'
    ? { ...mine, shippingStatus: { in: [...RETURN_STATUSES] }, returnReceipt: null }
    : { ...mine, returnReceipt: { isNot: null } };
}

export const courierWhere = (courier: string): Where => ({ deliveryProviderId: courier === NO_COURIER ? null : courier });

/** The parcels with no barcode: none written, or a blank one. */
export const noBarcodeWhere: Where = { OR: [{ trackingNumber: null }, { trackingNumber: '' }] };

/**
 * THE SHARED SEARCH, MINUS WHAT THIS PERSON MAY NOT CONFIRM.
 *
 * One builder for every order search (`orderSearchOr`); a clause that reads the customer's phone is dropped when
 * the person is not allowed to see phones. The clauses are told apart by what they match, not by their position,
 * so a field added to the builder reaches this list without being copied here.
 */
export function returnsSearch(q: string, maySeeContact: boolean): Where {
  const clauses = orderSearchOr(q) as Where[];
  const reads = (c: Where, field: string) => !!c.customer && typeof c.customer === 'object' && field in (c.customer as object);
  return {
    OR: maySeeContact ? clauses : clauses.filter((c) => !reads(c, 'phone') && !reads(c, 'rawPhone')),
  };
}

export interface ReturnsFilterInput {
  now: Date;
  /** `customers.view` — the same bar the rows are redacted by. */
  maySeeContact: boolean;
}

export interface ReturnsApplied {
  view: View;
  status: ReturnStatus | null;
  courier: string | null;
  age: Age | null;
  q: string | null;
  /** Present only when the parcels with no barcode were asked for. */
  barcode?: BarcodeFilter;
}

export type ReturnsFilterResult =
  | { ok: true; view: View; clauses: Where[]; applied: ReturnsApplied }
  | { ok: false; error: string; errorAr: string };

/**
 * THE URL'S FILTERS, READ ONCE, IN ONE PLACE.
 *
 * `all` and an absent value mean «no filter» — except the view, which always is one. A value this module does not
 * know is REFUSED, in Arabic, rather than ignored: ignoring it answers a question nobody asked with a list nobody
 * filtered. The status and the age describe a parcel that has not been counted in, so they are checked in either
 * view and APPLIED in the pending one only — a saved link from the other view does not make the record empty.
 */
export function returnsFilters(params: URLSearchParams, input: ReturnsFilterInput): ReturnsFilterResult {
  const refuse = (what: string, arabic: string, value: string): ReturnsFilterResult => ({
    ok: false,
    error: `Unknown ${what}: ${value}`,
    errorAr: `${arabic} غير معروف: ${value}`,
  });
  const word = (name: string) => {
    const raw = params.get(name)?.trim();
    return raw && raw !== 'all' ? raw : undefined;
  };

  const rawView = word('view');
  if (rawView && !isView(rawView)) return refuse('returns view', 'العرض', rawView);
  const view: View = (rawView as View | undefined) ?? DEFAULT_VIEW;

  const applied: ReturnsApplied = { view, status: null, courier: null, age: null, q: null };
  const clauses: Where[] = [];

  const status = word('status');
  if (status) {
    if (!isStatus(status)) return refuse('return status', 'الحالة', status);
    if (view === 'pending') {
      applied.status = status;
      clauses.push({ shippingStatus: status });
    }
  }

  const courier = word('courier');
  if (courier) {
    if (!isCourierFilter(courier)) return refuse('courier', 'شركة الشحن', courier);
    applied.courier = courier;
    clauses.push(courierWhere(courier));
  }

  // «بلا باركود» narrows either view: a parcel that was counted in has a barcode or not just the same.
  const barcode = word('barcode');
  if (barcode) {
    if (!isBarcodeFilter(barcode)) return refuse('barcode filter', 'فلتر الباركود', barcode);
    applied.barcode = barcode;
    clauses.push(noBarcodeWhere);
  }

  const age = word('age');
  if (age) {
    if (!isAge(age)) return refuse('age', 'العمر', age);
    if (view === 'pending') {
      applied.age = age;
      clauses.push(ageWhere(age, input.now));
    }
  }

  const q = params.get('q')?.trim().slice(0, MAX_SEARCH_LENGTH);
  if (q) {
    applied.q = q;
    clauses.push(returnsSearch(q, input.maySeeContact));
  }

  return { ok: true, view, clauses, applied };
}

/**
 * THE ORDER, AND WHY IT IS THE ONE IT IS.
 *
 * Pending: oldest first, as it has always been — the parcel that has sat longest is the one costing money. The
 * return date comes first; the three states that have none (a failed delivery, a part-delivery, a bare request)
 * follow, each by its own date, and the id ends the list so two parcels with the same moment can never swap
 * between pages. Received: the latest count first.
 */
export const PENDING_ORDER_BY: Prisma.OrderOrderByWithRelationInput[] = [
  { returnedAt: { sort: 'asc', nulls: 'last' } },
  { failedAt: { sort: 'asc', nulls: 'last' } },
  { deliveredAt: { sort: 'asc', nulls: 'last' } },
  { updatedAt: 'asc' },
  { id: 'asc' },
];
export const RECEIVED_ORDER_BY: Prisma.OrderOrderByWithRelationInput[] = [{ returnReceipt: { inspectedAt: 'desc' } }, { id: 'asc' }];
