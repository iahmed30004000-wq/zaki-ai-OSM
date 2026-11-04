import { db } from '../db';
import { decryptSecret } from '../secrets';

/**
 * «مساعد الاتصال» ON HER DESK — the callKey of her ACTIVE phone, read once per request to sign the call links of
 * «طلباتي» (`/api/confirmation/mine`). One indexed lookup (userId + revokedAt); nothing more when she has no phone.
 *
 * ── THE DESK NEVER FAILS BECAUSE OF THE HELPER ──
 *
 * The signed link is an extra: without it «اتصل» is today's `tel:` link and nothing else changes. So a lookup that
 * fails, or a key that no longer decrypts (APP_ENCRYPTION_KEY rotated), answers null — her desk loads, the calls go
 * through the dialler, and she pairs again from the card. Nothing that writes reads this.
 */
export async function deskCallKey(companyId: string, userId: string): Promise<string | null> {
  let row: { callKeyEncrypted: string } | null;
  try {
    row = await db.callHelperDevice.findFirst({
      where: { companyId, userId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { callKeyEncrypted: true },
    });
  } catch {
    return null;
  }
  if (!row) return null;
  try {
    return decryptSecret(row.callKeyEncrypted);
  } catch {
    console.error('[call-helper] the paired phone’s key does not decrypt — the desk falls back to the dialler');
    return null;
  }
}
