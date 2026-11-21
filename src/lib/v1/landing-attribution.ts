import { encryptSecret, encryptionAvailable } from '../secrets';

/**
 * WHICH AD A LANDING-PAGE ORDER CAME FROM — read from what the landing system sends, never trusted to be tidy.
 *
 * The standalone landing system (contract oms-lp.v1 §4) has always sent the visit's `attribution` object (`utm_*`,
 * `fbclid`, the `_fbp` / `_fbc` cookies) with every order, and this door used to drop it on the floor: orders reached
 * the OMS with no ad and no campaign, and the conversions this system sends to Meta (`conversions/emit.ts`) carried
 * no click id, so Meta matched them on the hashed phone alone.
 *
 * ── THE MAPPING (the owner's, item 1) ──
 *
 *   utm_content   → `Order.adId`            the Meta ad id
 *   utm_campaign  → `Order.metaCampaignId`  the Meta campaign id — NOT `campaignId`, which is a foreign key to this
 *                                           system's own campaigns and is still resolved from the `campaign` short
 *                                           code exactly as before (`resolveCampaign`)
 *   utm_term      → `Order.refCode`         the Meta ad SET id (the owner's choice of column; there is no adset column)
 *   'meta'        → `Order.adSourceType`    only when the visit came from Meta: an `fbclid`, or a `utm_source` of
 *                                           facebook / fb / instagram / ig / meta (any case). Otherwise null — the
 *                                           utm values are still kept.
 *   landingPageId → `Order.externalLandingPageId`  the landing system's own page id (`Order.landingPageId` is a
 *                                           foreign key to THIS system's pages and stays null at this door)
 *   _fbc / _fbp   → `Order.fbcEnc` / `fbpEnc`      SEALED with `encryptSecret`, like `ctwaClidEnc`: a click id is one
 *                                           person's click on one ad
 *   client_user_agent → `Order.clientUserAgent`   the visitor's browser, as Meta wants it in `user_data`
 *   event_id      → `Order.lpPurchaseEventId`     the id of the Purchase event the landing system sent Meta for this
 *                                           order — kept for reference; this system's own events keep their own ids
 *
 * ── A BAD VALUE IS DROPPED, NEVER A REASON TO REFUSE AN ORDER ──
 *
 * Each value is a trimmed string within its length, with no control character; the click and browser ids must also
 * look like Meta's (`fb.<n>.<time>.<value>`). Anything else is stored as null — not cut down: a truncated click id
 * is a different click id, and a wrong one matches somebody else's advert to this sale (`conversions/hash.ts`).
 * No value read here is ever written to a log.
 *
 * ── WHAT ZAKI PAGES ADDS (2026-11-21, «Prompt 2» — custom conversions sent from Pages) ──
 *
 * Zaki Pages may also send these at the TOP level of the order body, every one optional. Where a column already holds
 * the same fact it is reused; only what had no home is new:
 *
 *   fbp / fbc / utm_* / ad_name   → the same columns as above (and `stampAdTags`), read as if they were inside
 *                                   `attribution`. When both places carry one, `attribution` wins: it is the older contract.
 *   ad_id         → `Order.adId`, before `utm_content` (an explicit ad id is the better reading of the same fact)
 *   page_id       → `Order.externalLandingPageId`, only when `landingPageId` gives none (it is required, so: a fallback)
 *   browser_event_id → `Order.lpPurchaseEventId`, only when `event_id` gives none: both are the id the page's own pixel
 *                   sent Meta for this purchase, so one column — never a second copy that could disagree with it
 *   event_source_url → `Order.landingUrl` (through `stampAdTags`, as `landing_url`): the page the visitor ordered on,
 *                   kept WITHOUT its query string, like `landing_url` always was
 *   pixel_id      → `Order.lpPixelId`        NEW — the Meta pixel the page fired (digits only)
 *   page_slug     → `Order.externalPageSlug` NEW — the page's slug in Zaki Pages, for reading an order back to its page
 *   cc_sender     → `Order.ccSender`         NEW — «pages» means Zaki Pages sends this order's custom conversions to
 *                   Meta itself, so this system's sender skips it (`conversions/emit.ts`). Anything else is null = as before.
 *   client_ip     → NOT STORED. It is personal data and this system has no use for it: it may not send a raw IP to Meta
 *                   (no raw personal data to Meta), and an order with `cc_sender: "pages"` is sent by Pages, which has the
 *                   visitor's IP from the live request. Kept nowhere, sealed or not — the safest copy is the one not made.
 */

