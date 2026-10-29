'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '@/context/AppContext';
import { apiJson } from '@/lib/api-client';
import { RiArrowLeftLine, RiInformationLine, RiMenuLine, RiSearchLine, RiStore2Line } from '@remixicon/react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE FIRST-RUN TOUR — FOUR STEPS, ONCE, AND NEVER AGAIN UNLESS ASKED.
 *
 * المرحلة ٢ — «الدليل جوا النظام». The owner, 21/10: «حاسو معجوق وصعب».
 * The ⓘ (ScreenGuide.tsx) answers a person who is ALREADY lost on a screen;
 * this walks a person through the frame on their first morning, before they
 * are lost anywhere. It is not a second tooltip system and it shares no
 * code with one: it is one overlay, mounted in the shell, that runs once.
 *
 * ── ONCE IS A FACT ON THE USER ROW, NOT IN THE BROWSER ──
 *
 * `tourDoneAt` lives on the user (migration 20261022000000), arrives in the
 * session, and is written by PATCH /api/profile/tour. Somebody who works
 * from the counter and from a laptop is walked through once, not twice; a
 * browser they have never used does not walk them through it a third time.
 * The negative rule is absolute: once `tourDoneAt` is set, this component
 * never renders again, whatever the pathname, whatever the device.
 *
 * ── SKIPPING AND «ما بدي أشرح مرة ثانية» ──
 *
 * «تخطّي» closes for THIS browser session only — a person who skipped on a
 * busy morning still gets it tomorrow morning, which is the point of skipping
 * rather than refusing. «This session» is a fact the BROWSER keeps
 * (`sessionStorage`, keyed by the user), because the component alone forgets
 * on every full reload and on every trip out of the shell layout (switching
 * store goes through `/entry`): kept only in React state, a skip lasted until
 * the next navigation and the person met the overlay again within the hour.
 * `sessionStorage` dies with the tab, so «tomorrow» still greets. The checkbox
 * beside it is the refusal: checked, the
 * dismissal is written to the row and it never opens again. Finishing the
 * last step writes the same thing — nobody completes a walkthrough and then
 * wants it replayed tomorrow.
 *
 * ── ANCHORED TO REAL ELEMENTS, BY A NAME, NOT A PIXEL ──
 *
 * Each step names an element by `data-tour="…"`, and the card is placed
 * beside whatever is actually there at run time — the menu, the store chip,
 * the search box, the ⓘ in the title. If an element is not on the screen
 * (a phone folds the sidebar; a screen without a guide has no ⓘ) the step
 * is skipped rather than drawn against nothing: a tour that points at
 * empty air teaches nobody anything except distrust.
 *
 * «NOT ON THE SCREEN» INCLUDES «IN THE PAGE BUT HIDDEN». The sidebar is an
 * `<aside class="hidden md:…">` and the search button `hidden md:flex`: on a
 * phone both are in the DOM and `querySelector` finds them, yet they measure
 * 0×0 — the card was clamped to the corner and pointed at nothing, under a
 * counter that said «خطوة 1 من 4». So an anchor counts only if neither it nor
 * any ancestor is `display: none` (`isShown`).
 *
 * ── ARABIC, RTL, SHORT ──
 *
 * One sentence per step. Latin digits (`ar-u-nu-latn`), like every number
 * this interface prints. The tour interrupts, so it says the least it can.
 * ═══════════════════════════════════════════════════════════════════════
 */

/** A step: the element it stands beside, and the one sentence it says. */
interface TourStep {
  /** The `data-tour` name of the real element this step is anchored to. */
  anchor: string;
  /** One short Arabic sentence. */
  text: string;
  /** The glyph that names the thing, so the card is findable at a glance. */
  icon: React.ComponentType<{ className?: string }>;
}

const STEPS: TourStep[] = [
  {
    anchor: 'sidebar',
    icon: RiMenuLine,
    text: 'هذه القائمة: كل شاشات النظام مرتّبة فيها بمجموعات، واضغط المجموعة لتفتح شاشاتها.',
  },
  {
    anchor: 'context',
    icon: RiStore2Line,
    text: 'هنا المتجر والبلد اللي أنت شغّال عليهما الآن — كل الأرقام في كل شاشة تخصّ هذا المتجر، واضغط البطاقة للتبديل.',
  },
  {
    anchor: 'search',
    icon: RiSearchLine,
    text: 'هذا الصندوق يلاقي كل شي: طلباً أو عميلاً أو شاشة أو زراً. اختصاره Ctrl+K.',
  },
  {
    anchor: 'guide',
    icon: RiInformationLine,
    text: 'بجانب عنوان كل شاشة زر «ⓘ» يشرح الشاشة خطوة خطوة — إذا ضاع عليك شي اضغطه.',
  },
];

