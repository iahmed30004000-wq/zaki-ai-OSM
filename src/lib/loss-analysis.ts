import { NO_ANSWER_CLOSE, REJECTION_REASONS, REJECTION_REASON_AR } from './confirmation-workflow';
import {
  DELIVERY_FAILURE_REASONS,
  DELIVERY_FAILURE_REASON_LABELS,
  RETURN_REASONS,
  RETURN_REASON_LABELS,
} from './shipping-workflow';

/**
 * WHERE ORDERS DIE, WHY, AND WHICH OF IT COST MONEY.
 *
 * The dashboard counted rejections and never once asked why: `rejected: 41`
 * beside «الأكثر رفضاً» naming a product. Three structured fields hold the
 * answer — `rejectionReason` before confirmation, `deliveryFailureReason`
 * and `returnReason` after shipping — and not one report read any of them.
 *
 * THE TWO HALVES ARE NOT THE SAME KIND OF LOSS, and that is the whole
 * reason they are reported apart rather than as one «إلغاءات» number:
 *
 *   BEFORE CONFIRMATION nothing was spent. The order never shipped, no fee
 *   was paid, no stock left the shelf. What it cost is calls — and calling
 *   it money lost would be a lie, because an order that was never going to
 *   convert is not a loss, it is a lead. So this half is reported as counts
 *   and shares, with NO money column. A number nobody can defend is worse
 *   than a missing one.
 *
 *   AFTER SHIPPING money actually left: the courier's delivery fee, paid
 *   whatever happens, plus his return fee to bring the parcel back, plus
 *   the goods themselves when they come back damaged. Those are invoices.
 *
 * AND THE FINDING THE COUNTS CANNOT GIVE. The expensive half and the cheap
 * half share their failures. «عنوان خاطئ» after shipping and «رقم خاطئ»
 * before it are one defect — our own data — caught once for the price of a
 * phone call and once for the price of two courier fees. So the report ends
 * on one number: what the after-shipping half spent on failures that a
 * better call before shipping would have caught. That is the only line on
 * it anybody can act on this week.
 */

export const LOSS_STAGES = ['BEFORE_CONFIRMATION', 'AFTER_SHIPPING'] as const;
export type LossStage = (typeof LOSS_STAGES)[number];

/**
 * WHOSE DEFECT, because it is the only classification that changes what
 * somebody does on Monday.
 *
 *   OUR_DATA  — what we hold about the customer is wrong. Fixable at entry.
 *   OUR_REACH — we could not get to them in time. Fixable in scheduling.
 *   CUSTOMER  — they said no. Not a defect; a conversion rate.
 *   OUTSIDE   — neither of us. Coverage, or a parcel damaged in transit.
 *   UNKNOWN   — «أخرى», and anything stored that is not in a vocabulary.
 */
export const FAULTS = ['OUR_DATA', 'OUR_REACH', 'CUSTOMER', 'OUTSIDE', 'UNKNOWN'] as const;
export type Fault = (typeof FAULTS)[number];

export const FAULT_AR: Record<Fault, string> = {
  OUR_DATA: 'بياناتٌ عندنا خاطئة',
  OUR_REACH: 'لم نصل إليه في وقته',
  CUSTOMER: 'قرارُ العميل',
  OUTSIDE: 'خارج أيدينا',
  UNKNOWN: 'غير محدَّد',
};

/** Only these two are ours to fix, and only they enter the «كان يمكن تفاديه» sum. */
export const OUR_FAULTS: readonly Fault[] = ['OUR_DATA', 'OUR_REACH'];

const BEFORE_FAULT: Record<string, Fault> = {
  PRICE_TOO_HIGH: 'CUSTOMER',
  // The customer's decision, like «السعر مرتفع» — but it is the one
  // rejection that names a competitor, so it is kept apart from it:
  // «غالي» is a question about this customer, «لقاها أرخص» is a question
  // about the market, and only the second can be answered by a number.
  FOUND_CHEAPER_ELSEWHERE: 'CUSTOMER',
  CUSTOMER_CHANGED_MIND: 'CUSTOMER',
  CUSTOMER_DOES_NOT_WANT_PRODUCT: 'CUSTOMER',
  DUPLICATE_ORDER: 'OUR_DATA',
  WRONG_NUMBER: 'OUR_DATA',
  // Our own typing error, by the name the contract gives it.
  MODERATOR_DATA_ERROR: 'OUR_DATA',
  // Three calls, no answer. Nothing about the customer is known to be
  // wrong — we simply never got them on the line.
  NO_ANSWER_3_ATTEMPTS: 'OUR_REACH',
  // Five counted «لا يرد» over two days («جدول المحاولات»): the same defect, a longer chase.
  NO_ANSWER_5_ATTEMPTS: 'OUR_REACH',
  FAKE_ORDER: 'OUTSIDE',
  OUT_OF_SERVICE_AREA: 'OUTSIDE',
  OTHER: 'UNKNOWN',
};

