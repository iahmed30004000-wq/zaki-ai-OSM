import { CORE_STATES, whereForState, type CoreState } from './order-state';
import { whereClosed } from './order-closing';
import { normalizePhoneNumber } from './phone';
import { typed } from './text-search';

/**
 * THE ORDERS LIST'S «WHERE», WRITTEN ONCE.
 *
 * Three places asked the same question of the same table and answered it
 * three different ways:
 *
 *   GET /api/orders            the list on screen
 *   GET /api/reports/export    the CSV of «what I am looking at»
 *   GET /api/orders/:id        the ‹previous› and ‹next› arrows
 *
 * They had drifted, and each drift is something a person sees and cannot
 * explain:
 *
 *   · Scanning a courier barcode into the search box found the parcel in
 *     the list and found NOTHING in the CSV of that same search — the
 *     export's search looked at the order number, the name and the phone,
 *     and not at `trackingNumber` or `merchantRef`.
 *   · The arrows filtered on the LEGACY `status` column. The list stopped
 *     doing that deliberately — its own comment says «the legacy status
 *     column drifts from confirmation/shipping status, so filtering on it
 *     returned rows the screen was calling something else» — and the
 *     arrows were never brought along. With a state filter active they
 *     walked a different set, or none.
 *   · The arrows knew nothing of the governorate, the courier, the source,
 *     the dates or «late»: filter the list six ways, open an order, press
 *     ‹next›, and you leave the list you were reading.
 *
 * The export route has already been patched twice for exactly this — its
 * own comments record the CSV that ignored «متأخرة ١٠ أيام» and the one
 * that ignored the role's visibility envelope. A comment that says «keep
 * this in step with the other file» is the defect, not the fix.
 *
 * So: one function, three callers, and a test that asks all three the same
 * question and fails if the answers differ.
 *
 * WHAT IS NOT HERE, and why:
 *   · the tenant (`companyId`/`storeId`) — the caller already resolved it;
 *   · `createdAt` — the list takes the dates as given, while the export
 *     forces a ninety-day window and clamps a wider one. Two rules, both
 *     deliberate, so each caller passes its own resolved range;
 *   · `applyQueueFilter` — it needs the session and decides which queues a
 *     role may use at all. It wraps the result of this function.
 */

export interface OrdersWhereInput {
  /** Already resolved by the caller: the list's from/to, or the export's clamped window. */
  createdAt?: { gte?: Date; lte?: Date };
}

export type OrdersWhereResult =
  | { ok: true; where: Record<string, unknown> }
  | { ok: false; error: string };

/** The states that close an order: a delivered parcel from last year is finished, not late. */
const CLOSED_SHIPPING = ['DELIVERED', 'PARTIALLY_DELIVERED', 'RETURNED', 'CANCELLED'];
const CLOSED_CONFIRMATION = ['CANCELLED', 'REJECTED'];

/**
 * ═══════════════════════════════════════════════════════════════════════
 * EVERYTHING A PARCEL IN SOMEBODY'S HAND CAN BE IDENTIFIED BY.
 *
 * A label carries two references — our merchant reference in the QR and
 * the courier's barcode printed beside it — so a scan must find the order
 * by either. The phone is matched both as typed and normalised, because a
 * person searches with the spacing they read off a screen.
 *
 * LIFTED OUT OF `ordersWhere` SO «إنشاء شحنة» CAN ASK THE SAME QUESTION.
 *
 * That screen had no search at all, and the obvious way to give it one is
 * to write a second `OR` beside this one. Then the two drift: somebody
 * adds a field here, the shipment screen does not get it, and «بحثت عنه
 * بالطلبات ولقيته وما لقيته بالشحنات» is a bug report nobody can read.
 * One builder, two callers.
 *
 * `withCity` is off by default ON PURPOSE. Adding the city to the orders
 * list's search would change what today's searches return — a governorate
 * typed into the box would start matching every customer in it — and
 * nobody asked for that. «إنشاء شحنة» is sorted by where parcels go, so
 * there the city is the point.
 * ═══════════════════════════════════════════════════════════════════════
 */
