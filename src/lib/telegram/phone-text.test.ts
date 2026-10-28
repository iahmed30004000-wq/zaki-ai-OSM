import { describe, expect, it } from 'vitest';
import { canonicalPhone, isValidPhoneFor } from '../phone-rules';
import { cleanPhone, phoneKeyOf, readPhoneText } from './phone-text';
import { readLabeledOrder } from './labeled-order';

/**
 * «اريد يكون التنسيق يقبل كل انواع الارقام والمفتاح السوري … ولا يرفض الرسالة بسبب الرقم» — THE PHONE READER, ON ITS OWN.
 *
 * Every spelling of one Syrian number must come out as the same number the rest of the system keys on, and a number that is
 * not a number must say so (`valid: false`) instead of being guessed at. The reader never throws and never touches a database.
 */

const SY = 'SY';
const SAME = '933620102';

describe('every way of writing one Syrian number is that number', () => {
  it.each([
    ['+963 933 620 102'],
    ['+963933620102'],
    ['00963933620102'],
    ['00963 933 620 102'],
    ['963933620102'],
    ['0963933620102'],
    ['0933620102'],
    ['933620102'],
    ['٠٩٣٣٦٢٠١٠٢'],
    ['۰۹۳۳۶۲۰۱۰۲'],
    ['+٩٦٣ ٩٣٣ ٦٢٠ ١٠٢'],
    ['0933-620-102'],
    ['0933.620.102'],
    ['0933 620 102'],
    ['(+963) 933620102'],
    ['(0963) 933620102'],
    ['+963 0933620102'],
    ['+963-933-620-102'],
    ['واتساب 0933620102'],
    ['موبايل: 0933620102'],
    ['0933620102 جوال'],
    ['هاتف +963 933 620 102 واتس'],
    ['0933 - 620 - 102'],
  ])('«%s»', (written) => {
    const r = readPhoneText(written, SY);
    expect(r).not.toBeNull();
    expect(r!.valid).toBe(true);
    expect(r!.others).toEqual([]);
    // The form the system keys a customer and a block on.
    expect(canonicalPhone(r!.primary, SY)).toBe(SAME);
    expect(isValidPhoneFor(SY, r!.primary)).toBe(true);
    expect(phoneKeyOf(written, SY)).toBe(SAME);
  });

  it.each([
    ['011 1234567', '111234567'],
    ['+963 11 1234567', '111234567'],
    ['0963 21 123456', '21123456'],
    ['0211234567', '211234567'],
  ])('a landline «%s»', (written, key) => {
    const r = readPhoneText(written, SY)!;
    expect(r.valid).toBe(true);
    expect(canonicalPhone(r.primary, SY)).toBe(key);
  });

  it('a foreign line keeps its code and is valid for a store that takes foreign numbers', () => {
    const r = readPhoneText('+90 532 123 45 67', SY)!;
    expect(r.valid).toBe(true);
    expect(canonicalPhone(r.primary, SY)).toBe('905321234567');
  });

  it('a Jordanian store reads its own code the same way', () => {
    for (const written of ['+962 79 123 4567', '00962791234567', '0791234567', '791234567', '+962 0791234567']) {
      const r = readPhoneText(written, 'JO')!;
      expect(r.valid, written).toBe(true);
      expect(canonicalPhone(r.primary, 'JO'), written).toBe('791234567');
    }
  });

  it('a country with no rule reads digits and the + as written', () => {
    expect(readPhoneText('+49 151 2345678', 'DE')).toMatchObject({ primary: '+491512345678', valid: true });
  });
});

describe('a number that is no number says so', () => {
  it.each([
    ['12'],
    ['123'],
    ['12345'],
    ['ab12'],
    ['09336201'],
    ['+963 12'],
    ['0933 62010'],
    ['09336201022'],
  ])('«%s» is read, and it is not valid', (written) => {
    const r = readPhoneText(written, SY);
    expect(r).not.toBeNull();
    expect(r!.valid).toBe(false);
  });

  it.each([[''], ['   '], ['واتساب'], ['—'], ['0'], ['0000'], ['00']])('«%s» has no phone in it at all → null', (written) => {
    expect(readPhoneText(written, SY)).toBeNull();
  });

  it('is not rescued by another country’s rule: a Jordanian line is not valid on a store with no foreign allowance', () => {
    expect(readPhoneText('0933620102', 'JO')!.valid).toBe(false);
  });
});

