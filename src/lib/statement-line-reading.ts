import { toLatinDigits } from './latin-digits';
import { canonicalPhone, nationalDigits, phoneKeys, phoneKeysAnyStore, ruleFor } from './phone-rules';

/**
 * A COURIER'S LINE, READ FOR A PERSON — what the matching screen shows under «سبب الشركة», and the phone the link
 * dialog searches by.
 *
 * Nothing here writes, sums or judges money. The figures it shows are the ones the import already parsed into their
 * own columns (`StatementLine.amount / collected / fee`); the raw row is only read to find what those columns do NOT
 * hold — the notes cell, a name, a phone — and is always handed back whole as well, so nothing the company wrote is
 * hidden behind the tidy version.
 *
 * `rawRow` is the cells joined by « | » (`parseStatementRows`) with no header beside it, so a cell's column is not
 * known here. What IS known is which cells repeat a parsed column: the reference, the barcode, the status word, a
 * figure equal to one of the three amounts. Every other non-empty cell is what the company wrote besides them.
 */

export const RAW_CELL_SEPARATOR = ' | ';

export interface LineForReading {
  merchantRef: string | null;
  barcode: string | null;
  amount: string | number | null;
  collected?: string | number | null;
  fee?: string | number | null;
  status: string | null;
  rawRow: string | null;
  /**
   * Who the parcel went to, as the company's own headings said it when the file was imported (`StatementLine.receiver*`).
   * Absent or null on a line imported before they were kept, and on a file that had no such column: such a line is read
   * from its raw row exactly as it always was.
   */
  receiverName?: string | null;
  receiverPhone?: string | null;
  receiverAddress?: string | null;
  receiverCity?: string | null;
  receiverArea?: string | null;
}

export interface CourierRowReading {
  /** Our order number as the company wrote it (merchant reference), or null. */
  orderRef: string | null;
  barcode: string | null;
  /** The net the company states for the line. */
  amount: number | null;
  collected: number | null;
  fee: number | null;
  status: string | null;
  /** The cells that repeat none of the above: the notes column, a name, a city — the company's own words. */
  rest: string[];
  /** The whole row, untouched. */
  raw: string | null;
}

const asNumber = (v: string | number | null | undefined): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** A cell that is a plain figure — «25000», «(50)», «17.505», «٢٥٠٠٠» — as a number; anything else is null. */
function plainFigure(cell: string): number | null {
  const t = toLatinDigits(cell).replace(/\s+/g, '');
  const m = /^(\()?(-)?(\d+(?:\.\d+)?)(\))?$/.exec(t);
  if (!m) return null;
  if (Boolean(m[1]) !== Boolean(m[4])) return null;
  const n = Number(m[3]);
  return m[1] || m[2] ? -n : n;
}

const same = (a: string | null, b: string) => a !== null && a.trim().toLowerCase() === b.trim().toLowerCase();

export function splitRawRow(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw.split(RAW_CELL_SEPARATOR).map((c) => c.trim());
}

/** The line, with each piece under its own name and what is left of the row beside them. */
export function readCourierRow(line: LineForReading): CourierRowReading {
  const amount = asNumber(line.amount);
  const collected = asNumber(line.collected);
  const fee = asNumber(line.fee);
  const figures = [amount, collected, fee].filter((n): n is number => n !== null);

  const rest = splitRawRow(line.rawRow).filter((cell) => {
    if (!cell) return false;
    if (same(line.merchantRef, cell) || same(line.barcode, cell) || same(line.status, cell)) return false;
    const n = plainFigure(cell);
    if (n !== null && figures.some((f) => Math.abs(f - n) < 1e-9)) return false;
    return true;
  });

  return {
    orderRef: line.merchantRef?.trim() || null,
    barcode: line.barcode?.trim() || null,
    amount,
    collected,
    fee,
    status: line.status?.trim() || null,
    rest,
    raw: line.rawRow?.trim() || null,
  };
}

/**
 * THE CUSTOMER'S PHONE IN A COURIER'S ROW — a Syrian or a Jordanian MOBILE, nothing looser.
 *
 * Written any of the ways a sheet carries it: 0933620102 · 933620102 · +963 933 620 102 · 00963933620102 ·
 * 0791234567 · +962 79 123 4567 · in Arabic digits. A landline, a barcode, an amount or a date is not a mobile of
 * either country, and the reference and barcode cells are skipped outright, so a parcel number that happens to have
 * ten digits is never read as somebody's phone.
 *
 * The store's own country is tried first, so a number that fits both readings is read as the store's.
 */
const MOBILE: Record<string, RegExp> = {
  SY: /^9\d{8}$/,
  JO: /^7[789]\d{7}$/,
};