/** Per tab, per user: «تخطّي» was pressed in this browser session. */
const skippedKey = (userId: string) => `zaki.tour.skipped.${userId}`;

function skippedThisSession(userId: string): boolean {
  try {
    return window.sessionStorage.getItem(skippedKey(userId)) === '1';
  } catch {
    return false; // storage blocked: the tour simply cannot remember a skip
  }
}

function rememberSkip(userId: string) {
  try {
    window.sessionStorage.setItem(skippedKey(userId), '1');
  } catch {
    /* blocked storage: the skip lasts until the next load, as it used to */
  }
}

/**
 * Whether a person could actually see this element: not itself `display:none`
 * and not inside something that is. Walks up because `hidden` on a parent
 * hides the child without the child's own computed display changing.
 */
function isShown(el: Element): boolean {
  for (let node: Element | null = el; node; node = node.parentElement) {
    if (window.getComputedStyle(node).display === 'none') return false;
  }
  return true;
}

/** Where the card goes relative to its anchor, per side of the screen. */
function place(rect: DOMRect): { top: number; left: number } {
  // The sidebar stands on the RIGHT (RTL), the header on top. The card is
  // drawn beside the anchor with a 12px gap, clamped into the viewport.
  const W = 320;
  const H = 150; // measured max; clamping below keeps it honest
  let left = rect.left - W - 12;
  if (left < 8) left = Math.min(rect.right + 12, window.innerWidth - W - 8);
  let top = rect.top;
  if (top + H > window.innerHeight - 8) top = Math.max(8, window.innerHeight - H - 8);
  return { top: Math.max(8, top), left };
}

