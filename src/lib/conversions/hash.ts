import crypto from 'crypto';
import { toLatinDigits } from '../latin-digits';
import { isForeignNumber, ruleFor } from '../phone-rules';

/**
 * TURNING A CUSTOMER INTO SOMETHING META CAN MATCH BUT NOT READ.
 *
 * The browser pixel in this system is forbidden from carrying any personal
 * detail, and that is right: anything a page sends travels through the
 * customer's own browser, where it can be read. The Conversions API is the
 * opposite case — it runs on our server, and it WANTS the phone and the
 * name, because that is how Meta knows the person who bought is the person
 * who saw the advert.
 *
 * So the rule here is not "no personal data". It is: the raw value never
 * leaves this machine. What leaves is a SHA-256 fingerprint, which Meta
 * compares against the fingerprint of its own records. It cannot be turned
 * back into a phone number. This is stricter than Meta's own Advanced
 * Matching, which sends these fields from the customer's browser.
 *
 * WHY THIS FILE IS THE DANGEROUS ONE.
 *
 * Normalisation must match Meta's byte for byte. "0791234567" and
 * "+962791234567" are the same person and must produce the same hash; if
 * they do not, the match simply fails. And it fails SILENTLY — Meta accepts
 * the event, reports no error, and the match rate quietly sits near zero
 * while the seller believes the integration is working. There is no way to
 * notice this from the outside, which is why every rule below is tested.
 */

/** SHA-256, lowercase hex. Meta accepts nothing else. */
function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Hash a value that is already normalised, or nothing at all.
 *
 * An empty field must be OMITTED, never sent as the hash of an empty
 * string. `e3b0c44...` is a valid-looking hash that matches no human being,
 * and sending it for every customer without an email would drag the match
 * quality down while looking like data.
 */
function hashed(normalised: string | null): string | null {
  return normalised ? sha256(normalised) : null;
}

/**
 * A phone number as Meta wants it: digits only, country code included, no
 * plus sign.
 *
 * Jordan is the default because that is where this system's customers are,
 * and because the shape of a Jordanian mobile is unambiguous: 07XXXXXXXX
 * locally, 9627XXXXXXXX internationally. A number stored as "0791234567"
 * and the same number stored as "+962 79 123 4567" have to reach Meta as
 * the same twelve digits or the person is two people.
 */
export function normalizePhone(raw: string | null | undefined, countryCode = '962'): string | null {
  let digits = String(raw ?? '').replace(/\D+/g, '');
  if (!digits) return null;

  // 00962... — the other way people write a country code.
  if (digits.startsWith('00')) digits = digits.slice(2);

  if (digits.startsWith(countryCode)) {
    // Already international. A local number that merely begins with the
    // same digits would be too short to be one, so length decides.
    const rest = digits.slice(countryCode.length);
    if (rest.length >= 8) return digits;
  }

  // Local form: a single leading zero is a domestic trunk prefix and is not
  // part of the number. Dropping it is what makes 0791… and 96279… agree.
  if (digits.startsWith('0')) digits = digits.replace(/^0+/, '');
  if (!digits) return null;

  return `${countryCode}${digits}`;
}

/**
 * Lowercase, trimmed, and stripped of what is decoration rather than name.
 *
 * Arabic names arrive with the definite article, with kashida, and with
 * vowel marks that the same person will type differently on a different
 * day. Meta's rule is lowercase with punctuation removed; for Arabic the
 * equivalent is to drop the diacritics, which carry no identity and are
 * inconsistently typed. Letters themselves are never touched.
 */
export function normalizeName(raw: string | null | undefined): string | null {
  const v = String(raw ?? '')
    .normalize('NFKC')
    // Arabic diacritics (harakat) and the kashida stretcher.
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .toLowerCase()
    .trim();
  return v || null;
}

