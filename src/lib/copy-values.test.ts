import { describe, expect, it } from 'vitest';
import { barcodeToCopy, orderNumberToCopy, phoneToCopy } from './copy-values';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * WHAT IS COPIED NEXT TO AN ORDER NUMBER — THE SCREEN'S OWN TEXT, CLEANED.
 *
 * Pure functions, so every edge is a line here: Arabic-Indic digits,
 * invisible direction marks, a plus sign, a number too short to clean, and
 * the three kinds of nothing (null, undefined, whitespace). Nothing is
 * guessed — no country code is added, no barcode is re-cased.
 * ═══════════════════════════════════════════════════════════════════════
 */

const LRM = '‎';
const RLM = '‏';
const NBSP = ' ';
const ZWSP = '​';
const ZWNJ = '‌';
const LRE = '‪';
const PDF = '‬';
const LRI = '⁦';
const PDI = '⁩';
const ALM = '؜';
// Written as escapes: an editor must not be able to swallow the very mark under test.
const WJ = '\u2060';
const NNBSP = '\u202F';

describe('the order number is copied as it is printed', () => {
  it('trims and nothing else', () => {
    expect(orderNumberToCopy('  SY-2026-0148 ')).toBe('SY-2026-0148');
  });

  it('keeps the letter case and the dashes the screen shows', () => {
    expect(orderNumberToCopy('ord-26-5011-A')).toBe('ord-26-5011-A');
  });

  it('drops the invisible marks a right-to-left line wraps around it', () => {
    expect(orderNumberToCopy(`${LRM}SY-0044-A${RLM}`)).toBe('SY-0044-A');
    expect(orderNumberToCopy(`${LRI}SY-0044${PDI}`)).toBe('SY-0044');
    expect(orderNumberToCopy(`${LRE}SY-0044${PDF}`)).toBe('SY-0044');
    expect(orderNumberToCopy(`${ALM}SY-0044`)).toBe('SY-0044');
  });

  it('drops the word joiner and the narrow no-break space too', () => {
    expect(orderNumberToCopy(`SY${WJ}-0044`)).toBe('SY-0044');
    expect(orderNumberToCopy(`${NNBSP}SY-0044${NNBSP}`)).toBe('SY-0044');
  });

  it('speaks for nothing when there is nothing', () => {
    expect(orderNumberToCopy('')).toBe('');
    expect(orderNumberToCopy(null)).toBe('');
    expect(orderNumberToCopy(undefined)).toBe('');
    expect(orderNumberToCopy(`  ${LRM}${NBSP} `)).toBe('');
  });
});

