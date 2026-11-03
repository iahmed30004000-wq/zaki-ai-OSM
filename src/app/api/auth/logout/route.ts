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
    // Invalidate the current session server-side via tokenVersion bump
    const { getCurrentUser } = await import('@/lib/auth');
    // The person really signed in — never the one an owner is previewing («عاين كـ», preview-mode.ts): signing out
    // bumps THIS account's tokenVersion, and must not sign her out of her own phone.
    const user = await getCurrentUser({ preview: 'ignore' });
    if (user) {
      await db.user.update({
        where: { id: user.id },
        data: { tokenVersion: { increment: 1 } },
      });
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
