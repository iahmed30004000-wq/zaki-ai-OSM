import { NextResponse } from 'next/server';
import { z } from 'zod';
import { PASSWORD_MAX, checkPassword } from '@/lib/password-rules';
import { db } from '@/lib/db';
import { hashPassword } from '@/lib/auth';
import { rateLimit, getClientIp } from '@/lib/rate-limit';
import { storedForm } from '@/lib/reset-token';
import { UserRole, UserStatus, ROLE_PERMISSIONS } from '@/types/auth';
import { zodMessage } from '@/lib/zod-message';
import { wipePasskeys } from '@/lib/passkey-guard';

const resetSchema = z
  .object({
    token: z.string().min(10),
    password: z.string().max(PASSWORD_MAX).superRefine(checkPassword),
    confirmPassword: z.string(),
  })
  .refine((d) => d.password === d.confirmPassword, {
    message: 'كلمتا المرور غير متطابقتين',
    path: ['confirmPassword'],
  });

export async function POST(req: Request) {
  try {
    const ip = getClientIp(req);
    const rl = rateLimit(`reset:${ip}`, 8, 15 * 60 * 1000);
    if (!rl.allowed) {
      return NextResponse.json({ error: `محاولات كثيرة. أعد المحاولة بعد ${rl.retryAfterSec} ثانية` }, { status: 429 });
    }

    const body = await req.json().catch(() => null);
    const parsed = resetSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: zodMessage(parsed.error) },
        { status: 400 }
      );
    }

    const { token, password } = parsed.data;

    // The column holds a hash, so the link is hashed to look it up. A
    // reader of the database therefore learns nothing they can use.
    const user = await db.user.findFirst({
      where: {
        resetToken: storedForm(token),
        resetTokenExpires: { gt: new Date() },
      },
    });

    if (!user) {
      return NextResponse.json(
        { error: 'رابط إعادة التعيين غير صالح أو منتهي الصلاحية' },
        { status: 400 }
      );
    }

    const passwordHash = await hashPassword(password);

    // Bump tokenVersion: invalidates every existing session for this user
    // The fingerprints go with the sessions (A1): whoever held the old password may have added one.
    const updated = await db.$transaction(async (tx) => {
      const row = await tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          resetToken: null,
          resetTokenExpires: null,
          tokenVersion: { increment: 1 },
        },
      });
      await wipePasskeys(tx, user.id);
      return row;
    });

    /*
     * ── NO SESSION IS CREATED HERE ──
     *
     * This door used to sign a session token and set the cookie itself:
     * «Auto-login after successful reset». That is a login that never
     * passes `stepFor`, so whoever came through it was inside with a
     * password alone — and now that every account carries a second
     * factor, this would have been the one way around all of them.
     *
     * Anybody who holds a reset link holds the password; the second
     * factor is the half that says they are also the person. So the reset
     * ends at the login screen, where both halves are asked.
     */

    await (await import('@/lib/audit')).logAudit({
      companyId: updated.companyId || 'platform',
      userId: updated.id,
      action: 'PASSWORD_RESET_COMPLETED',
      entity: 'User',
      entityId: updated.id,
      newData: { email: updated.email, allSessionsInvalidated: true },
    });

    // `signIn: true` tells the screen to send them to the login page —
    // the password changed, and the second factor is still owed.
    return NextResponse.json({ success: true, status: updated.status, signIn: true });
  } catch (e: any) {
    console.error('Reset password error:', e);
    return NextResponse.json({ error: 'حدث خطأ داخلي' }, { status: 500 });
  }
}
