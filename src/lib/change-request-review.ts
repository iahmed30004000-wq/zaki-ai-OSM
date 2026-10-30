import { moneyText } from './money';
import type { EditDoor, FromTo, PriceBasis, PublicStockEffect, Totals } from './order-line-edit';

/**
 * WHAT THE PERSON WHO DECIDES A `lines` REQUEST IS SHOWN — THE SHAPE, AND THE ONE QUESTION «WHAT MOVED SINCE?».
 *
 * «حتى لما رفعت طلب تعديل ما ظهر بطلبات التعديل» and «طلب التعديل أقدر أعدل كذا شغلة بنفس الوقت … والأهم الحساب والمخزون».
 * A request that edits several lines stores the numbers the raiser saw. The person deciding it may read it an hour
 * later, on an order that has moved on: another line saved, a delivery fee rewritten, the shelf sold down. So the screen
 * does not show what was STORED as if it were true now — it shows what the stored request would do to the order NOW
 * (`change-request-review-facts.ts`, the same engine the apply door asks), beside what was shown when it was raised, and
 * says in a sentence what has moved.
 *
 * This file is the client-safe half: the types the endpoint answers with and the comparison. It adds, multiplies and
 * prices nothing — every figure arrives from the engine, and two figures are only ever compared, within half of the
 * currency's smallest unit (the tolerance the apply door uses to say «the total moved»).
 *
 * A response never carries what the order cost or earned: no cost, no profit, no margin, and not the engine's
 * `revenue` either — a decision about a quantity is not a reason to read the books.
 */

/** The money of an order at one moment: what the courier collects, and the pieces it is made of. */
export interface ReviewTotals {
  /** The lines, before the order's discount. */
  subtotal: number;
  discount: number;
  deliveryFee: number;
  addOns: number;
  /** What the courier collects. */
  cod: number;
  giftUnits: number;
}

/** The engine's totals, less the two things a decision screen does not need (the per-line shares, and `revenue`). */
export function reviewTotals(t: Totals): ReviewTotals {
  return { subtotal: t.subtotal, discount: t.discount, deliveryFee: t.deliveryFee, addOns: t.addOns, cod: t.cod, giftUnits: t.giftUnits };
}

/** One line of the order, before and after — the product named, never an id the reader would have to look up. */
export interface ReviewLine {
  lineId: string;
  changed: boolean;
  productName: FromTo<string>;
  quantity: FromTo<number>;
  freeQuantity: FromTo<number>;
  /** Before the order's discount, for the paid units. */
  lineTotal: FromTo<number>;
  unitPrice: FromTo<number>;
  /** After the order's discount — what the courier is told this line comes to. `null` when the result could not be worked out. */
  totalAfterDiscount: number | null;
  basis: PriceBasis | null;
}

export interface ReviewProblem {
  code: string;
  /** Stops the request being approved (and, when it is already approved, carried out). */
  blocking: boolean;
  messageAr: string;
  lineId?: string;
}

export const DRIFT_KINDS = ['LINES', 'TOTAL', 'RESULT', 'FEE', 'DISCOUNT', 'SHELF', 'DOOR'] as const;
export type DriftKind = (typeof DRIFT_KINDS)[number];

export interface DriftItem {
  kind: DriftKind;
  messageAr: string;
}

/**
 * WHAT HAS MOVED SINCE THE REQUEST WAS RAISED.
 *
 * `known: false` means the request carries no record of what it was raised against (an older one): nothing can be said
 * to have moved, and the screen says there is no record rather than «nothing changed».
 */
export interface Drift {
  known: boolean;
  moved: boolean;
  items: DriftItem[];
}

export interface ReviewPreview {
  requestId: string;
  /** The order's lines are no longer the ones the request was raised on: there is no «after» to show. */
  stale: boolean;
  /** Every line of the order, in the order they are priced. When `stale`, the lines the request recorded instead. */
  lines: ReviewLine[];
  /** The order as it stands now. */
  before: ReviewTotals;
  /** The order as it would stand now if the request were carried out, from the stored figures. `null` when `stale`. */
  after: ReviewTotals | null;
  /** The shelf, per product: the order's own units and a verdict — never how many the warehouse holds. */
  stock: PublicStockEffect[];
  /** Everything that stops the request, then everything worth a look. Blocking first. */
  problems: ReviewProblem[];
  /** At least one problem stops it: the button that carries it out is shut, with the reasons beside it. */
  blocked: boolean;
  drift: Drift;
  door: EditDoor;
  orderVersion: number;
  minorUnit: number;
}

/* ═══════════════════════════ reading what the request recorded ═══════════════════════════ */

