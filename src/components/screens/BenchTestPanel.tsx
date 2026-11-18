'use client';

import React, { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Money } from '@/components/ui/Money';
import { StatusChip } from '@/components/ui/StatusChip';
import { BENCH_STATE_AR, DEFAULT_BENCH_RULES, type BenchRules, type BenchState } from '@/lib/bench-verdict';
import type { StateTone } from '@/lib/order-state';

/**
 * ONE BENCH PRODUCT'S TEST — its verdict, its numbers, its spend by day and
 * the rules it is judged by (18/11, request B3).
 *
 * Every number on this panel came computed from the door (bench-verdict.ts);
 * the panel divides nothing. It writes two things only, both through
 * `POST /api/growth/bench`: the product's rules and its spend by day.
 */

export interface BenchTest {
  startDay: string | null;
  dayIndex: number | null;
  spend: number | null;
  orders: number;
  confirmed: number;
  confirmationRate: number | null;
  costPerOrder: number | null;
  costPerConfirmed: number | null;
  missingSpendDays: string[];
  ordersBeforeStart: number;
  spendBeforeStart: number;
}

export interface BenchVerdictView {
  state: BenchState;
  reason: string;
  flag: 'MISSING_SPEND' | null;
}

export interface BenchSpendLine {
  id: string;
  day: string;
  amount: number;
  voidedAt?: string;
  voidReason?: string;
  replaces?: string;
}

export interface BenchProductTest {
  id: string;
  name: string;
  currency: string;
  minorUnit: number;
  today: string;
  test: BenchTest;
  rules: BenchRules;
  customRules: boolean;
  verdict: BenchVerdictView;
  spendEntries: BenchSpendLine[];
}

const TONE: Record<BenchState, StateTone> = {
  SUCCESS: 'good',
  CONTINUE: 'neutral',
  FAIL: 'bad',
  CAPPED: 'warn',
  NOT_JUDGED: 'neutral',
};

/** The chip: a colour AND a word, never the colour alone. */
export function VerdictChip({ verdict }: { verdict: BenchVerdictView }) {
  const missing = verdict.flag === 'MISSING_SPEND';
  return (
    <StatusChip tone={missing ? 'warn' : TONE[verdict.state]} title={verdict.reason}>
      {missing ? 'الصرف ناقص' : BENCH_STATE_AR[verdict.state]}
    </StatusChip>
  );
}

const FIELDS: { key: Exclude<keyof BenchRules, 'startDay'>; label: string; step: string }[] = [
  { key: 'dailySpend', label: 'صرف اليوم', step: 'any' },
  { key: 'targetCpo', label: 'هدف تكلفة الطلب', step: 'any' },
  { key: 'capSpend', label: 'سقف التيست', step: 'any' },
  { key: 'continueDay', label: 'أول يوم بينحكم فيه', step: '1' },
  { key: 'successDay', label: 'يوم النجاح', step: '1' },
  { key: 'failMinOrders', label: 'طلبات قاعدة الفشل', step: '1' },
  { key: 'failMultiplier', label: 'مضاعف الفشل (× الهدف)', step: '0.01' },
];

/**
 * The panel is given its writer by the screen (`send`) and reads nothing
 * itself: its data is the screen's row, re-read after each save.
 */
