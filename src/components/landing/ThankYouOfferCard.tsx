'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useTracking } from '@/components/tracking/GlobalTrackingProvider';

/**
 * «العرض بعد الطلب» — ONE CARD, FOR EVERY DOOR AN ORDER COMES IN BY.
 *
 * The landing page, the product page in the shop and the shop's basket all end at a thank-you screen, and the
 * offer on it is the same offer: the seller's, at the server's price, added to the SAME order through the SAME
 * door (`/api/public/orders/[orderNumber]/post-order-offer`) with the signed token the order's answer carried.
 * It lived inside `OrderForm`, so the basket — which has no `OrderForm` — threw the answer away and its customer
 * never saw the offer at all. Out here it is drawn once and reached from both: `OrderForm` and the basket's
 * thank-you page (`storefront/CartThankYouOffer`). A second copy would be a second set of rules about the same
 * money, and this product's history is a list of those.
 *
 * Two halves, so each door keeps what is its own:
 *
 *   `usePostOrderOffer` — the answer: idle → adding → added, or `gone` when the server shuts the door, and
 *   «لا شكراً». The request, and the one Purchase for the ADDED amount. Nothing about where the new total is
 *   printed: the door is told (`onTotal`) and decides — `OrderForm` prints it in its header, the basket under
 *   the card.
 *
 *   `ThankYouOfferCard` — the card as it always was, in every look the form block offers (`data-look`).
 *
 * NOTHING HERE IS COMPUTED. `price` is what the customer will be charged and `listPrice` the bundle before its
 * own reduction, both from the server, printed by the door's own `fmt`.
 */

/**
 * THE ONE OFFER SHOWN AFTER THE ORDER, exactly as the server sends it.
 *
 * It arrives in the order-creation RESPONSE rather than as a prop, and that
 * is the point: the offer and its price are read from the product's own
 * offers at the moment the order exists, by the same `toOfferView` that
 * priced the bundles on this page. Nothing here is computed — `price` is
 * what the customer will be charged and `listPrice` is the bundle before its
 * own reduction, so «15 بدل 25» is two numbers printed, never a subtraction
 * performed in a browser.
 */
export interface PostOrderOfferView {
  id: string;
  name: string;
  quantity: number;
  freeQuantity: number;
  price: number;
  listPrice: number | null;
}

/** idle → adding → added, or `gone` when the server says the door is shut. */
export type PostOrderState = 'idle' | 'adding' | 'added' | 'gone';

export interface PostOrderAnswer {
  postOrderState: PostOrderState;
  /** «لا شكراً» was pressed. */
  postOrderRefused: boolean;
  /** The server's own sentence when it refuses. Never a code read in here. */
  postOrderMsg: string | null;
  addPostOrderOffer: () => Promise<void>;
  refusePostOrderOffer: () => void;
  /** Back to idle, for a new order on the same screen. */
  resetPostOrderOffer: () => void;
}

