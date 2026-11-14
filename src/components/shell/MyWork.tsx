'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { iconFor } from '@/components/shell/icons';
import { visibleWork, type WorkItem } from '@/lib/my-work';
import { pollGate } from '@/lib/poll-gate';
import { pollSignal } from '@/lib/poll-timeout';

/**
 * WHAT IS WAITING FOR ME, AT THE TOP OF EVERY SCREEN.
 *
 * This replaces the single confirmation counter rather than standing beside
 * it. That counter was the right idea applied to one role: a shipping clerk
 * with forty parcels ready to go, a warehouse with a pallet of returns
 * nobody has counted in, and an owner with change requests past their
 * deadline all saw a header identical to each other's.
 *
 * The server still decides which numbers a person gets, by permission, and
 * a count is never a list — the rule that counter was written with, kept.
 *
 * ONE ON A PHONE, THREE ON A DESK. «Seven controls in a 375px bar is how a
 * bell gets missed and a logout gets hit» is this header's own comment
 * about itself, and it is right: the phone gets the single most urgent
 * thing and the rest are one tap away in the palette.
 *
 * AND A ZERO IS NOT NEWS. Showing «0 مرتجع» teaches people to stop reading
 * the row, and then the day it says 14 nobody sees it.
 */

const POLL_MS = 60_000;
/** Two returns to the tab closer than this are one: the chips do not need the server twice in fifteen seconds. */
const RETURN_GAP_MS = 15_000;

export function MyWork() {
  const [items, setItems] = useState<WorkItem[]>([]);
  const [gate] = useState(pollGate);

  const fetchOnce = useCallback(async () => {
    try {
      // Plain fetch, on purpose — the same reasoning the counter had:
      // apiJson answers a missing store by sending the whole tab to the
      // store picker, which is right for a click and wrong for a poll that
      // fires on its own and would throw away whatever is being typed.
      // With a time limit, so a server that does not answer cannot hold a connection the next press needs (poll-timeout.ts).
      const res = await fetch('/api/me/work', { credentials: 'same-origin', signal: pollSignal() });
      if (res.ok) setItems(((await res.json()) as { items: WorkItem[] }).items ?? []);
    } catch {
      // A failed poll is not worth a message; the next one will do.
    }
  }, []);

  /** Every call goes through here, so the polls can see whether one is still out. */
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
      // Nothing is polled while nobody is looking.
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (gate.busy(now)) return;
      if (why === 'return') {
        if (now - lastReturn.current < RETURN_GAP_MS) return;
        lastReturn.current = now;
      }
      void load();
    };
    const tick = setInterval(() => poll('tick'), POLL_MS);
    const onShow = () => poll('return');
    document.addEventListener('visibilitychange', onShow);
    return () => {
      clearInterval(tick);
      document.removeEventListener('visibilitychange', onShow);
    };
  }, [load, gate]);

  const many = visibleWork(items, 3);
  if (many.length === 0) return null;
  const one = many.slice(0, 1);

  return (
    <>
      <span className="hidden md:flex items-center gap-2">
        {many.map((w) => (
          <Chip key={w.key} work={w} />
        ))}
      </span>
      <span className="flex md:hidden items-center gap-2">
        {one.map((w) => (
          <Chip key={w.key} work={w} />
        ))}
      </span>
    </>
  );
}

function Chip({ work }: { work: WorkItem }) {
  const Icon = iconFor(work.icon);
  const tone =
    work.tone === 'urgent'
      ? 'border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] text-[var(--sys-destructive)]'
      : 'border-[var(--sys-border)] bg-[var(--sys-surface)] text-[var(--sys-foreground)]';

  const body = (
    <>
      <Icon className="w-4 h-4 shrink-0" aria-hidden />
      <span className="tabular-nums font-bold">{work.count}</span>
      {/* The word is for a desk. On a phone the icon and the number are the
          whole chip — and the title carries the sentence either way. */}
      <span className="hidden lg:inline text-xs font-medium">{work.ar}</span>
    </>
  );

  const className = `min-h-11 md:min-h-0 inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-sm ${tone}`;
  const label = `${work.count} ${work.ar}`;

  /**
   * NO LINK IS A DECISION, NOT AN OMISSION.
   *
   * A moderator's own unconfirmed orders have none: the pool is not theirs
   * to open, and a counter that led to a list would be the list by another
   * door.
   */
  return work.href ? (
    <Link href={work.href} className={`${className} hover:border-[var(--sys-primary)]`} title={label} aria-label={label}>
      {body}
    </Link>
  ) : (
    <span className={className} title={label} aria-label={label}>
      {body}
    </span>
  );
}
