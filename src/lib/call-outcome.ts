/**
 * «شو صار؟» — WHAT HAPPENED ON THE CALL SHE JUST MADE FROM HER PHONE.
 *
 * The confirmation agents work from their phones (the owner's plan, «بنمشي ع اخر خطة»): «اسحب التالي» → «اتصل» → back →
 * one tap for what happened → «التالي». This file is the part of that loop that is not drawn: the order the answers are
 * offered in, the call that is still open, the outcomes waiting to be sent, and the two bodies those outcomes are sent with.
 *
 * NOTHING HERE IS A RULE. The answers are the results the contact log already knows (`CONTACT_RESULTS`), sent through the
 * doors the desk already uses with the bodies its buttons already send. What counts toward the three, what closes an
 * order, what a postponement does — all of it stays where it was, in the doors.
 */

/** The answers on the sheet. `NOT_CALLED` writes nothing; `ANSWERED` opens the desk's own confirm / postpone / cancel. */
export type CallOutcome =
  | 'ANSWERED'
  | 'NO_ANSWER'
  | 'BUSY'
  | 'UNREACHABLE'
  | 'WRONG_NUMBER'
  | 'CALLBACK'
  | 'NOT_CALLED';

/** Under this long away, the dialler was opened and shut — she did not really ring. */
export const SHORT_AWAY_MS = 6_000;
/** Over this long away, somebody most likely picked up. */
export const LONG_AWAY_MS = 45_000;
/** How long a tap waits before it is sent, so «تراجع» needs no delete door. */
export const UNDO_MS = 5_000;
/** A call left open longer than this is not waiting for an answer any more — it is forgotten. */
export const PENDING_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/**
 * THE ORDER THE ANSWERS ARE OFFERED IN, READ FROM HOW LONG SHE WAS AWAY.
 *
 * Nothing is hidden and nothing is chosen for her: every answer is always on the sheet, only the first ones move under
 * the thumb. `null` is «she has not come back yet» (or the browser never said so) — the plain order.
 */
export function outcomeOrder(awayMs: number | null): CallOutcome[] {
  if (awayMs === null) return ['ANSWERED', 'NO_ANSWER', 'BUSY', 'UNREACHABLE', 'WRONG_NUMBER', 'CALLBACK', 'NOT_CALLED'];
  if (awayMs < SHORT_AWAY_MS) return ['NOT_CALLED', 'NO_ANSWER', 'BUSY', 'UNREACHABLE', 'ANSWERED', 'WRONG_NUMBER', 'CALLBACK'];
  if (awayMs <= LONG_AWAY_MS) return ['NO_ANSWER', 'BUSY', 'UNREACHABLE', 'ANSWERED', 'WRONG_NUMBER', 'CALLBACK', 'NOT_CALLED'];
  return ['ANSWERED', 'CALLBACK', 'NO_ANSWER', 'BUSY', 'UNREACHABLE', 'WRONG_NUMBER', 'NOT_CALLED'];
}

/** «0:42», «12:05», «1:02:09» — the time away, small, in the digits a clock uses. */
export function awayClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/**
 * The result the contact log is sent for each answer that is one line in it. `ANSWERED`, `CALLBACK` and `NOT_CALLED` are
 * not here: the first opens the desk's own buttons, the second goes through the postponement door, the third writes nothing.
 */
export const ATTEMPT_RESULT: Partial<Record<CallOutcome, 'NO_ANSWER' | 'BUSY' | 'UNREACHABLE' | 'WRONG_NUMBER'>> = {
  NO_ANSWER: 'NO_ANSWER',
  BUSY: 'BUSY',
  UNREACHABLE: 'UNREACHABLE',
  WRONG_NUMBER: 'WRONG_NUMBER',
};

/**
 * THE BODY OF ONE LINE IN THE CONTACT LOG — the one the desk's «لا يرد» and «مغلق أو خارج التغطية» have always sent.
 * One builder, so the sheet and the card cannot drift apart: a test holds them byte for byte.
 */
export function attemptBody(contactMethod: 'PHONE' | 'WHATSAPP' | 'SMS', result: string): string {
  return JSON.stringify({ contactMethod, result });
}

