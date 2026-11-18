'use client';

import React, { useEffect, useId, useRef } from 'react';
import clsx from 'clsx';

/**
 * A TICK BOX THAT IS A TICK BOX.
 *
 * Seventy-six hand-written checkbox inputs across the screens, in
 * dozens of shapes: some with a label that points at nothing, some with a
 * 14px box and no row around it, some with a hint written as a loose
 * paragraph. This is the one shape the screens move onto.
 *
 * A REAL INPUT, RESTYLED — NEVER A DIV.
 *
 * The box is the browser's own checkbox, coloured by the system's accent
 * token. A div dressed as a checkbox loses the form, the keyboard (Space),
 * the screen reader's «مربّع اختيار, محدّد» and autofill's «remember me» all
 * at once, and every one of those has to be rebuilt by hand and re-proved.
 *
 * THE ROW IS THE TARGET, NOT THE BOX.
 *
 * `.tap-safe` grows a hit area with a pseudo-element, and a checkbox is a
 * replaced element that never draws one (touch-targets.test.ts says so).
 * So the whole `<label>` is the thing a finger hits: pressing the words
 * toggles the box, and on a phone the row is 44px tall. A real box has no
 * pseudo-element to overlap its neighbour with, so two rows 8px apart stay
 * two targets.
 *
 * CONTROLLED ONLY. `checked` and `onChange` are both required: every screen
 * that holds a tick holds it in state already (it is sent somewhere), and a
 * second, hidden copy inside the input is how the box and the data disagree.
 *
 * INDETERMINATE is a property of the DOM node, not an attribute — there is
 * no HTML to write for it — so it is set after every render. It is the
 * «بعضها محدّد» state of a select-all box, and a click on it ticks it.
 */
export interface CheckboxProps
  extends Omit<
    React.InputHTMLAttributes<HTMLInputElement>,
    'type' | 'size' | 'checked' | 'defaultChecked' | 'onChange' | 'className'
  > {
  checked: boolean;
  onChange: (checked: boolean, e: React.ChangeEvent<HTMLInputElement>) => void;
  /** The words beside the box. Without them, pass `aria-label`. */
  label?: React.ReactNode;
  /** A sentence under the words: the rule, not the question. */
  hint?: string;
  /** Replaces the hint, in the destructive colour, and marks the box invalid. */
  error?: string;
  /** «بعضها محدّد» — the box is neither ticked nor clear. */
  indeterminate?: boolean;
  /** For the wrapper (spacing in a form), not the input. */
  className?: string;
}

export function Checkbox({
  checked,
  onChange,
  label,
  hint,
  error,
  indeterminate = false,
  disabled,
  id,
  className,
  'aria-describedby': describedBy,
  ...props
}: CheckboxProps) {
  const autoId = useId();
  const inputId = id || props.name || autoId;
  const noteId = `${inputId}-note`;
  const box = useRef<HTMLInputElement>(null);

  // No dependency list on purpose: a click makes the browser clear the flag
  // by itself, and this puts it back whenever the screen still says so.
  useEffect(() => {
    if (box.current) box.current.indeterminate = indeterminate;
  });

  const note = error || hint;
  const described = [note ? noteId : undefined, describedBy].filter(Boolean).join(' ') || undefined;

  return (
    <div className={clsx('min-w-0', className)}>
      <label
        htmlFor={inputId}
        className={clsx(
          // 44px tall and wide on a phone, from the row and not from the
          // box; the desk has no such rule. `items-start` keeps the box
          // beside the FIRST line when a long Arabic label wraps.
          'inline-flex min-h-11 min-w-11 max-w-full items-start justify-center gap-2.5 py-3 md:min-h-0 md:min-w-0 md:py-2'
        )}
        // Inline, not classes: these two states are the only reason the
        // stylesheet would otherwise grow, and it is held to a ceiling.
        style={disabled ? { cursor: 'not-allowed', opacity: 0.5 } : { cursor: 'pointer' }}
      >
        <input
          {...props}
          ref={box}
          id={inputId}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked, e)}
          aria-invalid={error ? true : undefined}
          aria-describedby={described}
          style={{ cursor: 'inherit' }}
          className="h-5 w-5 shrink-0 accent-[var(--sys-primary)]"
        />
        {label !== undefined && label !== null && label !== false && (
          <span className="min-w-0 text-sm text-[var(--sys-heading)]">{label}</span>
        )}
      </label>
      {note && (
        <p
          id={noteId}
          className={clsx(
            'text-xs mt-1',
            error ? 'text-[var(--sys-destructive)]' : 'text-[var(--sys-muted-foreground)]'
          )}
        >
          {note}
        </p>
      )}
    </div>
  );
}
