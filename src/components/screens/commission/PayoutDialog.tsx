'use client';

import React, { useEffect, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { apiJson } from '@/lib/api-client';
import { RiLoader4Line, RiWallet3Line } from '@remixicon/react';
import { useToast } from '@/components/ui/Toast';
import { Money } from '@/components/ui/Money';

/**
 * HANDING OVER THE MONEY.
 *
 * Two currencies meet here and they are not one question. The person earned
 * in theirs — an Egyptian moderator counts in pounds. The wallet pays in
 * its own, and there may be no pound wallet at all.
 *
 * So the owner picks the wallet the cash really leaves and writes the rate
 * themselves, and the dialog shows what will leave BEFORE they confirm:
 * a rate typed the wrong way round is the difference between paying ten
 * dinars and paying twenty-four thousand, and it must be visible while it
 * can still be changed.
 */

interface Owed {
  currencyCode: string;
  amount: number;
  entries: string[];
}

interface Wallet {
  id: string;
  name: string;
  currencyCode: string;
  /** Its currency's decimals. Three was hard-coded here, and Syria is USD. */
  country: { minorUnit: number };
}

export function PayoutDialog({
  userId,
  userName,
  onClose,
  onPaid,
}: {
  userId: string;
  userName: string;
  onClose: () => void;
  onPaid: () => void;
}) {
  const toast = useToast();
  const [owed, setOwed] = useState<Owed[] | null>(null);
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [pick, setPick] = useState(0);
  const [walletId, setWalletId] = useState('');
  const [rate, setRate] = useState('1');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiJson<{ owed: Owed[]; wallets: Wallet[] }>(`/api/finance/commission/payout?userId=${userId}`)
      .then((d) => {
        setOwed(d.owed ?? []);
        setWallets(d.wallets ?? []);
        if (d.wallets?.length === 1) setWalletId(d.wallets[0].id);
      })
      .catch((e) => { setOwed([]); setError(e instanceof Error ? e.message : 'تعذر التحميل'); });
  }, [userId]);

  const row = owed?.[pick] ?? null;
  const wallet = wallets.find((w) => w.id === walletId) ?? null;
  const sameCurrency = !!wallet && !!row && wallet.currencyCode === row.currencyCode;
  const numericRate = Number(rate);
  // What will actually leave, shown before anything is confirmed.
  const leaving = row && numericRate > 0 ? row.amount * numericRate : null;

  // A wallet of the same currency needs no conversion, and offering one is
  // an invitation to mistype a rate that should be 1.
  useEffect(() => { if (sameCurrency) setRate('1'); }, [sameCurrency]);

  async function pay() {
    if (!row || !wallet) return;
    setSaving(true);
    try {
      await apiJson('/api/finance/commission/payout', {
        method: 'POST',
        body: JSON.stringify({
          userId,
          walletId: wallet.id,
          entryIds: row.entries,
          exchangeRate: sameCurrency ? 1 : numericRate,
          note: note.trim() || null,
        }),
      });
      onPaid();
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذر الصرف');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal isOpen onClose={onClose} title={`صرف عمولة ${userName}`}>
      {!owed ? (
        <div className="flex items-center justify-center gap-2 py-8 text-sm text-[var(--sys-muted-foreground)]">
          <RiLoader4Line className="h-4 w-4 animate-spin" /> جارٍ التحميل…
        </div>
      ) : owed.length === 0 ? (
        <p className="py-8 text-center text-sm text-[var(--sys-muted-foreground)]">
          لا عمولة مستحقة لهذا الموظف.
          <span className="mt-1 block text-note text-[var(--sys-muted)]">
            العمولة تصير مستحقة بعد اعتماد كشف التحصيل الذي يغطّيها.
          </span>
        </p>
      ) : (
        <div className="space-y-3">
          {owed.length > 1 && (
            <label className="block">
              <span className="mb-1 block text-note font-medium text-[var(--sys-foreground)]">العملة المستحقة</span>
              <select
                value={pick}
                onChange={(e) => setPick(Number(e.target.value))}
                className="h-11 md:h-10 w-full rounded-lg border border-[var(--sys-border-input)] bg-[var(--sys-card)] px-3 text-sm"
              >
                {owed.map((o, i) => (
                  <option key={o.currencyCode} value={i}>
                    <Money value={o.amount} currency={o.currencyCode} /> · {o.entries.length} قيد
                  </option>
                ))}
              </select>
              <span className="mt-1 block text-note text-[var(--sys-muted)]">
                كل عملة تُصرف وحدها — سعر واحد لا يخدم عملتين.
              </span>
            </label>
          )}

          <div className="rounded-lg bg-[var(--sys-surface)] px-3 py-2.5">
            <p className="text-note text-[var(--sys-muted-foreground)]">المستحق</p>
            <p className="text-lg font-black text-[var(--sys-heading)] tabular-nums" dir="ltr">
              <Money value={row?.amount} currency={row?.currencyCode} />
            </p>
            <p className="text-note text-[var(--sys-muted)]">{row?.entries.length} قيد عمولة</p>
          </div>

          <label className="block">
            <span className="mb-1 block text-note font-medium text-[var(--sys-foreground)]">تُصرف من محفظة</span>
            <select
              value={walletId}
              onChange={(e) => setWalletId(e.target.value)}
              className="h-11 md:h-10 w-full rounded-lg border border-[var(--sys-border-input)] bg-[var(--sys-card)] px-3 text-sm"
            >
              <option value="">— اختر المحفظة —</option>
              {wallets.map((w) => (
                <option key={w.id} value={w.id}>{w.name} ({w.currencyCode})</option>
              ))}
            </select>
            {wallets.length === 0 && (
              <span className="mt-1 block text-note text-[var(--sys-warning)]">لا محفظة مفعّلة — أنشئ واحدة أولاً.</span>
            )}
          </label>

          {wallet && !sameCurrency && (
            <label className="block">
              <span className="mb-1 block text-note font-medium text-[var(--sys-foreground)]">
                سعر الصرف — كم {wallet.currencyCode} لكل {row?.currencyCode} واحد
              </span>
              <input
                type="number"
                step="0.000001"
                min="0"
                value={rate}
                onChange={(e) => setRate(e.target.value)}
                className="h-11 md:h-10 w-full rounded-lg border border-[var(--sys-border-input)] px-3 text-sm"
                dir="ltr"
              />
              <span className="mt-1 block text-note text-[var(--sys-muted)]">
                يُحفظ كما تكتبه ولا يُعاد حسابه — شهر دُفع يبقى كما هو.
              </span>
            </label>
          )}

          {wallet && leaving !== null && (
            <div className="rounded-lg border border-[var(--sys-border)] px-3 py-2.5">
              <p className="flex items-center gap-1.5 text-note text-[var(--sys-muted-foreground)]">
                <RiWallet3Line className="h-4 w-4" /> سيخرج من «{wallet.name}»
              </p>
              <p className="text-lg font-black text-[var(--sys-destructive)]">
                <Money
                  value={leaving}
                  currency={wallet.currencyCode}
                  minorUnit={wallet.country.minorUnit}
                />
              </p>
              <p className="text-note text-[var(--sys-muted)]">
                ويُسجَّل مصروفاً على المحفظة، وتُقفل قيود العمولة المدفوعة.
              </p>
            </div>
          )}

          <label className="block">
            <span className="mb-1 block text-note font-medium text-[var(--sys-foreground)]">ملاحظة (اختياري)</span>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={200}
              placeholder="تحويل بنكي، نقداً باليد…"
              className="h-11 md:h-10 w-full rounded-lg border border-[var(--sys-border-input)] px-3 text-sm"
            />
          </label>

          {error && <p className="text-sm text-[var(--sys-destructive)]">{error}</p>}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              إلغاء
            </Button>
            <Button
              type="button"
              onClick={() => void pay()}
              disabled={saving || !wallet || (!sameCurrency && !(numericRate > 0))}
            >
              {saving ? 'جارٍ الصرف…' : 'صرف'}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
