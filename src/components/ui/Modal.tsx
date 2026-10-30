'use client';

import React, { useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import { RiCloseLine } from '@remixicon/react';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  maxWidth?: 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '4xl';
  /**
   * WHERE IT COMES FROM. A SHEET IS THIS COMPONENT WITH AN EDGE.
   *
   * `center` is a dialog: a decision, and the page behind it waits.
   * `end` is a side panel: a record you read BESIDE the list you found it
   *   in, so closing it returns you to your place in that list rather than
   *   to the top of a page you have to find your way down again.
   * `bottom` is a phone's sheet, where the thumb already is.
   *
   * It is one prop and not a second component on purpose: a second dialog
   * implementation means a second portal, a second scrim, a second Escape
   * handler and a second focus trap — and one of the two always lags.
   */
  side?: 'center' | 'end' | 'bottom';
  /**
   * THE BUTTONS THAT END THE DIALOG, DRAWN OUTSIDE THE PART THAT SCROLLS.
   *
   * A form tall enough to scroll used to carry its «حفظ» at the very bottom
   * of the scrolling body, so the one button the person came for was the
   * last thing to reach. Put here, the row stays at the foot of the dialog
   * while the body scrolls. (This does not follow the on-screen keyboard:
   * the dialog's height is the visible screen without it, so the keyboard
   * can still cover the foot; that needs the viewport to resize for it.)
   * A submit button that lives
   * out here belongs to a form inside the body through `form="…"`, and
   * pressing Enter in a field still submits it.
   */
  footer?: React.ReactNode;
}

