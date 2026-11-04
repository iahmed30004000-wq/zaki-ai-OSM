'use client';

import { apiJson } from '@/lib/api-client';
import { isNetworkFailure } from '@/lib/call-outcome';

/**
 * THE LINE A PRESS LEAVES — SENT FIRST, KEPT UNTIL IT LANDS (the owner's ruling 4/11).
 *
 * «اتصال» writes `OPENED` in the order's contact log, and that line is more than a record: it is the one thing that tells the
 * ninety-minute release (`releaseStaleClaims`) she is working the order. With no line at all, ninety working minutes after
 * she pulled it the order is taken back — in the middle of her day, with the customer perhaps still on the phone.
 *
 * The line used to be fire-and-forget: started on the press, while the dialler or the call helper took the screen, and
 * dropped for good on the first failure, with a small red sentence she could not see from inside the call app. So:
 *
 *   · `keepalive: true` — the request outlives the page being frozen or left for the dialler. It is STARTED on the press,
 *     before the link opens, and never awaited first: the call is not delayed by a single round trip;
 *   · a failure that is not a definitive refusal (no answer at all, a 408 / 429, a 5xx) is KEPT, in this tab's
 *     `sessionStorage` — which a phone keeps across the reload of a tab it dropped — and sent again every fifteen seconds
 *     and the moment the connection is back, until it lands;
 *   · a resend ASKS THE LOG FIRST, as the call sheet's outbox does (`alreadyLogged` in call-outcome.ts): the first send may
 *     have reached the server and lost only its answer, and the same press must never become two lines. The door has no
 *     idempotency key and no column for one; the log itself is the key — HER line (the employee who pressed, kept on the
 *     line), of this result, since the press with half a minute of clock slack. Anybody else's line, or an earlier press of
 *     hers, is not this press: a colleague's «اتصال» before the order changed hands, or her own before she re-pulled it,
 *     says nothing about the claim she holds now — and counting it would drop her line and let the re-pull release
 *     (`REPULL_RELEASE_REASON`) take the order ninety minutes later;
 *   · a definitive refusal (403 not hers, 404, 400) is said beside the strip, as it always was, and not retried.
 *
 * ── WHY NOT THE CALL SHEET'S OUTBOX ITSELF (`useOutbox`) ──
 *
 * That queue carries ONE OUTCOME PER CALL, keyed by the call; it exists only on her phone's desk, behind the sheet; and its
 * sender carries the sheet's own answers (the auto-close notice, the sheet's refusal). A press from the orders list, a
 * desk, or the order window never reached it. This keeps the outbox's two rules — kept across a reload, and ask-before-
 * resend — for the line every screen's strip writes.
 *
 * ── WHY `sessionStorage` ──
 *
 * The door writes the line under whoever's session sends it. A line kept in the browser's shared storage and sent after
 * another person signed in on the same phone would be his. Kept per tab, and forgotten on sign-out (`sign-out.ts`).
 */

export const CONTACT_LINES_KEY = 'osm.contact.lines';
/** Sent again after this long, if the connection has not come back first. */
export const LINE_RETRY_MS = 15_000;
/** A line still waiting after this long is about a call long over: dropped, never sent that late. */
export const LINE_MAX_AGE_MS = 2 * 60 * 60 * 1000;
/**
 * How far before the press the log is searched for the line already landed: the phone's clock and the server's are not the
 * same clock. Half a minute, as the call sheet's `alreadyLogged` — wider would find an EARLIER press (hers before a re-pull)
 * and drop this one, which is the one thing this module exists to prevent.
 */
export const LINE_CLOCK_SLACK_MS = 30_000;

export type LineMethod = 'PHONE' | 'SMS' | 'WHATSAPP';
export type LineResult = 'OPENED' | 'MESSAGE_SENT';

/** One line waiting to land. `key` is the order and the moment of the press: one line per press. */
export interface WaitingLine {
  key: string;
  orderId: string;
  /** Who pressed — the only employee whose line in the log can be this press, and the only session that may send it. */
  userId: string | null;
  method: LineMethod;
  result: LineResult;
  pressedAt: number;
  sendAt: number;
}

