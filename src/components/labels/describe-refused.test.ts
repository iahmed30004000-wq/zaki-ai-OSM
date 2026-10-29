import { describe, expect, it } from 'vitest';
import { describeRefused } from './openWaybills';
import { WAITING_FOR_BARCODE } from '@/lib/waybill';

/**
 * The dialog that says which orders did not print. Thirty-five orders waiting for their courier's barcode must not be
 * thirty-five entries; a couple of orders keep the plain «رقم (سبب)» form the screens always showed.
 */
describe('describeRefused', () => {
  it('a few orders keep one entry each, as before', () => {
    expect(
      describeRefused([
        { orderNumber: 'SY-1', reason: 'لم يُؤكَّد' },
        { orderNumber: 'SY-2', reason: 'بلا شركة شحن' },
      ]),
    ).toBe('SY-1 (لم يُؤكَّد)، SY-2 (بلا شركة شحن)');
  });

  it('a reason shared by many is said once, with the count and the first three numbers', () => {
    const many = Array.from({ length: 35 }, (_, i) => ({ orderNumber: `ORD-${i + 1}`, reason: WAITING_FOR_BARCODE }));
    const text = describeRefused([...many, { orderNumber: 'SY-9', reason: 'لم يُؤكَّد' }]);
    expect(text).toBe(`35 طلب (${WAITING_FOR_BARCODE}): ORD-1، ORD-2، ORD-3…، SY-9 (لم يُؤكَّد)`);
    expect(text).not.toContain('ORD-35');
  });

  it('exactly three still list each one; four group', () => {
    const three = Array.from({ length: 3 }, (_, i) => ({ orderNumber: `A${i}`, reason: 'x' }));
    expect(describeRefused(three)).toBe('A0 (x)، A1 (x)، A2 (x)');
    expect(describeRefused([...three, { orderNumber: 'A3', reason: 'x' }])).toBe('4 طلب (x): A0، A1، A2…');
  });

  it('nothing refused is nothing said', () => {
    expect(describeRefused([])).toBe('');
  });
});
