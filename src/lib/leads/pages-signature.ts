import crypto from 'crypto';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE PAGES SYSTEM'S SIGNATURE (Confirmation Center v2, step E1) — how the OMS knows a lead really came from pages.zakiai.io.
 *
 * The very shape the OMS signs its own six app events with (`apps/events.ts`), turned around: `X-Zaki-Timestamp` (milliseconds) and `X-Zaki-Signature = sha256=<HMAC-SHA256(secret, "<timestamp>.<raw body>")>`.
 * The secret is `PAGES_WEBHOOK_SECRET`, from the environment only — never a file, never the repository. FAIL CLOSED: without a configured secret every request is refused.
 *
 * Two things the older inbound doors do not have, because a lead is a person's details and a replay would be a second copy of them: the timestamp must be within ±5 minutes of the server's clock
 * (a recorded request cannot be played back an hour later), and the comparison is timing-safe after a length check. Replays inside the window are absorbed by the lead's own unique id.
 * ═══════════════════════════════════════════════════════════════════════
 */

/** How far the sender's clock may be from ours. */
export const SIGNATURE_WINDOW_MS = 5 * 60_000;

export function pagesWebhookSecret(): string | null {
  const s = process.env.PAGES_WEBHOOK_SECRET;
  return s && s.trim() ? s.trim() : null;
}

/** The signature the pages system must have sent for this timestamp and this raw body. */
export function sign(secret: string, timestamp: string, rawBody: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');
}

export type SignatureVerdict = 'OK' | 'NOT_CONFIGURED' | 'MISSING' | 'STALE' | 'BAD';

/** Judges a request's headers and raw body. Pure apart from reading the secret; never throws. */
export function verifyPagesSignature(input: { timestamp: string | null; signature: string | null; rawBody: string; now?: number; secret?: string | null }): SignatureVerdict {
  const secret = input.secret === undefined ? pagesWebhookSecret() : input.secret;
  if (!secret) return 'NOT_CONFIGURED';
  if (!input.timestamp || !input.signature) return 'MISSING';
  const at = Number(input.timestamp);
  if (!Number.isFinite(at) || !/^\d{10,16}$/.test(input.timestamp)) return 'BAD';
  if (Math.abs((input.now ?? Date.now()) - at) > SIGNATURE_WINDOW_MS) return 'STALE';
  const a = Buffer.from(sign(secret, input.timestamp, input.rawBody));
  const b = Buffer.from(input.signature);
  if (a.length !== b.length) return 'BAD';
  return crypto.timingSafeEqual(a, b) ? 'OK' : 'BAD';
}
