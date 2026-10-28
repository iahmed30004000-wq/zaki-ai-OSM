'use client';

import React, { useEffect, useRef, useState } from 'react';
import { apiJson } from '@/lib/api-client';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { toLatinDigits } from '@/lib/latin-digits';
import { REJECTION_REASON_AR } from '@/lib/confirmation-workflow';
import {
  DEFAULT_WINBACK_RULE,
  NEVER_WINBACK_REASONS,
  OPTIONAL_WINBACK_REASONS,
  WINBACK_BOUNDS,
  WINBACK_REASONS,
  validateWinbackRule,
  type WinbackRule,
} from '@/lib/winback';

/**
 * «عدّل القاعدة» — THE OWNER'S RULE FOR THE LOST ORDERS, IN A FORM.
 *
 * «شو القاعدة تبعو لاني ممكن اعدلها». Five things, each a real control with its
 * label and its limit beside it: whether a parcel that shipped and came back is
 * read too (one tick, «يشمل المرتجع بعد الشحن», on — the owner asked for both on
 * 28/10), which reasons are worth a second call, how long to wait, how far back
 * to look, how much of the price may be given away.
 *
 * What the form does NOT offer is as much the point as what it does. A parcel
 * that left and is not back, or is back and nobody received it, an order that
 * was already offered, a second chance, and a duplicate, a wrong number, a fake
 * order or an entry error are never called for, whatever is typed here — and the
 * form says so in a sentence rather than leaving the owner to wonder why «طلب
 * مكرّر» has no tick beside it. (That sentence said «الطلب الذي شُحن» until the
 * owner ruled the returns in; what it cannot reach now is what is not back.)
 *
 * The same judge runs here and on the server (`validateWinbackRule`): the form
 * refuses what the route would refuse, in the same words, before it is sent —
 * and the route judges again, because a form is not a lock.
 */
