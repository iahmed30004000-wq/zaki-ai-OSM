'use client';

import React, { useEffect, useId, useRef, useState } from 'react';
import clsx from 'clsx';
import { RiLoader4Line } from '@remixicon/react';
import { hapticConfirm, hapticRefuse } from '@/lib/haptics';

/**
 * AN ON/OFF SETTING THAT TAKES EFFECT THE MOMENT IT IS PRESSED.
 *
 * A tick box says «this will be sent when I press save». A switch says
 * «this is already true». The difference matters because a switch is a
 * request to the server, and a request can fail or be slow — so a switch
 * that only flips on screen is a switch that lies for as long as the
 * request is in the air, and for good if it was refused.
 *
 * THE PROMISE IS THE FLAG — the same rule `Button` lives by.
 *
 * `onChange` may return a promise. While it is pending the switch shows a
 * spinner in its knob and ignores every further press, so a second press
 * can never send a second request while the first is out. The switch keeps
 * showing the OLD value until the screen passes down the new one: there is
 * no optimistic path here, for the same reason there is none in `Button` —
 * a setting that says «on» while the server says «off» is worse than a
 * setting that takes a second.
 *
 * If the promise is refused, the switch stays where it was and says so in a
 * line under it (`failureText`, or a default). It does not vanish after a
 * moment: a setting that did not save is something the person has to read.
 *
 * STILL A REAL CHECKBOX UNDER THE LOOK. `role="switch"` changes what a
 * screen reader announces («مفتاح, مفعّل»), not how the keyboard works:
 * Space toggles, a label press toggles, and the focus ring is the one rule
 * `system.css` draws for every input.
 *
 * WHY THE PRESS IS LOCKED BY A REF AND NOT ONLY BY `disabled`. A native
 * `disabled` removes focus from the control, and inside a Modal that sends
 * the keyboard back to the top of the page in the middle of a save. So a
 * pending switch is `aria-disabled` and keeps focus; the lock that makes a
 * second press impossible is a ref set in the same tick as the first, which
 * state (still the old value in the next event of the same tick) cannot be.
 *
 * CONTROLLED ONLY: `checked` and `onChange` are both required.
 */
export interface SwitchProps
  extends Omit<
    React.InputHTMLAttributes<HTMLInputElement>,
    'type' | 'size' | 'role' | 'checked' | 'defaultChecked' | 'onChange' | 'className'
  > {
  checked: boolean;
  /**
   * Receives the value being asked for. Return a promise and the switch
   * waits for it; return anything else and the change is taken as done.
   */
  onChange: (next: boolean) => unknown;
  /** The words beside the switch. Without them, pass `aria-label`. */
  label?: React.ReactNode;
  hint?: string;
  /** An error the screen knows about; replaces the hint. */
  error?: string;
  /** What to say when `onChange` was refused. */
  failureText?: string;
  className?: string;
}

const DEFAULT_FAILURE = 'تعذّر الحفظ، حاول مرة ثانية';

export function Switch({
  checked,
  onChange,
  label,
  hint,
  error,
  failureText = DEFAULT_FAILURE,
  disabled,
  id,
  className,
  'aria-describedby': describedBy,
  ...props
}: SwitchProps) {
  const autoId = useId();
  const inputId = id || props.name || autoId;
  const noteId = `${inputId}-note`;

  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const alive = useRef(true);
  // The inner lock: set synchronously, so two presses in one tick still
  // send one request.
  const inFlight = useRef(false);

  useEffect(
    () => () => {
      alive.current = false;
    },
    []
  );

  const refuse = () => {
    hapticRefuse();
    if (alive.current) setFailed(true);
  };

  const handle = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (disabled || inFlight.current) return;
    const next = e.target.checked;
    setFailed(false);

    let result: unknown;
    try {
      result = onChange(next);
    } catch {
      refuse();
      return;
    }
    if (!result || typeof (result as Promise<unknown>).then !== 'function') return;

    inFlight.current = true;
    setBusy(true);
    void (result as Promise<unknown>)
      .then(() => {
        hapticConfirm();
      })
      .catch(refuse)
      .finally(() => {
        inFlight.current = false;
        if (alive.current) setBusy(false);
      });
  };

  const shownError = error || (failed ? failureText : undefined);
  const note = shownError || hint;
  const described = [note ? noteId : undefined, describedBy].filter(Boolean).join(' ') || undefined;
  const locked = !!disabled || busy;

  return (
    <div className={clsx('min-w-0', className)}>
      <label
        htmlFor={inputId}
        className={clsx(
          // 44px tall on a phone from the row; the track is 24px and the
          // row grows around it. `items-start` keeps the track beside the
          // FIRST line of a label that wraps.
          'inline-flex min-h-11 max-w-full items-start gap-3 py-2.5 md:min-h-0 md:py-2'
        )}
        // Inline, not classes: these few states are the only reason the
        // stylesheet would otherwise grow, and it is held to a ceiling.
        style={{ cursor: locked ? 'not-allowed' : 'pointer' }}
      >
        <span className="relative inline-flex h-6 w-11 shrink-0">
          <input
            {...props}
            id={inputId}
            type="checkbox"
            role="switch"
            checked={checked}
            aria-checked={checked}
            disabled={disabled}
            aria-disabled={busy || undefined}
            aria-busy={busy || undefined}
            aria-describedby={described}
            onChange={handle}
            // The global focus rule sets the card radius on a focused
            // input, and it is unlayered, so it beats `rounded-full`: the
            // pill would square off while it has focus. Stated inline, with
            // the track's colour and the bare appearance.
            style={{
              appearance: 'none',
              WebkitAppearance: 'none',
              borderRadius: '9999px',
              cursor: 'inherit',
              opacity: locked ? 0.5 : 1,
              backgroundColor: checked ? 'var(--sys-primary)' : 'var(--sys-border-input)',
            }}
            className="h-6 w-11 shrink-0 transition-colors"
          />
          <span
            aria-hidden
            // The knob rests at the END when on, in either direction.
            style={{ insetInlineStart: checked ? '1.375rem' : '0.125rem' }}
            className="pointer-events-none absolute top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-[var(--sys-card)]"
          >
            {busy && <RiLoader4Line className="h-4 w-4 animate-spin text-[var(--sys-muted-foreground)]" />}
          </span>
        </span>
        {label !== undefined && label !== null && label !== false && (
          // The line is 24px so the first line is centred on the 24px track.
          <span className="min-w-0 text-sm leading-6 text-[var(--sys-heading)]">{label}</span>
        )}
      </label>
      {note && (
        <p
          id={noteId}
          role={shownError ? 'alert' : undefined}
          className={clsx(
            'text-xs mt-1',
            shownError ? 'text-[var(--sys-destructive)]' : 'text-[var(--sys-muted-foreground)]'
          )}
        >
          {note}
        </p>
      )}
      {/* Said aloud while the request is out; nothing is drawn. */}
      <span role="status" className="sr-only">
        {busy ? 'جارٍ الحفظ' : ''}
      </span>
    </div>
  );
}
