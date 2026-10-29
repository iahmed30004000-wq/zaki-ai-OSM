/**
 * WHEN A STATEMENT LINE MUST NOT BE MATCHED BY ITSELF.
 *
 * The matcher compares a line with an order and, when the figures agree, calls it MATCHED — and approval then
 * settles the order and pays its commission. That is right only if the order is still ours to settle by this line.
 * Four things make it not:
 *
 *   · the money already came in by hand («استلمت منه», or a receipt that landed before the file did);
 *   · a person asked to cancel or postpone the order and nobody answered yet — the parcel may not be what the
 *     line describes;
 *   · another line of the same file names the same order;
 *   · another statement names it too.
 *
 * Each one is a reason for a person to look, not a fifth result word: the line becomes MISMATCHED and the note says
 * which reason. Pure on purpose — it is given the facts and returns the sentences, so every reason is tested
 * without a database.
 */

/** The `matchedBy` of a link a person made by hand. Matching again never deletes it. */
export const MANUAL_MATCH = 'MANUAL';

/**
 * A change request that is still open: asked and not answered, or answered and not carried out.
 * A function, so each query gets its own object and nobody edits the rule from a distance.
 */
export function openRequestWhere() {
  return {
    intent: { in: ['CANCEL', 'POSTPONE'] },
    OR: [{ status: 'PENDING' }, { status: 'APPROVED', appliedAt: null }],
  };
}

export const HAND_COLLECTED_NOTE = 'حُصّل يدوياً — مبلغه دخل قبل الكشف';
export const SAME_FILE_NOTE = 'الطلب مذكور بسطر آخر من هذا الكشف';
/** A line the company wrote at zero, or wrote no money against at all (the import kept it as 0). */
export const ZERO_LINE_NOTE = 'مبلغ السطر في الكشف صفر';

export interface OtherStatement {
  reference: string;
  /** Its approval already moved money. */
  approved: boolean;
}

export interface IntegrityFacts {
  settlementStatus: string | null | undefined;
  /** An earlier line of this file (or a kept answer) already holds this order. */
  claimedByAnotherLine: boolean;
  /** Other statements that name the order. */
  otherStatements: OtherStatement[];
  /** The open change requests on the order. */
  openRequests: string[];
}

/** The reasons, in the order a person should read them. Empty means the line may be matched. */
export function integrityNotes(f: IntegrityFacts): string[] {
  const notes: string[] = [];

  // Settled with no approved statement behind it = collected by hand. If an approved statement paid it, the
  // "other statement" sentence below says so instead.
  if (f.settlementStatus === 'SETTLED' && !f.otherStatements.some((s) => s.approved)) {
    notes.push(HAND_COLLECTED_NOTE);
  }
  if (f.claimedByAnotherLine) notes.push(SAME_FILE_NOTE);
  if (f.otherStatements.length > 0) {
    const refs = [...new Set(f.otherStatements.map((s) => s.reference))].join('، ');
    notes.push(`الطلب مذكور بكشف آخر: ${refs}`);
  }
  if (f.openRequests.includes('CANCEL')) notes.push('عليه طلب إلغاء مفتوح');
  if (f.openRequests.includes('POSTPONE')) notes.push('عليه طلب تأجيل مفتوح');

  return notes;
}
