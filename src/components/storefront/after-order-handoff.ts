import type { PostOrderOfferView } from '@/components/landing/ThankYouOfferCard';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE BASKET'S ANSWER, CARRIED TO ITS THANK-YOU PAGE — IN THIS TAB, NEVER IN A LINK.
 *
 * The basket's door (`/api/public/stores/[store]/orders`) answers exactly
 * like the landing page's: the order number, the signed add-on token, the
 * one offer after the order and its window. The landing form keeps that
 * answer in memory because its thank-you screen is the same component. The
 * basket's thank-you screen is another PAGE — `router.push` to
 * `/s/<slug>/thanks?o=<number>` — so the answer was thrown away on the way
 * and «العرض بعد الطلب» never reached a basket's customer (RV250).
 *
 * WHY NOT THE LINK. The token is the customer's own capability for their own
 * order, for thirty minutes. A link is the one place it must not be: it
 * stays in the browser's history, the server's access log and the next
 * page's referrer, and it is the thing a customer pastes to a friend. The
 * page that receives the link prints the reference and nothing else.
 *
 * WHY SESSION STORAGE. It belongs to this tab and dies with it — the same
 * life the landing form's memory has, a little longer: a refresh keeps it,
 * another tab opened on its own never sees it. One key per order, so two
 * orders in one tab never read each other's.
 *
 * WHAT IS KEPT is what the card needs and nothing more: the reference, the
 * token, the server's offer (its id, name, pieces and two prices), the
 * window, the currency and its decimals, and when the answer arrived by THIS
 * tab's clock — the window is measured on the same clock it was started on.
 * No name, no phone, no address: the customer typed those into a form and
 * they stay in the request that carried them.
 *
 * THE CURRENCY TRAVELS WITH ITS DECIMALS, because «a code without its
 * decimals is half an answer» (`money-decimals.test.ts`). The thank-you page
 * prints every figure through `moneyText`, the one door money is printed
 * by, and that door needs the shop's minor unit — the very one the checkout
 * printed «المطلوب عند الاستلام» with a moment earlier, already in its hands.
 * Without it the first version printed the new total by hand: «24 JOD» under
 * a checkout that had just said «14.000 JOD». It is a number about the
 * currency, not about anybody, and it saves the thank-you page a question to
 * the database about a shop it has already been told.
 *
 * EVERY TOUCH IS IN A `try`. Private mode, storage switched off, a quota —
 * the order is placed either way, and the thank-you page is then exactly the
 * page it always was.
 * ═══════════════════════════════════════════════════════════════════════
 */

const PREFIX = 'zaki:after-order:';

/** One key per order. */
export function afterOrderKey(orderNumber: string): string {
  return `${PREFIX}${orderNumber}`;
}

export interface AfterOrderEntry {
  orderNumber: string;
  addonToken: string;
  offer: PostOrderOfferView;
  windowMinutes: number;
  currency: string;
  /** The currency's decimals: the shop's own, the ones its checkout printed the total with. */
  minorUnit: number;
  /** When the door answered, by this tab's clock. */
  at: number;
}

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
/** A currency's decimals as a country may hold them — a whole number from 0 to 4 (`geo-schemas`). */
const isMinorUnit = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 4;

/** The offer as the card draws it, or null when the shape is not that. */
function offerFrom(raw: unknown): PostOrderOfferView | null {
  const o = (raw ?? null) as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return null;
  if (!isText(o.id) || typeof o.name !== 'string') return null;
  if (!isNumber(o.quantity) || !isNumber(o.freeQuantity) || !isNumber(o.price)) return null;
  if (o.listPrice !== null && !isNumber(o.listPrice)) return null;
  return {
    id: o.id,
    name: o.name,
    quantity: o.quantity,
    freeQuantity: o.freeQuantity,
    price: o.price,
    listPrice: o.listPrice as number | null,
  };
}

/**
 * THE ENTRY THE DOOR'S ANSWER MAKES — or null, and then nothing is kept.
 *
 * Null when there is nothing for the thank-you page to draw: no offer (the
 * seller set none on the head product — a real answer), no token (the card
 * could not add without it), no window, no currency, no decimals to print it
 * in. Keeping a token there is no use for is keeping it for nothing.
 *
 * `minorUnit` is the checkout's own, not the door's: the answer names the
 * currency, the shop's page knows its decimals.
 */
export function afterOrderFrom(answer: unknown, minorUnit: number, now: number): AfterOrderEntry | null {
  const a = (answer ?? null) as Record<string, unknown> | null;
  if (!a || typeof a !== 'object') return null;
  const offer = offerFrom(a.postOrderOffer);
  if (!offer || !isText(a.orderNumber) || !isText(a.addonToken) || !isText(a.currency)) return null;
  if (!isNumber(a.postOrderWindowMinutes) || a.postOrderWindowMinutes <= 0) return null;
  if (!isMinorUnit(minorUnit)) return null;
  return {
    orderNumber: a.orderNumber,
    addonToken: a.addonToken,
    offer,
    windowMinutes: a.postOrderWindowMinutes,
    currency: a.currency,
    minorUnit,
    at: now,
  };
}

/** Kept for the thank-you page, before the checkout leaves for it. */
export function keepAfterOrder(answer: unknown, minorUnit: number, now: number = Date.now()): void {
  const entry = afterOrderFrom(answer, minorUnit, now);
  if (!entry) return;
  try {
    sessionStorage.setItem(afterOrderKey(entry.orderNumber), JSON.stringify(entry));
  } catch {
    /* no storage — the thank-you page is the page it always was */
  }
}

/** Gone once the card is answered, or its window has passed. */
export function forgetAfterOrder(orderNumber: string): void {
  try {
    sessionStorage.removeItem(afterOrderKey(orderNumber));
  } catch {
    /* nothing to forget where nothing could be kept */
  }
}

/**
 * THE ENTRY FOR THIS PAGE'S REFERENCE, AND ONLY FOR IT.
 *
 * Read under the reference's own key, and then the entry must name that same
 * order: anything else — nothing kept, a corrupt value (decimals no currency
 * has among them), another order's answer, storage that throws — reads as
 * nothing, and the page draws no card.
 *
 * A window that has passed is forgotten and reads as nothing too: the server
 * would refuse the offer, and a card the server will refuse is a promise
 * nobody keeps. A clock that went backwards is inside the window, as
 * `postOrderGate` has it on the server.
 */
export function readAfterOrder(reference: string, now: number = Date.now()): AfterOrderEntry | null {
  let stored: string | null = null;
  try {
    stored = sessionStorage.getItem(afterOrderKey(reference));
  } catch {
    return null;
  }
  if (!stored) return null;
  let raw: Record<string, unknown> | null = null;
  try {
    raw = JSON.parse(stored) as Record<string, unknown> | null;
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const offer = offerFrom(raw.offer);
  if (!offer || raw.orderNumber !== reference || !isText(raw.addonToken) || !isText(raw.currency)) return null;
  if (!isNumber(raw.windowMinutes) || raw.windowMinutes <= 0 || !isNumber(raw.at)) return null;
  if (!isMinorUnit(raw.minorUnit)) return null;
  if (now - raw.at > raw.windowMinutes * 60_000) {
    forgetAfterOrder(reference);
    return null;
  }
  return {
    orderNumber: reference,
    addonToken: raw.addonToken,
    offer,
    windowMinutes: raw.windowMinutes,
    currency: raw.currency,
    minorUnit: raw.minorUnit,
    at: raw.at,
  };
}
