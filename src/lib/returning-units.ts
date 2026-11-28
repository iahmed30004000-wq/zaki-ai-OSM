/**
 * HOW MANY UNITS OF A PARCEL ARE COMING BACK — one rule, asked by the desk and by the shelf. Pure.
 *
 *   a line      what left (paid + gift) less what the customer kept at the door (`deliveredQty`).
 *   an add-on   it has no line of its own, so nobody at the door can refuse one: it is kept (and paid for) when anything
 *               was taken (`settlement.doorMoney`), and otherwise the whole of it comes back.
 *
 * The returns list, the receipt and the write-off count by it (`partial-delivery.ts`), and the stock moves by it
 * (`stock-consumption.ts`: `restoreOrderStock`, `takeOffUnreturned`). Two copies is how the desk expected units the shelf
 * never moved (27/11: add-ons stayed reserved for ever, and a partial return restored the product the customer kept).
 */

export interface LineBackFacts {
  quantity: number;
  freeQuantity: number;
  /** Units the customer kept. Null until the door settled the parcel. */
  deliveredQty?: number | null;
}

export const lineUnitsBack = (line: LineBackFacts): number =>
  Math.max(0, line.quantity + line.freeQuantity - (line.deliveredQty ?? 0));

/** Did the customer keep anything of this parcel? */
export const anythingKept = (items: readonly { deliveredQty?: number | null }[]): boolean =>
  items.some((i) => (i.deliveredQty ?? 0) > 0);

export const addOnUnitsBack = (items: readonly { deliveredQty?: number | null }[], addOn: { quantity: number }): number =>
  anythingKept(items) ? 0 : Math.max(0, addOn.quantity);
