'use client';

import React, { useState } from 'react';
import {
  RiCheckDoubleLine,
  RiCheckLine,
  RiDownloadLine,
  RiEmotionLine,
  RiErrorWarningLine,
  RiFileTextLine,
  RiMapPinLine,
  RiReplyLine,
  RiTimeLine,
  RiUserLine,
} from '@remixicon/react';
import { IconButton } from '@/components/ui/IconButton';
import { Button } from '@/components/ui/Button';
import { arTime } from '@/lib/format';
import { KIND_LABEL, type MessageKind } from '@/lib/whatsapp/message-kinds';
import { formatBytes, mapLink, type WaMessage } from './chat-model';
import { QUICK_REACTIONS } from './emoji-data';
import { VoicePlayer } from './VoicePlayer';

const kindLabel = (t: string) => KIND_LABEL[t as MessageKind] ?? KIND_LABEL.UNSUPPORTED;

/** One to three emojis and nothing else is drawn large, as WhatsApp does. */
export function isEmojiOnly(text: string | null | undefined): boolean {
  const t = (text || '').trim();
  if (!t || t.length > 24) return false;
  if (!/^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\u{FE0F}|\u{200D}|\s)+$/u.test(t)) return false;
  const pictos = t.match(/\p{Extended_Pictographic}/gu) ?? [];
  return pictos.length >= 1 && pictos.length <= 3;
}

/** The ticks of a message we sent: one, two, two in the brand colour, or the failure with Meta's reason. */
function StatusTicks({ status, error }: { status: string; error?: string | null }) {
  if (status === 'FAILED') {
    return (
      <span className="inline-flex items-center text-[var(--sys-destructive)]" title={error || 'لم تُرسل'} aria-label={error ? `لم تُرسل: ${error}` : 'لم تُرسل'} role="img">
        <RiErrorWarningLine className="w-4 h-4" />
      </span>
    );
  }
  if (status === 'READ') return <RiCheckDoubleLine role="img" aria-label="قُرئت" className="w-4 h-4 text-[var(--sys-primary)]" />;
  if (status === 'DELIVERED') return <RiCheckDoubleLine role="img" aria-label="وصلت" className="w-4 h-4 text-[var(--sys-muted)]" />;
  if (status === 'SENT') return <RiCheckLine role="img" aria-label="أُرسلت" className="w-4 h-4 text-[var(--sys-muted)]" />;
  return <RiTimeLine role="img" aria-label="قيد الإرسال" className="w-4 h-4 text-[var(--sys-muted)]" />;
}

function MediaProblem({ state, onRetry }: { state: 'FAILED' | 'TOO_LARGE'; onRetry: () => void }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--sys-surface)] text-note text-[var(--sys-muted-foreground)]">
      <RiErrorWarningLine className="w-4 h-4 shrink-0" />
      <span className="flex-1">{state === 'TOO_LARGE' ? 'الملف أكبر من الحد الذي نحفظه' : 'تعذّر تحميل الملف من واتساب'}</span>
      {state === 'FAILED' && (
        <Button variant="quiet" size="sm" onClick={onRetry} className="shrink-0">
          إعادة المحاولة
        </Button>
      )}
    </div>
  );
}