export function BenchTestPanel({
  product,
  send,
  onClose,
  onChanged,
}: {
  product: BenchProductTest;
  send: (body: Record<string, unknown>) => Promise<unknown>;
  onClose: () => void;
  onChanged: () => void;
}) {
  const t = product.test;
  const [error, setError] = useState<string | null>(null);
  const [day, setDay] = useState(product.today);
  const [amount, setAmount] = useState('');
  const [rules, setRules] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(product.rules).map(([k, v]) => [k, v === null ? '' : String(v)]))
  );
  const [edit, setEdit] = useState<{ id: string; mode: 'correct' | 'void'; value: string } | null>(null);

  const run = async (body: Record<string, unknown>, after?: () => void) => {
    setError(null);
    try {
      await send({ productId: product.id, ...body });
      after?.();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ما انحفظ');
    }
  };

  const money = (n: number | null) => (n === null ? '—' : <Money value={n} currency={product.currency} minorUnit={product.minorUnit} />);

  return (
    <Modal isOpen onClose={onClose} title={product.name} subtitle="التيست: الحكم والأرقام والصرف" maxWidth="2xl">
      <div className="space-y-4">
        {/* ── الحكم ── */}
        <Card plain padding="sm" className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <VerdictChip verdict={product.verdict} />
            {t.dayIndex !== null && t.dayIndex > 0 && <span className="text-note text-[var(--sys-muted-foreground)]">اليوم {t.dayIndex} من التيست</span>}
          </div>
          <p className="text-sm text-[var(--sys-heading)]">{product.verdict.reason}</p>
          <p className="text-note text-[var(--sys-muted-foreground)]">
            انحكم بهالقواعد: الهدف {product.rules.targetCpo} · السقف {product.rules.capSpend} · أول حكم باليوم {product.rules.continueDay} · النجاح من اليوم{' '}
            {product.rules.successDay} · الفشل من {product.rules.failMinOrders} طلب وفوق {product.rules.failMultiplier} × الهدف
            {product.customRules ? '' : ' (الافتراضي)'}.
          </p>
        </Card>

        {/* ── الأرقام ── */}
        <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          {[
            ['الصرف لحد اليوم', money(t.spend)],
            ['طلبات', t.orders],
            ['مؤكَّدة', t.confirmed],
            ['نسبة التأكيد', t.confirmationRate === null ? '—' : `${t.confirmationRate}%`],
            ['تكلفة الطلب', money(t.costPerOrder)],
            ['تكلفة المؤكَّد', money(t.costPerConfirmed)],
            ['بداية التيست', t.startDay ?? '—'],
            ['الصرف المخطط باليوم', money(product.rules.dailySpend)],
          ].map(([label, value]) => (
            <div key={String(label)} className="min-w-0 rounded-lg border border-[var(--sys-border)] p-2">
              <dt className="text-note text-[var(--sys-muted-foreground)]">{label}</dt>
              <dd className="tabular-nums font-semibold text-[var(--sys-heading)]">{value}</dd>
            </div>
          ))}
        </dl>
        {t.ordersBeforeStart > 0 && (
          <p className="text-note text-[var(--sys-muted-foreground)]">
            {t.ordersBeforeStart} طلب قبل بداية التيست — معروضين بالجدول وما انحسبوا بالحكم.
          </p>
        )}

        {error && (
          <p role="alert" className="rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] p-3 text-sm text-[var(--sys-destructive)]">
            {error}
          </p>
        )}

        {/* ── الصرف باليوم ── */}
        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-[var(--sys-heading)]">الصرف باليوم</h3>
          <p className="text-note text-[var(--sys-muted-foreground)]">
            الصرف بينكتب بالإيد هلأ، سطر لكل يوم. بعدين ممكن ينقرا من جدول صرف الإعلانات. السطر الغلط ما بينمسح: بيتصحّح أو بيتلغى، وبيضل ظاهر.
          </p>
          <form
            className="grid gap-2 sm:grid-cols-3 sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              void run({ action: 'spend', day, amount }, () => setAmount(''));
            }}
          >
            <Input label="اليوم" type="date" value={day} max={product.today} onChange={(e) => setDay(e.target.value)} required />
            <Input
              label={`المبلغ (${product.currency})`}
              type="number"
              inputMode="decimal"
              min={0}
              step="any"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              helperText={`المخطط: ${product.rules.dailySpend} باليوم`}
              required
            />
            <Button type="submit">سجّل الصرف</Button>
          </form>

          {product.spendEntries.length === 0 ? (
            <p className="text-sm text-[var(--sys-muted-foreground)]">ما في صرف مكتوب لسا. اكتب صرف أول يوم ليبلش العدّ.</p>
          ) : (
            <ul className="divide-y divide-[var(--sys-border)] rounded-lg border border-[var(--sys-border)]">
              {product.spendEntries.map((e) => (
                <li key={e.id} className="flex flex-wrap items-center gap-2 p-2 text-sm">
                  <span className="tabular-nums">{e.day}</span>
                  <span className={e.voidedAt ? 'line-through text-[var(--sys-muted)]' : 'font-semibold'}>{money(e.amount)}</span>
                  {e.voidedAt ? (
                    <span className="text-note text-[var(--sys-muted)]">ملغى: {e.voidReason}</span>
                  ) : edit?.id === e.id ? (
                    <form
                      className="flex w-full flex-wrap items-end gap-2"
                      onSubmit={(ev) => {
                        ev.preventDefault();
                        void run(
                          edit.mode === 'correct'
                            ? { action: 'correct', entryId: e.id, amount: edit.value }
                            : { action: 'void', entryId: e.id, reason: edit.value },
                          () => setEdit(null)
                        );
                      }}
                    >
                      <Input
                        label={edit.mode === 'correct' ? 'المبلغ الصحيح' : 'سبب الإلغاء'}
                        type={edit.mode === 'correct' ? 'number' : 'text'}
                        step="any"
                        min={0}
                        value={edit.value}
                        onChange={(ev) => setEdit({ ...edit, value: ev.target.value })}
                        required
                      />
                      <Button type="submit" size="sm" variant={edit.mode === 'void' ? 'danger' : 'primary'}>
                        {edit.mode === 'correct' ? 'احفظ التصحيح' : 'ألغِ السطر'}
                      </Button>
                      <Button type="button" size="sm" variant="quiet" onClick={() => setEdit(null)}>
                        رجوع
                      </Button>
                    </form>
                  ) : (
                    <span className="ms-auto flex gap-1">
                      <Button type="button" size="sm" variant="quiet" onClick={() => setEdit({ id: e.id, mode: 'correct', value: String(e.amount) })}>
                        صحّح
                      </Button>
                      <Button type="button" size="sm" variant="quiet" onClick={() => setEdit({ id: e.id, mode: 'void', value: '' })}>
                        ألغِ
                      </Button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ── القواعد ── */}
        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-[var(--sys-heading)]">قواعد الحكم لهالمنتج</h3>
          <p className="text-note text-[var(--sys-muted-foreground)]">
            لما تغيّرها، الحكم بينحسب من جديد من نفس الأرقام. «بداية التيست» فاضية = أول يوم انكتب فيه صرف؛ حطّها ليوم جديد لتبلش فترة تانية.
          </p>
          <form
            className="grid gap-2 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              void run({ action: 'rules', rules: { ...rules, startDay: rules.startDay || null } });
            }}
          >
            {FIELDS.map((f) => (
              <Input
                key={f.key}
                label={f.label}
                type="number"
                inputMode="decimal"
                step={f.step}
                min={0}
                value={rules[f.key] ?? ''}
                onChange={(e) => setRules({ ...rules, [f.key]: e.target.value })}
                helperText={`الافتراضي: ${DEFAULT_BENCH_RULES[f.key]}`}
                required
              />
            ))}
            <Input
              label="بداية التيست"
              type="date"
              value={rules.startDay ?? ''}
              max={product.today}
              onChange={(e) => setRules({ ...rules, startDay: e.target.value })}
              helperText="فاضية = أول يوم صرف"
            />
            <div className="flex flex-wrap gap-2 sm:col-span-2">
              <Button type="submit">احفظ القواعد</Button>
              {product.customRules && (
                <Button type="button" variant="quiet" onClick={() => void run({ action: 'rules', rules: null })}>
                  رجّع الافتراضي
                </Button>
              )}
            </div>
          </form>
        </section>
      </div>
    </Modal>
  );
}
