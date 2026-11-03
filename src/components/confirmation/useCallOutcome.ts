'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  OUTBOX_KEY,
  UNDO_MS,
  dropLease,
  isNetworkFailure,
  readOutbox,
  readPending,
  storageWorks,
  takeLease,
  undoable,
  writeOutbox,
  writePending,
  type Outgoing,
  type PendingCall,
} from '@/lib/call-outcome';

/**
 * THE CALL SHE OPENED, AND WHEN SHE CAME BACK FROM IT.
 *
 * The sheet opens the moment «اتصل» is pressed — it never waits for the browser to say anything, because a phone that
 * returns from the dialler may say nothing at all. The browser's word, when it comes (`visibilitychange` · `pageshow` ·
 * `focus`, whichever is first), only adds how long she was away. The call is kept in the phone's storage, so a reload on a
 * cheap phone that dropped the tab still finds the sheet waiting; a reload is itself a return.
 *
 * ONCE IT IS ANSWERED IT IS NO LONGER KEPT (`settle`): a reload after «ما رد» must not offer the same call's answers a
 * second time — that is a second line in the log for one call. «تراجع» puts it back (`unsettle`).
 */
export function usePendingCall(userId: string | null) {
  const [pending, setPending] = useState<PendingCall | null>(null);
  const [backAt, setBackAt] = useState<number | null>(null);

  useEffect(() => {
    if (!userId) return;
    const kept = readPending(userId);
    if (kept) {
      setPending(kept);
      setBackAt(Date.now());
    }
  }, [userId]);

  useEffect(() => {
    if (!pending || backAt !== null) return;
    const back = (e: Event) => {
      if (e.type === 'focus' && e.target !== window) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      setBackAt((b) => b ?? Date.now());
    };
    document.addEventListener('visibilitychange', back);
    window.addEventListener('pageshow', back);
    window.addEventListener('focus', back);
    return () => {
      document.removeEventListener('visibilitychange', back);
      window.removeEventListener('pageshow', back);
      window.removeEventListener('focus', back);
    };
  }, [pending, backAt]);

  const start = useCallback(
    (orderId: string) => {
      if (!userId) return;
      const p: PendingCall = { orderId, startedAt: Date.now(), userId };
      writePending(p);
      setPending(p);
      setBackAt(null);
    },
    [userId]
  );

  const clear = useCallback(() => {
    writePending(null);
    setPending(null);
    setBackAt(null);
  }, []);

  /** Answered: the sheet stays for what follows, but a reload no longer brings the question back. */
  const settle = useCallback(() => writePending(null), []);
  /** «تراجع»: the question is open again, and kept again. */
  const unsettle = useCallback(() => {
    if (pending) writePending(pending);
  }, [pending]);

  const awayMs = pending && backAt !== null ? Math.max(0, backAt - pending.startedAt) : null;
  return { pending, awayMs, start, clear, settle, unsettle };
}

/** A send whose line dropped is tried again after this long, if the connection has not come back before it. */
const RETRY_MS = 15_000;
const LOCK_NAME = 'osm.confirmation.outbox';

/** What a send came to: written, refused by the door (said by the caller), or the line was not there. */
export type SendAnswer = 'sent' | 'refused' | 'network';

type LockManagerLike = {
  request: (name: string, options: { ifAvailable: boolean }, cb: (lock: unknown) => Promise<unknown>) => Promise<unknown>;
};

/**
 * ONE TAB SENDS. Two desk tabs on one phone read the same waiting answers; whichever holds the lock sends them, and the
 * other finds them gone when it gets its turn. `navigator.locks` where the browser has it (it is let go when a tab dies);
 * a lease in storage, with an expiry, where it does not. `false` = another tab holds it, try on the next tick.
 */
async function underTheLock(tabId: string, fn: () => Promise<void>): Promise<boolean> {
  const locks = (typeof navigator !== 'undefined' ? (navigator as { locks?: LockManagerLike }).locks : undefined) ?? null;
  if (locks && typeof locks.request === 'function') {
    let ran = false;
    await locks.request(LOCK_NAME, { ifAvailable: true }, async (lock) => {
      if (!lock) return;
      ran = true;
      await fn();
    });
    return ran;
  }
  if (!takeLease(tabId)) return false;
  try {
    await fn();
  } finally {
    dropLease(tabId);
  }
  return true;
}

/**
 * THE OUTCOMES ON THEIR WAY — five seconds to take one back, and a dropped line that loses nothing.
 *
 * A tap is not sent at once: it waits `UNDO_MS`, and «تراجع» takes it out of the queue before it ever left — so undoing
 * needs no delete door and writes nothing. Without a connection it waits in memory and in the phone's storage and goes
 * the moment the connection is back.
 *
 * NEVER TWO LINES FOR ONE CALL:
 *   · one outcome per call (`key`); a second one is refused once the first can no longer be taken back;
 *   · the mark `inFlight` is written to storage BEFORE the send leaves, and from it on there is no «تراجع»;
 *   · whoever finds an item marked (a reload, a killed tab) or `uncertain` (an answer lost on the way) asks the log first;
 *   · one tab sends (`underTheLock`), and it reads the list from storage, not from what it remembered.
 */
