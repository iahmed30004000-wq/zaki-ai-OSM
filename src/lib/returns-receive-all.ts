/**
 * «استلام الكل» — WHAT THE DOOR AND THE SCREEN BOTH NEED TO KNOW, AND NOTHING THAT READS THE DATABASE.
 *
 * The door is `POST /api/ops/returns/receive-all`; the receipt of each parcel is `receiveReturn` (lib/return-receipt.ts).
 * This module imports nothing from the server: the screen reads it too.
 *
 * ── WHY A CURSOR AND NOT «WHAT IS LEFT» ──
 *
 * A partial delivery the button leaves, and a parcel the door refuses, stay in the pending list for ever. A loop that
 * keeps asking «what is still pending» would be handed them again on every round and never end. So the door walks the
 * filtered set ONCE, by id, ascending: each answer says where it stopped (`nextCursor`), and the screen sends that back
 * with the same filters until it comes back null — or the person presses «إيقاف».
 */

/** At most this many parcels per request, each in its own transaction like the single door. */
export const RECEIVE_ALL_CHUNK = 50;

/** Why a parcel was left. `FAILED` is a database error on that one parcel: the rest went on. */
export const RECEIVE_ALL_SKIPS = [
  'NEEDS_THE_QUESTION',
  'ALREADY_RECEIVED',
  'DELIVERED_AND_SETTLED',
  'OVER_RECEIVED',
  'NOTHING_EXPECTED',
  'NOT_FOUND',
  'FAILED',
] as const;
export type ReceiveAllSkip = (typeof RECEIVE_ALL_SKIPS)[number];

export const RECEIVE_ALL_SKIP_AR: Record<ReceiveAllSkip, string> = {
  NEEDS_THE_QUESTION: 'توصيل جزئي (بينستلم من نافذته)',
  ALREADY_RECEIVED: 'انستلم قبل',
  DELIVERED_AND_SETTLED: 'انسلّم وانسوّى حسابه',
  OVER_RECEIVED: 'الكمية ما بتطابق',
  NOTHING_EXPECTED: 'ما في شي راجع',
  NOT_FOUND: 'ما لقيناه',
  FAILED: 'صار خطأ',
};

export interface ReceiveAllAnswer {
  received: number;
  skipped: Partial<Record<ReceiveAllSkip, number>>;
  nextCursor: string | null;
}

export interface ReceiveAllTotals {
  received: number;
  skipped: Partial<Record<ReceiveAllSkip, number>>;
}

export const emptyTotals = (): ReceiveAllTotals => ({ received: 0, skipped: {} });

/** One answer added onto the running totals of a press. */
export function addAnswer(totals: ReceiveAllTotals, answer: ReceiveAllAnswer): ReceiveAllTotals {
  const skipped = { ...totals.skipped };
  for (const k of RECEIVE_ALL_SKIPS) {
    const n = answer.skipped[k] ?? 0;
    if (n > 0) skipped[k] = (skipped[k] ?? 0) + n;
  }
  return { received: totals.received + answer.received, skipped };
}

export const skippedTotal = (t: ReceiveAllTotals): number => RECEIVE_ALL_SKIPS.reduce((s, k) => s + (t.skipped[k] ?? 0), 0);

/**
 * THE ONE RESULT LINE: «استلمت 371 · تركت 3 توصيل جزئي · تخطيت 0».
 *
 * Counts by reason only — never order numbers (an order number is drawn by one component, `OrderRef`). A run that was
 * stopped, or that hit an error, says so plainly and says the press can be made again: what it left is still in the list.
 */
export function receiveAllLine(t: ReceiveAllTotals, how: { stopped?: boolean; broke?: boolean } = {}): string {
  const partial = t.skipped.NEEDS_THE_QUESTION ?? 0;
  const others = RECEIVE_ALL_SKIPS.filter((k) => k !== 'NEEDS_THE_QUESTION' && k !== 'FAILED' && (t.skipped[k] ?? 0) > 0);
  const othersTotal = others.reduce((s, k) => s + (t.skipped[k] ?? 0), 0);
  const failed = t.skipped.FAILED ?? 0;

  const parts = [`استلمت ${t.received}`, `تركت ${partial} توصيل جزئي`];
  parts.push(
    othersTotal > 0
      ? `تخطيت ${othersTotal} (${others.map((k) => `${RECEIVE_ALL_SKIP_AR[k]}: ${t.skipped[k]}`).join('، ')})`
      : 'تخطيت 0'
  );
  if (failed > 0) parts.push(`ما زبط ${failed}`);
  let line = parts.join(' · ');
  if (how.stopped) line += ' — وقفت قبل الآخر، والباقي لسا بالقائمة.';
  else if (how.broke || failed > 0) line += ' — في شي ما زبط، والباقي لسا بالقائمة: فيك تضغط «استلام الكل» مرة تانية.';
  return line;
}
