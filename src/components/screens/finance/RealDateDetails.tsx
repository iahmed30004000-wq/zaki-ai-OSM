'use client';

import React from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Money } from '@/components/ui/Money';
import { arDateTime } from '@/lib/format';
import { TRANSFER_STATE_AR, type TransferState } from '@/lib/transfer-reversal';

/**
 * THE REAL DATE ON A ROW, AND THE EYE THAT OPENS A ROW (22/11) — «ما في زر زي العين يعرضلك التفاصيل والملاحظات وتاريخ الحركة
 * الحقيقي … المفروض تاريخ الحركة وتاريخ التسجيل برّا وجوّا».
 *
 * Read-only. Nothing here writes, and nothing here works a figure out: every number and every date is the server's answer, and
 * «registeredOnAnotherDay» is decided by the door in the STORE's timezone (lib/real-date). Two lists use it: the wallet's movements
 * and the latest transfers.
 */

/** The row's date: the real one first, and «سُجّلت …» under it only when the registration fell on another day of the store. */
export function RealDateCell({
  realDate,
  createdAt,
  registeredOnAnotherDay,
}: {
  realDate?: string | null;
  createdAt: string;
  registeredOnAnotherDay?: boolean;
}) {
  return (
    <>
      {arDateTime(realDate ?? createdAt)}
      {registeredOnAnotherDay && <span className="block text-note text-[var(--sys-muted)]">سُجّلت {arDateTime(createdAt)}</span>}
    </>
  );
}

/** One line of a details panel: the name, then what it holds. */
function Line({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-2">
      <dt className="text-note text-[var(--sys-muted)]">{name}</dt>
      <dd className="text-sm text-[var(--sys-foreground)] break-words">{children}</dd>
    </div>
  );
}

/** The two moments, said in full: when it really happened, and when it was written down. */
function BothDates({ realDate, createdAt }: { realDate?: string | null; createdAt: string }) {
  return (
    <>
      <Line name="تاريخ الحركة الفعلي">{arDateTime(realDate ?? createdAt)}</Line>
      <Line name="تاريخ التسجيل">{arDateTime(createdAt)}</Line>
    </>
  );
}

/** What wrote a movement, said as a person reads it. */
export const REFERENCE_AR: Record<string, string> = {
  STATEMENT: 'كشف شركة الشحن',
  TRANSFER: 'تحويل بين المحافظ',
  COMMISSION_PERIOD: 'فترة عمولة',
  ORDER: 'طلب',
  PARTNER_DRAW: 'سحب شريك',
  EXPENSE: 'مصروف',
};

export interface MovementForDetails {
  id: string;
  direction: 'IN' | 'OUT';
  amount: number;
  party: string;
  category: string;
  note: string | null;
  reversalReason: string | null;
  createdAt: string;
  realDate?: string | null;
  createdByName: string | null;
  isReversal: boolean;
  wasReversed: boolean;
  referenceType?: string | null;
  referenceId?: string | null;
  reversalOf?: { id: string; note: string } | null;
  reversedBy?: { id: string; reversalReason: string | null; createdAt: string } | null;
}

