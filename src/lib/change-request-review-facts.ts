import { readLinesChange, type LinesChange } from './change-request-fields';
import {
  reviewDrift,
  reviewTotals,
  type ReviewLine,
  type ReviewPreview,
  type ReviewProblem,
} from './change-request-review';
import { readOrderEditFacts, type EditableOrderRow } from './order-edit-facts';
import { bindApprovedEdits, draftLineOf, linesStale, totalChanged, totalMoved } from './order-line-apply';
import {
  previewDraftSchema,
  previewLineEdit,
  type LineEditInput,
  type OrderEditPreview,
  type PreviewDraft,
  type Problem,
} from './order-line-edit';

/**
 * A STORED `lines` REQUEST, JUDGED AGAINST THE ORDER AS IT IS NOW — READ, NEVER WRITTEN.
 *
 * The person deciding does not need the engine to re-price anything: the request carries the figures the raiser saw, and
 * the apply door writes THOSE (`order-line-apply.ts`: nothing is derived again from today's offers or catalogue). What
 * they need to know is whether those figures can still be carried out on the order as it stands — and this answers by
 * asking the apply door's own questions in the apply door's own way:
 *
 *   · the lines the request names are found again with `bindApprovedEdits` — by id, then by what the request recorded as
 *     «before» — and if one cannot be, there is no «after» and the answer is `LINES_STALE`;
 *   · what each line becomes is the approved figure typed whole (`draftLineOf`, the same mapping), and the gift the
 *     request fixed is pinned, so a newer offer cannot move it;
 *   · `previewLineEdit` then judges that draft with the problems it always judges, and the one extra rule a DECISION has
 *     over a draft is applied: a product switched off since is a stop, not a warning (`refusalOf` says the same);
 *   · the total the decider was shown when the request was raised must still be the total the order comes to
 *     (`totalMoved`, the apply door's own test of «TOTAL_CHANGED»).
 *
 * So `blocked` is true exactly when the apply door would refuse — a test holds the two together over the same facts.
 * Every read is a `find`/`count`/`aggregate` (it uses the facts reader of the preview, which a test holds to no writes).
 */

export type StoredRequestPreview =
  | { ok: true; preview: ReviewPreview }
  | { ok: false; reason: 'NOT_LINES' }
  | { ok: false; reason: 'UNREADABLE'; error: string };

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The order's own fields that travel with the lines in a request, in the words of the draft. */
const FLAT_KEYS = ['discountAmount', 'regionId', 'customerName', 'customerPhone', 'customerAltPhone', 'customerAddress', 'customerNotes'] as const;

/** The `to` side of the request's flat fields that the draft knows — each judged by the draft schema's own bound, or dropped. */
function flatDraft(changes: unknown): Omit<PreviewDraft, 'lines'> {
  const out: Record<string, unknown> = {};
  if (!isRecord(changes)) return out;
  for (const key of FLAT_KEYS) {
    const entry = changes[key];
    if (!isRecord(entry) || entry.to === undefined) continue;
    const parsed = previewDraftSchema.shape[key].safeParse(entry.to);
    if (parsed.success && parsed.data !== undefined) out[key] = parsed.data;
  }
  // Every value above passed the draft schema's own rule for its key, so the object is a draft without lines.
  return out as Omit<PreviewDraft, 'lines'>;
}

/** A product switched off is a warning for a draft and a stop for a decision (`refusalOf`'s own rule). */
const stopsADecision = (p: Problem): boolean => p.blocking || p.code === 'PRODUCT_INACTIVE';

function problemsOf(preview: OrderEditPreview, extra: ReviewProblem[]): ReviewProblem[] {
  const own: ReviewProblem[] = preview.problems.map((p) => ({
    code: p.code,
    blocking: stopsADecision(p),
    messageAr: p.messageAr,
    ...(p.lineId ? { lineId: p.lineId } : {}),
  }));
  // Blocking first, and otherwise the order the engine gave them in (a stable sort).
  return [...extra, ...own].sort((a, b) => Number(b.blocking) - Number(a.blocking));
}

/** What the request recorded of each line, drawn when the lines can no longer be found: no «after», only what was asked. */
function recordedLines(snapshot: LinesChange, nameOf: (id: string | null | undefined) => string): ReviewLine[] {
  return snapshot.edits.map((e) => {
    const was = (pair: { from?: number | null; to: number } | undefined, fallback: number) => ({
      from: pair?.from ?? fallback,
      to: pair?.to ?? pair?.from ?? fallback,
    });
    return {
      lineId: e.lineId,
      changed: true,
      productName: { from: nameOf(e.productId?.from), to: nameOf(e.productId?.to ?? e.productId?.from) },
      quantity: was(e.quantity, 0),
      freeQuantity: was(e.freeQuantity, 0),
      lineTotal: was(e.lineTotal, 0),
      unitPrice: was(e.unitPrice, 0),
      totalAfterDiscount: null,
      basis: e.basis ?? null,
    };
  });
}

