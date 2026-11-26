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
  RiSparkling2Line,
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

/** The ticks of a message we sent: one, two, two in WhatsApp's blue once read, or the failure with Meta's reason. */
function StatusTicks({ status, error }: { status: string; error?: string | null }) {
  if (status === 'FAILED') {
    return (
      <span className="inline-flex items-center text-[var(--sys-destructive)]" title={error || 'لم تُرسل'} aria-label={error ? `لم تُرسل: ${error}` : 'لم تُرسل'} role="img">
        <RiErrorWarningLine />
      </span>
    );
  }
  if (status === 'READ') return <RiCheckDoubleLine role="img" aria-label="قُرئت" className="wa-tick-read" />;
  if (status === 'DELIVERED') return <RiCheckDoubleLine role="img" aria-label="وصلت" className="wa-tick" />;
  if (status === 'SENT') return <RiCheckLine role="img" aria-label="أُرسلت" className="wa-tick" />;
  return <RiTimeLine role="img" aria-label="قيد الإرسال" className="wa-tick" />;
}

function MediaProblem({ state, onRetry }: { state: 'FAILED' | 'TOO_LARGE'; onRetry: () => void }) {
  return (
    <div className="wa-card">
      <RiErrorWarningLine className="w-4 h-4 shrink-0" />
      <span className="flex-1 text-note">{state === 'TOO_LARGE' ? 'الملف أكبر من الحد الذي نحفظه' : 'تعذّر تحميل الملف من واتساب'}</span>
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
  const caption = m.text ? <p className="wa-text" dir="auto">{m.text}</p> : null;

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
              className="wa-media focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sys-primary)]"
              aria-label="فتح الصورة"
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- an authenticated, per-message file: not for the image optimizer */}
              <img src={src} alt={m.text || 'صورة'} loading="lazy" onError={() => setBroken(true)} />
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
        <img src={src} alt="ملصق" loading="lazy" onError={() => setBroken(true)} className="block object-contain" style={{ width: 128, height: 128 }} />
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
            <span className="wa-media">
              <video src={src} controls preload="metadata" onError={() => setBroken(true)}>
                <track kind="captions" />
              </video>
            </span>
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
            <div className="wa-card">
              <span className="wa-card-ic">
                <RiFileTextLine className="w-5 h-5" />
              </span>
              <div className="flex-1 min-w-0">
                <b dir="auto">{media.fileName || 'ملف'}</b>
                <small dir="ltr">
                  {[(media.mimeType || '').split('/')[1]?.split(';')[0]?.toUpperCase(), formatBytes(media.size)].filter(Boolean).join(' · ')}
                </small>
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
          className="wa-card focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sys-primary)]"
        >
          <span className="wa-card-ic">
            <RiMapPinLine className="w-5 h-5" />
          </span>
          <span className="flex-1 min-w-0">
            <b dir="auto">{m.location.name || 'موقع مُرسَل'}</b>
            <small dir="auto">{m.location.address || `${m.location.latitude.toFixed(5)}, ${m.location.longitude.toFixed(5)}`}</small>
            <small>فتح على الخريطة</small>
          </span>
        </a>
      );
    case 'CONTACTS':
      if (!m.contacts?.length) break;
      return (
        <div className="space-y-1.5">
          {m.contacts.map((c, i) => (
            <div key={i} className="wa-card">
              <span className="wa-card-ic">
                <RiUserLine className="w-5 h-5" />
              </span>
              <span className="flex-1 min-w-0">
                <b dir="auto">{c.name || 'جهة اتصال'}</b>
                {c.phones.map((p) => (
                  <small key={p} dir="ltr">{p}</small>
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
          <p className="wa-text font-semibold" dir="auto">{m.text || '—'}</p>
        </>
      );
    case 'UNSUPPORTED':
      return <p className="italic text-[var(--sys-muted-foreground)]">رسالة لا يعرضها واتساب للأعمال — افتحها من هاتف الزبون إن لزم.</p>;
    default:
      break;
  }

  if (m.messageType === 'TEXT' || m.messageType === 'TEMPLATE' || m.text) {
    return (
      <p className={`wa-text${isEmojiOnly(m.text) ? ' big' : ''}`} dir="auto">
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
  /** The first of a run from one side: the bubble wears WhatsApp's tail. */
  first?: boolean;
  /** The order bot's name, written over the messages it sent. */
  botName?: string;
}

/**
 * ONE MESSAGE, DRAWN BY ITS KIND AND DRESSED AS WHATSAPP — ours green on the right, theirs white on the left, the tail on
 * the first of a run, the time and the ticks inside the bubble's corner, the bot's name over what the bot wrote; a photo
 * opens large, a voice note plays in place, a file has its download, a place opens the map; the quoted message on top and
 * the reactions under it.
 */
export function MessageBubble({ message: m, reactions = [], onOpenImage, onReact, first = true, botName }: MessageBubbleProps) {
  const mine = m.direction === 'OUTBOUND';
  const [picking, setPicking] = useState(false);
  const bare = m.messageType === 'STICKER' || (m.messageType === 'TEXT' && isEmojiOnly(m.text));
  const myReaction = reactions.find((r) => r.mine)?.emoji ?? null;
  const side = mine ? 'out' : 'in';

  return (
    <div className={`wa-msg ${side}${first ? ' first' : ''}`} data-message-id={m.id}>
      {mine && onReact && <ReactControl picking={picking} setPicking={setPicking} onPick={(e) => onReact(m.id, e === myReaction ? '' : e)} />}
      <div className={`wa-holder${reactions.length ? ' reacted' : ''}`}>
        <div className={`wa-b ${side}${bare ? ' bare' : first ? ' tail' : ''}`}>
          {mine && m.byBot && (
            <span className="wa-by">
              <RiSparkling2Line aria-hidden="true" />
              {botName || 'البوت'}
            </span>
          )}
          {m.replyTo && (
            <div className="wa-quote">
              <b>{m.replyTo.direction === 'OUTBOUND' ? 'أنت' : 'الزبون'}</b>
              <span dir="auto">{m.replyTo.text || kindLabel(m.replyTo.messageType)}</span>
            </div>
          )}
          <Body m={m} mine={mine} onOpenImage={onOpenImage} />
          <span className="wa-meta">
            <span>{arTime(m.createdAt)}</span>
            {mine && <StatusTicks status={m.status} error={m.statusError} />}
          </span>
        </div>
        {reactions.length > 0 && (
          <div className={`wa-reacts ${side}`}>
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
    <div className="wa-react relative shrink-0" data-open={picking ? 'true' : 'false'}>
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
