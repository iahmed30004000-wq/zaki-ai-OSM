import { z } from 'zod';
import { roundMinor } from './money';
import { resolveUnitCost } from './unit-cost';

/**
 * WHAT GOODS COST WHEN THEY ARRIVE IN ANOTHER STORE (the warehouse plan, request W7b; the owner's decisions 6 and 7 of
 * 20/11). Pure: no database, no session, no clock. The transfer lib (`stock-transfers.ts`) reads every figure here.
 *
 *   THE GOODS KEEP THEIR COST. What left the source is the draw-down's own figure (`receiving.drawDownStock` — each
 *   batch at its price, a run and its twins costed once), kept on the line as `costOut` and never recomputed. There is
 *   NO exchange-rate step: the number travels as it is (the owner's decision 7 of 20/11) — 22/11 (F2): EXCEPT between
 *   two currencies, where the owner reversed it; see `convertedArrivalCost` below. Same currency = this, unchanged.
 *
 *   LANDED COSTS are typed at receipt as lines — transport, customs, other — in the destination store's currency (the
 *   currency its product cost is kept in), each rounded to that currency's minor unit. Their total goes INTO the unit
 *   cost; it is not an expense and it is posted to no profit (decision 7).
 *
 *   THE DESTINATION'S UNIT COST:
 *       carried = costOut × received ÷ sent              (the cost of the units that ARRIVED, not of the ones that did not)
 *       total   = carried + Σ landed
 *       unit    = roundMinor(total ÷ received, minor)     (half away from zero — `money.roundMinor`)
 *   The destination's stock value rises by EXACTLY received × unit (that is the batch it opens).
 *
 *   THE REMAINDER RULE (pinned): remainder = total − received × unit. It is what the rounding left out — positive or
 *   negative, never more than received × half a minor unit in size. It is booked NOWHERE: not in the stock, not in a
 *   profit, not in a wallet. It is written on the line for the report, so the arithmetic can be checked, and that is all.
 *
 *   A SHORTFALL (received < sent) is a report only (decision 6): the missing units left the source at the send and
 *   arrive nowhere; their value at the cost that left is `missingValue` (for the report), and nobody is charged.
 *
 *   A UNIT COST OF ZERO needs a sentence (`unit-cost.resolveUnitCost`) — a zero carried and nothing landed is the very
 *   silent zero that rule exists for.
 */

export const LANDED_KINDS = ['TRANSPORT', 'CUSTOMS', 'OTHER'] as const;
export type LandedKind = (typeof LANDED_KINDS)[number];

export interface LandedCost {
  kind: LandedKind;
  amount: number;
  note?: string | null;
}

/** One typed cost line, as a door accepts it (Arabic sentences; «غيره» needs a word on what it was). */
export const landedCostField = z
  .object(
    {
      kind: z.enum(LANDED_KINDS, { message: 'اختار نوع المصروف: شحن، جمرك، أو غيره' }),
      amount: z
        .number({ message: 'المبلغ لازم يكون رقم' })
        .min(0, 'المبلغ ما بيكون أقل من صفر')
        .max(1_000_000_000, 'المبلغ كبير كتير. راجعه.'),
      note: z.string({ message: 'الملاحظة لازم تكون كلام' }).trim().max(200, 'ملاحظة المصروف أطول من 200 حرف. اختصرها.').optional().nullable(),
    },
    { message: 'سطر المصروف مش مفهوم. حدّث الصفحة.' }
  )
  .refine((c) => c.kind !== 'OTHER' || (c.note?.trim().length ?? 0) >= 2, { message: 'اكتب شو هالمصروف («غيره» بدّو كلمة).' });

export const landedCostsField = z.array(landedCostField, { message: 'المصاريف مش مفهومة. حدّث الصفحة.' }).max(20, 'كتير سطور مصاريف لمنتج واحد.');

/** The lines as they are stored: each amount rounded once to the destination's minor unit, notes trimmed. */
export function normalizeLanded(lines: readonly LandedCost[] | null | undefined, minorUnit: number): LandedCost[] {
  return (lines ?? []).map((l) => ({ kind: l.kind, amount: roundMinor(l.amount, minorUnit), ...(l.note?.trim() ? { note: l.note.trim() } : {}) }));
}

