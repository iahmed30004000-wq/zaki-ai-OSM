'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { apiJson } from '@/lib/api-client';
import { Modal } from '@/components/ui/Modal';
import { Input, Select } from '@/components/ui/Input';
import { RiHandCoinLine } from '@remixicon/react';
import { Money } from '@/components/ui/Money';

/**
 * "استلمت منه" — settling a مندوب, or a company that sends no file, by hand.
 *
 * There is no statement to import and no barcode to match on for these, so
 * settlement is a person naming the orders and the wallet. It is still the
 * same gate: the wallet movement is written on confirm and nowhere earlier,
 * and the amount defaults to the NET — what the courier hands over after
 * keeping their fee — rather than the COD the customer paid.
 */

interface Row {
  id: string;
  orderNumber: string;
  totalAmount: number;
  currency: string;
  deliveryFee?: number | null;
  /** What this order owes, by the settlement rule, computed on the server. */
  expectedCollection?: number | null;
  customer: { fullName: string };
  deliveryProvider: { id: string; name: string; kind?: string } | null;
}

export function CollectDialog({
  orders,
  onClose,
  onDone,
}: {
  orders: Row[];
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [wallets, setWallets] = useState<{ id: string; name: string; currencyCode: string }[]>([]);
  const [walletId, setWalletId] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const currency = orders[0]?.currency ?? '';
  /**
   * What the courier owes, as the SERVER worked it out per order.
   *
   * This used to be `totalAmount − deliveryFee`, computed here. That is
   * right for a whole delivery and wrong for a partial one, where the
   * courier owes only what the customer actually took — so every partial
   * read as a shortfall, and the person collecting saw a number accusing a
   * rep of keeping money he never received. Worse, the server applied the
   * correct rule, so the two disagreed and the difference was recorded as
   * an overpayment.
   *
   * Adding up figures the server sent is not the same as re-deriving its
   * rule: the rule stays in settlement.ts, where the matcher reads it too.
   */
  const expected = useMemo(
    () => Number(orders.reduce((sum, o) => sum + Number(o.expectedCollection ?? 0), 0).toFixed(3)),
    [orders]
  );

  useEffect(() => {
    apiJson<{ wallets: { id: string; name: string; currencyCode: string }[] }>('/api/finance/wallets')
      .then((d) => {
        const usable = d.wallets.filter((w) => w.currencyCode === currency);
        setWallets(usable);
        if (usable.length === 1) setWalletId(usable[0].id);
      })
      .catch(() => undefined);
  }, [currency]);

  const party = orders[0]?.deliveryProvider?.name ?? '—';
  const entered = amount === '' ? expected : Number(amount);
  const difference = Number((entered - expected).toFixed(3));

  return (
    <Modal isOpen onClose={onClose} title="استلام المبلغ" subtitle={`${party} · ${orders.length} طلب`}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setSaving(true);
          setError(null);
          try {
            const res = await apiJson<{ message: string }>('/api/ops/tracking/collect', {
              method: 'POST',
              body: JSON.stringify({
                orderIds: orders.map((o) => o.id),
                walletId,
                ...(amount !== '' ? { amount: Number(amount) } : {}),
                note: note.trim(),
              }),
            });
            onDone(res.message);
          } catch (err) {
            setError(err instanceof Error ? err.message : 'تعذّر التسجيل');
          } finally {
            setSaving(false);
          }
        }}
        className="space-y-3"
      >
        <div className="text-xs bg-[var(--sys-surface)] border border-[var(--sys-border)] rounded-lg p-3 space-y-1">
          <p className="text-[var(--sys-foreground)]">
            المتوقَّع منه: <b className="tabular-nums"><Money value={expected} currency={currency} /></b>
          </p>
          <p className="text-[var(--sys-muted)]">
            وهو صافي ما يسلّمه بعد خصم أجرة التوصيل، لا المبلغ الذي دفعه العميل.
          </p>
          <p className="text-[var(--sys-muted)]">
            «استلمت منه» لنقد بعملة الطلب نفسها إلى محفظة فعّالة. أيّ عملة ثانية أو سعر صرف: «مطابق يدوي» ثم «تجميع».
          </p>
        </div>

        <div className="max-h-32 overflow-y-auto border border-[var(--sys-border)] rounded-lg divide-y divide-[var(--sys-border)]">
          {orders.map((o) => (
            <div key={o.id} className="flex items-center justify-between px-3 py-1.5 text-xs">
              <span className="text-[var(--sys-foreground)]">{o.orderNumber} · {o.customer.fullName}</span>
              <span className="tabular-nums text-[var(--sys-muted-foreground)]">
                {/* The server's figure, not the browser's arithmetic — a
                    partial delivery owes what the customer took, not the
                    order's full value. */}
                {Number(o.expectedCollection ?? 0)}
              </span>
            </div>
          ))}
        </div>

        {/*
          THE SHARED FIELD, FOR THE REASON THE RETURNS DESK NEEDED IT.

          This dialog is where the drift was easiest to see: the wallet
          `<select>` had been given `bg-[var(--sys-card)]` by hand and the two
          `<input>`s beside it had not, so one control in the column was
          themed and two were the class string somebody retyped. None of the
          three carried the focus ring, which system.css deliberately does not
          supply — it paints `:focus-visible` only, so a field a person TAPS
          showed nothing at all.
        */}
        <div>
          <Select
            label="المحفظة التي دخل إليها المبلغ"
            value={walletId}
            onChange={(e) => setWalletId(e.target.value)}
            required
          >
            <option value="">اختر…</option>
            {wallets.map((w) => (
              <option key={w.id} value={w.id}>{w.name} — {w.currencyCode}</option>
            ))}
          </Select>
          {wallets.length === 0 && (
            <span className="block text-xs text-[var(--sys-destructive)] mt-1">
              لا توجد محفظة بعملة {currency} — أنشئ واحدة أولاً.
            </span>
          )}
        </div>

        <div>
          <Input
            label="المبلغ المستلم فعلياً (اتركه فارغاً إن كان مطابقاً)"
            type="number"
            step="0.001"
            min="0.001"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder={String(expected)}
            dir="ltr"
          />
          {difference !== 0 && (
            <span className="block text-xs text-[var(--sys-destructive)] mt-1 tabular-nums">
              فارق {difference} عن المتوقَّع — سيُسجَّل كما هو.
            </span>
          )}
        </div>

        <Input
          label="الملاحظة (إلزامية)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          required
          minLength={3}
          placeholder="مثال: استلمت نقداً من المندوب"
        />

        {error && <p className="text-sm text-[var(--sys-destructive)]">{error}</p>}

        <div className="flex gap-2 justify-end">
          <button type="button" onClick={onClose} className="h-11 md:h-10 px-4 rounded-lg border border-[var(--sys-border)] text-sm">
            إلغاء
          </button>
          <button
            type="submit"
            disabled={saving || !walletId}
            className="h-11 md:h-10 px-4 rounded-lg bg-[var(--sys-success)] text-[var(--sys-primary-foreground)] text-sm font-medium inline-flex items-center gap-1.5 disabled:opacity-50"
          >
            <RiHandCoinLine className="w-4 h-4" />
            {saving ? 'جارٍ التسجيل…' : 'استلمت منه'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
