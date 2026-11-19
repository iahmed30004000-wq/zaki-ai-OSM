'use client';

import React from 'react';
import Link from 'next/link';
import type { RemixiconComponentType } from '@remixicon/react';
import { Button } from './Button';
import { ThemeDecor } from '@/components/shell/ThemeDecor';

/**
 * WHAT A SCREEN SAYS WHEN IT HAS NOTHING.
 *
 * Eighty-two of them, written one at a time across sixty-three files, and
 * almost all of them said the same non-sentence: «لا توجد بيانات». That
 * tells somebody standing in a warehouse exactly nothing. Is the list empty
 * because the filter is narrow, because nobody has created one yet, because
 * this account cannot see them, or because the request failed?
 *
 * So an empty state answers three questions and no more:
 *
 *   WHAT is missing — named, in the words of the work, not «بيانات».
 *   WHY it is missing — which is usually the filter, and usually the fix.
 *   THE ONE THING that changes it, as a control you can press right here.
 *
 * No illustration. A drawing of an empty box is a drawing somebody has to
 * scroll past every time the filter is narrow, and it never once told them
 * which filter.
 */
export function EmptyState({
  icon: Icon,
  title,
  why,
  action,
}: {
  /** From the shared family. Quiet — it is not the message. */
  icon?: RemixiconComponentType;
  /** What is missing, named. «لا طلبات متأخرة» — not «لا توجد بيانات». */
  title: string;
  /** Why it is empty, and what would change it. One sentence. */
  why?: string;
  /** The one control that fixes it: clear the filter, or create the first. */
  action?: { label: string; onClick?: () => unknown; href?: string };
}) {
  return (
    <div className="relative flex flex-col items-center gap-3 px-6 py-12 text-center">
      {/* An empty list is the other place nothing is being measured. The
          moment a row appears, the row is what the layer sits behind — so
          this is drawn by the empty state and by nothing that renders data.
          See src/lib/theme-decoration.ts. */}
      <ThemeDecor place="empty" />
      {Icon && <Icon className="w-6 h-6 text-[var(--sys-muted)]" aria-hidden />}
      <p className="text-sm font-semibold text-[var(--sys-heading)]">{title}</p>
      {why && <p className="max-w-sm text-xs leading-relaxed text-[var(--sys-muted-foreground)]">{why}</p>}
      {action &&
        (action.href ? (
          <Link
            href={action.href}
            className="mt-1 inline-flex h-10 items-center rounded-md border border-[var(--sys-border)] px-4 text-sm font-medium text-[var(--sys-primary)] hover:border-[var(--sys-primary)]"
          >
            {action.label}
          </Link>
        ) : (
          <Button size="sm" variant="secondary" className="mt-1" onClick={action.onClick}>
            {action.label}
          </Button>
        ))}
    </div>
  );
}
