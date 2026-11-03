'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  UNDO_MS,
  isNetworkFailure,
  readOutbox,
  readPending,
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

  const awayMs = pending && backAt !== null ? Math.max(0, backAt - pending.startedAt) : null;
  return { pending, awayMs, start, clear };
}

/** A send whose line dropped is tried again after this long, if the connection has not come back before it. */
const RETRY_MS = 15_000;

/** What a send came to: written, refused by the door (said by the caller), or the line was not there. */
export type SendAnswer = 'sent' | 'refused' | 'network';

/**
 * THE OUTCOMES ON THEIR WAY — five seconds to take one back, and a dropped line that loses nothing.
 *
 * A tap is not sent at once: it waits `UNDO_MS`, and «تراجع» takes it out of the queue before it ever left — so undoing
 * needs no delete door and writes nothing. Without a connection it waits in memory and in the phone's storage and goes
 * the moment the connection is back. One outcome per call (`key`), so a second tap replaces the first, and a resend
 * whose first answer was lost asks the log first (`uncertain`, see `alreadyLogged`).
 */
export function useOutbox(userId: string | null, send: (item: Outgoing) => Promise<SendAnswer>) {
  const [items, setItems] = useState<Outgoing[]>([]);
  const itemsRef = useRef<Outgoing[]>([]);
  const sending = useRef(false);
  // The newest sender (it reads the desk as drawn now), handed over after each render, never during one.
  const sendRef = useRef(send);
  useEffect(() => {
    sendRef.current = send;
  });
  const [offline, setOffline] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const commit = useCallback(
    (next: Outgoing[]) => {
      itemsRef.current = next;
      setItems(next);
      if (userId) writeOutbox(userId, next);
    },
    [userId]
  );

  useEffect(() => {
    if (!userId) return;
    const kept = readOutbox(userId);
    itemsRef.current = kept;
    setItems(kept);
  }, [userId]);

  const flush = useCallback(
    async (force = false) => {
      if (sending.current) return;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        setOffline(itemsRef.current.length > 0);
        return;
      }
      sending.current = true;
      try {
        for (;;) {
          const at = Date.now();
          const due = itemsRef.current.find((o) => force || o.sendAt <= at);
          if (!due) break;
          let answer: SendAnswer;
          try {
            answer = await sendRef.current(due);
          } catch (e) {
            answer = isNetworkFailure(e) ? 'network' : 'refused';
          }
          if (answer === 'network') {
            // Tried again in fifteen seconds, or the moment the connection is back — whichever is first.
            commit(itemsRef.current.map((o) => (o.key === due.key ? { ...o, uncertain: true, sendAt: Date.now() + RETRY_MS } : o)));
            setOffline(true);
            break;
          }
          commit(itemsRef.current.filter((o) => o.key !== due.key));
        }
        if (itemsRef.current.every((o) => !o.uncertain)) setOffline(false);
      } finally {
        sending.current = false;
      }
    },
    [commit]
  );

  // The next one due is sent when its five seconds are up (and what a reload kept, within the second); a countdown of
  // whole seconds is drawn meanwhile.
  useEffect(() => {
    if (items.length === 0) return;
    const tick = window.setInterval(() => {
      const at = Date.now();
      // Only while a countdown is on screen: a line waiting for the connection does not redraw the desk every second.
      if (itemsRef.current.some((o) => o.sendAt > at - 1000 && !o.uncertain)) setNow(at);
      if (itemsRef.current.some((o) => o.sendAt <= at)) void flush();
    }, 1000);
    return () => window.clearInterval(tick);
  }, [items.length, flush]);

  // The connection is back: everything waiting goes — what was due, and what was waiting for the line.
  useEffect(() => {
    const online = () => {
      const at = Date.now();
      commit(itemsRef.current.map((o) => (o.uncertain ? { ...o, sendAt: at } : o)));
      void flush();
    };
    const gone = () => setOffline(itemsRef.current.length > 0);
    window.addEventListener('online', online);
    window.addEventListener('offline', gone);
    return () => {
      window.removeEventListener('online', online);
      window.removeEventListener('offline', gone);
    };
  }, [flush, commit]);

  const add = useCallback(
    (item: Omit<Outgoing, 'sendAt'>) => {
      const next: Outgoing = { ...item, sendAt: Date.now() + UNDO_MS };
      setNow(Date.now());
      commit([...itemsRef.current.filter((o) => o.key !== item.key), next]);
    },
    [commit]
  );

  /** «تراجع»: out of the queue before it ever left. Nothing to take back from a door. */
  const undo = useCallback(
    (key: string) => {
      commit(itemsRef.current.filter((o) => o.key !== key));
    },
    [commit]
  );

  /** «التالي» does not wait out the five seconds: what she said is sent now, then the next order is pulled. */
  const sendNow = useCallback(() => flush(true), [flush]);

  return { items, offline, now, add, undo, sendNow };
}
