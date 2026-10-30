import { z } from 'zod';
import { roundMinor } from './money';

/**
 * WHAT A CHANGE REQUEST MAY TOUCH, AND WHAT EACH THING IS CALLED.
 *
 * One list, read by the route that accepts a request and by the dialog that
 * decides one. They used to keep a list each, and the lists had drifted:
 * the route accepted the city, the product, the offer and the notes, and
 * the dialog knew none of them — so four of the ten fields reached the
 * person deciding under their English code names, and three names in the
 * dialog belonged to fields no request could ever carry.
 *
 * Pure and client-safe: the dialog runs in the browser.
 */

/**
 * `regionId`, NOT `customerCity`.
 *
 * The city was free text and could not be applied at all: the order ships
 * to a REGION — the governorate the delivery fee is keyed on — and the
 * order route has no city field to write. So every request on it was
 * accepted, approved, and then refused with «عدّلها يدوياً»; it was
 * reported as «طلب تعديل: لا يمكن تعديل المدينة».
 *
 * The governorate is a real list and a real column, so the request can be
 * carried out to the end — which is the whole point of the door.
 *
 * AND `sellingPrice` IS HERE, WHILE `offerId` IS NOT.
 *
 * «كمية كم عدد والسعر الجديد… منتج آخر اختاره وكميته وسعره وينعكس هذا على
 * الفاتورة» — so the price had to become askable. The order route already
 * accepts it, so the request can be carried out to the end.
 *
 * The offer could not, and that was the city's bug wearing another name:
 * the door accepted it, a supervisor approved it, and the apply path then
 * answered «لا يمكن تطبيق العرض من هنا — عدّلها يدوياً». An offer is not one
 * value: it carries quantity, free units, price, discount AND whether the
 * price includes delivery, so applying one by copying an id would move five
 * money inputs at once through a path built for none of them. And the ask
 * behind it is already sayable in three fields that DO apply — the product,
 * the quantity and the price.
 *
 * A field belongs in this list only if `APPLIES_AS` in change-request-apply
 * can carry it out. A guard holds the two lists together, because this is
 * the second time they drifted apart and both times the seller found it
 * before we did.
 */
export const CHANGEABLE_FIELDS = [
  'customerName', 'customerPhone', 'customerAltPhone', 'customerAddress', 'regionId',
  'quantity', 'productId', 'sellingPrice', 'discountAmount', 'customerNotes',
] as const;

export type ChangeableField = (typeof CHANGEABLE_FIELDS)[number];

/**
 * THE FIELDS WHOSE APPROVAL MOVES WHAT THE CUSTOMER PAYS (perm-plan PR-7).
 *
 * The price, the discount, the quantity, the product — and the two names an old row may still carry (`offerId`, `items`),
 * because a row written before they were retired is decided under today's rule, not under a list that forgot it. Approving
 * a request that carries one of them needs `orders.change_price`: who may DECIDE a price change is the same question as who
 * may make one. Rejecting never needs it, and neither does any other field.
 */
export const MONEY_CHANGE_FIELDS: readonly string[] = [
  'sellingPrice', 'discountAmount', 'quantity', 'productId', 'offerId', 'items',
  // The lines of the order (a request that edits several things at once). A quantity alone moves the total through it,
  // so the key that decides a price decides this too — without the name here a lines request would be approved by
  // anyone who may decide, on the strength of «it is only a quantity».
  'lines',
];

/** The sentence a decider without the price key reads on a request that moves a figure. */
export const PRICE_KEY_REQUIRED_AR = 'هذا الطلب يغيّر السعر أو الكمية أو المنتج — البتّ فيه لمن عنده صلاحية تغيير السعر.';

/** Does this request (its `changes` object, as stored or as sent) ask for any money field? */
export function touchesMoney(changes: unknown): boolean {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return false;
  return Object.keys(changes as Record<string, unknown>).some((k) => MONEY_CHANGE_FIELDS.includes(k));
}

export const CHANGE_FIELD_AR: Record<ChangeableField, string> = {
  customerName: 'اسم العميل',
  customerPhone: 'هاتف العميل',
  customerAltPhone: 'الهاتف البديل',
  customerAddress: 'العنوان',
  regionId: 'المحافظة',
  quantity: 'الكمية',
  productId: 'المنتج',
  sellingPrice: 'السعر (إجمالي الكمية)',
  discountAmount: 'الخصم',
  customerNotes: 'ملاحظات العميل',
};

/**
 * Fields no new request may carry, kept only so an OLD row still reads in
 * Arabic. Dropping the name with the field would print `offerId` to a reader
 * of a request raised before it was retired — and the apply path refuses it
 * by its label, so the label is what the refusal says.
 */
const RETIRED_FIELD_AR: Record<string, string> = {
  offerId: 'العرض',
  customerCity: 'المدينة',
};

export function changeFieldLabel(field: string): string {
  if (field === 'lines') return 'أسطر الطلب';
  return (CHANGE_FIELD_AR as Record<string, string>)[field] ?? RETIRED_FIELD_AR[field] ?? field;
}