export interface LinePhone {
  /** As a person reads it: the trunk zero in front of the national number — or «+code…» for a number of another country. */
  shown: string;
  /**
   * The country whose MOBILE it is. `OTHER` is any other number the company wrote as a phone: a foreign line («+353…»,
   * «00966…» — the north of Syria runs on Turkish lines and families abroad order for home) or a landline.
   */
  country: 'SY' | 'JO' | 'OTHER';
  /** Every form a customer's stored phone may take for this number (own country: national; abroad: with its code). */
  keys: string[];
}

/** A run of digits a phone may be written in: an optional + or 00, then digits with spaces, dashes, dots or brackets. */
const RUN = /(?:\+|(?<!\d))[\d٠-٩۰-۹][\d٠-٩۰-۹\s\-().]{6,18}[\d٠-٩۰-۹](?!\d)/g;
const BIDI = /[‎‏‪-‮⁦-⁩؜]/g;

function readMobile(piece: string, order: ('SY' | 'JO')[]): LinePhone | null {
  const text = toLatinDigits(piece).replace(BIDI, '');
  for (const country of order) {
    const rule = ruleFor(country);
    if (!rule) continue;
    const national = nationalDigits(text, rule.dialCode);
    if (MOBILE[country].test(national)) {
      return { shown: `0${national}`, country, keys: [national, `${rule.dialCode}${national}`] };
    }
  }
  return null;
}

/**
 * One run may hold more than a phone: «0933620102 - 25000», two numbers side by side. The whole run is tried first
 * (so «+963 933 620 102» stays one number), then every stretch of its pieces, leftmost and longest first.
 */
function mobileInRun(run: string, order: ('SY' | 'JO')[]): LinePhone | null {
  const whole = readMobile(run, order);
  if (whole) return whole;
  const pieces = run.split(/\s+[-–—]\s+|\s+/).filter(Boolean);
  for (let start = 0; start < pieces.length; start++) {
    for (let end = pieces.length; end > start; end--) {
      if (start === 0 && end === pieces.length) continue;
      const found = readMobile(pieces.slice(start, end).join(' '), order);
      if (found) return found;
    }
  }
  return null;
}

/**
 * A CELL THAT IS, FROM END TO END, A NUMBER WRITTEN INTERNATIONALLY — «+353 87 123 4567», «00966 5X XXX XXXX».
 *
 * The one shape a foreign phone is read from a row with NO heading: it starts with `+` or `00` and holds nothing else. A
 * date («46322.57921296296»), a quantity («1.0»), a parcel number and a note never start that way, so reading these cannot
 * turn one of them into somebody's phone — which is why a Syrian or Jordanian mobile is still looked for FIRST, anywhere
 * in the row, and this is only the last resort.
 */
const INTERNATIONAL_CELL = /^(?:\+|00)\s*\d[\d\s\-().]{7,17}\d$/;

export function phoneFromRawRow(
  line: Pick<LineForReading, 'rawRow' | 'merchantRef' | 'barcode'>,
  storeCountry?: string | null
): LinePhone | null {
  const own = String(storeCountry ?? '').toUpperCase();
  const order: ('SY' | 'JO')[] = own === 'JO' ? ['JO', 'SY'] : ['SY', 'JO'];
  for (const cell of splitRawRow(line.rawRow)) {
    if (!cell || same(line.merchantRef, cell) || same(line.barcode, cell)) continue;
    for (const m of toLatinDigits(cell).replace(BIDI, '').matchAll(RUN)) {
      const found = mobileInRun(m[0], order);
      if (found) return found;
    }
  }
  // No Syrian or Jordanian mobile anywhere in the row. A foreign customer's number written with + or 00 as a cell of
  // its own is still the customer's phone («زر المطابقة عبر الهاتف مش شغال» — five lines of a real Basha file).
  for (const cell of splitRawRow(line.rawRow)) {
    if (!cell || same(line.merchantRef, cell) || same(line.barcode, cell)) continue;
    const text = toLatinDigits(cell).replace(BIDI, '').trim();
    if (!INTERNATIONAL_CELL.test(text)) continue;
    // A Syrian or Jordanian code was judged by its own country's rule above and refused («+962 71…» is no mobile head):
    // it does not come back in through here as «a foreign number».
    if (/^96[23]/.test(text.replace(/\D/g, '').replace(/^00/, ''))) continue;
    const found = phoneFromCell(text, storeCountry);
    if (found) return found;
  }
  return null;
}