export function usePostOrderOffer({
  orderNumber,
  addonToken,
  offer,
  currency,
  onTotal,
}: {
  orderNumber: string | null;
  addonToken: string | null;
  offer: PostOrderOfferView | null;
  /** The page's currency, for the Purchase event when the server's answer names none. */
  currency: string;
  /** The server's total after the add — the only number a door may print as the new total. */
  onTotal: (total: number) => void;
}): PostOrderAnswer {
  const { trackEvent } = useTracking();
  /*
   * `windowMinutes` is STATED and never enforced here. Every gate is on the server (`postOrderGate`): still NEW,
   * nobody has called yet, inside the window, once. A countdown in a browser would be a second clock, and the
   * lesson this product already learned about countdowns is that a clock with a source of its own reaches zero
   * while the thing carries on.
   */
  const [postOrderState, setPostOrderState] = useState<PostOrderState>('idle');
  /**
   * «لا شكرًا» for THIS offer, kept apart from the page's own recommendation list.
   *
   * Two different things are being refused — the seller's after-order bundle
   * and the page's recommendation list — and one flag for both would mean
   * saying no to one silently withdrew the other. A customer who declines
   * the bundle has not declined anything else.
   */
  const [postOrderRefused, setPostOrderRefused] = useState(false);
  const [postOrderMsg, setPostOrderMsg] = useState<string | null>(null);

  /**
   * A WAY TO SAY NO, AND TO BE BELIEVED.
   *
   * It hides the offer and touches nothing else: the order was placed before
   * this card appeared, so refusing has nothing to undo. The server agrees —
   * there is no «decline» endpoint, because there is no state a refusal would
   * have to write.
   */
  function refusePostOrderOffer() {
    setPostOrderRefused(true);
  }

  function resetPostOrderOffer() {
    setPostOrderState('idle');
    setPostOrderRefused(false);
    setPostOrderMsg(null);
  }

  /**
   * «آه، زيدها لطلبي» — one press, one request, and no figure on the wire.
   *
   * The body is the signed add-on token and the offer's id. The server
   * re-reads the offer through `postOrderOfferWhere`, prices it with the
   * same function that priced this page, checks the four gates and adds ONE
   * add-on to the SAME order. What comes back is the new total, which is the
   * only number this screen is allowed to print as one.
   *
   * A refusal is not an error here — it is the rule answering. The server
   * sends the Arabic sentence and a `reason`, and the one decision this
   * screen makes with it is whether the offer is still worth showing:
   * `ALREADY_ADDED`, `NOT_NEW`, `WINDOW_PASSED`, `OFFER_GONE` and
   * `NOT_IN_ORDER` all mean «stop offering it», so the card closes and the
   * sentence stays. Nothing about the order is undone, because nothing about
   * the order was done.
   *
   * `credentials: 'omit'`: this is the seller's page, read by an anonymous
   * shopper who has no session and must never be given one — the same reason
   * every other call on a public page leaves the cookies behind.
   */
  async function addPostOrderOffer() {
    if (!offer || !addonToken || !orderNumber) return;
    setPostOrderState('adding');
    setPostOrderMsg(null);
    try {
      const res = await fetch(
        `/api/public/orders/${encodeURIComponent(orderNumber)}/post-order-offer`,
        {
          method: 'POST',
          credentials: 'omit',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: addonToken, offerId: offer.id }),
        }
      );
      const json = await res.json().catch(() => null);
      if (res.ok) {
        setPostOrderState('added');
        // The server's total, never a sum worked out in here.
        if (typeof json?.newTotal === 'number') onTotal(json.newTotal);
        /*
         * The added amount, not the new total. Purchase already fired with
         * the opening figure and the ad platforms SUM the events they
         * receive, so re-sending the whole total would count the first
         * order twice — the same rule the recommendation add-on follows,
         * and for the same measured reason.
         */
        const added = json?.addOn;
        if (added && typeof added.total === 'number') {
          try {
            trackEvent('Purchase', {
              orderId: `${orderNumber}:${offer.id}`,
              value: added.total,
              currency: typeof json.currency === 'string' ? json.currency : currency,
              contentName: typeof added.productName === 'string' ? added.productName : undefined,
            });
          } catch { /* tracking is non-fatal */ }
        }
      } else {
        setPostOrderState('gone');
        setPostOrderMsg(json?.error || 'تعذر إضافة العرض');
      }
    } catch {
      // A connection that failed is not the rule saying no: the offer stays
      // on the screen so the customer can try again.
      setPostOrderState('idle');
      setPostOrderMsg('تعذر الاتصال، حاول مرة أخرى');
    }
  }

  return {
    postOrderState,
    postOrderRefused,
    postOrderMsg,
    addPostOrderOffer,
    refusePostOrderOffer,
    resetPostOrderOffer,
  };
}

/**
 * ═══════════════════════════════════════════════════════════
 * «وصلنا طلبك!» → «زيد علبة كمان؟ 15 بدل 25»
 *
 * ONE offer, the one the seller flagged on this product, at
 * the price the server computed. Every number drawn below
 * came off the response: `price` is what the customer will be
 * charged and `listPrice` is the bundle before its own
 * reduction, so «بدل 25» is a figure printed and never a
 * subtraction done in a browser.
 *
 * HONEST COPY, which the brief asks for by name. There is no
 * invented scarcity here: the only urgency stated is the real
 * window the server will enforce, in the minutes the
 * company's own setting holds, and it is stated only when the
 * server sent one. No «آخر قطعة», no fabricated countdown.
 *
 * The door decides WHETHER to draw it (the offer, «لا شكراً», the
 * window); once drawn, this is the whole card.
 * ═══════════════════════════════════════════════════════════
 */