export function WinbackRuleDialog({
  rule,
  isOpen,
  onClose,
  onSaved,
}: {
  rule: WinbackRule;
  isOpen: boolean;
  onClose: () => void;
  onSaved: (rule: WinbackRule) => void | Promise<void>;
}) {
  const [reasons, setReasons] = useState<string[]>([...rule.reasons]);
  const [afterShipping, setAfterShipping] = useState(rule.afterShipping === true);
  const [cooling, setCooling] = useState(String(rule.coolingDays));
  const [lookback, setLookback] = useState(String(rule.lookbackDays));
  const [percent, setPercent] = useState(String(Math.round(rule.maxDiscountShare * 10_000) / 100));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fill = (r: WinbackRule) => {
    setReasons([...r.reasons]);
    setAfterShipping(r.afterShipping === true);
    setCooling(String(r.coolingDays));
    setLookback(String(r.lookbackDays));
    setPercent(String(Math.round(r.maxDiscountShare * 10_000) / 100));
    setError(null);
  };

  /**
   * OPENING IT SHOWS WHAT IS STORED NOW — ON THE OPENING, AND ONLY THEN.
   *
   * It used to refill whenever `rule` changed, and `rule` is a new object every
   * time the screen re-reads the list: coming back to the window (`useLiveRefresh`
   * listens for `focus`) re-reads it, so an owner who alt-tabbed to a sheet to
   * check a number came back to a form that had put every box back to what was
   * stored — and lost what he had typed, without a word. The rule is read through
   * a ref at the moment of opening instead; the effect runs on the edge, and the
   * one that keeps the ref runs before it, in the same commit.
   */
  const stored = useRef(rule);
  useEffect(() => {
    stored.current = rule;
  });
  useEffect(() => {
    if (isOpen) fill(stored.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  /** A number typed on an Arabic keyboard is still a number; an empty box is not zero. */
  const num = (v: string) => (v.trim() === '' ? NaN : Number(toLatinDigits(v).trim()));

  const toggle = (reason: string) =>
    setReasons((cur) => (cur.includes(reason) ? cur.filter((r) => r !== reason) : [...cur, reason]));

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const body = { reasons, afterShipping, coolingDays: num(cooling), lookbackDays: num(lookback), maxDiscountPercent: num(percent) };
    const judged = validateWinbackRule(body);
    if (!judged.ok) {
      setError(judged.errorAr);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await apiJson<{ rule: WinbackRule }>('/api/confirmation/winback/rule', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      await onSaved(res.rule);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذّر الحفظ');
    } finally {
      setBusy(false);
    }
  };

  const box = (reason: string) => (
    <label key={reason} className="flex min-h-11 items-center gap-2 text-sm text-[var(--sys-foreground)] md:min-h-0">
      <input type="checkbox" checked={reasons.includes(reason)} onChange={() => toggle(reason)} />
      {REJECTION_REASON_AR[reason] ?? reason}
    </label>
  );

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="قاعدة استرجاع الملغى" subtitle="تحكم بمَن يظهر في القائمة، وبكم يُسمح بالخصم">
      <form onSubmit={save} className="space-y-4">
        {/* The kind first, as the sentence on the screen reads: which orders, and only then for which reasons. */}
        <div className="space-y-1">
          <label className="flex min-h-11 items-center gap-2 text-sm text-[var(--sys-foreground)] md:min-h-0">
            <input type="checkbox" checked={afterShipping} onChange={(e) => setAfterShipping(e.target.checked)} />
            يشمل المرتجع بعد الشحن
          </label>
          <p className="text-xs text-[var(--sys-muted-foreground)]">
            ما شُحن ثمّ رجع واستلمه المستودع — لا تحدّه الأسباب أدناه، وتُحسب مهلته من يوم الاستلام.
          </p>
        </div>

        <fieldset className="space-y-1">
          <legend className="mb-1 text-xs font-semibold text-[var(--sys-heading)]">الأسباب التي نتّصل لأجلها — للملغى قبل الشحن</legend>
          {WINBACK_REASONS.map(box)}
          <p className="pt-2 text-xs text-[var(--sys-muted-foreground)]">
            وهذه ثلاثةٌ على مسؤوليتك — الأصل أنّ العميل فيها قال كلمته فلا يُعاد عليه:
          </p>
          {OPTIONAL_WINBACK_REASONS.map(box)}
        </fieldset>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Input
            label="المهلة بعد الإلغاء (أيام)"
            type="text"
            inputMode="numeric"
            value={cooling}
            onChange={(e) => setCooling(e.target.value)}
            helperText={`من ${WINBACK_BOUNDS.coolingDays.min} إلى ${WINBACK_BOUNDS.coolingDays.max}`}
          />
          <Input
            label="أبعد طلب نقرؤه (أيام)"
            type="text"
            inputMode="numeric"
            value={lookback}
            onChange={(e) => setLookback(e.target.value)}
            helperText={`من ${WINBACK_BOUNDS.lookbackDays.min} إلى ${WINBACK_BOUNDS.lookbackDays.max}`}
          />
          <Input
            label="أقصى خصم (٪ من السعر)"
            type="text"
            inputMode="decimal"
            value={percent}
            onChange={(e) => setPercent(e.target.value)}
            helperText={`من 0 إلى ${WINBACK_BOUNDS.maxDiscountShare.max * 100}`}
          />
        </div>

        <p className="rounded-lg bg-[var(--sys-surface)] p-3 text-xs leading-6 text-[var(--sys-muted-foreground)]">
          لا يتغيّر بأيّ إعداد: ما شُحن ولم يرجع، أو رجع ولم يستلمه المستودع · ما عُرض عليه من قبل · محاولةُ الاسترجاع نفسُها ·
          ولا يُتَّصل لأجل{' '}
          {NEVER_WINBACK_REASONS.map((r) => REJECTION_REASON_AR[r] ?? r).join(' ولا ')}.
        </p>

        {error && (
          <p role="alert" className="rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] p-3 text-sm text-[var(--sys-destructive)]">
            {error}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {/* `loading` already holds the button: `Button` is disabled while it works, and the other two are held by hand. */}
          <Button type="submit" loading={busy}>
            احفظ القاعدة
          </Button>
          <Button type="button" variant="outline" disabled={busy} onClick={() => fill(DEFAULT_WINBACK_RULE)}>
            القيم الأصلية
          </Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
            إلغاء
          </Button>
        </div>
      </form>
    </Modal>
  );
}
