import { moneyText } from './money';

/**
 * «تم استيراد 292 سطراً بإجمالي 2,869.04 USD» — THE SENTENCE AFTER A STATEMENT IS IMPORTED.
 *
 * It printed the server's number as it came: `2869.040000000001`, the float sum of the file's lines. The server
 * now sends the figure already rounded to the country's minor unit, together with the currency and the minor
 * unit, and this writes it through `moneyText` — the one door every other money figure leaves by — so the
 * grouping, the decimals and the currency read the same here as in the table below it.
 *
 * A figure the screen is only SHOWING: nothing is added or compared here. An answer from an older server (no
 * currency yet) still gets the figure rounded to two places rather than a raw float.
 */
export interface ImportedStatement {
  rows: number;
  total: number;
  currencyCode?: string;
  minorUnit?: number;
  /** Lines the company named and wrote no money against: kept as 0. */
  blankLines?: number;
  /** Status words the phrase table does not hold, as written. */
  unknownWords?: string[];
}

export function importedSentence(res: ImportedStatement): string {
  const total = moneyText(res.total, res.currencyCode ?? null, res.minorUnit ?? 2);
  let sentence = `تم استيراد ${res.rows} سطراً بإجمالي ${total}`;
  // Said once, in the same breath: nothing was dropped, and these are the lines to look at.
  if (res.blankLines) sentence += ` — منها ${res.blankLines} سطراً بلا مبلغ حُفظت صفراً`;
  if (res.unknownWords?.length) sentence += ` — كلمات من الشركة لا نعرفها بعد: ${res.unknownWords.map((w) => `«${w}»`).join('، ')}`;
  return sentence;
}
