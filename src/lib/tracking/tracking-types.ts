/**
 * GLOBAL TRACKING — types & pure helpers (client-safe, testable).
 *
 * One central engine dispatches allowlisted events to every enabled,
 * scope-matching pixel of the company (Meta / TikTok / Snapchat / Google).
 *
 * Security model:
 *  - The ONLY stored configuration value is the Pixel ID, validated
 *    server-side per platform. No tokens/secrets/user JavaScript.
 *  - Platform loaders are 100% hard-coded — user input can never inject
 *    script/HTML/event names. All events and platforms are allowlisted.
 *  - Scope is resolved server-side; the client never grants itself pixels.
 *  - Payloads are built from trusted React/server state only, sanitized
 *    (no PII) by sanitizeTrackingPayload().
 */

export const TRACKING_PLATFORMS = ['META', 'TIKTOK', 'SNAPCHAT', 'GOOGLE'] as const;
export type TrackingPlatform = (typeof TRACKING_PLATFORMS)[number];

export const TRACKING_SCOPES = ['GLOBAL', 'PUBLIC', 'LANDING_PAGES'] as const;
export type TrackingScope = (typeof TRACKING_SCOPES)[number];

/** Allowlisted, code-defined events — no user-defined event names, ever. */
export const TRACKING_EVENTS = ['PageView', 'ViewContent', 'InitiateCheckout', 'Purchase', 'Lead'] as const;

/**
 * WHAT AN ORDER IS REPORTED AS — «شو الهدف الي بدك التحويل عليه».
 *
 * The order form always announces one moment: a real order, accepted by the server. Each pixel says what that moment
 * is called on its platform — a purchase (the default, as it always was) or a lead, for a seller whose campaigns
 * optimise on leads. `Lead` is never fired on its own; it is only what `Purchase` becomes for such a pixel.
 */
export const ORDER_EVENTS = ['Purchase', 'Lead'] as const;
export type OrderEvent = (typeof ORDER_EVENTS)[number];
export const ORDER_EVENT_AR: Record<OrderEvent, string> = { Purchase: 'شراء', Lead: 'عميل محتمل' };
export type TrackingEventName = (typeof TRACKING_EVENTS)[number];

/**
 * Page context used for scope resolution (server-side).
 *
 * Pixels fire on SELLING pages only: a landing page is LANDING_PAGES, a
 * storefront page is PUBLIC. The dashboard is neither and loads nothing —
 * a seller's own clicks in the admin are not visits to report to an ad
 * account.
 */
export type TrackingPageContext = 'PUBLIC' | 'LANDING_PAGES';

/**
 * What a seller chooses per pixel, in their words.
 *
 * The stored scopes are three, but with pixels confined to selling pages
 * two of them mean the same thing: GLOBAL and PUBLIC both reach every
 * landing page and every storefront page. The screen offers the two real
 * choices; a PUBLIC row reads as the first.
 */
export const SCOPE_CHOICES: { value: TrackingScope; label: string; hint: string }[] = [
  { value: 'GLOBAL', label: 'كل صفحات البيع', hint: 'صفحات الهبوط وواجهات المتاجر' },
  { value: 'LANDING_PAGES', label: 'صفحات الهبوط فقط', hint: 'لا يعمل على واجهات المتاجر' },
];

/** The choice a stored scope shows as. */
export function scopeChoice(scope: string): TrackingScope {
  return scope === 'LANDING_PAGES' ? 'LANDING_PAGES' : 'GLOBAL';
}

/**
 * WHOSE VISITORS A PIXEL IS TOLD ABOUT — «فصل البيكسل لكل متجر وبلد».
 *
 * Three states, and they are mutually exclusive by construction as well as
 * by a database CHECK:
 *
 *   · `{}`                 — every store in the company
 *   · `{ countryId }`      — every store in that country, now and later
 *   · `{ storeId }`        — that store alone
 *
 * A row naming both would be two answers to one question: if the store is
 * not in that country, which decides? There is no good answer, so the
 * state is refused rather than resolved.
 */
