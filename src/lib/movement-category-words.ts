/**
 * THE NAME OF A WALLET MOVEMENT'S CATEGORY, IN WORDS — one map for the wallets screen and the history file (22/11, F5).
 *
 * It lived inside `WalletsScreen` only; the history export («سحب سجل الحركات») needs the same words in its «البند» column, and a
 * second copy is how a screen and a file come to call one movement two names. No import: the screen's bundle carries these lines
 * and nothing more. Its keys are pinned to `MOVEMENT_CATEGORIES` (lib/wallets) by the history export's test.
 */
export const MOVEMENT_CATEGORY_AR: Record<string, string> = {
  COURIER_SETTLEMENT: 'تحصيل شركة شحن',
  COMMISSION: 'عمولة',
  EXPENSE: 'مصروف',
  TRANSFER_IN: 'تحويل وارد',
  TRANSFER_OUT: 'تحويل صادر',
  ADJUSTMENT: 'تسوية',
  OTHER: 'أخرى',
  // «السحوبات لازم تنضاف بند» (13/11): a partner's withdrawal, written by its own door and counted in the partners' statement.
  PARTNER_DRAW: 'سحب شريك',
};
