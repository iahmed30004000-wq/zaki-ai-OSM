'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { apiJson } from '@/lib/api-client';
import { userCan } from '@/lib/can';
import { useApp } from '@/context/AppContext';
import { Modal } from '@/components/ui/Modal';
import { RiArrowGoBackLine, RiCheckLine, RiCloseLine, RiLoader4Line, RiUserSharedLine } from '@remixicon/react';
import { PageHeader } from '@/components/ui/PageHeader';
import { routeLabel } from '@/lib/route-registry';
import { useToast } from '@/components/ui/Toast';
import { Money } from '@/components/ui/Money';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { SHORTFALL_KIND, SHORTFALL_STATUS_AR } from '@/lib/shortfall';

/**
 * WHAT THE SYSTEM PROPOSED, AND WHAT A PERSON DECIDES.
 *
 * Every row here is money about to be taken from somebody who is not in the
 * room. So the screen is built to make waiving easy and applying deliberate:
 * the measurement is printed beside the amount, the arithmetic is shown, and
 * nothing is applied in bulk — there is no "approve all" button, because
 * approving all is exactly what a tired manager does at the end of a month.
 *
 * Waiving asks for a reason and will not proceed without one. A deduction
 * cancelled with nothing written down cannot be told apart from a favour,
 * and the person it was cancelled for is the one who suffers when somebody
 * questions it later.
 */

interface Row {
  id: string;
  kind: string;
  occurredOn: string;
  units: number;
  chargedUnits: number;
  amount: number;
  currencyCode: string;
  status: 'PROPOSED' | 'APPLIED' | 'WAIVED' | 'REVERSED';
  note: string | null;
  decisionNote: string | null;
  decidedAt: string | null;
  payslipId: string | null;
  reversesId: string | null;
  /** Set on a «فرق تحصيل»: the statement line it is about. */
  settlementMatchId?: string | null;
  user: { id: string; name: string; role: string };
}

interface Data {
  kinds: { key: string; ar: string; unitAr: string; sourceAr: string }[];
  penalties: Row[];
}

const STATUS_AR: Record<Row['status'], { ar: string; cls: string }> = {
  PROPOSED: { ar: 'مقترح', cls: 'bg-[var(--sys-warning-soft)] text-[var(--sys-warning)] border-[var(--sys-warning)]/30' },
  APPLIED: { ar: 'معتمد', cls: 'bg-[var(--sys-destructive-soft)] text-[var(--sys-destructive)] border-[var(--sys-destructive-border)]' },
  WAIVED: { ar: 'مُلغى', cls: 'bg-[var(--sys-success-soft)] text-[var(--sys-success)] border-[var(--sys-success)]/30' },
  REVERSED: { ar: 'مُرتجَع', cls: 'bg-[var(--sys-surface-strong)] text-[var(--sys-muted-foreground)] border-[var(--sys-border)]' },
};

const TABS = [
  { key: 'PROPOSED', ar: 'بانتظار القرار' },
  { key: 'APPLIED', ar: 'معتمدة' },
  { key: '', ar: 'الكل' },
];