describe('two numbers in one line', () => {
  it.each([
    ['0933620102 - 0944123456'],
    ['0933620102 / 0944123456'],
    ['0933620102، 0944123456'],
    ['0933620102 , 0944123456'],
    ['0933620102 و 0944123456'],
    ['0933620102و0944123456'],
    ['0933620102 و0944123456'],
    ['0933620102; 0944123456'],
    ['0933620102 +963 944 123 456'],
    ['0933620102 | 0944123456'],
    ['واتساب 0933620102 / موبايل 0944123456'],
  ])('«%s» → the first valid one is the phone, the other is kept', (written) => {
    const r = readPhoneText(written, SY)!;
    expect(canonicalPhone(r.primary, SY)).toBe(SAME);
    expect(r.valid).toBe(true);
    expect(r.others.map((n) => canonicalPhone(n, SY))).toEqual(['944123456']);
  });

  it('a stub before the real number is not the phone', () => {
    const r = readPhoneText('12 و 0933620102', SY)!;
    expect(canonicalPhone(r.primary, SY)).toBe(SAME);
    expect(r.valid).toBe(true);
    expect(r.others).toEqual([]);
  });

  it('a stub after the real number is dropped, not kept as a second phone', () => {
    const r = readPhoneText('0933620102 - 12', SY)!;
    expect(r.valid).toBe(true);
    expect(r.others).toEqual([]);
  });

  it('the first VALID one wins even when it is second', () => {
    const r = readPhoneText('099 / 0933620102', SY)!;
    expect(canonicalPhone(r.primary, SY)).toBe(SAME);
  });

  it('the same number twice, in two spellings, is one number', () => {
    const r = readPhoneText('0933620102 / +963 933 620 102', SY)!;
    expect(r.others).toEqual([]);
  });

  it('two numbers that are both no numbers: the longer one is shown, and it is not valid', () => {
    const r = readPhoneText('12 / 12345', SY)!;
    expect(r.valid).toBe(false);
    expect(r.primary).toBe('12345');
  });
});

describe('cleanPhone', () => {
  it('turns a Syrian number into 0 + national, and a foreign one into + digits', () => {
    expect(cleanPhone('(+963) 933 620 102', SY)).toBe('0933620102');
    expect(cleanPhone('+90 532 123 45 67', SY)).toBe('+905321234567');
    expect(cleanPhone('abc', SY)).toBeNull();
  });

  it('a national mobile that happens to begin with the digits of the code is still national', () => {
    // 963123456 is nine digits starting with 9: a mobile, not "963" + "123456".
    expect(cleanPhone('963123456', SY)).toBe('0963123456');
  });
});

describe('the labeled reader never refuses a message for how the number is written', () => {
  const message = (phone: string) =>
    [
      'تاريخ الطلب: 2026-10-28 17:45:32',
      'إسم العميل: محمد',
      `رقم الهاتف: ${phone}`,
      'عنوان العميل: دمشق',
      'إسم المنتج: ماء',
      'إسم العرض: قطعة',
      'السعر: 25',
      'الكمية: 1',
    ].join('\n');
  const store = { country: { code: 'SY', name: 'سوريا', currencyCode: 'USD', minorUnit: 2 }, receivedAt: new Date('2026-10-28T14:45:40Z') };

  it.each(['+963 933 620 102', '00963933620102', '0933620102', '933620102', '٠٩٣٣٦٢٠١٠٢', '0933-620-102', '(+963) 933620102'])('«%s» is read', (written) => {
    expect(readLabeledOrder(message(written), store)).toMatchObject({ ok: true, phone: { valid: true, others: [] } });
  });

  it('a second number on the NEXT line is part of the phone, not a stray line', () => {
    const r = readLabeledOrder(message('0933620102\n0944123456'), store);
    expect(r).toMatchObject({ ok: true, phone: { others: ['0944123456'] } });
  });

  it('a next line that is not a number is still a stray line', () => {
    expect(readLabeledOrder(message('0933620102\nشكراً'), store)).toMatchObject({ ok: false, reason: 'STRAY_LINE' });
  });

  it.each([['+96398101968'], ['+963096061306'], ['09336201'], ['123456']])('«%s» does not fit the shape but is taken: accepted, valid false', (written) => {
    expect(readLabeledOrder(message(written), store)).toMatchObject({ claimed: true, ok: true, phone: { valid: false, accepted: true } });
  });

  it.each([['12'], ['123'], ['12345'], ['ab12'], ['+963 12']])('«%s» → INVALID_PHONE, the fields kept for the screen', (written) => {
    expect(readLabeledOrder(message(written), store)).toMatchObject({ claimed: true, ok: false, reason: 'INVALID_PHONE', fields: { phone: written } });
  });

  it('no digit → MISSING_PHONE; without a store the permissive 7–15 digit rule judges', () => {
    expect(readLabeledOrder(message('واتساب'), store)).toMatchObject({ ok: false, reason: 'MISSING_PHONE' });
    expect(readLabeledOrder(message('0933620102'))).toMatchObject({ ok: true });
    expect(readLabeledOrder(message('12'))).toMatchObject({ ok: false, reason: 'INVALID_PHONE' });
  });
});