export function ThankYouOfferCard({
  postOrder,
  answer,
  look,
  currency,
  fmt,
}: {
  postOrder: { offer: PostOrderOfferView; windowMinutes: number };
  answer: PostOrderAnswer;
  /** The form block's «بعد الطلب» shape, and whether its countdown already states the window. */
  look: { upsell: 'card' | 'banner' | 'compact'; banner: 'none' | 'congrats' | 'countdown' };
  currency: string;
  /** The door's own way of printing a figure — the card adds no formatter of its own. */
  fmt: (n: number) => string;
}) {
  const { postOrderState, postOrderMsg, addPostOrderOffer, refusePostOrderOffer } = answer;
  return (
    <div className="lp-upsell mt-6 rounded-xl border border-[var(--store-accent,#b8256e)] bg-white p-4 text-center" data-look={look.upsell}>
      <p className="lp-upsell-title text-sm font-bold text-[#121926]">
        {postOrderState === 'added' ? 'تمت الإضافة إلى طلبك ✅' : `${postOrder.offer.name} — زيدها لطلبك؟`}
      </p>
      <p className="lp-upsell-price mt-2 text-lg font-bold text-[var(--store-accent,#b8256e)]" dir="ltr">
        {fmt(postOrder.offer.price)} {currency}
        {postOrder.offer.listPrice !== null && (
          <span className="ms-2 text-sm font-semibold text-[#9aa4b2] line-through">
            {fmt(postOrder.offer.listPrice)} {currency}
          </span>
        )}
      </p>
      <p className="lp-upsell-note mt-1 text-xs text-[#697586]">
        {postOrder.offer.quantity} قطعة
        {postOrder.offer.freeQuantity > 0 && ` + ${postOrder.offer.freeQuantity} مجاناً`}
        {' — تدفعها عند الاستلام مع طلبك، بدون توصيل إضافي.'}
      </p>

      {postOrderState === 'added' ? (
        <p className="mt-3 text-xs font-semibold text-[#00c853]">
          صار على نفس الطلب — ما في طلب ثاني ولا توصيل ثاني.
        </p>
      ) : postOrderState === 'gone' ? null : (
        <div className="lp-upsell-actions mt-4 flex flex-col gap-2">
          <button
            type="button"
            onClick={addPostOrderOffer}
            disabled={postOrderState === 'adding'}
            className="lp-upsell-yes inline-flex items-center justify-center gap-2 rounded-xl bg-[var(--store-accent,#b8256e)] px-5 py-3 text-sm font-bold text-white transition hover:bg-[var(--store-accent-dark,#a01f5f)] disabled:opacity-60 active:scale-95"
          >
            {postOrderState === 'adding' ? <Loader2 className="h-4 w-4 animate-spin" /> : 'آه، زيدها لطلبي'}
          </button>
          {/* «لا شكراً» — see `refusePostOrderOffer`: it hides the offer and writes nothing. */}
          <button
            type="button"
            onClick={refusePostOrderOffer}
            className="text-xs font-semibold text-[#697586] underline hover:text-[#364152]"
          >
            لا شكراً
          </button>
        </div>
      )}

      {postOrderMsg && (
        <p className="mt-3 text-xs text-rose-600">{postOrderMsg}</p>
      )}

      {postOrderState === 'idle' && postOrder.windowMinutes > 0 && look.banner !== 'countdown' && (
        // The real rule, in the server's own number. It is the
        // window `postOrderGate` will measure, not a decoration.
        <p className="mt-3 text-[11px] text-[#9aa4b2]">
          تقدر تزيدها خلال {postOrder.windowMinutes} دقيقة من وقت الطلب، وقبل ما نتواصل معك.
        </p>
      )}
    </div>
  );
}
