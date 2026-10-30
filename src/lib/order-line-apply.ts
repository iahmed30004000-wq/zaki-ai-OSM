import type { ApprovedLineEdit, LinesChange } from './change-request-fields';
import { roundMinor } from './money';
import { inChunks } from './in-chunks';
import { readOrderEditFacts, type EditableOrderRow } from './order-edit-facts';
import {
  previewLineEdit,
  stockEffect,
  type LineEditInput,
  type OrderEditFacts,
  type PreviewDraft,
  type Problem,
  type StoredLine,
  type Totals,
} from './order-line-edit';
import { prepShortAr } from './prep-edit';
import { availableStock } from './reservation';

/**
 * CARRYING OUT AN APPROVED LINES REQUEST — WHAT THE ORDER ROUTE ASKS BEFORE IT WRITES A SINGLE ROW.
 *
 * `order-line-edit.ts` judges a DRAFT; this judges a DECISION. The difference is the whole file: a draft is a
 * suggestion and may be re-priced, but a request somebody approved says «this line, from 3 to 5, at 58, with 2 free»,
 * and the person who approved saw those numbers. Nothing is re-derived from today's offers or catalogue. What can be
 * checked is whether the order is still the order they approved a change TO.
 *
 * The rule is the owner's (28/10): refuse, do not guess. Every «no» here is a sentence and a code the screen reads:
 *
 *   LINES_STALE       a line the request names is not there as it was — a save rewrites the lines and gives them new
 *                     ids, so the id alone proves nothing; the values the request recorded as `from` decide.
 *   TOTAL_CHANGED     the order, with the approved lines in it, no longer comes to the total the decider was shown.
 *   FEE_SOURCE_DRIFT  the order carries two delivery fees; the save would collect one of them without saying which.
 *   COD_DRIFT         the stored total is not the lines' total; the save would quietly rewrite it.
 *   STATEMENT_LINKED  a courier statement claims the order; the statement writes the money, the door writes what happened.
 *   LINES_COMMITTED   a line was delivered or returned — a record, not a draft.
 *   CANCEL_AND_REORDER the company has the parcel: its goods are not edited from here.
 *   PRODUCT_INACTIVE  a product swapped in has been switched off since.
 *   STOCK_SHORT       the shelf cannot give what the lines need.
 *
 * It computes NO money: the route calls `computeCod` itself, and the figures here only choose which lines go in.
 */

/* ═══════════════════════════ binding the request to the stored lines ═══════════════════════════ */

/** Half a minor unit: two figures within it are the same figure at this currency's precision. */
const near = (a: number, b: number, minorUnit: number): boolean =>
  Math.abs(a - b) <= 0.5 / 10 ** Math.max(0, minorUnit) + 1e-9;

/** Does the line still read the way the request recorded it? Only what the request recorded is compared. */
function readsAsRecorded(line: StoredLine, edit: ApprovedLineEdit, minorUnit: number): boolean {
  const was = (v: number | string | null | undefined) => v !== undefined && v !== null;
  if (was(edit.productId?.from) && edit.productId!.from !== line.productId) return false;
  if (was(edit.quantity?.from) && edit.quantity!.from !== line.quantity) return false;
  if (was(edit.freeQuantity?.from) && edit.freeQuantity!.from !== line.freeQuantity) return false;
  if (was(edit.lineTotal?.from) && !near(edit.lineTotal!.from as number, line.lineTotal, minorUnit)) return false;
  return true;
}

const recordsAnything = (edit: ApprovedLineEdit): boolean =>
  [edit.productId?.from, edit.quantity?.from, edit.freeQuantity?.from, edit.lineTotal?.from].some(
    (v) => v !== undefined && v !== null
  );

export type Bound = { ok: true; bound: Array<{ edit: ApprovedLineEdit; line: StoredLine }> } | { ok: false; lineId: string };

/**
 * THE STORED LINE EACH EDIT MEANS — by id when the id is still there AND still reads as recorded; failing that, by the
 * recorded values, and only if exactly one line answers to them.
 *
 * Two lines that both read «3 × 12» are not told apart by a guess: an edit that fits both is refused. A line used for one
 * edit is not used for another. An edit that recorded no `from` at all cannot be found by value, so only its id can.
 */
