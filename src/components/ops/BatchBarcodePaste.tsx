'use client';

import React, { useState } from 'react';
import { RiLoader4Line } from '@remixicon/react';
import { Modal } from '@/components/ui/Modal';
import { Textarea } from '@/components/ui/Input';
import { OrderRef } from '@/components/orders/OrderRef';
import { apiJson } from '@/lib/api-client';
import type { LineOutcome, LineResult } from '@/lib/batch-barcodes';

/**
 * «لصق الباركودات» — the courier's barcodes of a batch, pasted as lines (RV165, the owner 3/11).
 *
 * For the batch handed over before «رحّل إلى الشركة»: its parcels were made at the courier's portal by hand, and their
 * barcodes come back as a list. «تحقّق» asks the server what each line would do and writes nothing; «اكتب» sends the same
 * paste to be written, and only after a «تحقّق» of exactly that text. Every line is answered beside its number.
 */

interface Answer {
  dryRun: boolean;
  counts: Record<LineOutcome, number>;
  lines: LineResult[];
}

const WORD: Record<LineOutcome, { dry: string; done: string; cls: string }> = {
  written: { dry: 'رح ينكتب', done: 'انكتب', cls: 'text-[var(--sys-success)]' },
  unchanged: { dry: 'ما رح يتغيّر', done: 'ما تغيّر', cls: 'text-[var(--sys-muted-foreground)]' },
  refused: { dry: 'مرفوض', done: 'مرفوض', cls: 'text-[var(--sys-destructive)]' },
};

export function BatchBarcodePaste({
  batch,
  onClose,
  onWritten,
}: {
  batch: { id: string; batchNumber: string };
  onClose: () => void;
  /** After a write that changed at least one order: the list re-reads. */
  onWritten: (written: number) => void;
}) {
  const [text, setText] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState<'check' | 'write' | null>(null);
  const [answer, setAnswer] = useState<Answer | null>(null);
  // The text and the box the last «تحقّق» answered: «اكتب» is offered for exactly that, never for an edit made after it.
  const [checked, setChecked] = useState<{ text: string; overwrite: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send(dryRun: boolean) {
    setBusy(dryRun ? 'check' : 'write');
    setError(null);
    try {
      const res = await apiJson<Answer>(`/api/shipping-batches/${batch.id}/tracking`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, dryRun, ...(overwrite ? { overwrite: true } : {}) }),
      });
      setAnswer(res);
      if (dryRun) {
        setChecked({ text, overwrite });
      } else {
        setChecked(null);
        if (res.counts.written > 0) onWritten(res.counts.written);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذّر الإرسال');
      setChecked(null);
    } finally {
      setBusy(null);
    }
  }

  const fresh = checked !== null && checked.text === text && checked.overwrite === overwrite;
  const mayWrite = fresh && answer?.dryRun === true && answer.counts.written > 0;

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={`لصق باركودات ${batch.batchNumber}`}
      subtitle="كل سطر: رقم الطلب وبعده باركود الشركة — بينهم فاصلة أو مسافة، أو منسوخ من إكسل"
      maxWidth="lg"
      footer={
        <div className="flex gap-2">
          <button
            onClick={() => void send(true)}
            disabled={busy !== null || !text.trim()}
            className="min-h-11 md:min-h-0 inline-flex items-center text-xs px-3 py-1.5 rounded-lg border border-[var(--sys-border)] text-[var(--sys-muted-foreground)] hover:text-[var(--sys-primary)] inline-flex items-center gap-1.5 disabled:opacity-40"
          >
            {busy === 'check' && <RiLoader4Line className="w-4 h-4 animate-spin" />}
            تحقّق
          </button>
          <button
            onClick={() => void send(false)}
            disabled={busy !== null || !mayWrite}
            title={mayWrite ? undefined : 'اضغط «تحقّق» أول — «اكتب» بيكتب اللي ظهر بالتحقّق بس'}
            className="min-h-11 md:min-h-0 inline-flex items-center text-xs px-3 py-1.5 rounded-lg bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] font-medium disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            {busy === 'write' && <RiLoader4Line className="w-4 h-4 animate-spin" />}
            {mayWrite ? `اكتب (${answer.counts.written})` : 'اكتب'}
          </button>
          <button
            onClick={onClose}
            className="min-h-11 md:min-h-0 inline-flex items-center text-xs px-3 py-1.5 rounded-lg border border-[var(--sys-border)] text-[var(--sys-muted-foreground)]"
          >
            إغلاق
          </button>
        </div>
      }
    >
      <div className="space-y-3">
        <Textarea
          label="الباركودات"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={8}
          dir="ltr"
          placeholder={'ORD-2026-0722, 1234567890\nORD-2026-0963\t1234567891'}
          helperText="رقم الطلب أو رقمنا المرجعي. طلب من دفعة تانية بينرفض، وطلب عليه باركود تاني ما بيتغيّر إلا إذا علّمت تحت."
        />
        <label className="flex items-center gap-2 text-xs text-[var(--sys-foreground)]">
          <input
            type="checkbox"
            checked={overwrite}
            onChange={(e) => setOverwrite(e.target.checked)}
            className="h-3.5 w-3.5 cursor-pointer accent-[var(--sys-primary)]"
          />
          استبدل الباركود القديم إذا الطلب عليه باركود تاني
        </label>

        {error && (
          <p className="text-xs text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] rounded-lg px-2.5 py-1.5">
            {error}
          </p>
        )}

        {answer && (
          <div role="status" className="space-y-2">
            <p className="text-xs font-bold text-[var(--sys-heading)]">
              {answer.dryRun ? 'نتيجة التحقّق (ما انكتب شي): ' : 'انحفظ: '}
              {`${WORD.written[answer.dryRun ? 'dry' : 'done']} ${answer.counts.written} · `}
              {`${WORD.unchanged[answer.dryRun ? 'dry' : 'done']} ${answer.counts.unchanged} · `}
              {`مرفوض ${answer.counts.refused}`}
            </p>
            {answer.dryRun && !fresh && (
              <p className="text-xs text-[var(--sys-warning)]">تغيّرت اللصقة بعد التحقّق — اضغط «تحقّق» من جديد.</p>
            )}
            <ul className="divide-y divide-[var(--sys-border)] rounded-lg border border-[var(--sys-border)]">
              {answer.lines.map((l) => (
                <li key={l.line} className="flex flex-wrap items-center gap-2 p-2 text-xs">
                  <span className="text-[var(--sys-muted)] tabular-nums">سطر {l.line}</span>
                  {/* A line that named an order of the batch draws it through `OrderRef`; one that did not is what was pasted. */}
                  {l.orderId && l.orderNumber ? (
                    <OrderRef id={l.orderId} number={l.orderNumber} className="font-bold" />
                  ) : (
                    <span className="font-bold text-[var(--sys-heading)]" dir="ltr">{l.ref}</span>
                  )}
                  {l.barcode && <span className="text-[var(--sys-muted)]" dir="ltr">{l.barcode}</span>}
                  <span className={`font-medium ${WORD[l.outcome].cls}`}>{WORD[l.outcome][answer.dryRun ? 'dry' : 'done']}</span>
                  {l.reason && <span className="text-[var(--sys-muted-foreground)]">— {l.reason}</span>}
                  {l.outcome === 'written' && l.previous && (
                    <span className="text-[var(--sys-muted-foreground)]">
                      — مكان <span dir="ltr">{l.previous}</span>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  );
}