/** What a stored request remembers of the moment it was raised — read defensively, because it is only ever a record. */
export interface RaisedSnapshot {
  before: Partial<ReviewTotals>;
  after: Partial<ReviewTotals>;
  lineOrder: string[] | null;
  stock: Array<{ productId: string; productName: string; enough: boolean }>;
  door: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function totalsOf(v: unknown): Partial<ReviewTotals> {
  if (!isRecord(v)) return {};
  const out: Partial<ReviewTotals> = {};
  for (const key of ['subtotal', 'discount', 'deliveryFee', 'addOns', 'cod', 'giftUnits'] as const) {
    const n = num(v[key]);
    if (n !== undefined) out[key] = n;
  }
  return out;
}

/** The snapshot of a stored `lines` request, or `null` when there is none worth reading. */
export function readRaisedSnapshot(snapshot: unknown): RaisedSnapshot | null {
  if (!isRecord(snapshot)) return null;
  const before = totalsOf(snapshot.before);
  const after = totalsOf(snapshot.after);
  if (Object.keys(before).length === 0 && Object.keys(after).length === 0) return null;
  const lineOrder = Array.isArray(snapshot.lineOrder) && snapshot.lineOrder.every((x) => typeof x === 'string') ? (snapshot.lineOrder as string[]) : null;
  const stock = Array.isArray(snapshot.stock)
    ? snapshot.stock.flatMap((s) =>
        isRecord(s) && typeof s.productId === 'string' && typeof s.enough === 'boolean'
          ? [{ productId: s.productId, productName: typeof s.productName === 'string' ? s.productName : '', enough: s.enough }]
          : []
      )
    : [];
  return { before, after, lineOrder, stock, door: typeof snapshot.door === 'string' ? snapshot.door : null };
}

/* ═══════════════════════════ what moved ═══════════════════════════ */

/** Half a minor unit: two figures within it are the same figure at this currency's precision. */
const near = (a: number, b: number, minorUnit: number): boolean => Math.abs(a - b) <= 0.5 / 10 ** Math.max(0, minorUnit) + 1e-9;

const say = (n: number, minorUnit: number): string => moneyText(n, null, minorUnit);

const DOOR_AR: Record<string, string> = {
  DIRECT: 'يتعدّل مباشرة',
  REQUEST: 'يمرّ بطلب تعديل',
  REQUEST_REPRINT: 'يمرّ بطلب وتُعاد البوليصة',
  COURIER_ACTION: 'الطرد عند شركة الشحن',
  CLOSED: 'مغلق',
};

export function reviewDrift(input: {
  snapshot: unknown;
  /** The order as it stands now, and as it would stand with the request in it (`null` when the lines moved). */
  nowBefore: ReviewTotals;
  nowAfter: ReviewTotals | null;
  /** How many lines the order has now. */
  lineCount: number;
  /** The lines the request recorded are no longer there as they were. */
  stale: boolean;
  stock: readonly PublicStockEffect[];
  door: EditDoor;
  minorUnit: number;
}): Drift {
  const raised = readRaisedSnapshot(input.snapshot);
  if (!raised) return { known: false, moved: false, items: [] };

  const mu = input.minorUnit;
  const items: DriftItem[] = [];
  const add = (kind: DriftKind, messageAr: string) => items.push({ kind, messageAr });

  if (input.stale) {
    add('LINES', 'أسطر الطلب تغيّرت منذ الرفع — الطلب ما عاد ينطبق عليها.');
  } else if (raised.lineOrder && raised.lineOrder.length !== input.lineCount) {
    add('LINES', `عدد أسطر الطلب تغيّر منذ الرفع (كان ${raised.lineOrder.length}، صار ${input.lineCount}).`);
  }

  const moved = (was: number | undefined, now: number) => was !== undefined && !near(was, now, mu);
  if (moved(raised.before.cod, input.nowBefore.cod)) {
    add('TOTAL', `إجمالي الطلب تغيّر منذ الرفع (كان ${say(raised.before.cod as number, mu)}، صار ${say(input.nowBefore.cod, mu)}).`);
  }
  if (moved(raised.before.deliveryFee, input.nowBefore.deliveryFee)) {
    add('FEE', `أجرة التوصيل تغيّرت منذ الرفع (كانت ${say(raised.before.deliveryFee as number, mu)}، صارت ${say(input.nowBefore.deliveryFee, mu)}).`);
  }
  if (moved(raised.before.discount, input.nowBefore.discount)) {
    add('DISCOUNT', `خصم الطلب تغيّر منذ الرفع (كان ${say(raised.before.discount as number, mu)}، صار ${say(input.nowBefore.discount, mu)}).`);
  }
  if (input.nowAfter && moved(raised.after.cod, input.nowAfter.cod)) {
    add('RESULT', `الإجمالي بعد التعديل صار ${say(input.nowAfter.cod, mu)} بدل ${say(raised.after.cod as number, mu)} اللي انعرض وقت الرفع.`);
  }

  const nowStock = new Map(input.stock.map((s) => [s.productId, s]));
  for (const was of raised.stock) {
    const now = nowStock.get(was.productId);
    if (!now || now.enough === was.enough) continue;
    const name = now.productName || was.productName || 'منتج';
    add('SHELF', now.enough ? `المخزون صار يكفي لـ${name}.` : `المخزون ما عاد يكفي لـ${name}.`);
  }

  if (raised.door && raised.door !== input.door) {
    add('DOOR', `مرحلة الطلب تغيّرت منذ الرفع (كانت: ${DOOR_AR[raised.door] ?? raised.door}، صارت: ${DOOR_AR[input.door] ?? input.door}).`);
  }

  return { known: true, moved: items.length > 0, items };
}

/* ═══════════════════════════ what the button says ═══════════════════════════ */

/** The sentence under a shut button: the blocking reasons, each once, in the order they were found. */
export function shutReason(problems: readonly ReviewProblem[]): string | null {
  const reasons = [...new Set(problems.filter((p) => p.blocking).map((p) => p.messageAr))];
  return reasons.length === 0 ? null : reasons.join(' — ');
}

/** The reason the buttons are shut when the check itself could not be made. A request nobody could check is not approved. */
export const REVIEW_UNAVAILABLE_AR = 'تعذّر فحص الطلب على حالة الطلب الآن — أعد المحاولة قبل الموافقة.';
