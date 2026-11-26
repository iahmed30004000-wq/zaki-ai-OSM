'use client';

import React, { Suspense, useEffect, useRef, useState } from 'react';
import { RiAttachment2, RiCloseLine, RiEmotionHappyLine, RiFileTextLine, RiImageLine, RiSendPlaneLine } from '@remixicon/react';
import { IconButton } from '@/components/ui/IconButton';
import { ACCEPT_FILE, ACCEPT_IMAGE, OUTBOUND_LIMITS, OUTBOUND_MIMES, TOO_BIG_MESSAGE } from '@/lib/whatsapp/outbound-rules';
import { formatBytes } from './chat-model';

/** The picker is fetched the first time the face is pressed — the inbox's first load does not carry it. */
const EmojiPicker = React.lazy(() => import('./EmojiPicker'));

export interface PendingFile {
  file: File;
  kind: 'image' | 'file';
  preview: string | null;
}

export interface ComposerProps {
  value: string;
  onChange: (v: string) => void;
  /** Send the typed text. */
  onSend: () => void;
  /** Send a picked file, the typed text as its caption. Resolves true when it left. */
  onSendFile: (file: File, kind: 'image' | 'file', caption: string) => Promise<boolean>;
  sending: boolean;
  /** Says why a file was refused before it was sent (type, size). */
  onRefuse: (why: string) => void;
}

/**
 * THE REPLY BOX, AS WHATSAPP DRAWS IT — one rounded field holding the face for emojis, the text, a picture and a paperclip
 * for files, and the round green «إرسال» beside it.
 *
 * Enter sends and Shift+Enter starts a new line. A picked (or pasted) photo or file waits above the box with its name and size;
 * what is typed then becomes its caption, and «إرسال» sends both. The box grows with what is typed, up to a few lines.
 * A file the server would refuse for its size is refused here first, in the same words.
 */
export function Composer({ value, onChange, onSend, onSendFile, sending, onRefuse }: ComposerProps) {
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [pending, setPending] = useState<PendingFile | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
  }, [value]);

  useEffect(() => () => {
    if (pending?.preview) URL.revokeObjectURL(pending.preview);
  }, [pending]);

  const pick = (file: File | undefined | null, kind: 'image' | 'file') => {
    if (!file) return;
    const asImage = kind === 'image' && OUTBOUND_MIMES.image.includes(file.type);
    if (kind === 'image' && !asImage) {
      onRefuse('الصورة لازم تكون JPG أو PNG — أو أرسلها كملف');
      return;
    }
    const limit = asImage ? OUTBOUND_LIMITS.image : OUTBOUND_LIMITS.document;
    if (file.size > limit) {
      onRefuse(TOO_BIG_MESSAGE);
      return;
    }
    setPending({ file, kind: asImage ? 'image' : 'file', preview: asImage ? URL.createObjectURL(file) : null });
    box.current?.focus();
  };

  const insertEmoji = (emoji: string) => {
    const el = box.current;
    if (!el) {
      onChange(value + emoji);
      return;
    }
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    const next = value.slice(0, start) + emoji + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      const at = start + emoji.length;
      el.setSelectionRange(at, at);
    });
  };

  const submit = async () => {
    if (sending) return;
    if (pending) {
      const ok = await onSendFile(pending.file, pending.kind, value.trim());
      if (ok) {
        setPending(null);
        onChange('');
      }
      return;
    }
    if (value.trim()) onSend();
  };

  const canSubmit = Boolean(pending) || Boolean(value.trim());

  return (
    <div className="relative">
      {emojiOpen && (
        <Suspense fallback={null}>
          <EmojiPicker onPick={insertEmoji} onClose={() => setEmojiOpen(false)} />
        </Suspense>
      )}
      {pending && (
        <div className="wa-attach min-w-0">
          {pending.preview ? (
            // eslint-disable-next-line @next/next/no-img-element -- a local preview of the picked file
            <img src={pending.preview} alt="معاينة الصورة" className="w-14 h-14 rounded-lg object-cover shrink-0" />
          ) : (
            <span className="shrink-0 w-14 h-14 rounded-lg bg-[var(--sys-primary-soft)] text-[var(--sys-primary)] flex items-center justify-center">
              <RiFileTextLine className="w-6 h-6" />
            </span>
          )}
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-[var(--sys-heading)] truncate" dir="auto">{pending.file.name}</p>
            <p className="text-note text-[var(--sys-muted-foreground)]">
              {formatBytes(pending.file.size)} · {pending.kind === 'image' ? 'اكتب تعليقاً إن أردت ثم أرسل' : 'سيُرسل كملف'}
            </p>
          </div>
          <IconButton size="sm" label="إزالة المرفق" onClick={() => setPending(null)} className="shrink-0">
            <RiCloseLine className="w-4 h-4" />
          </IconButton>
        </div>
      )}
      <div className="wa-compose">
        <div className="wa-pill">
        <span data-emoji-toggle className="shrink-0">
          <IconButton label="إيموجي" onClick={() => setEmojiOpen((o) => !o)} aria-expanded={emojiOpen} className="wa-ib shrink-0">
            <RiEmotionHappyLine className="w-5 h-5" />
          </IconButton>
        </span>
        <input
          ref={imageInput}
          type="file"
          accept={ACCEPT_IMAGE}
          className="hidden"
          aria-hidden="true"
          tabIndex={-1}
          onChange={(e) => {
            pick(e.target.files?.[0], 'image');
            e.target.value = '';
          }}
        />
        <input
          ref={fileInput}
          type="file"
          accept={ACCEPT_FILE}
          className="hidden"
          aria-hidden="true"
          tabIndex={-1}
          onChange={(e) => {
            pick(e.target.files?.[0], 'file');
            e.target.value = '';
          }}
        />
        <textarea
          ref={box}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
          onPaste={(e) => {
            const f = [...e.clipboardData.files].find((x) => x.type.startsWith('image/'));
            if (f) {
              e.preventDefault();
              pick(f, 'image');
            }
          }}
          rows={1}
          dir="auto"
          aria-label={pending ? 'تعليق على المرفق' : 'نص الرسالة'}
          placeholder={pending ? 'أضف تعليقاً...' : 'اكتب رسالة...'}
          className="flex-1 min-w-0"
        />
        <IconButton label="إرفاق صورة" onClick={() => imageInput.current?.click()} className="wa-ib shrink-0">
          <RiImageLine className="w-5 h-5" />
        </IconButton>
        <IconButton label="إرفاق ملف" onClick={() => fileInput.current?.click()} className="wa-ib shrink-0">
          <RiAttachment2 className="w-5 h-5" />
        </IconButton>
        </div>
        <IconButton variant="primary" label="إرسال" onClick={() => { void submit(); }} loading={sending} disabled={sending || !canSubmit} className="wa-send shrink-0">
          <RiSendPlaneLine className="icon-mirror w-5 h-5" />
        </IconButton>
      </div>
    </div>
  );
}