function Body({ m, mine, onOpenImage }: { m: WaMessage; mine: boolean; onOpenImage: (src: string, caption: string | null) => void }) {
  const [attempt, setAttempt] = useState(0);
  const [broken, setBroken] = useState(false);
  const media = m.media;
  const src = media ? (attempt ? `${media.url}?retry=${attempt}` : media.url) : '';
  const retry = () => {
    setBroken(false);
    setAttempt((n) => n + 1);
  };
  const problem = media && (media.state === 'TOO_LARGE' || broken) ? (media.state === 'TOO_LARGE' ? 'TOO_LARGE' : 'FAILED') : null;
  const caption = m.text ? <p className="mt-1.5 whitespace-pre-wrap break-words text-sm" dir="auto">{m.text}</p> : null;

  switch (m.messageType) {
    case 'IMAGE':
      if (!media) break;
      return (
        <>
          {problem ? (
            <MediaProblem state={problem} onRetry={retry} />
          ) : (
            <a
              href={src}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => {
                e.preventDefault();
                onOpenImage(src, m.text);
              }}
              className="block rounded-lg overflow-hidden focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sys-primary)]"
              aria-label="فتح الصورة"
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- an authenticated, per-message file: not for the image optimizer */}
              <img src={src} alt={m.text || 'صورة'} loading="lazy" onError={() => setBroken(true)} className="block max-h-72 w-auto max-w-full object-cover bg-[var(--sys-surface)]" />
            </a>
          )}
          {caption}
        </>
      );
    case 'STICKER':
      if (!media) break;
      return problem ? (
        <MediaProblem state={problem} onRetry={retry} />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- an authenticated, per-message file
        <img src={src} alt="ملصق" loading="lazy" onError={() => setBroken(true)} className="block w-32 h-32 object-contain" />
      );
    case 'AUDIO':
      if (!media) break;
      return problem ? <MediaProblem state={problem} onRetry={retry} /> : <VoicePlayer src={src} voice={media.voice} mine={mine} />;
    case 'VIDEO':
      if (!media) break;
      return (
        <>
          {problem ? (
            <MediaProblem state={problem} onRetry={retry} />
          ) : (
            <video src={src} controls preload="metadata" onError={() => setBroken(true)} className="block rounded-lg max-h-72 w-full bg-[var(--sys-surface-strong)]">
              <track kind="captions" />
            </video>
          )}
          {caption}
        </>
      );
    case 'DOCUMENT':
      if (!media) break;
      return (
        <>
          {problem ? (
            <MediaProblem state={problem} onRetry={retry} />
          ) : (
            <div className="flex items-center gap-3 p-2 rounded-lg bg-[var(--sys-surface)] min-w-0">
              <span className="shrink-0 w-10 h-10 rounded-lg bg-[var(--sys-primary-soft)] text-[var(--sys-primary)] flex items-center justify-center">
                <RiFileTextLine className="w-5 h-5" />
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-[var(--sys-heading)] truncate" dir="auto">{media.fileName || 'ملف'}</p>
                <p className="text-note text-[var(--sys-muted-foreground)]" dir="ltr">
                  {[(media.mimeType || '').split('/')[1]?.split(';')[0]?.toUpperCase(), formatBytes(media.size)].filter(Boolean).join(' · ')}
                </p>
              </div>
              <a
                href={`${media.url}?download=1`}
                download={media.fileName || true}
                aria-label="تنزيل الملف"
                title="تنزيل الملف"
                className="shrink-0 inline-flex items-center justify-center w-11 h-11 rounded-lg text-[var(--sys-primary)] hover:bg-[var(--sys-primary-soft)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sys-primary)]"
              >
                <RiDownloadLine className="w-5 h-5" />
              </a>
            </div>
          )}
          {caption}
        </>
      );
    case 'LOCATION':
      if (!m.location) break;
      return (
        <a
          href={mapLink(m.location.latitude, m.location.longitude)}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-3 p-2 rounded-lg bg-[var(--sys-surface)] hover:bg-[var(--sys-surface-strong)] min-w-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sys-primary)]"
        >
          <span className="shrink-0 w-10 h-10 rounded-lg bg-[var(--sys-destructive-soft)] text-[var(--sys-destructive)] flex items-center justify-center">
            <RiMapPinLine className="w-5 h-5" />
          </span>
          <span className="flex-1 min-w-0">
            <span className="block text-sm font-semibold text-[var(--sys-heading)] truncate" dir="auto">{m.location.name || 'موقع مُرسَل'}</span>
            <span className="block text-note text-[var(--sys-muted-foreground)] truncate" dir="auto">
              {m.location.address || `${m.location.latitude.toFixed(5)}, ${m.location.longitude.toFixed(5)}`}
            </span>
            <span className="block text-note text-[var(--sys-primary)] font-semibold">فتح على الخريطة</span>
          </span>
        </a>
      );
    case 'CONTACTS':
      if (!m.contacts?.length) break;
      return (
        <div className="space-y-1.5">
          {m.contacts.map((c, i) => (
            <div key={i} className="flex items-center gap-3 p-2 rounded-lg bg-[var(--sys-surface)] min-w-0">
              <span className="shrink-0 w-10 h-10 rounded-full bg-[var(--sys-surface-strong)] text-[var(--sys-muted-foreground)] flex items-center justify-center">
                <RiUserLine className="w-5 h-5" />
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-sm font-semibold text-[var(--sys-heading)] truncate" dir="auto">{c.name || 'جهة اتصال'}</span>
                {c.phones.map((p) => (
                  <span key={p} className="block text-note text-[var(--sys-muted-foreground)]" dir="ltr">{p}</span>
                ))}
              </span>
            </div>
          ))}
        </div>
      );
    case 'INTERACTIVE':
    case 'BUTTON':
      return (
        <>
          <p className="flex items-center gap-1 text-note text-[var(--sys-muted-foreground)]">
            <RiReplyLine className="w-4 h-4" /> {kindLabel(m.messageType)}
          </p>
          <p className="whitespace-pre-wrap break-words font-semibold" dir="auto">{m.text || '—'}</p>
        </>
      );
    case 'UNSUPPORTED':
      return <p className="italic text-[var(--sys-muted-foreground)]">رسالة لا يعرضها واتساب للأعمال — افتحها من هاتف الزبون إن لزم.</p>;
    default:
      break;
  }

  if (m.messageType === 'TEXT' || m.messageType === 'TEMPLATE' || m.text) {
    return (
      <p className={`whitespace-pre-wrap break-words ${isEmojiOnly(m.text) ? 'text-4xl leading-tight' : ''}`} dir="auto">
        {m.text || ''}
      </p>
    );
  }
  return <p className="italic text-[var(--sys-muted-foreground)]">{kindLabel(m.messageType)}</p>;
}

