/**
 * TELEGRAM WEBHOOK SECRET — X-Telegram-Bot-Api-Secret-Token verification.
 * Timing-safe comparison; fails closed when no secret is configured.
 */
import crypto from 'crypto';
import { getWebhookSecret } from './config';

export async function verifyTelegramSecret(secretHeader: string | null): Promise<boolean> {
  const secret = await getWebhookSecret();
  if (!secret || !secretHeader) return false;
  const a = Buffer.from(secret);
  const b = Buffer.from(secretHeader);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
