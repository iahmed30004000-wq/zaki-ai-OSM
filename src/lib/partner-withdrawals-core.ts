import { roundMinor, toMinorUnits, fromMinorUnits } from './money';
import { CURRENCIES } from './currencies';
import { readTypedFigure } from './numeric-input';

/**
 * «المسحوبات» — THE ARITHMETIC AND THE REFUSALS, WITH NO DATABASE (22/11).
 *
 * «الأرباح: حط شاشة مسحوبات وحط العملات» (the owner). A partner's withdrawal is RECORDED here, per store and per currency, from a
 * standing amount typed once. Nothing here moves a wallet, writes an expense or touches the profit or the partners' statement —
 * those read PARTNER_DRAW wallet movements (`partner-statement.ts`) and are not changed by this file.
 *
 * TWO CURRENCIES ARE NEVER ADDED TOGETHER. Every total is keyed by its currency; there is no «grand total», because a dollar and a
 * dinar summed is a number that means nothing. Sums run in whole minor units of the currency, so 0.1 + 0.2 is 0.3.
 */

export const WITHDRAWAL_MAX = 1_000_000_000;

export interface KnownCurrency {
  code: string;
  ar: string;
  minorUnit: number;
}

export interface Refusal {
  status: number;
  code: string;
  errorAr: string;
}

const refusal = (status: number, code: string, errorAr: string): Refusal => ({ status, code, errorAr });

/**
 * THE CURRENCIES A WITHDRAWAL MAY BE IN: the ones the company's countries are priced in and its wallets hold — the currencies the
 * stores actually use. A country's own decimals win (they are the store's settings); a wallet's currency takes the decimals of the
 * country it belongs to, then the list in `currencies.ts`. A code nobody uses is not offered and is refused.
 */
export function knownCurrencies(
  countries: readonly { currencyCode: string; minorUnit: number }[],
  wallets: readonly { currencyCode: string; minorUnit: number }[]
): KnownCurrency[] {
  const out = new Map<string, KnownCurrency>();
  for (const c of [...countries, ...wallets]) {
    const code = c.currencyCode.trim().toUpperCase();
    if (!code || out.has(code)) continue;
    const listed = CURRENCIES.find((x) => x.code === code);
    out.set(code, { code, ar: listed?.ar ?? code, minorUnit: c.minorUnit });
  }
  return [...out.values()].sort((a, b) => a.code.localeCompare(b.code));
}

/** The currency, or the refusal that says it is not one of the stores'. */
export function currencyOrRefusal(code: unknown, known: readonly KnownCurrency[]): KnownCurrency | Refusal {
  const typed = typeof code === 'string' ? code.trim().toUpperCase() : '';
  const found = known.find((c) => c.code === typed);
  if (found) return found;
  return refusal(
    400,
    'UNKNOWN_CURRENCY',
    `العملة «${typed || '—'}» مش من عملات المتاجر — اختار وحدة من: ${known.map((c) => c.code).join('، ') || 'ما في عملات'}.`
  );
}

/**
 * THE AMOUNT, CHECKED AND NEVER ROUNDED BEHIND THE PERSON'S BACK: present, a number, more than zero, at most a billion, and in the
 * currency's own decimals (a fils is not a rounding error — 1.2345 JOD is refused, not stored as 1.235).
 */
export function amountOrRefusal(amount: unknown, currency: KnownCurrency): number | Refusal {
  if (amount === undefined || amount === null || amount === '') {
    return refusal(400, 'AMOUNT_REQUIRED', 'اكتب المبلغ.');
  }
  const n = readTypedFigure(amount) ?? NaN;
  if (!Number.isFinite(n)) return refusal(400, 'AMOUNT_NOT_A_NUMBER', 'المبلغ لازم يكون رقم.');
  if (n <= 0) return refusal(400, 'AMOUNT_NOT_POSITIVE', 'المبلغ لازم يكون أكبر من صفر.');
  if (n > WITHDRAWAL_MAX) return refusal(400, 'AMOUNT_TOO_BIG', `المبلغ ${WITHDRAWAL_MAX} على الأكثر.`);
  if (roundMinor(n, currency.minorUnit) !== n) {
    return refusal(
      400,
      'AMOUNT_DECIMALS',
      currency.minorUnit === 0
        ? `عملة ${currency.code} بلا كسور — اكتب المبلغ رقماً صحيحاً.`
        : `المبلغ بأكثر من ${currency.minorUnit} خانات عشرية — عملة ${currency.code} بخانات ${currency.minorUnit} بس.`
    );
  }
  return n;
}

export const isRefusal = (x: unknown): x is Refusal =>
  typeof x === 'object' && x !== null && 'errorAr' in x && 'code' in x && 'status' in x;

