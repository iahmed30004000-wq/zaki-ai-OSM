import React from 'react';
import { HealthChip } from './HealthChip';
import type { Health as HealthVerdict } from '@/lib/health';
import Link from 'next/link';
import { RiArrowDownLine, RiArrowUpLine, type RemixiconComponentType } from '@remixicon/react';
import { Sparkline } from './Sparkline';
import clsx from 'clsx';
import { CARD_CLASS } from '@/lib/theme-shape';

interface CardProps {
  children: React.ReactNode;
  className?: string;
}

/**
 * A CARD IS A SURFACE WITH AN EDGE, NOT A THING THAT FLOATS.
 *
 * Every card carried `shadow-raised`, so a screen with nine of them was
 * nine objects hovering over the page at the same height — which is the
 * same as none of them being raised, except heavier to look at.
 *
 * Elevation means one thing: THIS IS ABOVE THE PAGE. A dialog is. A card
 * you can press is, while the pointer is on it. A card that is simply a
 * container is not, and it gets a hairline instead — which it needs
 * anyway, since a surface with neither an edge nor a shadow is invisible
 * against the page it sits on.
 */
/*
 * AND IT IS NOT A CONTROL.
 *
 * `Card` took an `onClick` and rendered it on a plain `<div>`: no keyboard
 * could reach it, a screen reader announced nothing, and `system.css` gives
 * its pressed state to buttons — so a pressable card would have answered
 * nothing. Nothing passed the prop, so it was a dead capability rather than
 * a live defect; it is removed because the next caller would have written
 * the defect by using it, the way the product image did.
 *
 * A card that leads somewhere puts a real button or link INSIDE itself.
 */
export function Card({ children, className }: CardProps) {
  return (
    <div
      className={clsx(
        /*
         * `zk-card` is how a THEME reaches this surface — its corner, its
         * edge, the arch some themes wear on the top line, and the faint
         * glyph in the corner furthest from the heading. On the shared
         * card and not on every element painted with the card colour: an
         * input and a badge wear that colour too, and a 22px crescent
         * inside a 32px field is not a theme, it is a defect.
         *
         * The three palettes the product came with change nothing here.
         * See src/lib/theme-shape.ts.
         */
        CARD_CLASS,
        'bg-[var(--sys-card)] rounded-lg border border-[var(--sys-border)] transition-shadow',
        className
      )}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  subtitle,
  action,
  className,
}: {
  /**
   * Rendered inside the card's own <h3>, so pass text — or inline content
   * such as a <span> carrying an icon. A heading or a block element here
   * produces invalid HTML and a hydration error at runtime, which React
   * only reports once the screen is opened.
   */
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={clsx(
        'flex items-center justify-between px-6 py-4 border-b border-[var(--sys-border)]',
        className
      )}
    >
      <div>
        <h3 className="text-base font-semibold text-[var(--sys-heading)]">{title}</h3>
        {subtitle && <p className="text-xs text-[var(--sys-muted-foreground)] mt-0.5">{subtitle}</p>}
      </div>
      {action && <div>{action}</div>}
    </div>
  );
}