/** utm_source values that mean the visit came from Meta, lowercased. */
export const META_SOURCES: ReadonlySet<string> = new Set(['facebook', 'fb', 'instagram', 'ig', 'meta']);

export const ATTRIBUTION_LIMITS = {
  /** An ad, ad set or campaign id: Meta's are about twenty digits; a name typed in a link fits too. */
  id: 100,
  fbc: 500,
  fbp: 200,
  userAgent: 512,
  eventId: 100,
  pageId: 64,
  /** Zaki Pages' slug for the page. */
  pageSlug: 120,
  /** A Meta pixel id: about sixteen digits. */
  pixelId: 32,
} as const;

/** The only sender names `cc_sender` may carry. Anything else is no sender, and this system sends as it always did. */
export const CC_SENDERS = ['pages', 'oms'] as const;
export type CcSender = (typeof CC_SENDERS)[number];
/** «pages»: Zaki Pages sends this order's custom conversions itself. */
export const PAGES_CC_SENDER: CcSender = 'pages';

/** The top-level names Zaki Pages may send that stand for a key of `attribution` (2026-11-21). */
const TOP_LEVEL_ATTRIBUTION: Readonly<Record<string, string>> = {
  fbc: 'fbc',
  fbp: 'fbp',
  utm_source: 'utm_source',
  utm_medium: 'utm_medium',
  utm_campaign: 'utm_campaign',
  utm_content: 'utm_content',
  utm_term: 'utm_term',
  ad_id: 'ad_id',
  ad_name: 'ad_name',
  event_source_url: 'landing_url',
};

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The visit's ad facts as ONE `attribution` object: the body's own `attribution`, with what Zaki Pages sent at the top
 * level filling only the keys it lacks. A body with none of the top-level names gets its `attribution` back untouched
 * (the very same value, whatever it is), so an old page is read exactly as before.
 */
export function mergedAttribution(body: Record<string, unknown>): unknown {
  const top = Object.entries(TOP_LEVEL_ATTRIBUTION).filter(([name]) => body[name] !== undefined && body[name] !== null);
  if (top.length === 0) return body.attribution;
  const out: Record<string, unknown> = {};
  for (const [name, key] of top) out[key] = body[name];
  return { ...out, ...(isPlainObject(body.attribution) ? body.attribution : {}) };
}

/** What only Zaki Pages sends and no older column holds. */
export interface PagesFields {
  ccSender: CcSender | null;
  lpPixelId: string | null;
  externalPageSlug: string | null;
}

/** Pure, like `readLandingAttribution`: a bad value is null, never a refusal. `client_ip` is read by nothing. */
export function readPagesFields(body: { cc_sender?: unknown; pixel_id?: unknown; page_slug?: unknown }): PagesFields {
  const sender = cleanValue(body.cc_sender, 10)?.toLowerCase() ?? null;
  return {
    ccSender: sender && (CC_SENDERS as readonly string[]).includes(sender) ? (sender as CcSender) : null,
    lpPixelId: cleanValue(body.pixel_id, ATTRIBUTION_LIMITS.pixelId, /^\d+$/),
    externalPageSlug: cleanValue(body.page_slug, ATTRIBUTION_LIMITS.pageSlug, /^\S+$/),
  };
}

/** The new columns to write: only those with a value. */
export function pagesColumns(p: PagesFields): Record<string, string> {
  return Object.fromEntries(Object.entries(p).filter((e): e is [string, string] => e[1] !== null));
}

/** Meta's cookie shape: `fb.<subdomain index>.<creation time>.<value>`. */
const META_COOKIE = /^fb\.\d+\.\d+\.\S+$/;

