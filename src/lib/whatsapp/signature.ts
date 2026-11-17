/**
 * META WEBHOOK SIGNATURE — X-Hub-Signature-256 verification (HMAC-SHA256 of
 * the RAW request body with the Meta App Secret). Timing-safe comparison.
 * Fail closed: without a configured app secret the webhook is rejected.
 */
import crypto from 'crypto';
import { getAppSecret } from './config';

export async function verifyMetaSignature(rawBody: string, signatureHeader: string | null): Promise<boolean> {
  const secret = await getAppSecret();
  if (!secret || !signatureHeader) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