/* ═══════════════════════════ THE LINES OF THE ORDER ═══════════════════════════ */

/**
 * THE ONE KEY THAT IS NOT A `{ from, to }`: `lines`.
 *
 * «أقدر أعدل كذا شغلة بنفس الوقت، مثلاً الكمية أكيد بتتطلب أغير معها السعر». The ten fields above describe the order as
 * if it had one line — `quantity` is the SUM of the lines and `sellingPrice` their subtotal — so a request could never
 * say «the second line, five pieces, at 58». `lines` says it, line by line, and travels beside the customer's fields.
 *
 * It is deliberately NOT in `CHANGEABLE_FIELDS`: that list is what the dialog offers a person to pick from and what the
 * route accepts from a browser today. The request that carries `lines` is raised by the server from a preview (the
 * numbers are the server's), and applied by `change-request-apply` — which is why the name lives here, beside the
 * labels, and not in the menu.
 *
 * No migration: `OrderChangeRequest.changes` is a JSON column and this is one more key in it.
 */
export const LINES_FIELD = 'lines';

/** The ways a line's total was reached — the same four words `order-line-edit` speaks (a test holds them equal). */
export const LINE_PRICE_BASES = ['KEEP_UNIT', 'OFFER', 'BASE_PRICE', 'MANUAL'] as const;

const fromTo = <T extends z.ZodType, F extends z.ZodType>(to: T, from: F) => z.object({ from: from.nullish(), to });

/**
 * A «BEFORE» THAT MUST BE THERE. The apply door finds a line again, after a save has given it a new id, by what the request
 * recorded of it; a request without that record would be found by its id alone (and refused when the id is gone), and the only
 * thing left standing guard would be the total. The server writes `from` for the identity of a line and for the two figures a
 * decision is about — the product, the quantity and the line's total — so a request without them is not this shape.
 */
const MISSING_BEFORE_AR = 'قيمة «قبل» ناقصة بسطر الطلب';
const required = <T extends z.ZodType, F extends z.ZodType>(to: T, from: F) => z.object({ from, to });

const wholeFrom = z.number({ error: MISSING_BEFORE_AR }).int().min(0).max(100000);
const moneyFrom = z.number({ error: MISSING_BEFORE_AR }).finite().min(0).max(1_000_000);

/**
 * ONE LINE'S EDIT, as it is stored.
 *
 * Every figure is the one the person who DECIDED saw: `lineTotal` is what the line costs BEFORE the order's discount for
 * its paid units, `freeQuantity` the gift the server worked out. `from` is the server's reading of the line at the moment
 * of asking (never the browser's), and is what the apply door checks the line against before it writes anything.
 * `unitPrice` is for the eye only — the apply door never reads it.
 */
export const lineEditChangeSchema = z.object({
  /** The stored line when the request was raised. A save rewrites the lines, so this alone is not trusted — see `from`. */
  lineId: z.string().min(1).max(64),
  productId: required(z.string().min(10).max(64), z.string({ error: MISSING_BEFORE_AR }).min(1).max(64)).optional(),
  quantity: required(z.number().int().min(1).max(999), wholeFrom).optional(),
  lineTotal: required(z.number().finite().min(0).max(100000), moneyFrom).optional(),
  unitPrice: fromTo(z.number().finite().min(0).max(100000), moneyFrom).optional(),
  freeQuantity: fromTo(z.number().int().min(0).max(9999), wholeFrom).optional(),
  basis: z.enum(LINE_PRICE_BASES).optional(),
  offerId: z.string().max(64).nullish(),
});

export type ApprovedLineEdit = z.infer<typeof lineEditChangeSchema>;

/** What the person who decided was shown as the order's money, kept to be compared — not to be believed. */
const totalsSeen = z.object({ cod: z.number().finite().optional() }).passthrough();

export const linesChangeSchema = z
  .object({
    /** The version of this shape. A request without it is not this shape. */
    v: z.literal(2),
    edits: z.array(lineEditChangeSchema).min(1, 'ما في أسطر للتعديل').max(20, 'الحد الأعلى عشرين سطر'),
    /** Adding and removing a line is a later stage: a request that carries either is refused, not half-applied. */
    removed: z.array(z.unknown()).optional(),
    added: z.array(z.unknown()).optional(),
    snapshot: z
      .object({ orderVersion: z.number().optional(), before: totalsSeen.optional(), after: totalsSeen.optional() })
      .passthrough()
      .optional(),
  })
  .refine((l) => new Set(l.edits.map((e) => e.lineId)).size === l.edits.length, { message: 'نفس السطر مكرر بالطلب' })
  .refine(
    (l) => l.edits.every((e) => e.productId || e.quantity || e.lineTotal || e.freeQuantity),
    { message: 'سطر بلا أي تغيير بالطلب' }
  );

export type LinesChange = z.infer<typeof linesChangeSchema>;