export function PenaltiesScreen() {
  const { currentUser } = useApp();
  const mayDecide = userCan(currentUser, 'penalties.decide');
  const toast = useToast();
  const [tab, setTab] = useState('PROPOSED');
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [asking, setAsking] = useState<{ row: Row; action: 'waive' | 'reverse' | 'retarget' } | null>(null);
  const [reason, setReason] = useState('');
  // «حوّل»: the people a «فرق تحصيل» can be moved to, and the one picked.
  const [people, setPeople] = useState<{ id: string; name: string }[]>([]);
  const [target, setTarget] = useState('');

  useEffect(() => {
    if (!mayDecide) return;
    void apiJson<{ people: { id: string; name: string }[] }>('/api/team/penalties?people=1')
      .then((d) => setPeople(d.people))
      .catch(() => undefined);
  }, [mayDecide]);

  const load = useCallback(async () => {
    try {
      setData(await apiJson<Data>(`/api/team/penalties${tab ? `?status=${tab}` : ''}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر التحميل');
    }
  }, [tab]);

  useLiveRefresh(load, { key: tab });

  const decide = async (row: Row, action: 'apply' | 'waive' | 'reverse' | 'retarget', note?: string, userId?: string) => {
    setBusy(row.id);
    try {
      await apiJson('/api/team/penalties', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ penaltyId: row.id, action, note, ...(userId ? { userId } : {}) }),
      });
      setAsking(null);
      setReason('');
      setTarget('');
      await load();
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذر التنفيذ');
    } finally {
      setBusy(null);
    }
  };

  const kindAr = (key: string) => data?.kinds.find((k) => k.key === key)?.ar ?? key;
  const unitAr = (key: string) => data?.kinds.find((k) => k.key === key)?.unitAr ?? '';

  return (
    <div className="max-w-4xl space-y-3" dir="rtl">
      <PageHeader title={routeLabel('/control/penalties')}
          description="النظام يقترح، وأنت تقرّر. لا خصم يصير مالاً بلا قرار إنسان — ولا يُقترح خصمٌ على وصولٍ مُقدَّر من أول طلب لمسه الموظف، لأنه حدٌّ أعلى لا قياس."
        />

      <div className="flex gap-1.5">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`h-11 md:h-8 flex-1 rounded-lg border text-xs font-medium ${
              tab === t.key ? 'border-[var(--sys-primary)] bg-[var(--sys-primary-soft)] text-[var(--sys-primary)]' : 'border-[var(--sys-border)] text-[var(--sys-foreground)]'
            }`}
          >
            {t.ar}
          </button>
        ))}
      </div>

      {error && <p className="rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] p-2.5 text-xs text-[var(--sys-destructive)]">{error}</p>}

      {!data ? (
        <p className="flex items-center justify-center gap-2 py-10 text-sm text-[var(--sys-muted-foreground)]">
          <RiLoader4Line className="h-4 w-4 animate-spin" /> جارٍ التحميل…
        </p>
      ) : data.penalties.length === 0 ? (
        <p className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] p-6 text-center text-sm text-[var(--sys-muted-foreground)]">
          لا خصومات هنا.
        </p>
      ) : (
        <ul className="space-y-2">
          {data.penalties.map((row) => {
            const isShortfall = row.kind === SHORTFALL_KIND;
            // A «فرق تحصيل» is named by what happens to it, not by the general words.
            const st = isShortfall ? { ...STATUS_AR[row.status], ar: SHORTFALL_STATUS_AR[row.status] } : STATUS_AR[row.status];
            return (
              <li key={row.id} className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm font-semibold text-[var(--sys-heading)]">{row.user.name}</span>
                  <span className={`rounded-lg border px-1.5 py-0.5 text-xs ${st.cls}`}>{st.ar}</span>
                </div>

                <p className="mt-1 text-xs text-[var(--sys-foreground)]">
                  {kindAr(row.kind)} ·{' '}
                  <span className="tabular-nums" dir="ltr">
                    {row.occurredOn.slice(0, 10)}
                  </span>
                </p>

                {/* The arithmetic, printed. Nobody should have to trust a
                    number that took money from somebody. */}
                <p className="mt-1 text-xs text-[var(--sys-muted-foreground)]">
                  <span className="tabular-nums">{row.units}</span> {unitAr(row.kind)} ·{' '}
                  المحتسَب <span className="tabular-nums">{row.chargedUnits}</span> ·{' '}
                  <span className="font-semibold tabular-nums text-[var(--sys-heading)]" dir="ltr">
                    <Money value={row.amount} currency={row.currencyCode} />
                  </span>
                </p>

                {/* «طلب · كشف · التفسير» — what the approval wrote, so nobody opens the statement to learn what this is. */}
                {isShortfall && row.note && (
                  <p className="mt-1 rounded-lg bg-[var(--sys-surface)] px-2 py-1 text-xs text-[var(--sys-muted-foreground)]">
                    {row.note}
                  </p>
                )}

                {row.decisionNote && (
                  <p className="mt-1 rounded-lg bg-[var(--sys-surface)] px-2 py-1 text-xs text-[var(--sys-muted-foreground)]">
                    السبب: {row.decisionNote}
                  </p>
                )}

                {mayDecide && (row.status === 'PROPOSED' || row.status === 'APPLIED') && (
                  <div className="mt-2 flex flex-wrap gap-2 border-t border-[var(--sys-border)] pt-2">
                    {row.status === 'PROPOSED' && (
                      <>
                        <button
                          type="button"
                          disabled={busy === row.id}
                          onClick={() => decide(row, 'apply')}
                          className="min-h-11 md:min-h-0 inline-flex items-center flex items-center gap-1 rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] px-2.5 py-1 text-xs font-medium text-[var(--sys-destructive)] disabled:opacity-60"
                        >
                          <RiCheckLine className="h-4 w-4" /> اعتمد الخصم
                        </button>
                        <button
                          type="button"
                          disabled={busy === row.id}
                          onClick={() => setAsking({ row, action: 'waive' })}
                          className="min-h-11 md:min-h-0 inline-flex items-center flex items-center gap-1 rounded-lg border border-[var(--sys-border)] px-2.5 py-1 text-xs text-[var(--sys-foreground)] disabled:opacity-60"
                        >
                          <RiCloseLine className="h-4 w-4" /> ألغِ
                        </button>
                        {isShortfall && (
                          <button
                            type="button"
                            disabled={busy === row.id}
                            onClick={() => setAsking({ row, action: 'retarget' })}
                            className="min-h-11 md:min-h-0 inline-flex items-center flex items-center gap-1 rounded-lg border border-[var(--sys-border)] px-2.5 py-1 text-xs text-[var(--sys-foreground)] disabled:opacity-60"
                          >
                            <RiUserSharedLine className="icon-mirror h-4 w-4" /> حوّل لموظف آخر
                          </button>
                        )}
                      </>
                    )}
                    {row.status === 'APPLIED' && !row.payslipId && (
                      <button
                        type="button"
                        disabled={busy === row.id}
                        onClick={() => setAsking({ row, action: 'reverse' })}
                        className="min-h-11 md:min-h-0 inline-flex items-center flex items-center gap-1 rounded-lg border border-[var(--sys-border)] px-2.5 py-1 text-xs text-[var(--sys-foreground)] disabled:opacity-60"
                      >
                        <RiArrowGoBackLine className="icon-mirror h-4 w-4" /> ارتجاع
                      </button>
                    )}
                    {row.status === 'APPLIED' && row.payslipId && (
                      <span className="text-xs text-[var(--sys-muted)]">
                        سُوّي مع صرفية — تصحيحه حركة جديدة لا تعديل للماضي.
                      </span>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* A reason, always. The service refuses without one; asking here
          means the person is told before they press, not after. */}
      {asking && (
        <Modal
          isOpen
          onClose={() => {
            setAsking(null);
            setReason('');
            setTarget('');
          }}
          title={asking.action === 'waive' ? 'إلغاء الخصم' : asking.action === 'retarget' ? 'تحويل لموظف آخر' : 'ارتجاع الخصم'}
          subtitle={asking.row.user.name}
          maxWidth="md"
        >
          <div className="space-y-3">
            {asking.action === 'retarget' ? (
              <>
                <p className="text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
                  يُلغى هذا الخصم بسبب «ليس المسؤول»، ويُكتب خصمٌ جديد بنفس المبلغ على الموظف الذي تختاره، وينتظر قرارك.
                </p>
                <select
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm bg-[var(--sys-card)]"
                >
                  <option value="">اختر…</option>
                  {people
                    .filter((p) => p.id !== asking.row.user.id)
                    .map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                </select>
              </>
            ) : (
              <>
                <p className="text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
                  اكتب السبب. خصمٌ يُلغى بلا سبب مكتوب لا يُفرَّق عن محاباة — والمتضرّر هو من أُلغي
                  الخصم عنه حين يسأل أحدٌ لاحقاً.
                </p>
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={3}
                  maxLength={500}
                  autoFocus
                  className="w-full rounded-lg border border-[var(--sys-border-input)] px-2 py-2 text-xs text-[var(--sys-foreground)] outline-none focus:border-[var(--sys-primary)]"
                />
              </>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                disabled={(asking.action === 'retarget' ? !target : !reason.trim()) || busy === asking.row.id}
                onClick={() =>
                  asking.action === 'retarget'
                    ? decide(asking.row, 'retarget', undefined, target)
                    : decide(asking.row, asking.action, reason.trim())
                }
                className="rounded-lg bg-[var(--sys-primary)] px-4 py-2 text-xs font-medium text-[var(--sys-primary-foreground)] disabled:opacity-50"
              >
                {busy === asking.row.id ? 'جارٍ…' : 'تأكيد'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setAsking(null);
                  setReason('');
                  setTarget('');
                }}
                className="rounded-lg border border-[var(--sys-border)] px-4 py-2 text-xs text-[var(--sys-muted-foreground)]"
              >
                تراجع
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