export interface PixelScope {
  storeId?: string | null;
  countryId?: string | null;
}

/** Where a page is being rendered, so the rule has something to compare to. */
export interface PageOrigin {
  storeId: string | null;
  countryId: string | null;
}

/**
 * DOES THIS PIXEL FIRE ON THIS PAGE?
 *
 * Pure, so every branch below is reachable from a test — including the
 * ones that must never happen. The whole feature is this function; the
 * query that fetches rows is an optimisation of it, and the guard checks
 * the two agree.
 *
 * ── THE CASE THE OWNER ASKED ABOUT ──
 *
 * «حتى لو ح اولد بلد او متجر جديد» — a store opened tomorrow. It is
 * reached by a company-wide pixel (both NULL) and by its own country's
 * pixel, and by nothing else. That is not an accident of NULL handling: a
 * company-wide pixel is a seller SAYING «all my shops», which the screen
 * names out loud, and a country pixel is a seller saying «everything I
 * open in Jordan». A pixel scoped to one store never follows.
 *
 * ── AND A PAGE THAT BELONGS TO NO STORE ──
 *
 * `LandingPage.storeId` is nullable: a campaign page can exist without a
 * shop. Such a page is reached by company-wide pixels ONLY. Not because
 * that is convenient — because a page with no store is in no country
 * either, so there is nothing for a narrower scope to match, and the
 * alternative (treating unknown as «matches everything») is how a pixel
 * belonging to one shop starts reporting another's sales.
 */
export function pixelReaches(pixel: PixelScope, page: PageOrigin): boolean {
  // A store scope matches one store and nothing else — never a page whose
  // store is unknown.
  if (pixel.storeId) return pixel.storeId === page.storeId;
  // A country scope matches any store in it, including ones opened later.
  if (pixel.countryId) return pixel.countryId === page.countryId;
  // Neither: the company's own, everywhere it sells.
  return true;
}

/** What a seller picked, for the screen. Derived, never stored. */
export type PixelScopeKind = 'COMPANY' | 'COUNTRY' | 'STORE';

export function pixelScopeKind(pixel: PixelScope): PixelScopeKind {
  if (pixel.storeId) return 'STORE';
  if (pixel.countryId) return 'COUNTRY';
  return 'COMPANY';
}

/** Serializable pixel as delivered to the client engine. */
export interface TrackingPixelView {
  id: string;
  platform: TrackingPlatform;
  name: string;
  pixelId: string; // re-validated before use
  scope: TrackingScope;
  enabled: boolean;
  /** Null for a company-wide pixel. Sent so a screen can say where it fires. */
  storeId?: string | null;
  countryId?: string | null;
  /**
   * THIS PIXEL'S PURCHASE COMES FROM THE SERVER, AT CONFIRMATION.
   *
   * True when the company has an enabled conversion on «تأكّد الطلب» named like THIS PIXEL'S order event (`Purchase`,
   * or `Lead` for a pixel whose `orderEvent` is Lead) that the pixel can
   * actually send (the pixel is on and holds its token). The browser then does NOT send the order event to it — at
   * the form's submit, or for an add-on — because Meta would count the submission and the confirmation as
   * two purchases. Absent/false: the browser sends Purchase as it always did. Set by the server, never by
   * the client.
   */
  purchaseOnServer?: boolean;
  /** What an order is reported as on this pixel; absent = `Purchase`. */
  orderEvent?: OrderEvent;
  /** False only when the seller switched the event off for this pixel; absent = sent. */
  sendViewContent?: boolean;
  sendInitiateCheckout?: boolean;
}

/** Neutral event payload — adapters map it to each platform's format. */
export interface TrackingPayload {
  contentIds?: string[]; // DB product ids
  contentName?: string | null;
  value?: number | null; // DB price / server order total only
  currency?: string | null;
  orderId?: string | null; // server orderNumber (Purchase dedupe)
}

