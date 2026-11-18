import React from 'react';
import { PageHeader } from './PageHeader';

/**
 * THE ONE FRAME OF A SCREEN (R2c, plan 17/11).
 *
 * Every screen drew its own: a `space-y-6` here, a `max-w-4xl` there, the toolbar a row above the list on one and inside the first card
 * on the next. This is the frame, in four parts and a fixed order:
 *
 *   the HEADER, through `PageHeader` — the name as the menu says it, one line of what the screen answers, the ⓘ of the screen's guide
 *   (drawn there, only when the screen has one), a chip beside the name, the actions at the end of the row;
 *   the TOOLBAR — one row under it for the few controls that act on the whole screen (the date box, a switch between two views);
 *   the FILTERS — the row of questions that narrow a list, always drawn (a filter behind a button is one nobody finds);
 *   the CONTENT, with the page's rhythm between its blocks.
 *
 * It holds no data and no state and asks the router nothing, so a screen can adopt it without changing what it fetches or sends.
 * Heading level: the header draws the screen's ONE `h1`; the content brings its own `h2`s.
 *
 * `width` caps how wide the content may grow, never how narrow: a phone is always the full width. No class here is one a screen did not
 * already carry, so the stylesheet does not grow for the sake of the frame.
 */
export type PageWidth = 'full' | 'wide' | 'medium' | 'narrow';

/** The cap for each width. `full` is no cap: the shell's own padding is the edge. */
export const PAGE_WIDTHS: Record<PageWidth, string> = {
  full: '',
  wide: 'max-w-6xl',
  medium: 'max-w-4xl',
  narrow: 'max-w-3xl',
};

export function PageShell({
  title,
  description,
  actions,
  badge,
  toolbar,
  filters,
  width = 'full',
  children,
}: {
  /** The name of the screen, as the menu says it. */
  title: string;
  /** One sentence. What this screen answers. */
  description?: string;
  /** Buttons, at the end of the header row (under the name on a phone). */
  actions?: React.ReactNode;
  /** A chip or a count that belongs beside the name. */
  badge?: React.ReactNode;
  /** The few controls that act on the whole screen, one row under the header. */
  toolbar?: React.ReactNode;
  /** The row of filters that narrow the list below. */
  filters?: React.ReactNode;
  width?: PageWidth;
  children?: React.ReactNode;
}) {
  return (
    <div className={`min-w-0 ${PAGE_WIDTHS[width]}`.trim()}>
      <PageHeader title={title} description={description} actions={actions}>
        {badge}
      </PageHeader>
      {toolbar && <div className="mb-4 flex min-w-0 flex-wrap items-center gap-2">{toolbar}</div>}
      {filters && <div className="mb-4 min-w-0">{filters}</div>}
      <div className="min-w-0 space-y-6">{children}</div>
    </div>
  );
}