/** Σ of stored (already rounded) lines, rounded once more so a float sum of cents is the cents it should be. */
export function landedTotal(lines: readonly LandedCost[], minorUnit: number): number {
  return roundMinor(
    lines.reduce((s, l) => s + l.amount, 0),
    minorUnit
  );
}

export type ArrivalCost =
  | {
      ok: true;
      /** The cost of the units that arrived, at the cost that left (not rounded). */
      carried: number;
      landed: number;
      /** carried + landed — what the arrived units cost in all, before the unit rounding. */
      total: number;
      unitCost: number;
      /** total − received × unitCost: booked nowhere, written for the report. */
      remainder: number;
    }
  | { ok: false; code: string; message: string };

/**
 * The destination's unit cost for `received` units of a line that left with `costOut` for `sent` units, plus the typed
 * landed lines (already normalized). `received` must be > 0 — a line where nothing arrived opens no batch.
 */
export function arrivalCost(input: {
  costOut: number;
  sent: number;
  received: number;
  landed: readonly LandedCost[];
  minorUnit: number;
  zeroCostReason?: string | null;
}): ArrivalCost {
  const { costOut, sent, received, minorUnit } = input;
  if (!(sent > 0) || !(received > 0) || received > sent || !Number.isFinite(costOut) || costOut < 0) {
    return { ok: false, code: 'COUNTS_INVALID', message: 'العدد المستلم مش صحيح.' };
  }
  // Multiply first, divide once: costOut × received ÷ sent is exact when everything arrived (received = sent → costOut).
  const carried = received === sent ? costOut : (costOut * received) / sent;
  const landed = landedTotal(input.landed, minorUnit);
  const total = carried + landed;
  const unitCost = roundMinor(total / received, minorUnit);
  const verdict = resolveUnitCost({ given: unitCost, previous: null, zeroCostReason: input.zeroCostReason });
  if (!verdict.ok) return { ok: false, code: verdict.code, message: verdict.message };
  const remainder = total - received * unitCost;
  return { ok: true, carried, landed, total, unitCost: verdict.unitCost, remainder };
}

/* ───────────────────────────── two currencies (F2, 22/11) ───────────────────────────── */

/**
 * 22/11 (F2): THE EXCHANGE RATE — the owner's word of 22/11 «حط سعر الصرف سهلة», which REVERSES his decision 7 of 20/11
 * («no exchange-rate step») for ONE case only: the two stores' countries keep their costs in DIFFERENT currencies
 * (`Country.currencyCode`). Everything above this line is untouched and is still what every other transfer does.
 *
 *   THE RATE is typed once, at the send: units of the DESTINATION currency for ONE unit of the SOURCE currency. It is
 *   stored on the transfer and never recomputed — no door changes it after the send.
 *
 *   EVERY FIGURE BEFORE THE RECEIPT IS IN THE SOURCE CURRENCY: the cost that left (`costOut`) and every typed landed
 *   line (rounded to the SOURCE's minor unit, never the destination's). The conversion happens ONCE, at the receipt:
 *       carried   = costOut × received ÷ sent                         (source, not rounded — as today)
 *       landed    = roundMinor(Σ lines, sourceMinor)                   (each line already roundMinor(·, sourceMinor))
 *       total     = (carried + landed) × rate                          (destination, not rounded — the one conversion)
 *       unit      = roundMinor(total ÷ received, minor)                 (destination, half away from zero — as today)
 *       remainder = total − received × unit                            (destination; booked nowhere — as today)
 *   So rounding happens in exactly three places: each landed line and their sum (source minor unit), and the unit
 *   (destination minor unit). |remainder| ≤ received × half a destination minor unit, as today.
 */
export const EXCHANGE_RATE_MAX = 1_000_000;

export type ExchangeRateCode = 'RATE_MISSING' | 'RATE_INVALID' | 'RATE_TOO_BIG' | 'RATE_NOT_HERE';

