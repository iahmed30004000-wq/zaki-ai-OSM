/**
 * WHAT A SELLER IS ALLOWED TO DECIDE.
 *
 * Three moments, three ways of valuing them, and a name of their own
 * choosing. Everything else about a conversion is fixed by the code,
 * because everything else is a way to get it wrong.
 */

/**
 * The moments. These are the EXISTING order events this system already
 * announces — not a second vocabulary invented for this feature. An order
 * that reaches one of these has already told the rest of the system so;
 * this only adds one more listener.
 */
export const CONVERSION_TRIGGERS = ['order.created', 'order.confirmed', 'order.delivered'] as const;
export type ConversionTrigger = (typeof CONVERSION_TRIGGERS)[number];

/**
 * WHICH ORDERS A SERVER CONVERSION IS ABOUT — «بس طلبات صفحات الهبوط والمتجر، وطلبات الرسائل ما تنبعت».
 *
 * The pixel is a website pixel: Meta reads every event on it as a sale that came through the site. An order
 * a moderator typed in from a chat, a call or a sheet did not, and sending it would credit the site's
 * campaigns with sales the messages made. So only an order that came through a selling page is sent.
 *
 * The two spellings are what the public doors write into `Order.source` — the landing page's
 * (`LANDING_PAGE_SOURCE` in `landing-pages.ts`) and the storefront's (written literally by its two order
 * doors). Copied rather than imported to keep this file free of server code; a test pins both to the doors.
 */
export const LANDING_PAGE_ORDER_SOURCE = 'Landing Page';
export const STOREFRONT_ORDER_SOURCE = 'Store';

/** The kind of selling page an order came through, or null for one that came through no page at all. */
export function salesPageOf(order: { source: string | null; landingPageId: string | null }): 'LANDING_PAGES' | 'PUBLIC' | null {
  if (order.landingPageId || order.source === LANDING_PAGE_ORDER_SOURCE) return 'LANDING_PAGES';
  if (order.source === STOREFRONT_ORDER_SOURCE) return 'PUBLIC';
  return null;
}

export const TRIGGER_AR: Record<ConversionTrigger, string> = {
  'order.created': 'عبّأ النموذج وأرسله',
  'order.confirmed': 'تأكّد الطلب',
  'order.delivered': 'استلم ودفع',
};

export const TRIGGER_HINT_AR: Record<ConversionTrigger, string> = {
  'order.created':
    'أسرع إشارة وأكثرها عدداً — لكنّها تعبئة نموذج، لا بيعة. جزء منها ما بيدفع.',
  'order.confirmed':
    'بعد ما يردّ الزبون ويوافق. أدقّ من النموذج، وما زال ممكناً أن يرجع الطلب.',
  'order.delivered':
    'المال في اليد. أصدق إشارة ممكنة، وتصل بعد يوم إلى أيام — وهذا داخل نافذة إسناد ميتا (7 أيام نقرة).',
};

/**
 * Which number Meta is told the conversion was worth.
 *
 * At delivery, the collected amount is the truth and the order total is a
 * wish: a customer who took three of four items paid for three. Sending the
 * total there would teach Meta that every delivery is worth full price,
 * which is the same lie the delivery-rate multiplier was invented to patch.
 */
export const VALUE_SOURCES = ['ORDER_TOTAL', 'COLLECTED_AMOUNT', 'NONE'] as const;
export type ValueSource = (typeof VALUE_SOURCES)[number];

export const VALUE_SOURCE_AR: Record<ValueSource, string> = {
  ORDER_TOTAL: 'قيمة الطلب',
  COLLECTED_AMOUNT: 'المبلغ المقبوض فعلاً',
  NONE: 'بلا قيمة (حدث فقط)',
};

export function isTrigger(v: unknown): v is ConversionTrigger {
  return typeof v === 'string' && (CONVERSION_TRIGGERS as readonly string[]).includes(v);
}

export function isValueSource(v: unknown): v is ValueSource {
  return typeof v === 'string' && (VALUE_SOURCES as readonly string[]).includes(v);
}

/**
 * The four events the BROWSER pixel already sends.
 *
 * Not forbidden here — a seller who knows what they are doing may want to
 * send `Purchase` from the server too. But naming one of these is almost
 * always an accident, and it produces the one failure nobody notices: Meta
 * counts the form submission AND the delivery as two purchases, the reported
 * return on ad spend doubles, and the seller scales a campaign on a number
 * that was never real. So it is warned about, loudly, at the point of
 * choosing.
 */
