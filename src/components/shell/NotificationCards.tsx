'use client';

import React from 'react';
import Link from 'next/link';
import { RiCloseLine, RiNotification3Line } from '@remixicon/react';
import { useNotifications } from './NotificationsProvider';

/**
 * WHAT ARRIVED WHILE YOU WERE LOOKING AT SOMETHING ELSE.
 *
 * Square cards in the corner, the way a desktop chat application does it:
 * they appear, they can be read at a glance, they can be dismissed, and
 * «إخفاء الكل» clears the stack in one press.
 *
 * WHY NOT THE TOAST SYSTEM. A toast is the screen's reply to a press —
 * «تم الحفظ» — and it belongs where the press was, in the middle of the
 * bottom edge. This is not a reply to anything: it is work arriving from
 * elsewhere, it points at a screen, and it must survive long enough to be
 * read by somebody who was not watching. Putting the two in one place
 * teaches people to flick away «طلب جديد» with the same thumb that
 * dismisses «تم الحفظ».
 *
 * AT MOST FIVE, and never the same one twice: the provider remembers what
 * this tab has already shown. Sixty unread rows on the first load stay in
 * the bell, which is the list built for them.
 */

const TONE: Record<string, string> = {
  ORDER_NEW: 'border-s-[var(--sys-primary)]',
  LOW_STOCK: 'border-s-[var(--sys-warning)]',
  CLOSING_DUE: 'border-s-[var(--sys-warning)]',
  POSTPONED_DUE: 'border-s-[var(--sys-warning)]',
  RETURNS_NOT_RECEIVED: 'border-s-[var(--sys-destructive)]',
  SYSTEM_ALERT: 'border-s-[var(--sys-muted)]',
};

export function NotificationCards() {
  const { arriving, dismiss, dismissAll, markRead } = useNotifications();
  if (arriving.length === 0) return null;

  return (
    <div
      /**
       * The start corner, clear of the phone's bar and of the assistant —
       * which anchors to the END side. Two floaters on one corner is two
       * things covering each other, which is the bug this file's sibling
       * fix was about.
       *
       * And it lets a press through wherever there is no card. It is a
       * column 20rem wide that stands above the page's last rows: five cards
       * cover up to 250 points from the bottom of a phone, and the gaps
       * BETWEEN them — and the strip beside a narrow card — swallowed every
       * tap meant for the page. Only the cards (and «إخفاء الكل») take
       * presses; the rest of the column is not there for a finger.
       */
      style={{ bottom: 'calc(var(--sys-mobile-nav-h) + env(safe-area-inset-bottom) + 0.75rem)' }}
      className="pointer-events-none fixed start-4 z-50 flex w-[min(20rem,calc(100vw-2rem))] flex-col gap-2 md:!bottom-4"
      aria-live="polite"
    >
      {arriving.length > 1 && (
        <button
          type="button"
          onClick={dismissAll}
          className="pointer-events-auto self-start rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] px-2.5 py-1 text-xs font-semibold text-[var(--sys-muted-foreground)] shadow-raised hover:text-[var(--sys-foreground)]"
        >
          إخفاء الكل ({arriving.length})
        </button>
      )}

      {arriving.map((n) => {
        const body = (
          <>
            <span className="flex items-start gap-2">
              <RiNotification3Line className="mt-0.5 h-4 w-4 shrink-0 text-[var(--sys-primary)]" aria-hidden />
              <span className="min-w-0">
                <span className="block truncate text-xs font-bold text-[var(--sys-heading)]">{n.title}</span>
                <span className="mt-0.5 block text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
                  {n.message}
                </span>
              </span>
            </span>
          </>
        );
        const shell = `pointer-events-auto relative rounded-lg border border-s-4 border-[var(--sys-border)] bg-[var(--sys-card)] p-3 pe-8 shadow-overlay ${
          TONE[n.type] ?? 'border-s-[var(--sys-muted)]'
        }`;

        return (
          <div key={n.id} className={shell}>
            {/* Opening it is reading it: a card that takes you to the work
                and leaves itself unread in the bell is a second dismissal
                to perform for the same thing. */}
            {n.link ? (
              <Link href={n.link} onClick={() => void markRead(n.id)} className="block">
                {body}
              </Link>
            ) : (
              body
            )}
            <button
              type="button"
              onClick={() => dismiss(n.id)}
              aria-label={`أخفِ ${n.title}`}
              title="أخفِ"
              className="absolute end-1 top-1 min-h-11 min-w-11 rounded-lg p-1.5 text-[var(--sys-muted)] hover:text-[var(--sys-foreground)] md:min-h-0 md:min-w-0"
            >
              <RiCloseLine className="h-4 w-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
