'use client';

import React from 'react';

/**
 * THE FIRST LOAD FAILED — SAY SO, AND OFFER THE ONE THING THAT HELPS.
 *
 * Three confirmation screens drew «جارٍ التحميل…» until their first answer
 * arrived, and when that answer was an error they kept drawing it: the
 * spinner turned forever, the error sat in state where nothing showed it,
 * and the agent sat in front of a screen that looked busy and was dead.
 * Right after a deploy, when the first request is the one most likely to
 * fail, that was the whole shift's first screen.
 *
 * So the wait ends one of two ways — the screen, or this: what went wrong,
 * in the server's own words, and a button that asks again. Nothing was
 * written by a load, so asking again is always safe.
 */
export function LoadFailed({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center gap-3 text-sm text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] rounded-lg p-4 my-8 text-center"
    >
      <p>{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="h-11 md:h-10 px-5 text-sm font-medium rounded-lg border border-[var(--sys-border-strong)] bg-[var(--sys-card)] text-[var(--sys-foreground)] hover:bg-[var(--sys-surface-strong)]"
      >
        جرّب مرة ثانية
      </button>
    </div>
  );
}
