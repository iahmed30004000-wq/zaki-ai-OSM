import { db } from '../db';
import { encryptSecret, encryptionAvailable } from '../secrets';

/**
 * THE AD TAGS A PAGES ORDER ARRIVES WITH — read leniently, stamped after the order exists (the media buyer's contract,
 * `oms.landing-attribution-intake`; the media buyer, 17/11).
 *
 * The media buyer decides where ad money goes by joining an order to the AD that brought it, so the landing door takes the
 * tags the visitor's link carried: `ad_id`, `adset_id`, `campaign_id` (the platform's ids, digits), `ad_name`, `utm_source`,
 * `utm_medium`, the link it opened, and Meta's click id and browser ids.
 *
 * ── THE ADS' LINKS (the owner, 17/11) ──
 *
 * Every ad link carries `utm_source=fb&utm_campaign={{campaign.id}}&utm_term={{adset.id}}&utm_content={{ad.id}}&ad_name={{ad.name}}`: the campaign, the ad set
 * and the ad ride in the utm trio, which is the join between an ad and an order. They are kept AS TEXT (`utmCampaign` · `utmTerm` · `utmContent`) and, when
 * the value is all digits, also become `campaign_id` · `adset_id` · `ad_id`. A value that is not a number — a macro the platform did not fill in, a name —
 * stays readable in the utm column and the id is left EMPTY, never a guess. An explicit `ad_id` / `adset_id` / `campaign_id` in the body wins when it is
 * valid (a page that already resolved them knows better than a macro).
 *
 * ── A BAD TAG NEVER LOSES AN ORDER ──
 *
 * A link edited by hand, a tool that rewrote a parameter, a value that is not digits: that is a visitor who still bought. So
 * the tags are read one by one and a value that does not fit is DROPPED, the order goes on — the opposite of the order body
 * itself, whose every field is checked and refused. «Ids digits only» holds because only digits are ever kept.
 *
 * ── AFTER THE ORDER, NEVER INSIDE ITS CREATION ──
 *
 * Order creation (`createPublicOrder`) is not touched. The door stamps the tags once the order is committed, in one
 * conditional update that fills a row only while it has none (`adId` and `adsetId` both still null): a retry, a replay or a
 * second call writes nothing, and a failure here is logged and swallowed — the order is already saved and the media buyer
 * reading a null for a day is the old behaviour, not a lost sale.
 *
 * ── THE SEALED THREE ──
 *
 * `fbclid`, `fbc` and `fbp` identify a person's browser. They are encrypted before they are stored (the same `encryptSecret` a
 * courier password uses), dropped — never written in clear — when no key is configured, and read by no endpoint.
 */

export interface AdTags {
  method: 'url_tags' | null;
  adId: string | null;
  adsetId: string | null;
  campaignId: string | null;
  adName: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmTerm: string | null;
  utmContent: string | null;
  landingUrl: string | null;
  fbclid: string | null;
  fbc: string | null;
  fbp: string | null;
}

const ID = /^\d{6,25}$/;

function id(v: unknown): string | null {
  return typeof v === 'string' && ID.test(v.trim()) ? v.trim() : null;
}

function text(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 && t.length <= max ? t : null;
}

/**
 * The page the visitor opened, WITHOUT its query string or fragment: the query is where the click id and every other tag ride, and what the
 * media buyer reads back is a page, not a tracked link. Anything that is not an http(s) address is dropped.
 */
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
    method: a.method === 'url_tags' ? 'url_tags' : null,
    // The explicit id first; else the digits the ad's own macro carried (`utm_content` = the ad, `utm_term` = the ad set, `utm_campaign` = the campaign).
    adId: id(a.ad_id) ?? id(a.utm_content),
    adsetId: id(a.adset_id) ?? id(a.utm_term),
    campaignId: id(a.campaign_id) ?? id(a.utm_campaign),
    adName: text(a.ad_name, 120),
    utmSource: text(a.utm_source, 40),
    utmMedium: text(a.utm_medium, 60),
    utmCampaign: text(a.utm_campaign, 120),
    utmTerm: text(a.utm_term, 120),
    utmContent: text(a.utm_content, 120),
    landingUrl: pageLink(a.landing_url),
    fbclid: text(a.fbclid, 200),
    fbc: text(a.fbc, 200),
    fbp: text(a.fbp, 200),
  };
  const any = Object.entries(tags).some(([k, v]) => k !== 'method' && v !== null);
  return any ? tags : null;
}

function sealed(value: string | null): string | null {
  if (!value) return null;
  if (!encryptionAvailable()) {
    console.error('the landing door: APP_ENCRYPTION_KEY is not set — a Meta browser id was dropped, not stored');
    return null;
  }
  try {
    return encryptSecret(value);
  } catch {
    return null;
  }
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
      where: { companyId, orderNumber, adId: null, adsetId: null },
      data: {
        adId: tags.adId,
        adSourceType: tags.method,
        adsetId: tags.adsetId,
        adCampaignId: tags.campaignId,
        adName: tags.adName,
        utmSource: tags.utmSource,
        utmMedium: tags.utmMedium,
        utmCampaign: tags.utmCampaign,
        utmTerm: tags.utmTerm,
        utmContent: tags.utmContent,
        landingUrl: tags.landingUrl,
        fbclidEnc: sealed(tags.fbclid),
        fbcEnc: sealed(tags.fbc),
        fbpEnc: sealed(tags.fbp),
      },
    });
    return done.count > 0;
  } catch (e) {
    console.error('the landing door: could not stamp the ad tags on the order (non-fatal):', (e as Error)?.name || 'unknown');
    return false;
  }
}