describe('the phone is copied the way a dialler is handed it', () => {
  it('keeps Latin digits and the leading plus, drops what is decorative', () => {
    expect(phoneToCopy('+962 79 123-4567')).toBe('+962791234567');
    expect(phoneToCopy('(079) 123 4567')).toBe('0791234567');
  });

  it('reads Arabic-Indic and Persian digits as Latin', () => {
    expect(phoneToCopy('٠٧٩١٢٣٤٥٦٧')).toBe('0791234567');
    expect(phoneToCopy('۰۷۹۱۲۳۴۵۶۷')).toBe('0791234567');
    expect(phoneToCopy('+٩٦٢ ٧٩ ١٢٣ ٤٥٦٧')).toBe('+962791234567');
  });

  it('takes the direction marks, the no-break space and the zero-width marks out', () => {
    expect(phoneToCopy(`${LRM}079${NBSP}123${ZWSP}4567${RLM}`)).toBe('0791234567');
    expect(phoneToCopy(`${LRI}+962${ZWNJ}791234567${PDI}`)).toBe('+962791234567');
  });

  it('drops the word joiner and the narrow no-break space', () => {
    expect(phoneToCopy(`079${WJ}123${NNBSP}4567`)).toBe('0791234567');
    expect(phoneToCopy(`${NNBSP}${WJ}`)).toBe('');
  });

  it('adds no country code of its own', () => {
    expect(phoneToCopy('0791234567')).toBe('0791234567');
    expect(phoneToCopy('791234567')).toBe('791234567');
  });

  it('keeps an international 00 prefix as the row had it', () => {
    expect(phoneToCopy('00962 79 123 4567')).toBe('00962791234567');
  });

  it('under five digits it is not a number the cleaning can speak for: the row text, in Latin digits', () => {
    expect(phoneToCopy(' ١٢٣ ')).toBe('123');
    expect(phoneToCopy('ext 12')).toBe('ext 12');
  });

  it('a field holding two numbers is NOT glued into one: its text is copied as it is', () => {
    expect(phoneToCopy('0791234567 / 0777654321')).toBe('0791234567 / 0777654321');
    expect(phoneToCopy('0791234567/0777654321')).toBe('0791234567/0777654321');
    expect(phoneToCopy('0791234567، 0777654321')).toBe('0791234567، 0777654321');
    expect(phoneToCopy('0791234567, 0777654321')).toBe('0791234567, 0777654321');
    expect(phoneToCopy('0791234567; 0777654321')).toBe('0791234567; 0777654321');
    expect(phoneToCopy('0791234567؛ 0777654321')).toBe('0791234567؛ 0777654321');
    expect(phoneToCopy('0791234567\n0777654321')).toBe('0791234567\n0777654321');
  });

  it('a number with an extension is copied as it is, not with the extension glued on', () => {
    expect(phoneToCopy('065551234 ext 12')).toBe('065551234 ext 12');
    expect(phoneToCopy('065551234 EXT. 12')).toBe('065551234 EXT. 12');
    expect(phoneToCopy('065551234 داخلي 12')).toBe('065551234 داخلي 12');
    expect(phoneToCopy('065551234 تحويلة 12')).toBe('065551234 تحويلة 12');
  });

  it('as-is means the digits stay as the row had them, but the invisible marks still go', () => {
    expect(phoneToCopy(`${LRM}٠٧٩١٢٣٤٥٦٧ / ٠٧٧٧٦٥٤٣٢١${RLM}`)).toBe('٠٧٩١٢٣٤٥٦٧ / ٠٧٧٧٦٥٤٣٢١');
    expect(phoneToCopy(`079${WJ}1234567 / 0777654321`)).toBe('0791234567 / 0777654321');
  });

  it('a lone hyphen, dot or bracket is decoration, not a second number', () => {
    expect(phoneToCopy('079-123-4567')).toBe('0791234567');
    expect(phoneToCopy('079.123.4567')).toBe('0791234567');
    expect(phoneToCopy('+962 (79) 123 4567')).toBe('+962791234567');
  });

  it('five digits is enough', () => {
    expect(phoneToCopy('12-345')).toBe('12345');
  });

  it('speaks for nothing when there is nothing', () => {
    expect(phoneToCopy('')).toBe('');
    expect(phoneToCopy(null)).toBe('');
    expect(phoneToCopy(undefined)).toBe('');
    expect(phoneToCopy(`${LRM} ${NBSP}`)).toBe('');
  });
});

describe('the barcode is copied exactly as the courier wrote it', () => {
  it('trims and nothing else', () => {
    expect(barcodeToCopy('  9421-0033  ')).toBe('9421-0033');
  });

  it('never changes the case of the letters', () => {
    expect(barcodeToCopy('aB-1234-xY')).toBe('aB-1234-xY');
  });

  it('keeps interior spaces and dashes (a reference is not a phone)', () => {
    expect(barcodeToCopy('JO 12 345-67')).toBe('JO 12 345-67');
  });

  it('does not turn Arabic digits into Latin ones: it is not ours to rewrite', () => {
    expect(barcodeToCopy('٣٤٥')).toBe('٣٤٥');
  });

  it('drops invisible marks', () => {
    expect(barcodeToCopy(`${LRM}9421-0033${RLM}`)).toBe('9421-0033');
    expect(barcodeToCopy(`${WJ}9421${NNBSP}0033`)).toBe('94210033');
  });

  it('speaks for nothing when there is nothing', () => {
    expect(barcodeToCopy('')).toBe('');
    expect(barcodeToCopy(null)).toBe('');
    expect(barcodeToCopy(undefined)).toBe('');
    expect(barcodeToCopy('   ')).toBe('');
  });
});
