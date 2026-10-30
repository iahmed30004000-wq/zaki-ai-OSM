import { z } from 'zod';
import { LINES_FIELD, linesChangeSchema, type LinesChange } from './change-request-fields';
import { count, money } from './numeric-input';
import {
  MAX_EDIT_LINES,
  PRICE_BASES,
  type LineEditInput,
  type OrderEditPreview,
  type Problem,
} from './order-line-edit';

/**
 * RAISING A REQUEST THAT EDITS SEVERAL LINES — what the door accepts, and what it writes down.
 *
 * «أقدر أعدل كذا شغلة بنفس الوقت، مثلاً الكمية أكيد بتتطلب أغير معها السعر». The pieces that make a `lines` request
 * are here as pure functions so the route stays a sequence of questions and a test can ask each one without a
 * database:
 *
 *   · `splitLinesKey`     — the `lines` key is taken out of the body BEFORE the old schema sees it, so every request
 *                           without one is parsed by exactly the code it always was.
 *   · `raisedLinesSchema` — what a BROWSER may say: which line, and the figures it wants. Never a «before», never a
 *                           gift, never a snapshot: zod strips what it does not name, and nothing below reads it.
 *   · `draftFromRaised`   — the same words as the preview's draft, so the request is judged by the SAME engine, with
 *                           the same inputs, that the screen showed.
 *   · `storedLinesFrom`   — the `lines` value that is written: every figure is the SERVER's, taken from the preview
 *                           (its «before» from the stored lines, its gifts from the engine, the total the person
 *                           deciding will see). The apply door binds the request to the lines by those «before»
 *                           values and refuses a total that moved, so a request without them cannot be carried out.
 *   · `blockingRefusal`   — the sentence a blocked request is refused with: the reasons themselves, in Arabic.
 *
 * Nothing here adds up, prices or rounds: the figures come from `previewLineEdit` and go into the request as they are.
 */

/** The sentence for a request that carries a goods shorthand AND `lines` — two answers to one question. */
export const LINES_AND_FLAT_AR = 'ما بينفع تجمع أسطر مع كمية أو سعر أو منتج مفرد بنفس الطلب — اكتب التعديل بالأسطر بس.';
/** `lines` belongs to an edit: a cancellation or a postponement has no goods to change. */
export const LINES_NEED_EDIT_AR = 'تعديل الأسطر بيكون بطلب تعديل بس.';
/** Adding or removing a line is a later stage — refused at the door, not half-done at the apply. */
export const LINES_ADD_REMOVE_AR = 'إضافة سطر أو حذفه من هنا لسا مش مدعوم — ألغِ الطلب وأنشئ جديداً.';
/** A `lines` request whose lines all come out as they were, with nothing else beside it. */
export const LINES_NOTHING_CHANGED_AR = 'ما في أي تغيير فعلي بالأسطر — الأرقام زي ما هي.';
/** The order is not confirmed yet: its lines are edited on its own screen, and no request could ever be applied to it. */
export const LINES_NOT_CONFIRMED_AR = 'الطلب لم يُؤكَّد بعد — عدّل أسطره مباشرة من شاشته.';

/** The goods shorthand a `lines` request may not be raised beside. */
export const FLAT_GOODS_FIELDS = ['quantity', 'productId', 'sellingPrice'] as const;

/* ═══════════════════════════ what the browser may send ═══════════════════════════ */

/** Only the wanted value: a `from` beside it is the browser's guess about the past, and zod drops it. */
const wanted = <T extends z.ZodType>(value: T) => z.object({ to: value });

/**
 * ONE LINE, as a browser may ask for it. Same bounds as the lines save and the preview (`count(999, 1)`, `money(100000)`).
 * A price is a unit price OR a line total — the draft schema refuses both at once, in the preview's own words.
 */
const raisedEditSchema = z.object({
  lineId: z.string().min(1).max(64),
  productId: wanted(z.string().min(10).max(64)).optional(),
  quantity: wanted(count(999, 1)).optional(),
  lineTotal: wanted(money(100000)).optional(),
  unitPrice: wanted(money(100000)).optional(),
  basis: z.enum(PRICE_BASES).optional(),
  offerId: z.string().min(1).max(64).optional(),
});

export const raisedLinesSchema = z.object({
  v: z.literal(2, { error: 'شكل أسطر الطلب غير معتمد' }),
  edits: z
    .array(raisedEditSchema)
    .min(1, 'ما في أسطر للتعديل')
    .max(MAX_EDIT_LINES, 'الحد الأعلى عشرين سطر')
    .refine((all) => new Set(all.map((e) => e.lineId)).size === all.length, { message: 'نفس السطر مكرر بالطلب' }),
  /** Named only to be refused: a later stage. */
  removed: z.array(z.unknown()).optional(),
  added: z.array(z.unknown()).optional(),
});

export type RaisedLines = z.infer<typeof raisedLinesSchema>;

/**
 * THE `lines` KEY, TAKEN OUT OF THE BODY BEFORE THE OLD SCHEMA READS IT.
 *
 * `changes` is a closed list of ten fields, and `lines` is not one of them (it is a different shape, raised from a
 * preview). Taking it out here means a request without it is parsed by the same schema as before, to the letter.
 * `lines: undefined` is absent; `null` or anything else is PRESENT and is judged by `raisedLinesSchema`.
 */
