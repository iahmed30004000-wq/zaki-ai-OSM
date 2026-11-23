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

// ─────────────── 23/11 (F7): a withdrawal IS a wallet movement — the standing amount is a shortcut that fills its boxes ───────────────

/** A standing amount as the boxes read it: per (partner, currency), and perhaps what it is worth in one store's currency. */
export interface StandingRow {
  partnerId: string;
  currencyCode: string;
  amount: number;
  storeValue: number | null;
  storeCurrencyCode: string | null;
}

/** What the boxes are filled with: the amount, and «ما يعادله» when the wallet's currency is not the store's and one was typed. */
export interface Prefill {
  amount: string;
  storeValue: string | null;
}

/**
 * «من المبلغ الثابت للشريك — تقدر تعدّله» — THE ONE RULE OF THE PRE-FILL, for the wallet dialog and the one press alike.
 *
 *   · no standing row for THIS partner in THE WALLET's currency → null: the boxes stay as today (typed). A row in another currency
 *     is not this one and is ignored — a dinar figure never fills a dollar wallet;
 *   · the wallet is in the store's currency → only the amount (no «ما يعادله» is asked there);
 *   · otherwise the equivalent too, but only when it was typed for THIS store currency; else it stays empty, to be typed.
 * Never a rate worked out here: there is no standing rate in this system, and a guessed one would put a wrong number in a partner's
 * account.
 */
export function standingPrefill(
  standing: readonly StandingRow[],
  partnerId: string,
  walletCurrency: string,
  storeCurrency: string | null
): Prefill | null {
  if (!partnerId || !walletCurrency) return null;
  const row = standing.find((s) => s.partnerId === partnerId && s.currencyCode === walletCurrency);
  if (!row || !(row.amount > 0)) return null;
  const asked = !!storeCurrency && storeCurrency !== walletCurrency;
  const value =
    asked && row.storeCurrencyCode === storeCurrency && row.storeValue !== null && row.storeValue > 0 ? String(row.storeValue) : null;
  return { amount: String(row.amount), storeValue: value };
}

/** One draw (a PARTNER_DRAW wallet movement, the original OUT row) as the dashboard's totals read it. */
export interface DrawLedgerRow {
  storeId: string;
  partnerId: string;
  currencyCode: string;
  amount: number;
  valueInStoreCurrency: number | null;
  /** Taken back through the wallet's reversal door: the pair counts as nothing (the partners' statement's own rule). */
  reversed: boolean;
}

export interface DrawTotal {
  storeId: string;
  partnerId: string;
  currencyCode: string;
  /** In the WALLET's currency. */
  total: number;
  /** What the same draws are worth in the STORE's currency — the figure the partners' statement counts. */
  valueTotal: number;
  count: number;
}

/**
 * THE DASHBOARD'S TOTALS — per (store, partner, wallet currency), in whole minor units; a reversed draw is left out. Two currencies
 * are never added: the wallet currency is part of the key, and the store-currency worth is summed beside it in the store's decimals.
 */
export function drawTotals(
  rows: readonly DrawLedgerRow[],
  minorOf: (code: string) => number,
  storeMinorOf: (storeId: string) => number
): DrawTotal[] {
  const acc = new Map<string, { storeId: string; partnerId: string; currencyCode: string; units: number; valueUnits: number; count: number }>();
  for (const r of rows) {
    if (r.reversed) continue;
    const key = `${r.storeId}|${r.partnerId}|${r.currencyCode}`;
    const cur = acc.get(key) ?? { storeId: r.storeId, partnerId: r.partnerId, currencyCode: r.currencyCode, units: 0, valueUnits: 0, count: 0 };
    cur.units += toMinorUnits(r.amount, minorOf(r.currencyCode));
    cur.valueUnits += toMinorUnits(r.valueInStoreCurrency ?? 0, storeMinorOf(r.storeId));
    cur.count += 1;
    acc.set(key, cur);
  }
  return [...acc.values()].map((t) => ({
    storeId: t.storeId,
    partnerId: t.partnerId,
    currencyCode: t.currencyCode,
    total: fromMinorUnits(t.units, minorOf(t.currencyCode)),
    valueTotal: fromMinorUnits(t.valueUnits, storeMinorOf(t.storeId)),
    count: t.count,
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
