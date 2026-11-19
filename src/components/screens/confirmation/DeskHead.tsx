'use client';

import React from 'react';
import { RiLoader4Line, RiRefreshLine } from '@remixicon/react';
import { Button } from '@/components/ui/Button';

/**
 * THE TOP OF «طلباتي», UNDER ITS TITLE — moved out of `ConfirmationMineScreen.tsx` in R8b (18/11), on the kit, nothing else changed.
 *
 *   «شاشة موظفة»   the picker of the colleagues this reader may watch (`desk-watch.ts`), and «تحديث»
 *   «قراءة بس»     the line that says whose desk is on screen when it is not hers
 *   «الشغل أول»    what she owes, at the top — the server's sentence (`due`), never one written here
 *   «أرجِع «لا يرد» للطابور»  the one press a watcher makes on a colleague's desk, with the server's count beside it
 *
 * PRESENTATION ONLY. The screen keeps the state, the reads, the handlers and every «may she»: it hands this the picker's names, the
 * banner only when it is to be drawn, and the return pile only for a holder of the key its door asks (`orders.unlock`) — `null`
 * otherwise. Nothing here reads the session, asks a permission or calls the server (`the-desk-head-is-presentation.test.tsx`).
 */

/** One name in the «شاشة موظفة» picker, with what she holds open now. */
export interface DeskHeadAgent {
  id: string;
  name: string;
  holding: number;
}

/** What «أرجِع «لا يرد» للطابور» would do from here — the server's count and arithmetic (`return-no-answer-pile.ts`). */
export interface DeskHeadReturnPile {
  eligible: number;
  thisPress: number;
  remainingAfter: number;
}

export function DeskHead({
  desks,
  watchedId,
  onWatch,
  refreshing,
  onRefresh,
  readOnly,
  watchedName,
  due,
  returnPile,
  returning,
  onReturnPile,
}: {
  /** The colleagues she may watch. Null or empty: no picker (she may watch nobody). */
  desks: DeskHeadAgent[] | null;
  /** The desk on screen: a colleague's id, or `''` for her own. */
  watchedId: string;
  onWatch: (id: string) => void;
  refreshing: boolean;
  onRefresh: () => void;
  /** A colleague's desk is on screen. */
  readOnly: boolean;
  watchedName: string;
  /** «الشغل أول» — passed only when the screen draws it; `count > 0` is the warning tone, otherwise the all-clear. */
  due: { count: number; sentence?: string | null } | null;
  /** The watcher's return press — passed only on a colleague's desk, with the server's plan, for the key's holder. */
  returnPile: DeskHeadReturnPile | null;
  returning: boolean;
  onReturnPile: () => void;
}) {
  return (
    <>
      {desks && desks.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="desk-watch" className="text-note font-medium text-[var(--sys-muted-foreground)]">
            شاشة موظفة
          </label>
          <select
            id="desk-watch"
            value={watchedId}
            onChange={(e) => onWatch(e.target.value)}
            className="h-11 md:h-10 w-56 px-3 rounded-lg border border-[var(--sys-border-input)] bg-[var(--sys-card)] text-sm"
          >
            <option value="">شاشتي أنا</option>
            {desks.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} ({d.holding})
              </option>
            ))}
          </select>
          <Button variant="secondary" size="sm" onClick={() => onRefresh()} disabled={refreshing}>
            {refreshing ? <RiLoader4Line className="w-4 h-4 animate-spin" /> : <RiRefreshLine className="w-4 h-4" />}
            تحديث
          </Button>
        </div>
      )}
      {readOnly && (
        <p role="status" className="text-sm text-[var(--sys-warning)] bg-[var(--sys-warning-soft)] border border-[var(--sys-warning)]/30 rounded-lg p-3">
          عم تشوف شاشة {watchedName} — قراءة بس
        </p>
      )}
      {due && (
        <p
          className={`text-sm border rounded-lg p-3 ${
            due.count > 0
              ? 'text-[var(--sys-warning)] bg-[var(--sys-warning-soft)] border-[var(--sys-warning)]/30'
              : 'text-[var(--sys-success)] bg-[var(--sys-success-soft)] border-[var(--sys-success)]/30'
          }`}
        >
          {due.sentence}
        </p>
      )}
      {returnPile && (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => onReturnPile()} disabled={returning || returnPile.eligible === 0}>
            {returning && <RiLoader4Line className="w-4 h-4 animate-spin" />}
            أرجِع «لا يرد» للطابور
          </Button>
          <span className="text-note font-medium text-[var(--sys-muted-foreground)]">
            {returnPile.eligible === 0
              ? 'ما في «لا يرد» يرجع هلأ — اللي عليه موعد أو اللي ردّ زبونه بيضل عندها'
              : returnPile.remainingAfter > 0
                ? `${returnPile.eligible} طلب «لا يرد» يرجعوا — ${returnPile.thisPress} بكل ضغطة`
                : `${returnPile.eligible} طلب «لا يرد» يرجعوا`}
          </span>
        </div>
      )}
    </>
  );
}
