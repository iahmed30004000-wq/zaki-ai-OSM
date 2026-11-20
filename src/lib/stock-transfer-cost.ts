import { z } from 'zod';
import { roundMinor } from './money';
import { resolveUnitCost } from './unit-cost';

/**
 * WHAT GOODS COST WHEN THEY ARRIVE IN ANOTHER STORE (the warehouse plan, request W7b; the owner's decisions 6 and 7 of
 * 20/11). Pure: no database, no session, no clock. The transfer lib (`stock-transfers.ts`) reads every figure here.
 *
 *   THE GOODS KEEP THEIR COST. What left the source is the draw-down's own figure (`receiving.drawDownStock` — each
 *   batch at its price, a run and its twins costed once), kept on the line as `costOut` and never recomputed. There is
 *   NO exchange-rate step: the number travels as it is (the owner's decision 7 of 20/11).
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

/** What the units that did not arrive cost when they left — for the report of a shortfall. Not rounded. */
export function missingValue(costOut: number, sent: number, received: number): number {
  if (!(sent > 0) || received >= sent) return 0;
  return (costOut * (sent - received)) / sent;
}
