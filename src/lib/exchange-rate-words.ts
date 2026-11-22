/**
 * 22/11 (F2, review): HOW A STOCK TRANSFER'S EXCHANGE RATE IS SAID — one place, read by the server (the ledger note,
 * the list door) and by the screen «نقل البضاعة» (the line under «سعر الصرف» while it is typed). Pure: no database,
 * no money, no import at all, so the screen's bundle carries nothing more than these few lines.
 *
 *   `rateText`     the rate in Western digits with fixed decimals — never «1e-7» — and no trailing zeros.
 *   `rateMirror`   the same rate the other way round: «يعني 1 JOD = 14084.507042 SYP». A rate typed upside down
 *                  (14000 where 0.000071 was meant) reads wrong at once.
 *   `rateLooksOff` a WARNING only (never a refusal): the typed rate is more than 1000× or less than 1/1000 of the
 *                  usual ORDER between the two currencies (the door sends that order; null = unknown, no warning).
 *                  Since the destination's unit cost = the source's × the rate (before the landed lines), this is the
 *                  same as «the converted unit cost is > 1000× or < 0.001× of what that order would make it».
 */

/** Fixed decimals, no exponent, trailing zeros dropped: 0.000071 → «0.000071», 1e-7 → «0.0000001», 14000 → «14000». */
export function rateText(rate: number): string {
  if (!Number.isFinite(rate) || rate <= 0) return String(rate);
  const decimals = rate >= 1 ? 6 : Math.min(20, -Math.floor(Math.log10(rate)) + 5);
  const fixed = rate.toFixed(decimals);
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
}

/** «يعني 1 <to> = <1 ÷ rate> <from>». */
export function rateMirror(rate: number, fromCode: string, toCode: string): string {
  return `يعني 1 ${toCode} = ${rateText(1 / rate)} ${fromCode}`;
}

/** The ledger's words: «بسعر صرف R: 1 SYP = R JOD». */
export function rateWords(rate: number, c: { fromCode: string; toCode: string }): string {
  return `بسعر صرف ${rateText(rate)}: 1 ${c.fromCode} = ${rateText(rate)} ${c.toCode}`;
}

/** More than 1000× off the usual order between the two currencies (either way)? `usual` null = unknown → no. */
export function rateLooksOff(rate: number, usual: number | null | undefined): boolean {
  if (!usual || !(usual > 0) || !(rate > 0) || !Number.isFinite(rate)) return false;
  const ratio = rate / usual;
  return ratio > 1000 || ratio < 0.001;
}