/** Split a full name into the first and last part Meta asks for. */
export function splitName(raw: string | null | undefined): { fn: string | null; ln: string | null } {
  const parts = String(raw ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return { fn: null, ln: null };
  if (parts.length === 1) return { fn: normalizeName(parts[0]), ln: null };
  return {
    fn: normalizeName(parts[0]),
    // The last part, not the second: "محمد عبد الله الشمري" surnames on.
    ln: normalizeName(parts[parts.length - 1]),
  };
}

/** A city: lowercase letters and digits, no spaces or punctuation. */
export function normalizeCity(raw: string | null | undefined): string | null {
  return normalizeName(raw);
}

/** An email: lowercase and trimmed. Nothing else — the local part is case-sensitive by spec even if no real provider treats it so. */
export function normalizeEmail(raw: string | null | undefined): string | null {
  const v = String(raw ?? '').trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? v : null;
}

/** A country as a two-letter lowercase code. */
export function normalizeCountry(raw: string | null | undefined, fallback = 'jo'): string | null {
  const v = String(raw ?? '').trim().toLowerCase();
  if (/^[a-z]{2}$/.test(v)) return v;
  return fallback || null;
}

/** The customer, as Meta receives them. Every value is a fingerprint. */
export interface UserData {
  ph?: string[];
  fn?: string[];
  ln?: string[];
  ct?: string[];
  country?: string[];
  em?: string[];
  external_id?: string[];
  client_ip_address?: string;
  client_user_agent?: string;
  fbc?: string;
  fbp?: string;
}

export interface CustomerFacts {
  phone?: string | null;
  fullName?: string | null;
  city?: string | null;
  email?: string | null;
  country?: string | null;
  /** Our own customer id — hashed too, and the most stable match of all. */
  externalId?: string | null;
  /** Not hashed: Meta uses these as-is and they are not identity on their own. */
  ip?: string | null;
  userAgent?: string | null;
  /** Meta's own click and browser cookies, when the landing page captured them. */
  fbc?: string | null;
  fbp?: string | null;
  /** Defaults to Jordan; a store elsewhere passes its own. */
  phoneCountryCode?: string;
  /** The phone already carries its own country code (a foreign number kept whole): hashed as its digits, nothing added. */
  phoneInternational?: boolean;
}

/**
 * THE PHONE AND THE COUNTRY OF AN ORDER'S CUSTOMER, in the shape `buildUserData` wants — from the ORDER's country.
 *
 * `deliverConversion` passed neither the phone's country code nor the order's country. The phone then fell back to
 * Jordan's 962 (a Syrian 0944123456, stored as 944123456, was hashed as 962944123456) and the country came from
 * `Customer.country`, which no door ever sets, so it was «EG» on every row of every store. Meta matched nothing.
 *
 * The store's country gives the dial code (`ruleFor`) and the lowercase code. A number that is not the store's own but
 * a whole foreign number (stored with its code since RV136) is passed as its digits and not prefixed a second time.
 * A country with no rule keeps the old reading rather than a guess.
 */
export function customerPhoneFacts(
  phone: string | null | undefined,
  orderCountryCode: string | null | undefined
): Pick<CustomerFacts, 'phone' | 'country' | 'phoneCountryCode' | 'phoneInternational'> {
  const code = String(orderCountryCode ?? '').trim().toLowerCase();
  const country = /^[a-z]{2}$/.test(code) ? code : null;
  const rule = ruleFor(orderCountryCode);
  if (!rule || !phone) return { phone: phone ?? null, country };
  const digits = toLatinDigits(String(phone)).replace(/\D/g, '');
  if (isForeignNumber(digits, rule)) return { phone: digits, country, phoneInternational: true };
  return { phone: digits, country, phoneCountryCode: rule.dialCode };
}

/**
 * Build the `user_data` block.
 *
 * Every field is optional and every absent one is omitted rather than sent
 * empty. More fields means a better match, but a wrong field is worse than
 * a missing one: it does not fail, it just matches somebody else's advert
 * to your sale, or nobody's.
 */
export function buildUserData(facts: CustomerFacts): UserData {
  const out: UserData = {};
  const one = (v: string | null) => (v ? [v] : undefined);

  const ph = hashed(
    facts.phoneInternational
      ? String(facts.phone ?? '').replace(/\D+/g, '').replace(/^0+/, '') || null
      : normalizePhone(facts.phone, facts.phoneCountryCode ?? '962')
  );
  if (ph) out.ph = [ph];

  const { fn, ln } = splitName(facts.fullName);
  const fnH = one(hashed(fn));
  if (fnH) out.fn = fnH;
  const lnH = one(hashed(ln));
  if (lnH) out.ln = lnH;

  const ct = one(hashed(normalizeCity(facts.city)));
  if (ct) out.ct = ct;

  const country = one(hashed(normalizeCountry(facts.country)));
  if (country) out.country = country;

  const em = one(hashed(normalizeEmail(facts.email)));
  if (em) out.em = em;

  const ext = one(hashed(facts.externalId ? String(facts.externalId).trim().toLowerCase() : null));
  if (ext) out.external_id = ext;

  // Passed through, not hashed — Meta specifies these as plain values, and
  // hashing them would simply make them unusable.
  if (facts.ip) out.client_ip_address = facts.ip;
  if (facts.userAgent) out.client_user_agent = facts.userAgent;
  if (facts.fbc) out.fbc = facts.fbc;
  if (facts.fbp) out.fbp = facts.fbp;

  return out;
}

/**
 * How much of a match we were able to offer, 0 to 1.
 *
 * Shown to the seller, because the one failure mode of this whole feature
 * is invisible: events arrive, Meta reports no error, and nothing matches.
 * A number on the screen is the only way anyone finds out.
 */
export function matchQuality(u: UserData): number {
  const WEIGHTS: [keyof UserData, number][] = [
    ['ph', 3], ['em', 3], ['external_id', 2],
    ['fn', 1], ['ln', 1], ['ct', 1], ['country', 0.5],
    ['fbc', 2], ['fbp', 1], ['client_ip_address', 0.5], ['client_user_agent', 0.5],
  ];
  const total = WEIGHTS.reduce((s, [, w]) => s + w, 0);
  const got = WEIGHTS.reduce((s, [k, w]) => (u[k] ? s + w : s), 0);
  return Math.round((got / total) * 100) / 100;
}