export function splitLinesKey(body: unknown): { rest: unknown; lines: unknown } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { rest: body, lines: undefined };
  const changes = (body as Record<string, unknown>).changes;
  if (!changes || typeof changes !== 'object' || Array.isArray(changes) || !(LINES_FIELD in changes)) {
    return { rest: body, lines: undefined };
  }
  const { [LINES_FIELD]: lines, ...others } = changes as Record<string, unknown>;
  return { rest: { ...(body as Record<string, unknown>), changes: others }, lines };
}

/** The goods shorthand a flat `changes` carries, by name — empty when it carries none. */
export function flatGoodsIn(changes: object | null | undefined): string[] {
  return FLAT_GOODS_FIELDS.filter((k) => !!changes && (changes as Record<string, unknown>)[k] !== undefined);
}

/* ═══════════════════════════ the draft the engine judges ═══════════════════════════ */

type FlatTo = Partial<Record<string, { to: string | number | null }>>;

/**
 * THE REQUEST AS THE PREVIEW'S DRAFT: the lines, and the order's own fields that travel with them (the discount, the
 * governorate, the customer's name, phones, address and notes). A candidate only — `previewDraftSchema` has the last
 * word on every bound, exactly as it has for the screen's preview.
 */
export function draftFromRaised(raised: RaisedLines, flat: FlatTo): Record<string, unknown> {
  const lines: LineEditInput[] = raised.edits.map((e) => ({
    lineId: e.lineId,
    ...(e.productId ? { productId: e.productId.to } : {}),
    ...(e.quantity ? { quantity: e.quantity.to } : {}),
    ...(e.lineTotal ? { lineTotal: e.lineTotal.to } : {}),
    ...(e.unitPrice ? { unitPrice: e.unitPrice.to } : {}),
    ...(e.basis ? { priceBasis: e.basis } : {}),
    ...(e.offerId ? { offerId: e.offerId } : {}),
  }));
  const draft: Record<string, unknown> = { lines };
  for (const key of ['discountAmount', 'regionId', 'customerName', 'customerPhone', 'customerAltPhone', 'customerAddress', 'customerNotes']) {
    const asked = flat[key];
    if (asked) draft[key] = asked.to;
  }
  return draft;
}

/* ═══════════════════════════ what is written ═══════════════════════════ */

/**
 * THE `lines` VALUE OF THE REQUEST, from the preview and from nothing else.
 *
 * Only the lines the person edited AND that came out different are written. Each carries the whole record the apply door
 * needs, `from` and `to` together: the product, the quantity and the line's total (so the line can be found again after a
 * save has given it a new id), and the gift the engine worked out (so the number the decider saw is the number written).
 * `unitPrice` is for the eye. The snapshot keeps what the decider is shown — and `after.cod` is the total the apply door
 * insists the order still comes to — together with the order in which the lines were priced, which the apply writes in.
 *
 * Returns `null` when no edited line changed, so a request is never stored with a line that asks for nothing.
 */
export function storedLinesFrom(preview: OrderEditPreview, edited: ReadonlySet<string>): LinesChange | null {
  const edits = preview.lines
    .filter((l) => edited.has(l.lineId) && l.changed)
    .map((l) => ({
      lineId: l.lineId,
      productId: { from: l.productId.from, to: l.productId.to },
      quantity: { from: l.quantity.from, to: l.quantity.to },
      lineTotal: { from: l.lineTotal.from, to: l.lineTotal.to },
      unitPrice: { from: l.unitPrice.from, to: l.unitPrice.to },
      freeQuantity: { from: l.freeQuantity.from, to: l.freeQuantity.to },
      ...(l.basis ? { basis: l.basis } : {}),
      ...(l.offerId ? { offerId: l.offerId } : {}),
    }));
  if (edits.length === 0) return null;

  const seen = (t: OrderEditPreview['before']) => ({
    cod: t.cod,
    subtotal: t.subtotal,
    discount: t.discount,
    deliveryFee: t.deliveryFee,
    revenue: t.revenue,
    giftUnits: t.giftUnits,
  });
  return {
    v: 2,
    edits,
    snapshot: {
      orderVersion: preview.orderVersion,
      minorUnit: preview.minorUnit,
      before: seen(preview.before),
      after: seen(preview.after),
      lineOrder: preview.lineOrder,
      stock: preview.stock,
      door: preview.door,
      // The non-blocking warnings the decider read, by code — a blocking one never gets this far.
      warnings: preview.problems.map((p) => p.code),
    },
  } as LinesChange;
}

/** Does the value written read back through the SAME schema the apply door reads it with? A sentence if it does not. */
export function readsBack(stored: LinesChange): string | null {
  const back = linesChangeSchema.safeParse(stored);
  if (!back.success) return back.error.issues[0]?.message || 'أسطر الطلب ما انكتبت بالشكل المعتمد';
  const cod = back.data.snapshot?.after?.cod;
  return typeof cod === 'number' && Number.isFinite(cod) ? null : 'إجمالي الطلب بعد التعديل ناقص';
}

/* ═══════════════════════════ what a refusal says ═══════════════════════════ */

/**
 * THE BLOCKING REASONS OF A PREVIEW, in one sentence each (distinct), or null when nothing blocks.
 *
 * The sentences are the engine's own — the ones the screen already drew — so the person who is told «no» reads the same
 * words they saw under the preview.
 */
export function blockingRefusal(problems: readonly Problem[]): { error: string; reasons: Problem[] } | null {
  const reasons = problems.filter((p) => p.blocking);
  if (reasons.length === 0) return null;
  const sentences = [...new Set(reasons.map((p) => p.messageAr))];
  return { error: sentences.join(' — '), reasons };
}
