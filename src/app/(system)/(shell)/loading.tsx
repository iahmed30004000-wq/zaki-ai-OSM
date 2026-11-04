import { SkeletonRows } from '@/components/ui/Skeleton';

/**
 * WHAT A PRESS ON THE MENU DRAWS BEFORE THE NEXT SCREEN HAS ANSWERED.
 *
 * Without this file there was no Suspense boundary under the shell, so a
 * click on a link waited for the WHOLE next page on the server before the
 * screen moved at all. On a slow line — and right after a deploy, while the
 * server is still warming — that wait has no mark on it: the old screen
 * stays, the press seems to have done nothing, and the person presses
 * again, or decides the system is stuck.
 *
 * Here, beside `(shell)/layout.tsx`, it wraps every screen under the shell
 * and never the shell itself: the sidebar and the top bar stay where they
 * are and stay usable, and only the body is swapped for this outline the
 * moment the press lands. Next prefetches it with the link, so it is drawn
 * without a round trip.
 *
 * Deliberately light: no data, no hooks of its own, one shared outline. A
 * screen that needs its own shape while it waits still draws it itself.
 */
export default function ShellLoading() {
  return (
    <div className="space-y-4" dir="rtl" aria-busy="true">
      <div aria-hidden className="h-7 w-48 animate-pulse rounded-sm bg-[var(--sys-surface-strong)]" />
      <SkeletonRows rows={6} />
    </div>
  );
}
