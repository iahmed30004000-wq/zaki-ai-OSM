/**
 * WHAT A PERSONAL PHONE CAN AND CANNOT BE MADE TO DO.
 *
 * The staff open this on their own phones. Those phones leave the building,
 * get lent to a brother, get sold, and photograph their own screens. Most of
 * what people ask for here is impossible, and saying so plainly is part of
 * the job:
 *
 *   A web page CANNOT block a screenshot. Not on iOS, not on Android, not
 *   in a PWA, not with any CSS or JavaScript. There is no API for it and
 *   there is no trick that works. Even if there were, it would not stop the
 *   oldest method there is — a second phone, pointed at the first.
 *
 *   A web page CANNOT stop copying, retyping, or reading a number aloud
 *   into a phone call.
 *
 * So nothing in this file claims to prevent leakage. Each piece does one
 * thing that is actually achievable:
 *
 *   The WATERMARK does not stop a photograph. It puts a name in it, so a
 *   leaked screenshot answers "whose screen was this" without an
 *   investigation. That changes behaviour, which is the whole of the
 *   effect, and it is worth having for that alone.
 *
 *   The IDLE LIMIT does not stop a thief. It shortens the window in which a
 *   phone left on a counter is an open account, from the seven days the
 *   cookie lasts to the minutes somebody would have to notice it.
 *   (11/11, the owner's ruling: it is a SWITCH now — `AUTH_IDLE_SIGN_OUT`, off
 *   by default, see auth-switches.ts. The constants below are all still here
 *   and `on` gives back exactly what they say; with it off nothing reads them.)
 *
 *   The AUDIT of bulk extraction does not stop an export. It means one
 *   happened in the open rather than invisibly.
 *
 * Everything here is a decision, not a drawing. The components read these
 * answers; they do not each invent their own.
 */

/**
 * How long a screen may sit untouched before the account is signed out.
 *
 * Twenty minutes is chosen from the work, not from a standard. A
 * confirmation agent puts the phone down between calls; a packer scans
 * every few seconds; a manager reads a dashboard for ten minutes without
 * touching it, and scrolling counts as touching it. Five minutes would sign
 * people out mid-shift and teach them to hate it, which ends with the
 * timeout being raised to a day. Twenty is short enough to matter on a
 * counter and long enough that nobody games it.
 */
export const IDLE_LIMIT_MS = 20 * 60 * 1000;

/** The warning before it happens. Long enough to reach for the phone. */
export const IDLE_WARN_MS = 60 * 1000;

export type IdleState = 'active' | 'warning' | 'expired';

/**
 * Where a session stands, from one timestamp.
 *
 * A pure function of two numbers, so the rule can be tested without a
 * browser, a clock, or a component. The component's only job is to supply
 * the "last touched" moment honestly.
 */
export function idleState(lastActiveAt: number, now: number, limit = IDLE_LIMIT_MS, warn = IDLE_WARN_MS): IdleState {
  const idle = now - lastActiveAt;
  // Both comparisons are on the SIGNED interval, deliberately. A clock that
  // moved backwards — a device correcting its time, a tab restored from the
  // back/forward cache — produces a negative one, and a negative interval
  // must read as active rather than as expired. Reaching for Math.abs here
  // is the mistake: it turns "the clock jumped" into "you have been away
  // for an hour", and signs somebody out mid-call for no visible reason.
  if (idle >= limit) return 'expired';
  if (idle >= limit - warn) return 'warning';
  return 'active';
}

/**
 * A CALL IS WORK, NOT IDLENESS — THE OWNER'S RULING 4/11.
 *
 * A confirmation agent presses «اتصال» and the page goes to the background: the dialler or the call helper is in
 * front, and she is talking to a customer. Counted as idle, a few long calls in a row came back to «signed out» within
 * five seconds of returning — the one moment she most needed the order on the screen.
 *
 * So the press leaves a timestamp (a time, never a number or a name — see CUSTOMER_FIELDS below), and the time from it
 * until the page is visible again counts as activity, up to an hour. An hour, because a call that long is not a call: a
 * phone left in the dialler on a counter must still run out.
 */
export const ON_CALL_KEY = 'salesflow.onCall';