export function bindApprovedEdits(stored: readonly StoredLine[], edits: readonly ApprovedLineEdit[], minorUnit: number): Bound {
  const taken = new Set<string>();
  const bound: Array<{ edit: ApprovedLineEdit; line: StoredLine }> = [];
  for (const edit of edits) {
    const byId = stored.find((s) => s.id === edit.lineId && !taken.has(s.id));
    let line: StoredLine | undefined;
    if (byId) {
      if (!readsAsRecorded(byId, edit, minorUnit)) return { ok: false, lineId: edit.lineId };
      line = byId;
    } else {
      if (!recordsAnything(edit)) return { ok: false, lineId: edit.lineId };
      const fits = stored.filter((s) => !taken.has(s.id) && readsAsRecorded(s, edit, minorUnit));
      if (fits.length !== 1) return { ok: false, lineId: edit.lineId };
      line = fits[0];
    }
    taken.add(line.id);
    bound.push({ edit, line });
  }
  return { ok: true, bound };
}

/**
 * THE SHORTHAND OF AN OLD REQUEST AS AN EDIT OF THE ORDER'S ONE LINE.
 *
 * `quantity`, `productId` and `sellingPrice` (the line's total for the quantity, taken whole and never scaled) describe an
 * order as if it were one line, and for an order with exactly one that is true. With no price the piece price the line
 * already had is kept — the behaviour the shorthand has always had, and the one the person who approved it expected —
 * never the offer's or the catalogue's.
 *
 * A PRICE IS TAKEN BECAUSE IT IS THERE, NOT BECAUSE IT DIFFERS. «ثبّت السعر على 50» beside a quantity of six, on a line that
 * already costs 50, asks for 50 for six; reading «same as now» as «no price» re-priced it by the piece (100) and asked the
 * customer for the difference. The route therefore hands over every shorthand key the request carried.
 */
export function flatGoodsEdit(
  line: StoredLine,
  flat: { quantity?: number; productId?: string; sellingPrice?: number }
): LineEditInput {
  return {
    lineId: line.id,
    ...(flat.productId !== undefined && flat.productId !== line.productId ? { productId: flat.productId } : {}),
    ...(flat.quantity !== undefined && flat.quantity !== line.quantity ? { quantity: flat.quantity } : {}),
    ...(flat.sellingPrice !== undefined ? { lineTotal: flat.sellingPrice } : { priceBasis: 'KEEP_UNIT' as const }),
  };
}

/**
 * An approved edit as the engine's draft line: what was approved is typed whole, so nothing is priced again.
 * Exported so the decider's preview (`change-request-review-facts.ts`) reads a request the way this door writes it — one mapping, not two.
 */
export function draftLineOf(edit: ApprovedLineEdit, line: StoredLine): LineEditInput {
  const goodsMoved = !!edit.productId || !!edit.quantity;
  return {
    lineId: line.id,
    ...(edit.productId ? { productId: edit.productId.to } : {}),
    ...(edit.quantity ? { quantity: edit.quantity.to } : {}),
    ...(edit.lineTotal ? { lineTotal: edit.lineTotal.to } : goodsMoved ? { priceBasis: 'KEEP_UNIT' as const } : {}),
  };
}

/* ═══════════════════════════ what an «no» says ═══════════════════════════ */

export interface Refusal {
  status: number;
  code: string;
  error: string;
}

const STALE_AR = 'تغيّرت أسطر الطلب منذ رفع طلب التعديل — ارفع طلباً جديداً.';
const COMMITTED_AR = 'لا يمكن تعديل بنود طلب حُجزت بضاعته أو خرج للشحن — عدّل الكميات من شاشة المرتجعات';
const MOVED_AR = 'إجمالي الطلب مع هالأسطر ما عاد هو الإجمالي اللي انعرض وقت الموافقة — ارفع طلباً جديداً.';
const HANDED_AR = 'الطرد عند شركة الشحن — أسطر الطلب ما بتتعدل بعد التسليم. ألغِ الطلب وأنشئ طلباً جديداً.';
const INACTIVE_AR = 'المنتج الجديد معطّل حالياً — ما بينضاف لطلب.';
const MISSING_PRODUCT_AR = 'أحد المنتجات غير موجود في هذه الشركة';
const DISCOUNT_AR = 'الخصم لا يمكن أن يتجاوز إجمالي قيمة الطلب';