const FAILURE_FAULT: Record<string, Fault> = {
  // The number we hold does not reach him — the same defect as WRONG_NUMBER
  // before confirmation, found after the fee was paid.
  PHONE_UNREACHABLE: 'OUR_DATA',
  WRONG_ADDRESS: 'OUR_DATA',
  ADDRESS_NOT_FOUND: 'OUR_DATA',
  // He exists and answers; nobody agreed a time he could be there.
  CUSTOMER_NOT_AVAILABLE: 'OUR_REACH',
  CUSTOMER_REFUSED: 'CUSTOMER',
  CUSTOMER_REQUESTED_DELAY: 'CUSTOMER',
  AREA_NOT_SERVICED: 'OUTSIDE',
  OTHER: 'UNKNOWN',
};

const RETURN_FAULT: Record<string, Fault> = {
  CUSTOMER_REFUSED: 'CUSTOMER',
  CUSTOMER_REQUEST: 'CUSTOMER',
  FAILED_DELIVERY: 'OUR_REACH',
  WRONG_PRODUCT: 'OUR_DATA',
  DAMAGED_PRODUCT: 'OUTSIDE',
  OTHER: 'UNKNOWN',
};

/** Which vocabulary a stored value belongs to, and what it is called. */
export type LossField = 'rejectionReason' | 'deliveryFailureReason' | 'returnReason';

const VOCAB: Record<LossField, { stage: LossStage; codes: readonly string[]; fault: Record<string, Fault> }> = {
  rejectionReason: { stage: 'BEFORE_CONFIRMATION', codes: REJECTION_REASONS, fault: BEFORE_FAULT },
  deliveryFailureReason: { stage: 'AFTER_SHIPPING', codes: DELIVERY_FAILURE_REASONS, fault: FAILURE_FAULT },
  returnReason: { stage: 'AFTER_SHIPPING', codes: RETURN_REASONS, fault: RETURN_FAULT },
};

export function stageOf(field: LossField): LossStage {
  return VOCAB[field].stage;
}

/**
 * IS THIS ONE OF OUR CODES, OR SOMETHING ELSE ENTIRELY?
 *
 * It matters more here than anywhere. `returnReason` measured 31 distinct
 * values across 31 orders on this database — the courier's own prose, with
 * his waybill number stuck to the front and several notes concatenated. All
 * of it arrived through the import from the old system, and the launch is a
 * clean start, so the live writers are the ones that enforce the vocabulary.
 *
 * Two live writers do not: the write-off closes a lost parcel with a
 * sentence, and a region transfer stores the transfer's own reason. Both are
 * real and both land in this field, so «غير مصنَّف» is not a theoretical
 * bucket and it carries its own count on the report. Grouping free text
 * yields one row per order, which is how a report says nothing while
 * appearing to say something.
 */
export function isKnownCode(field: LossField, value: string | null): boolean {
  return !!value && VOCAB[field].codes.includes(value);
}

export function faultOf(field: LossField, value: string | null): Fault {
  if (!isKnownCode(field, value)) return 'UNKNOWN';
  return VOCAB[field].fault[value as string] ?? 'UNKNOWN';
}

/** In Arabic, falling back to the stored value rather than to an English constant. */
export function reasonLabel(field: LossField, value: string | null): string {
  if (!value) return 'بلا سبب مُسجَّل';
  if (!isKnownCode(field, value)) return value;
  if (field === 'rejectionReason') return REJECTION_REASON_AR[value] ?? value;
  const table = field === 'returnReason' ? RETURN_REASON_LABELS : DELIVERY_FAILURE_REASON_LABELS;
  return table[value]?.ar ?? value;
}

