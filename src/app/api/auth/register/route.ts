import { NextResponse } from 'next/server';
import { z } from 'zod';
import { PASSWORD_MAX, checkPassword } from '@/lib/password-rules';
import { db } from '@/lib/db';
import { hashPassword } from '@/lib/auth';
import { rateLimit, getClientIp } from '@/lib/rate-limit';
import { logAudit } from '@/lib/audit';
import { selfSignupOn } from '@/lib/auth-switches';
import { mayBootstrapOwner } from '@/lib/bootstrap-owner';

const registerSchema = z
  .object({
    fullName: z
      .string()
      .trim()
      .min(3, 'الاسم يجب أن يكون 3 أحرف على الأقل')
      .max(80, 'الاسم طويل جداً'),
    email: z.string().trim().toLowerCase().email('صيغة البريد الإلكتروني غير صحيحة'),
    password: z.string().max(PASSWORD_MAX).superRefine(checkPassword),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'كلمتا المرور غير متطابقتين',
    path: ['confirmPassword'],
  });

export async function POST(req: Request) {
  try {
    // Rate limiting: 5 registrations per IP per hour (brute-force / spam protection)
    const ip = getClientIp(req);
    const rl = rateLimit(`register:${ip}`, 5, 60 * 60 * 1000);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: `محاولات كثيرة. أعد المحاولة بعد ${rl.retryAfterSec} ثانية` },
        { status: 429 }
      );
    }

    const body = await req.json().catch(() => null);
    if (!body) {
      return NextResponse.json({ error: 'طلب غير صالح' }, { status: 400 });
    }

    /**
     * THE DOOR IS SHUT UNLESS THE OWNER OPENED IT (A4, D7).
     *
     * Self sign-up is off by default: a stranger who can register an account can fill the approval list, probe the
     * system and wait for a manager to tick the wrong box. The one thing that still works with the door shut is the
     * owner's own bootstrap (A3), and only while there is no owner. The answer is the same for every shut case, and it
     * is given before the body is judged, so it says nothing about which emails exist.
     */
    const askedEmail = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const configuredEmail = process.env.INITIAL_SUPER_ADMIN_EMAIL;
    const bootstrap =
      askedEmail !== '' &&
      mayBootstrapOwner({
        configuredEmail,
        email: askedEmail,
        superAdminCount: (configuredEmail ?? '').trim() === '' ? 1 : await db.user.count({ where: { role: 'SUPER_ADMIN' } }),
      });
    if (!selfSignupOn() && !bootstrap) {
      return NextResponse.json(
        { error: 'التسجيل الذاتي مغلق. اطلب من المدير أن ينشئ لك حساباً' },
        { status: 403 }
      );
    }

    // Server-side Zod validation — role/status are NEVER accepted from the client
    const parsed = registerSchema.safeParse(body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return NextResponse.json({ error: first?.message || 'بيانات غير صالحة' }, { status: 400 });
    }

    const { fullName, email, password } = parsed.data;

    /*
     * THE SAME WORK AND THE SAME ANSWER, WHETHER THE EMAIL IS NEW OR NOT (A4).
     *
     * The hash is made BEFORE the lookup, so a taken email does not answer faster than a free one, and a taken email gets
     * the very body a new one gets: «هذا البريد مسجل مسبقاً» (409) told a stranger which emails have accounts. Nothing is
     * created for a taken email, and the real owner of it learns nothing from a stranger's attempt.
     */
    const passwordHash = await hashPassword(password);
    const isInitialSuperAdmin = bootstrap && email === askedEmail;
    const answer = () =>
      NextResponse.json({
        success: true,
        status: isInitialSuperAdmin ? 'ACTIVE' : 'PENDING',
        role: isInitialSuperAdmin ? 'SUPER_ADMIN' : 'PENDING_USER',
        signIn: true,
        message: isInitialSuperAdmin
          ? 'تم إنشاء حساب المدير الأعلى بنجاح — سجّل دخولك الآن'
          : 'استلمنا طلبك. إن كان البريد جديداً فحسابك الآن بانتظار موافقة المدير',
      });

    const existing = await db.user.findUnique({ where: { email }, select: { id: true } });
    if (existing) return answer();

    const user = await db.user.create({
      data: {
        email,
        name: fullName,
        passwordHash,
        // Default: no permissions, no company, awaiting admin approval.
        // A client can never reach this endpoint and self-assign a role.
        role: isInitialSuperAdmin ? 'SUPER_ADMIN' : 'PENDING_USER',
        status: isInitialSuperAdmin ? 'ACTIVE' : 'PENDING',
      },
    });

    await logAudit({
      companyId: user.companyId || 'platform',
      userId: user.id,
      action: isInitialSuperAdmin ? 'INITIAL_SUPER_ADMIN_CREATED' : 'USER_REGISTERED',
      entity: 'User',
      entityId: user.id,
      newData: {
        email: user.email,
        name: user.name,
        role: user.role,
        status: user.status,
      },
    });

    /*
     * ── NO SESSION IS CREATED HERE EITHER ──
     *
     * Registering used to sign a token and set the cookie. That is a way
     * into the system that never passes `stepFor`, and now that every
     * account carries a second factor it would be the way around it: a
     * brand-new account is precisely one with `totpEnabledAt` null, which
     * is what `enrol` exists for.
     *
     * The very first SUPER_ADMIN matters most here, not least: the account
     * that can do everything must not be the one account that got in
     * without enrolling.
     */
    return answer();
  } catch (error: any) {
    if (error?.code === 'P2002') {
      // Two requests for one new email raced: the second is a taken email, and a taken email gets the neutral answer.
      return NextResponse.json({
        success: true,
        status: 'PENDING',
        role: 'PENDING_USER',
        signIn: true,
        message: 'استلمنا طلبك. إن كان البريد جديداً فحسابك الآن بانتظار موافقة المدير',
      });
    }
    console.error('Register error:', error);
    return NextResponse.json({ error: 'حدث خطأ داخلي. حاول مرة أخرى' }, { status: 500 });
  }
}