/** The eye of a movement: everything about it, and a way to the entry that reverses it (or that it reverses) when it is listed. */
export function MovementDetails({
  movement: m,
  currency,
  minorUnit,
  categoryLabel,
  listed,
  onOpen,
  onClose,
}: {
  movement: MovementForDetails;
  currency: string | null | undefined;
  minorUnit: number;
  categoryLabel: string;
  /** The ids on the list: a linked entry that is listed gets a press that opens it here. */
  listed: ReadonlySet<string>;
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  const linked = m.isReversal ? m.reversalOf?.id ?? null : m.wasReversed ? m.reversedBy?.id ?? null : null;
  return (
    <Modal isOpen onClose={onClose} side="end" title="تفاصيل الحركة">
      <dl className="divide-y divide-[var(--sys-border)]">
        <BothDates realDate={m.realDate} createdAt={m.createdAt} />
        <Line name="سجّلها">{m.createdByName ?? '—'}</Line>
        <Line name="الاتجاه والمبلغ">
          {m.direction === 'IN' ? 'وارد' : 'صادر'} ·{' '}
          <Money value={m.amount} currency={currency} minorUnit={minorUnit} tone={m.direction === 'IN' ? 'collected' : 'lost'} />
        </Line>
        <Line name="الطرف">{m.party}</Line>
        <Line name="البند">{categoryLabel}</Line>
        <Line name="الملاحظة">
          <span className="whitespace-pre-wrap">{m.note || '—'}</span>
        </Line>
        <Line name="المرجع">
          {m.referenceType ? (
            <>
              {REFERENCE_AR[m.referenceType] ?? m.referenceType}
              {m.referenceId && <span dir="ltr" className="block text-note text-[var(--sys-muted)]">{m.referenceId}</span>}
            </>
          ) : (
            'مسجّلة باليد'
          )}
        </Line>
        {m.isReversal && (
          <Line name="قيد عكسي لـ">
            {m.reversalOf?.note ?? '—'}
            {m.reversalReason && <span className="block text-note text-[var(--sys-destructive)]">السبب: {m.reversalReason}</span>}
          </Line>
        )}
        {m.wasReversed && (
          <Line name="انعكست">
            {m.reversedBy?.createdAt ? arDateTime(m.reversedBy.createdAt) : '—'}
            {m.reversedBy?.reversalReason && (
              <span className="block text-note text-[var(--sys-destructive)]">السبب: {m.reversedBy.reversalReason}</span>
            )}
          </Line>
        )}
      </dl>
      {linked && listed.has(linked) && (
        <div className="pt-3">
          <Button variant="secondary" size="sm" onClick={() => onOpen(linked)}>
            {m.isReversal ? 'افتح الحركة الأصلية' : 'افتح القيد العكسي'}
          </Button>
        </div>
      )}
    </Modal>
  );
}

interface TransferEndForDetails {
  name: string;
  currencyCode: string;
  store?: { name: string } | null;
}

export interface TransferForDetails {
  id: string;
  amountOut: number;
  amountIn: number;
  exchangeRate: number;
  note: string | null;
  createdAt: string;
  realDate?: string | null;
  createdByName?: string | null;
  kindLabel?: string;
  from: TransferEndForDetails | null;
  to: TransferEndForDetails | null;
  state?: TransferState;
  reversal?: { reason: string | null; at: string | null; byName: string | null } | null;
}

const endText = (w: TransferEndForDetails | null) => (w ? [w.name, w.store?.name].filter(Boolean).join(' · ') : '—');

/** The eye of a transfer: both moments, who wrote it, both ends, both amounts, the rate, the note, and what was taken back. */
export function TransferDetails({ transfer: t, onClose }: { transfer: TransferForDetails; onClose: () => void }) {
  const state = t.state ?? 'ACTIVE';
  return (
    <Modal isOpen onClose={onClose} side="end" title="تفاصيل التحويل">
      <dl className="divide-y divide-[var(--sys-border)]">
        <BothDates realDate={t.realDate} createdAt={t.createdAt} />
        <Line name="سجّله">{t.createdByName ?? '—'}</Line>
        <Line name="النوع">{t.kindLabel ?? '—'}</Line>
        <Line name="من">{endText(t.from)}</Line>
        <Line name="إلى">{endText(t.to)}</Line>
        <Line name="الصادر">
          <Money value={t.amountOut} currency={t.from?.currencyCode} />
        </Line>
        <Line name="الوارد">
          <Money value={t.amountIn} currency={t.to?.currencyCode} />
        </Line>
        <Line name="السعر">
          <span dir="ltr">{t.exchangeRate}</span>
        </Line>
        <Line name="الملاحظة">
          <span className="whitespace-pre-wrap">{t.note || '—'}</span>
        </Line>
        <Line name="الحالة">
          {TRANSFER_STATE_AR[state]}
          {t.reversal?.reason && <span className="block text-note text-[var(--sys-destructive)]">السبب: {t.reversal.reason}</span>}
          {(t.reversal?.byName || t.reversal?.at) && (
            <span className="block text-note text-[var(--sys-muted)]">
              {[t.reversal?.byName, t.reversal?.at ? arDateTime(t.reversal.at) : null].filter(Boolean).join(' · ')}
            </span>
          )}
        </Line>
        <Line name="رقم التحويل">
          <span dir="ltr" className="text-note">{t.id}</span>
        </Line>
      </dl>
    </Modal>
  );
}
