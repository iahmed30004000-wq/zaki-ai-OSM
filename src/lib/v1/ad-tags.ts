import { db } from '../db';

/**
 * WHAT THE MEDIA BUYER'S LINK ADDS to the ad evidence a landing order already carries (the owner, 17/11).
 *
 * `landing-attribution.ts` (the landing door's own) keeps `utm_content` as `adId`, `utm_campaign` as `metaCampaignId`, `utm_term` as `refCode` (the ad set) and the
 * sealed click and browser cookies. Every ad link also carries `ad_name={{ad.name}}` and `utm_source`/`utm_medium`, and the media buyer reads the page back as a link:
 * these four are the part nothing kept — the ad's name, the utm source and medium, and the page the visitor opened.
 *
 * ── THE IDS ARE NOT STORED AGAIN, AND ARE ONLY HANDED OUT AS NUMBERS ──
 *
 * The three ids already have their columns, and a second copy of them is a figure that can disagree with itself. The rule «a value that is not a number is kept as text and
 * the id is left empty» is applied where the id leaves this system: `attributionItem` gives the media buyer `ad_id` / `adset_id` / `campaign_id` for a landing order only when
 * the stored value is all digits (`numericId`); a macro the platform did not fill in (`{{ad.id}}`) or a name stays readable in the column and is no id.
 *
 * ── A BAD TAG NEVER LOSES AN ORDER, AND NOTHING IS WRITTEN IN ORDER CREATION ──
 *
 * Each value is read on its own and one that does not fit is DROPPED. The page link is kept WITHOUT its query string or fragment (the query is where the click id and every
 * other tag ride) and only if it is http(s). The four are stamped after the order is committed, in one conditional update that fills a row only while it has none of them: a
 * retry or a replay writes nothing, and a failure is logged (its error name only) and swallowed — the order is already saved. `createPublicOrder` is not touched.
 */

export interface AdTags {
  adName: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  landingUrl: string | null;
}

function text(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  // eslint-disable-next-line no-control-regex
  if (t.length === 0 || t.length > max || /[\u0000-\u001f\u007f]/.test(t)) return null;
  return t;
}

/** The page the visitor opened, without its query string or fragment; anything that is not an http(s) address is dropped. */
function pageLink(v: unknown): string | null {
  const t = text(v, 300);
  if (!t) return null;
  try {
    const u = new URL(t);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin + u.pathname : null;
  } catch {
    return null;
  }
}

/** Whatever arrived under `attribution`, reduced to the tags that fit. Pure; never throws. */
export function readAdTags(raw: unknown): AdTags | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const a = raw as Record<string, unknown>;
  const tags: AdTags = {
    adName: text(a.ad_name, 120),
    utmSource: text(a.utm_source, 40),
    utmMedium: text(a.utm_medium, 60),
    landingUrl: pageLink(a.landing_url),
  };
  return Object.values(tags).some((v) => v !== null) ? tags : null;
}

/**
 * Write the tags on the order once. Returns whether a row was filled. Never throws: the order is already saved.
 * Scoped by the company, so the number can only ever name that company's own order.
 */
export async function stampAdTags(companyId: string, orderNumber: string, raw: unknown): Promise<boolean> {
  const tags = readAdTags(raw);
  if (!tags) return false;
  try {
    const done = await db.order.updateMany({
      where: { companyId, orderNumber, adName: null, utmSource: null, utmMedium: null, landingUrl: null },
      data: { adName: tags.adName, utmSource: tags.utmSource, utmMedium: tags.utmMedium, landingUrl: tags.landingUrl },
    });
    return done.count > 0;
  } catch (e) {
    const code = (e as { code?: unknown })?.code;
    console.error('the landing door: could not stamp the ad tags on the order (non-fatal):', typeof code === 'string' ? code : 'error');
    return false;
  }
}
