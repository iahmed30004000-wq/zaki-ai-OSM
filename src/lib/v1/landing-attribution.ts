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
} as const;

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
}): LandingAttribution {
  const raw = body.attribution;
  const attr: Record<string, unknown> = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    adId: cleanValue(attr.utm_content, ATTRIBUTION_LIMITS.id),
    metaCampaignId: cleanValue(attr.utm_campaign, ATTRIBUTION_LIMITS.id),
    refCode: cleanValue(attr.utm_term, ATTRIBUTION_LIMITS.id),
    adSourceType: cameFromMeta(attr) ? 'meta' : null,
    externalLandingPageId: cleanValue(body.landingPageId, ATTRIBUTION_LIMITS.pageId),
    fbc: cleanValue(attr.fbc, ATTRIBUTION_LIMITS.fbc, META_COOKIE),
    fbp: cleanValue(attr.fbp, ATTRIBUTION_LIMITS.fbp, META_COOKIE),
    clientUserAgent: cleanValue(body.client_user_agent, ATTRIBUTION_LIMITS.userAgent),
    lpPurchaseEventId: cleanValue(body.event_id, ATTRIBUTION_LIMITS.eventId),
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
