import { emitAppEvent } from './apps/events';

/**
 * WHAT THE REPLIES SYSTEM IS TOLD ABOUT A PARCEL SWAP — after the commit, never able to undo it.
 *
 * Two of the six v1 events, and no more:
 *
 *   order.delivered   for the SALE (X′): the customer took delivery and paid. `replacesOrderNumber` is an
 *                     optional field inside `data` (the contract allows adding one; nothing is removed or retyped).
 *   order.returned    for the box's order (Y), when the whole box went: it ends as a return.
 *
 * NOT `order.created`. X′ is not a new order from the customer's side — it is the sale A already made, told on
 * the day it was delivered — and announcing a creation would hand the other system a second order for one sale.
 *
 * This is the one place the swap announces from; `events-sites.test.ts` lists it by name.
 */

export interface SwapAnnouncement {
  companyId: string;
  sale: { id: string; orderNumber: string; total: number; currency: string; replacesOrderNumber: string };
  /** The Y row as the swap read it — its total is read here, as the shipping door reads it. */
  box: {
    id: string;
    orderNumber: string;
    totalAmount: unknown;
    currency: string;
    trackingNumber: string | null;
    previousStatus: string;
    endedAs: 'RETURNED' | 'RETURN_REQUESTED';
  };
}

export async function announceSwap(a: SwapAnnouncement): Promise<void> {
  await emitAppEvent(a.companyId, 'order.delivered', {
    orderId: a.sale.id,
    orderNumber: a.sale.orderNumber,
    shippingStatus: 'DELIVERED',
    previousStatus: null,
    total: Number(a.sale.total),
    currency: a.sale.currency,
    trackingNumber: null,
    replacesOrderNumber: a.sale.replacesOrderNumber,
  });
  // A box with pieces still owed back is only RETURN_REQUESTED: the shipping door does not announce that
  // state either — `order.returned` is told when the whole of it has come back.
  if (a.box.endedAs === 'RETURNED') {
    await emitAppEvent(a.companyId, 'order.returned', {
      orderId: a.box.id,
      orderNumber: a.box.orderNumber,
      shippingStatus: 'RETURNED',
      previousStatus: a.box.previousStatus,
      total: Number(a.box.totalAmount),
      currency: a.box.currency,
      trackingNumber: a.box.trackingNumber,
    });
  }
}
