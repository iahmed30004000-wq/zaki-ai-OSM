import { db } from '../db';
import { sessionUserFor } from '../auth';
import { encryptSecret } from '../secrets';
import type { SessionUser } from '@/types/auth';
import { bearerOf, newSecret, sha256Hex } from './core';

/**
 * «مساعد الاتصال» — THE TWO DOORS A PHONE COMES IN BY, WITH NO COOKIE.
 *
 * The app has no session: it is a separate program on her phone. So it proves itself the way a courier or another
 * system does — a token at the door is still a door (`every-route-asks-who` lists both names below beside
 * `requireSystemToken`):
 *
 *   · `redeemPairCode` — the one-time code in the pairing link IS the credential, once, for ten minutes, for an ACTIVE
 *     person. It returns a token and a callKey; the token is kept only as its SHA-256.
 *   · `requireCallHelperDevice` — the bearer token of a paired phone: not revoked, its person ACTIVE and still of the
 *     device's company. It returns that person as the SessionUser her browser would have, so every door asked after it
 *     answers exactly as it would for her.
 *
 * The company always comes from the stored row, never from the request.
 */

export interface CallHelperCaller {
  deviceId: string;
  companyId: string;
  user: SessionUser;
}

/** The paired phone behind this request, or null — and null is the 401 that tells the app to forget its pairing. */
export async function requireCallHelperDevice(req: Request): Promise<CallHelperCaller | null> {
  const token = bearerOf(req);
  if (!token) return null;
  const device = await db.callHelperDevice.findUnique({
    where: { tokenHash: sha256Hex(token) },
    select: { id: true, companyId: true, userId: true, revokedAt: true },
  });
  if (!device || device.revokedAt) return null;
  const user = await sessionUserFor(device.userId);
  if (!user || user.status !== 'ACTIVE') return null;
  // A person moved to another company does not carry the phone with her.
  if (user.role !== 'SUPER_ADMIN' && user.companyId !== device.companyId) return null;
  return { deviceId: device.id, companyId: device.companyId, user };
}

export type PairOutcome =
  | { ok: true; token: string; callKey: string; userName: string }
  | { ok: false; status: number; error: string };

export const PAIR_CODE_DEAD = 'رمز الربط خلص أو انستعمل — افتحي «طلباتي» واضغطي «اربط هذا التلفون» من جديد.';
export const PAIR_USER_INACTIVE = 'الحساب مش فعّال — راجعي المسؤول.';

/**
 * SPEND THE CODE, ONCE, AND PAIR THE PHONE.
 *
 * In one transaction, under a lock on her user row: the code is stamped used ONLY IF it is still unused and unexpired (a conditional update, so two
 * presses of «اربط» racing each other pair once), every earlier device of hers is stamped revoked (one active phone per
 * person — the old phone's next reading is a 401 and it forgets the pairing), and the new device is written with the
 * token's hash and the callKey encrypted.
 */
export async function redeemPairCode(code: string, deviceName: string, now: Date = new Date()): Promise<PairOutcome> {
  const codeHash = sha256Hex(code);
  const row = await db.callHelperPairCode.findUnique({
    where: { codeHash },
    select: { id: true, companyId: true, userId: true, expiresAt: true, usedAt: true },
  });
  if (!row || row.usedAt || row.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, status: 400, error: PAIR_CODE_DEAD };
  }
  const user = await db.user.findUnique({ where: { id: row.userId }, select: { name: true, status: true, companyId: true, role: true } });
  if (!user || user.status !== 'ACTIVE' || (user.role !== 'SUPER_ADMIN' && user.companyId !== row.companyId)) {
    return { ok: false, status: 403, error: PAIR_USER_INACTIVE };
  }

  const token = newSecret();
  const callKey = newSecret();
  const callKeyEncrypted = encryptSecret(callKey);

  const paired = await db.$transaction(async (tx) => {
    // HER ROW, LOCKED FOR THE PAIRING: two different codes of hers redeemed in the same instant would each revoke the
    // devices they saw and each write one — two active phones. The second waits here and then revokes the first's.
    await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${row.userId} FOR UPDATE`;
    const spent = await tx.callHelperPairCode.updateMany({
      where: { id: row.id, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (spent.count !== 1) return false;
    await tx.callHelperDevice.updateMany({
      where: { userId: row.userId, revokedAt: null },
      data: { revokedAt: now },
    });
    await tx.callHelperDevice.create({
      data: {
        companyId: row.companyId,
        userId: row.userId,
        deviceName,
        tokenHash: sha256Hex(token),
        callKeyEncrypted,
        lastSeenAt: now,
      },
    });
    return true;
  });
  if (!paired) return { ok: false, status: 400, error: PAIR_CODE_DEAD };
  return { ok: true, token, callKey, userName: user.name };
}