export const linesStale = (): Refusal => ({ status: 409, code: 'LINES_STALE', error: STALE_AR });
export const totalChanged = (): Refusal => ({ status: 409, code: 'TOTAL_CHANGED', error: MOVED_AR });

/**
 * THE FIRST THING THAT STOPS A DECISION BEING CARRIED OUT, or null.
 *
 * `problems` is the engine's own list (blocking first, in a fixed order), so the answer does not depend on which check
 * happened to run first. A product switched off is a warning for a draft and a stop for a decision: the person who
 * approved it could not have seen it was off.
 */
export function refusalOf(problems: readonly Problem[]): Refusal | null {
  const hit = problems.find((p) => p.blocking) ?? problems.find((p) => p.code === 'PRODUCT_INACTIVE');
  if (!hit) return null;
  switch (hit.code) {
    case 'UNKNOWN_LINE':
      return linesStale();
    case 'LINE_SETTLED':
      return { status: 409, code: 'LINES_COMMITTED', error: COMMITTED_AR };
    case 'PARCEL_HANDED':
      return { status: 409, code: 'CANCEL_AND_REORDER', error: HANDED_AR };
    case 'PRODUCT_UNAVAILABLE':
      return { status: 404, code: 'PRODUCT_NOT_FOUND', error: MISSING_PRODUCT_AR };
    case 'PRODUCT_INACTIVE':
      return { status: 409, code: 'PRODUCT_INACTIVE', error: INACTIVE_AR };
    case 'DISCOUNT_EXCEEDS_TOTAL':
      return { status: 400, code: 'DISCOUNT_EXCEEDS_TOTAL', error: DISCOUNT_AR };
    case 'STOCK_SHORT_BLOCKED':
      return { status: 409, code: 'STOCK_SHORT', error: prepShortAr(hit.detail?.name ? [String(hit.detail.name)] : []) };
    default:
      return { status: 409, code: hit.code, error: hit.messageAr };
  }
}

/** The order with the approved lines in it no longer comes to what the decider was shown (the request recorded it). */
export function totalMoved(snapshot: LinesChange['snapshot'] | null | undefined, afterCod: number, minorUnit: number): boolean {
  const seen = snapshot?.after?.cod;
  return typeof seen === 'number' && Number.isFinite(seen) && !near(seen, afterCod, minorUnit);
}

/* ═══════════════════════════ the plan ═══════════════════════════ */

export interface LineAuditEntry {
  productId: string;
  qtyBefore: number;
  qtyAfter: number;
  totalBefore: number;
  totalAfter: number;
  giftBefore: number;
  giftAfter: number;
  /** Set only when the line was moved to another product. */
  productBefore?: string;
}

/** The lines an approved request leaves the order with, in the ONE order they are written. */
export interface LineApply {
  /** `unitPrice` is the line's TOTAL before the order's discount — the meaning the lines save has always given it. */
  items: Array<{ productId: string; quantity: number; unitPrice: number }>;
  /** The gift of each item, same index. Fixed by the request; nothing the browser sent. */
  gifts: number[];
  /** The stored line behind each item, same index — its attribution is carried over. */
  lineIds: string[];
  /**
   * What a line keeps of its reservation, same index: the units it held, when its product, quantity and gift are what they
   * were (a price moved, nothing else); null when the line's units changed and it must be reserved again. A price alone
   * must not make a line lose the stock it holds because the shelf has since been sold past it.
   */
  keepReserved: Array<number | null>;
  /** The order's lines as they were read, for the shelf's question and for the race check. */
  stored: StoredLine[];
  addOns: OrderEditFacts['addOns'];
  names: Map<string, string>;
  allowNegativeStock: boolean;
  audit: LineAuditEntry[];
  before: Totals;
  after: Totals;
}

