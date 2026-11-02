import type { Prisma } from '@prisma/client';
import { readCourierWord, type CourierOutcome } from './couriers/words';
import { stateGroup } from './settlement-decisions';
import { EXCLUDED_RESULT } from './statement-open-lines';

/**
 * WHEN A STATEMENT LINE IS NOT MONEY — «تم ارجاعها الي بالكشف… لا تحطها استبعدها… ممكن يكون الطلب مؤجل او مرتجع
 * وفي اصلا عندي قسم للمرتجعات» (the owner, 2/11).
 *
 * A line at zero beside «تم ارجاعها» or «مؤجلة» used to be a question: against a parcel still on the road it came
 * out «فرق في المبلغ» and could only be parked, by hand, with a reason — and until somebody did, the whole statement
 * waited. Against a parcel the returns desk had already closed it came out clean and the approval SETTLED the order
 * over the desk's «NOT_APPLICABLE» and wrote the line's fee as money the customer paid.
 *
 * It is neither. It is the company saying it delivered nothing and collected nothing, so the matching writes it as
 * `EXCLUDED`: not open, never settled, and the order is left to the door that owns it — the returns desk for a parcel
 * coming back, the next statement for one that waits.
 *
 * ── ONLY WHEN EVERY ONE OF THESE HOLDS — money is never hidden ──
 *
 *   · the line is ZERO: net 0, no collected figure other than 0, and no fee other than 0. A returned line of −5,000 is
 *     a fee the company charged and deducted; so is a line written 5,000 collected, 5,000 fee, 0 net — the net is
 *     zero but a fee was taken (RV807). Either stays a question, or a fee nobody agreed to would vanish from sight;
 *   · the company's word is one we KNOW says «not delivered»: returned, postponed, cancelled, still on the road. An
 *     empty cell, an unknown word, «delivered» or «partly delivered» at zero is a real question and stays one;
 *   · OUR parcel agrees it was not delivered: on the road, or coming back. If our door recorded it delivered, the
 *     company's zero contradicts it and that is money to chase — a question. A parcel that never left is a
 *     question too.
 *
 * Pure: no database, no clock.
 */

/** The company's words that say the parcel was not delivered. */
export const NOT_DELIVERED_WORDS: readonly CourierOutcome[] = ['RETURNED', 'POSTPONED', 'CANCELLED', 'IN_TRANSIT'];

type Num = Prisma.Decimal | number | string | null | undefined;

export interface ExclusionLine {
  /** The net — what the company hands over for this line. */
  amount: Num;
  /** What the customer paid at the door, when the file states it. */
  collected?: Num;
  /** The fee the company kept or charged for this line, when the file states it. */
  fee?: Num;
  /** The company's status cell. */
  status?: string | null;
}

/** Is this line, against this order, not money at all? */
export function isExcludedLine(line: ExclusionLine, order: { shippingStatus: string | null | undefined }): boolean {
  if (Number(line.amount ?? 0) !== 0) return false;
  if (line.collected != null && Number(line.collected) !== 0) return false;
  if (line.fee != null && Number(line.fee) !== 0) return false;
  const reading = readCourierWord(line.status);
  if (!reading || !reading.known || !NOT_DELIVERED_WORDS.includes(reading.outcome)) return false;
  const group = stateGroup(order.shippingStatus);
  return group === 'IN_FLIGHT' || group === 'COMING_BACK';
}

/** The sentence written beside an excluded row. */
export function excludedNote(status: string | null | undefined): string {
  const phrase = readCourierWord(status)?.phrase ?? '';
  return `استُبعد من المطابقة — قالت الشركة «${phrase}» بصفر: مش مصاري، والطلب بيتابعه قسم المرتجعات أو الكشف الجاي`;
}

export { EXCLUDED_RESULT };