export function useOutbox(userId: string | null, send: (item: Outgoing) => Promise<SendAnswer>) {
  const [items, setItems] = useState<Outgoing[]>([]);
  const itemsRef = useRef<Outgoing[]>([]);
  /** The flush now running in this tab — a second caller waits for it instead of returning before it has committed. */
  const running = useRef<Promise<void> | null>(null);
  const [tabId] = useState(() => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
  /** What this tab has sent: a key that left is never queued again from here. */
  const sent = useRef(new Set<string>());
  // The newest sender (it reads the desk as drawn now), handed over after each render, never during one.
  const sendRef = useRef(send);
  useEffect(() => {
    sendRef.current = send;
  });
  const [offline, setOffline] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  /** The list as it is now: from storage (another tab may have changed it), or from memory where storage throws. */
  const current = useCallback((): Outgoing[] => {
    if (!userId) return itemsRef.current;
    return storageWorks() ? readOutbox(userId) : itemsRef.current;
  }, [userId]);

  /** Read, change, write — against the list as it is now, never a copy one tab held while another wrote. */
  const mutate = useCallback(
    (fn: (list: Outgoing[]) => Outgoing[]) => {
      const next = fn(current());
      itemsRef.current = next;
      setItems(next);
      if (userId) writeOutbox(userId, next);
      return next;
    },
    [current, userId]
  );

  useEffect(() => {
    if (!userId) return;
    const kept = readOutbox(userId);
    itemsRef.current = kept;
    setItems(kept);
    // Another tab sent or added one: draw what is there now.
    const changed = (e: StorageEvent) => {
      if (e.key !== OUTBOX_KEY && e.key !== null) return;
      const fresh = readOutbox(userId);
      itemsRef.current = fresh;
      setItems(fresh);
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, [userId]);

  const flush = useCallback(
    async (force = false) => {
      // «التالي» (force) waits for a send already on its way, then sends the rest; a tick simply leaves it to that one.
      while (running.current) {
        await running.current;
        if (!force) return;
      }
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        setOffline(itemsRef.current.length > 0);
        return;
      }
      const run = (async () => {
        await underTheLock(tabId, async () => {
          for (;;) {
            const at = Date.now();
            // Under the lock nothing is being sent by anyone else: a marked item is one whose sender died mid-send.
            const due = current().find((o) => o.inFlight || force || o.sendAt <= at);
            if (!due) {
              // Draw what is there now (another tab may have sent some), without writing anything.
              const fresh = current();
              itemsRef.current = fresh;
              setItems(fresh);
              break;
            }
            const doubt = !!(due.uncertain || due.inFlight);
            // Write-ahead: marked in storage before it leaves.
            mutate((list) => list.map((o) => (o.key === due.key ? { ...o, inFlight: true, uncertain: doubt } : o)));
            let answer: SendAnswer;
            try {
              answer = await sendRef.current({ ...due, inFlight: true, uncertain: doubt });
            } catch (e) {
              answer = isNetworkFailure(e) ? 'network' : 'refused';
            }
            if (answer === 'network') {
              // Tried again in fifteen seconds, or the moment the connection is back — and the log is asked first.
              mutate((list) =>
                list.map((o) => (o.key === due.key ? { ...o, inFlight: false, uncertain: true, sendAt: Date.now() + RETRY_MS } : o))
              );
              setOffline(true);
              break;
            }
            sent.current.add(due.key);
            mutate((list) => list.filter((o) => o.key !== due.key));
          }
        });
        if (itemsRef.current.every((o) => !o.uncertain)) setOffline(false);
      })();
      running.current = run;
      try {
        await run;
      } finally {
        if (running.current === run) running.current = null;
      }
    },
    [current, mutate, tabId]
  );

  // The next one due is sent when its five seconds are up (and what a reload kept, within the second); a countdown of
  // whole seconds is drawn meanwhile.
  useEffect(() => {
    if (items.length === 0) return;
    const tick = window.setInterval(() => {
      const at = Date.now();
      // Only while a countdown is on screen: a line waiting for the connection does not redraw the desk every second.
      if (itemsRef.current.some((o) => o.sendAt > at - 1000 && !o.uncertain)) setNow(at);
      if (itemsRef.current.some((o) => o.sendAt <= at || o.inFlight)) void flush();
    }, 1000);
    return () => window.clearInterval(tick);
  }, [items.length, flush]);

  // The connection is back: everything waiting goes — what was due, and what was waiting for the line.
  useEffect(() => {
    const online = () => {
      const at = Date.now();
      mutate((list) => list.map((o) => (o.uncertain ? { ...o, sendAt: at } : o)));
      void flush();
    };
    const gone = () => setOffline(itemsRef.current.length > 0);
    window.addEventListener('online', online);
    window.addEventListener('offline', gone);
    return () => {
      window.removeEventListener('online', online);
      window.removeEventListener('offline', gone);
    };
  }, [flush, mutate]);

  /** Queues one outcome. `false` when this call's outcome has already left (or can no longer be taken back). */
  const add = useCallback(
    (item: Omit<Outgoing, 'sendAt'>): boolean => {
      if (sent.current.has(item.key)) return false;
      const there = current().find((o) => o.key === item.key);
      if (there && !undoable(there)) return false;
      const next: Outgoing = { ...item, sendAt: Date.now() + UNDO_MS };
      setNow(Date.now());
      mutate((list) => [...list.filter((o) => o.key !== item.key), next]);
      return true;
    },
    [current, mutate]
  );

  /** «تراجع»: out of the queue before it ever left. `false` once it has left — then there is nothing to take back. */
  const undo = useCallback(
    (key: string): boolean => {
      const there = current().find((o) => o.key === key);
      if (!there || !undoable(there)) return false;
      mutate((list) => list.filter((o) => o.key !== key));
      return true;
    },
    [current, mutate]
  );

  /** Is this call's outcome still waiting (queued, in flight, or for the line)? */
  const has = useCallback((key: string) => current().some((o) => o.key === key), [current]);

  /** «التالي» does not wait out the five seconds: what she said is sent now, then the next order is pulled. */
  const sendNow = useCallback(() => flush(true), [flush]);

  return { items, offline, now, add, undo, has, sendNow };
}