export function orderSearchOr(
  search: string,
  opts: { withCity?: boolean } = {}
): Record<string, unknown>[] {
  const normalised = normalizePhoneNumber(search);
  return [
    { orderNumber: typed(search) },
    { merchantRef: typed(search) },
    { trackingNumber: typed(search) },
    { customer: { fullName: typed(search) } },
    { customer: { phone: typed(normalised || search) } },
    { customer: { rawPhone: typed(search) } },
    ...(opts.withCity ? [{ customer: { city: typed(search) } }] : []),
  ];
}

export function ordersWhere(params: URLSearchParams, input: OrdersWhereInput = {}): OrdersWhereResult {
  const where: Record<string, unknown> = {};
  const and: unknown[] = [];

  const moderatorId = params.get('moderatorId')?.trim();
  if (moderatorId && moderatorId !== 'all') where.moderatorId = moderatorId;

  /*
   * THE SAME STATE THE ROW IS LABELLED WITH.
   *
   * `status` on the table is the legacy combined column and the schema
   * says so. Everything a person reads comes from the derived state, so
   * everything a person filters by must come from it too.
   */
  const status = params.get('status')?.trim();
  if (status && status !== 'all') {
    /*
     * «مغلق» is not a core state — it is the closed ZONE with both of its
     * stages finished (the money settled, the goods received), the ruling
     * `closingStages` makes and `whereClosed` renders as a query. It sits
     * beside the states in the dropdown because that is how the owner reads
     * the list: finished work in one pile, whatever the winning state was.
     */
    if (status === 'CLOSED') {
      and.push(whereClosed());
    } else if (!CORE_STATES.includes(status as CoreState)) {
      return { ok: false, error: `حالة غير معروفة: ${status}` };
    } else {
      // A state nothing can currently be in returns nothing, rather than
      // silently returning everything.
      and.push(whereForState(status as CoreState) ?? { id: '' });
    }
  }

  const productId = params.get('productId')?.trim();
  if (productId && productId !== 'all') {
    /*
     * «OF THIS PRODUCT» MEANS ANY LINE, NOT ONLY THE FIRST (RV75).
     *
     * `Order.productId` is the legacy column and names the FIRST line's product. The reports and the grades count the
     * LINES, so an order of two products showed under the second in the reports and not under «كل الطلبات على هذا المنتج»
     * nor on the product page's «أحدث الطلبات». The order matches when its first line is the product (the column, kept
     * for a row written before it had lines) or when any of its lines is. It is an extra clause in the AND list, so the
     * search box's own `OR` is left whole, and every caller still ANDs it onto its own scope.
     */
    and.push({ OR: [{ productId }, { items: { some: { productId } } }] });
  }

  const regionId = params.get('regionId')?.trim();
  if (regionId && regionId !== 'all') where.regionId = regionId;

  // Which courier is carrying it — 'none' finds the ones nobody has taken.
  const courierId = params.get('courierId')?.trim();
  if (courierId && courierId !== 'all') {
    where.deliveryProviderId = courierId === 'none' ? null : courierId;
  }

  const source = params.get('source')?.trim();
  if (source && source !== 'all') where.source = source;

  /*
   * «Late» is measured from `shippedAt`, never `createdAt`: from creation,
   * an order that waited a week to be confirmed and shipped yesterday
   * showed as eight days late and the courier was blamed for the
   * confirmation queue. An order that has not shipped cannot be late in
   * transit, and `lte` on a null `shippedAt` excludes it with no extra test.
   */
  const lateDays = params.get('lateDays')?.trim();
  if (lateDays) {
    const days = Number(lateDays);
    if (!Number.isFinite(days) || days < 1 || days > 365) {
      return { ok: false, error: 'عدد أيام غير صالح' };
    }
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    and.push(
      { shippedAt: { lte: cutoff } },
      { shippingStatus: { notIn: CLOSED_SHIPPING } },
      { confirmationStatus: { notIn: CLOSED_CONFIRMATION } }
    );
  }

  const search = params.get('q')?.trim();
  if (search) {
    where.OR = orderSearchOr(search);
  }

  if (input.createdAt && (input.createdAt.gte || input.createdAt.lte)) {
    where.createdAt = input.createdAt;
  }

  if (and.length > 0) where.AND = and;
  return { ok: true, where };
}