export function Modal({
  isOpen,
  onClose,
  title,
  subtitle,
  children,
  maxWidth = 'lg',
  side = 'center',
  footer,
}: ModalProps) {
  const panel = React.useRef<HTMLDivElement>(null);

  /**
   * THE CLOSER, HELD IN A REF, AND THAT IS THE WHOLE POINT.
   *
   * This effect used to list `onClose` in its dependencies. 63 places render
   * this component and 73 pass their closer as an arrow written in place —
   * `onClose={() => setOpenForm(null)}` — which is a NEW FUNCTION on every
   * render. So the effect tore itself down and set itself up again on every
   * render of the parent, for as long as the dialog was open, and each cycle:
   *
   *   • released the scroll lock and took it again, so the page behind could
   *     move for an instant;
   *   • and ran the cleanup's `opener.focus()` before re-focusing the first
   *     control in the panel — WHICH TAKES THE CURSOR OUT OF THE FIELD
   *     SOMEBODY IS TYPING IN. Any field whose value lives in the parent's
   *     state re-renders the parent on every keystroke, so the caret jumped
   *     to the top of the dialog on every letter. That is the «the page is
   *     stuck and nothing works until I click» that was reported.
   *
   * The handler reads the ref at the moment the key is pressed, so Escape
   * still calls the current closer while the effect runs exactly twice per
   * dialog: once on open, once on close.
   */
  const onCloseRef = React.useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  /**
   * ESCAPE CLOSED IT, BUT TAB COULD WALK OUT OF IT.
   *
   * A dialog whose focus is not held is a dialog where the third Tab press
   * lands on a button in the page behind — a page the scrim says is not
   * available, and which the keyboard could reach anyway. And on close,
   * focus went to the top of the document rather than back to the control
   * that opened it, so somebody who opened a modal from row forty resumed
   * at row one.
   */
  useEffect(() => {
    if (!isOpen) return;

    const opener = document.activeElement as HTMLElement | null;
    const FOCUSABLE =
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab' || !panel.current) return;
      /**
       * No visibility filter here, and that is deliberate.
       *
       * The obvious one — `el.offsetParent !== null` — is wrong in exactly
       * this component: this panel lives inside a `position: fixed` box,
       * and a fixed element's descendants report a null `offsetParent` in
       * real browsers. It would have filtered away every stop in the
       * dialog and quietly turned the trap off altogether.
       *
       * The selector already excludes disabled controls and anything taken
       * out of the tab order, and a dialog renders what it means to show.
       */
      const stops = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (stops.length === 0) return;
      const first = stops[0];
      const last = stops[stops.length - 1];
      const here = document.activeElement;
      if (!e.shiftKey && here === last) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && (here === first || !panel.current.contains(here))) {
        e.preventDefault();
        last.focus();
      }
    };

    /**
     * AND THE LOCK IS PUT BACK AS IT WAS FOUND, NOT SET TO A GUESS.
     *
     * The cleanup used to write `'unset'`, which is not «what it was» — it is
     * «scrollable». `MobileNav` locks the same property while its drawer is
     * open and correctly saves and restores the previous value; a dialog
     * opened and closed above that drawer handed the page back its scroll
     * underneath it.
     */
    const heldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);
    // After paint: the panel is not in the document yet on this tick.
    const id = window.setTimeout(() => {
      panel.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    }, 0);

    return () => {
      document.body.style.overflow = heldOverflow;
      window.removeEventListener('keydown', handleKeyDown);
      window.clearTimeout(id);
      // Back to the control that opened it, not to the top of the page.
      opener?.focus?.();
    };
    // `onClose` is deliberately NOT a dependency — see the ref above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  /**
   * RESOLVED AFTER MOUNT, NOT WHILE RENDERING.
   *
   * On the first render of a tree the frame div is not in the document yet,
   * so a query run during render finds nothing and the dialog falls back to
   * `<body>` — the exact defect this is here to fix, hidden behind the fact
   * that in the running app a dialog is almost always opened later. A layout
   * effect runs after the DOM is committed and before paint, so the dialog
   * never appears in the wrong place even for one frame.
   */
  const [host, setHost] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (!isOpen) return;
    setHost(document.querySelector<HTMLElement>('[data-sys-theme]') ?? document.body);
  }, [isOpen]);

  if (!isOpen || typeof document === 'undefined' || !host) return null;

  /*
   * INTO THE THEMED FRAME, NOT INTO <body>.
   *
   * Every colour in this product is a custom property declared on
   * `[data-sys-theme]`, and `SystemFrame` renders that attribute on a div
   * INSIDE the document element. Custom properties inherit down the tree,
   * so a dialog portalled into `<body>` — a SIBLING of that div, not a
   * descendant — never saw it: it fell back to the `:root` block, which is
   * the dark «ops» palette.
   *
   * The effect was invisible to anybody on the default theme, which is 18 of
   * this shop's 19 accounts. For the one person on «النهار» EVERY dialog in
   * the product rendered dark over a light page, and the fonts had already
   * been worked around the same way — `SystemFrame` puts its font variables
   * on `:root` precisely because «a dialog portalled into <body> reads them
   * too». The colours never got that treatment.
   *
   * Portalling into the frame keeps the reason the portal exists — the
   * dialog is still not a DOM child of the row that opened it, so its
   * clicks no longer bubble into that row — and it needs no script: a theme
   * change re-paints the dialog because the attribute is an ancestor again.
   *
   * `<body>` remains the fallback for anything rendered outside the frame,
   * which is how the seller's own surfaces render their dialogs.
   */

  const widthStyles = {
    sm: 'max-w-sm',
    md: 'max-w-md',
    lg: 'max-w-lg',
    xl: 'max-w-xl',
    '2xl': 'max-w-2xl',
    '4xl': 'max-w-4xl',
  };

  // Rendered through a portal. A modal opened from inside a clickable row
  // used to be a DOM child of that row, so every click inside it bubbled up
  // and opened the row behind it — clicking "السجل" landed you in the order
  // instead of the history. See `host` above for which node it lands in.
  return createPortal(
    <div
      className={clsx(
        // One scrim for the whole product. It used to be `--sys-sidebar`
        // at 50% — a token that is a LIGHT colour in two of the three
        // themes, so the wash meant to push the page back barely dimmed it.
        'fixed inset-0 z-50 flex bg-[var(--sys-background)]/60 backdrop-blur-xs animate-in fade-in duration-200',
        // A phone gets a sheet from the bottom edge, where the thumb already
        // is, and a desk keeps the centred dialog with its margin.
        side === 'center' && 'items-end justify-center sm:items-center sm:p-4',
        side === 'end' && 'items-stretch justify-start',
        side === 'bottom' && 'items-end justify-center'
      )}
      // The portal moves the modal out of the row in the DOM, but a React
      // event still travels up the COMPONENT tree — so a click on a tab
      // inside this modal reached the row's onClick and opened the order
      // behind it. Nothing that happens inside a modal belongs to whatever
      // rendered it.
      onClick={(e) => e.stopPropagation()}
    >
      <div
        className="fixed inset-0"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={clsx(
          'relative z-10 flex w-full flex-col overflow-hidden bg-[var(--sys-card)] shadow-raised',
          // `dvh`, not `vh`: on a phone `vh` is the height with the browser's
          // bars tucked away, so a 90vh dialog reached under the toolbar while
          // it was showing — and the button at its foot went with it.
          side === 'center' &&
            clsx(
              'max-h-[90dvh] rounded-t-lg sm:rounded-lg pb-[env(safe-area-inset-bottom)]',
              widthStyles[maxWidth]
            ),
          // A record read BESIDE the list it was found in: closing it
          // returns you to your place in that list. Full height on a desk,
          // and on a phone it is simply the screen.
          side === 'end' && clsx('h-full max-h-full sm:rounded-s-lg', widthStyles[maxWidth]),
          side === 'bottom' && clsx('max-h-[85vh] rounded-t-lg', widthStyles[maxWidth]),
          side === 'bottom' && 'pb-[env(safe-area-inset-bottom)]'
        )}
      >
        <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-[var(--sys-border)] bg-[var(--sys-surface)]">
          <div className="min-w-0">
            <h3 className="text-lg font-semibold text-[var(--sys-heading)]">{title}</h3>
            {subtitle && <p className="text-xs text-[var(--sys-muted-foreground)] mt-0.5">{subtitle}</p>}
          </div>
          <button
            onClick={onClose}
            aria-label="إغلاق"
            className="min-h-11 min-w-11 md:min-h-0 md:min-w-0 p-1 rounded-lg text-[var(--sys-muted)] hover:text-[var(--sys-heading)] hover:bg-[var(--sys-border)] transition-colors cursor-pointer"
          >
            <RiCloseLine className="w-5 h-5" />
          </button>
        </div>
        {/* 16px of margin on a phone, 24 from `sm`: at 375 the old 24 on each
            side plus the card inside it left 23% of the width for content. */}
        <div data-modal-body className="p-4 sm:p-6 overflow-y-auto flex-1">
          {children}
        </div>
        {footer && (
          <div className="shrink-0 border-t border-[var(--sys-border)] bg-[var(--sys-surface)] px-4 sm:px-6 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>,
    host
  );
}
