/**
 * A DIFFERENCE AT MATCHING IS A QUESTION, AND IT HAS TWO ANSWERS.
 *
 * «عند المطابقة في فرق… ممكن عادي صار خصم، بس يعتمد رقم الشركة. وإذا غير
 * معتمد أنا رح أتواصل مع الشركة وخط اعتماد رقمنا، وهي بتعتمد رقمنا. بس بضل
 * الطلب معلّم.»
 *
 * Before this a mismatched line was a red row and nothing more. The reader
 * could see that the courier's figure and ours disagreed and could do
 * nothing with that: no way to say «yes, an agent gave a discount», no way
 * to say «no, they owe us the difference», and so the same argument was had
 * again at the next statement over the same parcel.
 *
 * The commonest cause is not theft and not a courier error. It is a
 * DISCOUNT: the agent on the phone agreed to take two off to save the sale,
 * and wrote it in the order's internal notes — where finance never looks,
 * because a note is prose and a statement is a number. That is why the
 * screen puts the notes one press away from the difference: the answer is
 * usually already written down by the person who caused it.
 *
 * ── THE TWO ANSWERS ──
 *
 *   ACCEPTED_COURIER — their figure stands. A discount was really given, or
 *                      the difference is small enough not to chase. The
 *                      money is settled at what actually arrived.
 *   OURS_STANDS      — our figure stands, and the shop takes it up with the
 *                      courier. The parcel is not settled at their number;
 *                      it waits for their correction.
 *
 * ── AND THE ORDER STAYS MARKED EITHER WAY ──
 *
 * «بس بضل الطلب معلّم.» Resolving a difference records what was decided; it
 * does not make the difference never have happened. An order that needed
 * this answer keeps saying so, because the count of them per person is the
 * whole point of writing it down: «في إحصائيات على هاد الشي».
 *
 * Pure: no database, no clock. It is handed rows and returns verdicts.
 */

import { roundMinor } from './money';

export const RESOLUTIONS = ['ACCEPTED_COURIER', 'OURS_STANDS'] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

export const RESOLUTION_AR: Record<Resolution, string> = {
  ACCEPTED_COURIER: 'اعتُمد رقم الشركة',
  OURS_STANDS: 'رقمنا هو المعتمد',
};

/**
 * THE THIRD THING A PERSON CAN SAY: «قيد المراجعة».
 *
 * Offered where neither figure can be settled yet — the order has no door that takes either answer (not
 * delivered, a cancel asked for, already settled elsewhere). It records that somebody looked and parked the
 * row. It settles nothing and claims nothing, so it is not one of the two ANSWERS above and `RESOLUTIONS` does
 * not hold it; it does end the «nobody has looked» state, which is why `isOpen` does not count it.
 */
export const PARKED = 'UNDER_REVIEW' as const;
export const PARKED_AR = 'قيد المراجعة';

/** What pressing each one means, in the words the screen shows. */
export const RESOLUTION_MEANING: Record<Resolution, string> = {
  ACCEPTED_COURIER:
    'الفرق مقبول — غالباً خصمٌ أعطاه من كلّم الزبون. تُسوّى على ما وصل فعلاً، ويبقى الطلب معلَّماً.',
  OURS_STANDS:
    'الفرق غير مقبول — يُطالَب به من الشركة. لا يُسوّى على رقمهم حتى يصحّحوه، ويبقى الطلب معلَّماً.',
};

/**
 * THE THIRD THING A DIFFERENCE MAY BE CALLED: «طلب تبديل».
 *
 * «احيانا بيكون طلب تبديل او زبون وصلو الطلب ناقص فنبعثلو حبة فلازم يا تعمل خيار يعطيك انو طلب تبديل لاحظ الفرق شاسع
 * اكيد مش طلب وهو طلب تبديل» (the owner, 13/11, over a line whose parcel had no price to collect — the courier took
 * nothing and charged only the delivery, so the «difference» was the whole price of an order nobody was ever to pay for.)
 *
 * IT IS NOT A THIRD FIGURE. For the MONEY it is exactly «اعتُمد رقم الشركة» — their figure stands, the order is
 * settled at what arrived at the approval — and it takes no money path of its own: the stored `resolution` stays
 * `ACCEPTED_COURIER`, so every reader of that literal (the matcher, the close, the claim, the stats) keeps reading
 * what it always read. What it adds is a QUALIFIER beside it, `resolutionKind`, that says WHY — and the qualifier
 * does exactly two things:
 *
 *   · the line is not counted as a discount somebody gave away (the per-person tally leaves it out and counts it
 *     as an exchange of its own);
 *   · at the approval nobody is asked who carries the shortfall, and no «فرق تحصيل» is written for it — nothing was
 *     owed, so nobody carries anything (`shortfall.ts`).
 *
 * The qualifier is written by EVERY door that writes an answer (`decisionKind` in `settlement-decisions`): `EXCHANGE`
 * for this one, null for all the others, so an answer given over an exchange clears it. And it only means something
 * BESIDE the courier's figure (`isExchange`): a kind standing next to any other answer is read as nothing.
 */
