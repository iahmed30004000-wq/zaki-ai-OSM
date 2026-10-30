'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { apiJson } from '@/lib/api-client';
import { changeFieldLabel, PRICE_KEY_REQUIRED_AR, readLinesChange } from '@/lib/change-request-fields';
import { LinesRequestReview, type Verdict } from '@/components/orders/LinesRequestReview';
import { REVIEW_UNCHECKED_AR } from '@/lib/change-request-review';
import { RiAlertLine, RiArrowLeftLine, RiCheckLine, RiCloseLine, RiLoader4Line } from '@remixicon/react';
import { useToast } from '@/components/ui/Toast';
import { arDateTime } from '@/lib/format';

/**
 * ONE CHANGE REQUEST, DECIDED.
 *
 * It opens where the work is — on the packing line, on the order the box is
 * being filled for — because the answer to "can this still be changed?"
 * depends on what is happening to that box right now, and the person with
 * the box is the one who knows.
 *
 * Two things it is careful about:
 *
 *   The BEFORE and the AFTER are both shown. A request that says only "make
 *   it 3" is unanswerable; three instead of what?
 *
 *   A refusal must say what happens next. "مرفوض" on its own leaves the
 *   person who asked with a customer on the phone and nothing to tell them,
 *   so the reason is required — the server refuses a rejection without one,
 *   and this asks for it before letting the button work.
 */

interface RequestRow {
  id: string;
  orderId: string;
  reason: string;
  /** Each field as `{ from, to }`; the key `lines` is the one that is not (the request edits several lines). */
  changes: Record<string, unknown> | null;
  requestedByName?: string | null;
  requestedRole?: string | null;
  createdAt: string;
  order?: { orderNumber: string } | null;
  /** The request moves a figure and the reader lacks the price key (the server says; it also refuses the press). */
  needsPriceKey?: boolean;
}