export function FirstRunTour() {
  const { currentUser, refreshUser } = useApp();
  const [step, setStep] = useState(0);
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [neverAgain, setNeverAgain] = useState(false);
  const [busy, setBusy] = useState(false);
  /**
   * The steps this screen can actually show: a step whose element is absent
   * is dropped BEFORE the tour starts rather than skipped mid-walk. Deciding
   * it up front is what keeps the counter honest — «خطوة 2 من 3» on a phone
   * with no sidebar is true; «خطوة 2 من 4» with a step that never appears is
   * a tour that lost a page.
   */
  const [plan, setPlan] = useState<TourStep[]>(STEPS);

  // Opens at most once per mount, only for a user who has never dismissed it,
  // and plans only the steps whose elements are on THIS screen right now.
  useEffect(() => {
    if (!currentUser || currentUser.tourDoneAt) return;
    if (skippedThisSession(currentUser.id)) return;
    // A dialog that is already open at first paint would sit UNDER the veil
    // (the Modal is z-50, the veil z-60) and could not be pressed. The tour
    // waits for the next visit rather than burying somebody's open work.
    if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
    const here = STEPS.filter((s) => {
      const el = document.querySelector(`[data-tour="${s.anchor}"]`);
      return el !== null && isShown(el);
    });
    // Nothing to point at is nothing to say: no overlay at all rather than an
    // overlay with no anchor, which would cover a screen and explain none of it.
    if (here.length === 0) return;
    setPlan(here);
    setStep(0);
    setOpen(true);
  }, [currentUser?.id, currentUser?.tourDoneAt]);

  const current = plan[step];

  // Follow the anchor while the page moves under it. Measuring is a
  // synchronisation with the DOM, not a second source of truth: the element
  // owns where it is, the card only reads it.
  useEffect(() => {
    if (!open || !current) return;
    const el = document.querySelector(`[data-tour="${current.anchor}"]`);
    if (!el) {
      // The thing this step points at left the page between two steps. A card
      // (and a veil) drawn against nothing teaches nothing and swallows every
      // press, so the walk moves on, or ends, instead.
      setRect(null);
      if (step + 1 < plan.length) setStep(step + 1);
      else setOpen(false);
      return;
    }
    setRect(el.getBoundingClientRect());
    const onMove = () => setRect(el.getBoundingClientRect());
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open, step, current, plan.length]);

  /** Writes the dismissal to the row, and never throws at the person. */
  const dismissForever = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setOpen(false);
    try {
      await apiJson('/api/profile/tour', { method: 'PATCH' });
      await refreshUser();
    } catch {
      // The tour closed regardless; a failed write costs one more tour on
      // the next sign-in, never a stuck overlay or an error to a new user.
      refreshUser().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }, [busy, refreshUser]);

  const next = () => {
    if (step + 1 < plan.length) {
      setStep(step + 1);
    } else {
      void dismissForever();
    }
  };

  const skip = () => {
    if (neverAgain) {
      void dismissForever();
      return;
    }
    if (currentUser) rememberSkip(currentUser.id);
    setOpen(false);
  };

  // Escape is «تخطّي»: the veil covers the whole screen and swallows clicks,
  // so the keyboard needs its own way out. The ref is the latest `skip`, so
  // the listener is attached once per open and never goes stale.
  const skipRef = useRef(skip);
  useEffect(() => {
    skipRef.current = skip;
  });
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        skipRef.current();
        return;
      }
      /**
       * TAB STAYS INSIDE THE CARD.
       *
       * The veil swallows the pointer, but the keyboard walked straight past
       * it: the third Tab landed on a link in the dimmed page behind, which a
       * person reading the tour cannot see. The card's own controls are the
       * only stops, and the last one wraps to the first.
       */
      if (e.key !== 'Tab' || !cardRef.current) return;
      const stops = [
        ...cardRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])'),
      ];
      if (stops.length === 0) return;
      const here = document.activeElement as HTMLElement | null;
      const first = stops[0];
      const last = stops[stops.length - 1];
      const inside = !!here && cardRef.current.contains(here) && here !== cardRef.current;
      if (e.shiftKey && (!inside || here === first)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (!inside || here === last)) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Focus goes into the card when a step opens, so Tab/Enter work on the
  // buttons it shows and not on the dimmed page behind it.
  useEffect(() => {
    if (open && rect) cardRef.current?.focus();
  }, [open, step, rect === null]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open || !current || !currentUser || currentUser.tourDoneAt) return null;

  return (
    <div dir="rtl" data-testid="first-run-tour">
      {/* THE VEIL IS DRAWN WITH THE CARD, NEVER WITHOUT IT.
          The card needs a measured anchor and the veil did not, so for the
          moment between «the tour opened» and «its anchor was measured» — or
          for good, when the anchor vanished — the screen was dimmed, every
          press was swallowed and there was nothing to press. Both come
          together or neither does.

          A dim veil, under the card and above the page: the tour interrupts
          on purpose, and an interrupting card that competes with a bright
          page behind it is read as one more widget. Pointer-events stay on
          the veil so a stray click dismisses nothing — the buttons decide.
          The card comes later in the DOM at the same layer, so it paints
          above the veil. Both classes already ship elsewhere, so the tour
          adds no CSS rule (the 94.04 KB first-load ceiling in
          quality-gates.test.ts). */}
      {rect && (
        <>
          <div className="fixed inset-0 z-[60] bg-[var(--sys-background)]/60" aria-hidden />
          <div
            ref={cardRef}
            tabIndex={-1}
            role="dialog"
            aria-label="الجولة الأولى"
            style={{ top: place(rect).top, left: place(rect).left }}
            className="fixed z-[60] w-[320px] outline-none rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] p-4 shadow-raised"
          >
            <div className="flex items-start gap-3">
              <current.icon className="mt-0.5 h-5 w-5 shrink-0 text-[var(--sys-primary)]" aria-hidden />
              <p className="text-sm leading-relaxed text-[var(--sys-heading)]">{current.text}</p>
            </div>

            <p className="mt-3 text-xs text-[var(--sys-muted-foreground)] tabular-nums">
              خطوة {step + 1} من {plan.length}
            </p>

            <div className="mt-3 flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={skip}
                className="h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border)] text-xs font-medium text-[var(--sys-muted-foreground)] hover:border-[var(--sys-primary)] hover:text-[var(--sys-primary)]"
              >
                تخطّي
              </button>
              <button
                type="button"
                onClick={next}
                disabled={busy}
                className="inline-flex h-11 md:h-10 items-center gap-1 px-4 rounded-lg bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] text-xs font-medium disabled:opacity-50"
              >
                {step + 1 < plan.length ? 'التالي' : 'خلصت'}
                <RiArrowLeftLine className="icon-mirror h-4 w-4" aria-hidden />
              </button>
            </div>

            {step === 0 && (
              <label className="mt-3 flex cursor-pointer items-center gap-2 text-xs text-[var(--sys-muted-foreground)]">
                <input
                  type="checkbox"
                  checked={neverAgain}
                  onChange={(e) => setNeverAgain(e.target.checked)}
                  className="h-4 w-4 rounded-sm border-[var(--sys-border)]"
                />
                ما بدي أشرح مرة ثانية
              </label>
            )}
          </div>
        </>
      )}
    </div>
  );
}