export const EXCHANGE_KIND = 'EXCHANGE' as const;
export const EXCHANGE_AR = 'طلب تبديل';
/**
 * What the close writes on the order's timeline for an exchange line, where it writes `SETTLEMENT_DECISION_APPLIED` for any other
 * accepted one — a name of its own because the timeline's sentence is chosen by the action, and «سُوّي الطلب برقم الشركة بعد بتّ
 * مكتوب» would read, beside an exchange, as a discount somebody gave. The timeline gives it its Arabic (`order-timeline`).
 */
export const EXCHANGE_APPLIED_ACTION = 'SETTLEMENT_EXCHANGE_APPLIED';
export const EXCHANGE_MEANING =
  'تبديل أو حبة ناقصة بعتناها للزبون — ما إلها ثمن؛ رقم الشركة هو الصحيح وما بينحسب خصم على حدا.';

/** The sentence a door answers with when «طلب تبديل» is asked together with another answer — it is the courier's figure and nothing else. */
export const EXCHANGE_COMBINATION_SENTENCE =
  'طلب التبديل يعني «اعتُمد رقم الشركة» مع سبب التبديل — لا يُجمع مع «رقمنا هو المعتمد» ولا مع «قيد المراجعة»';

/** The sentence the bulk door answers with: an exchange is one order at a time, each with its own reason. */
export const EXCHANGE_NOT_IN_BULK_SENTENCE = 'طلب التبديل يُجاب طلباً طلباً — لا بتّ جماعي له';

/** Is this row answered as an exchange? The qualifier counts only beside «اعتُمد رقم الشركة»; a row from an older server carries none. */
export function isExchange(m: { resolution?: string | null; resolutionKind?: string | null }): boolean {
  return m.resolution === 'ACCEPTED_COURIER' && m.resolutionKind === EXCHANGE_KIND;
}

/**
 * THE ONE KIND OF ROW THAT IS A DIFFERENCE IN MONEY: the company's figure and ours disagree.
 *
 * «رقمنا / رقمهم» is an answer about TWO FIGURES. A parcel we delivered that no statement mentions has one
 * figure only (ours), and a line with no order has the other only (theirs): there is nothing to choose
 * between, so the answer recorded nothing of any use — and the row then counted in the per-person tally
 * as if somebody had given a discount. Those two are lists of things to chase or to link, with their own
 * actions on the ORDER, and they are not counted here. This is also the gate's list: whatever later asks
 * «is anything still undecided» asks it of these rows and of nothing else.
 */
export const DIFFERENCE_RESULTS = ['MISMATCHED'] as const;

/** The rows that name a parcel one side does not have. Never a difference in money, never counted at approval. */
export const MISSING_RESULTS = ['MISSING_IN_STATEMENT', 'MISSING_IN_SYSTEM'] as const;

/** A parcel we delivered that no statement names — «طلبات لم يذكرها أي كشف». */
export function isNotMentioned(m: { result: string }): boolean {
  return m.result === 'MISSING_IN_STATEMENT';
}

export interface MatchRow {
  result: string;
  /** Ours. */
  expectedAmount: number | null;
  /** Theirs. */
  statementAmount: number | null;
  difference: number | null;
  resolution: string | null;
}

/** A row that is a difference at all — a clean match asks nothing. */
export function isDifference(m: Pick<MatchRow, 'result'>): boolean {
  return (DIFFERENCE_RESULTS as readonly string[]).includes(m.result);
}

