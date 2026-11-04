import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { COOKIE_NAME } from '@/lib/auth';
import { PREVIEW_COOKIE } from '@/lib/preview-mode';

export async function POST(req: Request) {
  // Why the session ended. A person leaving and a phone left on a counter
  // are the same action and a very different fact, and the second one is
  // the one a manager wants to see a pattern of.
  //
  // It arrives from a browser, so it is not believed: anything that is not
  // one of the two known words is recorded as unknown rather than written
  // into the audit trail as itself.
  let reason = 'manual';
  try {
    const body = await req.json();
    const said = typeof body?.reason === 'string' ? body.reason : '';
    reason = said === 'idle' || said === 'manual' ? said : 'unknown';
  } catch {
    /* no body at all — the older callers, and a manual sign-out */
  }

  try {
    const { getCurrentUser, currentSessionClaims } = await import('@/lib/auth');
    // The person really signed in — never the one an owner is previewing («عاين كـ», preview-mode.ts): signing out
    // ends THIS account's session, and must not sign her out of her own phone.
    const user = await getCurrentUser({ preview: 'ignore' });
    if (user) {
      const claims = await currentSessionClaims();
      if (claims) {
        /**
         * THIS DEVICE ONLY — THE OWNER'S RULING 4/11 (two devices per account).
         *
         * Signing out of the laptop must not sign her out of the phone she is calling from. The row is stamped, not
         * deleted, so the copy of the cookie somebody kept dies with it all the same: `getCurrentUser` refuses a
         * revoked `sid`. `tokenVersion` — every device at once — is left to the doors that mean every device.
         */
        // `userId` in the filter: a row that is not hers is not ended in her name (it cannot be — the session check
        // already refused such a cookie — but a sign-out must not depend on that).
        await db.userSession.updateMany({
          where: { id: claims.sid, userId: user.id, revokedAt: null },
          data: { revokedAt: new Date(), revokeReason: reason === 'idle' ? 'IDLE' : 'LOGOUT' },
        });
      } else {
        /**
         * A COOKIE FROM BEFORE THE RULING carries no `sid`: there is no row to stamp, and the version bump is the only
         * way to make a kept copy of it die too. So it signs out every device of the account, as every sign-out did
         * before — and only until the last of those cookies expires.
         */
        await db.user.update({
          where: { id: user.id },
          data: { tokenVersion: { increment: 1 } },
        });
      }
      await (await import('@/lib/audit')).logAudit({
        companyId: user.companyId || 'platform',
        userId: user.id,
        action: 'USER_LOGGED_OUT',
        entity: 'User',
        entityId: user.id,
        newData: { email: user.email, reason },
      });
    }
  } catch (e) {
    console.error('Logout error:', e);
  }

  const response = NextResponse.json({ success: true });
  response.cookies.set({
    name: COOKIE_NAME,
    value: '',
    httpOnly: true,
    path: '/',
    maxAge: 0,
  });
  // And the preview dies with the session (it is bound to it anyway — this only stops it riding in the jar).
  response.cookies.set({ name: PREVIEW_COOKIE, value: '', httpOnly: true, path: '/', maxAge: 0 });
  return response;
}
