/**
 * THE SWITCHES OF THE SIGN-IN HARDENING — ONE PLACE, ONE RULE FOR READING THEM.
 *
 * Every part of the hardening (A1-A8) can be turned off or on from the environment WITHOUT a code change, because the
 * parts that touch the way in can lock people out and the owner must be able to step back from one without a redeploy of
 * code. A part is either ON BY DEFAULT (it only closes a hole and cannot shut an honest person out) or OFF BY DEFAULT
 * (it needs the owner to be ready for it first).
 *
 *   on by default, 'off' / '0' / 'false' / 'no' turns it off:
 *     AUTH_PASSKEY_STEP_UP        A1  adding a fingerprint asks for the password (or a fresh six-digit code) first
 *     AUTH_PASSKEY_WIPE           A1  the fingerprints go when the password / second factor is reset or the account stops
 *     AUTH_BOOTSTRAP_GUARD        A3  INITIAL_SUPER_ADMIN_EMAIL creates the owner only while there is no owner
 *     AUTH_LOGIN_EMAIL_LIMIT      A7  a ceiling on WRONG passwords per email, whatever the address
 *
 *   off by default, 'on' / '1' / 'true' / 'yes' turns it on:
 *     AUTH_SELF_SIGNUP            A4  anyone may open the register page (D7: off until the owner decides)
 *     AUTH_ENROL_CODE_REQUIRED    A2  first-time two-factor setup needs the code the owner issued (D7)
 *     PUBLIC_MEDIA_STRICT         A8  a product's file is public on its own only if it is one of the product's pictures
 *
 *   THE THREE THAT GIVE BACK THE OLD PROTECTION — off by default, and «on» means «as it was before 11/11»
 *   (the owner's ruling 11/11: «بدي الغي ال 2fa و قصة انو يطلع كل ١٥ دقيقة و كمان يحتفظ بتسجيل الدخول ع طول»).
 *   Nothing was removed to grant it: every line of the second factor, the idle sign-out and the short cookie is still
 *   here, and putting one back is a changed variable in Coolify and a restart, never a code change. Anything unreadable
 *   stays OFF, so a typo shuts nobody out and signs nobody out.
 *     AUTH_TWO_FACTOR_REQUIRED    on = the second code is asked at every password sign-in (and set up at the first one),
 *                                 off = the password alone opens the account, enrolled or not
 *     AUTH_IDLE_SIGN_OUT          on = a screen untouched for twenty minutes signs this device out (a minute's warning
 *                                 first), off = nothing signs anybody out for being idle
 *     AUTH_SHORT_SESSIONS         on = a sign-in lasts 7 days (30 with «تذكرني»), off = a sign-in lasts 365 days and the
 *                                 «تذكرني» box is not drawn (it would do nothing)
 *
 * Never a secret here, only a yes or a no.
 */

/** What the switches are read from: the real environment, or one a test (or the boot check) hands over. */
type Env = Record<string, string | undefined>;

const ON = new Set(['on', '1', 'true', 'yes']);
const OFF = new Set(['off', '0', 'false', 'no']);

function word(name: string, env: Env): string {
  return (env[name] ?? '').trim().toLowerCase();
}

/** A part that is ON unless somebody wrote an explicit «off». Anything unreadable stays ON: the safe side. */
export function onUnlessOff(name: string, env: Env = process.env): boolean {
  return !OFF.has(word(name, env));
}

/** A part that is OFF unless somebody wrote an explicit «on». Anything unreadable stays OFF: nobody is locked out by a typo. */
export function offUnlessOn(name: string, env: Env = process.env): boolean {
  return ON.has(word(name, env));
}

export const passkeyStepUpOn = () => onUnlessOff('AUTH_PASSKEY_STEP_UP');
export const passkeyWipeOn = () => onUnlessOff('AUTH_PASSKEY_WIPE');
export const bootstrapGuardOn = () => onUnlessOff('AUTH_BOOTSTRAP_GUARD');
export const loginEmailLimitOn = () => onUnlessOff('AUTH_LOGIN_EMAIL_LIMIT');
export const selfSignupOn = () => offUnlessOn('AUTH_SELF_SIGNUP');
export const enrolCodeRequired = () => offUnlessOn('AUTH_ENROL_CODE_REQUIRED');
export const publicMediaStrict = () => offUnlessOn('PUBLIC_MEDIA_STRICT');

/** The second code at sign-in. `env` is for the boot check, which is handed the environment instead of reading it. */
export const twoFactorRequired = (env: Env = process.env) => offUnlessOn('AUTH_TWO_FACTOR_REQUIRED', env);
/** The sign-out of a screen left untouched. Read on the SERVER and handed to the page — the browser has no environment. */
export const idleSignOutOn = (env: Env = process.env) => offUnlessOn('AUTH_IDLE_SIGN_OUT', env);
/** The old 7 / 30 day cookie. Off = one long sign-in (`session-length.ts`). */
export const shortSessionsOn = (env: Env = process.env) => offUnlessOn('AUTH_SHORT_SESSIONS', env);