/** Keys that must NEVER appear in any tracking payload (PII protection). */
const PII_KEYS = new Set([
  'full_name', 'fullname', 'name', 'phone', 'address', 'notes', 'note',
  'email', 'city', 'companyid', 'userid', 'userid', 'customerid',
  'lastname', 'firstname', 'em', 'ph', 'ct', 'zp', 'country', 'st',
]);

/**
 * Sanitize a payload: drop PII-ish keys, non-primitive values and anything
 * oversized. Used by adapters so even a future caller mistake cannot leak
 * name/phone/address/notes into an ad platform.
 *
 * IDEMPOTENT: it reads its own output as well as the camelCase input. The
 * engine sanitizes once and every adapter sanitizes again, and reading only
 * `contentIds`/`orderId` meant the second pass threw the products and the
 * order number away — no content ids on any ViewContent, no transaction id
 * on any Purchase, on every platform.
 */
export function sanitizeTrackingPayload(payload: TrackingPayload | Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!payload || typeof payload !== 'object') return out;
  const p = payload as Record<string, unknown>;
  const contentIds = p.contentIds ?? p.content_ids;
  const contentName = p.contentName ?? p.content_name;
  const orderId = p.orderId ?? p.order_id;

  if (Array.isArray(contentIds)) {
    const ids = contentIds
      .filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 64)
      .slice(0, 10);
    if (ids.length > 0) out.content_ids = ids;
  }
  if (typeof contentName === 'string' && contentName.trim()) {
    out.content_name = contentName.trim().slice(0, 120);
  }
  if (typeof p.value === 'number' && Number.isFinite(p.value) && p.value >= 0) {
    out.value = Math.round(p.value * 100) / 100;
  }
  if (typeof p.currency === 'string' && /^[A-Za-z]{3}$/.test(p.currency)) {
    out.currency = p.currency.toUpperCase();
  }
  if (typeof orderId === 'string' && orderId.length <= 64) {
    out.order_id = orderId;
  }
  // Defense-in-depth: nothing PII-like survives, no matter the input shape.
  for (const key of Object.keys(out)) {
    if (PII_KEYS.has(key.toLowerCase())) delete out[key];
  }
  return out;
}

/** Which pixels apply to a given page context, honoring scope.
 *  PUBLIC pages: GLOBAL + PUBLIC. Landing pages (which are also public):
 *  GLOBAL + PUBLIC + LANDING_PAGES. */
export function filterPixelsForPage(
  pixels: TrackingPixelView[],
  page: TrackingPageContext
): TrackingPixelView[] {
  return pixels.filter((p) => p.enabled && scopeServesPage(p.scope, page));
}

/**
 * DOES A PIXEL OF THIS KIND-OF-PAGE SCOPE SERVE THIS KIND OF PAGE?
 *
 * One rule for the browser (which pixels a page loads) and the server (which
 * pixels an order's conversion is sent to) — so a «landing pages only» pixel
 * never hears about a storefront order from either side.
 */
export function scopeServesPage(scope: string, page: TrackingPageContext): boolean {
  return scope === 'GLOBAL' || scope === page || (page === 'LANDING_PAGES' && scope === 'PUBLIC');
}

/** Dedupe key: platform + pixel + event (+ order for Purchase). */
export function trackingEventKey(
  platform: TrackingPlatform,
  pixelId: string,
  event: TrackingEventName,
  orderId?: string | null
): string {
  return orderId
    ? `${platform}:${pixelId}:${event}:${orderId}`
    : `${platform}:${pixelId}:${event}`;
}

/**
 * Consent hook (future cookie-consent integration point).
 * Today the app has no consent layer — default allow keeps current behavior;
 * the engine signature already accepts a consent gate so it can be added
 * later without rewriting the engine.
 */
export type TrackingConsentGate = (platform: TrackingPlatform, scope: TrackingScope) => boolean;
export const allowAllConsent: TrackingConsentGate = () => true;

/** Mask a pixel ID for audit logs (platform + name remain readable). */
export function maskPixelId(pixelId: string): string {
  const v = String(pixelId || '');
  if (v.length <= 4) return '****';
  return `${v.slice(0, 3)}***${v.slice(-2)}`;
}
