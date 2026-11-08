import { toLatinDigits } from './latin-digits';

/**
 * «زر تثبيت وفلاتر وسيرش بوكس» — the owner, 8/11, on a statement of 116 lines in five queues.
 *
 * What a person types into the box above a queue and what a row says are written in different hands: «0900000001» against
 * «+963 900 000 001», «ادلب» against «إدلب», «حماه» against «حماة», Arabic digits against Latin ones. So both sides are put
 * in ONE spelling before they are compared, and every word of the query has to be found (a second word narrows, never
 * widens). A number typed for a phone, a barcode or an order number is also looked for among the DIGITS of each field on its
 * own — never among digits glued across two cells, which is how a row would answer a number nobody wrote.
 *
 * Pure: no database, no clock. Nothing here decides anything about money or about a link; it only hides rows from view.
 */

/** One spelling of a text for searching: Latin digits, no diacritics or stretch, hamza / ة / ى folded, spaces collapsed, lower case. */
function searchKey(text: unknown): string {
  return toLatinDigits(String(text ?? ''))
    .normalize('NFKC')
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** The shortest digit run searched inside a field's digits: three digits would match half of every phone. */
const MIN_DIGITS = 4;

/**
 * Does the row answer the query?
 *
 * `fields` are the cells a number can be typed against (barcodes, order numbers, a phone, a name, an address, the governorate):
 * words are looked for in their text, and a typed number also in each one's own digits (trunk zero ignored, so «0900000001»
 * finds «+963 900 000 001»). `text` are free blobs — the company's whole row — looked in as text only.
 * An empty query answers yes.
 */
export function matchesQuery(parts: { fields: ReadonlyArray<unknown>; text?: ReadonlyArray<unknown> }, query: string): boolean {
  const words = searchKey(query).split(' ').filter(Boolean);
  if (words.length === 0) return true;
  const fields = parts.fields.map(searchKey).filter(Boolean);
  const haystack = [...fields, ...(parts.text ?? []).map(searchKey).filter(Boolean)].join(' ');
  const digitCells = fields.map((f) => f.replace(/\D/g, '')).filter((d) => d.length >= MIN_DIGITS);
  return words.every((word) => {
    if (haystack.includes(word)) return true;
    // «+963900000001» is a number typed with its plus: the plus is not a digit, and not a reason to miss the phone.
    const typed = word.startsWith('+') ? word.slice(1) : word;
    if (/^\d+$/.test(typed)) {
      const bare = typed.replace(/^0+/, '');
      return bare.length >= MIN_DIGITS && digitCells.some((d) => d.includes(bare));
    }
    return false;
  });
}