/** One group as the database hands it over. */
export interface LossRow {
  field: LossField;
  reason: string | null;
  count: number;
  /** Money that actually left, in the store's currency. Zero before confirmation. */
  money: number;
}

export interface LossLine {
  field: LossField;
  reason: string;
  label: string;
  fault: Fault;
  known: boolean;
  count: number;
  money: number;
  /** Of this stage's total count. */
  share: number;
}

export interface LossHalf {
  stage: LossStage;
  count: number;
  money: number;
  lines: LossLine[];
  /** Stored values that are in no vocabulary — counted, never hidden. */
  unclassified: { count: number; money: number };
  byFault: { fault: Fault; label: string; count: number; money: number }[];
}

export interface LossReport {
  before: LossHalf;
  after: LossHalf;
  /**
   * What the after-shipping half spent on failures that were ours: a wrong
   * number, an address nobody could find, a delivery nobody scheduled. Every
   * one of them was answerable on the phone, before a fee was paid.
   */
  preventable: { money: number; count: number; shareOfAfterMoney: number };
}

/**
 * The one line every unrecognised value lands on. A reserved key rather than
 * an empty string, so a genuinely null reason and a sentence we cannot read
 * are never the same row.
 */
export const UNCLASSIFIED = '__UNCLASSIFIED__';
export const UNCLASSIFIED_AR = 'سببٌ غيرُ مُصنَّف — نصٌّ حرّ';

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * THE WHOLE ANALYSIS, from grouped rows — no database, no clock.
 *
 * Kept pure so the classification and the arithmetic can be argued with in a
 * test instead of in a query, and so the same rows can come from a report,
 * a job or the assistant without three versions of the reading.
 */
export function summariseLoss(rows: readonly LossRow[]): LossReport {
  const halves: Record<LossStage, LossHalf> = {
    BEFORE_CONFIRMATION: emptyHalf('BEFORE_CONFIRMATION'),
    AFTER_SHIPPING: emptyHalf('AFTER_SHIPPING'),
  };

  for (const row of rows) {
    if (row.count <= 0) continue;
    const half = halves[stageOf(row.field)];
    const known = isKnownCode(row.field, row.reason);
    // Before confirmation nothing was spent, whatever a caller passes: the
    // one number on this half that could be wrong is a money number, so it
    // is not the caller's to decide.
    const money = stageOf(row.field) === 'BEFORE_CONFIRMATION' ? 0 : row.money;

    half.count += row.count;
    half.money = round2(half.money + money);

    if (!known) {
      half.unclassified.count += row.count;
      half.unclassified.money = round2(half.unclassified.money + money);
    }

    /**
     * ONE LINE FOR EVERYTHING WE DO NOT UNDERSTAND.
     *
     * Measured on the real database: 31 unrecognised values across 31 orders,
     * each the courier's own sentence with his waybill number stuck to the
     * front. Drawn one per row that is 31 lines of count 1 — a panel nobody
     * reads, saying nothing it does not already say in the bucket's total. So
     * they collapse into a single line carrying the count and the money, and
     * the sentences stay where they belong, on the order and on the returns
     * screen. The count is never hidden; only the prose is.
     *
     * Two fields feed the after-shipping half and they overlap —
     * CUSTOMER_REFUSED is in both vocabularies. Known codes are kept as
     * separate lines with the field on each, because «رفض قبل التسليم» and
     * «رفض فأُرجع» are two events, and merging them by spelling would invent
     * a number.
     */
    const key = known ? (row.reason ?? '') : UNCLASSIFIED;
    const existing = half.lines.find((l) => l.field === row.field && l.reason === key);
    if (existing) {
      existing.count += row.count;
      existing.money = round2(existing.money + money);
    } else {
      half.lines.push({
        field: row.field,
        reason: key,
        label: known ? reasonLabel(row.field, row.reason) : UNCLASSIFIED_AR,
        fault: faultOf(row.field, row.reason),
        known,
        count: row.count,
        money: round2(money),
        share: 0,
      });
    }
  }

  for (const half of Object.values(halves)) {
    for (const line of half.lines) {
      line.share = half.count ? round2((line.count / half.count) * 100) : 0;
    }
    /**
     * RANKED BY WHAT IT COSTS, and by count only where nothing costs.
     *
     * The commonest reason is usually not the expensive one — twelve
     * customers changing their minds cost nothing, and three parcels sent to
     * an address nobody could find cost six fees. A report sorted by count
     * puts the cheap row first and is read top-down.
     */
    half.lines.sort((a, b) => b.money - a.money || b.count - a.count);

    const faults = new Map<Fault, { count: number; money: number }>();
    for (const line of half.lines) {
      const at = faults.get(line.fault) ?? { count: 0, money: 0 };
      faults.set(line.fault, { count: at.count + line.count, money: round2(at.money + line.money) });
    }
    half.byFault = [...faults.entries()]
      .map(([fault, v]) => ({ fault, label: FAULT_AR[fault], ...v }))
      .sort((a, b) => b.money - a.money || b.count - a.count);
  }

  const after = halves.AFTER_SHIPPING;
  const ours = after.lines.filter((l) => OUR_FAULTS.includes(l.fault));
  const money = round2(ours.reduce((s, l) => s + l.money, 0));

  return {
    before: halves.BEFORE_CONFIRMATION,
    after,
    preventable: {
      money,
      count: ours.reduce((s, l) => s + l.count, 0),
      shareOfAfterMoney: after.money ? round2((money / after.money) * 100) : 0,
    },
  };
}

