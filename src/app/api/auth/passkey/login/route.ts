import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { rateLimit, rateLimitByIp, getClientIp } from '@/lib/rate-limit';
import { issueSession } from '@/lib/sign-in';
import type { UserStatus } from '@/types/auth';
import {
  CHALLENGE_TTL_MS,
  REFUSAL_AR,
  newChallenge,
  publicOrigin,
  relyingParty,
  verifyAssertion,
} from '@/lib/passkey';

/**
 * POST /api/auth/passkey/login — SIGNING IN WITH THE FINGERPRINT ALONE.
 *
 * This is the door, not the second lock on it. `/assert` stands where the
 * six digits stand, after a password; this one replaces the whole typing:
 * the browser finds a key stored on the device, the device asks for the
 * finger or the face, and the signature names the account.
 *
 * WHY THAT IS NOT WEAKER THAN A PASSWORD. A passkey cannot be typed into
 * the wrong site — the signature covers the origin, so a copy of this
 * login page on another domain gets nothing. It cannot be reused, guessed
 * or read out of a breach: what we store is a PUBLIC key. And it is two
 * factors on its own — the device is the thing you have, and
 * `userVerification: 'required'` means the device would not sign without
 * the thing you are. A picked-up phone signs nothing.
 *
 * WHAT IT STILL REFUSES. A suspended or disabled account, a signature
 * whose counter did not advance (the mark of a cloned key), a challenge
 * that was already spent, and anything at all over plain HTTP.
 *
 * Two shapes, one route, for the same reason `/assert` has two: a separate
 * «start» endpoint is a second place to keep the rate limit in step.
 */

export async function POST(req: Request) {
  try {
    const ip = getClientIp(req);
    const body = await req.json().catch(() => ({}));

    const rp = relyingParty(publicOrigin(req));
    if (!rp) {
      return NextResponse.json(
        { error: 'الدخول بالبصمة يحتاج اتصالاً آمناً (HTTPS)', code: 'INSECURE_CONTEXT' },
        { status: 400 }
      );
    }

    /**
     * BY ADDRESS ONLY, because nobody has said who they are yet. The
     * per-account limit lives in the branch below, once the signature has
     * named an account.
     */
    const rl = rateLimitByIp('passkey-login', ip, 20, 5 * 60 * 1000);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: `محاولات كثيرة. أعد المحاولة بعد ${rl.retryAfterSec} ثانية` },
        { status: 429 }
      );
    }

    // ── Shape one: a challenge, belonging to nobody yet ──
    if (!body?.credentialId) {
      const challenge = newChallenge();
      await db.passkeyChallenge.create({
        data: {
          userId: null,
          challenge,
          kind: 'LOGIN',
          expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
        },
      });
      // No allowCredentials: the browser offers whatever keys for this site
      // the device holds. That list is exactly what makes the login
      // passwordless, and it is the device's to know, not ours.
      return NextResponse.json({ challenge, rpId: rp.rpId });
    }

    // ── Shape two: a signature that names its own account ──
    const credentialId = String(body.credentialId);
    const credential = await db.passkey.findUnique({
      where: { credentialId },
      select: { id: true, userId: true, publicKey: true, algorithm: true, counter: true },
    });
    if (!credential) {
      // Deliberately the same words a bad signature gets: which keys exist
      // is not something an unauthenticated caller may learn.
      return NextResponse.json({ error: 'تعذّر التحقّق من البصمة' }, { status: 401 });
    }

    const rlUser = rateLimit(`passkey:user:${credential.userId}`, 10, 5 * 60 * 1000);
    if (!rlUser.allowed) {
      return NextResponse.json(
        { error: `محاولات كثيرة. أعد المحاولة بعد ${rlUser.retryAfterSec} ثانية` },
        { status: 429 }
      );
    }

    const now = new Date();
    const sent = String(body.challenge ?? '');
    const issued = sent
      ? await db.passkeyChallenge.findFirst({
          where: { challenge: sent, kind: 'LOGIN', usedAt: null, expiresAt: { gt: now } },
          select: { id: true, challenge: true },
        })
      : null;
    if (!issued) return NextResponse.json({ error: 'انتهت صلاحية الطلب — حاول من جديد' }, { status: 400 });

    // Spent once, conditionally: two requests carrying the same signature
    // cannot both become a session.
    const spent = await db.passkeyChallenge.updateMany({
      where: { id: issued.id, usedAt: null },
      data: { usedAt: now },
    });
    if (spent.count !== 1) {
      return NextResponse.json({ error: 'انتهت صلاحية الطلب — حاول من جديد' }, { status: 400 });
    }

    const verdict = verifyAssertion({
      authenticatorData: String(body.authenticatorData ?? ''),
      clientDataJSON: String(body.clientDataJSON ?? ''),
      signature: String(body.signature ?? ''),
      credential,
      expected: { challenge: issued.challenge, origin: rp.origin, rpId: rp.rpId },
    });

    const user = await db.user.findUnique({ where: { id: credential.userId }, include: { company: true } });
    if (!user) return NextResponse.json({ error: 'تعذّر التحقّق من البصمة' }, { status: 401 });

    if (!verdict.ok) {
      await logAudit({
        companyId: user.companyId || 'platform',
        userId: user.id,
        action: 'PASSKEY_FAILED',
        entity: 'User',
        entityId: user.id,
        newData: { ip, reason: verdict.code, passkeyId: credential.id, at: 'login' },
      });
      return NextResponse.json({ error: REFUSAL_AR[verdict.code], code: verdict.code }, { status: 401 });
    }

    const status = user.status as UserStatus;
    if (status === 'SUSPENDED' || status === 'DISABLED') {
      return NextResponse.json({ error: 'الحساب موقوف', status }, { status: 403 });
    }
    if (status === 'PENDING') {
      return NextResponse.json({ error: 'حسابك بانتظار موافقة المدير', status }, { status: 403 });
    }

    await db.passkey.update({
      where: { id: credential.id },
      data: { counter: verdict.counter, lastUsedAt: now },
    });

    /**
     * `remember` is the browser's to ask for and ours to honour, exactly as
     * on the password form. The session itself is issued by the one
     * function every door uses — including its `tokenVersion` bump.
     *
     * ── AND NO SECOND FACTOR IS ASKED FOR, BECAUSE THIS WAS ONE ──
     *
     * Every account now carries a second factor, and `stepFor` is what the
     * PASSWORD door asks. This door does not, and that is not a gap in the
     * rule — it is the rule being satisfied by a different means.
     *
     * A TOTP code proves possession of an enrolled phone. A passkey proves
     * possession of a key held in this device's secure hardware, and the
     * signature just verified is that proof. Sending somebody who signed
     * with a passkey on to type a six-digit code would be asking them to
     * prove possession twice, and the usual answer to that is that people
     * stop using the stronger one.
     *
     * `factor: 'passkey'` records which half was shown, so the audit can
     * tell the two entrances apart.
     */
    return await issueSession({
      user,
      remember: body?.remember === true,
      ip,
      factor: 'passkey',
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
