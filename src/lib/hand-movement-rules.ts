/**
 * WHAT MAY BE TYPED BY HAND INTO A WALLET — as a rule the door and the dialog both read.
 *
 * «حركة جديدة» used to take any category in either direction. So a courier's collection could be typed
 * in by hand (and then written again when its statement was approved), and an «مصروف» could be typed as
 * money coming IN. Two rows for one set of money is the defect; this is the door that closes it.
 *
 * Courier money has exactly two doors: the receipt of an approved statement, and «استلمت منه». A transfer
 * has its own door too. Everything else is a person writing down what happened, and each category runs in
 * the direction it can honestly run in.
 *
 * Pure on purpose: the server refuses with it and the dialog offers only what it allows, so the sentence
 * on the screen is the sentence the server would have answered with. It imports nothing — the dialog is a
 * client component and the wallet module reaches the database.
 */

export type HandDirection = 'IN' | 'OUT';

export interface HandRefusal {
  code: string;
  error: string;
}

/** The categories a person may type, and the directions each one may run in. */
const HAND_DIRECTIONS: Record<string, readonly HandDirection[]> = {
  EXPENSE: ['OUT'],
  COMMISSION: ['OUT'],
  ADJUSTMENT: ['IN', 'OUT'],
  OTHER: ['IN', 'OUT'],
};

/** One short line under the category box: where courier money is recorded. */
export const COURIER_MONEY_HINT =
  'تحصيل شركة الشحن لا يُكتب هنا: يُسجَّل عند اعتماد الكشف (إيصال الاستلام) أو من «استلمت منه».';

const ONLY_OUT: Record<string, string> = {
  EXPENSE: 'المصروف صادر بس',
  COMMISSION: 'العمولة صادرة بس',
};

/** The categories the dialog may offer for this direction. */
export function handCategoriesFor(direction: HandDirection): string[] {
  return Object.keys(HAND_DIRECTIONS).filter((c) => HAND_DIRECTIONS[c].includes(direction));
}

/** Null when a person may type this pair; otherwise the door's refusal. */
export function handMovementRefusal(category: string, direction: HandDirection): HandRefusal | null {
  if (category === 'COURIER_SETTLEMENT') {
    return {
      code: 'COURIER_NOT_BY_HAND',
      error:
        'تحصيل شركة الشحن ما بينكتب باليد — بيتسجّل لحاله لما ينعتمد الكشف (إيصال الاستلام)، أو من «استلمت منه». ' +
        'إذا الشركة دفعت فرق كشف معتمد، اكتبها «تسوية» ورقم الكشف بالملاحظة.',
    };
  }
  if (category === 'TRANSFER_IN' || category === 'TRANSFER_OUT') {
    return { code: 'TRANSFER_NOT_BY_HAND', error: 'التحويل بين المحافظ من «تحويل»، مش من هون' };
  }
  const allowed = HAND_DIRECTIONS[category];
  if (!allowed) return { code: 'UNKNOWN_CATEGORY', error: 'بند غير معروف' };
  if (!allowed.includes(direction)) {
    return { code: 'DIRECTION_NOT_ALLOWED', error: ONLY_OUT[category] ?? 'هذا البند لا يُكتب بهذا الاتجاه' };
  }
  return null;
}