/**
 * ONE ROW FOR «CLOSED BECAUSE NOBODY ANSWERED», TWO CODES UNDER IT (the planner 15/11, answer 8) — A DISPLAY, NEVER THE DATA.
 *
 * The close is stored under two codes: `NO_ANSWER_3_ATTEMPTS` (the older rule) and `NO_ANSWER_5_ATTEMPTS` («جدول المحاولات»). They stay two in the database, in every payload and in
 * every report (`summariseLoss` above is untouched and still returns one line per code). What a person reading REASONS wants is one «أُغلق بلا رد» — so the screen asks THIS for the
 * rows it draws: the merged row (the sum, the same fault and share arithmetic) with the two codes' own lines kept as its `detail`, indented under it.
 *
 * It merges only when BOTH codes hold orders. A company that has only ever used one — which is every company with the plan off, where the new code never occurs — gets its
 * lines back untouched, object for object: the very row it always read, with no detail and no new label.
 */
export const NO_ANSWER_MERGED_KEY = '__NO_ANSWER_CLOSED__';
export const NO_ANSWER_MERGED_AR = 'أُغلق بلا رد';
const NO_ANSWER_LOSS_CODES: readonly string[] = [NO_ANSWER_CLOSE.three.reason, NO_ANSWER_CLOSE.five.reason];

/** A line as the screen draws it: a plain line, or the merged row with the lines it stands for. */
export type LossDisplayLine = LossLine & { detail?: LossLine[] };

export function lossDisplayLines(half: Pick<LossHalf, 'count' | 'lines'>): LossDisplayLine[] {
  const own = NO_ANSWER_LOSS_CODES.map((code) => half.lines.find((l) => l.field === 'rejectionReason' && l.reason === code && l.count > 0));
  if (own.some((l) => !l)) return half.lines;
  const detail = own as LossLine[];

  const count = detail.reduce((s, l) => s + l.count, 0);
  const merged: LossDisplayLine = {
    field: 'rejectionReason',
    reason: NO_ANSWER_MERGED_KEY,
    label: NO_ANSWER_MERGED_AR,
    // Both are our reach; if a future edit ever splits them, the merged row says what the first says rather than invent a third answer.
    fault: detail[0].fault,
    known: true,
    count,
    money: round2(detail.reduce((s, l) => s + l.money, 0)),
    share: half.count ? round2((count / half.count) * 100) : 0,
    detail,
  };
  // Where the report ranks it by what it costs: the merged row stands wherever its SUM puts it (a tie keeps the place of its first line), the rest keep their order.
  const lines: LossDisplayLine[] = [];
  for (const l of half.lines) {
    if (l === detail[0] || l === detail[1]) {
      if (!lines.includes(merged)) lines.push(merged);
    } else {
      lines.push(l);
    }
  }
  return lines.sort((a, b) => b.money - a.money || b.count - a.count);
}

function emptyHalf(stage: LossStage): LossHalf {
  return { stage, count: 0, money: 0, lines: [], unclassified: { count: 0, money: 0 }, byFault: [] };
}
