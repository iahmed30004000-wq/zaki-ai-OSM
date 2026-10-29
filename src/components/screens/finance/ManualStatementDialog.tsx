'use client';

import React, { useState } from 'react';
import { RiCheckLine } from '@remixicon/react';
import { apiJson } from '@/lib/api-client';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';

/**
 * «مطابق يدوي» — the first press of the manual statement, in a dialog of its own.
 *
 * The delivered orders a person ticked on the matching screen (all of ONE courier) go into that courier's open
 * draft statement, each with the amount the courier handed over for it. It lives apart from `ManualMatching` on
 * purpose: that screen reads the follow-up door and writes the delivery door, and the money dialog it opens is
 * `CollectDialog`; a third door does not belong in its source, and a test pins that.
 *
 * ── IT HOLDS NO ARITHMETIC AND MOVES NO MONEY ──
 *
 * The figure beside each order is the SERVER's expectation, shown as the field's placeholder: a field left empty
 * is sent as «the expected amount» and the server fills it by the one settlement rule. The draft's total comes
 * back in the answer. Nothing is settled and no wallet is touched here — the second press («تجميع», on the
 * collection screen), the receipt and the approval do that, in that order.
 */

interface Row {
  id: string;
  orderNumber: string;
  /** What this order owes, by the settlement rule, worked out on the server. */
  expectedCollection?: number | null;
  customer: { fullName: string };
  deliveryProvider: { id: string; name: string } | null;
}

interface Added {
  statementId: string;
  courier: string;
  currencyCode: string;
  created: boolean;
  added: number;
  updated: number;
  lines: number;
  total: number;
}

/** The sentence the screen shows after the press: what happened, the draft's total, and what comes next. */
export function addedSentence(r: Added): string {
  const changed = r.updated > 0 ? ` (وعُدِّل ${r.updated} موجود فيها)` : '';
  return (
    `أُضيف ${r.added} طلب إلى مسوّدة كشف ${r.courier}${changed}. ` +
    `في المسوّدة الآن ${r.lines} طلب بإجمالي ${r.total} ${r.currencyCode}. ` +
    `افتح «التحصيل والكشوف» واضغط «تجميع» لتعطيها مرجعاً، ثم سجّل الإيصال.`
  );
}

export function ManualStatementDialog({
  orders,
  onClose,
  onDone,
}: {
  orders: Row[];
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const party = orders[0]?.deliveryProvider?.name ?? '—';

  return (
    <Modal isOpen onClose={onClose} title="مطابق يدوي" subtitle={`${party} · ${orders.length} طلب`}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          const typed = orders.map((o) => ({ o, text: (amounts[o.id] ?? '').trim() }));
          const bad = typed.find((t) => t.text !== '' && !Number.isFinite(Number(t.text)));
          if (bad) {
            setError(`المبلغ المكتوب للطلب ${bad.o.orderNumber} ليس رقماً`);
            return;
          }
          setSaving(true);
          try {
            const res = await apiJson<Added>('/api/finance/statements/manual', {
              method: 'POST',
              body: JSON.stringify({
                orders: typed.map((t) => ({ orderId: t.o.id, ...(t.text !== '' ? { amount: Number(t.text) } : {}) })),
              }),
            });
            onDone(addedSentence(res));
          } catch (err) {
            setError(err instanceof Error ? err.message : 'تعذّرت الإضافة');
          } finally {
            setSaving(false);
          }
        }}
        className="space-y-3"
      >
        <div className="text-xs bg-[var(--sys-surface)] border border-[var(--sys-border)] rounded-lg p-3 space-y-1">
          <p className="text-[var(--sys-foreground)]">
            تُضاف هذه الطلبات إلى مسوّدة كشف واحدة لهذه الجهة، ثم تعتمدها كما تعتمد أيّ كشف. لا يتحرك أيّ مبلغ الآن.
          </p>
          <p className="text-[var(--sys-muted)]">
            المبلغ المكتوب في كل خانة هو المتوقَّع من المندوب. إن سلّمك أقل، اكتب ما سلّمه فعلاً ويُسجَّل الناقص على هذا الطلب وحده.
          </p>
          <p className="text-[var(--sys-muted)]">
            «استلمت منه» لنقد بعملة الطلب نفسها إلى محفظة فعّالة. أيّ عملة ثانية أو سعر صرف تمرّ بالكشف اليدوي.
          </p>
        </div>

        <div className="max-h-64 overflow-y-auto border border-[var(--sys-border)] rounded-lg divide-y divide-[var(--sys-border)]">
          {orders.map((o) => (
            <div key={o.id} className="px-3 py-1.5">
              <Input
                label={`${o.orderNumber} · ${o.customer.fullName}`}
                type="number"
                step="0.001"
                value={amounts[o.id] ?? ''}
                onChange={(e) => setAmounts((a) => ({ ...a, [o.id]: e.target.value }))}
                placeholder={String(Number(o.expectedCollection ?? 0))}
                dir="ltr"
              />
            </div>
          ))}
        </div>

        {error && <p className="text-sm text-[var(--sys-destructive)]">{error}</p>}

        <div className="flex gap-2 justify-end">
          <button type="button" onClick={onClose} className="h-11 md:h-10 px-4 rounded-lg border border-[var(--sys-border)] text-sm">
            إلغاء
          </button>
          <button
            type="submit"
            disabled={saving}
            className="h-11 md:h-10 px-4 rounded-lg bg-[var(--sys-success)] text-[var(--sys-primary-foreground)] text-sm font-medium inline-flex items-center gap-1.5 disabled:opacity-50"
          >
            <RiCheckLine className="w-4 h-4" aria-hidden />
            {saving ? 'جارٍ الإضافة…' : 'أضف إلى المسوّدة'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
