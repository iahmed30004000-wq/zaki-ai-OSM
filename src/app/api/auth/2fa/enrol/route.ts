import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { readChallenge } from '@/lib/two-factor-challenge';
import { TwoFactorRefused, completeEnrolment } from '@/lib/two-factor';
import { rateLimitByIp, getClientIp } from '@/lib/rate-limit';
import { logAudit } from '@/lib/audit';
import { gateEnrolment } from '@/lib/enrol-code';
import { enrolCodeRequired } from '@/lib/auth-switches';

/**
 * POST /api/auth/2fa/enrol — prove the authenticator works, then keep it.
 *
 * The recovery codes come back here and NOWHERE ELSE, ever. They are hashed
 * on the way in, so there is nothing left to show a second time — and the
 * screen has to say that before the person closes it.
 *
 * No session is issued: enrolling is not signing in. They go back to the
 * login and use the thing they just set up, which is also the only honest
 * proof that it works on their phone rather than on this page.
 */
export async function POST(req: Request) {
  try {
    const ip = getClientIp(req);
    const rl = rateLimitByIp('2fa:enrol', ip, 12, 5 * 60 * 1000);
    if (!rl.allowed) {
      return NextResponse.json({ error: 'محاولات كثيرة — انتظر قليلاً' }, { status: 429 });
    }

    const { challenge, secret, code, enrolCode } = await req.json().catch(() => ({}));
    const ticket = await readChallenge(challenge, 'enrol');
    if (!ticket) {
      return NextResponse.json({ error: 'انتهت صلاحية الطلب — سجّل الدخول من جديد' }, { status: 401 });
    }
    if (typeof secret !== 'string' || typeof code !== 'string') {
      return NextResponse.json({ error: 'الرمز مطلوب' }, { status: 400 });
    }

    /*
     * THE OWNER'S CODE IS CHECKED AGAIN HERE, AND SPENT HERE (A2). Checking it only at `start` would let a ticket that
     * got a secret finish without one; spending it only after a successful setup means a wrong six digits does not burn
     * the owner's code.
     */
    const row = enrolCodeRequired()
      ? await db.user.findUnique({ where: { id: ticket.userId }, select: { enrolCodeHash: true, enrolCodeExpiresAt: true } })
      : null;
    const gate = await gateEnrolment(ticket.userId, row ?? {}, enrolCode);
    if (!gate.ok) return NextResponse.json({ error: gate.error, code: gate.code }, { status: gate.status });

    const { recoveryCodes } = await db.$transaction(async (tx) => {
      const done = await completeEnrolment(tx, { userId: ticket.userId, secret, code });
      // Spent with the setup, in the same transaction; never touched while the switch is off.
      if (enrolCodeRequired()) {
        await tx.user.update({ where: { id: ticket.userId }, data: { enrolCodeHash: null, enrolCodeExpiresAt: null } });
      }
      return done;
    });

    const user = await db.user.findUnique({
      where: { id: ticket.userId },
      select: { companyId: true, email: true, role: true },
    });
    await logAudit({
      companyId: user?.companyId || 'platform',
      userId: ticket.userId,
      action: 'TWO_FACTOR_ENABLED',
      entity: 'User',
      entityId: ticket.userId,
      // Never the secret and never the codes.
      newData: { email: user?.email, role: user?.role, ip, recoveryCodes: recoveryCodes.length },
    });

    return NextResponse.json({ success: true, recoveryCodes });
  } catch (e: unknown) {
    if (e instanceof TwoFactorRefused) {
      const status = e.code === 'BAD_CODE' ? 400 : e.code === 'ALREADY_ENROLLED' ? 409 : 503;
      return NextResponse.json({ error: e.message, code: e.code }, { status });
    }
    return NextResponse.json({ error: 'تعذّر التفعيل' }, { status: 500 });
  }
}
