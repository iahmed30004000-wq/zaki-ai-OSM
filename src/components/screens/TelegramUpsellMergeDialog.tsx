'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { apiJson } from '@/lib/api-client';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Rows, type Column } from '@/components/ui/Rows';
import { useToast } from '@/components/ui/Toast';
import { useConfirm } from '@/components/ui/Confirm';

/**
 * «دمج الأب سيل — تجربة» — WHAT THE NEW RULES WOULD DO WITH THE MESSAGES ALREADY WAITING, BEFORE ANYTHING IS DONE (10/11).
 *
 * The owner: «A dry-run over the current «للمراجعة» items returns a table (رقم الطلب، المنتج، العبوات، المبلغ، الإجراء). Apply
 * only after Ahmad's «نعم».» Opening the dialog asks the server for the plan and writes nothing. «نعم، نفّذ الدمج» asks AGAIN
 * («متأكد؟») before it sends `confirm: true` with the rows that were shown; the server plans again itself and answers per row.
 */

export interface PlanRow {
  key: string;
  kind: 'merge' | 'order' | 'review';
  orderNumber: string | null;
  product: string;
  units: number | null;
  amount: number | null;
  action: string;
  reason?: string;
}

interface ApplyRow {
  key: string;
  status: string;
  orderId?: string;
  reason?: string;
}

/**
 * «رقم الطلب» here is the SITE's number from the message (the pairing key), not one of our orders — so it is drawn as plain text
 * and never through `OrderRef`, which links to an order of ours.
 */
const siteNumberOf = (r: PlanRow) => r.orderNumber ?? '—';

export function TelegramUpsellMergeDialog({ canManage, onClose, onApplied }: { canManage: boolean; onClose: () => void; onApplied: () => void | Promise<void> }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [rows, setRows] = useState<PlanRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const preview = useCallback(async () => {
    try {
      const r = await apiJson<{ rows: PlanRow[] }>('/api/telegram/upsell-merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'preview' }),
      });
      setRows(r.rows);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ما زبطت التجربة');
    }
  }, []);

  useEffect(() => {
    void preview();
  }, [preview]);

  const doable = (rows ?? []).filter((r) => r.kind !== 'review');

  const apply = async () => {
    const yes = await confirm({
      title: 'متأكد؟ رح ننفّذ الدمج',
      body: `${doable.length} صف رح يصير طلبات هلّق، والباقي بيضل بالمراجعة. ما في رجعة عن طلب انعمل.`,
      confirmLabel: 'نعم، نفّذ',
    });
    if (!yes) return;
    setBusy(true);
    try {
      const r = await apiJson<{ results: ApplyRow[] }>('/api/telegram/upsell-merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'apply', confirm: true, keys: doable.map((d) => d.key) }),
      });
      const made = r.results.filter((x) => x.status === 'PROCESSED').length;
      toast.done(`صار ${made} طلب`);
      await onApplied();
      await preview();
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'ما زبط التنفيذ');
    } finally {
      setBusy(false);
    }
  };

  const columns: Column<PlanRow>[] = [
    { key: 'orderNumber', label: 'رقم الطلب', primary: true, render: (r) => <span dir="ltr" className="tabular-nums">{siteNumberOf(r)}</span> },
    { key: 'product', label: 'المنتج', primary: true, render: (r) => r.product },
    { key: 'units', label: 'العبوات', align: 'end', render: (r) => (r.units == null ? '—' : <span className="tabular-nums">{r.units}</span>) },
    { key: 'amount', label: 'المبلغ', align: 'end', render: (r) => (r.amount == null ? '—' : <span dir="ltr" className="tabular-nums">{r.amount}</span>) },
    {
      key: 'action',
      label: 'الإجراء',
      wide: true,
      render: (r) => (
        <span className={r.kind === 'review' ? 'text-xs text-[var(--sys-muted-foreground)]' : 'text-xs font-semibold text-[var(--sys-primary)]'}>{r.action}</span>
      ),
    },
  ];

  return (
    <Modal isOpen onClose={onClose} title="دمج الأب سيل — تجربة" subtitle="هاد اللي رح يصير بالرسائل اللي بتستنّى — لسا ما انعمل شي" maxWidth="2xl">
      <div className="space-y-4">
        {error && (
          <p role="alert" className="rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] p-3 text-sm text-[var(--sys-destructive)]">
            {error}
          </p>
        )}
        {rows === null && !error ? (
          <p className="text-xs text-[var(--sys-muted-foreground)]">عم نجرّب…</p>
        ) : (
          rows && (
            <Rows
              rows={rows}
              keyOf={(r) => r.key}
              columns={columns}
              alert={(r) => (r.kind === 'review' ? 'warn' : null)}
              empty={<EmptyState title="ما في شي يندمج" why="ما في رسائل أب سيل أو أسماء قديمة بتستنّى بالمراجعة." />}
            />
          )
        )}
        <div className="flex flex-wrap items-center gap-2">
          {canManage && (
            <Button loading={busy} disabled={doable.length === 0} onClick={apply}>
              نعم، نفّذ الدمج
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            سكّر
          </Button>
        </div>
      </div>
    </Modal>
  );
}
