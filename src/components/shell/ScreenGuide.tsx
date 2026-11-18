'use client';

import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { RiArrowRightLine, RiInformationLine } from '@remixicon/react';
import { Modal } from '@/components/ui/Modal';
import { IconButton } from '@/components/ui/IconButton';
import { Card } from '@/components/ui/Card';
import { useMayOpen } from '@/hooks/useMayOpen';
import { findRoute, type RouteDef } from '@/lib/route-registry';
import { roadPosition } from '@/lib/next-stop';
import { guideRoute, whoOpens, type GuideText } from '@/lib/route-guide';

/**
 * «اشرح لي هذه الشاشة» — ONE BUTTON IN THE TITLE, ONE SHEET BESIDE THE SCREEN.
 *
 * The owner, 21/10: «حاسو معجوق وصعب … شرح داخل السايت». See
 * `route-guide.ts` for what is derived and what is written, and why the texts
 * are not loaded until this sheet is opened.
 *
 * ── WHY THE SHELL OWNS THE SHEET AND THE HEADERS ONLY HOLD THE BUTTON ──
 *
 * The screens draw their title with `PageHeader` — one component since 18/11,
 * when `ScreenTitle` (the older one, which read its name from the address) was
 * deleted and its screens moved onto `PageHeader` with the name read from the
 * registry. The button sits in it, beside the title where an eye looks for
 * «what is this»; the sheet is drawn by the shell, once, so the header does
 * not have to know what a guide is. It reads one context, and without a provider (a component under
 * test, a page outside the shell) it is `null` and the button is simply not
 * there — which is also why this is a context and not `usePathname()` inside
 * the headers: thirty tests mock `next/navigation` without it.
 *
 * ── A SIDE SHEET, NOT A PANEL IN THE PAGE ──
 *
 * `Modal` with an edge is the product's sheet: Escape closes it, focus is held
 * inside it and returns to the button, and the page behind does not move. A
 * panel opened above the title pushes the very screen it explains down the
 * page, and one of the two always has to be scrolled to.
 */

interface GuideState {
  route: RouteDef | null;
  open: boolean;
  toggle: () => void;
}

const Ctx = createContext<GuideState | null>(null);

export function ScreenGuideProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const route = guideRoute(pathname);
  const [open, setOpen] = useState(false);

  // Another screen is another question. A sheet that followed the person to
  // the next page would be explaining the one they left.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  const value = useMemo(() => ({ route, open, toggle: () => setOpen((v) => !v) }), [route, open]);

  return (
    <Ctx.Provider value={value}>
      {children}
      {route && open && <GuideSheet route={route} onClose={() => setOpen(false)} />}
    </Ctx.Provider>
  );
}

/** The ⓘ. Draws nothing on a screen without a guide, and nothing outside the shell. */
export function GuideButton() {
  const guide = useContext(Ctx);
  if (!guide?.route) return null;
  return (
    <IconButton
      type="button"
      onClick={guide.toggle}
      label="اشرح لي هذه الشاشة"
      aria-haspopup="dialog"
      aria-expanded={guide.open}
      // The first-run tour anchors its last step here — the ⓘ is the thing
      // the tour exists to introduce. See FirstRunTour.tsx.
      data-tour="guide"
      // The kit's square (44px on a phone) with the negative margin that keeps
      // it from growing the title's row — the classes `PanelHeader`'s ⓘ
      // carries, so it costs the stylesheet nothing.
      className="tap-safe -m-2"
    >
      <RiInformationLine className="h-4 w-4" />
    </IconButton>
  );
}

function GuideSheet({ route, onClose }: { route: RouteDef; onClose: () => void }) {
  const mayOpen = useMayOpen();
  // null = still loading; 'failed' = the texts could not be fetched (offline).
  const [text, setText] = useState<GuideText | null | 'failed'>(null);

  useEffect(() => {
    let alive = true;
    import('@/lib/route-guide-texts')
      .then((m) => {
        if (alive) setText(m.GUIDE_TEXTS[route.path] ?? 'failed');
      })
      .catch(() => {
        if (alive) setText('failed');
      });
    return () => {
      alive = false;
    };
  }, [route.path]);

  const road = roadPosition(route.path, mayOpen);
  const who = whoOpens(route);

  // A stop's next is read from the road; any other screen may say where it
  // leads. Either way it is offered only to somebody who may open it.
  const written = typeof text === 'object' && text ? text : null;
  const explicit = written?.next ? findRoute(written.next) : undefined;
  const after = road ? road.next : explicit && mayOpen(explicit) ? explicit : null;

  return (
    <Modal isOpen onClose={onClose} title={route.label} subtitle="كيف تستعمل هذه الشاشة" side="end" maxWidth="md">
      <div dir="rtl" className="space-y-4">
        {road && (
          <p className="text-note font-semibold text-[var(--sys-primary)]">
            {road.road} · الخطوة <span className="tabular-nums">{road.here.step}</span> من{' '}
            <span className="tabular-nums">{road.of}</span>
          </p>
        )}

        {text === null && <p className="text-sm text-[var(--sys-muted-foreground)]">جارٍ التحميل…</p>}
        {text === 'failed' && (
          <p className="text-sm text-[var(--sys-muted-foreground)]">تعذّر تحميل الشرح — تحقّق من الاتصال وجرّب مرة ثانية.</p>
        )}

        {written && (
          <>
            <ol className="space-y-2">
              {written.steps.map((step, i) => (
                <li key={i} className="flex gap-2 text-sm leading-relaxed">
                  <span className="shrink-0 font-bold tabular-nums text-[var(--sys-primary)]">{i + 1}.</span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
            {written.watch && (
              <Card plain padding="sm">
                <p className="text-note leading-relaxed text-[var(--sys-muted-foreground)]">
                  <span className="font-bold">انتبه: </span>
                  {written.watch}
                </p>
              </Card>
            )}
          </>
        )}

        {after && (
          <Link
            href={after.path}
            onClick={onClose}
            className="inline-flex min-h-11 items-center gap-1 font-medium text-[var(--sys-primary)] hover:underline md:min-h-0"
          >
            التالي: {after.label}
            <RiArrowRightLine className="icon-mirror h-4 w-4 shrink-0" aria-hidden />
          </Link>
        )}

        <p className="border-t border-[var(--sys-border)] pt-3 text-note leading-relaxed text-[var(--sys-muted-foreground)]">
          {who
            ? `تفتحها صلاحية: ${who.map((n) => `«${n}»`).join(' أو ')}.`
            : 'مفتوحة لكل من سجّل دخوله.'}
        </p>
      </div>
    </Modal>
  );
}
