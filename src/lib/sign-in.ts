import { NextResponse } from 'next/server';
import { db } from './db';
import { COOKIE_NAME, createSessionToken, sessionCookieOptions } from './auth';
import { ROLE_PERMISSIONS, type UserRole, type UserStatus } from '@/types/auth';
import { logAudit } from './audit';
import { markLogin } from './attendance';
import { createDeviceToken } from './auth';
import { DEVICE_COOKIE, claimsFor, deviceCookieOptions, trustDays } from './trusted-device';
import { longestSessionDays } from './session-length';

/**
 * ISSUING A SESSION — ONE PLACE, BECAUSE THERE ARE NOW TWO DOORS.
 *
 * Before the second factor there was one: the login route did the password,
 * the version bump, the attendance mark, the audit row and the cookie, all
 * in a line. Now a protected role signs in through `/api/auth/2fa/verify`
 * instead, and a second copy of that line would be the place where one of
 * them quietly stops writing the session row — which is the rule that keeps
 * an account to two devices at a time (the owner's ruling 4/11; it was one
 * device, by a `tokenVersion` bump, before it).
 *
 * THE SESSION ROW, AND THE OLDEST DEVICE IT ENDS, BELONG HERE AND NOWHERE
 * EARLIER. Ending a device when the password is accepted would sign the
 * person out of a device they are already using, before they have proved
 * anything — so a stolen password alone could log an owner out of their own
 * session, over and over, without ever getting in.
 */
/** How many devices one account may be signed in on at once — the owner's ruling 4/11. A third ends the oldest. */
export const DEVICES_PER_ACCOUNT = 2;

/**
 * A session row unused for longer than the longest cookie can no longer be presented by any device: it is stamped STALE at
 * the next sign-in and never counted as one of the two.
 *
 * THE LONGEST COOKIE IS WHATEVER `session-length.ts` SAYS NOW — 365 days while sign-ins are long (the owner's ruling
 * 11/11), 30 («تذكّرني») under `AUTH_SHORT_SESSIONS=on`. It has to follow it: with a line at 30 days and cookies that live
 * a year, a laptop left for five weeks would be counted dead at the next sign-in on the account while its cookie is still
 * good, and signed out for it. A function and not a constant, because the switch is read when the sign-in happens.
 */
function staleAfterMs(): number {
  return longestSessionDays() * 24 * 60 * 60 * 1000;
}

/** The browser's own description, cut to 200 characters — «the phone» or «the laptop» for a person reading the rows. */
async function requestUserAgent(): Promise<string | null> {
  try {
    const { headers } = await import('next/headers');
    const said = (await headers()).get('user-agent')?.trim();
    return said ? said.slice(0, 200) : null;
  } catch {
    // Outside a request (a script, a test): a session with no description is still a session.
    return null;
  }
}

