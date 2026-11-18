import React from 'react';
import clsx from 'clsx';
import { Card } from './Card';
import { figureScale, figureText } from '@/lib/kpi-figure';

/**
 * ONE NUMBER, ITS NAME, AND A LINE OF CONTEXT.
 *
 * The «three numbers» tile of the new dashboard, and the tile the screens
 * that today draw their own (Tile, Stat, Fact, Figure…) move onto.
 *
 * IT NEVER COMPUTES. `value` and `caption` arrive as text or a node — a
 * `<Money>`, a count the server already worked out — and are drawn as they
 * come. A tile that formatted money or worked out a percentage would be a
 * second place for the arithmetic to be wrong; `KpiCard` makes the same
 * promise, and this one is its smaller sibling: no rule, no sparkline, no
 * link. A figure that needs «how is this counted» is a `KpiCard`.
 *
 * THE FIGURE IS LEFT-TO-RIGHT inside an Arabic line, so a currency code
 * stays after its number and the digits do not reorder, and its size
 * follows its length (the steps `KpiCard` already uses) so a long figure
 * stays inside the tile.
 *
 * THE SURFACE IS `Card plain`: a strip of tiles is dense, and the theme's
 * page-level decorations do not belong on each one.
 */
export function StatTile({
  label,
  value,
  caption,
  className,
}: {
  /** What is counted, in a few words. */
  label: React.ReactNode;
  /** The figure itself. */
  value: React.ReactNode;
  /** One small line under it — the change, the period, the note. */
  caption?: React.ReactNode;
  className?: string;
}) {
  return (
    <Card plain padding="md" className={clsx('min-w-0', className)}>
      <dl>
        <dt className="text-note font-medium text-[var(--sys-muted-foreground)]">{label}</dt>
        <dd className="mt-2 flex min-w-0 flex-wrap items-baseline gap-2">
          <span
            dir="ltr"
            className={clsx(
              'min-w-0 max-w-full font-bold leading-none tabular-nums text-[var(--sys-heading)]',
              figureScale(figureText(value))
            )}
          >
            {value}
          </span>
        </dd>
        {caption && <dd className="mt-2 text-xs text-[var(--sys-muted-foreground)]">{caption}</dd>}
      </dl>
    </Card>
  );
}
