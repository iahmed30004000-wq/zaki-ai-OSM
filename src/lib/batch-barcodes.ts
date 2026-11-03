import { toLatinDigits } from '@/lib/latin-digits';

/**
 * «لصق الباركودات» — THE COURIER'S BARCODES OF A BATCH, PASTED AS LINES (RV165, the owner 3/11).
 *
 * A batch handed to the courier before «رحّل إلى الشركة» has no way back to the dispatch (`BATCH_NOT_READY`: a parcel made
 * at the courier after the driver left is a parcel with no tracking), and the order's own door refuses a barcode after
 * «مشحون». So the parcels are made at the courier's portal by hand, and their barcodes come back as a list: one line per
 * order, «رقم الطلب, الباركود». This file reads those lines and decides, for each, what would happen — it writes nothing.
 * The route (`/api/shipping-batches/[id]/tracking`) asks it twice: once for «تحقّق» (a dry run), once inside the transaction
 * that writes.
 *
 * Only `trackingNumber` is ever decided here. No money, no order status, no stock.
 */

export const BARCODE_MIN = 4;
export const BARCODE_MAX = 64;
/** A batch is a few hundred parcels at most; a paste longer than this is not a batch's list. */
export const MAX_PASTED_LINES = 1000;
export const MAX_PASTED_TEXT = 100_000;

/** One line as read, before any order is looked at. `error` = the line itself is wrong. */
export interface PastedLine {
  /** 1-based, as the person sees the line in the box. */
  line: number;
  ref: string;
  barcode: string;
  error?: { code: string; reason: string };
}

export type LineOutcome = 'written' | 'unchanged' | 'refused';

export interface LineResult {
  line: number;
  ref: string;
  barcode: string;
  outcome: LineOutcome;
  code?: string;
  /** Arabic, for the person: why it was refused, or why nothing changed. */
  reason?: string;
  orderId?: string;
  orderNumber?: string;
  /** The barcode the order held before (written lines only; null = none). */
  previous?: string | null;
}

/** A parcel of the batch, as the plan needs it. */
export interface BatchMember {
  id: string;
  orderNumber: string;
  merchantRef: string | null;
  trackingNumber: string | null;
}

/** An order of the company that already holds one of the pasted barcodes. */
export interface BarcodeHolder {
  id: string;
  orderNumber: string;
  trackingNumber: string | null;
  storeId: string | null;
}

/** Comma, Arabic comma, semicolon, tab or spaces: whatever a spreadsheet or a chat pastes between the two values. */
const SEPARATOR = /[\s,،;]+/;
/** Visible ASCII, no space: what a courier's barcode is made of. */
const BARCODE_CHARS = /^[\x21-\x7E]+$/;

const key = (s: string) => s.trim().toUpperCase();

/** Reads the pasted text into lines. Blank lines are skipped; every other line is answered, even a wrong one. */
export function parsePastedBarcodes(text: string): PastedLine[] {
  const out: PastedLine[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const trimmed = toLatinDigits(raw).trim();
    if (!trimmed) return;
    const parts = trimmed.split(SEPARATOR).filter(Boolean);
    const line = i + 1;
    const ref = parts[0] ?? '';
    const barcode = parts.slice(1).join(' ');
    if (parts.length < 2) {
      out.push({ line, ref, barcode: '', error: { code: 'LINE_INCOMPLETE', reason: 'السطر ناقص — اكتب رقم الطلب وبعده الباركود' } });
      return;
    }
    if (parts.length > 2) {
      out.push({ line, ref, barcode, error: { code: 'BARCODE_HAS_SPACE', reason: 'بالسطر أكتر من قيمتين — الباركود ما بيكون فيه مسافة' } });
      return;
    }
    const verdict = barcodeProblem(parts[1]);
    out.push(verdict ? { line, ref, barcode: parts[1], error: verdict } : { line, ref, barcode: parts[1] });
  });
  return out;
}

/** Why a barcode is not one — or null. */
export function barcodeProblem(barcode: string): { code: string; reason: string } | null {
  if (barcode.length < BARCODE_MIN || barcode.length > BARCODE_MAX) {
    return { code: 'BARCODE_LENGTH', reason: `الباركود لازم يكون من ${BARCODE_MIN} لـ${BARCODE_MAX} حرف` };
  }
  if (!BARCODE_CHARS.test(barcode)) {
    return { code: 'BARCODE_CHARS', reason: 'الباركود لازم يكون أرقام وأحرف لاتينية بس' };
  }
  return null;
}