export type Plan = { ok: true; apply: LineApply | null } | ({ ok: false } & Refusal);

export interface PlanInput {
  order: EditableOrderRow;
  companyId: string;
  country: { code: string; minorUnit: number; allowNegativeStock: boolean };
  /** The lines the request approved. Empty for an old request, which speaks the shorthand. */
  edits: readonly ApprovedLineEdit[];
  snapshot: LinesChange['snapshot'] | null;
  /** The shorthand fields that CHANGE something (equal to what the order has, they are not here). */
  flat: { quantity?: number; productId?: string; sellingPrice?: number };
  /** The discount the same request sets, if it does: it re-spreads over the lines, so it belongs to the same judgement. */
  discountAmount?: number;
}

/**
 * WHAT TO WRITE, OR WHY NOT.
 *
 * `apply: null` is not a refusal: it means the request has nothing to do with the order's lines (or, for an old
 * shorthand request, the order does not have exactly one — then the older, narrower rules answer as they always did).
 */
export async function planLineApply(input: PlanInput): Promise<Plan> {
  const mu = input.country.minorUnit;
  const lineMode = input.edits.length > 0;
  const flatAsked = input.flat.quantity !== undefined || input.flat.productId !== undefined || input.flat.sellingPrice !== undefined;
  if (!lineMode && !flatAsked) return { ok: true, apply: null };

  // The products the request names must be read BEFORE the lines are bound to it, so the draft read here only names
  // them; the real draft, with real line ids, is made once the lines are in hand.
  const named: LineEditInput[] = lineMode
    ? input.edits.map((e) => ({ lineId: e.lineId, ...(e.productId ? { productId: e.productId.to } : {}) }))
    : [{ lineId: 'shorthand', ...(input.flat.productId ? { productId: input.flat.productId } : {}) }];
  const facts = await readOrderEditFacts({
    order: input.order,
    companyId: input.companyId,
    country: input.country,
    draft: { lines: named, ...(input.discountAmount !== undefined ? { discountAmount: input.discountAmount } : {}) },
  });

  let drafted: LineEditInput[];
  const pinned = new Map<string, number>();
  if (lineMode) {
    const bound = bindApprovedEdits(facts.lines, input.edits, mu);
    if (!bound.ok) return { ok: false, ...linesStale() };
    drafted = bound.bound.map(({ edit, line }) => draftLineOf(edit, line));
    for (const { edit, line } of bound.bound) {
      if (edit.freeQuantity) pinned.set(line.id, edit.freeQuantity.to);
    }
  } else {
    // The older shorthand is an edit of a line only when there is exactly one to edit.
    if (facts.lines.length !== 1) return { ok: true, apply: null };
    const only = facts.lines[0];
    drafted = [flatGoodsEdit(only, input.flat)];
    /*
     * THE GIFT IS NOT RE-WORKED FOR A REQUEST THE DECIDER SAW WITHOUT ONE. «3 ← 6» on a line priced by today's «3 + 1» would
     * come out «1 ← 2» if the offer were asked, a free unit nobody approved. The older door kept the gift as the line held it
     * (carried by product), and so does this: pinned to what it is now — except on a swap to ANOTHER product, where the
     * gift of the old one is not carried across (as the lines save has always done).
     */
    pinned.set(only.id, input.flat.productId !== undefined && input.flat.productId !== only.productId ? 0 : only.freeQuantity);
  }

  const draft: PreviewDraft = {
    lines: drafted,
    ...(input.discountAmount !== undefined ? { discountAmount: input.discountAmount } : {}),
  };
  const preview = previewLineEdit(facts, draft, pinned);

  const refusal = refusalOf(preview.problems);
  if (refusal) return { ok: false, ...refusal };
  if (lineMode && totalMoved(input.snapshot, preview.after.cod, mu)) return { ok: false, ...totalChanged() };

  // Nothing the request asked for would change a line: the lines are left alone (no rewrite, no new reservation).
  if (preview.lines.every((l) => !l.changed)) return { ok: true, apply: null };

  // THE ORDER IS THE PREVIEW'S: the remainder of a discount that does not divide lands on the first largest line, so the
  // lines are written in the order they were priced in. They are taken from the preview by its own `lineOrder` — not read
  // again and sorted again.
  const byId = new Map(preview.lines.map((l) => [l.lineId, l]));
  const ordered = preview.lineOrder.map((id) => byId.get(id)!);

  return {
    ok: true,
    apply: {
      items: ordered.map((l) => ({ productId: l.productId.to, quantity: l.quantity.to, unitPrice: l.lineTotal.to })),
      gifts: ordered.map((l) => l.freeQuantity.to),
      lineIds: ordered.map((l) => l.lineId),
      keepReserved: ordered.map((l) => {
        const was = facts.lines.find((s) => s.id === l.lineId);
        return was && was.productId === l.productId.to && was.quantity === l.quantity.to && was.freeQuantity === l.freeQuantity.to
          ? was.reservedQty
          : null;
      }),
      stored: facts.lines,
      addOns: facts.addOns,
      names: new Map([...facts.lines.map((l) => [l.productId, l.productName] as const), ...facts.products.map((p) => [p.id, p.name] as const)]),
      allowNegativeStock: facts.allowNegativeStock,
      audit: ordered
        .filter((l) => l.changed)
        .map((l) => ({
          productId: l.productId.to,
          qtyBefore: l.quantity.from,
          qtyAfter: l.quantity.to,
          totalBefore: l.lineTotal.from,
          totalAfter: l.lineTotal.to,
          giftBefore: l.freeQuantity.from,
          giftAfter: l.freeQuantity.to,
          ...(l.productId.from !== l.productId.to ? { productBefore: l.productId.from } : {}),
        })),
      before: preview.before,
      after: preview.after,
    },
  };
}

