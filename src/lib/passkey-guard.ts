import { db } from './db';
import { verifyPassword } from './auth';
import { rateLimit } from './rate-limit';
import { TwoFactorRefused, checkSecondFactor } from './two-factor';
import { passkeyStepUpOn, passkeyWipeOn } from './auth-switches';

/**
 * THE TWO GUARDS AROUND A FINGERPRINT (A1).
 *
 * A fingerprint is a way into an account that outlives the session that added it. Two things were missing:
 *
 *  1. ADDING ONE ONLY NEEDED A SESSION. Whoever held a stolen session (an unlocked laptop, a copied cookie) could bolt a
 *     permanent key onto the account, keep it after the password changed, and walk in later without the second factor,
 *     because a passkey stands in for the six digits. `checkStepUp` asks for what a stolen session does not have: the
 *     CURRENT password, or a fresh six-digit code from the authenticator.
 *
 *  2. NOTHING TOOK THEM BACK. Resetting a password, resetting the second factor, suspending or disabling an account, or
 *     signing it out everywhere all ended the sessions and left the fingerprints working. `wipePasskeys` removes the keys
 *     and their open challenges in the same transaction as the change that made them untrustworthy.
 *
 * Both are switchable (`AUTH_PASSKEY_STEP_UP`, `AUTH_PASSKEY_WIPE`, see auth-switches.ts). Neither touches the way in of
 * somebody who signs in the way they always did: password, and the six digits.
 */

export type StepUp = { ok: true } | { ok: false; status: number; error: string };

const ATTEMPTS = 8;
const WINDOW_MS = 5 * 60 * 1000;

export async function checkStepUp(input: {
  userId: string;
  status: string;
  password?: unknown;
  code?: unknown;
}): Promise<StepUp> {
  if (input.status !== 'ACTIVE') return { ok: false, status: 403, error: 'الحساب غير مفعّل' };
  if (!passkeyStepUpOn()) return { ok: true };

  const password = typeof input.password === 'string' ? input.password : '';
  const digits = typeof input.code === 'string' ? input.code.replace(/\D/g, '') : '';
  if (!password && digits.length !== 6) {
    return { ok: false, status: 400, error: 'اكتب كلمة المرور الحالية لتضيف بصمة' };
  }

  const rl = rateLimit(`passkey:stepup:${input.userId}`, ATTEMPTS, WINDOW_MS);
  if (!rl.allowed) {
    return { ok: false, status: 429, error: `محاولات كثيرة. أعد المحاولة بعد ${rl.retryAfterSec} ثانية` };
  }

  if (password) {
    const row = await db.user.findUnique({ where: { id: input.userId }, select: { passwordHash: true } });
    if (row && (await verifyPassword(password, row.passwordHash))) return { ok: true };
    return { ok: false, status: 401, error: 'كلمة المرور غير صحيحة' };
  }

  try {
    await checkSecondFactor(db, { userId: input.userId, code: digits });
    return { ok: true };
  } catch (e) {
    if (e instanceof TwoFactorRefused) return { ok: false, status: 401, error: 'الرمز غير صحيح' };
    throw e;
  }
}

interface PasskeyTables {
  passkey: { deleteMany: (args: { where: { userId: string } }) => Promise<{ count: number }> };
  passkeyChallenge: { deleteMany: (args: { where: { userId: string } }) => Promise<{ count: number }> };
}

/** Removes a person's fingerprints and their open challenges. Returns how many keys went; 0 when the switch is off. */
export async function wipePasskeys(tx: PasskeyTables, userId: string): Promise<number> {
  if (!passkeyWipeOn()) return 0;
  const keys = await tx.passkey.deleteMany({ where: { userId } });
  await tx.passkeyChallenge.deleteMany({ where: { userId } });
  return keys.count;
}
