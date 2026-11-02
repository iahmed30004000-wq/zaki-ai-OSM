import { toLatinDigits } from './latin-digits';
import { nationalDigits, ruleFor } from './phone-rules';

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
  /** As a person reads it: the trunk zero in front of the national number. */
  shown: string;
  /** The country whose mobile it is. */
  country: 'SY' | 'JO';
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
  return null;
}
