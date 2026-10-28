/**
 * THE SAME MONEY, ENTERED BY HAND AND THEN BY THE STATEMENT.
 *
 * Approving a statement writes one wallet IN per receipt. If somebody had already typed that collection in
 * by hand, the wallet now holds it twice — and nothing on the approval screen said so. Before the money
 * moves, the server looks for a hand entry that could be the same money and, if there is one, stops and
 * shows it. The person reverses the hand row, or says «اعتمد هيك» and the approval goes ahead (and the
 * confirmation is written to the approval's audit row).
 *
 * Pure: it is given the receipts and the candidate movements and answers which of them look alike, so the
 * comparison (the currency's minor unit, the 14-day window) is tested without a database.
 */

/** How far back a hand entry can be and still look like the same money. */
export const HAND_WINDOW_DAYS = 14;

export const POSSIBLE_DOUBLE_SENTENCE =
  'في حركة يدوية بنفس المبلغ بنفس المحفظة — إذا هي نفس مصاري الكشف، اعكسها («قيد عكسي») قبل الاعتماد.';

export interface ReceiptToCheck {
  walletId: string;
  amount: number;
}

/** A hand-entered incoming movement, as the approval reads it. */
export interface HandMovement {
  id: string;
  walletId: string;
  amount: number;
  /** The wallet's currency decides how many decimals "the same amount" means. */
  minorUnit: number;
  party: string;
  note: string;
  createdAt: Date;
  createdById: string;
}

/** The oldest a hand entry may be, counted back from the approval. */
export function handWindowStart(now: Date): Date {
  return new Date(now.getTime() - HAND_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}

/** Integer minor units, so 10.125 and 10.12 are different amounts in JOD and the same one in a 2-place currency. */
function inMinor(amount: number, minorUnit: number): number {
  return Math.round(Number((amount * 10 ** minorUnit).toFixed(6)));
}

/**
 * The hand entries that could be the same money as one of the receipts: same wallet, same amount at the
 * wallet's minor unit, inside the window. A row is listed once however many receipts it resembles.
 */
export function findPossibleDoubles(receipts: ReceiptToCheck[], movements: HandMovement[], now: Date): HandMovement[] {
  const since = handWindowStart(now).getTime();
  const out: HandMovement[] = [];
  for (const m of movements) {
    if (m.createdAt.getTime() < since) continue;
    const same = receipts.some(
      (r) => r.walletId === m.walletId && inMinor(r.amount, m.minorUnit) === inMinor(m.amount, m.minorUnit)
    );
    if (same && !out.some((o) => o.id === m.id)) out.push(m);
  }
  return out;
}
