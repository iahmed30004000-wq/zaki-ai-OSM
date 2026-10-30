'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { apiJson } from '@/lib/api-client';
import { Modal } from '@/components/ui/Modal';
import { ScreenTitle } from '@/components/shell/ScreenTitle';
import { RiAlertLine, RiLoader4Line, RiLockLine, RiWallet3Line } from '@remixicon/react';
import { useToast } from '@/components/ui/Toast';
import { Money } from '@/components/ui/Money';
import { EmptyState } from '@/components/ui/EmptyState';
import { useApp } from '@/context/AppContext';
import { userCan } from '@/lib/can';
import { useIsPhone } from '@/hooks/useIsPhone';

/**
 * /finance/closing — count each wallet at the end of the day against its book
 * balance. A difference needs a written explanation, an unexplained one
 * blocks the next day, and whoever recorded the day's movements cannot
 * approve its closing — the approve button simply refuses, server-side.
 */

interface Closing {
  id: string;
  status: 'OPEN' | 'APPROVED';
  bookBalance: number;
  actualBalance: number;
  difference: number;
  explanation: string | null;
  recordedById: string;
}

interface Row {
  walletId: string;
  walletName: string;
  currencyCode: string;
  /** Its currency's decimals — three was hard-coded, and Syria is USD. */
  minorUnit: number;
  bookBalance: number;
  closing: Closing | null;
  blockedBy: { id: string; date: string; difference: number } | null;
}

const today = () => new Date().toISOString().slice(0, 10);

