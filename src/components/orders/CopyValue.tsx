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
 * refuses looks like a fault) — unless the screen passes `whenEmpty`, below.
 *
 * SUCCESS IS SHOWN ON THE BUTTON, NOT IN A TOAST. Twenty-five rows and a
 * few presses each would bury the page under notices. The icon turns to a
 * tick for a second and a half, the accessible name changes, and a status
 * line says it for a screen reader. FAILURE is the opposite: said out loud,
 * with the value in the message so the person can select it by hand.
 *
 * THE PRESS DOES NOT REACH THE ROW. A list row that opens the order on click
 * would otherwise open it every time someone copied a number.
 *
 * THREE OPTIONAL WORDS FOR A SCREEN THAT NEEDS THEM (the shipment follow-up): `title` when the tooltip is a sentence of its
 * own, `onRefused` when a refused copy should be handed to something better than a warning — a dialog with the value in a
 * field to select — and `whenEmpty`, the one exception to «empty draws nothing»: the owner wants the barcode button to
 * stay in its place and be OFF when the parcel has no barcode (10/11), so it is drawn dimmed and not pressable, and the
 * words say why. Left out, all three do what they always did.
 */
const SHOWN_MS = 1500;

export function CopyValue({
  text,
  noun,
  shown,
  label,
  title,
  whenEmpty,
  onRefused,
}: {
  /** What goes on the clipboard — already cleaned. Empty draws nothing. */
  text: string;
  /** What it is, in words: «رقم الطلب» · «رقم هاتف الزبون» · «باركود الشحنة». */
  noun: string;
  /** Appended to the accessible name when the value is not private (the order number). */
  shown?: string;
  /** Visible words beside the icon. Without it the button is the icon alone. */
  label?: string;
  /** The tooltip, when «نسخ <noun>» is not the sentence. */
  title?: string;
  /**
   * Given, an empty `text` draws the button OFF — dimmed, not pressable, this sentence as its tooltip and in its
   * accessible name — instead of nothing. Left out, an empty value still draws nothing.
   */
  whenEmpty?: string;
  /** What to do when neither way of copying worked. Left out: the warning toast that carries the value. */
  onRefused?: (text: string) => void;
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

  // OFF is the same button in the same size — a row does not jump when a barcode arrives — dimmed and not pressable.
  const off = !text;
  if (off && !whenEmpty) return null;

  const size = label ? 'h-11 md:h-8 px-2 gap-1 text-xs' : 'h-11 w-7 min-w-11 md:h-7 md:min-w-0';
  const name = off ? `${noun} — ${whenEmpty}` : shown ? `${noun} ${shown}` : noun;

  async function press(e: MouseEvent) {
    e.stopPropagation();
    if (off) return;
    const ok = await copyText(text);
    if (!ok) {
      if (onRefused) onRefused(text);
      else toast.warn('تعذّر النسخ — انسخه يدوياً', text);
      return;
    }
    if (!alive.current) return;
    // A fast second press restarts the second and a half; it does not stack.
    if (timer.current) clearTimeout(timer.current);
    setCopied(true);
    timer.current = setTimeout(() => setCopied(false), SHOWN_MS);
  }

  const Icon = copied ? RiCheckLine : RiFileCopyLine;
  const look = `inline-flex items-center justify-center rounded-lg border border-[var(--sys-border)] text-[var(--sys-muted-foreground)] ${
    off
      ? 'disabled:opacity-40 disabled:cursor-not-allowed'
      : 'hover:text-[var(--sys-primary)] hover:border-[var(--sys-primary)]/50 transition-colors'
  } ${size}`;

  return (
    <>
      <button
        type="button"
        disabled={off}
        onClick={(e) => void press(e)}
        aria-label={copied ? `تم نسخ ${name}` : `نسخ ${name}`}
        title={off ? whenEmpty : copied ? 'تم النسخ' : (title ?? `نسخ ${noun}`)}
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