/** One row as the totals read it. */
export interface WithdrawalLedgerRow {
  id: string;
  storeId: string;
  partnerId: string;
  currencyCode: string;
  amount: number;
  reversalOfId: string | null;
}

export interface WithdrawalTotal {
  partnerId: string;
  currencyCode: string;
  total: number;
  count: number;
}

export interface StoreWithdrawalTotal extends WithdrawalTotal {
  storeId: string;
}

/**
 * WHAT STANDS: an original with no reversal. A reversal points back at its original; the pair counts as nothing, and a reversal is
 * never itself a withdrawal.
 */
export function standingRows<T extends WithdrawalLedgerRow>(rows: readonly T[]): T[] {
  const reversed = new Set(rows.flatMap((r) => (r.reversalOfId ? [r.reversalOfId] : [])));
  return rows.filter((r) => !r.reversalOfId && !reversed.has(r.id));
}

/**
 * THE TOTALS — per (store, partner, currency), in whole minor units. `minorOf` gives a currency's decimals; a currency it does not
 * know is summed at three (the widest the column holds), so nothing is lost. The currency is ALWAYS part of the key.
 */
export function withdrawalTotals(rows: readonly WithdrawalLedgerRow[], minorOf: (code: string) => number): StoreWithdrawalTotal[] {
  const acc = new Map<string, { storeId: string; partnerId: string; currencyCode: string; units: number; count: number }>();
  for (const r of standingRows(rows)) {
    const key = `${r.storeId}|${r.partnerId}|${r.currencyCode}`;
    const minor = minorOf(r.currencyCode);
    const cur = acc.get(key) ?? { storeId: r.storeId, partnerId: r.partnerId, currencyCode: r.currencyCode, units: 0, count: 0 };
    cur.units += toMinorUnits(r.amount, minor);
    cur.count += 1;
    acc.set(key, cur);
  }
  return [...acc.values()].map((t) => ({
    storeId: t.storeId,
    partnerId: t.partnerId,
    currencyCode: t.currencyCode,
    total: fromMinorUnits(t.units, minorOf(t.currencyCode)),
    count: t.count,
  }));
}

// ─────────────── 23/11 (F7): a withdrawal IS a wallet movement, in the wallet's own currency ───────────────
//
// «السحوبات الأساسية بتتسجّل سحب من المحفظة بالعملة. مثال أحمد سحب 1000 USDT و1000 دينار و1000 ليرة وهكذا، بدون ما يجيني سعر الصرف»
// (the owner). The standing amount is only a shortcut for the AMOUNT; no equivalent is kept or worked out here.

/** A standing amount as the wallet form reads it: per (partner, currency). */
export interface StandingRow {
  partnerId: string;
  currencyCode: string;
  amount: number;
}

/**
 * «من المبلغ الثابت للشريك — تقدر تعدّله» — THE ONE RULE OF THE PRE-FILL: the standing row of THIS partner in THE WALLET's currency
 * fills the amount; none → null, and the box stays as today (typed). A row in another currency is not this one and is ignored — a
 * dinar figure never fills a dollar wallet. Never a rate, never an equivalent.
 */
export function standingPrefill(standing: readonly StandingRow[], partnerId: string, walletCurrency: string): string | null {
  if (!partnerId || !walletCurrency) return null;
  const row = standing.find((s) => s.partnerId === partnerId && s.currencyCode === walletCurrency);
  return row && row.amount > 0 ? String(row.amount) : null;
}

/** One draw (a PARTNER_DRAW wallet movement, the original OUT row) as the dashboard's totals read it. */
export interface DrawLedgerRow {
  storeId: string;
  partnerId: string;
  currencyCode: string;
  amount: number;
  /** What it is worth in the STORE's currency — only when one was typed; null = a draw in its own currency alone. */
  valueInStoreCurrency: number | null;
  /** Taken back through the wallet's reversal door: the pair counts as nothing (the partners' statement's own rule). */
  reversed: boolean;
}

export interface DrawTotal {
  storeId: string;
  partnerId: string;
  currencyCode: string;
  /** In the WALLET's currency — every standing draw of the key. */
  total: number;
  count: number;
  /** The draws of the key that carry a store-currency worth, and that worth — the figure the partners' statement counts. */
  valueTotal: number;
  valueCount: number;
  /** The draws with NO worth in the store's currency, in the wallet's currency: counted in no share (the statement's «uncounted»). */
  unvaluedTotal: number;
  unvaluedCount: number;
}

