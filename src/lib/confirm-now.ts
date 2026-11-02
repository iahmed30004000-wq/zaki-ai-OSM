import { apiJson } from './api-client';
import { TWIN_CONFIRMED_CODE, TWIN_FORM_NEXT, twinFormReason, twinsFromRefusal } from './twin-refusal';

/**
 * «الزبون على الخط — أكّده الآن» — CONFIRM THE ORDER THAT WAS JUST MADE.
 *
 * It used to be a second button on the shipping-batches screen that opened a second copy of
 * the new-order form and then confirmed the result. It is an option of the one form now
 * (`CreateOrderModal`), and this is its second half.
 *
 * NOT A SECOND CONFIRMATION PATH. It goes through the ordinary endpoint
 * (`POST /api/orders/<id>/confirmation`), the one that reserves the stock, stamps who
 * confirmed and when, and writes the status log — and that asks `orders.confirm` of the
 * caller on the server. Re-implementing any of that here would be a copy that drifts, and
 * the first thing to drift would be the reservation. The form only OFFERS the option to
 * somebody who holds that permission; the door decides regardless.
 *
 * The order exists either way. A refusal is returned, not thrown, so the caller can say
 * «created, but not confirmed» instead of leaving anyone to wonder whether it was made.
 *
 * ── AND WHEN THE REASON IS A TWIN ──
 *
 * The door refuses a yes for a customer who already has a confirmed order for the same product
 * (`TWIN_CONFIRMED`). That is the one refusal this form must not read as «try again»: pressing
 * confirm a second time would be the very mistake the door is there to stop. So it is returned
 * with its own code, its reason names the other order, and `then` says what to do instead —
 * open the order and decide, with the question the confirmation window asks. This form NEVER
 * sends `acknowledgeTwin`: a person who typed an order in the middle of a call has not been
 * asked, and the answer is not hers to give by a tick box.
 */
export type ConfirmNowResult =
  | { ok: true }
  | {
      ok: false;
      reason: string;
      /** Set when the reason is not an accident but the door's question; the form shows `then` in place of its usual advice. */
      code?: typeof TWIN_CONFIRMED_CODE;
      /** What to do about it, in a sentence that replaces «أكّده من شاشة الطلبات». */
      then?: string;
    };

export async function confirmOrderNow(orderId: string): Promise<ConfirmNowResult> {
  try {
    // The version the screen would have loaded: confirmation is an optimistic-concurrency write.
    const fresh = await apiJson<{ order: { version: number } }>(`/api/orders/${orderId}`);
    await apiJson(`/api/orders/${orderId}/confirmation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'confirm', expectedVersion: fresh.order.version }),
    });
    return { ok: true };
  } catch (e) {
    const twins = twinsFromRefusal((e as { data?: unknown } | null)?.data);
    if (twins) return { ok: false, reason: twinFormReason(twins), code: TWIN_CONFIRMED_CODE, then: TWIN_FORM_NEXT };
    return { ok: false, reason: e instanceof Error ? e.message : 'تعذّر التأكيد' };
  }
}
