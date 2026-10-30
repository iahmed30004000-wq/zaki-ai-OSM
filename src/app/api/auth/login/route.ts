import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { db } from '@/lib/db';
import { verifyPassword, verifyDeviceToken } from '@/lib/auth';
import { rateLimit, rateLimitByIp, peekRateLimit, getClientIp } from '@/lib/rate-limit';
import { loginEmailLimitOn } from '@/lib/auth-switches';
import { passwordMatchesNobody } from '@/lib/dummy-password';
import { logAudit } from '@/lib/audit';
import { UserStatus } from '@/types/auth';
import { issueSession } from '@/lib/sign-in';
import { issueChallenge } from '@/lib/two-factor-challenge';
import { stepFor } from '@/lib/two-factor';
import { DEVICE_COOKIE, judgeTrust, noteBadPassword, recentBadPassword } from '@/lib/trusted-device';

/** Wrong passwords one email may collect in the window before the sign-in pauses for it. */
const EMAIL_FAILURES = 20;
const EMAIL_WINDOW_MS = 15 * 60 * 1000;

/** «3 دقائق» or «40 ثانية» — the wait said the way a person says it. */
function waitWords(sec: number): string {
  if (sec < 60) return `${Math.max(1, sec)} ثانية`;
  const minutes = Math.ceil(sec / 60);
  return `${minutes} ${minutes <= 10 ? 'دقائق' : 'دقيقة'}`;
}

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

    /**
     * A CEILING ON WRONG PASSWORDS PER EMAIL, WHATEVER ADDRESS THEY COME FROM (A7).
     *
     * The bucket above is keyed address+email, so a guesser who changes address on every try (a rotating pool, or an IPv6
     * range) never fills it. This one is keyed by the email alone and counts ONLY what went wrong: a right password never
     * uses it up, and it is checked before any password work is done. The window ends by itself, so it is a pause and
     * never a lock; the message says how long. A stranger can make the owner wait this long, no longer, and only by
     * typing wrong passwords against the owner's email, which is the cost of having a limit at all.
     */
    const emailKey = `login:email:${email}`;
    if (loginEmailLimitOn()) {
      const held = peekRateLimit(emailKey, EMAIL_FAILURES);
      if (held.blocked) {
        return NextResponse.json(
          { error: `محاولات دخول خاطئة كثيرة على هذا الحساب. انتظر ${waitWords(held.retryAfterSec)} ثم أعد المحاولة` },
          { status: 429 }
        );
      }
    }
    const failedOnce = () => {
      if (loginEmailLimitOn()) rateLimit(emailKey, EMAIL_FAILURES, EMAIL_WINDOW_MS);
    };

    const user = await db.user.findUnique({
      where: { email },
      include: { company: true },
    });

    if (!user) {
      /*
       * THE SAME WORK AS A REAL ACCOUNT (A4). A known email paid for a password check and an unknown one did not, so the
       * time the answer took told a stranger which emails exist. One check against a hash nobody can match, the same cost.
       */
      await passwordMatchesNobody(password);
      failedOnce();
      return NextResponse.json({ error: 'البريد الإلكتروني أو كلمة المرور غير صحيحة' }, { status: 401 });
    }

    const isMatch = await verifyPassword(password, user.passwordHash);
    if (!isMatch) {
      failedOnce();
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