/**
 * THE BODY OF A POSTPONEMENT — the one the desk's «تأجيل» dialog has always sent (`schedule_follow_up`). The sheet's
 * «اتصل لاحقاً» chips send it too, with the moment the chip names; the door validates it exactly as it validates the dialog.
 */
export function followUpBody(v: {
  at: Date;
  reason: string;
  preferredTime: string;
  note?: string;
  expectedVersion: number;
}): string {
  return JSON.stringify({
    action: 'schedule_follow_up',
    nextFollowUpAt: v.at.toISOString(),
    followUpReason: v.reason,
    preferredTime: v.preferredTime,
    note: v.note || undefined,
    expectedVersion: v.expectedVersion,
  });
}

/** The reason a chip's postponement is filed under — one the postponement list already knows. */
export const CALLBACK_REASON = 'CUSTOMER_REQUESTED_CALLBACK';

export interface CallbackChip {
  label: string;
  at: Date;
}

/**
 * «اتصل لاحقاً» — FOUR MOMENTS, ON THE PHONE'S OWN CLOCK.
 *
 * «اليوم 6 م» is left out once six o'clock is (nearly) past: a postponement into the past is refused by the door, and a
 * chip that exists in order to be refused teaches nothing.
 */
export function callbackChips(now: Date): CallbackChip[] {
  const chips: CallbackChip[] = [
    { label: '+1 س', at: new Date(now.getTime() + 60 * 60 * 1000) },
    { label: '+3 س', at: new Date(now.getTime() + 3 * 60 * 60 * 1000) },
  ];
  const evening = new Date(now);
  evening.setHours(18, 0, 0, 0);
  if (evening.getTime() - now.getTime() > 5 * 60 * 1000) chips.push({ label: 'اليوم 6 م', at: evening });
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(10, 0, 0, 0);
  chips.push({ label: 'بكرة 10 ص', at: tomorrow });
  return chips;
}

