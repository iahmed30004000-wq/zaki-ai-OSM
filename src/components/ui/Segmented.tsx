'use client';

import React, { useEffect, useRef } from 'react';
import clsx from 'clsx';

/**
 * TWO TO FIVE CHOICES, ONE OF THEM TRUE, IN ONE COMPACT BAR.
 *
 * «اليوم / أمس», «الكل / الجديدة», «جدول / بطاقات»: twenty-five screens
 * draw this by hand as a row of buttons, and most of them say nothing to a
 * screen reader and ignore the arrow keys. It is not a set of tabs (`Tabs`
 * switches a PANEL and may be nine long, with a counter) — this switches a
 * VALUE of the screen you are already on, and stays short.
 *
 * A RADIO GROUP, BECAUSE THAT IS WHAT IT IS.
 *
 * Mutually exclusive, exactly one chosen, the choice follows the focus.
 * `role="radiogroup"` with a `role="radio"` per option says that in one
 * breath; `aria-pressed` buttons say «N independent toggles», which is a
 * different promise (and the 38 hand-made ones of those are not this).
 *
 * ONE STOP ON THE WAY DOWN THE PAGE. The chosen option takes the Tab stop
 * (the roving `tabIndex`); the arrows move inside. With nothing chosen, the
 * first option that can be chosen takes it.
 *
 * WHICH WAY IS «NEXT». The bar is drawn in the page's direction, so in a
 * right-to-left page the option to the LEFT of the focused one is the next
 * in the list, and the left arrow goes there. Following the key's raw
 * direction in both layouts would move the highlight against the arrow in
 * one of them. Down is always next and up always previous, as in any radio
 * group, and the ends wrap round. A disabled option is jumped over, not
 * stopped on.
 *
 * CONTROLLED ONLY: `value` and `onChange` are both required.
 */
export interface SegmentedOption {
  value: string;
  label: string;
  /** A number (or a short word) after the name — how many are in this one. */
  count?: number | string;
  disabled?: boolean;
}

export interface SegmentedProps {
  options: SegmentedOption[];
  value: string;
  onChange: (value: string) => void;
  /** sm: 32px on a desk · md: 40px. Both are 44px on a phone. */
  size?: 'sm' | 'md';
  /** The bar needs a name: «الفترة», «طريقة العرض»… */
  'aria-label'?: string;
  'aria-labelledby'?: string;
  /** Every option at once. */
  disabled?: boolean;
  className?: string;
}

/**
 * The direction THIS bar is drawn in. A `dir` on it or above it decides;
 * with none, the computed style does; and a layout that says nothing is the
 * product's own, which is right-to-left.
 */
function isRtl(el: HTMLElement): boolean {
  const dir = el.closest('[dir]')?.getAttribute('dir');
  if (dir === 'rtl') return true;
  if (dir === 'ltr') return false;
  return getComputedStyle(el).direction !== 'ltr';
}

export function Segmented({
  options,
  value,
  onChange,
  size = 'md',
  disabled = false,
  className,
  ...aria
}: SegmentedProps) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const off = (i: number) => disabled || !!options[i]?.disabled;

  useEffect(() => {
    // A bar of one is not a choice and a bar of eight is not compact: the
    // right control for those is a checkbox and a dropdown. Said once, at
    // the desk where it is written, and never on a customer's screen.
    if (process.env.NODE_ENV !== 'production' && (options.length < 2 || options.length > 5)) {
      console.warn(`Segmented: ${options.length} options — the kit holds 2 to 5.`);
    }
  }, [options.length]);

  const chosen = options.findIndex((o, i) => o.value === value && !off(i));
  const firstOpen = options.findIndex((_, i) => !off(i));
  const stop = chosen !== -1 ? chosen : firstOpen;

  const go = (i: number) => {
    if (i < 0 || off(i)) return;
    // Focus first and on the spot: the roving stop follows on the next
    // render, and a button with `tabIndex=-1` takes focus from a script.
    refs.current[i]?.focus();
    if (options[i].value !== value) onChange(options[i].value);
  };

  /** The next option that can be chosen, walking `step` and wrapping round. */
  const walk = (from: number, step: 1 | -1) => {
    for (let n = 1; n <= options.length; n++) {
      const i = (((from + step * n) % options.length) + options.length) % options.length;
      if (!off(i)) return i;
    }
    return -1;
  };

  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const radio = (e.target as HTMLElement).closest<HTMLElement>('[role="radio"]');
    if (!radio) return;
    const from = Number(radio.dataset.i);
    const rtl = isRtl(e.currentTarget);

    let target = -1;
    if (e.key === 'ArrowDown') target = walk(from, 1);
    else if (e.key === 'ArrowUp') target = walk(from, -1);
    else if (e.key === 'ArrowLeft') target = walk(from, rtl ? 1 : -1);
    else if (e.key === 'ArrowRight') target = walk(from, rtl ? -1 : 1);
    else if (e.key === 'Home') target = firstOpen;
    else if (e.key === 'End') target = options.reduce((last, _, i) => (off(i) ? last : i), -1);
    else return;

    e.preventDefault();
    go(target);
  };

  return (
    <div
      role="radiogroup"
      onKeyDown={onKey}
      className={clsx(
        'inline-flex max-w-full gap-0.5 rounded-lg border border-[var(--sys-border)] bg-[var(--sys-surface)] p-0.5',
        className
      )}
      {...aria}
    >
      {options.map((opt, i) => {
        const on = i === chosen || (chosen === -1 && opt.value === value);
        return (
          <button
            key={opt.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            data-i={i}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={off(i)}
            tabIndex={i === stop ? 0 : -1}
            onClick={() => go(i)}
            className={clsx(
              // `min-h`, not `h`: a long Arabic name wraps inside its own
              // option and the bar grows, rather than scrolling sideways.
              'min-w-0 flex-1 rounded-md px-3 py-1 text-center font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
              size === 'sm' ? 'min-h-11 md:min-h-0 md:py-2 text-xs' : 'min-h-11 md:min-h-10 text-sm',
              on
                ? 'bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)]'
                : 'text-[var(--sys-muted-foreground)] hover:text-[var(--sys-heading)]'
            )}
          >
            {opt.label}
            {opt.count !== undefined && (
              <span className="ms-1.5 tabular-nums text-xs opacity-80">{opt.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