export async function previewStoredRequest(args: {
  requestId: string;
  /** `OrderChangeRequest.changes`, as stored. */
  changes: unknown;
  order: EditableOrderRow;
  companyId: string;
  country: { code: string; minorUnit: number; allowNegativeStock: boolean };
}): Promise<StoredRequestPreview> {
  const read = readLinesChange(args.changes);
  if (!read.ok) return { ok: false, reason: 'UNREADABLE', error: read.error };
  const request = read.value;
  if (!request) return { ok: false, reason: 'NOT_LINES' };

  const mu = args.country.minorUnit;
  const extras = flatDraft(args.changes);
  // Read the products the request names BEFORE the lines are bound to it (as the apply door does): the real draft, with
  // real line ids, is made once the lines are in hand.
  const named: LineEditInput[] = request.edits.map((e) => ({ lineId: e.lineId, ...(e.productId ? { productId: e.productId.to } : {}) }));
  const facts = await readOrderEditFacts({
    order: args.order,
    companyId: args.companyId,
    country: args.country,
    draft: { ...extras, lines: named },
  });

  const names = new Map<string, string>([...facts.lines.map((l) => [l.productId, l.productName] as const), ...facts.products.map((p) => [p.id, p.name] as const)]);
  const nameOf = (id: string | null | undefined): string => (id ? names.get(id) : undefined) || 'منتج';

  const bound = bindApprovedEdits(facts.lines, request.edits, mu);

  if (!bound.ok) {
    // The lines moved: the order as it is (no draft), the reasons it carries, and the one that matters first.
    const now = previewLineEdit(facts, extras);
    const stale: ReviewProblem = { code: 'LINES_STALE', blocking: true, messageAr: linesStale().error };
    const problems = problemsOf(now, [stale]);
    const before = reviewTotals(now.before);
    return {
      ok: true,
      preview: {
        requestId: args.requestId,
        stale: true,
        lines: recordedLines(request, nameOf),
        before,
        after: null,
        stock: now.stock,
        problems,
        blocked: true,
        drift: reviewDrift({
          snapshot: request.snapshot,
          nowBefore: before,
          nowAfter: null,
          lineCount: facts.lines.length,
          stale: true,
          stock: now.stock,
          door: now.door,
          minorUnit: mu,
        }),
        door: now.door,
        orderVersion: now.orderVersion,
        minorUnit: mu,
      },
    };
  }

  const pinned = new Map<string, number>();
  for (const { edit, line } of bound.bound) {
    if (edit.freeQuantity) pinned.set(line.id, edit.freeQuantity.to);
  }
  const draft: PreviewDraft = { ...extras, lines: bound.bound.map(({ edit, line }) => draftLineOf(edit, line)) };
  const preview = previewLineEdit(facts, draft, pinned);

  const extra: ReviewProblem[] = totalMoved(request.snapshot, preview.after.cod, mu)
    ? [{ code: 'TOTAL_CHANGED', blocking: true, messageAr: totalChanged().error }]
    : [];
  const problems = problemsOf(preview, extra);
  const before = reviewTotals(preview.before);
  const after = reviewTotals(preview.after);

  const lines: ReviewLine[] = preview.lines.map((l) => ({
    lineId: l.lineId,
    changed: l.changed,
    productName: { from: nameOf(l.productId.from), to: nameOf(l.productId.to) },
    quantity: l.quantity,
    freeQuantity: l.freeQuantity,
    lineTotal: l.lineTotal,
    unitPrice: l.unitPrice,
    totalAfterDiscount: l.totalAfterDiscount,
    basis: l.basis,
  }));

  return {
    ok: true,
    preview: {
      requestId: args.requestId,
      stale: false,
      lines,
      before,
      after,
      stock: preview.stock,
      problems,
      blocked: problems.some((p) => p.blocking),
      drift: reviewDrift({
        snapshot: request.snapshot,
        nowBefore: before,
        nowAfter: after,
        lineCount: facts.lines.length,
        stale: false,
        stock: preview.stock,
        door: preview.door,
        minorUnit: mu,
      }),
      door: preview.door,
      orderVersion: preview.orderVersion,
      minorUnit: mu,
    },
  };
}