function show(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function ChangeRequestReview({
  requestId,
  onClose,
  onDecided,
}: {
  requestId: string;
  onClose: () => void;
  onDecided: () => void;
}) {
  const toast = useToast();
  const [row, setRow] = useState<RequestRow | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'APPROVED' | 'REJECTED' | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** What the check of a lines request says: still asking, or the sentence that shuts the approve button. */
  const [verdict, setVerdict] = useState<Verdict>({ checking: true, shut: null });

  const load = useCallback(async () => {
    try {
      const data = await apiJson<{ requests: RequestRow[] }>('/api/control/change-requests?status=all');
      const found = data.requests?.find((r) => r.id === requestId) ?? null;
      setRow(found);
      if (!found) setError('طلب التعديل لم يعد معروضاً لك — ربما بُتّ فيه.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر التحميل');
    }
  }, [requestId]);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (decision: 'APPROVED' | 'REJECTED') => {
    setBusy(decision);
    try {
      await apiJson(`/api/control/change-requests/${requestId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, note: note.trim() || undefined }),
      });
      onDecided();
      onClose();
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذر حفظ القرار');
    } finally {
      setBusy(null);
    }
  };

  const fields = Object.entries((row?.changes ?? {}) as Record<string, { from?: unknown; to?: unknown }>).filter(([f]) => f !== 'lines');
  // A request that edits lines carries its own key; it is read strictly, and one that cannot be read is never approved.
  const lines = readLinesChange(row?.changes);
  const linesRequest = lines.ok && lines.value !== null;
  const approveShut = !row
    ? null
    : !lines.ok
      ? lines.error
      : linesRequest
        ? verdict.checking
          ? 'جارٍ فحص الطلب…'
          : verdict.unchecked
            ? REVIEW_UNCHECKED_AR
            : verdict.shut
        : null;

  return (
    <Modal isOpen onClose={onClose} title={`طلب تعديل · ${row?.order?.orderNumber ?? ''}`}>
      <div className="space-y-4">
        {row && (
          <>
            <p className="text-xs text-[var(--sys-muted-foreground)]">
              {row.requestedByName ?? 'موظف'} · {arDateTime(row.createdAt)}
            </p>

            <div className="rounded-lg border border-[var(--sys-border)] divide-y divide-[var(--sys-border)]">
              {fields.length === 0 && !linesRequest ? (
                <p className="p-3 text-xs text-[var(--sys-muted)]">لا تفاصيل مرفقة.</p>
              ) : (
                fields.map(([field, change]) => (
                  <div key={field} className="p-3">
                    <p className="text-xs font-semibold text-[var(--sys-muted-foreground)] mb-1">
                      {changeFieldLabel(field)}
                    </p>
                    <div className="flex items-center gap-2 text-xs flex-wrap">
                      <span className="text-[var(--sys-muted)] line-through">{show(change?.from)}</span>
                      <RiArrowLeftLine className="icon-mirror w-4 h-4 text-[var(--sys-primary)] shrink-0" />
                      <span className="font-semibold text-[var(--sys-heading)]">{show(change?.to)}</span>
                    </div>
                  </div>
                ))
              )}
            </div>

            {linesRequest && (
              <div className="space-y-2">
                <p className="text-xs font-semibold text-[var(--sys-muted-foreground)]">{changeFieldLabel('lines')}</p>
                <LinesRequestReview requestId={requestId} refreshKey={row.id} onVerdict={setVerdict} />
              </div>
            )}

            <div className="rounded-lg bg-[var(--sys-surface)] border border-[var(--sys-border)] p-3">
              <p className="text-xs font-semibold text-[var(--sys-muted-foreground)] mb-1">السبب</p>
              <p className="text-xs text-[var(--sys-foreground)]">{row.reason}</p>
            </div>

            <label className="block">
              <span className="block text-xs text-[var(--sys-muted-foreground)] mb-1">
                ردّك — <span className="text-[var(--sys-warning)]">مطلوب مع الرفض</span>
              </span>
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="مثلاً: الطرد خرج مع المندوب، بلّغي الزبون أنه سيُسلَّم بالعنوان القديم"
                maxLength={500}
                className="w-full h-11 md:h-10 px-2 rounded-lg border border-[var(--sys-border-input)] bg-[var(--sys-card)] text-xs text-[var(--sys-foreground)] focus:outline-none focus:border-[var(--sys-primary)]"
              />
            </label>

            <p className="flex items-start gap-1.5 text-xs text-[var(--sys-muted-foreground)]">
              <RiAlertLine className="w-4 h-4 text-[var(--sys-warning)] shrink-0 mt-0.5" />
              الموافقة تسجّل القرار ولا تكتب التعديل بعد — يظهر بعدها في «بانتظار التطبيق» بطلبات
              التعديل، ومن هناك يُطبَّق بزرّ واحد عبر مسار المال نفسه، لا بنسخ حقل.
            </p>
          </>
        )}

        {row?.needsPriceKey && (
          <p className="flex items-start gap-1.5 text-xs text-[var(--sys-muted-foreground)]">
            <RiAlertLine className="w-4 h-4 text-[var(--sys-warning)] shrink-0 mt-0.5" />
            {PRICE_KEY_REQUIRED_AR} الرفض متاح.
          </p>
        )}

        {approveShut && row?.needsPriceKey !== true && (
          <p className="flex items-start gap-1.5 text-xs text-[var(--sys-muted-foreground)]">
            <RiAlertLine className="w-4 h-4 text-[var(--sys-warning)] shrink-0 mt-0.5" />
            الموافقة مقفلة: {approveShut} الرفض متاح.
          </p>
        )}

        {error && (
          <p className="text-xs text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] rounded-lg p-2.5">{error}</p>
        )}

        <div className="flex gap-2 justify-end pt-1">
          <Button variant="outline" size="sm" onClick={onClose} disabled={!!busy}>
            إغلاق
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => decide('REJECTED')}
            disabled={!!busy || !row || !note.trim()}
            title={!note.trim() ? 'الرفض يتطلب سبباً' : undefined}
          >
            {busy === 'REJECTED' ? <RiLoader4Line className="w-4 h-4 animate-spin" /> : <RiCloseLine className="w-4 h-4" />}
            رفض
          </Button>
          <Button
            size="sm"
            onClick={() => decide('APPROVED')}
            disabled={!!busy || !row || row.needsPriceKey === true || approveShut !== null}
            title={row?.needsPriceKey ? PRICE_KEY_REQUIRED_AR : (approveShut ?? undefined)}
          >
            {busy === 'APPROVED' ? <RiLoader4Line className="w-4 h-4 animate-spin" /> : <RiCheckLine className="w-4 h-4" />}
            موافقة
          </Button>
        </div>
      </div>
    </Modal>
  );
}