/** The time a chip names, as the postponed list will print it back («الساعة 18:00»). */
export function preferredClock(at: Date): string {
  return `الساعة ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

// ───────────────────────── what survives a reload ─────────────────────────

/** The call she opened and has not answered «شو صار؟» for yet. */
export interface PendingCall {
  orderId: string;
  startedAt: number;
  userId: string;
}

/**
 * One outcome on its way to a door.
 *
 * `key` is the order and the moment the call started: ONE outcome per call. Adding a second for the same call replaces the
 * first, and a resend after a dropped line asks the log first (`uncertain`) — so the queue never writes the same line twice.
 */
export interface Outgoing {
  key: string;
  userId: string;
  orderId: string;
  orderNumber: string;
  door: 'attempt' | 'followUp';
  /** The exact body the door is sent. */
  body: string;
  /** The result, for an `attempt` — what the log is asked for before a resend. */
  result?: string;
  /** In words, for the line that says it is waiting («ما رد»). */
  label: string;
  startedAt: number;
  sendAt: number;
  /** A send that may have reached the server before the line dropped. */
  uncertain?: boolean;
  /**
   * WRITTEN BEFORE THE SEND LEAVES (write-ahead). From this mark on it can no longer be taken back, and a tab that finds
   * it marked — after a reload, a killed tab, or another tab's crash — does not know whether it arrived, so it asks the
   * log first, exactly as for `uncertain`.
   */
  inFlight?: boolean;
}

/** Can this one still be taken back? Only while its five seconds run and nothing has left. */
export function undoable(o: Outgoing, now = Date.now()): boolean {
  return !o.inFlight && !o.uncertain && o.sendAt > now;
}

/** What the sheet says about the answer on its way. */
export type OutgoingState = 'countdown' | 'sending' | 'line';
export function outgoingState(o: Outgoing, offline: boolean, now = Date.now()): OutgoingState {
  if (undoable(o, now)) return 'countdown';
  if (o.uncertain || offline) return 'line';
  return 'sending';
}

/** An answer still waiting after a day is about an order long since released: it is dropped, never sent that late. */
export const OUTBOX_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export const PENDING_KEY = 'osm.confirmation.pendingCall';
export const OUTBOX_KEY = 'osm.confirmation.outbox';

/** A private window, a full disk or a blocked site answers by throwing: the sheet then lives in memory alone. */
function readJson(key: string): unknown {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Does this browser let us keep anything at all? (A private window may throw on every call.) */
export function storageWorks(): boolean {
  try {
    window.localStorage.getItem(OUTBOX_KEY);
    return true;
  } catch {
    return false;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* memory still holds it */
  }
}

export function readPending(userId: string, now = Date.now()): PendingCall | null {
  const p = readJson(PENDING_KEY) as Partial<PendingCall> | null;
  if (!p || typeof p.orderId !== 'string' || typeof p.startedAt !== 'number' || p.userId !== userId) return null;
  if (now - p.startedAt > PENDING_MAX_AGE_MS || p.startedAt > now + 60_000) return null;
  return { orderId: p.orderId, startedAt: p.startedAt, userId };
}

export function writePending(p: PendingCall | null): void {
  writeJson(PENDING_KEY, p);
}

export function readOutbox(userId: string, now = Date.now()): Outgoing[] {
  const list = readJson(OUTBOX_KEY);
  if (!Array.isArray(list)) return [];
  return list.filter(
    (o): o is Outgoing =>
      !!o &&
      typeof o === 'object' &&
      (o as Outgoing).userId === userId &&
      typeof (o as Outgoing).key === 'string' &&
      typeof (o as Outgoing).orderId === 'string' &&
      typeof (o as Outgoing).body === 'string' &&
      ((o as Outgoing).door === 'attempt' || (o as Outgoing).door === 'followUp') &&
      typeof (o as Outgoing).startedAt === 'number' &&
      now - (o as Outgoing).startedAt <= OUTBOX_MAX_AGE_MS
  );
}

// ───────────────────────── one tab sends ─────────────────────────

export const LEASE_KEY = 'osm.confirmation.outbox.lease';
/** Longer than one send (15 s request timeout, plus the log read before a resend). */
export const LEASE_MS = 40_000;

/**
 * THE SENDER'S LEASE — for a browser without `navigator.locks`.
 *
 * Two desk tabs on one phone read the same waiting answers. Only the tab holding the lease sends; the other waits for it
 * to be dropped or to expire (a tab killed mid-send cannot drop it). Storage that throws means there is no second tab to
 * share it with: the lease is granted.
 */
export function takeLease(owner: string, now = Date.now()): boolean {
  if (!storageWorks()) return true;
  const held = readJson(LEASE_KEY) as { owner?: string; until?: number } | null;
  if (held && held.owner !== owner && typeof held.until === 'number' && held.until > now) return false;
  writeJson(LEASE_KEY, { owner, until: now + LEASE_MS });
  const back = readJson(LEASE_KEY) as { owner?: string } | null;
  return back?.owner === owner;
}

export function dropLease(owner: string): void {
  const held = readJson(LEASE_KEY) as { owner?: string } | null;
  if (held?.owner === owner) writeJson(LEASE_KEY, null);
}

/** Written whole for this person; another person's waiting lines on the same phone are kept, never sent as hers. */
export function writeOutbox(userId: string, mine: Outgoing[]): void {
  const list = readJson(OUTBOX_KEY);
  const others = Array.isArray(list) ? list.filter((o) => !!o && (o as Outgoing).userId !== userId) : [];
  const all = [...others, ...mine];
  writeJson(OUTBOX_KEY, all.length ? all : null);
}

/** A refusal is an answer from the server (`status`); anything without one never reached it, or never came back. */
export function isNetworkFailure(e: unknown): boolean {
  return !(e && typeof e === 'object' && typeof (e as { status?: unknown }).status === 'number');
}

/**
 * HAS THIS LINE ALREADY REACHED THE LOG? — asked before resending a send whose answer was lost.
 *
 * Her own line, of the same result, written since the call started (on the server's clock, with half a minute of slack).
 */
export function alreadyLogged(
  attempts: { result?: string; employeeId?: string; createdAt?: string }[],
  item: Pick<Outgoing, 'result' | 'userId' | 'startedAt'>,
  serverOffsetMs: number
): boolean {
  const since = item.startedAt + serverOffsetMs - 30_000;
  return attempts.some(
    (a) =>
      a.result === item.result &&
      a.employeeId === item.userId &&
      typeof a.createdAt === 'string' &&
      Date.parse(a.createdAt) >= since
  );
}
