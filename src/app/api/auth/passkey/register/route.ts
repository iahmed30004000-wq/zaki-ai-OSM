import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { REFUSAL_AR, publicOrigin, relyingParty, verifyRegistration } from '@/lib/passkey';
import { numeric } from '@/lib/numeric-input';

/**
 * POST /api/auth/passkey/register — finish registering a fingerprint.
 *
 * WHAT IS STORED IS PUBLIC. The browser hands over the SPKI public key
 * itself; there is no secret here and nothing to encrypt. A copy of the
 * table lets somebody verify a signature and never lets them make one.
 *
 * The challenge is spent in the same statement that finds it — two people
 * answering one challenge is exactly the race a replay is.
 */

export async function POST(req: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return NextResponse.json({ error: 'غير مسجَّل الدخول' }, { status: 401 });

    // An account that is suspended, disabled or still pending adds no way in (A1). The step-up itself was asked when the
    // challenge was issued; this door accepts nothing without one.
    if (me.status !== 'ACTIVE') return NextResponse.json({ error: 'الحساب غير مفعّل' }, { status: 403 });

    const rp = relyingParty(publicOrigin(req));
    if (!rp) return NextResponse.json({ error: 'البصمة تحتاج اتصالاً آمناً (HTTPS)' }, { status: 400 });

    const body = await req.json().catch(() => null);
    const credentialId = typeof body?.credentialId === 'string' ? body.credentialId : '';
    const publicKey = typeof body?.publicKey === 'string' ? body.publicKey : '';
    /**
     * THE ALGORITHM NUMBER — READ STRICTLY, AND WHY IT IS NOT THE GATE.
     *
     * This was `Number(body?.algorithm)` under `Number.isFinite`, and the
     * notation was open: measured on this build, `'0x10'` → 16, `null` → 0,
     * `[]` → 0, `''` → 0, `['-7']` → -7.
     *
     * IT CANNOT WEAKEN THE AUTHENTICATION, and this is how that was
     * established rather than assumed:
     *
     *   1. `verifyRegistration` (`lib/passkey.ts`) refuses anything outside
     *      `ALLOWED_ALGORITHMS = [-7, -257]` with UNSUPPORTED_ALGORITHM, and
     *      it runs BEFORE `db.passkey.create`. A number nobody meant is
     *      never stored.
     *   2. Both accepted values are NEGATIVE, and `Number()` of a
     *      base-prefixed string is never negative — `Number('-0x10')` is
     *      NaN, measured. So no notation trick reaches an accepted value.
     *   3. `verifyAssertion` checks the same allowlist again at sign-in, and
     *      the proof itself is anchored on the STORED PUBLIC KEY: whichever
     *      branch the algorithm number selects, the signature must still
     *      have been made by the matching private key. Claiming -7 over an
     *      RSA key at worst locks the owner out of their own passkey.
     *
     * So the severity is lower than «low»: nil for authentication strength.
     * What was real is smaller and is what this change fixes — under
     * `Number()`, `{"algorithm": null}` and `{"algorithm": []}` became `0`,
     * which IS finite, so they slipped past this «بيانات التسجيل ناقصة»
     * check, SPENT THE CHALLENGE below, and only then came back as
     * «نوع المفتاح غير مدعوم». A missing field now reads as a missing field,
     * before the ticket is burned.
     *
     * `numeric()` and not `count()`: a COSE algorithm is negative, so a
     * reader with `min(0)` would refuse every real one. And no
     * `Number.isFinite` beside it — `numeric()` already refuses NaN and
     * Infinity (measured: `numeric().safeParse('1e400')` fails), so such a
     * check could never fire once, and a guard that cannot fire is the one
     * thing this audit keeps finding.
     */
    const algorithm = numeric().safeParse(body?.algorithm);
    const clientDataJSON = typeof body?.clientDataJSON === 'string' ? body.clientDataJSON : '';
    const label = typeof body?.label === 'string' ? body.label.trim().slice(0, 60) : '';

    if (!credentialId || !publicKey || !clientDataJSON || !algorithm.success) {
      return NextResponse.json({ error: 'بيانات التسجيل ناقصة' }, { status: 400 });
    }

    /**
     * SPENT IN THE FINDING. `updateMany` with `usedAt: null` in the filter
     * makes a second answer to the same challenge a no-op rather than a
     * second registration — the same shape the change-request apply uses.
     */
    const now = new Date();
    const ticket = await db.passkeyChallenge.findFirst({
      where: { userId: me.id, kind: 'REGISTER', usedAt: null, expiresAt: { gt: now } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, challenge: true },
    });
    if (!ticket) {
      return NextResponse.json({ error: 'انتهت صلاحية الطلب — ابدأ من جديد' }, { status: 400 });
    }
    const spent = await db.passkeyChallenge.updateMany({
      where: { id: ticket.id, usedAt: null },
      data: { usedAt: now },
    });
    if (spent.count !== 1) {
      return NextResponse.json({ error: 'انتهت صلاحية الطلب — ابدأ من جديد' }, { status: 400 });
    }

    const verdict = verifyRegistration({
      clientDataJSON,
      algorithm: algorithm.data,
      expected: { challenge: ticket.challenge, origin: rp.origin },
    });
    if (!verdict.ok) {
      return NextResponse.json({ error: REFUSAL_AR[verdict.code], code: verdict.code }, { status: 400 });
    }

    // One physical key, one row — enforced by the unique index, so two tabs
    // racing the same finger cannot make two.
    const already = await db.passkey.findUnique({ where: { credentialId }, select: { userId: true } });
    if (already) {
      return NextResponse.json(
        {
          error:
            already.userId === me.id
              ? 'هذا المفتاح مسجَّل لديك بالفعل'
              : 'هذا المفتاح مسجَّل لحسابٍ آخر',
          code: 'ALREADY_REGISTERED',
        },
        { status: 409 }
      );
    }

    const key = await db.passkey.create({
      data: {
        userId: me.id,
        credentialId,
        publicKey,
        algorithm: algorithm.data,
        label: label || null,
        counter: 0,
      },
      select: { id: true, label: true, createdAt: true },
    });

    await logAudit({
      companyId: me.companyId || 'platform',
      userId: me.id,
      action: 'PASSKEY_REGISTERED',
      entity: 'User',
      entityId: me.id,
      // Never the key itself. What matters on the trail is that a new way
      // in was added, by whom, and which one it is.
      newData: { passkeyId: key.id, label: key.label, algorithm: algorithm.data },
    });

    return NextResponse.json({ key });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
