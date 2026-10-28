import { toLatinDigits } from '../latin-digits';
import { canonicalPhone, isValidPhoneFor, ruleFor } from '../phone-rules';

/**
 * «رقم الهاتف» OF A TELEGRAM MESSAGE — READ THE WAY A SELLER WRITES IT, NEVER REFUSED FOR ITS SHAPE.
 *
 * The owner, 28/10: «اريد يكون التنسيق يقبل كل انواع الارقام والمفتاح السوري وكل انواع الارقام ولا يرفض الرسالة بسبب الرقم».
 *
 * A seller writes the Syrian code in every way: +963 · 00963 · 963 · 0963 · (+963) · 09xx · 9xx, with the trunk zero after
 * the code («+963 0933…»), with spaces, dots, dashes, slashes and brackets, on an Arabic or a Persian keypad, behind a word
 * («واتساب 0933…»), and sometimes two numbers in one line. Every one of those is the same number, and this file turns it
 * into the ONE form the rest of the system already agrees on: the store's own number as `0` + national (`0933620102`),
 * or a foreign one as `+` + digits. `isValidPhoneFor`, `canonicalPhone` (the customer's key and the blacklist's key) read
 * that form identically — so nothing here invents a second idea of what a phone is, and `phone-rules.ts` is untouched.
 *
 * A number that still does not pass `isValidPhoneFor` after all this is not guessed at: the reading says `valid: false`.
 * It is still ACCEPTED when it has at least `MIN_PHONE_DIGITS` digits (the owner, 29/10, from two real messages one digit
 * short: «اريده يكون يقبل كل الارقام») — the order is made with the number as written, and the order's notes say it does
 * not fit the country's shape, so the confirmation call is the check. Below that («12», «123», five digits) it is no number
 * anybody can ring, and the door holds the message for a person. Only a value with no digit at all (or only zeros, which
 * `canonicalPhone` reads as nothing) is no phone: `null`.
 *
 * PURE. No I/O.
 */

export interface PhoneReading {
  /** The number the customer is made from, cleaned. */
  primary: string;
  /** Whether `primary` passes the store country's own rule (`isValidPhoneFor`). */
  valid: boolean;
  /** Whether the order may be made with it: it passes the rule, or it is long enough to be a number someone could ring. */
  accepted: boolean;
  /** Any other numbers in the line, cleaned and without the primary — the customer's second phone, and the notes. */
  others: string[];
}

/** The fewest digits a value needs to be taken as a phone number when it does not fit the country's shape. */
export const MIN_PHONE_DIGITS = 6;

const BIDI = /[\u200e\u200f\u202a-\u202e\u2066-\u2069\u061c]/g;

const digitsOf = (s: string) => s.replace(/\D/g, '');
const withoutTrunkZero = (s: string) => s.replace(/^0/, '');

/**
 * ONE number, whatever its dress, as the form the system's phone functions agree on — or `null` without a digit.
 * It does not judge: the caller asks `isValidPhoneFor` of the result.
 */
export function cleanPhone(piece: string, countryCode?: string | null): string | null {
  const text = toLatinDigits(piece).replace(BIDI, '');
  const first = text.search(/\d/);
  if (first < 0) return null;
  const plus = text.slice(0, first).includes('+');
  let digits = digitsOf(text);
  if (digits.startsWith('00')) digits = digits.slice(2);
  const marked = plus || digitsOf(text).startsWith('00');

  const rule = ruleFor(countryCode);
  if (!rule) return marked ? `+${digits}` : digits;

  const code = rule.dialCode;
  if (marked) {
    // The code was written on purpose: «+963 0933…» is the trunk zero after it, still the same number.
    if (digits.startsWith(code)) {
      const rest = withoutTrunkZero(digits.slice(code.length));
      if (rule.national.test(rest)) return `0${rest}`;
    }
    return `+${digits}`;
  }

  // No marker: the number as the store writes it first («933620102», «0933620102») — a national mobile may itself
  // begin with the digits of the code — and only then the code written without a marker («963933620102», «0963933620102»).
  const own = withoutTrunkZero(digits);
  if (rule.national.test(own)) return `0${own}`;
  if (own.startsWith(code)) {
    const rest = withoutTrunkZero(own.slice(code.length));
    if (rule.national.test(rest)) return `0${rest}`;
  }
  return digits;
}

/**
 * What separates two numbers: a new line, a slash, a comma of either script, a semicolon, a bar, «و» before the next one,
 * and a «+» that opens the next number after a space. (A dash with spaces around it is handled below, because «0933 - 620 -
 * 102» is one number written with gaps.)
 */
const HARD_SEPARATORS = /[\n\r\\/،,;؛|]+|\s+و\s*(?=[+(\d])|(?<=\d)و\s*(?=[+(\d])|(?<=\d)\s+(?=\+)/;
const DASH_SEPARATOR = /\s+[-–—]\s+/;

/**
 * The line, read. `null` only when there is no phone in it at all (no digit, or nothing but zeros).
 * With no country the validity is the permissive 7–15 digit rule `isValidPhoneFor` falls back to.
 */
export function readPhoneText(value: string, countryCode?: string | null): PhoneReading | null {
  const text = toLatinDigits(value ?? '').replace(BIDI, '');
  if (!/\d/.test(text)) return null;

  const valid = (n: string) => isValidPhoneFor(countryCode, n);
  const picked: string[] = [];

  for (const group of text.split(HARD_SEPARATORS)) {
    const fragments = group.split(DASH_SEPARATOR).filter((f) => /\d/.test(f));
    const cleaned = fragments.map((f) => cleanPhone(f, countryCode)).filter((n): n is string => n !== null);
    if (cleaned.length === 0) continue;

    const good = cleaned.filter(valid);
    if (good.length > 0) {
      picked.push(...good);
      continue;
    }
    // «0933 - 620 - 102»: no piece is a number, the pieces together are.
    const joined = fragments.length > 1 ? cleanPhone(fragments.join(' '), countryCode) : null;
    if (joined && valid(joined)) {
      picked.push(joined);
      continue;
    }
    // Nothing valid in this group: keep the longest piece, so a person can see what was written.
    picked.push([...cleaned].sort((a, b) => digitsOf(b).length - digitsOf(a).length)[0]);
  }

  // The same person's number twice is one number; a number that means nothing (only zeros) is none.
  const seen = new Set<string>();
  const numbers = picked.filter((n) => {
    const key = canonicalPhone(n, countryCode);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (numbers.length === 0) return null;

  const primary = numbers.find(valid) ?? [...numbers].sort((a, b) => digitsOf(b).length - digitsOf(a).length)[0];
  // A stub of the line («12») beside a real number is not a second number worth keeping.
  const others = numbers.filter((n) => n !== primary && (valid(n) || digitsOf(n).length >= 7));
  const fits = valid(primary);
  return { primary, valid: fits, accepted: fits || digitsOf(primary).length >= MIN_PHONE_DIGITS, others };
}

/**
 * The key two messages are compared by (the duplicate check): the customer's own key for the line's phone, so
 * «0933620102», «+963 933 620 102» and «٠٩٣٣٦٢٠١٠٢» are one number, and a line with two numbers is its first valid one.
 */
export function phoneKeyOf(value: string, countryCode?: string | null): string {
  const reading = readPhoneText(value, countryCode);
  return canonicalPhone(reading ? reading.primary : value, countryCode);
}