/* ═══════════════════════════ the shelf, asked at the write ═══════════════════════════ */

type StockClient = Parameters<typeof availableStock>[0];

/**
 * THE PRODUCTS THE SHELF CANNOT COVER — asked per PRODUCT, the way the preview asks it.
 *
 * `reserveOrderLines` asks per LINE: it reserves each line against the whole shelf on its own, so a product on two lines
 * of 3 and 4 with 5 on the shelf reserves both (each fits alone) and promises 7 (RV400). The write therefore asks this
 * once more, after the lines are in and the stock locked, over the SUM of each product — and a shortage that is bigger
 * than the one the order already had stops the save. The stricter reading wins.
 *
 * Returns the names of the products that block. An order already short is not stopped by a gap that did not grow, and a
 * country that allows negative stock is told, not stopped (`stockEffect` holds both rules; this adds none).
 */
export async function blockedByStock(
  client: StockClient,
  a: {
    companyId: string;
    orderId: string;
    stored: readonly StoredLine[];
    next: ReadonlyArray<{ productId: string; quantity: number; freeQuantity: number }>;
    addOns: ReadonlyArray<{ productId: string; quantity: number }>;
    names: ReadonlyMap<string, string>;
    allowNegativeStock: boolean;
  }
): Promise<string[]> {
  const ids = [...new Set([...a.stored.map((l) => l.productId), ...a.next.map((l) => l.productId)])];
  const available: Record<string, number> = {};
  // Reads only, five at a time: the locks of the products were taken (in their fixed order) by the reserver before this.
  const counts = await inChunks(ids, (id) => availableStock(client, a.companyId, id, a.orderId));
  ids.forEach((id, i) => {
    available[id] = counts[i];
  });
  const effects = stockEffect({
    stored: a.stored,
    next: a.next,
    addOns: a.addOns,
    available,
    names: a.names,
    allowNegativeStock: a.allowNegativeStock,
    reserves: true,
  });
  return effects.filter((e) => e.status === 'SHORT_BLOCKED').map((e) => e.productName || e.productId);
}

/* ═══════════════════════════ the race, and the cost ═══════════════════════════ */

/** Thrown inside the write when the order's lines are not the ones the plan was made against; the route says LINES_STALE. */
export class LinesChanged extends Error {
  constructor(readonly courierCancelled = false) {
    super('LINES_CHANGED');
  }
}

