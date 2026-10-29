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

/**
 * The categories a person may type, and the directions each one may run in.
 *
 * ONLY «تسوية» AND «أخرى» — a person writing down a movement that has no ledger of its own.
 *
 * «مصروف» and «عمولة» used to be here, running OUT. Each of them HAS a ledger, and a row typed here sits
 * outside it:
 *
 *   · a typed «مصروف» took the money out of the wallet and never reached the expense list, so profit did
 *     not subtract it (the expense door writes the expense and this same movement in one transaction);
 *   · a typed «عمولة» paid money out and left the commission entries «مستحقة», so «صرف» could pay the
 *     same commission a second time.
 *
 * The doors that own them are «سجّل مصروفاً» (finance/route POST) and «صرف» (commission-payout, payroll).
 * They are refused here and the dialog still LISTS them, disabled, with the door to use — marked, not removed.
 */
const HAND_DIRECTIONS: Record<string, readonly HandDirection[]> = {
  ADJUSTMENT: ['IN', 'OUT'],
  OTHER: ['IN', 'OUT'],
};

/** One short line under the category box: where courier money is recorded. */
export const COURIER_MONEY_HINT =
  'تحصيل شركة الشحن لا يُكتب هنا: يُسجَّل عند اعتماد الكشف (إيصال الاستلام) أو من «استلمت منه».';

/** The second line: where the two ledgers that used to be typable here are written now. */
export const OWN_LEDGER_HINT =
  'المصروف من «سجّل مصروفاً» في «الأرباح»، والعمولة من «صرف» في «العمولات»، والراتب من صفحة الموظف.';

/**
 * Categories with a ledger of their own: refused at the hand door in BOTH directions, each with the
 * short pointer the dialog prints beside the disabled option and the sentence the door answers with.
 */
export const OWN_LEDGER: Record<string, { short: string; code: string; error: string }> = {
  EXPENSE: {
    short: 'من «سجّل مصروفاً»',
    code: 'EXPENSE_NOT_BY_HAND',
    error:
      'المصروف ما بينكتب من هون — سجّله من «سجّل مصروفاً» في «الأرباح» فبينخصم من الربح وبيطلع من المحفظة بنفس اللحظة. ' +
      'الراتب من صفحة الموظف. مصروف رجع؟ اكتبه «تسوية» واردة.',
  },
  COMMISSION: {
    short: 'من «صرف» في «العمولات»',
    code: 'COMMISSION_NOT_BY_HAND',
    error:
      'العمولة ما بتنكتب من هون — بتنصرف من «صرف» في «الإعدادات ← العمولات» فبتنعلّم قيودها مدفوعة وما بتنصرف مرتين. ' +
      'عمولة رجعت؟ اكتبها «تسوية» واردة.',
  },
};

/** The categories the dialog may offer for this direction. */
export function handCategoriesFor(direction: HandDirection): string[] {
  return Object.keys(HAND_DIRECTIONS).filter((c) => HAND_DIRECTIONS[c].includes(direction));
}

/** The categories the dialog lists DISABLED, because their own door writes them. */
export function ownLedgerCategories(): string[] {
  return Object.keys(OWN_LEDGER);
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
  if (Object.hasOwn(OWN_LEDGER, category)) {
    const own = OWN_LEDGER[category];
    return { code: own.code, error: own.error };
  }
  const allowed = Object.hasOwn(HAND_DIRECTIONS, category) ? HAND_DIRECTIONS[category] : undefined;
  if (!allowed) return { code: 'UNKNOWN_CATEGORY', error: 'بند غير معروف' };
  if (!allowed.includes(direction)) {
    return { code: 'DIRECTION_NOT_ALLOWED', error: 'هذا البند لا يُكتب بهذا الاتجاه' };
  }
  return null;
}
