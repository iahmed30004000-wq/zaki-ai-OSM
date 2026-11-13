'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { pollSignal } from '@/lib/poll-timeout';
import { pollGate } from '@/lib/poll-gate';

/**
 * ONE POLLER, THREE READERS.
 *
 * The bell wants the list and a badge. The menu wants a number beside each
 * entry. The corner wants to know what has just arrived. All three are the
 * same rows, and three components asking the server separately would be
 * three timers, three answers a second apart, and a badge that disagrees
 * with the list it opens.
 *
 * So the asking happens here, once, and the three read from it.
 *
 * IT STOPS WHEN NOBODY IS LOOKING. A hidden tab asking every minute for a
 * number nobody can see is load with no reader — the bell already knew
 * this, and the rule moves here with the polling.
 */

export interface NotificationRow {
  id: string;
  title: string;
  message: string;
  type: string;
  isRead: boolean;
  link: string | null;
  createdAt: string;
}

interface Payload {
  notifications?: NotificationRow[];
  unreadCount?: number;
  /** Unread, keyed by the screen each points at: { '/orders': 42 }. */
  byRoute?: Record<string, number>;
}

interface Value {
  items: NotificationRow[];
  unreadCount: number;
  byRoute: Record<string, number>;
  /** Arrived since this tab last looked — what the corner shows. */
  arriving: NotificationRow[];
  dismiss: (id: string) => void;
  dismissAll: () => void;
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
  refresh: () => Promise<void>;
}

const Ctx = createContext<Value | null>(null);

export function useNotifications(): Value {
  const ctx = useContext(Ctx);
  if (!ctx) {
    // A screen rendered outside the shell (the login page) asks for none of
    // this; an empty reading is the honest answer, not a crash.
    return {
      items: [],
      unreadCount: 0,
      byRoute: {},
      arriving: [],
      dismiss: () => undefined,
      dismissAll: () => undefined,
      markRead: async () => undefined,
      markAllRead: async () => undefined,
      refresh: async () => undefined,
    };
  }
  return ctx;
}

const POLL_MS = 60_000;
/** Two returns to the tab closer than this are one: the bell does not need the server twice in fifteen seconds. */
const RETURN_GAP_MS = 15_000;

export function NotificationsProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<NotificationRow[]>([]);
  const [unreadCount, setUnread] = useState(0);
  const [byRoute, setByRoute] = useState<Record<string, number>>({});
  const [arriving, setArriving] = useState<NotificationRow[]>([]);

  /**
   * What this tab has already shown in the corner. A card is shown ONCE —
   * a notification that reappears every minute until it is read is not a
   * notification, it is a nag, and people learn to dismiss the corner
   * without reading it.
   */
  const shown = useRef<Set<string>>(new Set());
  /** The first load fills the bell without throwing a stack of cards up. */
  const primed = useRef(false);

  const [gate] = useState(pollGate);

  const fetchOnce = useCallback(async () => {
    try {
      // Plain fetch on purpose (a poll must not send the tab to /login), with a time limit (poll-timeout.ts).
      const res = await fetch('/api/notifications', { signal: pollSignal() });
      if (!res.ok) return;
      const data = (await res.json()) as Payload;
      const rows = data.notifications ?? [];
      setItems(rows);
      setUnread(data.unreadCount ?? 0);
      setByRoute(data.byRoute ?? {});

      const fresh = rows.filter((n) => !n.isRead && !shown.current.has(n.id));
      for (const n of fresh) shown.current.add(n.id);
      // On the first read everything is "new"; showing sixty cards at once
      // would bury the screen. They are in the bell, where they belong.
      if (primed.current && fresh.length > 0) {
        setArriving((cur) => [...fresh, ...cur].slice(0, 5));
      }
      primed.current = true;
    } catch {
      // A failed poll is not worth a message: the next one is a minute away.
    }
  }, []);

  /** Every call goes through here — the timer's, the return's and the press's — so the polls can see whether one is still out. */
  const load = useCallback(() => {
    const call = fetchOnce();
    gate.follow(call, Date.now());
    return call;
  }, [fetchOnce, gate]);

  const lastReturn = useRef(0);

  useEffect(() => {
    void load();
    // A tick or a return waits for a call that is still out (13/11: a slow server was asked again by every open tab), and two
    // returns to the tab within fifteen seconds are one.
    const poll = (why: 'tick' | 'return') => {
      if (document.hidden) return;
      const now = Date.now();
      if (gate.busy(now)) return;
      if (why === 'return') {
        if (now - lastReturn.current < RETURN_GAP_MS) return;
        lastReturn.current = now;
      }
      void load();
    };
    const timer = setInterval(() => poll('tick'), POLL_MS);
    const onShow = () => poll('return');
    document.addEventListener('visibilitychange', onShow);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onShow);
    };
  }, [load, gate]);

  const dismiss = useCallback((id: string) => {
    setArriving((cur) => cur.filter((n) => n.id !== id));
  }, []);

  const dismissAll = useCallback(() => setArriving([]), []);

  const markRead = useCallback(
    async (id: string) => {
      setArriving((cur) => cur.filter((n) => n.id !== id));
      await fetch('/api/notifications', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notificationId: id }),
      }).catch(() => undefined);
      await load();
    },
    [load]
  );

  const markAllRead = useCallback(async () => {
    setArriving([]);
    await fetch('/api/notifications', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markAllRead: true }),
    }).catch(() => undefined);
    await load();
  }, [load]);

  const value = useMemo(
    () => ({ items, unreadCount, byRoute, arriving, dismiss, dismissAll, markRead, markAllRead, refresh: load }),
    [items, unreadCount, byRoute, arriving, dismiss, dismissAll, markRead, markAllRead, load]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