/** What the press came to, for the strip: landed, kept for another try, or refused — with the server's words. */
export type LineAnswer = { state: 'sent' } | { state: 'waiting' } | { state: 'refused'; said: string | null };

/** Does a refusal already speak to her? (the Arabic block, as `api-error.ts` asks it) */
const ARABIC = /[؀-ۿ]/;

/**
 * A definitive refusal, or worth another try? No answer at all is worth one (`isNetworkFailure`), and so are a timeout, a
 * rate limit and a server that failed; the door refusing — not hers, not found, not allowed — is final.
 */
export function worthAnotherTry(e: unknown): boolean {
  if (isNetworkFailure(e)) return true;
  const status = (e as { status: number }).status;
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Her line of this result, since the press (with the clocks' margin) — the same press, already landed. Nobody else's: with
 * no presser known, nothing in the log is this press, and the line is sent.
 */
export function lineLanded(
  attempts: { result?: string; employeeId?: string; createdAt?: string }[],
  line: Pick<WaitingLine, 'result' | 'pressedAt' | 'userId'>
): boolean {
  const since = line.pressedAt - LINE_CLOCK_SLACK_MS;
  return attempts.some(
    (a) =>
      a.result === line.result &&
      a.employeeId === line.userId &&
      typeof a.createdAt === 'string' &&
      Date.parse(a.createdAt) >= since
  );
}

/**
 * WHO IS SIGNED IN ON THIS TAB — told by the app's provider (`AppContext.tsx`), so the strip needs no context of its own.
 * Null until it is known; a line is sent only under the session of the one who pressed it.
 */
let owner: string | null = null;
export function setContactLineOwner(userId: string | null): void {
  const changed = owner !== userId;
  owner = userId;
  if (changed && userId) resumeContactLines();
}

// ───────────────────────── kept in this tab ─────────────────────────

/** Where storage throws (a private window, a full disk), the lines live in memory alone. */
let memory: WaitingLine[] = [];

function read(now = Date.now()): WaitingLine[] {
  let list: unknown = memory;
  try {
    const raw = window.sessionStorage.getItem(CONTACT_LINES_KEY);
    list = raw ? JSON.parse(raw) : [];
  } catch {
    /* memory holds them */
  }
  if (!Array.isArray(list)) return [];
  return list.filter(
    (l): l is WaitingLine =>
      !!l &&
      typeof l === 'object' &&
      typeof (l as WaitingLine).key === 'string' &&
      typeof (l as WaitingLine).orderId === 'string' &&
      typeof (l as WaitingLine).pressedAt === 'number' &&
      ((l as WaitingLine).userId === null || typeof (l as WaitingLine).userId === 'string') &&
      now - (l as WaitingLine).pressedAt <= LINE_MAX_AGE_MS
  );
}

function write(list: WaitingLine[]): void {
  memory = list;
  try {
    if (list.length) window.sessionStorage.setItem(CONTACT_LINES_KEY, JSON.stringify(list));
    else window.sessionStorage.removeItem(CONTACT_LINES_KEY);
  } catch {
    /* memory holds them */
  }
  for (const fn of listeners) fn();
  if (list.length) startTimer();
  else stopTimer();
}

const listeners = new Set<() => void>();
/** A definitive refusal a RESEND met, per order — said beside that order's strip. */
const refusals = new Map<string, string | null>();

/** The strip listens: a line kept, landed or refused redraws it. */
export function subscribeLines(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Is a line of this order still waiting to land? */
export function lineWaiting(orderId: string): boolean {
  return read().some((l) => l.orderId === orderId);
}

/** The refusal a resend of this order's line met, if any (`undefined` = none). */
export function lineRefusal(orderId: string): string | null | undefined {
  return refusals.has(orderId) ? refusals.get(orderId) : undefined;
}

/** Signing out: nothing of hers is sent under the next person's session. */
export function forgetContactLines(): void {
  refusals.clear();
  write([]);
}

// ───────────────────────── sending ─────────────────────────

function post(orderId: string, method: LineMethod, result: LineResult): Promise<unknown> {
  return apiJson(`/api/orders/${orderId}/contact-attempts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contactMethod: method, result }),
    // The page is about to be left for the dialler: the request must outlive it.
    keepalive: true,
  });
}

function said(e: unknown): string | null {
  return e instanceof Error && ARABIC.test(e.message) ? e.message : null;
}

/**
 * THE PRESS. The request is started HERE, synchronously — `apiJson` calls `fetch` before its first `await` — so a caller
 * that calls this and then lets the link open has sent the line first. Nothing is awaited before the link.
 */
export function sendContactLine(v: { orderId: string; method: LineMethod; result: LineResult; now?: number }): Promise<LineAnswer> {
  const pressedAt = v.now ?? Date.now();
  // Read at the press, not at the failure: whoever was signed in when she pressed.
  const presser = owner;
  return post(v.orderId, v.method, v.result).then(
    (): LineAnswer => {
      refusals.delete(v.orderId);
      for (const fn of listeners) fn();
      return { state: 'sent' };
    },
    (e: unknown): LineAnswer => {
      if (!worthAnotherTry(e)) return { state: 'refused', said: said(e) };
      const line: WaitingLine = {
        key: `${v.orderId}:${pressedAt}`,
        orderId: v.orderId,
        userId: presser,
        method: v.method,
        result: v.result,
        pressedAt,
        sendAt: Date.now() + LINE_RETRY_MS,
      };
      write([...read().filter((l) => l.key !== line.key), line]);
      return { state: 'waiting' };
    }
  );
}

let flushing: Promise<void> | null = null;

/**
 * SEND WHAT IS DUE — one line at a time, one pass at a time in this tab. Each resend asks the log first; a line it finds
 * there is done without a second POST.
 */
export function flushContactLines(force = false): Promise<void> {
  // A pass already running: a tick leaves it to that one; a forced send (the connection back) waits for it, then goes.
  if (flushing) return force ? flushing.then(() => flushContactLines(true)) : flushing;
  const run = (async () => {
    for (;;) {
      const at = Date.now();
      // Another person's line (a session that ended and a different one signed in on this tab) is never sent as this one's.
      const signedIn = owner;
      if (signedIn && read(at).some((l) => l.userId && l.userId !== signedIn)) {
        write(read(at).filter((l) => !l.userId || l.userId === signedIn));
      }
      // Until the tab knows who is signed in, a line with a presser waits: it may not be this session's.
      const due = read(at).find((l) => (force || l.sendAt <= at) && (!l.userId || l.userId === owner));
      if (!due) break;
      try {
        const log = await apiJson<{ attempts?: { result?: string; employeeId?: string; createdAt?: string }[] }>(
          `/api/orders/${due.orderId}/contact-attempts`
        );
        if (!lineLanded(log.attempts ?? [], due)) await post(due.orderId, due.method, due.result);
        refusals.delete(due.orderId);
        write(read().filter((l) => l.key !== due.key));
      } catch (e) {
        if (worthAnotherTry(e)) {
          write(read().map((l) => (l.key === due.key ? { ...l, sendAt: Date.now() + LINE_RETRY_MS } : l)));
          break;
        }
        refusals.set(due.orderId, said(e));
        write(read().filter((l) => l.key !== due.key));
      }
    }
  })();
  flushing = run;
  return run.finally(() => {
    if (flushing === run) flushing = null;
  });
}

let timer: ReturnType<typeof setInterval> | null = null;
let online: (() => void) | null = null;

function startTimer(): void {
  if (typeof window === 'undefined' || timer) return;
  timer = setInterval(() => void flushContactLines(), 5_000);
  online = () => void flushContactLines(true);
  window.addEventListener('online', online);
}

function stopTimer(): void {
  if (timer) clearInterval(timer);
  timer = null;
  if (online && typeof window !== 'undefined') window.removeEventListener('online', online);
  online = null;
}

/** A strip mounted after a reload picks up what this tab kept, and sends it. */
export function resumeContactLines(): void {
  if (typeof window === 'undefined') return;
  if (read().length) {
    startTimer();
    void flushContactLines();
  }
}