/**
 * THE PHONE OF A CELL THE COMPANY HEADED AS A PHONE («هاتف المستلم») — read as a phone, whatever country it is from.
 *
 * `phoneFromRawRow` has no heading to go by, so it accepts only a Syrian or Jordanian MOBILE: anything looser would turn
 * a parcel number into a customer. A cell whose own heading says «phone» needs no such suspicion, so the same readings
 * come first (a Syrian or Jordanian mobile keeps its keys exactly as before) and what is left is read as the address book
 * writes a number: a foreign line with its country code, a landline with its trunk zero gone (`canonicalPhone`), and the
 * other stored form of each (`phoneKeys`) — so a customer saved before the country code was kept is found too.
 *
 * Seven to fifteen digits once a leading `00` is gone (E.164 stops at fifteen); a cell that holds two numbers
 * («0933620102 - 0944111222») is read from its first one. Anything else — «لا يوجد», a date — is no phone.
 */
export function phoneFromCell(text: string | null | undefined, storeCountry?: string | null): LinePhone | null {
  const clean = toLatinDigits(String(text ?? '')).replace(BIDI, '').trim();
  if (!clean) return null;
  const own = String(storeCountry ?? '').toUpperCase();
  const order: ('SY' | 'JO')[] = own === 'JO' ? ['JO', 'SY'] : ['SY', 'JO'];

  for (const m of clean.matchAll(RUN)) {
    const run = m[0];
    const digits = run.replace(/\D/g, '');
    // More digits than any one number has: two numbers share this run, and the stretches are tried leftmost first.
    if (digits.length > 15) {
      const found = mobileInRun(run, order);
      if (found) return found;
      continue;
    }
    // The WHOLE run as one number — never a stretch of it: «+353 78 123 4567» is an Irish number, not a Jordanian «78 123 4567».
    const mobile = readMobile(run, order);
    if (mobile) return mobile;
    const national = digits.replace(/^00/, '');
    if (national.length < 7 || national.length > 15) continue;
    const canonical = canonicalPhone(run, storeCountry);
    if (!canonical) continue;
    const international = run.trim().startsWith('+') || digits.startsWith('00');
    return {
      shown: international ? `+${national}` : digits,
      country: 'OTHER',
      keys: [...new Set([...phoneKeys(canonical), ...phoneKeysAnyStore(run)])],
    };
  }
  return null;
}

/**
 * WHAT THE SCREEN SAYS ABOUT A COMPANY'S LINE — the four things the owner asked for («العنوان والمحافظة ورقم الهاتف
 * والحالة»), and the name beside them, which is what a person compares first.
 *
 * Read from the five cells the import kept under the company's own headings. A line imported before they were kept has
 * none of them: its phone is looked for in the raw row as it always was (a Syrian or Jordanian mobile, or a cell that is
 * wholly a number written with + or 00), and its name, address and governorate are simply not known — the raw row is
 * still one press away.
 *
 * A column that WAS in the file and holds something that is no phone gives no phone: the row is not searched for
 * another number to put in its place (BACKLOG RV762 — that is how the sender's number came to be searched).
 */
export interface LineEssentials {
  /** The company's own status word, as it wrote it. */
  status: string | null;
  phone: LinePhone | null;
  name: string | null;
  address: string | null;
  /** The company's governorate and the area under it, apart — for the comparison. */
  city: string | null;
  area: string | null;
  /** «حماة»، or «ريف دمشق — ضواحي دمشق» when the area says something more than the governorate does. */
  governorate: string | null;
  /** The pieces came from the company's headings (a line imported with them), not from the raw row. */
  fromHeadings: boolean;
}

export const GOVERNORATE_JOIN = ' — ';

/** What `lineEssentials` reads: no figures at all (a database row carries them as decimals, a screen's as strings). */
export type LineForEssentials = Pick<
  LineForReading,
  'merchantRef' | 'barcode' | 'status' | 'rawRow' | 'receiverName' | 'receiverPhone' | 'receiverAddress' | 'receiverCity' | 'receiverArea'
>;

export function lineEssentials(line: LineForEssentials, storeCountry?: string | null): LineEssentials {
  const clean = (v: string | null | undefined) => v?.trim() || null;
  const name = clean(line.receiverName);
  const address = clean(line.receiverAddress);
  const city = clean(line.receiverCity);
  const area = clean(line.receiverArea);
  const phoneCell = clean(line.receiverPhone);
  const fromHeadings = !!(name || address || city || area || phoneCell);

  const phone = phoneCell ? phoneFromCell(phoneCell, storeCountry) : phoneFromRawRow(line, storeCountry);
  const sameText = (a: string, b: string) => a.replace(/\s+/g, ' ').toLowerCase() === b.replace(/\s+/g, ' ').toLowerCase();
  const governorate = city ? (area && !sameText(area, city) ? `${city}${GOVERNORATE_JOIN}${area}` : city) : area;

  return { status: clean(line.status), phone, name, address, city, area, governorate, fromHeadings };
}