/** The barcodes the plan needs to ask the company about: the well-formed ones. */
export function pastedBarcodes(lines: PastedLine[]): string[] {
  return [...new Set(lines.filter((l) => !l.error).map((l) => l.barcode))];
}

/**
 * WHAT EACH LINE WOULD DO. Pure: the members of THIS batch and the company's orders holding a pasted barcode are read by
 * the caller, so the dry run and the write decide with the same code.
 *
 *  · an order not in this batch (by our number or our reference) → refused;
 *  · one order pasted with two different barcodes → all its lines refused; the same line twice → the repeat is unchanged;
 *  · one barcode pasted for two orders → all those lines refused;
 *  · a barcode held by ANOTHER order of the company → refused, and named only when that order is of this store;
 *  · the same barcode the order already holds → unchanged;
 *  · a different barcode already on the order → refused, unless `overwrite`;
 *  · otherwise → written.
 */
export function planBarcodes(input: {
  lines: PastedLine[];
  members: BatchMember[];
  holders: BarcodeHolder[];
  storeId: string | null;
  overwrite: boolean;
}): LineResult[] {
  const byRef = new Map<string, BatchMember>();
  for (const m of input.members) {
    byRef.set(key(m.orderNumber), m);
    if (m.merchantRef) byRef.set(key(m.merchantRef), m);
  }

  // First pass: which order each line names, and how many distinct barcodes each order and orders each barcode got.
  const found = input.lines.map((l) => (l.error ? null : byRef.get(key(l.ref)) ?? null));
  const barcodesOf = new Map<string, Set<string>>();
  const ordersOf = new Map<string, Set<string>>();
  input.lines.forEach((l, i) => {
    const m = found[i];
    if (!m) return;
    if (!barcodesOf.has(m.id)) barcodesOf.set(m.id, new Set());
    barcodesOf.get(m.id)!.add(l.barcode);
    if (!ordersOf.has(l.barcode)) ordersOf.set(l.barcode, new Set());
    ordersOf.get(l.barcode)!.add(m.id);
  });
  const firstLine = new Map<string, number>();

  return input.lines.map((l, i): LineResult => {
    const base = { line: l.line, ref: l.ref, barcode: l.barcode };
    if (l.error) return { ...base, outcome: 'refused', code: l.error.code, reason: l.error.reason };
    const m = found[i];
    if (!m) return { ...base, outcome: 'refused', code: 'NOT_IN_BATCH', reason: 'الطلب مش من هالدفعة' };
    const named = { ...base, orderId: m.id, orderNumber: m.orderNumber };

    if ((barcodesOf.get(m.id)?.size ?? 0) > 1) {
      return { ...named, outcome: 'refused', code: 'ORDER_TWICE', reason: 'الطلب انلصق مرتين بباركودين مختلفين — خلّي سطر واحد' };
    }
    if ((ordersOf.get(l.barcode)?.size ?? 0) > 1) {
      return { ...named, outcome: 'refused', code: 'BARCODE_TWICE', reason: 'نفس الباركود انلصق لأكتر من طلب' };
    }
    const seenAt = firstLine.get(m.id);
    if (seenAt !== undefined) {
      return { ...named, outcome: 'unchanged', code: 'LINE_REPEATED', reason: `مكرّر — نفس السطر ${seenAt}` };
    }
    firstLine.set(m.id, l.line);

    const holder = input.holders.find((h) => h.trackingNumber === l.barcode && h.id !== m.id);
    if (holder) {
      const who = holder.storeId === input.storeId ? ` ${holder.orderNumber}` : ' تاني';
      return { ...named, outcome: 'refused', code: 'BARCODE_TAKEN', reason: `الباركود مستعمل على طلب${who}` };
    }
    if (m.trackingNumber === l.barcode) {
      return { ...named, outcome: 'unchanged', code: 'SAME_BARCODE', reason: 'نفس الباركود موجود عالطلب' };
    }
    if (m.trackingNumber && !input.overwrite) {
      return { ...named, outcome: 'refused', code: 'HAS_OTHER_BARCODE', reason: `عليه باركود تاني (${m.trackingNumber})` };
    }
    return { ...named, outcome: 'written', previous: m.trackingNumber };
  });
}

export function countOutcomes(results: LineResult[]): Record<LineOutcome, number> {
  const counts: Record<LineOutcome, number> = { written: 0, unchanged: 0, refused: 0 };
  for (const r of results) counts[r.outcome] += 1;
  return counts;
}
