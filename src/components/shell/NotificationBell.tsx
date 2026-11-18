'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useNotifications } from './NotificationsProvider';
import { apiJson } from '@/lib/api-client';
import { arDateShort } from '@/lib/format';
import type { NotificationType } from '@/lib/notification';
import { RiCheckLine, RiLoader4Line, RiNotification3Line } from '@remixicon/react';

/**
 * The bell.
 *
 * Eleven places in the system create notifications, all through
 * createNotification, which writes one row per person it concerns. The bell
 * shows only this person's rows for the store they have selected; who gets
 * what, and what a click may open, is decided on the server.
 *
 * The unread count is polled with the count-only query (one COUNT, no rows)
 * and the list is fetched only when the panel opens. Polling stops while the
 * tab is hidden: a background tab asking every minute for a number nobody
 * is looking at is just load.
 */

interface Notification {
  id: string;
  title: string;
  message: string;
  type: string;
  isRead: boolean;
  link: string | null;
  createdAt: string;
}

/**
 * The kinds, in words. A badge reading ORDER_NEW tells a person nothing.
 * Keyed by the server's own type list, so a kind added there without a
 * label here does not compile — two of the jobs' kinds shipped showing
 * their raw English name that way.
 */
const TYPE_AR: Record<NotificationType, string> = {
  ORDER_NEW: 'طلب جديد',
  FOLLOW_UP: 'متابعة',
  LOW_STOCK: 'مخزون منخفض',
  HIGH_REJECTION: 'رفض مرتفع',
  CLOSING_DUE: 'إغلاق مستحق',
  POSTPONED_DUE: 'مؤجَّل حان موعده',
  RETURNS_NOT_RECEIVED: 'مرتجعات لم تُستلم',
  PERFORMANCE: 'أداء',
  SYSTEM_ALERT: 'تنبيه',
  LANDING_CHAT: 'رسائل اللاندينج',
};

const TONE: Record<NotificationType, string> = {
  ORDER_NEW: 'bg-[var(--sys-surface)] text-[var(--sys-muted-foreground)]',
  FOLLOW_UP: 'bg-[var(--sys-warning-soft)] text-[var(--sys-warning)]',
  LOW_STOCK: 'bg-[var(--sys-warning-soft)] text-[var(--sys-warning)]',
  HIGH_REJECTION: 'bg-[var(--sys-destructive-soft)] text-[var(--sys-destructive)]',
  CLOSING_DUE: 'bg-[var(--sys-surface)] text-[var(--sys-muted-foreground)]',
  POSTPONED_DUE: 'bg-[var(--sys-warning-soft)] text-[var(--sys-warning)]',
  RETURNS_NOT_RECEIVED: 'bg-[var(--sys-warning-soft)] text-[var(--sys-warning)]',
  PERFORMANCE: 'bg-[var(--sys-success-soft)] text-[var(--sys-success)]',
  SYSTEM_ALERT: 'bg-[var(--sys-surface)] text-[var(--sys-muted-foreground)]',
  LANDING_CHAT: 'bg-[var(--sys-primary-soft)] text-[var(--sys-primary)]',
};

const POLL_MS = 60_000;

