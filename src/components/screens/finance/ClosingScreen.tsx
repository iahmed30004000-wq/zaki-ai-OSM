'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { apiJson } from '@/lib/api-client';
import { Modal } from '@/components/ui/Modal';
import { PageShell } from '@/components/ui/PageShell';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { routeLabel } from '@/lib/route-registry';
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
    <PageShell title={routeLabel('/finance/closing')} width="wide">

      <Card padding="md" className="flex gap-3 items-end">
        <label>
          <span className="block text-note font-medium text-[var(--sys-foreground)] mb-1">يوم الإغلاق</span>
          <input
            type="date"
            value={date}
            max={today()}
            onChange={(e) => setDate(e.target.value)}
            className="h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm"
            dir="ltr"
          />
        </label>
      </Card>

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
            <Card plain padding="md" key={r.walletId}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-medium text-[var(--sys-heading)]">{r.walletName}</h3>
                  <p className="text-note text-[var(--sys-muted-foreground)] tabular-nums mt-0.5">
                    رصيد الدفاتر{' '}
                    {/* On a phone it takes the same decimals as the counted figure beside it; the desk line is as it was. */}
                    <Money value={r.bookBalance} currency={r.currencyCode} minorUnit={phone ? r.minorUnit : undefined} />
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
                      className={`text-note px-2 py-1 rounded-full border tabular-nums ${
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
                    <span className="text-note text-[var(--sys-success)] inline-flex items-center gap-1">
                      <RiLockLine className="w-4 h-4" /> معتمد
                    </span>
                  ) : (
                    <>
                      {mayCount && (
                      <Button
                        size="sm"
                        disabled={!!r.blockedBy}
                        onClick={() => setCountFor(r)}
                      >
                        {r.closing ? 'تعديل الجرد' : 'تسجيل الجرد'}
                      </Button>
                      )}
                      {r.closing && mayApprove && (
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={busy === r.walletId}
                          title="يعتمده شخص غير من سجّل الحركات أو الجرد"
                          onClick={() => { void (async () => {
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
                          })(); }}
                        >
                          اعتماد
                        </Button>
                      )}
                    </>
                  )}
                </div>
              </div>

              {phone && r.closing && r.closing.status === 'OPEN' && mayApprove && (
                <p className="mt-2 text-note text-[var(--sys-muted-foreground)]">يعتمده شخص غير من سجّل الحركات أو الجرد</p>
              )}

              {r.blockedBy && (
                <p className="mt-3 text-note text-[var(--sys-warning)] bg-[var(--sys-warning-soft)] border border-[var(--sys-warning)]/40 rounded-lg p-2.5 flex items-start gap-2">
                  <RiAlertLine className="w-4 h-4 shrink-0" />
                  إغلاق {new Date(r.blockedBy.date).toISOString().slice(0, 10)} فيه فرق{' '}
                  <b className="tabular-nums">{r.blockedBy.difference}</b> بلا تفسير — فسّره واعتمده قبل إغلاق هذا اليوم.
                </p>
              )}

              {r.closing?.explanation && (
                <Card plain className="mt-3 p-2.5 text-note text-[var(--sys-muted-foreground)]">
                  التفسير: {r.closing.explanation}
                </Card>
              )}
            </Card>
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
    </PageShell>
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
        <Card plain padding="sm" className="text-sm text-[var(--sys-foreground)] tabular-nums">
          رصيد الدفاتر: <b>{row.bookBalance}</b> {row.currencyCode}
        </Card>

        <label className="block">
          <span className="block text-note font-medium text-[var(--sys-foreground)] mb-1">المبلغ المعدود فعلياً</span>
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
            <span className="block text-note font-medium text-[var(--sys-foreground)] mb-1">سبب الفرق (إلزامي)</span>
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
          <Button type="button" variant="secondary" onClick={onClose}>
            إلغاء
          </Button>
          <Button
            type="submit"
            disabled={saving}
          >
            {saving ? 'جارٍ الحفظ…' : 'حفظ الجرد'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