export async function issueSession(input: {
  user: {
    id: string;
    email: string;
    name: string | null;
    role: string;
    status: string;
    companyId: string | null;
    commissionRate: unknown;
    company?: { name: string } | null;
  };
  remember: boolean;
  ip: string;
  /**
   * Recorded on the audit row so a sign-in says how it was proved. A
   * sign-in row that cannot say how it was proved is a trail nobody can
   * read backwards.
   *
   *   `password+passkey` — the fingerprint standing where the six digits
   *   stand, after the password was accepted.
   *
   *   `passkey` — the fingerprint standing where the WHOLE login stands.
   *   Not a weaker door: the signature covers the origin, so it cannot be
   *   phished; what is stored is a public key, so it cannot be breached
   *   out of us; and the device only signs after verifying the person, so
   *   it is possession and inherence together. It is written differently
   *   from the others precisely so the audit can tell them apart.
   */
  /**
   *   `password+device` — the password, and a device that proved the six
   *   digits within the last thirty days standing where the six digits
   *   stand. Written as its own word so the audit can answer «how many
   *   sign-ins skipped the code, and on whose devices» — which is the
   *   question somebody will ask of this feature first.
   */
  factor:
    | 'password'
    | 'password+totp'
    | 'password+recovery'
    | 'password+device'
    | 'password+passkey'
    | 'passkey';
  /**
   * «لا تطلب الرمز على هذا الجهاز» — the person ticked the box.
   *
   * IT IS SET HERE AND NOT IN THE ROUTE, and the rule that put it here is
   * worth repeating: `two-factor.test.ts` forbids either door writing a
   * cookie of its own, because the day one route is allowed to set one is
   * the day a route sets the SESSION cookie without its session row (and
   * so past the two-devices rule). So everything a successful sign-in
   * grants is granted in this one function, and «no cookies in the routes» stays a rule with no
   * exception rather than a rule with one.
   */
  trustDevice?: boolean;
  /**
   * The moment the authenticator was enrolled, which the trust token
   * carries so that resetting 2FA revokes every device at once. Passed in
   * rather than re-read: the caller has the row already, and a second read
   * is a second chance to read a different one.
   */
  totpEnabledAt?: Date | null;
}): Promise<NextResponse> {
  const { user, remember, ip } = input;

  /**
   * TWO DEVICES AT ONCE — THE OWNER'S RULING 4/11.
   *
   * This used to bump `tokenVersion`, which made an account work on ONE device: a confirmation agent who opened the
   * system on her phone for the call helper was signed out of the laptop she was confirming on, mid-shift. Now a
   * sign-in writes its own `user_sessions` row, and of the account's live rows it keeps this one and the newest one
   * before it; anything older is stamped REPLACED (never deleted), and that device's login page says why.
   *
   * ONE TRANSACTION, AND THE USER ROW FIRST. The `lastLoginAt` write takes the account's row lock, so two sign-ins of
   * the same account at the same instant queue behind each other, and the second one counts the first one's row —
   * without that, two at once would each count two and leave three open.
   *
   * `tokenVersion` is NOT touched here any more. It stays the «sign out everywhere» lever — force-logout, suspension,
   * password reset, 2FA reset, changing your own password — and the token carries its current value so that lever
   * still reaches this cookie too.
   */
  const now = new Date();
  const userAgent = await requestUserAgent();
  const { refreshed, sid, replaced } = await db.$transaction(async (tx) => {
    const refreshed = await tx.user.update({
      where: { id: user.id },
      data: { lastLoginAt: now },
      select: { tokenVersion: true },
    });
    const created = await tx.userSession.create({
      data: { userId: user.id, createdAt: now, lastSeenAt: now, userAgent },
      select: { id: true },
    });
    /**
     * KEPT BY USE, NOT BY BIRTH — the owner's ruling 4/11 is «two DEVICES», not «two rows».
     *
     * Ordered by creation, a dead row pushed out a live device: the laptop signs in at 08:00 and is worked on all
     * morning, the phone at 09:00, the phone loses its cookie and signs in again at 10:00 — and the laptop, the one in
     * use, was the «oldest». So the others are ranked by `lastSeenAt` (refreshed every five minutes of use), creation
     * only breaking a tie; the 09:00 phone row, untouched since, is the one that goes.
     *
     * And a row nobody has used for longer than a cookie lives is no device at all: every cookie that could name it has
     * expired. It is stamped STALE and not counted, so it can never be what keeps a real device out.
     */
    const live = await tx.userSession.findMany({
      where: { userId: user.id, revokedAt: null },
      orderBy: [{ lastSeenAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, lastSeenAt: true },
    });
    const others = live.filter((row) => row.id !== created.id);
    const staleBefore = now.getTime() - staleAfterMs();
    const stale = others.filter((row) => new Date(row.lastSeenAt).getTime() < staleBefore).map((row) => row.id);
    // This sign-in is kept whatever the clock says of it; of the others still alive, the most recently used
    // DEVICES_PER_ACCOUNT - 1.
    const surplus = others
      .filter((row) => !stale.includes(row.id))
      .slice(DEVICES_PER_ACCOUNT - 1)
      .map((row) => row.id);
    if (stale.length > 0) {
      await tx.userSession.updateMany({
        where: { id: { in: stale }, revokedAt: null },
        data: { revokedAt: now, revokeReason: 'STALE' },
      });
    }
    if (surplus.length > 0) {
      await tx.userSession.updateMany({
        where: { id: { in: surplus }, revokedAt: null },
        data: { revokedAt: now, revokeReason: 'REPLACED' },
      });
    }
    return { refreshed, sid: created.id, replaced: surplus.length };
  });

  await markLogin(user.companyId, user.id);

  await logAudit({
    companyId: user.companyId || 'platform',
    userId: user.id,
    action: 'USER_LOGGED_IN',
    entity: 'User',
    entityId: user.id,
    // `replaced`: how many older devices this sign-in ended — «why was I signed out» has an answer in the trail too.
    newData: { email: user.email, role: user.role, status: user.status, ip, factor: input.factor, replaced },
  });

  const role = user.role as UserRole;
  const status = user.status as UserStatus;

  const token = await createSessionToken({
    userId: user.id,
    email: user.email,
    role,
    status,
    companyId: user.companyId,
    tv: refreshed.tokenVersion,
    sid,
    remember,
  });

  const response = NextResponse.json({
    success: true,
    status,
    role,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role,
      status,
      companyId: user.companyId,
      companyName: user.company?.name,
      commissionRate: user.commissionRate,
      permissions: ROLE_PERMISSIONS[role] || [],
    },
  });

  response.cookies.set({ name: COOKIE_NAME, value: token, ...sessionCookieOptions(remember) });

  /**
   * THE TRUSTED DEVICE, GRANTED ONLY BY PROVING THE SECOND FACTOR.
   *
   * Two independent reasons have to agree before a device is trusted, and
   * that is deliberate on a security rule:
   *
   *   · the caller asked for it — the person ticked the box, and the only
   *     caller that passes it is the one that just accepted a six-digit
   *     code;
   *   · and the factor is not a recovery code. A recovery code means the
   *     authenticator was not to hand, which is also what it means when
   *     somebody else is holding the account. One printed code must not buy
   *     thirty days of skipping the second factor, and printed codes are
   *     exactly what gets photographed.
   *
   * Either reason alone refuses. A caller that forgets the second is still
   * refused here; a function that forgot it would still be refused by the
   * caller.
   */
  if (input.trustDevice && input.factor === 'password+totp' && input.totpEnabledAt) {
    response.cookies.set(
      DEVICE_COOKIE,
      await createDeviceToken(claimsFor({ id: user.id, totpEnabledAt: input.totpEnabledAt })),
      deviceCookieOptions()
    );
    await logAudit({
      companyId: user.companyId || 'platform',
      userId: user.id,
      action: 'TWO_FACTOR_DEVICE_TRUSTED',
      entity: 'User',
      entityId: user.id,
      newData: { ip, days: trustDays() },
    });
  }

  return response;
}
