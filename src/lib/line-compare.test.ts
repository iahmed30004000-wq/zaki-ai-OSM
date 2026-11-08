import { describe, expect, it, vi } from 'vitest';

vi.mock('./db', () => ({ db: {} }));

import { compareAmounts, compareGovernorates, comparePhones } from './line-compare';

/**
 * «كيف بدي أقارن بين الطلب الموجود والطلب اللي عنا» (the owner, 8/11): the three fields that can be compared without guessing.
 * What these pin is that a mark is never LOUDER than what is known: no phone on one side is «unknown», a Latin name against an
 * Arabic one is «unknown», and only a real disagreement is «different». Every value is invented.
 */

describe('comparePhones', () => {
  const customer = { phone: '900000001', rawPhone: '0900000001' };

  it('the same number in any form a customer may be stored in is the same', () => {
    for (const keys of [['900000001', '963900000001'], ['963900000001'], ['900000001']]) {
      expect(comparePhones(keys, customer, 'SY'), keys.join()).toBe('SAME');
    }
  });

  it('a foreign line is compared with its code: stored whole, or as typed', () => {
    expect(comparePhones(['353871234567'], { phone: '353871234567', rawPhone: '+353 87 123 4567' }, 'SY')).toBe('SAME');
    expect(comparePhones(['353871234567'], { phone: '353871234567' }, 'SY')).toBe('SAME');
  });

  it('another number is different', () => {
    expect(comparePhones(['944111222', '963944111222'], customer, 'SY')).toBe('DIFFERENT');
  });

  it('no phone on the line, or none on the customer, is unknown — not different', () => {
    expect(comparePhones(null, customer, 'SY')).toBe('UNKNOWN');
    expect(comparePhones([], customer, 'SY')).toBe('UNKNOWN');
    expect(comparePhones(['900000001'], { phone: '', rawPhone: null }, 'SY')).toBe('UNKNOWN');
    expect(comparePhones(['900000001'], null, 'SY')).toBe('UNKNOWN');
  });
});

describe('compareGovernorates', () => {
  it('folds hamza, ة/ه, and a leading «محافظة»', () => {
    expect(compareGovernorates('ادلب', 'إدلب')).toBe('SAME');
    expect(compareGovernorates('حماة', 'حماه')).toBe('SAME');
    expect(compareGovernorates('محافظة حلب', 'حلب')).toBe('SAME');
  });

  it('a governorate is a name, not a prefix: «دمشق» is not «ريف دمشق»', () => {
    expect(compareGovernorates('دمشق', 'ريف دمشق')).toBe('DIFFERENT');
    expect(compareGovernorates('حماة', 'حلب')).toBe('DIFFERENT');
  });

  it('a missing side is unknown', () => {
    expect(compareGovernorates(null, 'حماة')).toBe('UNKNOWN');
    expect(compareGovernorates('حماة', '  ')).toBe('UNKNOWN');
    expect(compareGovernorates(undefined, undefined)).toBe('UNKNOWN');
  });

  it('a name in Latin letters against one in Arabic cannot be compared by spelling: unknown, never a red «مختلف»', () => {
    expect(compareGovernorates('Idlib', 'إدلب')).toBe('UNKNOWN');
    expect(compareGovernorates('إدلب', 'Idlib')).toBe('UNKNOWN');
    // …but two Latin spellings, or two Arabic ones, are compared as written.
    expect(compareGovernorates('Idlib', 'idlib')).toBe('SAME');
    expect(compareGovernorates('Idlib', 'Hama')).toBe('DIFFERENT');
  });
});

describe('compareAmounts', () => {
  it('agrees below half of the currency’s smallest unit, and not at it', () => {
    expect(compareAmounts(0, 2)).toBe('SAME');
    expect(compareAmounts(0.004, 2)).toBe('SAME');
    expect(compareAmounts(0.005, 2)).toBe('DIFFERENT');
    expect(compareAmounts(0.0004, 3)).toBe('SAME');
    expect(compareAmounts(0.0005, 3)).toBe('DIFFERENT');
    expect(compareAmounts(16, 2)).toBe('DIFFERENT');
  });

  it('a distance the server could not measure is unknown', () => {
    expect(compareAmounts(null, 2)).toBe('UNKNOWN');
    expect(compareAmounts(undefined, 2)).toBe('UNKNOWN');
    expect(compareAmounts(Number.NaN, 2)).toBe('UNKNOWN');
  });

  it('a currency with no minor unit compares whole numbers', () => {
    expect(compareAmounts(0.4, 0)).toBe('SAME');
    expect(compareAmounts(1, 0)).toBe('DIFFERENT');
  });
});
