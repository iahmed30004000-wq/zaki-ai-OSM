'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { RiErrorWarningLine } from '@remixicon/react';
import { reloadOnceForStaleBuild } from '@/lib/stale-build';

/**
 * ONE BOUNDARY FOR THE WHOLE SYSTEM SIDE, AND WHY ONE IS ENOUGH.
 *
 * An `error.tsx` wraps its segment's `page`, `loading`, `not-found` AND
 * every layout nested below it. Placed here it therefore catches:
 *
 *   /                       (system)/page.tsx — the entry redirect
 *   /login /register        the sign-in screens
 *   /forgot-password /reset-password /pending /entry
 *   (system)/not-found.tsx  the dashboard's own 404
 *   (shell)/layout.tsx      requireShellContext — session, country, store
 *   and every contract screen under it: orders, finance, inventory,
 *   manufacturing, ops, control, growth, customers, products, store,
 *   admin, apps, assistant, confirmation, dashboard, settings.
 *
 * That is roughly a hundred and twenty screens behind one file, and a file
 * per screen would be a hundred and twenty copies of the same sentence to
 * keep in step.
 *
 * WHY NOT A SECOND ONE INSIDE `(shell)`, WHICH WOULD KEEP THE SIDEBAR. It
 * was considered and refused. `(shell)/layout.tsx` awaits
 * `requireShellContext()`, which resolves the session and the country and
 * store selection — the likeliest throw site on the whole system side — and
 * a boundary inside `(shell)` cannot catch its own layout. So the file here
 * would be needed regardless, and the second one would differ from it only
 * in whether the navigation survives. Two pages saying the same thing, one
 * of which drifts. This one draws its own way back instead, so it does not
 * depend on a sidebar it may not have.
 *
 * AND IT DOES NOT WRAP ITSELF IN `SystemFrame`. Next renders `error.tsx`
 * INSIDE the layout of its own segment, and `(system)/layout.tsx` is where
 * `SystemFrame` already is — the stylesheet, the two font families and the
 * person's chosen theme are in scope on this element. A second frame here
 * would nest a theme attribute inside itself and link the system's nine
 * faces a second time. (The sibling `not-found.tsx` does wrap one; it is
 * the belt-and-braces of an older change, not a thing to copy.)
 */
export default function SystemError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  /*
   * A file from the build before a deploy: one full reload fetches the new
   * build, which a retry cannot (src/lib/stale-build.ts). Once — the guard
   * there is what stops a reload loop; a second one is drawn as below.
   */
  useEffect(() => {
    reloadOnceForStaleBuild(error, window);
  }, [error]);

  useEffect(() => {
    /**
     * A Server Component's real message never reaches the browser in
     * production — Next replaces it with a generic one so a stack trace
     * cannot leak a connection string. The digest is the hash that matches
     * this screen to the server log, and printing it is the whole reason
     * «الصفحة لا تفتح» from a warehouse can be traced to a cause.
     */
    console.error('[system-boundary]', error.digest ?? '(no digest)', error);
  }, [error]);

  return (
    <div className="min-h-screen bg-[var(--sys-surface)] flex items-center justify-center p-4" dir="rtl">
      <div className="w-full max-w-md bg-[var(--sys-card)] rounded-lg border border-[var(--sys-border)] p-8 text-center space-y-5">
        <div className="mx-auto w-14 h-14 rounded-lg bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] flex items-center justify-center">
          <RiErrorWarningLine className="w-6 h-6 text-[var(--sys-destructive)]" />
        </div>
        <h1 className="text-lg font-bold text-[var(--sys-heading)]">تعذّر فتح هذه الشاشة</h1>
        <p className="text-sm text-[var(--sys-muted-foreground)]">
          حدث خطأ أثناء تحميل الشاشة. الخطأ من النظام لا من عملك، وغالباً يكون مؤقتاً.
        </p>

        {/*
          THE SENTENCE THAT STOPS A SECOND SHIPMENT.

          The same one `OfflineWatch` and `offline.html` carry, because the
          danger is identical: a person who believes the confirmation, the
          shipment or the cash movement they pressed was «kept» will not
          press it again, and it never happened. A screen that failed to
          LOAD wrote nothing at all — and the only people who know that are
          the ones who are told.
        */}
        <p className="text-note text-[var(--sys-muted-foreground)]">
          لم يُحفَظ شيء من هذه الشاشة. إن كنت في منتصف إجراء، أعِده بعد فتحها من جديد.
        </p>

        <div className="flex flex-wrap items-center justify-center gap-2">
          <Link
            href="/"
            className="inline-block px-5 py-2 text-sm font-medium rounded-lg bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] hover:bg-[var(--sys-primary)]/90"
          >
            العودة إلى شاشتك الأولى
          </Link>
          {/*
            The retry is the SECOND offer, never the only one. `retry()`
            asks the server for this segment again and re-renders it (it is
            `reset()` that re-renders without a round trip), so it recovers
            a server answer that failed for a moment. It cannot recover an
            expired session, nor a file from the build before a deploy (the
            effect above reloads once for that) — and a screen whose single
            control can do nothing is a screen that strands the person on
            it. `/` re-resolves the session on the server and sends them to
            the first screen their role holds, which is a door that always
            opens.
          */}
          <button
            type="button"
            onClick={() => retry()}
            className="h-11 md:h-10 px-5 text-sm font-medium rounded-lg border border-[var(--sys-border-strong)] text-[var(--sys-foreground)] hover:bg-[var(--sys-surface-strong)]"
          >
            أعد المحاولة
          </button>
        </div>
      </div>
    </div>
  );
}