/**
 * THE DASHBOARD'S TOTALS — per (store, partner, wallet currency), in whole minor units; a reversed draw is left out. Two currencies
 * are never added: the wallet currency is part of the key; the store-currency worth is summed beside it only over the draws that
 * carry one, and the others are said apart (`unvalued…`) — nothing is converted.
 */
export function drawTotals(
  rows: readonly DrawLedgerRow[],
  minorOf: (code: string) => number,
  storeMinorOf: (storeId: string) => number
): DrawTotal[] {
  type Acc = { storeId: string; partnerId: string; currencyCode: string; units: number; count: number; valueUnits: number; valueCount: number; unvaluedUnits: number; unvaluedCount: number };
  const acc = new Map<string, Acc>();
  for (const r of rows) {
    if (r.reversed) continue;
    const key = `${r.storeId}|${r.partnerId}|${r.currencyCode}`;
    const cur =
      acc.get(key) ??
      { storeId: r.storeId, partnerId: r.partnerId, currencyCode: r.currencyCode, units: 0, count: 0, valueUnits: 0, valueCount: 0, unvaluedUnits: 0, unvaluedCount: 0 };
    const units = toMinorUnits(r.amount, minorOf(r.currencyCode));
    cur.units += units;
    cur.count += 1;
    if (r.valueInStoreCurrency === null) {
      cur.unvaluedUnits += units;
      cur.unvaluedCount += 1;
    } else {
      cur.valueUnits += toMinorUnits(r.valueInStoreCurrency, storeMinorOf(r.storeId));
      cur.valueCount += 1;
    }
    acc.set(key, cur);
  }
  return [...acc.values()].map((t) => ({
    storeId: t.storeId,
    partnerId: t.partnerId,
    currencyCode: t.currencyCode,
    total: fromMinorUnits(t.units, minorOf(t.currencyCode)),
    count: t.count,
    valueTotal: fromMinorUnits(t.valueUnits, storeMinorOf(t.storeId)),
    valueCount: t.valueCount,
    unvaluedTotal: fromMinorUnits(t.unvaluedUnits, minorOf(t.currencyCode)),
    unvaluedCount: t.unvaluedCount,
  }));
}

/** Folds the store away: per (partner, currency) — still never across currencies. */
export function totalsByPartner(byStore: readonly StoreWithdrawalTotal[], minorOf: (code: string) => number): WithdrawalTotal[] {
  const acc = new Map<string, { partnerId: string; currencyCode: string; units: number; count: number }>();
  for (const t of byStore) {
    const key = `${t.partnerId}|${t.currencyCode}`;
    const cur = acc.get(key) ?? { partnerId: t.partnerId, currencyCode: t.currencyCode, units: 0, count: 0 };
    cur.units += toMinorUnits(t.total, minorOf(t.currencyCode));
    cur.count += t.count;
    acc.set(key, cur);
  }
  return [...acc.values()].map((t) => ({
    partnerId: t.partnerId,
    currencyCode: t.currencyCode,
    total: fromMinorUnits(t.units, minorOf(t.currencyCode)),
    count: t.count,
  }));
}

/**
 * «المجموع بالدولار» (23/11, F8) — THE SUM OF THE STORED EQUIVALENTS, AND NOTHING ELSE.
 *
 * Every stored equivalent is in the STORE's currency, so they may be added across the wallets' currencies; a draw with NO stored
 * equivalent is not converted here or anywhere — it stays on its own currency's «بلا سعر» line. Per partner and for the store, in
 * whole minor units of the store's currency.
 */
export function equivalentSums(
  totals: readonly { partnerId: string; valueTotal: number; valueCount: number }[],
  storeMinor: number
): { byPartner: { partnerId: string; value: number; count: number }[]; store: { value: number; count: number } } {
  const acc = new Map<string, { units: number; count: number }>();
  let all = 0;
  let allCount = 0;
  for (const t of totals) {
    if (t.valueCount === 0) continue;
    const units = toMinorUnits(t.valueTotal, storeMinor);
    const cur = acc.get(t.partnerId) ?? { units: 0, count: 0 };
    cur.units += units;
    cur.count += t.valueCount;
    acc.set(t.partnerId, cur);
    all += units;
    allCount += t.valueCount;
  }
  return {
    byPartner: [...acc.entries()].map(([partnerId, v]) => ({ partnerId, value: fromMinorUnits(v.units, storeMinor), count: v.count })),
    store: { value: fromMinorUnits(all, storeMinor), count: allCount },
  };
}

/** «المجموع بالدولار» when the store counts in dollars; otherwise the store's own currency is named. */
export function equivalentSumLabel(storeCode: string): string {
  return storeCode === 'USD' ? 'المجموع بالدولار' : `المجموع بعملة المتجر (${storeCode})`;
}
