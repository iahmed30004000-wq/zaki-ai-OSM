'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { apiJson } from '@/lib/api-client';
import { Modal } from '@/components/ui/Modal';
import { RiCashLine, RiLoader4Line, RiWallet3Line } from '@remixicon/react';
import { Money } from '@/components/ui/Money';
import { useIsPhone } from '@/hooks/useIsPhone';

/**
 * WHAT THIS PERSON IS PAID, AND PAYING IT.
 *
 * The deductions had nowhere to go until this screen existed: rows saying
 * somebody owed the business forty pounds, and no moment at which those
 * forty pounds were ever taken. This is that moment, and the arithmetic is
 * printed in full before anybody presses anything — salary, what is being
 * deducted, and what is actually handed over.
 *
 * The two numbers that matter most are the ones nobody would think to ask
 * for: what did NOT fit inside the wage and stays owed for next month, and
 * what actually leaves the wallet after the rate is applied. A person
 * paying a salary in a currency the business does not hold is entitled to
 * see both before committing.
 */

interface Preview {
  salary: number;
  currencyCode: string;
  penaltyTotal: number;
  net: number;
  carriedOver: number;
  penaltyIds: string[];
  /** «فرق تحصيل» nobody decided yet: paying applies it, in the payer's name. */
  undecided?: { id: string; amount: number; currencyCode: string }[];
  otherCurrency: { currencyCode: string; amount: number }[];
  /** What was converted at the typed rate; null when nothing was. */
  converted?: { currencyCode: string; rate: number; amount: number; inSalaryCurrency: number } | null;
}

interface Data {
  period: { start: string; end: string; paid: { id: string; netAmount: number; createdAt: string } | null };
  preview: Preview;
  commission: { currencyCode: string; amount: number }[];
  wallets: WalletRow[];
}

interface WalletRow {
  id: string;
  name: string;
  currencyCode: string;
  /** Its currency's decimals. Three was hard-coded here, and Syria is USD. */
  country: { minorUnit: number };
}

const FIELD =
  'h-11 md:h-10 rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] px-2 text-xs text-[var(--sys-foreground)] outline-none focus:border-[var(--sys-primary)]';

function Line({ label, value, strong, warn }: { label: string; value: string; strong?: boolean; warn?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className={`text-xs ${warn ? 'text-[var(--sys-warning)]' : 'text-[var(--sys-muted-foreground)]'}`}>{label}</span>
      <span
        className={`tabular-nums ${strong ? 'text-sm font-bold text-[var(--sys-heading)]' : 'text-xs text-[var(--sys-foreground)]'}`}
        dir="ltr"
      >
        {value}
      </span>
    </div>
  );
}

