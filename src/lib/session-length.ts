import { shortSessionsOn } from './auth-switches';

/**
 * HOW LONG A SIGN-IN LASTS — ONE NUMBER, IN ONE PLACE.
 *
 * THE OWNER'S RULING 11/11: «بدي ... يحتفظ بتسجيل الدخول ع طول». A sign-in now lasts a year, whether «تذكرني» was ticked or not,
 * and the box is not drawn (a box that does nothing is a box that lies). A browser cuts a cookie at 400 days, so 365 is as
 * long as one can honestly be asked to last.
 *
 * `AUTH_SHORT_SESSIONS=on` puts the old rule back, exactly: 7 days, or 30 with «تذكرني».
 *
 * FOUR THINGS READ THIS, AND THEY MUST AGREE — «two numbers that disagree is a bug nobody can see»:
 *
 *   · the signed token's own expiry (`createSessionToken`, auth.ts) — what the proxy and the session check enforce;
 *   · the cookie's `maxAge` (`sessionCookieOptions`, auth.ts) — how long the browser keeps it;
 *   · the line after which a session ROW nobody has used is «stale» (sign-in.ts). It follows the LONGEST cookie, or a row
 *     whose cookie is still good would be counted dead and its device signed out at somebody else's sign-in;
 *   · how long a trusted device skips the six digits (`trustDays`, trusted-device.ts), which is meant to agree with
 *     «تذكرني» and now agrees with whatever the longest sign-in is.
 *
 * COOKIES ALREADY ISSUED KEEP THEIR OWN LIFE. The 7 or 30 days were written into them at sign-in; changing a switch changes
 * only the next sign-in. (And the other way round: cookies issued while sessions were long stay good for their year after
 * `AUTH_SHORT_SESSIONS=on` — ending one at once is the account's «sign out everywhere», which bumps the token version.)
 */

/** The old rule, kept whole: a plain sign-in. */
export const SHORT_SESSION_DAYS = 7;
/** The old rule, kept whole: a sign-in with «تذكرني» ticked. */
export const REMEMBERED_SESSION_DAYS = 30;
/** The rule now. */
export const LONG_SESSION_DAYS = 365;

/** Days a sign-in made right now lasts. `remember` is the box on the login page; it only counts under the old rule. */
export function sessionDays(remember: boolean): number {
  if (!shortSessionsOn()) return LONG_SESSION_DAYS;
  return remember ? REMEMBERED_SESSION_DAYS : SHORT_SESSION_DAYS;
}

/** The longest any sign-in made right now can last — what a session row's «stale» line and a trusted device follow. */
export function longestSessionDays(): number {
  return shortSessionsOn() ? REMEMBERED_SESSION_DAYS : LONG_SESSION_DAYS;
}