export function CardContent({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={clsx('p-6', className)}>{children}</div>;
}

/**
 * A FIGURE, AND THE THREE THINGS THAT MAKE IT MEAN SOMETHING.
 *
 * The old card was a title, a number and a coloured icon. The number is the
 * least useful part on its own: «12,400» is good news after 9,000 and bad
 * news after 20,000, and nothing on the card said which — so every figure
 * was read, believed, and then checked somewhere else anyway.
 *
 *   THE FIGURE, large and tabular, so a row of four cards lines up and the
 *     eye can compare them without reading each one.
 *   THE PREVIOUS PERIOD beside it, named. Not a percentage this card
 *     invented — see below.
 *   THE SHAPE over time, in a centimetre of SVG.
 *   AND A WAY IN. Tapping the card opens the list the figure came from,
 *     because the question after every number is "which ones".
 *
 * THIS CARD DOES NOT COMPUTE A PERCENTAGE.
 *
 * It shows both figures and which way it moved. «الربح ارتفع ١٢٪» is a
 * business claim, and the divisor — what counts as the previous period —
 * belongs to whatever produced the numbers, not to a card that happens to
 * have two of them. A caller that already has the percentage passes it.
 */
export function KpiCard({
  title,
  value,
  subtitle,
  icon: Icon,
  previous,
  series,
  goodWhen,
  health,
  rule,
  href,
}: {
  title: string;
  /** Usually a <Money>. Anything that prints as one figure. */
  value: React.ReactNode;
  subtitle?: string;
  icon?: RemixiconComponentType;
  /** The same figure, last period, and what to call that period. */
  previous?: { value: React.ReactNode; label: string; direction?: 'up' | 'down' | 'flat'; change?: string };
  /** The shape over time. Fewer than two points draws nothing. */
  series?: number[];
  goodWhen?: 'rising' | 'falling' | 'neither';
  /**
   * WHERE THE NUMBER SITS AGAINST THE BAR, not only against last month.
   *
   * The arrow answers «did it move» and that was the only question this
   * card ever asked. «هل هو جيّد» is the other one, and it is the one
   * somebody opening the screen actually has: a delivery rate can rise
   * three points and still be under the bar, and a card that shows a green
   * arrow over it is telling a comforting lie.
   */
  health?: HealthVerdict;
  /**
   * HOW THIS FIGURE IS WORKED OUT — in a sentence, on the card.
   *
   * The owner's rule for every indicator: «كل مؤشّر يبيّن قاعدة
   * الاحتساب». A percentage on a dashboard is read as a verdict on
   * somebody's work, and two people reading the same percentage with
   * different ideas of its denominator are not disagreeing about the
   * business — they are disagreeing about arithmetic, and one of them is
   * going to act on it.
   *
   * It says WHAT is counted, FROM WHICH statuses, and OVER WHICH period.
   * Not optional: a card that ships without one is a number nobody can
   * check, and the type is the only guard strong enough to stop that
   * happening again next month.
   */
  rule: string;
  /** The list behind the number. */
  href?: string;
}) {
  const dir = previous?.direction;
  const Arrow = dir === 'up' ? RiArrowUpLine : dir === 'down' ? RiArrowDownLine : null;
  const good = goodWhen === 'falling' ? dir === 'down' : dir === 'up';

  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <span className="text-note font-medium text-[var(--sys-muted-foreground)]">{title}</span>
        {Icon && <Icon className="w-5 h-5 shrink-0 text-[var(--sys-muted)]" aria-hidden />}
      </div>

      <div className="mt-2 flex flex-wrap items-baseline gap-2">
        <span className="text-display font-bold leading-none tabular-nums text-[var(--sys-heading)]">{value}</span>
        {health && <HealthChip health={health} />}
      </div>

      {previous && (
        <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-[var(--sys-muted-foreground)]">
          {Arrow && (
            <Arrow
              className={clsx('w-4 h-4 shrink-0', good ? 'text-[var(--sys-success)]' : 'text-[var(--sys-destructive)]')}
              aria-hidden
            />
          )}
          {previous.change && (
            <span className={clsx('font-semibold tabular-nums', good ? 'text-[var(--sys-success)]' : 'text-[var(--sys-destructive)]')}>
              {previous.change}
            </span>
          )}
          <span>{previous.label}</span>
          <span className="tabular-nums">{previous.value}</span>
        </p>
      )}

      {series && series.length >= 2 && (
        <div className="mt-3">
          <Sparkline points={series} goodWhen={goodWhen} />
        </div>
      )}

      {subtitle && <p className="mt-2 text-xs text-[var(--sys-muted-foreground)]">{subtitle}</p>}

      {/*
        THE RULE, ON THE CARD AND NOT IN A TOOLTIP.
        A `title` attribute does not exist on a phone, and the phone is
        where this screen is read. `<details>` costs one line closed,
        needs no state, and opens with a tap or with a keyboard — and a
        screen reader announces it as a disclosure rather than as a
        decoration.
      */}
      {/*
        AND THE CLASSES ARE ONES THE SHEET ALREADY HAS.
        `list-none` and `group` were used nowhere else in the product, and
        the stylesheet ratchet measured them: +32 bytes, over the cap. The
        marker is hidden in `system.css` with the other element defaults
        instead, where it costs nothing and applies to every disclosure
        this product ever draws.
      */}
      <details className="mt-2">
        <summary className="cursor-pointer text-xs text-[var(--sys-muted)] hover:text-[var(--sys-primary)]">
          قاعدة الاحتساب
        </summary>
        <p className="mt-1 text-xs leading-relaxed text-[var(--sys-muted-foreground)]">{rule}</p>
      </details>
    </>
  );

  const shell = 'rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] p-4';

  // Raised only when it can be pressed. A card that lifts off the page
  // without being pressable is a card people try to press.
  if (href) {
    return (
      <Link href={href} className={clsx(shell, 'block transition-shadow hover:shadow-raised')}>
        {body}
      </Link>
    );
  }
  return <div className={shell}>{body}</div>;
}
