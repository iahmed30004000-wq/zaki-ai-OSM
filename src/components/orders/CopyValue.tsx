'use client';

import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { RiCheckLine, RiFileCopyLine } from '@remixicon/react';
import { copyText } from '@/lib/clipboard';
import { useToast } from '@/components/ui/Toast';

/**
 * ONE BUTTON, ONE VALUE, COPIED.
 *
 * It writes nothing and asks nothing: no request, no audit line, no
 * «contact attempt». Copying a number a row already shows reads nothing the
 * screen had not already been given, and a copy must never count as having
 * called the customer — the confirmation desk unlocks its buttons on that
 * count (see `OrderRef`).
 *
 * THE TEXT IS PASSED IN READY. This component does not clean, guess or
 * complete it — `lib/copy-values.ts` is where «what is copied» is decided,
 * and an empty value draws NOTHING (not a greyed button: a button that
 * refuses looks like a fault).
 *
 * SUCCESS IS SHOWN ON THE BUTTON, NOT IN A TOAST. Twenty-five rows and a
 * few presses each would bury the page under notices. The icon turns to a
 * tick for a second and a half, the accessible name changes, and a status
 * line says it for a screen reader. FAILURE is the opposite: said out loud,
 * with the value in the message so the person can select it by hand.
 *
 * THE PRESS DOES NOT REACH THE ROW. A list row that opens the order on click
 * would otherwise open it every time someone copied a number.
 */
const SHOWN_MS = 1500;

export function CopyValue({
  text,
  noun,
  shown,
  label,
}: {
  /** What goes on the clipboard — already cleaned. Empty draws nothing. */
  text: string;
  /** What it is, in words: «رقم الطلب» · «رقم هاتف الزبون» · «باركود الشحنة». */
  noun: string;
  /** Appended to the accessible name when the value is not private (the order number). */
  shown?: string;
  /** Visible words beside the icon. Without it the button is the icon alone. */
  label?: string;
}) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);

  // A timer outliving the row would set state on nothing.
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  if (!text) return null;

  const name = shown ? `${noun} ${shown}` : noun;

  async function press(e: MouseEvent) {
    e.stopPropagation();
    const ok = await copyText(text);
    if (!ok) {
      toast.warn('تعذّر النسخ — انسخه يدوياً', text);
      return;
    }
    if (!alive.current) return;
    // A fast second press restarts the second and a half; it does not stack.
    if (timer.current) clearTimeout(timer.current);
    setCopied(true);
    timer.current = setTimeout(() => setCopied(false), SHOWN_MS);
  }

  const Icon = copied ? RiCheckLine : RiFileCopyLine;
  const look = `inline-flex items-center justify-center rounded-lg border border-[var(--sys-border)] text-[var(--sys-muted-foreground)] hover:text-[var(--sys-primary)] hover:border-[var(--sys-primary)]/50 transition-colors ${
    label ? 'h-11 md:h-8 px-2 gap-1 text-xs' : 'h-11 w-7 min-w-11 md:h-7 md:min-w-0'
  }`;

  return (
    <>
      <button
        type="button"
        onClick={(e) => void press(e)}
        aria-label={copied ? `تم نسخ ${name}` : `نسخ ${name}`}
        title={copied ? 'تم النسخ' : `نسخ ${noun}`}
        className={look}
      >
        <Icon className="w-4 h-4" aria-hidden />
        {label}
      </button>
      {/* Present from the start: a live region announces what is put INTO
          it, and one that appears with its text is often not announced. */}
      <span role="status" className="sr-only">
        {copied ? `تم نسخ ${noun}` : ''}
      </span>
    </>
  );
}
