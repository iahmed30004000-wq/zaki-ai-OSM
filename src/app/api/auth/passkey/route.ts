import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { CHALLENGE_TTL_MS, newChallenge, publicOrigin, relyingParty } from '@/lib/passkey';
import { checkStepUp } from '@/lib/passkey-guard';

/**
 * GET    /api/auth/passkey — the keys I have registered.
 * POST   /api/auth/passkey — start registering one: here is a challenge.
 * DELETE /api/auth/passkey?id= — forget one.
 *
 * REGISTRATION IS A SIGNED-IN ACT. Adding a way into an account is not
 * something the way in should be able to do: you prove who you are the old
 * way — password, and the code if your role needs one — and only then may
 * you add a finger. Otherwise anybody holding a stolen session could bolt a
 * permanent key onto the account and keep it after the password changed.
 */

export async function GET() {
  try {
    const me = await getCurrentUser();
    if (!me) return NextResponse.json({ error: 'غير مسجَّل الدخول' }, { status: 401 });

    const keys = await db.passkey.findMany({
      where: { userId: me.id },
      // Never the public key: the screen has no use for it, and a field
      // that is not sent is a field that cannot be logged by accident.
      select: { id: true, label: true, createdAt: true, lastUsedAt: true },
      orderBy: { createdAt: 'desc' },
    });
    return NextResponse.json({ keys });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return NextResponse.json({ error: 'غير مسجَّل الدخول' }, { status: 401 });

    const rp = relyingParty(publicOrigin(req));
    if (!rp) {
      return NextResponse.json(
        { error: 'البصمة تحتاج اتصالاً آمناً (HTTPS)', code: 'INSECURE_CONTEXT' },
        { status: 400 }
      );
    }

    /**
     * THE SESSION IS NOT ENOUGH TO ADD A WAY IN (A1).
     *
     * The password (or a fresh six-digit code) is asked for here, at the START: a challenge only exists for somebody who
     * passed it, and `register` accepts nothing but an unspent challenge, so the finish needs no second question.
     */
    const body = await req.json().catch(() => null);
    const stepUp = await checkStepUp({ userId: me.id, status: me.status, password: body?.password, code: body?.code });
    if (!stepUp.ok) return NextResponse.json({ error: stepUp.error, code: 'STEP_UP' }, { status: stepUp.status });

    const challenge = newChallenge();
    await db.passkeyChallenge.create({
      data: {
        userId: me.id,
        challenge,
        kind: 'REGISTER',
        expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
      },
    });

    // The credentials already on file, so the browser refuses to enrol the
    // same finger twice rather than creating a second row nobody can tell
    // apart from the first.
    const existing = await db.passkey.findMany({
      where: { userId: me.id },
      select: { credentialId: true },
    });

    return NextResponse.json({
      challenge,
      rp: { id: rp.rpId, name: 'Zaki AI OMS' },
      user: { id: me.id, name: me.email, displayName: me.name ?? me.email },
      excludeCredentials: existing.map((e) => e.credentialId),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(req: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return NextResponse.json({ error: 'غير مسجَّل الدخول' }, { status: 401 });

    const id = new URL(req.url).searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'أيُّ مفتاح؟' }, { status: 400 });

    // Scoped to the session's own id: there is no way to name somebody
    // else's key, so there is no way to remove one.
    const gone = await db.passkey.deleteMany({ where: { id, userId: me.id } });
    if (gone.count === 0) return NextResponse.json({ error: 'المفتاح غير موجود' }, { status: 404 });

    await logAudit({
      companyId: me.companyId || 'platform',
      userId: me.id,
      action: 'PASSKEY_REMOVED',
      entity: 'User',
      entityId: me.id,
      newData: { passkeyId: id },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
