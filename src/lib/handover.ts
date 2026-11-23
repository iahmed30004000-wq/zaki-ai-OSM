import { roundMinor } from './money';
import { receiptsInStatementCurrency, type ReceiptLine } from './receipt-conversion';

/**
 * «استلمت منه» AS A STATEMENT — the rules of the courier's handover that need no database.
 *
 * The owner, on the tracking dialog: «تسوية يدوية للمندوب مش تمام … بدنا نصحح الموضوع زي الكشوفات للمناديب والشركات اللي
 * بدون API». So a courier's handover is no longer a door of its own that writes money: it is the MANUAL STATEMENT, reached
 * from the tracking screen. The orders join that courier's draft (`addOrdersToDraft`), the draft is gathered under a
 * reference (`assembleDraft`), each payment is a receipt with its own wallet, currency and rate (the receipts door), and the
 * approval writes the money once — one IN per receipt. Nothing here adds, rounds or converts money of its own: the table
 * below is the receipts door's conversion (`receiptsInStatementCurrency`) asked once per currency, and «باقي» is the
 * statement's own gap (`receiptGap`) read with its sign split in two.
 *
 * And two refusals every door that takes a wallet for a courier's cash now says alike:
 *   · a wallet of another country («بحطلي محافظ الأردن وأنا بسوريا») — WALLET_OTHER_COUNTRY;
 *   · an order WITH a courier at the old hand door — USE_HANDOVER: its money goes through the handover now.
 */

/** A wallet as the doors read it before they take money into it. */
export interface WalletCountryFacts {
  name: string;
  countryId?: string | null;
  country?: { name: string } | null;
}

export interface HandoverRefusal {
  code: string;
  error: string;
}

/**
 * IS THIS WALLET OF THE STATEMENT'S COUNTRY? Null when it is.
 *
 * The store's country is the one the session stands in (`requireContext` validates the store inside it, and always
 * returns its id). `wallets.countryId` is NOT NULL in the schema, so «an unplaced wallet with no country» cannot exist:
 * measured by discovery, not assumed. A wallet whose country was not read is therefore refused (undefined is not the
 * session's id) — the one pair that passes without two equal ids is «neither side read», which only a test double with
 * no geography produces; the old doors' tests are such doubles, and they keep passing unchanged.
 */
export function walletCountryRefusal(wallet: WalletCountryFacts, countryId: string | null | undefined): HandoverRefusal | null {
  if (wallet.countryId === countryId) return null;
  const where = wallet.country?.name ? `من ${wallet.country.name}` : 'بلا بلد معروف';
  return {
    code: 'WALLET_OTHER_COUNTRY',
    error: `المحفظة «${wallet.name}» ${where}، مش من بلد هالمتجر — اختر محفظة من نفس البلد.`,
  };
}

/** What the old hand door answers for an order that has a courier: its money is the handover's now. */
export const USE_HANDOVER_SENTENCE =
  'هالطلبات إلها مندوب أو شركة شحن — استلام مصاريها صار «تسليم مندوب» متل الكشف: افتح «استلمت منه» من المتابعة وسجّل الدفعات هناك.';

/**
 * The orders the old hand door may still take: those the handover CANNOT take. Null when every one is such.
 *
 * `takes` is the statement's own rule, asked by the caller (`handoverTakes` in `handover-takes.ts`, server-only): an order
 * with no courier, no reference, or another currency can never enter a manual statement, so it keeps this door — no order is
 * left with neither. A press that mixes the two kinds is refused WHOLE (nothing written), naming the orders the handover
 * takes: the person takes those through «تسليم مندوب» and presses again for the rest.
 */
export function courierOrdersRefusal<O extends { orderNumber: string }>(
  orders: O[],
  takes: (o: O) => boolean
): (HandoverRefusal & { orders: string[] }) | null {
  const handover = orders.filter(takes);
  if (handover.length === 0) return null;
  return { code: 'USE_HANDOVER', error: USE_HANDOVER_SENTENCE, orders: handover.map((o) => o.orderNumber) };
}

/** The reference a handover is gathered under unless the person types another: «تسليم {المندوب} {التاريخ}». */
export function handoverReference(courier: string, at: Date): string {
  const y = at.getFullYear();
  const m = String(at.getMonth() + 1).padStart(2, '0');
  const d = String(at.getDate()).padStart(2, '0');
  return `تسليم ${courier.trim() || 'المندوب'} ${y}-${m}-${d}`.slice(0, 80);
}

/** One row of the handover's table: what arrived in one currency, at which rates, and what it is worth in the orders' currency. */
export interface CurrencyRow {
  currencyCode: string;
  amount: number;
  /** The rates the receipts of this currency were typed at (statement currency → this one). Empty for the statement's own. */
  rates: number[];
  /** In the statement's currency; null when a receipt of this currency has no rate (the approval refuses it). */
  equivalent: number | null;
}

/**
 * THE PER-CURRENCY TABLE — the receipts door's conversion, asked once per currency.
 *
 * Rounded by each currency's own minor unit for the «amount» column (the caller says which), and by the statement's for the
 * equivalent, exactly as `receiptGap` rounds it. The table is a reading of the receipts; `receiptGap` stays the figure the
 * approval judges.
 */
export function currencyTable(
  receipts: ReceiptLine[],
  statementCurrency: string,
  minorUnit: number,
  minorUnitOf: (currencyCode: string) => number = () => minorUnit
): CurrencyRow[] {
  const groups = new Map<string, ReceiptLine[]>();
  for (const r of receipts) groups.set(r.currencyCode, [...(groups.get(r.currencyCode) ?? []), r]);
  // The orders' own currency first, then the others by name: the same order every time it is drawn.
  const codes = [...groups.keys()].sort((a, b) =>
    a === statementCurrency ? -1 : b === statementCurrency ? 1 : a.localeCompare(b)
  );
  return codes.map((code) => {
    const lines = groups.get(code)!;
    const { received, unconvertible } = receiptsInStatementCurrency(lines, statementCurrency, minorUnit);
    return {
      currencyCode: code,
      amount: roundMinor(lines.reduce((s, l) => s + l.amount, 0), minorUnitOf(code)),
      rates: code === statementCurrency ? [] : [...new Set(lines.map((l) => l.exchangeRate).filter((r): r is number => r != null))],
      equivalent: unconvertible > 0 ? null : received,
    };
  });
}

/** «استلمت / باقي / زيادة» — the statement's own gap, its sign said in words. */
export function handoverStanding(gap: { claimed: number; received: number; gap: number }): {
  claimed: number;
  received: number;
  remaining: number;
  over: number;
} {
  return {
    claimed: gap.claimed,
    received: gap.received,
    remaining: gap.gap < 0 ? -gap.gap : 0,
    over: gap.gap > 0 ? gap.gap : 0,
  };
}
