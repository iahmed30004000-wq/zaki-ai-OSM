import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireCompanyTenant } from '@/lib/auth';
import { can } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { rateLimit } from '@/lib/rate-limit';
import { encryptionAvailable } from '@/lib/secrets';
import { publicOrigin } from '@/lib/passkey';
import { PAIR_CODE_TTL_MS, intentUrl, newPairCode, pairLink, sha256Hex } from '@/lib/call-helper/core';

/**
 * POST /api/call-helper/pair-code — «اربط هذا التلفون» on «طلباتي».
 *
 * A one-time code for HER, ten minutes, and the two links that carry it: the `zakicall://pair` link of the contract and
 * the Android intent URL Chrome opens it with (falling back to «طلباتي» with the «install the app first» line when the
 * app is not on the phone). The card fetches it BEFORE she presses — an intent opened after an `await` can lose the
 * press in Chrome — so the button is a plain link to a code that is already here.
 *
 * Asked of `confirmation.work`, the key «طلباتي» itself asks: the helper exists for the desk. No key is added to any
 * role. `base` is the public origin the rest of the product believes (`publicOrigin`: APP_URL first, forwarded headers
 * only behind TRUST_PROXY) — never a Host header taken as it came.
 *
 * Only the code's SHA-256 is stored. Her own spent and expired codes are cleared as a new one is made, so the table holds
 * at most the few she has open.
 */

export async function POST(req: Request) {
  try {
    const { user, companyId } = await requireCompanyTenant();
    if (!can(user, 'confirmation.work')) {
      const said = 'مساعد الاتصال لشاشة «طلباتي» بس — ما عندك صلاحيتها.';
      return NextResponse.json({ error: said, errorAr: said }, { status: 403 });
    }
    if (!encryptionAvailable()) {
      const said = 'الربط مش متاح هلق: مفتاح التشفير مش مضبوط على السيرفر — راجعي المسؤول.';
      return NextResponse.json({ error: said, errorAr: said, code: 'ENCRYPTION_KEY_MISSING' }, { status: 503 });
    }
    const rl = rateLimit(`call-helper-pair-code:${user.id}`, 30, 10 * 60 * 1000);
    if (!rl.allowed) {
      const said = `طلبات ربط كتير — جرّبي بعد ${rl.retryAfterSec} ثانية.`;
      return NextResponse.json({ error: said, errorAr: said }, { status: 429 });
    }

    const now = new Date();
    await db.callHelperPairCode.deleteMany({
      where: { userId: user.id, OR: [{ usedAt: { not: null } }, { expiresAt: { lte: now } }] },
    });
    const code = newPairCode();
    const expiresAt = new Date(now.getTime() + PAIR_CODE_TTL_MS);
    await db.callHelperPairCode.create({ data: { companyId, userId: user.id, codeHash: sha256Hex(code), expiresAt } });

    const base = publicOrigin(req);
    const link = pairLink(base, code);
    return NextResponse.json({
      pairLink: link,
      intentUrl: intentUrl(link, `${base}/confirmation/mine#call-helper-install`),
      expiresAt: expiresAt.toISOString(),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
