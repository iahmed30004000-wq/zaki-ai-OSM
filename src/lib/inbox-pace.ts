/**
 * HOW OFTEN AN OPEN INBOX ASKS (RV182).
 *
 * The inbox asked every five seconds, for as long as the tab was open and visible — a tab left open on a quiet afternoon
 * cost the server the same as one in the middle of a rush (each poll re-reads the session, 7 to 10 queries, plus the list).
 * An inbox is the one screen where stale IS the bug, so the five seconds stay for as long as anything is happening. What
 * goes is the asking for NOTHING: after a minute in which the list did not change and no message arrived, the screen asks
 * every fifteen seconds instead, and the first change — or the person doing anything, or coming back to the tab — puts it
 * back to five.
 *
 * Pure on purpose: the screen keeps the counter, this says what the counter means.
 */

/** The pace while anything is happening. */
export const FAST_POLL_MS = 5_000;
/** The pace after a quiet minute. */
export const IDLE_POLL_MS = 15_000;
/** Quiet polls in a row before slowing down: twelve at five seconds is one minute. */
export const QUIET_POLLS_BEFORE_SLOWING = 12;

export function paceFor(quietPolls: number): number {
  return quietPolls >= QUIET_POLLS_BEFORE_SLOWING ? IDLE_POLL_MS : FAST_POLL_MS;
}

/**
 * What «the list changed» means: a different set of conversations, a different unread count on any of them, or a
 * different last message. Anything the person could see move is in it; nothing they could not is.
 */
export function listSignature(list: ReadonlyArray<{ id: string; unreadCount?: number | null; lastMessageAt?: string | null }>): string {
  return list.map((c) => `${c.id}:${c.unreadCount ?? 0}:${c.lastMessageAt ?? ''}`).join('|');
}
