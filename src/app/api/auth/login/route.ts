import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { db } from '@/lib/db';
import { verifyPassword, verifyDeviceToken } from '@/lib/auth';
import { rateLimit, rateLimitByIp, getClientIp } from '@/lib/rate-limit';
import { logAudit } from '@/lib/audit';
import { UserStatus } from '@/types/auth';
import { issueSession } from '@/lib/sign-in';
import { issueChallenge } from '@/lib/two-factor-challenge';
import { stepFor } from '@/lib/two-factor';
import { DEVICE_COOKIE, judgeTrust, noteBadPassword, recentBadPassword } from '@/lib/trusted-device';

export async function POST(req: Request) {
  try {
    const ip = getClientIp(req);
    const { email: rawEmail, password, remember } = await req.json().catch(() => ({}));

    if (!rawEmail || !password) {
      return NextResponse.json({ error: 'البريد الإلكتروني وكلمة المرور مطلوبان' }, { status: 400 });
    }

    const email = String(rawEmail).toLowerCase().trim();

    // Brute-force protection: 8 attempts / 5 min per IP+email, 20 per IP
    const rlUser = rateLimit(`login:user:${ip}:${email}`, 8, 5 * 60 * 1000);
    const rlIp = rateLimitByIp('login:ip', ip, 20, 5 * 60 * 1000);
    if (!rlUser.allowed || !rlIp.allowed) {
      return NextResponse.json(
        { error: `محاولات دخول كثيرة. أعد المحاولة بعد ${Math.max(rlUser.retryAfterSec, rlIp.retryAfterSec)} ثانية` },
        { status: 429 }
      );
    }

    const user = await db.user.findUnique({
      where: { email },
      include: { company: true },
    });

    if (!user) {
      return NextResponse.json({ error: 'البريد الإلكتروني أو كلمة المرور غير صحيحة' }, { status: 401 });
    }

    const isMatch = await verifyPassword(password, user.passwordHash);
    if (!isMatch) {
      // Remembered for a quarter of an hour, and it is what makes a trusted
      // device ask for the six digits anyway. Noted AFTER the account was
      // found, so a wrong email cannot be used to make a stranger's login
      // stricter.
      noteBadPassword(email);
      return NextResponse.json({ error: 'البريد الإلكتروني أو كلمة المرور غير صحيحة' }, { status: 401 });
    }

    const status = user.status as UserStatus;

    if (status === 'SUSPENDED' || status === 'DISABLED') {
      return NextResponse.json(
        {
          error:
            status === 'SUSPENDED'
              ? 'تم إيقاف حسابك مؤقتاً. تواصل مع المدير'
              : 'تم تعطيل حسابك. تواصل مع المدير',
          status,
        },
        { status: 403 }
      );
    }

    /**
     * THE PASSWORD IS THE FIRST FACTOR. FOR FIVE ROLES IT IS NO LONGER THE LAST.
     *
     * Nothing is issued and NOTHING IS CHANGED here — no session, and in
     * particular no `tokenVersion` bump. Bumping it now would mean a stolen
     * password alone could sign an owner out of the device they are working
     * on, repeatedly, without ever getting in.
     *
     * A protected role that has not enrolled yet is not turned away either:
     * on the morning this ships nobody is enrolled, and an owner locked out
     * of their own business is how a second factor gets switched off for
     * everyone. They get an enrolment challenge instead, which grants
     * nothing but the two endpoints that set it up.
     */
    const step = stepFor({ role: user.role, totpEnabledAt: user.totpEnabledAt });
    if (step === 'verify') {
      /**
       * A DEVICE THAT ALREADY PROVED THE SECOND FACTOR DOES NOT PROVE IT
       * AGAIN — «بس اذا صار نشاط مشبوه يطلبو».
       *
       * The password has just been accepted; this decides only whether the
       * SIX DIGITS are also asked for. Somebody holding this device without
       * the password never reached this line.
       *
       * The verdict is a pure function in `trusted-device.ts`, and its
       * `why` goes on the audit row: a sign-in that skipped the code must
       * say so, and one that was asked must say what asked for it.
       */
      const verdict = judgeTrust({
        claims: await verifyDeviceToken((await cookies()).get(DEVICE_COOKIE)?.value),
        user: { id: user.id, totpEnabledAt: user.totpEnabledAt },
        suspicious: recentBadPassword(email),
      });

      if (verdict.trusted) {
        return issueSession({ user, remember: !!remember, ip, factor: 'password+device' });
      }

      const challenge = await issueChallenge({ userId: user.id, purpose: step, remember: !!remember });
      return NextResponse.json({
        twoFactor: step,
        challenge,
        email: user.email,
        // The screen says WHY the code is being asked for. «نشاطٌ غير
        // معتاد» after a wrong password is the difference between a
        // person trusting the measure and a person thinking it is broken.
        askedBecause: verdict.why,
      });
    }

    if (step === 'enrol') {
      const challenge = await issueChallenge({ userId: user.id, purpose: step, remember: !!remember });
      return NextResponse.json({
        twoFactor: step,
        challenge,
        email: user.email,
      });
    }

    return issueSession({ user, remember: !!remember, ip, factor: 'password' });
  } catch (error: any) {
    console.error('Login error:', error);
    return NextResponse.json({ error: 'حدث خطأ داخلي. حاول مرة أخرى' }, { status: 500 });
  }
}
