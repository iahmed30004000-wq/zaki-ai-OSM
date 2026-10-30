import { NextResponse } from 'next/server';
import QRCode from 'qrcode';
import { db } from '@/lib/db';
import { readChallenge } from '@/lib/two-factor-challenge';
import { TwoFactorRefused, beginEnrolment } from '@/lib/two-factor';
import { rateLimitByIp, getClientIp } from '@/lib/rate-limit';
import { enrolCodeSelect, enrolColumnsOf, gateEnrolment } from '@/lib/enrol-code';

/**
 * POST /api/auth/2fa/start — hand out a secret to scan.
 *
 * Reachable only with an ENROL challenge, which the login issues to a
 * protected role that has none yet. The secret is returned and NOT saved:
 * it becomes real in `/enrol`, when the person proves they scanned it. A
 * secret saved before that would leave an account half-enrolled if the QR
 * never rendered — locked out by a broken image.
 */
export async function POST(req: Request) {
  try {
    const ip = getClientIp(req);
    const rl = rateLimitByIp('2fa:start', ip, 10, 5 * 60 * 1000);
    if (!rl.allowed) {
      return NextResponse.json({ error: 'محاولات كثيرة — انتظر قليلاً' }, { status: 429 });
    }

    const { challenge, enrolCode } = await req.json().catch(() => ({}));
    const ticket = await readChallenge(challenge, 'enrol');
    if (!ticket) {
      return NextResponse.json({ error: 'انتهت صلاحية الطلب — سجّل الدخول من جديد' }, { status: 401 });
    }

    const user = await db.user.findUnique({
      where: { id: ticket.userId },
      select: { email: true, totpEnabledAt: true, ...enrolCodeSelect() },
    });
    if (!user) return NextResponse.json({ error: 'المستخدم غير موجود' }, { status: 404 });
    if (user.totpEnabledAt) {
      return NextResponse.json({ error: 'التحقّق الثنائيّ مفعَّل أصلاً' }, { status: 409 });
    }

    // With the owner's code switched on, no secret is handed out before the code is right (A2).
    const gate = await gateEnrolment(ticket.userId, enrolColumnsOf(user), enrolCode);
    if (!gate.ok) return NextResponse.json({ error: gate.error, code: gate.code }, { status: gate.status });

    const { secret, uri } = beginEnrolment(user.email);
    // Drawn on the server: the URI carries the secret, and a client-side
    // generator would be one more place it could be logged.
    // The quiet zone is part of the CODE, not of the box around it: the
    // library draws it white inside the image, which is what a scanner
    // needs and what a dark theme must not be allowed to tint. A `bg-white`
    // wrapper did the same job with a hardcoded colour, and `one-palette`
    // was right to refuse it.
    const qr = await QRCode.toDataURL(uri, { margin: 3, width: 240 });

    return NextResponse.json({ secret, uri, qr });
  } catch (e: unknown) {
    if (e instanceof TwoFactorRefused) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: 503 });
    }
    return NextResponse.json({ error: 'تعذّر بدء التفعيل' }, { status: 500 });
  }
}