export function ClosingScreen() {
  const toast = useToast();
  const { currentUser } = useApp();
  // The screen opens on the cash box's VIEW key (PR-9); each press below is drawn only for the key its door asks.
  const mayCount = userCan(currentUser, 'finance.cashbox');
  const mayApprove = userCan(currentUser, 'finance.closing_approve');
  // The phone prints the figures the way every other money figure here is printed, and says out loud the rule that
  // otherwise lives only in a `title` — which a phone never shows.
  const phone = useIsPhone();
  const [date, setDate] = useState(today());
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [countFor, setCountFor] = useState<Row | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRows(null);
    try {
      const data = await apiJson<{ rows: Row[] }>(`/api/finance/closing?date=${date}`);
      setRows(data.rows);
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذر التحميل');
    }
  }, [date]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="max-w-5xl space-y-3">
      <ScreenTitle />

      <div className="bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg p-4 flex gap-3 items-end">
        <label>
          <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">يوم الإغلاق</span>
          <input
            type="date"
            value={date}
            max={today()}
            onChange={(e) => setDate(e.target.value)}
            className="h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm"
            dir="ltr"
          />
        </label>
      </div>

      {error && <p className="text-sm text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] rounded-lg p-3">{error}</p>}
      {done && <p className="text-sm text-[var(--sys-success)] bg-[var(--sys-success-soft)] border border-[var(--sys-success)]/30 rounded-lg p-3">{done}</p>}

      {!rows ? (
        <div className="flex items-center justify-center gap-2 text-[var(--sys-muted-foreground)] text-sm py-16">
          <RiLoader4Line className="w-4 h-4 animate-spin" /> جارٍ التحميل…
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={RiWallet3Line}
          title="لا محافظ نشطة"
          why="الجرد يُسجَّل على محفظة نشطة. أنشئ المحفظة أولاً من شاشة المحافظات، ويظهر جردُها هنا."
          action={{ label: 'افتح المحافظات', href: '/finance/wallets' }}
        />
      ) : (
        <div className="space-y-3">
          {rows.map((r) => (
            <div key={r.walletId} className="bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-medium text-[var(--sys-heading)]">{r.walletName}</h3>
                  <p className="text-xs text-[var(--sys-muted-foreground)] tabular-nums mt-0.5">
                    رصيد الدفاتر <Money value={r.bookBalance} currency={r.currencyCode} />
                    {r.closing &&
                      (phone ? (
                        <>
                          {' · الجرد '}
                          <Money value={r.closing.actualBalance} currency={r.currencyCode} minorUnit={r.minorUnit} />
                        </>
                      ) : (
                        ` · الجرد ${r.closing.actualBalance}`
                      ))}
                  </p>
                </div>

                <div className="flex items-center gap-3">
                  {r.closing && (
                    <span
                      className={`text-xs px-2 py-1 rounded-full border tabular-nums ${
                        r.closing.difference === 0
                          ? 'bg-[var(--sys-success-soft)] text-[var(--sys-success)] border-[var(--sys-success)]/40'
                          : 'bg-[var(--sys-destructive-soft)] text-[var(--sys-destructive)] border-[var(--sys-destructive-border)]'
                      }`}
                    >
                      الفرق{' '}
                      {phone ? (
                        <Money value={r.closing.difference} currency={r.currencyCode} minorUnit={r.minorUnit} />
                      ) : (
                        r.closing.difference
                      )}
                    </span>
                  )}
                  {r.closing?.status === 'APPROVED' ? (
                    <span className="text-xs text-[var(--sys-success)] inline-flex items-center gap-1">
                      <RiLockLine className="w-4 h-4" /> معتمد
                    </span>
                  ) : (
                    <>
                      {mayCount && (
                      <button
                        disabled={!!r.blockedBy}
                        onClick={() => setCountFor(r)}
                        className="h-11 md:h-8 px-3 rounded-lg bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] text-xs font-medium disabled:opacity-50"
                      >
                        {r.closing ? 'تعديل الجرد' : 'تسجيل الجرد'}
                      </button>
                      )}
                      {r.closing && mayApprove && (
                        <button
                          disabled={busy === r.walletId}
                          title="يعتمده شخص غير من سجّل الحركات أو الجرد"
                          onClick={async () => {
                            setBusy(r.walletId);
                            setDone(null);
                            try {
                              await apiJson('/api/finance/closing', {
                                method: 'PATCH',
                                body: JSON.stringify({ closingId: r.closing!.id }),
                              });
                              setDone(`اعتُمد إغلاق ${r.walletName}`);
                              await load();
                            } catch (e) {
                              toast.failed(e instanceof Error ? e.message : 'تعذر الاعتماد');
                            } finally {
                              setBusy(null);
                            }
                          }}
                          className="h-11 md:h-8 px-3 rounded-lg border border-[var(--sys-border)] text-xs font-medium text-[var(--sys-success)] disabled:opacity-50"
                        >
                          اعتماد
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>

              {phone && r.closing && r.closing.status === 'OPEN' && mayApprove && (
                <p className="mt-2 text-xs text-[var(--sys-muted-foreground)]">يعتمده شخص غير من سجّل الحركات أو الجرد</p>
              )}

              {r.blockedBy && (
                <p className="mt-3 text-xs text-[var(--sys-warning)] bg-[var(--sys-warning-soft)] border border-[var(--sys-warning)]/40 rounded-lg p-2.5 flex items-start gap-2">
                  <RiAlertLine className="w-4 h-4 shrink-0" />
                  إغلاق {new Date(r.blockedBy.date).toISOString().slice(0, 10)} فيه فرق{' '}
                  <b className="tabular-nums">{r.blockedBy.difference}</b> بلا تفسير — فسّره واعتمده قبل إغلاق هذا اليوم.
                </p>
              )}

              {r.closing?.explanation && (
                <p className="mt-3 text-xs text-[var(--sys-muted-foreground)] bg-[var(--sys-surface)] border border-[var(--sys-border)] rounded-lg p-2.5">
                  التفسير: {r.closing.explanation}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {countFor && (
        <CountDialog
          row={countFor}
          date={date}
          onClose={() => setCountFor(null)}
          onSaved={async (message) => {
            setCountFor(null);
            setDone(message);
            await load();
          }}
        />
      )}
    </div>
  );
}

function CountDialog({
  row,
  date,
  onClose,
  onSaved,
}: {
  row: Row;
  date: string;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [actual, setActual] = useState(row.closing ? String(row.closing.actualBalance) : '');
  const [explanation, setExplanation] = useState(row.closing?.explanation ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const difference = actual === '' ? null : Number(actual) - row.bookBalance;
  const needsExplanation = difference !== null && Math.abs(difference) > 1e-9;

  return (
    <Modal isOpen onClose={onClose} title={`جرد ${row.walletName} — ${date}`}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setSaving(true);
          setError(null);
          try {
            await apiJson('/api/finance/closing', {
              method: 'POST',
              body: JSON.stringify({
                walletId: row.walletId,
                date,
                actualBalance: Number(actual),
                ...(explanation.trim() ? { explanation: explanation.trim() } : {}),
              }),
            });
            onSaved('سُجِّل الجرد — يبقى بانتظار اعتماد شخص آخر');
          } catch (err) {
            setError(err instanceof Error ? err.message : 'تعذر الحفظ');
          } finally {
            setSaving(false);
          }
        }}
        className="space-y-3"
      >
        <p className="text-sm text-[var(--sys-foreground)] bg-[var(--sys-surface)] border border-[var(--sys-border)] rounded-lg p-3 tabular-nums">
          رصيد الدفاتر: <b>{row.bookBalance}</b> {row.currencyCode}
        </p>

        <label className="block">
          <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">المبلغ المعدود فعلياً</span>
          <input
            type="number"
            step="0.001"
            value={actual}
            onChange={(e) => setActual(e.target.value)}
            required
            autoFocus
            className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm"
            dir="ltr"
          />
        </label>

        {difference !== null && (
          <p
            className={`text-sm rounded-lg p-3 border tabular-nums ${
              needsExplanation
                ? 'text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] border-[var(--sys-destructive-border)]'
                : 'text-[var(--sys-success)] bg-[var(--sys-success-soft)] border-[var(--sys-success)]/40'
            }`}
          >
            الفرق:{' '}
            <b>
              <Money value={difference} currency={row.currencyCode} minorUnit={row.minorUnit} />
            </b>
            {needsExplanation && ' — يحتاج تفسيراً مكتوباً'}
          </p>
        )}

        {needsExplanation && (
          <label className="block">
            <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">سبب الفرق (إلزامي)</span>
            <textarea
              value={explanation}
              onChange={(e) => setExplanation(e.target.value)}
              required
              rows={3}
              className="w-full p-3 rounded-lg border border-[var(--sys-border-input)] text-sm"
              placeholder="مثال: سلفة نقدية لمندوب لم تُسجَّل بعد"
            />
          </label>
        )}

        {error && <p className="text-sm text-[var(--sys-destructive)]">{error}</p>}

        <div className="flex gap-2 justify-end">
          <button type="button" onClick={onClose} className="h-11 md:h-10 px-4 rounded-lg border border-[var(--sys-border)] text-sm">
            إلغاء
          </button>
          <button
            type="submit"
            disabled={saving}
            className="h-11 md:h-10 px-4 rounded-lg bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] text-sm font-medium disabled:opacity-50"
          >
            {saving ? 'جارٍ الحفظ…' : 'حفظ الجرد'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
