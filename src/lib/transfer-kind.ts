/**
 * WHAT KIND OF TRANSFER THIS IS — decided by the two wallets, not chosen.
 *
 * The owner thinks of four separate things: moving money inside a store,
 * moving it between stores, moving it between countries, and changing it from
 * one currency to another inside one store of one country («صرفت ليرة
 * لدولار»). They ARE four different acts — the second crosses two sets of
 * books, the third crosses a currency as well, and the fourth is the third
 * without the border.
 *
 * But they are not four screens. Four screens means four forms to learn,
 * four places for a rule to drift, and a person who picked the wrong one
 * before they started. Instead there is one act — money leaves this wallet
 * and arrives in that one — and the system reads the two wallets and says
 * which of them you are about to do, before you commit.
 *
 * That also makes the rate impossible to misapply: it is asked for in
 * exactly one case, the only one where the currency changes — whichever of
 * the four it happens to be.
 *
 * The answer is recorded on the transfer when it happens. Deriving it again
 * later would let a wallet moved to another store rewrite what every past
 * transfer meant, and a transfer is a thing that happened.
 */

export type TransferKind = 'INTERNAL' | 'BETWEEN_STORES' | 'BETWEEN_COUNTRIES' | 'EXCHANGE';

export interface TransferSide {
  id: string;
  name: string;
  currencyCode: string;
  storeId: string | null;
  countryId: string;
  storeName?: string | null;
  countryName?: string | null;
}

export interface TransferReading {
  kind: TransferKind;
  /** The short name for it, as the screen says it. */
  label: string;
  /** The one sentence that tells you what you are about to do. */
  detail: string;
  /** True only when the currency changes — the one case needing a rate. */
  needsRate: boolean;
}

const LABELS: Record<TransferKind, string> = {
  INTERNAL: 'تحويل داخلي',
  BETWEEN_STORES: 'بين متجرين',
  BETWEEN_COUNTRIES: 'بين دولتين',
  EXCHANGE: 'صرف داخل البلد',
};

export function transferKind(from: TransferSide, to: TransferSide): TransferKind {
  if (from.countryId !== to.countryId) return 'BETWEEN_COUNTRIES';
  // Same country. A wallet with no store yet is nobody's, so pairing it with
  // one that has a store is still a move between two sets of books.
  if (from.storeId !== to.storeId) return 'BETWEEN_STORES';
  // One country AND one set of books, and the currency still changes: nothing
  // is moving anywhere, one currency is being turned into another («صرفت
  // ليرة لدولار»). It used to be refused as a setup error; it is a thing a
  // shop does every day.
  if (from.currencyCode !== to.currencyCode) return 'EXCHANGE';
  return 'INTERNAL';
}

export function readTransfer(from: TransferSide, to: TransferSide): TransferReading {
  const kind = transferKind(from, to);
  const needsRate = from.currencyCode !== to.currencyCode;

  const store = (w: TransferSide) => w.storeName ?? 'بلا متجر';
  const country = (w: TransferSide) => w.countryName ?? '';

  const detail =
    kind === 'INTERNAL'
      ? `داخل ${store(from)} — ${from.name} ← ${to.name}`
      : kind === 'BETWEEN_STORES'
        ? `من ${store(from)} إلى ${store(to)} — دفتران مختلفان`
        : kind === 'EXCHANGE'
          ? `صرف عملة داخل ${store(from)} — من ${from.currencyCode} إلى ${to.currencyCode}، بلد واحد ودفتر واحد`
          : `من ${country(from)} (${from.currencyCode}) إلى ${country(to)} (${to.currencyCode})`;

  return { kind, label: LABELS[kind], detail, needsRate };
}

export const TRANSFER_KIND_LABEL = LABELS;

/**
 * Reasons a pair of wallets cannot be transferred between at all.
 *
 * Returns the Arabic reason, or null when the pair is fine. These are the
 * cases where going ahead would produce a record nobody can later explain.
 *
 * Two wallets of one country holding two currencies is NOT one of them any
 * more. It was refused as «the data is wrong» — one country, one currency —
 * but a shop in Syria keeps dollars and liras side by side, and changing one
 * for the other is a transfer with a rate like any other. The rate is still
 * asked for, and still stored with the transfer (see `EXCHANGE`).
 */
export function transferRefusal(from: TransferSide, to: TransferSide): string | null {
  if (from.id === to.id) return 'لا يمكن التحويل إلى نفس المحفظة';

  return null;
}
