'use client';

import React, { useRef } from 'react';
import clsx from 'clsx';

/**
 * TABS THAT A KEYBOARD CAN REACH.
 *
 * Eight screens keep a `tab` in state. Two of them say `role="tab"`. The
 * other six are rows of buttons that look like tabs and are not: nothing
 * announces them as a set, nothing says which is current, and the arrow
 * keys do nothing — so reaching the fourth tab means four presses of Tab,
 * through every tab before it, on every visit.
 *
 * ARROWS, AND WHICH WAY IS "NEXT".
 *
 * The page is right-to-left, so the tab visually to the LEFT is the next
 * one. Following the DOM order instead would move the highlight the
 * opposite way from the key that was pressed, which is worse than no arrow
 * keys at all.
 *
 * ONE TAB STOP FOR THE WHOLE SET.
 *
 * The roving `tabIndex` is not a nicety: without it a set of nine tabs is
 * nine stops between the top of the page and the content.
 */

export interface TabDef {
  key: string;
  label: string;
  /** A number beside the name — how many are waiting in this one. */
  count?: number;
}

export function Tabs({
  tabs,
  value,
  onChange,
  className,
}: {
  tabs: TabDef[];
  value: string;
  onChange: (key: string) => void;
  className?: string;
}) {
  const strip = useRef<HTMLDivElement>(null);

  const move = (delta: number) => {
    const i = tabs.findIndex((t) => t.key === value);
    if (i === -1) return;
    const next = tabs[(i + delta + tabs.length) % tabs.length];
    onChange(next.key);
    // The highlight follows the selection, so focus must too — otherwise
    // the next arrow press starts from wherever focus was left behind.
    requestAnimationFrame(() => {
      strip.current?.querySelector<HTMLButtonElement>(`[data-tab="${next.key}"]`)?.focus();
    });
  };

  const onKey = (e: React.KeyboardEvent) => {
    // In a right-to-left strip, "the next tab" is the one to the left.
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      move(1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      move(-1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      onChange(tabs[0].key);
    } else if (e.key === 'End') {
      e.preventDefault();
      onChange(tabs[tabs.length - 1].key);
    }
  };

  return (
    <div
      ref={strip}
      role="tablist"
      onKeyDown={onKey}
      className={clsx(
        // Scrolls rather than wraps: a strip that wraps to two rows moves
        // the content under it every time the count changes.
        'flex gap-1 overflow-x-auto border-b border-[var(--sys-border)]',
        className
      )}
    >
      {tabs.map((tab) => {
        const on = tab.key === value;
        return (
          <button
            key={tab.key}
            data-tab={tab.key}
            type="button"
            role="tab"
            aria-selected={on}
            // One stop for the set. The arrows do the rest.
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(tab.key)}
            className={clsx(
              'min-h-11 md:min-h-0 shrink-0 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm transition-colors',
              on
                ? 'border-[var(--sys-primary)] font-semibold text-[var(--sys-primary)]'
                : 'border-transparent text-[var(--sys-muted-foreground)] hover:text-[var(--sys-heading)]'
            )}
          >
            {tab.label}
            {tab.count !== undefined && (
              // Never a dot: a count answers "is it worth opening" and a dot
              // only says "something".
              <span className="ms-1.5 tabular-nums text-xs text-[var(--sys-muted)]">{tab.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
