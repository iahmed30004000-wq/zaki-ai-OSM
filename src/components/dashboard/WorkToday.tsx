'use client';

import React, { useCallback, useState } from 'react';
import Link from 'next/link';
import { RiArrowRightLine } from '@remixicon/react';
import { iconFor } from '@/components/shell/icons';
import { apiFetch } from '@/lib/api-client';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { useMayOpen } from '@/hooks/useMayOpen';
import { findRoute } from '@/lib/route-registry';
import { MissionCard } from './MissionCard';
import { visibleWork, workKind, type WorkItem } from '@/lib/my-work';

/**
 * «بدّو إياك هلق» (was «شغلك اليوم» until R9, 18/11) — WHAT IS WAITING FOR YOU, AND WHAT TO DO ABOUT IT.
 *
 * The owner, 21/10: «حاسو معجوق وصعب … كل خطوة تودّي للثانية». The dashboard
 * opened on the month: tiles of what HAD happened, and nothing telling
 * somebody who has just sat down what to do first. The header already holds
 * a few counts (`MyWork`), but a chip has room for «14 مرتجع» and not for
 * what that is FOR, and on a phone it shows one.
 *
 * So this is the same numbers, from the same door (`/api/me/work`, which
 * the SERVER scopes by permission — a count is never a list), given room:
 * the number, its name, one sentence of what to do, and the way in.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ──
 *
 *   • It does not invent work. Every card is one of `WORK_KINDS`, and the
 *     sentence on it is that kind's own `todo`, written beside it.
 *   • It does not show a zero. «0 مرتجع» teaches people to stop reading the
 *     row, and the header's rule is kept.
 *   • It says «لا شيء ينتظرك الآن» ONLY when the person has kinds of work
 *     and every one of them is empty. Somebody with no kind of work at all
 *     (an accountant, say) gets no section — telling them «nothing is
 *     waiting» would be a statement about work they were never going to be
 *     given.
 *   • It offers a link only to a screen the person may open (`useMayOpen`),
 *     and none where the kind has none by design: a moderator's own
 *     unconfirmed orders lead nowhere, because the pool is not theirs.
 *   • It computes nothing. The count is the server's; this prints it.
 *
 * Nothing until the first answer, and nothing if the answer never comes: the
 * header's chips are still there, and a section announcing «لا شيء» because
 * the request failed would say a thing nobody knows.
 */

/** The server stops counting at 999: past it the number is «كثير» either way. */
const CEILING = 999;

export function WorkToday() {
  const [items, setItems] = useState<WorkItem[] | null>(null);
  const mayOpen = useMayOpen();

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/me/work');
      if (res.ok) setItems(((await res.json()) as { items?: WorkItem[] }).items ?? []);
    } catch {
      // A failed poll is not worth a message; the next one will do.
    }
  }, []);

  useLiveRefresh(load, { everyMs: 60_000, key: 'work-today' });

  // Not loaded, or a person with no kind of work at all: nothing to say.
  if (items === null || items.length === 0) return null;

  const work = visibleWork(items, items.length);

  return (
    <section aria-labelledby="work-today">
      {/* ─── «مهمّتك الجاية»: THE ONE THING, ABOVE THE LIST OF MANY ───
          The plan's المرحلة ١ asks the dashboard to open with a single
          sentence a person can act on. The grid below is every count that is
          not zero — necessary, and up to six answers to «ماذا الآن»; this is
          the first of them, chosen by rank on the server's own list. It draws
          nothing when there is no mission, so the person with nothing waiting
          sees exactly the page they saw before. */}
      <MissionCard items={items} />

      <h2 id="work-today" className="mb-2 mt-4 text-sm font-bold text-[var(--sys-heading)]">
        بدّو إياك هلق
      </h2>

      {work.length === 0 ? (
        <p className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] p-4 text-sm text-[var(--sys-muted-foreground)]">
          لا شيء ينتظرك الآن.
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {work.map((w) => (
            <Card key={w.key} work={w} href={w.href && mayOpen(w.href) ? w.href : null} />
          ))}
        </ul>
      )}
    </section>
  );
}

function Card({ work, href }: { work: WorkItem; href: string | null }) {
  const Icon = iconFor(work.icon);
  const urgent = work.tone === 'urgent';
  const where = href ? findRoute(href.split('?')[0])?.label : undefined;

  return (
    <li
      className={`rounded-lg border bg-[var(--sys-card)] p-4 ${
        urgent ? 'border-[var(--sys-destructive-border)]' : 'border-[var(--sys-border)]'
      }`}
    >
      <div className={`flex items-center gap-2 ${urgent ? 'text-[var(--sys-destructive)]' : 'text-[var(--sys-foreground)]'}`}>
        <Icon className="h-4 w-4 shrink-0" aria-hidden />
        <span className="text-2xl font-semibold tabular-nums">
          {work.count >= CEILING ? `${CEILING}+` : work.count}
        </span>
        <span className="text-sm font-medium">{work.ar}</span>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-[var(--sys-muted-foreground)]">{workKind(work.key)?.todo}</p>
      {href && (
        <Link
          href={href}
          className="mt-2 inline-flex min-h-11 items-center gap-1 font-medium text-[var(--sys-primary)] hover:underline md:min-h-0"
        >
          افتح {where}
          <RiArrowRightLine className="icon-mirror h-4 w-4 shrink-0" aria-hidden />
        </Link>
      )}
    </li>
  );
}