/**
 * ARE THE ORDER'S LINES, AS THE WRITE FINDS THEM, THE ONES THE PLAN READ?
 *
 * Every save of the lines moves the order's version, and the write is conditional on it — but a line can also be added or
 * changed by a door that does not, so the write looks once more at the rows themselves before it deletes them.
 */
export function linesAreStill(
  rows: ReadonlyArray<{ id: string; productId: string; quantity: number; freeQuantity: number }>,
  stored: readonly StoredLine[]
): boolean {
  if (rows.length !== stored.length) return false;
  const now = new Map(rows.map((r) => [r.id, r]));
  return stored.every((s) => {
    const r = now.get(s.id);
    return !!r && r.productId === s.productId && r.quantity === s.quantity && r.freeQuantity === s.freeQuantity;
  });
}

/** Thrown inside the write when the request was stamped applied by someone else first; the route says ALREADY_APPLIED. */
export class AppliedMeanwhile extends Error {
  constructor(readonly courierCancelled = false) {
    super('APPLIED_MEANWHILE');
  }
}

export const APPLIED_AR = 'طُبّق هذا التعديل مسبقاً';

/** The products whose average cost the edit needs: those the changed lines were and became. */
export function costProductIds(changed: ReadonlyArray<LineAuditEntry>): string[] {
  return [...new Set(changed.flatMap((c) => [c.productId, c.productBefore ?? c.productId]))];
}

/**
 * WHAT THE GOODS ON THE ORDER COST US AFTER THE EDIT — a conservative ESTIMATE, by the share of the units.
 *
 * The order's estimated cost was struck once, from the batches of that day, and a line's share of it is not stored. Pricing
 * every line again at today's averages moved the profit of a line nobody touched; taking the OLD units off at TODAY's average
 * could cut it to nothing while a unit was still on the order (a cost of 12 for three, today's average 9: 12 + 9 − 27), or
 * leave the old product's cost standing beside the new one's. So the old figure is spread over the units it was struck for
 * (its own average per unit) and only the CHANGED lines move it:
 *
 *   FEWER units   — the units removed take their share OFF at the order's own average (cost × removed ÷ units before).
 *   MORE units    — the units added are put ON at today's average of the product, or at the order's own where the product has
 *                   no batch now.
 *   A SWAP        — the old line's units come off at the order's own average, the new product's go on at its today's average
 *                   (the order's own where it has none). Nothing is counted twice.
 *
 * Every unit that leaves the shelf counts, the gift included — a free unit is free to the customer, never to the shop. Never
 * below nothing; rounded at the currency's own unit.
 *
 * A COST THAT IS NOT KNOWN IS NOT INVENTED. An order struck at 0 (or with no units) has no per-unit figure to move: it is left
 * as it is and `kept` says so — only when a unit really moved — so the order can be told, on its timeline, that its cost was
 * not re-estimated.
 */
export function costAfterEdit(
  oldCost: number,
  unitsBefore: number,
  changed: ReadonlyArray<LineAuditEntry>,
  averageOf: (productId: string) => number,
  minorUnit: number
): { cost: number; kept: boolean } {
  const unitsMoved = changed.some((c) => c.qtyAfter + c.giftAfter !== c.qtyBefore + c.giftBefore || c.productBefore !== undefined);
  if (!(oldCost > 0) || !(unitsBefore > 0)) return { cost: oldCost, kept: unitsMoved };
  const own = oldCost / unitsBefore;
  const today = (productId: string) => {
    const average = averageOf(productId);
    return average > 0 ? average : own;
  };
  let moved = 0;
  for (const c of changed) {
    const before = c.qtyBefore + c.giftBefore;
    const after = c.qtyAfter + c.giftAfter;
    if (c.productBefore !== undefined) moved += today(c.productId) * after - own * before;
    else moved += after >= before ? today(c.productId) * (after - before) : -own * (before - after);
  }
  return { cost: Math.max(0, roundMinor(oldCost + moved, minorUnit)), kept: false };
}
