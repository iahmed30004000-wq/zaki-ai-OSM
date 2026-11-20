/**
 * WHAT KIND OF STOCK TRANSFER THIS IS — read from the two ends, not chosen (the mirror of `transfer-kind.ts`).
 *
 * A wallet transfer is one act whose kind the system reads from the two wallets and says before the press. Goods are
 * the same: one act — units leave this warehouse and arrive in that one — and three kinds, decided by the ends:
 *
 *   INTERNAL           the two warehouses hold the goods of ONE store (one set of books): the batch is split, no cost
 *                      moves, «دخل» and «خرج» stay still (`batch-split.ts`);
 *   BETWEEN_STORES     two stores of one country: two products, two books — a draw-down here and a receipt there;
 *   BETWEEN_COUNTRIES  two countries: the same, plus a currency and a border.
 *
 * INTERNAL was built first (W3a). 20/11 (W7b): the other two are built too — the owner's explicit word of 20/11 changed the contract line «Cross-border transfer is refused by rule» (invariants.md).
 * Both need the product's twin in the other store (`product-pairs`); BETWEEN_COUNTRIES also needs the key
 * `inventory.transfer_abroad` and the owner's approval press on the document before anything moves
 * (`needsOwnerApproval`). Neither has a rate: the goods keep their cost (`stock-transfer-cost.ts`).
 *
 * The answer is stored on the transfer when it is sent: deriving it again later would let a warehouse that changed
 * hands rewrite what a past transfer meant.
 *
 * Pure: no database, no session, no money.
 */

export type StockTransferKind = 'INTERNAL' | 'BETWEEN_STORES' | 'BETWEEN_COUNTRIES';

export interface StockTransferEnd {
  warehouseId: string;
  warehouseName?: string | null;
  /** Whose goods leave or arrive — the store the units belong to at that end. */
  storeId: string;
  storeName?: string | null;
  /** The warehouse's country. */
  countryId: string;
  countryName?: string | null;
}

export interface StockTransferReading {
  kind: StockTransferKind;
  /** The short name, as the screen says it. */
  label: string;
  /** The one sentence that says what is about to happen, BEFORE the press. */
  detail: string;
  /** Built in this release? Every kind since W7b (20/11). */
  built: boolean;
}

const LABELS: Record<StockTransferKind, string> = {
  INTERNAL: 'نقل داخل المتجر',
  BETWEEN_STORES: 'بين متجرين',
  BETWEEN_COUNTRIES: 'بين بلدين',
};

export const STOCK_TRANSFER_KIND_LABEL = LABELS;

/** The kinds this release builds. */
export const BUILT_KINDS: readonly StockTransferKind[] = ['INTERNAL', 'BETWEEN_STORES', 'BETWEEN_COUNTRIES'];

/**
 * 20/11 (W7b): the sentence the screen «نقل البضاعة» says for a kind its form cannot send YET. The doors send every
 * kind; the form has no field for the destination store and the twin until W7c, so it says so instead of sending a
 * transfer the door would refuse.
 */
export const NOT_BUILT_AR = 'النقل لمتجر تاني أو لبلد تاني بدّو اختيار المتجر والمنتج التوأم، وهالنموذج لسا ما فيه هالخانات. هلّق من هون بس النقل بين مخزنين لنفس المتجر.';

/** 20/11 (W7b): the key a transfer to another country asks, on top of the send key. */
export const ABROAD_KEY = 'inventory.transfer_abroad';

/** 20/11 (W7b): a transfer to another country waits for the owner's press before anything moves. */
export function needsOwnerApproval(kind: StockTransferKind): boolean {
  return kind === 'BETWEEN_COUNTRIES';
}

/** 20/11 (W7b): a transfer between two stores (of one country or two) — two products, two books. */
export function isAcross(kind: string): boolean {
  return kind === 'BETWEEN_STORES' || kind === 'BETWEEN_COUNTRIES';
}

export function stockTransferKind(from: StockTransferEnd, to: StockTransferEnd): StockTransferKind {
  if (from.countryId !== to.countryId) return 'BETWEEN_COUNTRIES';
  if (from.storeId !== to.storeId) return 'BETWEEN_STORES';
  return 'INTERNAL';
}

export function readStockTransfer(from: StockTransferEnd, to: StockTransferEnd): StockTransferReading {
  const kind = stockTransferKind(from, to);
  const place = (e: StockTransferEnd) => e.warehouseName ?? 'مخزن';
  const store = (e: StockTransferEnd) => e.storeName ?? 'المتجر';
  const country = (e: StockTransferEnd) => e.countryName ?? 'بلد';
  const detail =
    kind === 'INTERNAL'
      ? `داخل ${store(from)} — من ${place(from)} إلى ${place(to)}. نفس البضاعة ونفس الكلفة، بس المكان بيتغيّر.`
      : kind === 'BETWEEN_STORES'
        ? `من ${store(from)} إلى ${store(to)} — دفترين مختلفين: بتطلع من المنتج هون وبتدخل على توأمه هناك بنفس كلفتها.`
        : `من ${country(from)} إلى ${country(to)} — بلدين مختلفين: بتطلع بكلفتها وبتدخل بكلفتها مع مصاريف الشحن والجمرك، وبدها اعتماد المالك قبل ما تطلع.`;
  return { kind, label: LABELS[kind], detail, built: BUILT_KINDS.includes(kind) };
}

/**
 * Is a transfer still OPEN — units on the road, or a shortfall waiting for its approval? The stop door's question
 * (`warehouses.warehouseStopBlockers`): an open transfer from or to a warehouse keeps it running.
 */
export const OPEN_TRANSFER_WHERE = {
  // 20/11 (W7b): a transfer to another country waiting for the owner's press holds its units too.
  OR: [{ status: 'AWAITING_APPROVAL' }, { status: 'SENT' }, { status: 'RECEIVED_WITH_DIFFERENCE', differenceApprovedAt: null }],
};

/** Reasons a pair of ends cannot be a transfer at all (Arabic), or null. */
export function stockTransferRefusal(from: StockTransferEnd, to: StockTransferEnd): string | null {
  if (from.warehouseId === to.warehouseId) return 'المخزن اللي بتنقل منه هو نفسه اللي بتنقل عليه. اختار مخزن تاني.';
  return null;
}