export const EXCHANGE_RATE_AR: Record<ExchangeRateCode, string> = {
  RATE_MISSING: 'المتجرين بعملتين مختلفتين، فلازم تكتب سعر الصرف: كم بتساوي الوحدة من عملة المتجر اللي بيبعت بعملة المتجر اللي بيستلم.',
  RATE_INVALID: 'سعر الصرف لازم يكون رقم أكبر من صفر.',
  RATE_TOO_BIG: 'سعر الصرف كبير كتير (أكتر من مليون). راجعه.',
  RATE_NOT_HERE: 'سعر الصرف بينكتب بس على نقل بين متجرين بعملتين مختلفتين.',
};

/** Do the two ends keep their costs in different currencies? An unknown code on either side is not a difference. */
export function needsExchangeRate(fromCurrency: string | null | undefined, toCurrency: string | null | undefined): boolean {
  return !!fromCurrency && !!toCurrency && fromCurrency !== toCurrency;
}

/** The service's judgement of a typed rate. `needed` = the two currencies differ. */
export function checkExchangeRate(
  rate: unknown,
  needed: boolean
): { ok: true; rate: number | null } | { ok: false; code: ExchangeRateCode; message: string } {
  const refuse = (code: ExchangeRateCode) => ({ ok: false as const, code, message: EXCHANGE_RATE_AR[code] });
  if (!needed) return rate === null || rate === undefined ? { ok: true, rate: null } : refuse('RATE_NOT_HERE');
  if (rate === null || rate === undefined) return refuse('RATE_MISSING');
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) return refuse('RATE_INVALID');
  if (rate > EXCHANGE_RATE_MAX) return refuse('RATE_TOO_BIG');
  return { ok: true, rate };
}

export type ConvertedArrivalCost =
  | {
      ok: true;
      /** Source currency, not rounded: the cost of the units that arrived, at the cost that left. */
      carried: number;
      /** Source currency: Σ landed lines, rounded to the source's minor unit. */
      landed: number;
      /** Source currency: carried + landed. */
      sourceTotal: number;
      /** Destination currency: sourceTotal × rate — the one conversion, not rounded. */
      total: number;
      unitCost: number;
      /** Destination currency: total − received × unitCost. */
      remainder: number;
      rate: number;
    }
  | { ok: false; code: string; message: string };

/**
 * The destination's unit cost of a transfer between two currencies. `landed` must be normalized in the SOURCE's minor
 * unit (`normalizeLanded(lines, sourceMinorUnit)`); `minorUnit` is the destination's.
 */
export function convertedArrivalCost(input: {
  costOut: number;
  sent: number;
  received: number;
  landed: readonly LandedCost[];
  rate: number;
  sourceMinorUnit: number;
  minorUnit: number;
  zeroCostReason?: string | null;
}): ConvertedArrivalCost {
  const { costOut, sent, received, rate, minorUnit } = input;
  if (!(sent > 0) || !(received > 0) || received > sent || !Number.isFinite(costOut) || costOut < 0) {
    return { ok: false, code: 'COUNTS_INVALID', message: 'العدد المستلم مش صحيح.' };
  }
  const judged = checkExchangeRate(rate, true);
  if (!judged.ok) return { ok: false, code: judged.code, message: judged.message };
  const carried = received === sent ? costOut : (costOut * received) / sent;
  const landed = landedTotal(input.landed, input.sourceMinorUnit);
  const sourceTotal = carried + landed;
  const total = sourceTotal * rate;
  const unitCost = roundMinor(total / received, minorUnit);
  const verdict = resolveUnitCost({ given: unitCost, previous: null, zeroCostReason: input.zeroCostReason });
  if (!verdict.ok) return { ok: false, code: verdict.code, message: verdict.message };
  const remainder = total - received * unitCost;
  return { ok: true, carried, landed, sourceTotal, total, unitCost: verdict.unitCost, remainder, rate };
}

/** What the units that did not arrive cost when they left — for the report of a shortfall. Not rounded. */
export function missingValue(costOut: number, sent: number, received: number): number {
  if (!(sent > 0) || received >= sent) return 0;
  return (costOut * (sent - received)) / sent;
}