export function NotificationBell() {
  const router = useRouter();
  /**
   * THE ROWS COME FROM THE ONE POLLER.
   *
   * This kept a timer of its own and asked for the count every minute; the
   * corner cards and the menu's numbers want the same rows, and three
   * askers is three answers a second apart — a badge that disagrees with
   * the list it opens. The timer, the visibility rule and the «a failed
   * poll is not worth a message» all moved to NotificationsProvider.
   */
  const { items: rows, unreadCount: unread, markAllRead, markRead: markOneRead, refresh } = useNotifications();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const items: Notification[] | null = rows as unknown as Notification[];

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  async function toggle() {
    const next = !open;
    setOpen(next);
    // Opening asks for a fresh read rather than showing a minute-old list;
    // the rows themselves live in the provider.
    if (next) await refresh();
  }

  async function markAll() {
    setBusy(true);
    try {
      // The provider owns the write and the re-read, so the bell, the
      // corner and the menu all stop counting the same rows at once.
      await markAllRead();
    } finally {
      setBusy(false);
    }
  }

  async function openItem(n: Notification) {
    if (!n.isRead) void markOneRead(n.id);
    if (n.link) {
      setOpen(false);
      router.push(n.link);
    }
  }

  return (
    <div className="relative" ref={box}>
      <button
        onClick={toggle}
        aria-label={unread > 0 ? `${unread} إشعار غير مقروء` : 'الإشعارات'}
        className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-[var(--sys-muted-foreground)] hover:text-[var(--sys-primary)] hover:bg-[var(--sys-surface)] transition-colors"
        title={unread > 0 ? `${unread} إشعار غير مقروء` : 'الإشعارات'}
      >
        <RiNotification3Line className="w-5 h-5" />
        {unread > 0 && (
          <span className="absolute -top-0.5 -end-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-[var(--sys-destructive)] text-[var(--sys-primary-foreground)] text-xs font-bold flex items-center justify-center tabular-nums">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          dir="rtl"
          className="absolute z-40 mt-1 end-0 w-[22rem] max-w-[calc(100vw-2rem)] rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] shadow-overlay overflow-hidden"
        >
          <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-[var(--sys-border)] bg-[var(--sys-surface)]">
            <span className="text-xs font-bold text-[var(--sys-heading)]">الإشعارات</span>
            {unread > 0 && (
              <button
                onClick={markAll}
                disabled={busy}
                className="text-xs text-[var(--sys-primary)] hover:underline inline-flex items-center gap-1 disabled:opacity-50"
              >
                {busy ? <RiLoader4Line className="w-4 h-4 animate-spin" /> : <RiCheckLine className="w-4 h-4" />}
                تعليم الكل كمقروء
              </button>
            )}
          </div>

          <div className="max-h-[22rem] overflow-y-auto">
            {items === null ? (
              <p className="px-4 py-6 text-xs text-[var(--sys-muted)] flex items-center justify-center gap-1.5">
                <RiLoader4Line className="w-4 h-4 animate-spin" /> جارٍ التحميل…
              </p>
            ) : items.length === 0 ? (
              <p className="px-4 py-6 text-xs text-[var(--sys-muted)] text-center">لا إشعارات.</p>
            ) : (
              <ul className="divide-y divide-[var(--sys-border)]">
                {items.map((n) => (
                  <li key={n.id}>
                    <button
                      onClick={() => openItem(n)}
                      className={`w-full text-start px-4 py-2.5 hover:bg-[var(--sys-surface)] transition-colors ${
                        n.isRead ? '' : 'bg-[var(--sys-primary-soft)]/60'
                      }`}
                    >
                      <span className="flex items-start gap-2">
                        {!n.isRead && (
                          <span className="w-1.5 h-1.5 rounded-full bg-[var(--sys-primary)] mt-1.5 shrink-0" aria-hidden="true" />
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5 flex-wrap">
                            <span className={`text-xs px-1.5 py-0.5 rounded-md ${TONE[n.type as NotificationType] ?? TONE.SYSTEM_ALERT}`}>
                              {TYPE_AR[n.type as NotificationType] ?? TYPE_AR.SYSTEM_ALERT}
                            </span>
                            <span className="text-xs text-[var(--sys-muted)]">{arDateShort(n.createdAt)}</span>
                          </span>
                          <span className={`block text-xs mt-1 ${n.isRead ? 'text-[var(--sys-muted-foreground)]' : 'text-[var(--sys-heading)] font-medium'}`}>
                            {n.title}
                          </span>
                          <span className="block text-xs text-[var(--sys-muted)] mt-0.5 break-words">{n.message}</span>
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