export interface MessageBubbleProps {
  message: WaMessage;
  reactions?: { emoji: string; mine: boolean }[];
  onOpenImage: (src: string, caption: string | null) => void;
  /** Absent = this person cannot react here (no send key, a closed conversation, a closed window). */
  onReact?: (messageId: string, emoji: string) => void;
}

/**
 * ONE MESSAGE, DRAWN BY ITS KIND — text, photo (opens large), voice note (played in place), video, file (with its download),
 * place (opens the map), contact card, sticker, a button the customer pressed — with the message it answers quoted on top, its
 * reactions under it, and, for ours, the ticks.
 */
export function MessageBubble({ message: m, reactions = [], onOpenImage, onReact }: MessageBubbleProps) {
  const mine = m.direction === 'OUTBOUND';
  const [picking, setPicking] = useState(false);
  const bare = m.messageType === 'STICKER' || (m.messageType === 'TEXT' && isEmojiOnly(m.text));
  const myReaction = reactions.find((r) => r.mine)?.emoji ?? null;

  return (
    <div className={`group flex items-end gap-1 ${mine ? 'justify-end' : 'justify-start'}`} data-message-id={m.id}>
      {mine && onReact && <ReactControl picking={picking} setPicking={setPicking} onPick={(e) => onReact(m.id, e === myReaction ? '' : e)} />}
      <div className={`relative max-w-[75%] ${reactions.length ? 'mb-3' : ''}`}>
        <div
          className={
            bare
              ? 'px-1 py-0.5 text-sm text-[var(--sys-heading)]'
              : `rounded-lg px-3 py-2 text-sm shadow-raised text-[var(--sys-heading)] ${
                  mine
                    ? 'bg-[var(--sys-primary-soft)]'
                    : 'bg-[var(--sys-card)] border border-[var(--sys-border)]'
                }`
          }
          // The tail corner, inline: two one-off utilities cost the shared stylesheet more than they are worth (CSS budget).
          style={bare ? undefined : mine ? { borderEndEndRadius: 4 } : { borderEndStartRadius: 4 }}
        >
          {m.replyTo && (
            <div className="mb-1.5 ps-2 pe-2 py-1 rounded-lg border-s-4 border-[var(--sys-primary)] bg-[var(--sys-surface)] text-note min-w-0">
              <p className="font-semibold text-[var(--sys-primary)]">{m.replyTo.direction === 'OUTBOUND' ? 'أنت' : 'الزبون'}</p>
              <p className="text-[var(--sys-muted-foreground)] truncate" dir="auto">{m.replyTo.text || kindLabel(m.replyTo.messageType)}</p>
            </div>
          )}
          <Body m={m} mine={mine} onOpenImage={onOpenImage} />
          <div className="flex items-center gap-1 justify-end mt-0.5 text-note text-[var(--sys-muted)] tabular-nums">
            <span>{arTime(m.createdAt)}</span>
            {mine && <StatusTicks status={m.status} error={m.statusError} />}
          </div>
        </div>
        {reactions.length > 0 && (
          <div style={{ bottom: -12 }} className={`absolute ${mine ? 'end-2' : 'start-2'} flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-[var(--sys-card)] shadow-raised text-sm leading-none`}>
            {reactions.map((r) => (
              <span key={`${r.emoji}-${r.mine}`} role="img" aria-label={r.mine ? `تفاعلك ${r.emoji}` : `تفاعل الزبون ${r.emoji}`}>
                {r.emoji}
              </span>
            ))}
          </div>
        )}
      </div>
      {!mine && onReact && <ReactControl picking={picking} setPicking={setPicking} onPick={(e) => onReact(m.id, e === myReaction ? '' : e)} />}
    </div>
  );
}

function ReactControl({ picking, setPicking, onPick }: { picking: boolean; setPicking: (v: boolean) => void; onPick: (emoji: string) => void }) {
  return (
    <div className={`relative shrink-0 transition-opacity ${picking ? 'opacity-100' : 'opacity-60 md:opacity-0 md:group-hover:opacity-100 focus-within:opacity-100'}`}>
      <IconButton size="sm" label="تفاعل مع الرسالة" onClick={() => setPicking(!picking)} aria-expanded={picking}>
        <RiEmotionLine className="w-4 h-4" />
      </IconButton>
      {picking && (
        <div role="group" aria-label="اختر تفاعلاً" className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 z-10 flex items-center gap-0.5 p-1 rounded-full bg-[var(--sys-card)] shadow-overlay">
          {QUICK_REACTIONS.map((e) => (
            <IconButton
              key={e}
              size="sm"
              label={`تفاعل ${e}`}
              onClick={() => {
                setPicking(false);
                onPick(e);
              }}
            >
              <span className="text-lg leading-none">{e}</span>
            </IconButton>
          ))}
        </div>
      )}
    </div>
  );
}