export function UserSalary({
  userId,
  initial,
  canEdit,
  canPay,
}: {
  userId: string;
  initial: { salaryAmount: number | null; salaryCurrency: string | null };
  canEdit: boolean;
  canPay: boolean;
}) {
  const [amount, setAmount] = useState(initial.salaryAmount === null ? '' : String(initial.salaryAmount));
  const [currency, setCurrency] = useState(initial.salaryCurrency ?? '');
  const [saved, setSaved] = useState(`${initial.salaryAmount ?? ''}|${initial.salaryCurrency ?? ''}`);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // The wallet box was a fixed 160px and cut «الصندوق النقدي (JOD)» short on a phone; there it takes the line.
  const phone = useIsPhone();

  const [paying, setPaying] = useState(false);
  const [data, setData] = useState<Data | null>(null);
  const [wallets, setWallets] = useState<WalletRow[]>([]);
  const [walletId, setWalletId] = useState('');
  const [rate, setRate] = useState('1');
  const [payError, setPayError] = useState<string | null>(null);
  // Deductions in ANOTHER currency than the salary's turn into it at a rate written here, at payment.
  const [convCode, setConvCode] = useState('');
  const [convRate, setConvRate] = useState('');
  const [convApplied, setConvApplied] = useState(false);

  const current = `${amount}|${currency.toUpperCase()}`;
  const changed = current !== saved;

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/users/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'updateContact',
          salaryAmount: amount === '' ? null : Number(amount),
          salaryCurrency: currency.trim().toUpperCase(),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'تعذّر الحفظ');
      setSaved(current);
      setMsg({ ok: true, text: 'حُفظ.' });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'تعذّر الحفظ' });
    } finally {
      setBusy(false);
    }
  };

  const openPay = useCallback(async () => {
    setPaying(true);
    setPayError(null);
    setData(null);
    try {
      const slip = await apiJson<Data>(`/api/payroll/payslip?userId=${userId}`);
      setData(slip);
      setWallets(slip.wallets ?? []);
      setConvCode(slip.preview.otherCurrency[0]?.currencyCode ?? '');
      setConvRate('');
      setConvApplied(false);
    } catch (e) {
      setPayError(e instanceof Error ? e.message : 'تعذّر التحميل');
    }
  }, [userId]);

  /** Draw the slip again with the other currency's deductions converted at the rate typed. */
  const applyConversion = async () => {
    if (!convCode || !(Number(convRate) > 0)) return;
    setPayError(null);
    try {
      const slip = await apiJson<Data>(
        `/api/payroll/payslip?userId=${userId}&convertCurrency=${encodeURIComponent(convCode)}&convertRate=${encodeURIComponent(convRate)}`
      );
      setData(slip);
      setConvApplied(true);
    } catch (e) {
      setPayError(e instanceof Error ? e.message : 'تعذّر الحساب');
    }
  };

  // The currencies whose deductions can be converted: the ones waiting, and the one already converted (so its rate can be changed).
  const convOptions = data
    ? [...new Set([...data.preview.otherCurrency.map((o) => o.currencyCode), ...(data.preview.converted ? [data.preview.converted.currencyCode] : [])])]
    : [];

  const wallet = wallets.find((w) => w.id === walletId);
  // Same currency both sides needs no rate, and offering one there is how a
  // salary gets multiplied by a number somebody typed out of habit.
  const sameCurrency = !!wallet && !!data && wallet.currencyCode === data.preview.currencyCode;
  const effectiveRate = sameCurrency ? 1 : Number(rate);
  const leaves = data && effectiveRate > 0 ? data.preview.net * effectiveRate : null;

  /**
   * Why «اصرف» is off, in the order the person meets the problems — and
   * `null` when it is on. Reading the same conditions the `disabled`
   * attribute reads, so the two cannot drift: a reason for a button that
   * works, or a working button with a reason under it, are both worse than
   * saying nothing.
   */
  const offReason = !data
    ? null
    : data.period.paid
      ? 'صُرف راتب هذه الفترة من قبل.'
      : data.preview.net <= 0
        ? 'الصافي صفر أو أقل — ما في إشي يُصرف.'
        : !walletId
          ? 'اختر المحفظة اللي بيخرج منها المبلغ.'
          : !(effectiveRate > 0)
            ? 'اكتب سعر الصرف — المحفظة بعملة تانية.'
            : null;

  const pay = async () => {
    if (!data || !walletId) return;
    setBusy(true);
    setPayError(null);
    try {
      await apiJson('/api/payroll/payslip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          walletId,
          exchangeRate: effectiveRate,
          ...(convApplied && convCode && Number(convRate) > 0 ? { convert: { currencyCode: convCode, rate: Number(convRate) } } : {}),
        }),
      });
      setPaying(false);
      setMsg({ ok: true, text: 'صُرف الراتب.' });
    } catch (e) {
      setPayError(e instanceof Error ? e.message : 'تعذّر الصرف');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="col-span-full rounded-lg bg-[var(--sys-surface)] px-3 py-2.5">
      <p className="mb-1.5 flex items-center gap-1 text-xs text-[var(--sys-muted)]">
        <RiCashLine className="h-4 w-4" /> الراتب
      </p>

      <div className="flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="mb-0.5 block text-xs text-[var(--sys-muted-foreground)]">المبلغ</span>
          <input
            type="number"
            min={0}
            step="0.01"
            value={amount}
            disabled={!canEdit}
            onChange={(e) => setAmount(e.target.value)}
            className={`${FIELD} w-28`}
            dir="ltr"
          />
        </label>
        <label className="block">
          <span className="mb-0.5 block text-xs text-[var(--sys-muted-foreground)]">العملة</span>
          <input
            value={currency}
            disabled={!canEdit}
            maxLength={3}
            placeholder="EGP"
            onChange={(e) => setCurrency(e.target.value)}
            className={`${FIELD} w-20`}
            dir="ltr"
          />
        </label>

        {canEdit && (
          <button
            type="button"
            onClick={save}
            disabled={busy || !changed}
            className="h-11 md:h-10 rounded-lg bg-[var(--sys-primary)] px-3 text-xs font-medium text-[var(--sys-primary-foreground)] disabled:opacity-50"
          >
            {busy ? 'جارٍ…' : 'احفظ'}
          </button>
        )}

        {canPay && initial.salaryAmount !== null && (
          <button
            type="button"
            onClick={openPay}
            className="flex h-11 md:h-10 items-center gap-1 rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] px-3 text-xs text-[var(--sys-foreground)]"
          >
            <RiWallet3Line className="h-4 w-4" /> اصرف الراتب
          </button>
        )}
      </div>

      {!amount && (
        <p className="mt-1 text-xs text-[var(--sys-muted)]">
          لا راتب مسجّل. الخصومات المعتمدة تبقى مستحقة ولا تُطرح من شيء حتى يُسجَّل راتب.
        </p>
      )}
      {msg && <p className={`mt-1 text-xs ${msg.ok ? 'text-[var(--sys-success)]' : 'text-[var(--sys-destructive)]'}`}>{msg.text}</p>}

      {paying && (
        <Modal isOpen onClose={() => setPaying(false)} title="صرف الراتب" maxWidth="md">
          {!data && !payError && (
            <p className="flex items-center justify-center gap-2 py-6 text-sm text-[var(--sys-muted-foreground)]">
              <RiLoader4Line className="h-4 w-4 animate-spin" /> جارٍ الحساب…
            </p>
          )}
          {payError && <p className="text-sm text-[var(--sys-destructive)]">{payError}</p>}

          {data && (
            <div className="space-y-3" dir="rtl">
              <p className="text-xs text-[var(--sys-muted-foreground)]">
                الفترة{' '}
                <span dir="ltr" className="tabular-nums">
                  {data.period.start.slice(0, 10)} ← {data.period.end.slice(0, 10)}
                </span>
              </p>

              {data.period.paid && (
                <p className="rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] p-2 text-xs text-[var(--sys-destructive)]">
                  صُرف راتب هذه الفترة من قبل. شهرٌ يُصرف مرتين هو شهرٌ يُصرف مرتين.
                </p>
              )}

              <div className="divide-y divide-[var(--sys-border)] rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] px-3">
                <Line label="الراتب" value={`${data.preview.salary} ${data.preview.currencyCode}`} />
                <Line label="خصومات مطروحة" value={`− ${data.preview.penaltyTotal}`} />
                {/* A «فرق تحصيل» nobody decided: it comes out of this payment unless it is waived first. */}
                {(data.preview.undecided ?? []).map((u) => (
                  <Line
                    key={u.id}
                    label="لم يُعتمد تفسيره — سيُخصم"
                    value={`${u.amount} ${u.currencyCode}`}
                    warn
                  />
                ))}
                {data.preview.converted && (
                  <Line
                    label={`خصومات ${data.preview.converted.currencyCode} حُوّلت بسعر ${data.preview.converted.rate}`}
                    value={`${data.preview.converted.amount} ← ${data.preview.converted.inSalaryCurrency} ${data.preview.currencyCode}`}
                  />
                )}
                <Line label="الصافي" value={`${data.preview.net} ${data.preview.currencyCode}`} strong />
                {data.preview.carriedOver > 0 && (
                  <Line
                    label="خصومات لم تتّسع — تبقى مستحقة للشهر القادم"
                    value={`${data.preview.carriedOver}`}
                    warn
                  />
                )}
                {data.preview.otherCurrency.map((o) => (
                  <Line
                    key={o.currencyCode}
                    label={`خصومات بعملة ${o.currencyCode} — لا تُطرح من راتب بعملة أخرى`}
                    value={`${o.amount}`}
                    warn
                  />
                ))}
              </div>

              {convOptions.length > 0 && (
                <div className="flex flex-wrap items-end gap-2">
                  <label className="block">
                    <span className="mb-0.5 block text-xs text-[var(--sys-muted-foreground)]">حوّل خصومات عملة</span>
                    <select
                      value={convCode}
                      onChange={(e) => {
                        setConvCode(e.target.value);
                        setConvApplied(false);
                      }}
                      className={`${FIELD} w-28`}
                    >
                      {convOptions.map((code) => (
                        <option key={code} value={code}>
                          {code}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className="mb-0.5 block text-xs text-[var(--sys-muted-foreground)]">
                      {data.preview.currencyCode} لكل 1 {convCode || '؟'}
                    </span>
                    <input
                      type="number"
                      min={0}
                      step="0.000001"
                      value={convRate}
                      onChange={(e) => {
                        setConvRate(e.target.value);
                        setConvApplied(false);
                      }}
                      className={`${FIELD} w-28`}
                      dir="ltr"
                    />
                  </label>
                  <button
                    type="button"
                    disabled={!convCode || !(Number(convRate) > 0)}
                    onClick={applyConversion}
                    className="h-11 md:h-10 rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] px-3 text-xs text-[var(--sys-foreground)] disabled:opacity-50"
                  >
                    طبّق السعر
                  </button>
                </div>
              )}

              {data.commission.length > 0 && (
                <p className="text-xs text-[var(--sys-muted-foreground)]">
                  وله عمولة مستحقة لم تُصرف:{' '}
                  {data.commission.map((c) => (
                    <span key={c.currencyCode} className="ms-1 tabular-nums text-[var(--sys-heading)]" dir="ltr">
                      <Money value={c.amount} currency={c.currencyCode} />
                    </span>
                  ))}{' '}
                  — تُصرف من شاشة العمولات بزرّها.
                </p>
              )}

              <div className="flex flex-wrap items-end gap-2">
                <label className={phone ? 'block w-full' : 'block'}>
                  <span className="mb-0.5 block text-xs text-[var(--sys-muted-foreground)]">من محفظة</span>
                  <select value={walletId} onChange={(e) => setWalletId(e.target.value)} className={`${FIELD} ${phone ? 'w-full' : 'w-40'}`}>
                    <option value="">اختر…</option>
                    {wallets.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name} ({w.currencyCode})
                      </option>
                    ))}
                  </select>
                </label>
                {!sameCurrency && (
                  <label className="block">
                    <span className="mb-0.5 block text-xs text-[var(--sys-muted-foreground)]">
                      سعر الصرف ({wallet?.currencyCode ?? '؟'} لكل {data.preview.currencyCode})
                    </span>
                    <input
                      type="number"
                      min={0}
                      step="0.000001"
                      value={rate}
                      onChange={(e) => setRate(e.target.value)}
                      className={`${FIELD} w-28`}
                      dir="ltr"
                    />
                  </label>
                )}
              </div>

              {leaves !== null && wallet && (
                <p className="rounded-lg bg-[var(--sys-surface)] px-2 py-1.5 text-xs text-[var(--sys-foreground)]">
                  يخرج من المحفظة{' '}
                  <Money
                    value={leaves}
                    currency={wallet.currencyCode}
                    minorUnit={wallet.country.minorUnit}
                    className="font-semibold"
                  />
                  {!sameCurrency && ' — بالسعر الذي كتبته أنت، ويُحفظ ولا يُعاد حسابه.'}
                </p>
              )}

              {/*
                A GREY «اصرف» THAT SAYS NOTHING IS A SCREEN THAT LOOKS BROKEN.

                Five things switch this button off and only ONE of them was
                ever explained — «صُرف راتب هذه الفترة من قبل», above. The
                other four were silent: no wallet picked, no exchange rate
                typed, nothing left to pay. On a money screen that reads as
                the system refusing for a reason nobody will tell you, and
                the next move is to press it again.

                The owner's rule, in his words: «اللي مطفي عن قصد بيضل
                مطفي، بس بيكتب السبب جنبه». So the reason stands beside the
                button, and only the FIRST one that applies — a list of
                four complaints about one press is not an answer.
              */}
              {offReason && (
                <p className="text-xs text-[var(--sys-muted-foreground)]">{offReason}</p>
              )}

              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={busy || !walletId || !(effectiveRate > 0) || !!data.period.paid || data.preview.net <= 0}
                  onClick={pay}
                  className="min-h-11 md:min-h-0 rounded-lg bg-[var(--sys-primary)] px-4 py-2 text-xs font-medium text-[var(--sys-primary-foreground)] disabled:opacity-50"
                >
                  {busy ? 'جارٍ…' : 'اصرف'}
                </button>
                <button
                  type="button"
                  onClick={() => setPaying(false)}
                  className="min-h-11 md:min-h-0 rounded-lg border border-[var(--sys-border)] px-4 py-2 text-xs text-[var(--sys-muted-foreground)]"
                >
                  تراجع
                </button>
              </div>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