export interface LandingAttribution {
  adId: string | null;
  metaCampaignId: string | null;
  refCode: string | null;
  adSourceType: 'meta' | null;
  externalLandingPageId: string | null;
  fbc: string | null;
  fbp: string | null;
  clientUserAgent: string | null;
  lpPurchaseEventId: string | null;
}

/** A trimmed string within `max`, with no control character, matching `shape` when given — or null. */
export function cleanValue(v: unknown, max: number, shape?: RegExp): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || s.length > max) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(s)) return null;
  if (shape && !shape.test(s)) return null;
  return s;
}

/** Did this visit come from Meta? An fbclid, or a utm_source Meta's own links use. */
export function cameFromMeta(attr: Record<string, unknown>): boolean {
  if (cleanValue(attr.fbclid, 2048)) return true;
  const source = cleanValue(attr.utm_source, ATTRIBUTION_LIMITS.id);
  return !!source && META_SOURCES.has(source.toLowerCase());
}

/**
 * The order's ad facts, in plain text, from the body the landing system sent. Pure: no database, no key.
 *
 * `attribution` is read only when it is a plain object; anything else (an old page sends none) is no attribution.
 */
export function readLandingAttribution(body: {
  landingPageId?: unknown;
  attribution?: unknown;
  event_id?: unknown;
  client_user_agent?: unknown;
  /** Zaki Pages' names (2026-11-21): fallbacks for `landingPageId` and `event_id` — see the header. */
  page_id?: unknown;
  browser_event_id?: unknown;
}): LandingAttribution {
  const raw = body.attribution;
  const attr: Record<string, unknown> = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    adId: cleanValue(attr.ad_id, ATTRIBUTION_LIMITS.id) ?? cleanValue(attr.utm_content, ATTRIBUTION_LIMITS.id),
    metaCampaignId: cleanValue(attr.utm_campaign, ATTRIBUTION_LIMITS.id),
    refCode: cleanValue(attr.utm_term, ATTRIBUTION_LIMITS.id),
    adSourceType: cameFromMeta(attr) ? 'meta' : null,
    externalLandingPageId:
      cleanValue(body.landingPageId, ATTRIBUTION_LIMITS.pageId) ?? cleanValue(body.page_id, ATTRIBUTION_LIMITS.pageId),
    fbc: cleanValue(attr.fbc, ATTRIBUTION_LIMITS.fbc, META_COOKIE),
    fbp: cleanValue(attr.fbp, ATTRIBUTION_LIMITS.fbp, META_COOKIE),
    clientUserAgent: cleanValue(body.client_user_agent, ATTRIBUTION_LIMITS.userAgent),
    lpPurchaseEventId:
      cleanValue(body.event_id, ATTRIBUTION_LIMITS.eventId) ?? cleanValue(body.browser_event_id, ATTRIBUTION_LIMITS.eventId),
  };
}

/**
 * A click or browser id, sealed before it is stored — or dropped. Same rule as `sealed` in `order-intake.ts`: with no
 * key configured the value is lost rather than written in the clear under a name that says «Enc».
 */
function sealed(value: string | null): string | null {
  if (!value || !encryptionAvailable()) return null;
  try {
    return encryptSecret(value);
  } catch {
    return null;
  }
}

/** The Order columns to write: only those with a value, so a page that sent nothing writes nothing but its page id. */
export function attributionColumns(a: LandingAttribution): Record<string, string> {
  const columns: Record<string, string | null> = {
    adId: a.adId,
    metaCampaignId: a.metaCampaignId,
    refCode: a.refCode,
    adSourceType: a.adSourceType,
    externalLandingPageId: a.externalLandingPageId,
    fbcEnc: sealed(a.fbc),
    fbpEnc: sealed(a.fbp),
    clientUserAgent: a.clientUserAgent,
    lpPurchaseEventId: a.lpPurchaseEventId,
  };
  return Object.fromEntries(Object.entries(columns).filter((e): e is [string, string] => e[1] !== null));
}
