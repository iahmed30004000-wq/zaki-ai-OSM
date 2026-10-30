import type { Prisma } from '@prisma/client';
import type { StatusChoice } from './filters';

/**
 * WHO SEES WHICH ROWS ON THE FOLLOW-UP SCREEN — TWO LEVELS, AND THE SERVER IS WHERE THEY HOLD.
 *
 * The screen showed every parcel, the courier's money and the collect bar to anybody who held `ops.track`. Chasing
 * a parcel and counting the courier's cash are two different jobs, so the screen now has two levels:
 *
 *   SEEING   a delivered parcel (the collection rows), the «بانتظار التحصيل» chip and the courier's figures need
 *            «عرض التسويات» or «إدارة الصناديق النقدية». Without either, those rows are not read, not counted by the
 *            chips and the dropdowns, and the money fields are not in the answer. A return row (طلب إرجاع، مرتجع)
 *            needs «عرض المرتجعات»; «المرتجعات» (`ops.returns`) stays the key that RECEIVES the stock, nothing more.
 *   ACTING   the bar, the boxes and «استلمت منه» need «إدارة الصناديق النقدية» — the key the collect door asks.
 *
 * The browser is told which level it holds (`access` in the answer) so that it draws no option and no button the
 * door would refuse — but that is manners, not enforcement: everything here is decided by the door, and a request
 * for what the person may not see is a 403, not a quiet empty list.
 *
 * Pure and import-light on purpose: the screen reads the same constants the door filters with.
 */

/** The parcels whose money is the work: they arrived. */
export const COLLECTION_STATUSES = ['DELIVERED', 'PARTIALLY_DELIVERED'] as const;
/** The parcels coming back: the desk that receives the stock is `ops.returns`, seeing them is `ops.returns_view`. */
export const RETURN_STATUSES = ['RETURN_REQUESTED', 'RETURNED'] as const;

/**
 * What a row says about the COURIER'S money — what he owes, what he paid, what he keeps, and whether it is settled.
 *
 * `totalAmount` and `currency` are deliberately NOT here: they are the sum the customer is asked to pay, the same
 * figure anybody who may open the order reads, and the contact buttons put it into the message that goes to him.
 */
export const MONEY_FIELDS = [
  'collectionStatus',
  'settlementStatus',
  'collectedAmount',
  'expectedCollection',
  'deliveryFee',
  'priceIncludesDelivery',
] as const;
export type MoneyField = (typeof MONEY_FIELDS)[number];

export interface TrackingSight {
  /** May see the collection rows, the chip and the courier's figures. */
  money: boolean;
  /** May see the return rows. */
  returns: boolean;
  /** May act on the money: the bar, the boxes, «استلمت منه». */
  collect: boolean;
}

/** What a screen that was not told otherwise assumes — the server always tells. */
export const FULL_SIGHT: TrackingSight = { money: true, returns: true, collect: true };
/** What the screen draws until the first answer says what this person holds: nothing of the other level's. */
export const NO_SIGHT: TrackingSight = { money: false, returns: false, collect: false };

const among = (list: readonly string[], v: string | null | undefined): boolean => !!v && list.includes(v);

/**
 * THE KEY A REQUEST ASKS FOR THAT THE PERSON DOES NOT HOLD — or null when every part of it is theirs.
 *
 * A state or a chip that is only the other level's rows is refused, in the door's usual 403 sentence. The default
 * view, «every» and the chips that are not about money or returns are not refused: they are read through `sightWhere`,
 * which leaves the other level's rows out.
 */
export function unseenKey(applied: { status: StatusChoice; task: string | null }, sight: TrackingSight): 'settlement.view' | 'ops.returns_view' | null {
  if (!sight.money && (among(COLLECTION_STATUSES, applied.status) || applied.task === 'COLLECT')) return 'settlement.view';
  if (!sight.returns && (among(RETURN_STATUSES, applied.status) || applied.task === 'RETURNING')) return 'ops.returns_view';
  return null;
}

/** The rows this person may read, as one clause for the database's question — or null when they may read every row. */
export function sightWhere(sight: TrackingSight): Prisma.OrderWhereInput | null {
  const hidden = [...(sight.money ? [] : COLLECTION_STATUSES), ...(sight.returns ? [] : RETURN_STATUSES)];
  return hidden.length ? { shippingStatus: { notIn: hidden } } : null;
}

/** The row without the courier's money. */
export function withoutMoney<T extends object>(row: T): Omit<T, MoneyField> {
  const out = { ...row } as Record<string, unknown>;
  for (const f of MONEY_FIELDS) delete out[f];
  return out as Omit<T, MoneyField>;
}

/** The states the dropdown may offer: only those the door would answer. */
export function statesOffered<S extends string>(all: readonly S[], sight: TrackingSight): S[] {
  return all.filter((s) => (sight.money || !among(COLLECTION_STATUSES, s)) && (sight.returns || !among(RETURN_STATUSES, s)));
}
