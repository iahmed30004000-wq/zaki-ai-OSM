'use client';

import React, { useState } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Money } from '@/components/ui/Money';
import { apiJson } from '@/lib/api-client';
import type { BackfillPlan } from '@/lib/draw-backfill';

/**
 * «عبّي السعر للقديم بسعر اليوم» — THE OWNER'S EXCEPTION, ON THE WITHDRAWALS TAB (23/11, F8). Drawn only when the server says the
 * reader is the owner (`mayBackfill`); the door asks again.
 *
 * Two presses, never one: «اعرض المعاينة» lists the old draws with no equivalent, each at today's rate, their total, and the
 * currencies skipped for want of a rate; «أكّد وعبّي» sends exactly that list and that total, and the door refuses if anything moved
 * in between. Afterwards each filled row can be edited or cleared from the list («عدّل السعر» on the row).
 */

type Plan = BackfillPlan & { source: string };

export function BackfillOldDraws({ onDone }: { onDone: () => void }) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const preview = async () => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      setPlan(await apiJson<Plan>('/api/finance/partners/draws/backfill'));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذّر عرض المعاينة');
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!plan) return;
    setBusy(true);
    setError(null);
    try {
      const out = await apiJson<{ written: number; total: number }>('/api/finance/partners/draws/backfill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true, expectedIds: plan.rows.map((r) => r.id), expectedTotal: plan.total }),
      });
      setDone(`انعبّى ${out.written} سحب بسعر اليوم.`);
      setPlan(null);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذّر الحفظ');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader
        title="عبّي السعر للقديم بسعر اليوم"
        subtitle="استثناء للمالك: السحوبات القديمة اللي ما إلها «ما يعادله» بتنحسب بسعر اليوم وبتدخل بحساب الشريك. بتشوف القائمة والمجموع قبل ما ينكتب شي، وكل سطر بتقدر تعدّله أو تمسحه بعدين."
      />
      <CardContent className="space-y-3">
        {!plan && (
          <Button variant="secondary" size="sm" onClick={preview} loading={busy}>
            اعرض المعاينة
          </Button>
        )}
        {plan && (
          <div className="space-y-3" data-preview="backfill">
            {plan.rows.length === 0 ? (
              <p className="text-note text-[var(--sys-muted)]">ما في سحوبات قديمة بلا سعر بتنعبّى.</p>
            ) : (
              <ul className="divide-y divide-[var(--sys-border)]">
                {plan.rows.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 text-note">
                    <span className="tabular-nums">{r.createdAt.slice(0, 10).replace(/-/g, '/')}</span>
                    <Money value={r.amount} currency={r.currencyCode} />
                    <span className="ms-auto font-bold text-[var(--sys-heading)]">
                      <Money value={r.value} currency={plan.storeCurrency} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {plan.rows.length > 0 && (
              <p className="text-sm font-bold text-[var(--sys-heading)]" data-total="backfill">
                المجموع: <Money value={plan.total} currency={plan.storeCurrency} /> ({plan.rows.length} سحب)
              </p>
            )}
            {plan.skipped.map((s) => (
              <p key={s.currencyCode} className="text-note text-[var(--sys-warning)]">
                {s.count} سحب بـ{s.currencyCode} ما انحسبو: {s.sentence}
              </p>
            ))}
            <div className="flex flex-wrap gap-2">
              {plan.rows.length > 0 && (
                <Button size="sm" onClick={confirm} loading={busy}>
                  أكّد وعبّي
                </Button>
              )}
              <Button variant="quiet" size="sm" onClick={() => setPlan(null)} disabled={busy}>
                تراجع
              </Button>
            </div>
          </div>
        )}
        {done && <p className="text-note text-[var(--sys-success)]">{done}</p>}
        {error && <p className="text-note text-[var(--sys-destructive)]">{error}</p>}
      </CardContent>
    </Card>
  );
}

/** «عدّل السعر» of one row the exception filled: another figure, or empty to clear it (back to no equivalent). */
export function EditBackfilled({
  movementId,
  current,
  currency,
  onClose,
  onDone,
}: {
  movementId: string;
  current: number | null;
  currency: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [value, setValue] = useState(current === null ? '' : String(current));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (clear: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await apiJson('/api/finance/partners/draws/backfill', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ movementId, value: clear ? null : value.trim() }),
      });
      onDone();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذّر الحفظ');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal isOpen onClose={onClose} title="عدّل «ما يعادله» — استثناء بسعر اليوم">
      <div className="space-y-3">
        <Input label={`ما يعادله بعملة المتجر (${currency})`} type="number" inputMode="decimal" dir="ltr" value={value} onChange={(e) => setValue(e.target.value)} />
        <p className="text-note text-[var(--sys-muted)]">«امسح» بيرجّع السحب بلا «ما يعادله» متل ما كان قبل التعبئة.</p>
        {error && <p className="text-note text-[var(--sys-destructive)]">{error}</p>}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => save(false)} loading={busy} disabled={value.trim() === ''}>
            احفظ
          </Button>
          <Button variant="danger" size="sm" onClick={() => save(true)} disabled={busy}>
            امسح
          </Button>
        </div>
      </div>
    </Modal>
  );
}
