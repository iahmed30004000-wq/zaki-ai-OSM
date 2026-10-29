import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { getClientIp, rateLimit, rateLimitByIp } from '@/lib/rate-limit';
import { readChallenge } from '@/lib/two-factor-challenge';
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
 * POST /api/auth/passkey/assert — the fingerprint, in place of the code.
 *
 * IT STANDS WHERE THE SIX DIGITS STAND, AND NOWHERE ELSE. The password has
 * already been accepted — that is what the login ticket in `challenge` IS —
 * and this replaces the typing that follows it. A phone that is picked up
 * is a second factor that is already lost; the password is what keeps a
 * stolen phone from being an open account, and no passkey skips it.
 *
 * THE SESSION IS ISSUED BY `issueSession`, the same function the password
 * login and the code both use — including the `tokenVersion` bump that
 * makes an account work on one device at a time. A third copy of that line
 * here is exactly where the bump would one day go missing.
 *
 * Two shapes, one route: without an assertion it hands out a challenge,
 * with one it checks it. A separate «start» route would be a second place
 * to keep the rate limit and the ticket reading in step.
 */

export async function POST(req: Request) {
  try {
    const ip = getClientIp(req);
    const body = await req.json().catch(() => ({}));
    const ticket = await readChallenge(body?.challenge, 'verify');
    if (!ticket) {
      return NextResponse.json({ error: 'انتهت صلاحية الطلب — سجّل الدخول من جديد' }, { status: 401 });
    }

    /**
     * THE SAME LIMIT THE CODE PATH HAS, and for the same reason: per user
     * AND per address. Per address alone lets a botnet spread the guessing;
     * per user alone lets one address grind through every account.
     */
    const rlUser = rateLimit(`passkey:user:${ticket.userId}`, 10, 5 * 60 * 1000);
    const rlIp = rateLimitByIp('passkey:ip', ip, 30, 5 * 60 * 1000);
    if (!rlUser.allowed || !rlIp.allowed) {
      return NextResponse.json(
        { error: `محاولات كثيرة. أعد المحاولة بعد ${Math.max(rlUser.retryAfterSec, rlIp.retryAfterSec)} ثانية` },
        { status: 429 }
      );
    }

    const rp = relyingParty(publicOrigin(req));
    if (!rp) return NextResponse.json({ error: 'البصمة تحتاج اتصالاً آمناً (HTTPS)' }, { status: 400 });

    // ── Shape one: hand out a challenge and the keys to answer it with ──
    if (!body?.credentialId) {
      const keys = await db.passkey.findMany({
        where: { userId: ticket.userId },
        select: { credentialId: true },
      });
      if (keys.length === 0) return NextResponse.json({ challenge: null, allowCredentials: [] });

      const challenge = newChallenge();
      await db.passkeyChallenge.create({
        data: {
          userId: ticket.userId,
          challenge,
          kind: 'AUTHENTICATE',
          expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
        },
      });
      return NextResponse.json({
        challenge,
        rpId: rp.rpId,
        allowCredentials: keys.map((k) => k.credentialId),
      });
    }

    // ── Shape two: check the signature ──
    const credentialId = String(body.credentialId);
    const credential = await db.passkey.findUnique({
      where: { credentialId },
      select: { id: true, userId: true, publicKey: true, algorithm: true, counter: true },
    });
    /**
     * The key must belong to the person the ticket is for. Without this,
     * anybody's fingerprint would finish anybody's half-done login — the
     * password would have been proved for one account and the second factor
     * for another.
     */
    if (!credential || credential.userId !== ticket.userId) {
      return NextResponse.json({ error: 'هذا المفتاح لا يخصّ هذا الحساب' }, { status: 401 });
    }

    const now = new Date();
    const issued = await db.passkeyChallenge.findFirst({
      where: { userId: ticket.userId, kind: 'AUTHENTICATE', usedAt: null, expiresAt: { gt: now } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, challenge: true },
    });
    if (!issued) return NextResponse.json({ error: 'انتهت صلاحية الطلب — حاول من جديد' }, { status: 400 });
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

    const user = await db.user.findUnique({ where: { id: ticket.userId }, include: { company: true } });
    if (!user) return NextResponse.json({ error: 'المستخدم غير موجود' }, { status: 404 });

    if (!verdict.ok) {
      await logAudit({
        companyId: user.companyId || 'platform',
        userId: user.id,
        action: 'PASSKEY_FAILED',
        entity: 'User',
        entityId: user.id,
        newData: { ip, reason: verdict.code, passkeyId: credential.id },
      });
      return NextResponse.json({ error: REFUSAL_AR[verdict.code], code: verdict.code }, { status: 401 });
    }

    /**
     * Re-checked here, not trusted from the login: a ticket is ten minutes
     * long, and an account suspended inside them must not still open. The
     * same rule the code path holds to.
     */
    const status = user.status as UserStatus;
    if (status === 'SUSPENDED' || status === 'DISABLED') {
      return NextResponse.json({ error: 'الحساب موقوف', status }, { status: 403 });
    }

    await db.passkey.update({
      where: { id: credential.id },
      data: { counter: verdict.counter, lastUsedAt: now },
    });

    return await issueSession({
      user,
      remember: ticket.remember,
      ip,
      factor: 'password+passkey',
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
