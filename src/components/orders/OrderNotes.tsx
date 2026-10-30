'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { apiJson } from '@/lib/api-client';
import { NOTE_KIND_AR } from '@/lib/order-notes';
import { arDateShort } from '@/lib/format';
import { RiChatQuoteLine, RiLoader4Line, RiSendPlaneLine } from '@remixicon/react';
import { useToast } from '@/components/ui/Toast';

/**
 * The conversation about an order, between the people working it.
 *
 * Internal notes used to be one text box inside the order-data form: saving
 * it overwrote whatever the last person wrote, so the field only ever held
 * the most recent thought and the reasoning behind a decision disappeared
 * the moment somebody else edited the order.
 *
 * They are appended now, each with its author and its moment, and nothing
 * here edits or deletes. A note is what somebody said at a time — the point
 * of keeping it is that it stays said.
 *
 * It sits directly under the journey and is built to the same rhythm: the
 * same card, the same heading, the same 11px body and 10px byline, so the
 * two read as one story — what happened, then what was said about it.
 */

interface Note {
  id: string;
  body: string;
  kind: string;
  createdAt: string;
  authorName: string | null;
}

/*
 * The four words live in `lib/order-notes.ts` now. A second copy here is how
 * «متابعة» becomes «اتصال» on one screen and nobody chose that.
 */
const KIND_AR = NOTE_KIND_AR as Record<string, string>;

/** One colour per author, picked from their name so it never moves. */
const TONES = [
  'bg-[var(--sys-primary-soft)] text-[var(--sys-primary)]',
  'bg-[var(--sys-surface)] text-[var(--sys-muted-foreground)]',
  'bg-[var(--sys-success-soft)] text-[var(--sys-success)]',
  'bg-[var(--sys-warning-soft)] text-[var(--sys-warning)]',
  'bg-[var(--sys-surface)] text-[var(--sys-muted-foreground)]',
];
function toneFor(name: string): string {
  let sum = 0;
  for (let i = 0; i < name.length; i++) sum += name.charCodeAt(i);
  return TONES[sum % TONES.length];
}
const initials = (name: string) => name.trim().charAt(0) || '؟';

/** `canWrite`: writing a note is a key of its own (PR-6, `orders.note`); reading the thread is not. UX only — the server asks the same. */
export function OrderNotes({ orderId, canWrite: mayWrite = true }: { orderId: string; canWrite?: boolean }) {
  const toast = useToast();
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiJson<{ notes: Note[] }>(`/api/orders/${orderId}/notes`);
      setNotes(res.notes);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر تحميل الملاحظات');
    }
  }, [orderId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function send() {
    const body = draft.trim();
    if (body.length < 2) return;
    setBusy(true);
    try {
      await apiJson(`/api/orders/${orderId}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body, kind: 'internal' }),
      });
      setDraft('');
      await load();
      box.current?.focus();
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذر إضافة الملاحظة');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg p-4 shadow-raised">
      <div className="flex items-center gap-2 mb-4">
        <RiChatQuoteLine className="w-4 h-4 text-[var(--sys-primary)]" />
        <h4 className="text-xs font-black text-[var(--sys-foreground)]">ملاحظات داخلية</h4>
        {notes && notes.length > 0 && (
          <span className="text-xs font-medium text-[var(--sys-muted)] tabular-nums">{notes.length}</span>
        )}
      </div>

      {notes === null ? (
        <p className="text-xs text-[var(--sys-muted)] flex items-center gap-1.5 py-2">
          <RiLoader4Line className="w-4 h-4 animate-spin" /> جارٍ التحميل…
        </p>
      ) : notes.length === 0 ? (
        <p className="text-xs text-[var(--sys-muted)] py-2">لا ملاحظات بعد — اكتب أول واحدة.</p>
      ) : (
        <ol className="space-y-2.5">
          {notes.map((note) => {
            const who = note.authorName ?? 'النظام';
            return (
              <li key={note.id} className="flex gap-2.5">
                <span
                  className={`w-7 h-7 rounded-full shrink-0 flex items-center justify-center text-xs font-bold ${toneFor(who)}`}
                  aria-hidden="true"
                >
                  {initials(who)}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-[var(--sys-heading)] whitespace-pre-line break-words leading-relaxed">
                    {note.body}
                  </p>
                  <p className="text-xs text-[var(--sys-muted)] mt-0.5 flex flex-wrap gap-x-1.5">
                    <span className="font-medium text-[var(--sys-muted-foreground)]">{who}</span>
                    <span>· {arDateShort(note.createdAt)}</span>
                    {note.kind !== 'internal' && <span>· {KIND_AR[note.kind] ?? note.kind}</span>}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {error && <p className="text-xs text-[var(--sys-destructive)] mt-2">{error}</p>}

      {mayWrite && (
      <div className="mt-4 pt-3 border-t border-[var(--sys-border)]">
        <div className="flex items-end gap-2">
          <textarea
            ref={box}
            rows={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends, Shift+Enter makes a new line.
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder="اكتب ملاحظة لمن يكمل هذا الطلب…"
            className="flex-1 min-h-9 max-h-32 px-3 py-2 rounded-lg border border-[var(--sys-border-input)] text-xs resize-y focus:outline-none focus:border-[var(--sys-primary)]"
          />
          <button
            onClick={send}
            disabled={busy || draft.trim().length < 2}
            className="h-11 md:h-9 w-9 min-w-11 md:min-w-0 rounded-lg bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] disabled:opacity-30 flex items-center justify-center shrink-0"
            aria-label="أضف الملاحظة (Enter)" title="أضف الملاحظة (Enter)"
          >
            {busy ? <RiLoader4Line className="w-4 h-4 animate-spin" /> : <RiSendPlaneLine className="icon-mirror w-4 h-4" />}
          </button>
        </div>
        <p className="text-xs text-[var(--sys-muted)] mt-1.5">
          تُضاف ولا تُعدَّل — تبقى كما كُتبت وباسم كاتبها.
        </p>
      </div>
      )}
    </div>
  );
}