/** Every parameter this builder reads — the list of what a caller may forward. */
export const ORDER_FILTER_PARAMS = [
  'q',
  'status',
  'productId',
  'moderatorId',
  'regionId',
  'courierId',
  'source',
  'lateDays',
] as const;

/**
 * THE SAME GRAMMAR, WRITTEN RATHER THAN READ.
 *
 * Everything above turns a query string into a `where`. A screen needs the
 * other direction: the ten controls a person has set, as the one query
 * string that asks for them. Two things need it and they must not each
 * invent it —
 *
 *   · «العروض المحفوظة» stores a view AS a query string and nothing else,
 *     so a saved view is only as faithful as this function;
 *   · the CSV export forwards the filters it was asked for.
 *
 * ABSENT, `''` AND `'all'` ARE ONE THING — read `ordersWhere` above: every
 * branch is `if (value && value !== 'all')`. So the canonical form OMITS a
 * filter that is not set, and a saved view carries only what was chosen.
 * That is also why a short query string and a long one with six `=all` in
 * it return the same rows: this is a shorter spelling, not a second rule.
 *
 * AND APPLYING A VIEW CLEARS WHAT IS NOT IN IT. `orderFiltersFromQuery`
 * starts from `EMPTY_ORDER_FILTERS`, so recalling «المتأخرة — أرامكس» shows
 * exactly that and not that plus whatever was already on the screen. «Show
 * me this view» is the request; «add this to what I have» is not.
 */
export interface OrderFilterValues {
  /** Free text: order number, merchant ref, tracking, name or phone. */
  q: string;
  status: string;
  productId: string;
  source: string;
  courierId: string;
  regionId: string;
  /** `YYYY-MM-DD`, inclusive. Read by the routes, not by the builder. */
  from: string;
  to: string;
  /** Days late since SHIPPING. `''` when the «المتأخرة» switch is off. */
  lateDays: string;
}

/** Every filter at rest — and the value each control shows when unset. */
export const EMPTY_ORDER_FILTERS: OrderFilterValues = {
  q: '',
  status: 'all',
  productId: 'all',
  source: 'all',
  courierId: 'all',
  regionId: 'all',
  from: '',
  to: '',
  lateDays: '',
};

/** What the builder treats as «no filter», in its own words: `v && v !== 'all'`. */
const UNSET_FILTER = new Set(['', 'all']);

/** The filters a screen holds, as the query string that asks for them. */
export function orderFiltersToQuery(values: Partial<OrderFilterValues>): string {
  const params = new URLSearchParams();
  for (const key of Object.keys(EMPTY_ORDER_FILTERS) as (keyof OrderFilterValues)[]) {
    const value = (values[key] ?? '').trim();
    if (UNSET_FILTER.has(value)) continue;
    params.set(key, value);
  }
  return params.toString();
}

/** A stored query string, back as the controls that produced it. */
export function orderFiltersFromQuery(query: string): OrderFilterValues {
  const params = new URLSearchParams(query.replace(/^\?/, ''));
  const out = { ...EMPTY_ORDER_FILTERS };
  for (const key of Object.keys(EMPTY_ORDER_FILTERS) as (keyof OrderFilterValues)[]) {
    const raw = params.get(key);
    if (raw === null) continue;
    const value = raw.trim();
    // An empty value in a stored string is «unset», not «filter by nothing».
    out[key] = value === '' ? EMPTY_ORDER_FILTERS[key] : value;
  }
  return out;
}
