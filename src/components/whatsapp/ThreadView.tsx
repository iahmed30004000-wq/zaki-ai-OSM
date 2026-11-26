'use client';

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { RiArrowDownLine } from '@remixicon/react';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Modal } from '@/components/ui/Modal';
import { dayKey, dayLabel, reactionsByTarget, type WaMessage } from './chat-model';
import { MessageBubble } from './MessageBubble';

export interface ThreadViewProps {
  messages: WaMessage[];
  hasOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  onReact?: (messageId: string, emoji: string) => void;
}

/**
 * THE THREAD — messages grouped under day separators («اليوم», «أمس», a date), reactions gathered under the message they mark
 * (a reaction is not drawn as a message of its own), photos opened large in a lightbox, and the view kept at the newest message
 * unless the person scrolled up to read — then a «الأحدث» press brings them back.
 */
export function ThreadView({ messages, hasOlder, loadingOlder, onLoadOlder, onReact }: ThreadViewProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [awayFromEnd, setAwayFromEnd] = useState(false);
  const [lightbox, setLightbox] = useState<{ src: string; caption: string | null } | null>(null);

  const reactions = useMemo(() => reactionsByTarget(messages), [messages]);
  const visible = useMemo(
    () => messages.filter((m) => m.messageType !== 'REACTION' || !m.reactionToId),
    [messages]
  );

  const lastId = visible.length ? visible[visible.length - 1].id : '';
  const firstId = visible.length ? visible[0].id : '';
  const prevFirst = useRef(firstId);
  const prevHeight = useRef(0);

  // Keep the newest message in view as messages arrive — unless the person is reading further up.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (prevFirst.current && firstId !== prevFirst.current && prevHeight.current) {
      // Older messages were put on top: hold the reader where they were.
      el.scrollTop = el.scrollHeight - prevHeight.current + el.scrollTop;
    } else if (pinned.current) {
      el.scrollTop = el.scrollHeight;
    }
    prevFirst.current = firstId;
    prevHeight.current = el.scrollHeight;
  }, [lastId, firstId]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onScroll = () => {
      const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      pinned.current = near;
      setAwayFromEnd(!near);
      prevHeight.current = el.scrollHeight;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <div className="relative flex-1 min-h-0">
      <div ref={scroller} className="h-full overflow-y-auto px-4 py-4 space-y-1.5 bg-[var(--sys-surface)]" dir="ltr" aria-live="polite" aria-relevant="additions">
        {hasOlder && (
          <div className="flex justify-center pb-2">
            <Button variant="secondary" size="sm" onClick={onLoadOlder} loading={loadingOlder}>
              عرض الرسائل الأقدم
            </Button>
          </div>
        )}
        {visible.map((m, i) => {
          const separator = i === 0 || dayKey(m.createdAt) !== dayKey(visible[i - 1].createdAt);
          return (
            <React.Fragment key={m.id}>
              {separator && (
                <div className="flex justify-center py-2" role="separator" aria-label={dayLabel(m.createdAt)}>
                  <span className="px-3 py-1 rounded-full bg-[var(--sys-card)] text-note font-semibold text-[var(--sys-muted-foreground)] shadow-raised" dir="rtl">
                    {dayLabel(m.createdAt)}
                  </span>
                </div>
              )}
              <MessageBubble
                message={m}
                reactions={reactions.get(m.id)}
                onOpenImage={(src, caption) => setLightbox({ src, caption })}
                onReact={m.messageType === 'REACTION' ? undefined : onReact}
              />
            </React.Fragment>
          );
        })}
      </div>
      {awayFromEnd && (
        <div className="absolute bottom-3 end-3">
          <IconButton
            variant="secondary"
            label="الانتقال إلى أحدث رسالة"
            className="shadow-overlay rounded-full"
            onClick={() => {
              const el = scroller.current;
              if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
            }}
          >
            <RiArrowDownLine className="w-5 h-5" />
          </IconButton>
        </div>
      )}
      <Modal isOpen={Boolean(lightbox)} onClose={() => setLightbox(null)} title="صورة" maxWidth="4xl">
        {lightbox && (
          <figure className="flex flex-col items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element -- an authenticated, per-message file */}
            <img src={lightbox.src} alt={lightbox.caption || 'صورة'} className="max-h-[75vh] w-auto max-w-full rounded-lg object-contain" />
            {lightbox.caption && (
              <figcaption className="text-sm text-[var(--sys-heading)] whitespace-pre-wrap break-words" dir="auto">
                {lightbox.caption}
              </figcaption>
            )}
            <a href={`${lightbox.src}${lightbox.src.includes('?') ? '&' : '?'}download=1`} className="text-sm font-semibold text-[var(--sys-primary)] hover:underline">
              تنزيل الصورة
            </a>
          </figure>
        )}
      </Modal>
    </div>
  );
}
