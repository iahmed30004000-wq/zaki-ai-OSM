/**
 * WHAT WROTE A WALLET MOVEMENT, IN WORDS (22/11) — the «المرجع» line of the eye panel.
 *
 * One name for every `referenceType` a writer in this codebase stores (pinned by `movement-reference.test.ts`, which reads the
 * writers). A type nobody named yet is said as «مرجع آخر», never as the English code: every visible word is Arabic.
 */
export const MOVEMENT_REFERENCE_AR: Record<string, string> = {
  STATEMENT: 'كشف شركة الشحن',
  TRANSFER: 'تحويل بين المحافظ',
  COMMISSION_PERIOD: 'فترة عمولة',
  ORDER: 'طلب',
  PARTNER_DRAW: 'سحب شريك',
  EXPENSE: 'مصروف',
  MANUAL_COLLECTION: 'تحصيل يدوي من التتبع',
  PAYSLIP: 'راتب',
};

export const UNKNOWN_REFERENCE_AR = 'مرجع آخر';

export function movementReferenceAr(type: string): string {
  return MOVEMENT_REFERENCE_AR[type] ?? UNKNOWN_REFERENCE_AR;
}
