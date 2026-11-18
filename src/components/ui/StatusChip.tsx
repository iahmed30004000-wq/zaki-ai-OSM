'use client';

import React from 'react';
import clsx from 'clsx';
import { STATE_LABEL_AR, STATE_TONE, type CoreState, type StateTone } from '@/lib/order-state';
import { BENCH_CONFIRMED_AR } from '@/lib/bench-label';

/**
 * ONE CHIP, AND THE WORD COMES FROM ONE PLACE.
 *
 * A state is a thing the business decided, not a thing a screen decides how
 * to say. There were three sayings of it — order-state.ts, a second map
 * inside the orders badge, and a third in ui/Badge reading the legacy
 * `status` column — and six of the sixteen states were spelled differently
 * between the first two. The same order read «مسلَّم» in the list and «تم
 * التسليم» on its own page.
 *
 * So the word and the tone both come from `order-state.ts`, and this draws
 * them. Nothing here decides what a state means.
 *
 * FOUR TONES, AND EVERY COLOUR A TOKEN.
 *
 * The old badge carried `border-blue-100` and `border-purple-100` — raw
 * palette steps that belong to no theme, so they stayed the same pale blue
 * whichever of the three a person chose. A chip that ignores the theme is a
 * chip that looks pasted on in two of them.
 */

const TONES: Record<StateTone, string> = {
  neutral: 'bg-[var(--sys-surface)] text-[var(--sys-foreground)] border-[var(--sys-border)]',
  good: 'bg-[var(--sys-success-soft)] text-[var(--sys-success)] border-[var(--sys-success)]/30',
  warn: 'bg-[var(--sys-warning-soft)] text-[var(--sys-warning)] border-[var(--sys-warning)]/30',
  bad: 'bg-[var(--sys-destructive-soft)] text-[var(--sys-destructive)] border-[var(--sys-destructive-border)]',
};

/**
 * THE FOUR TONES AS THEIR PARTS, for a caller that is not a chip.
 *
 * The dashboard's status tiles are a number, a dot and a label — not a
 * chip — so they cannot use the class string above. They were choosing
 * their own colours instead, and three of the seven disagreed with
 * `STATE_TONE`: NEW, CONTACTING and SHIPPED were painted with the accent,
 * which `order-state.ts` rules out by name — «there is no informational
 * blue — the action colour is already in the blue family, and a chip
 * painted the same family as a button is a chip people try to press».
 *
 * So the OWNER still decides what a state means; this says what a meaning
 * looks like, in one place, for both shapes.
 */
export const TONE_TEXT: Record<StateTone, string> = {
  neutral: 'text-[var(--sys-foreground)]',
  good: 'text-[var(--sys-success)]',
  warn: 'text-[var(--sys-warning)]',
  bad: 'text-[var(--sys-destructive)]',
};

export const TONE_DOT: Record<StateTone, string> = {
  neutral: 'bg-[var(--sys-muted-foreground)]',
  good: 'bg-[var(--sys-success)]',
  warn: 'bg-[var(--sys-warning)]',
  bad: 'bg-[var(--sys-destructive)]',
};

export function StatusChip({
  tone = 'neutral',
  title,
  children,
  className,
}: {
  tone?: StateTone;
  /** The longer sentence, for the chip that cannot say it in two words. */
  title?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      title={title}
      className={clsx(
        'inline-flex items-center whitespace-nowrap rounded-sm border px-2 py-0.5 text-xs font-medium',
        TONES[tone],
        className
      )}
    >
      {children}
    </span>
  );
}

/**
 * `beforeShipping` splits the one word «ملغى» into the two things it means.
 *
 * Cancelled before the parcel left costs nothing and the units go straight
 * back on the shelf. Cancelled after means a parcel is out there, a courier
 * will be paid, and the stock only returns through the returns door. One
 * chip for both hides the only part anybody needs.
 *
 * It is derived, never stored: the core state list stays closed.
 *
 * `testStore` (B2, 18/11) does the same to «مؤكد»: a confirmed order of a bench store stops there and is never shipped
 * (`test-store.ts`), so the word says it — from `Store.isTest`, not from a state of its own.
 */
export function OrderStateChip({ state, beforeShipping, testStore }: { state: string; beforeShipping?: boolean; testStore?: boolean }) {
  // The word only, in the tone «مؤكد» already has: the fewest bytes on the desk, whose budget is measured to the kilobyte.
  const label = testStore && state === 'CONFIRMED' ? BENCH_CONFIRMED_AR : STATE_LABEL_AR[state as CoreState];

  if (state === 'CANCELLED' && beforeShipping !== undefined) {
    return (
      <StatusChip
        tone={beforeShipping ? 'warn' : 'bad'}
        title={
          beforeShipping
            ? 'أُلغي قبل أن يُشحن — لا طرد خارج المستودع والبضاعة عادت للرف'
            : 'أُلغي بعد الشحن — الطرد خارج المستودع، وأجرة الشحن مستحقّة، والبضاعة تعود عبر المرتجعات'
        }
      >
        {beforeShipping ? 'ملغى قبل الشحن' : 'ملغى بعد الشحن'}
      </StatusChip>
    );
  }

  // An unknown value is shown as it arrived rather than as nothing: a blank
  // chip is a screen that hides the one field somebody is looking at.
  if (!label) return <StatusChip>{state}</StatusChip>;

  return <StatusChip tone={STATE_TONE[state as CoreState]}>{label}</StatusChip>;
}
