import { describe, expect, it } from 'vitest';
import { undoImportRefusal } from './settlement-gates';

/**
 * «زر إلغاء الاستيراد لغاية قبل ما أعمل اعتماد أفضل».
 * One function, read by the server and the screen: a statement may be taken back at EVERY step until it is
 * approved — before approval nothing financial was written from it — and never after.
 */
describe('undoImportRefusal', () => {
  it('lets a statement be taken back at every step before approval', () => {
    for (const status of ['IMPORTED', 'RECEIPTED', 'MATCHED']) {
      expect(undoImportRefusal({ status, approvedAt: null }), status).toBeNull();
    }
  });

  it('NEGATIVE: an approved statement — by stamp or by status — is never taken back, and says why', () => {
    expect(undoImportRefusal({ status: 'MATCHED', approvedAt: '2026-10-24T00:00:00Z' })?.code).toBe('ALREADY_APPROVED');
    expect(undoImportRefusal({ status: 'APPROVED', approvedAt: null })?.code).toBe('ALREADY_APPROVED');
    // (Was: toContain('قيد عكسي'). The lock gives every door of a closed statement one sentence — the way back is a settlement statement.)
    expect(undoImportRefusal({ status: 'APPROVED' })?.error).toBe('الكشف مغلق نهائياً — التصحيح بكشف تسوية');
  });
});
