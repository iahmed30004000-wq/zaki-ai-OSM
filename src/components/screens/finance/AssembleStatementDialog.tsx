'use client';

import React, { useState } from 'react';
import { RiCheckLine } from '@remixicon/react';
import { apiJson } from '@/lib/api-client';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Money } from '@/components/ui/Money';

/**
 * «تجميع» — the second press of the manual statement: give the draft its reference and its period.
 *
 * Until now the draft was a list of orders. After this it is a statement like any other: the receipt (with the
 * wallet it landed in and, when that wallet's currency differs, the rate it changed at), the matching and the
 * approval take over, and nothing here moves money. The reference is unique for this COURIER — two couriers may
 * both have «كشف الأحد» — and the server says so in words when it is already used.
 */

interface Draft {
  id: string;
  reference: string;
  currencyCode: string;
  totalAmount: number;
  counts: { lines: number };
}

/** A day typed in a date box, as the instant the server reads: the start of that day, or its last second. */
function dayStart(day: string): string {
  return new Date(`${day}T00:00:00`).toISOString();
}
function dayEnd(day: string): string {
  return new Date(`${day}T23:59:59`).toISOString();
}

export function AssembleStatementDialog({
  statement,
  onClose,
  onSaved,
}: {
  statement: Draft;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [reference, setReference] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  return (
    <Modal isOpen onClose={onClose} title="تجميع الكشف اليدوي">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setSaving(true);
          setError(null);
          try {
            await apiJson(`/api/finance/statements/${statement.id}/assemble`, {
              method: 'POST',
              body: JSON.stringify({
                reference: reference.trim(),
                ...(from ? { periodFrom: dayStart(from) } : {}),
                ...(to ? { periodTo: dayEnd(to) } : {}),
              }),
            });
            onSaved(`جُمِّع الكشف «${reference.trim()}». سجّل الآن إيصال الاستلام، ثم المطابقة، ثم الاعتماد.`);
          } catch (err) {
            setError(err instanceof Error ? err.message : 'تعذّر التجميع');
          } finally {
            setSaving(false);
          }
        }}
        className="space-y-3"
      >
        <div className="text-xs bg-[var(--sys-surface)] border border-[var(--sys-border)] rounded-lg p-3 space-y-1">
          <p className="text-[var(--sys-foreground)]">
            في المسوّدة <b className="tabular-nums">{statement.counts.lines}</b> طلب بإجمالي{' '}
            <b className="tabular-nums"><Money value={statement.totalAmount} currency={statement.currencyCode} /></b>.
          </p>
          <p className="text-[var(--sys-muted)]">
            بعد التجميع لا تُضاف إليها طلبات. المرجع خاص بهذه الجهة: لا تكرّره لها، وتقدر جهة ثانية أن تستعمل الاسم نفسه.
          </p>
        </div>

        <Input
          label="مرجع الكشف"
          value={reference}
          onChange={(e) => setReference(e.target.value)}
          required
          minLength={2}
          maxLength={80}
          placeholder="مثال: كشف الأحد"
        />

        <div className="grid gap-3 md:grid-cols-2">
          <Input label="من تاريخ (اختياري)" type="date" value={from} onChange={(e) => setFrom(e.target.value)} dir="ltr" />
          <Input label="إلى تاريخ (اختياري)" type="date" value={to} onChange={(e) => setTo(e.target.value)} dir="ltr" />
        </div>

        {error && <p className="text-sm text-[var(--sys-destructive)]">{error}</p>}

        <div className="flex gap-2 justify-end">
          <button type="button" onClick={onClose} className="h-11 md:h-10 px-4 rounded-lg border border-[var(--sys-border)] text-sm">
            إلغاء
          </button>
          <button
            type="submit"
            disabled={saving || reference.trim().length < 2}
            className="h-11 md:h-10 px-4 rounded-lg bg-[var(--sys-success)] text-[var(--sys-primary-foreground)] text-sm font-medium inline-flex items-center gap-1.5 disabled:opacity-50"
          >
            <RiCheckLine className="w-4 h-4" aria-hidden />
            {saving ? 'جارٍ التجميع…' : 'تجميع'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
