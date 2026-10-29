/**
 * A MEMORY OF ONE ANSWER, FOR A MINUTE — AND FOR THE ASKERS WHO ARRIVE WHILE IT IS BEING WORKED OUT.
 *
 * For a read that is expensive, is the same for everyone in the same scope,
 * and does not need to be fresher than the time it takes a person to read
 * the page (RV184: the governorates' delivery times, asked three times on
 * every opening of the orders screen, each one a scan of 180 days of
 * delivered orders with their addresses).
 *
 * WHAT IT IS NOT
 *   - not for anything a person edits and then looks at again: the next
 *     read would show the old answer for a minute;
 *   - not for money;
 *   - not shared between scopes: the KEY is the caller's whole scope
 *     (company and store both), so one tenant can never be handed another's
 *     answer.
 *
 * It holds the PROMISE, so the second and third askers of the same opening
 * wait for the one read instead of starting their own. A read that fails is
 * forgotten at once: an error is not an answer to remember. The number of
 * keys is capped; past it the oldest goes, so it cannot grow without limit.
 * In memory, per process — a deploy clears it, which is correct.
 */
export interface ShortMemo<V> {
  get: (key: string, load: () => Promise<V>, now?: number) => Promise<V>;
  /** Tests only. */
  size: () => number;
  clear: () => void;
}

export function shortMemo<V>(ttlMs: number, maxKeys: number): ShortMemo<V> {
  const kept = new Map<string, { at: number; value: Promise<V> }>();

  return {
    get(key, load, now = Date.now()) {
      const hit = kept.get(key);
      if (hit && now - hit.at < ttlMs) return hit.value;

      if (!hit && kept.size >= maxKeys) {
        const oldest = kept.keys().next().value;
        if (oldest !== undefined) kept.delete(oldest);
      }
      // Re-inserted, so insertion order is also age order.
      kept.delete(key);
      const value = load();
      const entry = { at: now, value };
      kept.set(key, entry);
      // Both arms, so a rejection is never left unhandled here; only THIS entry is dropped.
      const forget = () => {
        if (kept.get(key) === entry) kept.delete(key);
      };
      value.then(undefined, forget);
      return value;
    },
    size: () => kept.size,
    clear: () => kept.clear(),
  };
}
