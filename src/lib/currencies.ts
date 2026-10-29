/**
 * THE CURRENCIES A COUNTRY IS LIKELY TO USE, WITH THEIR OFFICIAL DECIMALS.
 *
 * Choosing a currency sets its decimal places, because the two are not
 * independent facts: a Jordanian dinar has three (the fils), a Kuwaiti
 * dinar three, a dollar two. The form used to ask for both separately and
 * start the decimals at 2 — so a country created as JOD with the default
 * rounded every amount in the system to the wrong unit, quietly, in every
 * COD, commission and settlement it ever touched.
 *
 * The decimals stay editable: this is a correct default, not a lock.
 * Values are ISO 4217 minor units.
 */

export interface CurrencyOption {
  code: string;
  ar: string;
  minorUnit: number;
}

export const CURRENCIES: CurrencyOption[] = [
  { code: 'JOD', ar: 'دينار أردني', minorUnit: 3 },
  { code: 'SYP', ar: 'ليرة سورية', minorUnit: 2 },
  { code: 'USD', ar: 'دولار أمريكي', minorUnit: 2 },
  { code: 'SAR', ar: 'ريال سعودي', minorUnit: 2 },
  { code: 'AED', ar: 'درهم إماراتي', minorUnit: 2 },
  { code: 'KWD', ar: 'دينار كويتي', minorUnit: 3 },
  { code: 'BHD', ar: 'دينار بحريني', minorUnit: 3 },
  { code: 'OMR', ar: 'ريال عُماني', minorUnit: 3 },
  { code: 'QAR', ar: 'ريال قطري', minorUnit: 2 },
  { code: 'IQD', ar: 'دينار عراقي', minorUnit: 3 },
  { code: 'EGP', ar: 'جنيه مصري', minorUnit: 2 },
  { code: 'LBP', ar: 'ليرة لبنانية', minorUnit: 2 },
  { code: 'LYD', ar: 'دينار ليبي', minorUnit: 3 },
  { code: 'TND', ar: 'دينار تونسي', minorUnit: 3 },
  { code: 'MAD', ar: 'درهم مغربي', minorUnit: 2 },
  { code: 'DZD', ar: 'دينار جزائري', minorUnit: 2 },
  { code: 'TRY', ar: 'ليرة تركية', minorUnit: 2 },
  { code: 'EUR', ar: 'يورو', minorUnit: 2 },
];

/**
 * The smallest rate a payer may write to turn one currency into another: what a rate column holds (six decimals).
 * Below it the rate would be USED as written and STORED as something else, and a deduction could turn into nothing.
 */
export const MIN_CONVERT_RATE = 0.000001;

/** The official decimals for a code, or null for one not on the list. */
export function minorUnitFor(code: string): number | null {
  const c = CURRENCIES.find((x) => x.code === code.trim().toUpperCase());
  return c ? c.minorUnit : null;
}

/** "دينار أردني (JOD)" — or the bare code for one not on the list. */
export function currencyLabel(code: string): string {
  const c = CURRENCIES.find((x) => x.code === code.trim().toUpperCase());
  return c ? `${c.ar} (${c.code})` : code;
}