/** The `lines` key of a stored request, read strictly: the shape or a sentence. Absent is `null`, not an error. */
export function readLinesChange(changes: unknown): { ok: true; value: LinesChange | null } | { ok: false; error: string } {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return { ok: true, value: null };
  const raw = (changes as Record<string, unknown>)[LINES_FIELD];
  if (raw === undefined || raw === null) return { ok: true, value: null };
  const parsed = linesChangeSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message || 'أسطر طلب التعديل مش بالشكل المعتمد' };
  }
  return { ok: true, value: parsed.data };
}

/**
 * A `lines` request in words, one sentence per line — for the screen of whoever decides (and for a timeline), never JSON.
 *
 * `names` maps a product id to its name; a line without one reads «سطر ٣». The figures are printed as stored, rounded to
 * the currency's own unit: this file adds nothing up and prices nothing.
 */
export function describeLines(
  change: Pick<LinesChange, 'edits'>,
  opts: { minorUnit?: number; names?: Readonly<Record<string, string>> } = {}
): string[] {
  const mu = opts.minorUnit ?? 2;
  const num = (n: number) => String(roundMinor(n, mu));
  const arrow = (pair: { from?: number | null; to: number }) =>
    pair.from === undefined || pair.from === null ? num(pair.to) : `${num(pair.from)} ← ${num(pair.to)}`;
  const name = (id: string | null | undefined, fallback: string) => (id && opts.names?.[id]) || fallback;

  /**
   * A FIGURE THAT DID NOT MOVE IS NOT PRINTED. The server writes the whole record of an edited line — «٠ ← ٠» for a gift
   * nobody touched, «كريم ← كريم» for a product nobody swapped — and a sentence that lists them buries the one thing the
   * line changes. A figure with no recorded «before» is shown alone (it is new information, not a repeat).
   */
  const moved = (pair: { from?: number | null; to: number } | undefined): pair is { from?: number | null; to: number } =>
    !!pair && (pair.from === undefined || pair.from === null || pair.from !== pair.to);

  return change.edits.map((edit, i) => {
    const label = name(edit.productId?.from ?? null, `سطر ${i + 1}`);
    const parts: string[] = [];
    if (edit.productId && edit.productId.from !== edit.productId.to) {
      parts.push(`المنتج: ${name(edit.productId.from, 'منتج')} ← ${name(edit.productId.to, 'منتج آخر')}`);
    }
    if (moved(edit.quantity)) parts.push(`الكمية: ${arrow(edit.quantity)}`);
    if (moved(edit.lineTotal)) parts.push(`إجمالي السطر: ${arrow(edit.lineTotal)}`);
    if (moved(edit.freeQuantity)) parts.push(`الهدية: ${arrow(edit.freeQuantity)}`);
    if (edit.basis === 'MANUAL') parts.push('السعر يدوي');
    return `${label} — ${parts.length > 0 ? parts.join(' · ') : 'بلا تغيير'}`;
  });
}

export type ChangeValue = string | number | null;
export type Changes = Partial<Record<ChangeableField, { from?: ChangeValue; to: ChangeValue }>>;

/** The order as it stands, in the shape a change request speaks. */
export interface OrderSnapshot {
  quantity: number;
  productId: string;
  /** The line total for the quantity, not the per-unit price — see below. */
  sellingPrice: number;
  discountAmount: number;
  customerNotes: string | null;
  /** The governorate it ships to — what the delivery fee is keyed on. */
  regionId: string | null;
  /** The address this order goes to, when it has its own — the «before» of an address change is THIS one. */
  deliveryAddress?: string | null;
  customer: {
    fullName: string;
    phone: string;
    altPhone: string | null;
    address: string;
    city: string;
  };
}

function current(order: OrderSnapshot, field: ChangeableField): ChangeValue {
  switch (field) {
    case 'customerName': return order.customer.fullName;
    case 'customerPhone': return order.customer.phone;
    case 'customerAltPhone': return order.customer.altPhone;
    case 'customerAddress': return order.deliveryAddress ?? order.customer.address;
    case 'regionId': return order.regionId ?? null;
    case 'quantity': return order.quantity;
    case 'productId': return order.productId;
    /**
     * THE LINE TOTAL, NOT THE PER-UNIT PRICE.
     *
     * `Order.sellingPrice` is the whole line — the order route's own words:
     * «the single-line shorthand: price is the TOTAL for the quantity». A
     * request that showed «50 ← 60» while the person meant sixty EACH would
     * be approved as a discount, so the label says which it is and the
     * decider sees the current figure beside it.
     */
    case 'sellingPrice': return order.sellingPrice;
    case 'discountAmount': return order.discountAmount;
    case 'customerNotes': return order.customerNotes;
  }
}

/**
 * Each requested change, with what it is changing FROM.
 *
 * Taken by the server at the moment of asking, never accepted from the
 * browser. A request that says only "make it 3" is unanswerable — three
 * instead of what? — and a "from" the requester typed could say anything.
 * The dialog was built to show both sides and had only ever been given one.
 */
export function withFrom(order: OrderSnapshot, changes: Changes): Changes {
  const out: Changes = {};
  for (const [field, change] of Object.entries(changes) as [ChangeableField, { to: ChangeValue }][]) {
    if (!change) continue;
    out[field] = { from: current(order, field), to: change.to };
  }
  return out;
}
