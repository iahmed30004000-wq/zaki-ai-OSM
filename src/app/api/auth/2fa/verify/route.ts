import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { readChallenge } from '@/lib/two-factor-challenge';
import { TwoFactorRefused, checkSecondFactor } from '@/lib/two-factor';
import { rateLimit, rateLimitByIp, getClientIp } from '@/lib/rate-limit';
import { issueSession } from '@/lib/sign-in';
import { logAudit } from '@/lib/audit';
import type { UserStatus } from '@/types/auth';

/**
 * POST /api/auth/2fa/verify — the second factor, and then the session.
 *
 * SIX DIGITS ARE A MILLION GUESSES, AND A MILLION IS NOT MANY. A code lives
 * ninety seconds across the accepted window, so an unthrottled endpoint is a
 * few hours of traffic away from being opened by a script. The limit is per
 * user AND per address: per address alone lets a botnet spread the guessing,
 * and per user alone lets one address grind through every account.
 *
 * The session is issued by `issueSession`, the same function the plain login
 * uses — including the `tokenVersion` bump that makes an account work on one
 * device at a time. A second copy of that here is where the bump would one
 * day go missing.
 */
export async function POST(req: Request) {
  try {
    const ip = getClientIp(req);
    const { challenge, code, trustDevice } = await req.json().catch(() => ({}));
    // It arrives from a browser, so it is a yes/no and nothing else.
    const trustThisDevice = trustDevice === true;

    const ticket = await readChallenge(challenge, 'verify');
    if (!ticket) {
      return NextResponse.json({ error: 'انتهت صلاحية الطلب — سجّل الدخول من جديد' }, { status: 401 });
    }

    const rlUser = rateLimit(`2fa:verify:user:${ticket.userId}`, 6, 5 * 60 * 1000);
    const rlIp = rateLimitByIp('2fa:verify:ip', ip, 30, 5 * 60 * 1000);
    if (!rlUser.allowed || !rlIp.allowed) {
      return NextResponse.json(
        { error: `محاولات كثيرة. أعد المحاولة بعد ${Math.max(rlUser.retryAfterSec, rlIp.retryAfterSec)} ثانية` },
        { status: 429 }
      );
    }

    if (typeof code !== 'string' || code.trim() === '') {
      return NextResponse.json({ error: 'الرمز مطلوب' }, { status: 400 });
    }

    const user = await db.user.findUnique({
      where: { id: ticket.userId },
      include: { company: true },
    });
    if (!user) return NextResponse.json({ error: 'المستخدم غير موجود' }, { status: 404 });

    // Re-checked here, not trusted from the login: a ticket is ten minutes
    // long, and an account suspended inside them must not still open.
    const status = user.status as UserStatus;
    if (status === 'SUSPENDED' || status === 'DISABLED') {
      return NextResponse.json({ error: 'الحساب موقوف', status }, { status: 403 });
    }

    let result: { usedRecovery: boolean; recoveryLeft: number };
    try {
      result = await db.$transaction((tx) => checkSecondFactor(tx, { userId: ticket.userId, code }));
    } catch (e: unknown) {
      if (e instanceof TwoFactorRefused) {
        await logAudit({
          companyId: user.companyId || 'platform',
          userId: user.id,
          action: 'TWO_FACTOR_FAILED',
          entity: 'User',
          entityId: user.id,
          newData: { ip, reason: e.code },
        });
        return NextResponse.json({ error: e.message, code: e.code }, { status: 401 });
      }
      throw e;
    }

    /**
     * «لا تطلب الرمز على هذا الجهاز» — ASKED FOR, AND ONLY AFTER PROVING.
     *
     * The box was ticked before the code was typed; the trust is granted
     * only on the far side of `checkSecondFactor`, so a device cannot
     * become trusted by asking to be. It becomes trusted by proving the
     * second factor once.
     *
     * NOT AFTER A RECOVERY CODE, and it is refused twice over: here,
     * because `usedRecovery` is known here, and again inside
     * `issueSession`, which only trusts on a `password+totp` factor. A
     * recovery code means the authenticator was not to hand — which is
     * also what it means when somebody else is holding the account.
     *
     * The cookie is written by `issueSession` and not here: the rule in
     * `two-factor.test.ts` is that neither door writes a cookie of its
     * own, so that the day one of them does, it is not the session cookie
     * going out without the `tokenVersion` bump.
     *
     * `user.totpEnabledAt` is non-null on this line — `checkSecondFactor`
     * refuses with NOT_ENROLLED otherwise, and that returned above.
     */
    const response = await issueSession({
      user,
      remember: ticket.remember,
      ip,
      factor: result.usedRecovery ? 'password+recovery' : 'password+totp',
      trustDevice: trustThisDevice && !result.usedRecovery,
      totpEnabledAt: user.totpEnabledAt,
    });

    if (result.usedRecovery) {
      // Spending a recovery code is a fact worth its own row: it means the
      // authenticator was not to hand, and a run of them is a story.
      await logAudit({
        companyId: user.companyId || 'platform',
        userId: user.id,
        action: 'TWO_FACTOR_RECOVERY_USED',
        entity: 'User',
        entityId: user.id,
        newData: { ip, remaining: result.recoveryLeft },
      });
    }

    return response;
  } catch {
    return NextResponse.json({ error: 'حدث خطأ داخلي' }, { status: 500 });
  }
}