/** Still waiting for somebody to say which figure stands. The only rows a gate, a lock or a refusal may count. */
export function isOpen(m: Pick<MatchRow, 'result' | 'resolution'>): boolean {
  return isDifference(m) && !m.resolution;
}

/**
 * THE MONEY THE DIFFERENCE IS WORTH, SIGNED THE WAY A SHOP READS IT.
 *
 * Positive is what the courier kept back: we expected more than arrived. A
 * courier who hands over MORE than expected is negative, and it is not a
 * windfall — it is the same defect from the other side and worth the same
 * question.
 *
 * `difference` on the row is `statement − expected`, so the sign is flipped
 * here rather than in a screen, where two screens would flip it twice.
 *
 * ROUNDED BY THE CURRENCY'S MINOR UNIT, handed in by the caller. A dinar has three places: rounding it to two
 * printed a difference of 2.125 as 2.13 on the answer of the door that records which figure stands (RV306).
 */
export function shortfall(
  m: Pick<MatchRow, 'expectedAmount' | 'statementAmount' | 'difference'>,
  minorUnit = 2
): number | null {
  if (m.difference !== null && m.difference !== undefined) return roundMinor(-m.difference, minorUnit);
  if (m.expectedAmount === null || m.statementAmount === null) return null;
  return roundMinor(m.expectedAmount - m.statementAmount, minorUnit);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface PersonDifferences {
  personId: string;
  /** Differences on orders this person handled. */
  differences: number;
  /** Of those, the ones answered with «their figure stands». */
  accepted: number;
  /** Still unanswered. */
  open: number;
  /** The money given away across the accepted ones. */
  acceptedValue: number;
  /** Of the orders of theirs that reached a statement, the share with a difference. */
  rate: number | null;
  /** How many of their orders reached a statement at all. */
  settledOrders: number;
  /**
   * The lines answered «طلب تبديل»: counted HERE and in none of `differences`, `accepted`, `acceptedValue` or `rate` —
   * a replacement or a missing piece sent to the customer is not a discount somebody gave away.
   */
  exchanges: number;
  why: string;
}

/**
 * The minimum number of a person's orders that must have reached a statement
 * before a RATE is stated about them. Below it the counts are still shown —
 * they are facts — but the share is not, because one difference out of three
 * orders is 33% of nothing.
 */
export const MIN_SETTLED_ORDERS = 20;

export interface PersonRow {
  personId: string;
  settledOrders: number;
  /** Without the exchanges: the query leaves them out of this, of `accepted` and of `acceptedValue` (they have their own number). */
  differences: number;
  accepted: number;
  acceptedValue: number;
  /** The lines answered «طلب تبديل». Absent (an older caller) is none. */
  exchanges?: number;
}

/**
 * WHO A DIFFERENCE BELONGS TO, COUNTED.
 *
 * «أصلاً في إحصائيات على بنت المتابعة: بتقرأ التعليقات الداخلية وبتشوف إذا
 * عملت خصومات.» The person who agreed the discount is the person whose
 * orders keep arriving short, and until it is counted nobody can tell a
 * generous agent from an unlucky one.
 *
 * The counts are always shown; the RATE is withheld below the floor, and
 * the row says which of the two it is rather than printing a percentage of
 * three orders.
 */
export function differencesByPerson(rows: PersonRow[]): PersonDifferences[] {
  return rows
    .map((r) => {
      const enough = r.settledOrders >= MIN_SETTLED_ORDERS;
      const rate = enough ? round2((r.differences / r.settledOrders) * 100) / 100 : null;
      return {
        personId: r.personId,
        differences: r.differences,
        accepted: r.accepted,
        open: Math.max(0, r.differences - r.accepted),
        acceptedValue: round2(r.acceptedValue),
        settledOrders: r.settledOrders,
        exchanges: r.exchanges ?? 0,
        rate,
        why: enough
          ? `${r.differences} فرقاً على ${r.settledOrders} طلباً وصلت كشفاً`
          : `${r.settledOrders} طلباً فقط وصلت كشفاً — تحت الحدّ ${MIN_SETTLED_ORDERS}، فلا نسبة`,
      };
    })
    .sort((a, b) => b.acceptedValue - a.acceptedValue || b.differences - a.differences);
}
