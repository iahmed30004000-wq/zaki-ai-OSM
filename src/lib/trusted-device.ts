/**
 * «ال 2fa يحتفظ بتسجيل الدخول... بس اذا صار نشاط مشبوه يطلبو»
 *
 * WHY THE SIX DIGITS ARE ASKED FOR SO OFTEN, MEASURED RATHER THAN GUESSED:
 * a screen untouched for twenty minutes signs the account out
 * (`IDLE_LIMIT_MS`), and every sign-in verifies the second factor again. An
 * owner who puts a laptop down between two meetings reaches for the phone
 * three or four times a day — and a rule reached for that often is a rule
 * people start working around, which is how a second factor ends up
 * switched off for everybody.
 *
 * ── WHAT THIS REPLACES, AND WHAT IT CANNOT ──
 *
 * A trusted device stands in for the SIX DIGITS. It never stands in for the
 * password. Somebody holding this device and not the password gets nowhere;
 * somebody holding the password and not this device is asked for the code
 * exactly as before. That is the whole security argument, and it is the
 * reason the feature is safe to want: the second factor is not being
 * removed, the *possession* of the enrolled device is being remembered.
 *
 * ── HOW TRUST ENDS, WITHOUT A REVOCATION LIST ──
 *
 * The trust is a signed token the device holds, not a row. It carries the
 * moment the authenticator was enrolled (`enr`), so:
 *
 *   · resetting or re-enrolling 2FA changes `totpEnabledAt` and every
 *     trusted device in the world stops being trusted, at once
 *   · a different person signing in on the device finds `sub` is not theirs
 *   · thirty days pass and the token expires on its own
 *
 * No table to keep in step, and nothing to forget to clean up. What it
 * cannot do is revoke ONE device from a screen — that needs a row, and it
 * is written here as a known limit rather than left to be discovered.
 *
 * SIGNING OUT DOES NOT FORGET THE DEVICE, which is deliberate and is how
 * every bank behaves: leaving is not the same as saying «this is not my
 * laptop». The password is still asked for on the way back in.
 */

/** Thirty days, to agree with «تذكرني» — two numbers that disagree is a bug nobody can see. */
export const TRUST_DAYS = 30;

/**
 * A WRONG PASSWORD IN THE LAST QUARTER OF AN HOUR IS THE SUSPICIOUS ACTIVITY.
 *
 * It is the one signal this deployment actually has. Addresses are not one
 * of them: without `TRUST_PROXY=true` every caller shares the bucket
 * `'local'` (see `getClientIp`), so «a new IP» would be either always true
 * or always false, and a signal that cannot vary is worse than none — it
 * reads as a protection while protecting nothing.
 *
 * WHAT IT COSTS WHEN IT FIRES WRONGLY: a typo costs one code entry. That
 * is the trade, stated so it can be changed if it grates — the counter is
 * deliberately NOT cleared by a later success, because «somebody guessed
 * wrong at this account minutes ago» stays true whoever typed next.
 *
 * AND IT CAN BE PROVOKED: anybody who knows an email can fail a password on
 * purpose and force the owner to reach for their phone. That is a nuisance
 * and not a hole — it only ever makes the door stricter, never looser.
 */
export const SUSPICION_WINDOW_MS = 15 * 60 * 1000;

/** The cookie is its own, so clearing the session never clears the trust. */
export const DEVICE_COOKIE = 'zaki_device_trust';

/**
 * In memory, like `rateLimit` next door, and for the same reason: a deploy
 * clears it. For a «be stricter for the next quarter of an hour» signal
 * that is acceptable — the failure mode is asking for the code when it
 * need not have, which is the safe direction.
 */
const badPassword = new Map<string, number>();

const key = (email: string) => email.trim().toLowerCase();

/** Past this many remembered addresses, the ones whose quarter of an hour has passed are dropped. */
const SWEEP_ABOVE = 1_000;

export function noteBadPassword(email: string, now: number = Date.now()): void {
  /*
   * NOTHING WAS EVER FORGOTTEN unless the same address was asked about again:
   * `recentBadPassword` deletes a stale entry only when it is looked up, so a
   * stranger trying a thousand different addresses left a thousand entries
   * for the life of the process. Dropping the ones past the window changes
   * no answer — `recentBadPassword` already treats them as absent — and
   * never drops one that is still inside it.
   */
  if (badPassword.size >= SWEEP_ABOVE) {
    for (const [address, at] of badPassword) {
      if (now - at >= SUSPICION_WINDOW_MS) badPassword.delete(address);
    }
  }
  badPassword.set(key(email), now);
}

/** Tests only — how many addresses are being remembered. */
export function rememberedBadPasswords(): number {
  return badPassword.size;
}

export function recentBadPassword(email: string, now: number = Date.now()): boolean {
  const at = badPassword.get(key(email));
  if (at === undefined) return false;
  if (now - at >= SUSPICION_WINDOW_MS) {
    badPassword.delete(key(email));
    return false;
  }
  return true;
}

/** Tests only — the map is module state and a test must be able to start clean. */
export function forgetBadPasswords(): void {
  badPassword.clear();
}

/** What a device's token says. Nothing identifying, and nothing secret. */
export interface DeviceTrustClaims {
  typ: 'device';
  /** The user this device was trusted for. */
  sub: string;
  /** `totpEnabledAt` in ms — the binding that makes a 2FA reset revoke everything. */
  enr: number;
}

export type TrustVerdict =
  | { trusted: true }
  | { trusted: false; why: 'no-token' | 'other-user' | 're-enrolled' | 'not-enrolled' | 'suspicious' };

/**
 * THE DECISION, as a pure function of four things.
 *
 * No cookie, no request, no database, no clock of its own — so every branch
 * below is reachable from a test, including the ones that are meant never
 * to happen. The token's own expiry is checked by the signature layer
 * before this is called; everything else is here.
 *
 * ORDER MATTERS AND IS DELIBERATE: suspicion is checked LAST, so a token
 * that is wrong for a structural reason reports that reason rather than
 * hiding behind «suspicious». The audit trail is the reader of these words.
 */
export function judgeTrust(input: {
  claims: DeviceTrustClaims | null;
  user: { id: string; totpEnabledAt: Date | null };
  suspicious: boolean;
}): TrustVerdict {
  const { claims, user, suspicious } = input;

  if (!claims) return { trusted: false, why: 'no-token' };
  // A device trusted for one person is not a device trusted for the next
  // one to use it, even on the same machine.
  if (claims.sub !== user.id) return { trusted: false, why: 'other-user' };
  // Nothing to stand in for: no authenticator, no trust.
  if (!user.totpEnabledAt) return { trusted: false, why: 'not-enrolled' };
  // The one that makes a reset a revocation of every device at once.
  if (claims.enr !== user.totpEnabledAt.getTime()) return { trusted: false, why: 're-enrolled' };
  if (suspicious) return { trusted: false, why: 'suspicious' };

  return { trusted: true };
}

export function claimsFor(user: { id: string; totpEnabledAt: Date }): DeviceTrustClaims {
  return { typ: 'device', sub: user.id, enr: user.totpEnabledAt.getTime() };
}

/**
 * The cookie's own settings. `sameSite: 'strict'` and not `'lax'` as the
 * session's is: this cookie is only ever read by the login endpoint, which
 * is never reached by following a link from somewhere else, so there is no
 * reason to let it travel on a cross-site navigation.
 */
export function deviceCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict' as const,
    path: '/',
    maxAge: 60 * 60 * 24 * TRUST_DAYS,
  };
}
