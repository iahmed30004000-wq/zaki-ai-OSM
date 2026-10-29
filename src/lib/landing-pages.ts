/**
 * Landing Pages helpers — server-side only.
 *
 * Security model:
 *  - Uploaded HTML is stored server-side (DB) and NEVER trusted from the client.
 *  - Uploaded HTML is only ever rendered inside a sandboxed iframe
 *    (opaque origin: no allow-same-origin) so it can never read the CRM
 *    session cookie (salesflow_session), localStorage, JWT or CSRF tokens.
 *  - The public order API derives companyId/product/price exclusively from
 *    the LandingPage row — browser values are ignored by design.
 */

import path from 'path';
import { SignJWT, jwtVerify } from 'jose';

export const LANDING_PAGE_SOURCE = 'Landing Page';
export const MAX_LANDING_HTML_SIZE_MB = parseInt(process.env.MAX_LANDING_HTML_SIZE_MB || '2', 10);
export const MAX_LANDING_HTML_BYTES = MAX_LANDING_HTML_SIZE_MB * 1024 * 1024;

/** slug: lowercase letters, digits and hyphens only, 3-60 chars, no leading/trailing hyphen */
export const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])?$/;

export function validateSlug(slug: string): { valid: boolean; error?: string } {
  if (!SLUG_REGEX.test(slug)) {
    return {
      valid: false,
      error: 'الرابط (slug) غير صالح: أحرف إنجليزية صغيرة وأرقام وشرطات فقط (3-60 حرفًا)',
    };
  }
  return { valid: true };
}

/**
 * Server-side validation of an uploaded landing page file.
 * Never trusts the filename or Content-Type from the client.
 */
export function validateHtmlUpload(file: {
  fileName: string;
  size: number;
  buffer: Buffer;
}): { valid: boolean; error?: string } {
  // Extension check (lower-cased, no path separators allowed)
  const base = path.basename(file.fileName || '');
  if (path.extname(base).toLowerCase() !== '.html' || base.toLowerCase() === '.html') {
    return { valid: false, error: 'الملف يجب أن يكون بصيغة .html' };
  }
  // Reject nested paths / traversal attempts in the client name entirely
  if (/[/\\]/.test(file.fileName || '') || file.fileName.includes('..')) {
    return { valid: false, error: 'اسم الملف غير صالح' };
  }
  if (file.size <= 0) {
    return { valid: false, error: 'الملف فارغ' };
  }
  if (file.size > MAX_LANDING_HTML_BYTES) {
    return { valid: false, error: `حجم الملف يتجاوز الحد المسموح (${MAX_LANDING_HTML_SIZE_MB} ميجابايت)` };
  }
  // Magic sniffing: an HTML file must start with '<' (optionally after a
  // UTF BOM / whitespace). Anything else (binary, image, script, zip...) is rejected.
  let start = 0;
  if (file.buffer[0] === 0xef && file.buffer[1] === 0xbb && file.buffer[2] === 0xbf) start = 3;
  while (start < file.buffer.length && (file.buffer[start] === 0x20 || file.buffer[start] === 0x0a || file.buffer[start] === 0x0d || file.buffer[start] === 0x09)) start++;
  if (file.buffer[start] !== 0x3c) {
    return { valid: false, error: 'محتوى الملف ليس مستند HTML صالحًا' };
  }
  return { valid: true };
}

/** Hard cap for stored HTML re-read from DB (defense in depth). */
export function clampStoredHtml(html: string | null | undefined): string | null {
  if (!html) return null;
  const buf = Buffer.from(html, 'utf8');
  if (buf.length > MAX_LANDING_HTML_BYTES) return null;
  return html;
}

/**
 * Public quantity limits (server-enforced).
 */
export const LANDING_PAGE_MIN_QTY = 1;
export const LANDING_PAGE_MAX_QTY = 99;

/**
 * The Trusted Native Order Form is NOT injected into the uploaded HTML.
 * It is rendered by the Zaki AI app itself in /lp/[slug] BELOW the sandboxed
 * iframe, so the uploaded (untrusted) HTML can never touch or read it.
 */

/** CSP for the raw public HTML response — defined in csp.ts, sent by next.config. */
export { RAW_HTML_CSP } from './csp';

/** Conversion rate (percentage) — orders / views. */
export function conversionRate(views: number, orders: number): number {
  if (!views || views <= 0) return 0;
  return Number(((orders / views) * 100).toFixed(1));
}

/**
 * Short-lived signed preview tokens: let the dashboard embed a preview of an
 * UNPUBLISHED page inside a sandboxed iframe without exposing it publicly.
 * Scoped to one LandingPage id, 10 minutes TTL.
 */
function jwtSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    if (process.env.NODE_ENV === 'production' && process.env.NEXT_PHASE !== 'phase-production-build') {
      throw new Error('SECURITY: JWT_SECRET required for preview tokens in production');
    }
    return new TextEncoder().encode('development_only_insecure_jwt_secret_key_0000');
  }
  return new TextEncoder().encode(secret);
}

export async function signPreviewToken(landingPageId: string): Promise<string> {
  return new SignJWT({ kind: 'lp_preview', lpId: landingPageId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(jwtSecret());
}

export async function verifyPreviewToken(token: string): Promise<{ lpId: string } | null> {
  try {
    const { payload } = await jwtVerify(token, jwtSecret());
    if (payload.kind !== 'lp_preview' || typeof payload.lpId !== 'string') return null;
    return { lpId: payload.lpId };
  } catch {
    return null;
  }
}

/**
 * HOW LONG AN ADD-ON LINK LIVES, in minutes — the one number.
 *
 * The seller's own window (`postOrderOfferSettings`) may be set up to a day, but the link the thank-you screen holds
 * dies here, so the window the screen is TOLD is `Math.min(window, ADDON_TOKEN_MINUTES)`.
 */
export const ADDON_TOKEN_MINUTES = 30;

/**
 * Short-lived signed ADD-ON token: issued once right after a public order is
 * created and handed to the success screen. It is the ONLY proof that this
 * anonymous visitor owns the just-created order — knowing the orderNumber
 * alone is NOT enough to add products (prevents tampering with other
 * people's orders). Contains no sensitive data, TTL 30 minutes.
 */
export async function signAddonToken(payload: { orderId: string; orderNumber: string }): Promise<string> {
  return new SignJWT({ kind: 'lp_addon', orderId: payload.orderId, orderNumber: payload.orderNumber })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${ADDON_TOKEN_MINUTES}m`)
    .sign(jwtSecret());
}

export async function verifyAddonToken(
  token: string
): Promise<{ orderId: string; orderNumber: string } | null> {
  try {
    const { payload } = await jwtVerify(token, jwtSecret());
    if (
      payload.kind !== 'lp_addon' ||
      typeof payload.orderId !== 'string' ||
      typeof payload.orderNumber !== 'string'
    ) {
      return null;
    }
    return { orderId: payload.orderId, orderNumber: payload.orderNumber };
  } catch {
    return null;
  }
}