export const BROWSER_PIXEL_EVENTS = ['PageView', 'ViewContent', 'InitiateCheckout', 'Purchase'] as const;

/** What a pixel's own browser reports an order as: its `orderEvent` — Purchase unless the seller set it to Lead. */
export type PixelOrderEvent = 'Purchase' | 'Lead';

/** A pixel row's order event as the type: anything but «Lead» is the default, Purchase. */
export function orderEventOf(pixel: { orderEvent?: string | null }): PixelOrderEvent {
  return pixel.orderEvent === 'Lead' ? 'Lead' : 'Purchase';
}

export function collidesWithBrowserPixel(eventName: string, trigger?: string, orderEvent: PixelOrderEvent = 'Purchase'): boolean {
  // The order event at confirmation REPLACES the browser's: the page stands down for that pixel, so Meta counts one.
  if (replacesBrowserPurchase(eventName, trigger, orderEvent)) return false;
  /*
   * THE BROWSER'S EVENTS ARE THE PIXEL'S OWN. A pixel set to report orders as leads sends `Lead` at the submit and no
   * `Purchase` at all: a server conversion named «Lead» doubles it (and went unwarned), and one named «Purchase»
   * doubles nothing.
   */
  const browser = [...BROWSER_PIXEL_EVENTS.filter((e) => e !== 'Purchase'), orderEvent] as string[];
  return browser.includes(eventName.trim());
}

/**
 * «الشراء بيتحقق لما يتم تأكيد الطلب»: a server conversion named `Purchase` on the confirmation is the one
 * combination that takes the browser's Purchase place instead of doubling it.
 */
export function replacesBrowserPurchase(eventName: string, trigger?: string, orderEvent: PixelOrderEvent = 'Purchase'): boolean {
  return eventName.trim() === orderEvent && trigger === 'order.confirmed';
}

/**
 * An event name Meta will accept.
 *
 * Letters, digits and underscores only. Meta is lenient here and that is
 * the problem: a name with a space or an Arabic letter is accepted by the
 * API, appears nowhere useful in Events Manager, and cannot be selected
 * when building a custom conversion — a failure that looks like success
 * until somebody tries to use it a week later.
 */
export function validateEventName(raw: string): string | null {
  const v = String(raw ?? '').trim();
  return /^[A-Za-z][A-Za-z0-9_]{2,39}$/.test(v) ? v : null;
}

/** Names worth offering, so most sellers never have to invent one. */
export const SUGGESTED_EVENT_NAMES: Record<ConversionTrigger, string> = {
  'order.created': 'LeadSubmitted',
  'order.confirmed': 'OrderConfirmed',
  'order.delivered': 'OrderDelivered',
};

/**
 * Meta rejects an event whose time is more than seven days old.
 *
 * It matters here more than anywhere else: a conversion at delivery carries
 * the moment of delivery, and a slow courier can put that outside the
 * window. Without this check the delivery is queued, fails, retries five
 * times over six hours and dies with a message about a timestamp — for
 * every late order, for ever. With it, the row is marked skipped once and
 * says why, in words.
 */
export const META_EVENT_MAX_AGE_DAYS = 7;

export function isTooOldForMeta(eventTime: Date, now = new Date()): boolean {
  const days = (now.getTime() - eventTime.getTime()) / 86_400_000;
  return days > META_EVENT_MAX_AGE_DAYS;
}

/**
 * The event id: stable across retries of the SAME delivery.
 *
 * Meta deduplicates on `event_name` + `event_id`. Deriving it from the
 * conversion and the order rather than randomly means a row that is somehow
 * sent twice — a retry that actually succeeded the first time, two workers,
 * a restored backup — is still counted once on Meta's side, not only on
 * ours.
 *
 * NOT the id the browser sends: the browser pixel passes no event id at all, so Meta cannot join a browser event to
 * this one. That is why a pixel's order event is sent from ONE side only — the browser stands down for a pixel the
 * server covers (`pixelsWithServerPurchase`) — and not "deduplicated" afterwards.
 */
export function conversionEventId(conversionId: string, orderId: string): string {
  return `${conversionId.slice(0, 8)}.${orderId}`;
}