/** The most a single press of «اتصال» may count as activity. */
export const ON_CALL_CAP_MS = 60 * 60 * 1000;

/**
 * How long before the page went away the press may have been. The press and the dialler opening are one gesture; a
 * mark older than this belongs to a call long finished (a desk phone, a `tel:` that opened nothing) and is not THIS
 * absence.
 */
export const ON_CALL_LEAD_MS = 60 * 1000;

/**
 * THE MINUTE'S WARNING HAS A CEILING — the owner's ruling 4/11, as the review of #206 read it.
 *
 * The ruling asked two things: call time is not idle, and she SEES a warning before an idle sign-out. It did not ask
 * that a hidden page never be signed out. So a page that comes back within an hour of running out shows the countdown;
 * one that comes back later than that (idle ≥ IDLE_LIMIT_MS + this, after the call credit) is a phone left on a
 * counter, and is signed out on return with no grace.
 */
export const HIDDEN_GRACE_CEILING_MS = 60 * 60 * 1000;

/** «اتصال» was pressed. Written by the press itself (ContactButtons.tsx), read and cleared by IdleGuard on return. */
export function markOnCall(now: number = Date.now()): void {
  try {
    localStorage.setItem(ON_CALL_KEY, String(now));
  } catch {
    /* blocked storage: the call counts as idle, exactly as before the ruling — nothing worse */
  }
}

/**
 * The «last active» moment after a return from a call: the call's time counted, capped, never moved backwards.
 *
 * A pure function of four numbers, like `idleState`. `hiddenAt` is when the page went away (0 when unknown). A mark that
 * is missing, garbled, in the future, or older than `ON_CALL_LEAD_MS` before the page went away gives nothing.
 */
export function creditForCall(
  lastActiveAt: number,
  callMark: number,
  hiddenAt: number,
  now: number,
  cap = ON_CALL_CAP_MS
): number {
  if (!Number.isFinite(callMark) || callMark <= 0 || callMark > now) return lastActiveAt;
  if (hiddenAt > 0 && callMark < hiddenAt - ON_CALL_LEAD_MS) return lastActiveAt;
  return Math.max(lastActiveAt, Math.min(now, callMark + cap));
}

/** Seconds left, for a countdown somebody is watching. Never negative. */
export function secondsLeft(lastActiveAt: number, now: number, limit = IDLE_LIMIT_MS): number {
  return Math.max(0, Math.ceil((lastActiveAt + limit - now) / 1000));
}

/**
 * WHAT A PHOTOGRAPH OF THE SCREEN WILL CARRY.
 *
 * The viewer's own name, a short piece of the account id, and the moment.
 * The name alone is ambiguous in a company with two Ahmads; the id alone is
 * unreadable to the manager looking at the leaked image. Together they are
 * one line that a person can act on.
 *
 * What it deliberately does NOT carry: the email address, the phone, the
 * role. A watermark is on screen all day, in front of whoever is standing
 * behind the person — adding contact details to it would leak in order to
 * prevent leaking.
 */
export function watermarkText(viewer: { name: string; id: string }, now: Date): string {
  const name = viewer.name?.trim() || 'مستخدم';
  // The last six characters of a uuid: enough to separate two namesakes,
  // useless to anybody who cannot already read the user list.
  const tag = viewer.id.replace(/-/g, '').slice(-6).toUpperCase();
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate()
  ).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  return `${name} · ${tag} · ${stamp}`;
}

/**
 * KEYS A BROWSER IS ALLOWED TO REMEMBER.
 *
 * Client storage on a personal device is the one place data outlives the
 * session, survives sign-out, and is readable by anything else that runs on
 * the device. So the rule is absolute rather than careful: no customer
 * datum is written to it. Not a name, not a phone, not an address — not
 * "just the last order for convenience".
 *
 * These are the field names that would give it away. The guard test sweeps
 * every storage write in the codebase against this list, which means the
 * rule survives the next person who has a good reason.
 */
export const CUSTOMER_FIELDS = [
  'fullName',
  'rawPhone',
  'altPhone',
  'customerName',
  'customerPhone',
  'phone',
  'address',
  'governorate',
] as const;
