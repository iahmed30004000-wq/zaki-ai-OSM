'use client';

import React, { useCallback, useState } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { Money } from '@/components/ui/Money';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input, Select, Textarea } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Rows, type Column } from '@/components/ui/Rows';
import { EmptyState } from '@/components/ui/EmptyState';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { apiJson } from '@/lib/api-client';
import { arDate } from '@/lib/format';
import { localDayKey } from '@/lib/local-day';
import type { WithdrawalsBook } from '@/lib/partner-withdrawals';

/**
 * «المسحوبات» — WHAT EACH PARTNER TOOK, PER STORE AND CURRENCY, FROM A STANDING AMOUNT TYPED ONCE (22/11).
 *
 * «الأرباح: حط شاشة مسحوبات وحط العملات» (the owner). Each partner's usual figure per currency is saved once («المبالغ الثابتة»);
 * beside each one, a box already filled with it and ONE press «سجّل مسحوب». The box may be changed for that press; «مبلغ تاني» takes
 * a figure in any currency of the stores.
 *
 * THE FIGURES ARE THE SERVER'S: every total is `GET /api/finance/partners/withdrawals`'s, per currency — two currencies are never
 * added here or there. RECORD ONLY: nothing moves a wallet and the profit and the partners' account above are unchanged — the tab
 * says so in its first line. Drawn only for who holds `finance.partners`.
 */

type Row = WithdrawalsBook['rows'][number];
type Draft = { partnerId: string; currencyCode: string; amount: string; note: string };

const ERROR_BOX = 'rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] p-2.5 text-note text-[var(--sys-destructive)]';

export function WithdrawalsSection() {
  const [book, setBook] = useState<WithdrawalsBook | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const answer = await apiJson<WithdrawalsBook>('/api/finance/partners/withdrawals');
      if (!answer || !Array.isArray(answer.partners) || !Array.isArray(answer.rows) || !Array.isArray(answer.totals)) throw new Error('not a book');
      setBook(answer);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);
  useLiveRefresh(load);

  const [day, setDay] = useState(() => localDayKey(new Date()));
  const [boxes, setBoxes] = useState<Record<string, string>>({});
  const [pressing, setPressing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [draftBusy, setDraftBusy] = useState(false);

  const [standingOf, setStandingOf] = useState<string | null>(null);
  const [standingBoxes, setStandingBoxes] = useState<Record<string, string>>({});
  const [standingError, setStandingError] = useState<string | null>(null);
  const [standingBusy, setStandingBusy] = useState(false);

  const [cancelling, setCancelling] = useState<Row | null>(null);
  const [reason, setReason] = useState('');
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);

  const post = async (body: Record<string, unknown>) =>
    apiJson('/api/finance/partners/withdrawals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  /** The one press: the box beside the standing amount, as it reads now. */
  const pressStanding = async (partnerId: string, currencyCode: string, standing: number) => {
    const key = `${partnerId}|${currencyCode}`;
    setPressing(key);
    setError(null);
    setDone(null);
    try {
      const typed = boxes[key];
      await post({ partnerId, currencyCode, amount: typed === undefined ? String(standing) : typed, withdrawnOn: day });
      setDone('انسجّل المسحوب.');
      setBoxes((b) => {
        const next = { ...b };
        delete next[key];
        return next;
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذّر تسجيل المسحوب');
    } finally {
      setPressing(null);
    }
  };

  const submitDraft = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    setDraftBusy(true);
    setDraftError(null);
    try {
      await post({ ...draft, withdrawnOn: day });
      setDraft(null);
      setDone('انسجّل المسحوب.');
      await load();
    } catch (err) {
      setDraftError(err instanceof Error ? err.message : 'تعذّر تسجيل المسحوب');
    } finally {
      setDraftBusy(false);
    }
  };

  const openStanding = (partnerId: string) => {
    if (!book) return;
    const mine = Object.fromEntries(book.standing.filter((s) => s.partnerId === partnerId).map((s) => [s.currencyCode, String(s.amount)]));
    setStandingBoxes(mine);
    setStandingError(null);
    setStandingOf(partnerId);
  };

  const submitStanding = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!book || !standingOf) return;
    setStandingBusy(true);
    setStandingError(null);
    try {
      await apiJson('/api/finance/partners/withdrawals', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          partnerId: standingOf,
          amounts: book.currencies.map((c) => ({ currencyCode: c.code, amount: (standingBoxes[c.code] ?? '').trim() })),
        }),
      });
      setStandingOf(null);
      await load();
    } catch (err) {
      setStandingError(err instanceof Error ? err.message : 'تعذّر حفظ المبالغ');
    } finally {
      setStandingBusy(false);
    }
  };

  const submitCancel = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cancelling) return;
    setCancelBusy(true);
    setCancelError(null);
    try {
      await apiJson('/api/finance/partners/withdrawals', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ withdrawalId: cancelling.id, reason: reason.trim() }),
      });
      setCancelling(null);
      setReason('');
      await load();
    } catch (err) {
      setCancelError(err instanceof Error ? err.message : 'تعذّر إلغاء المسحوب');
    } finally {
      setCancelBusy(false);
    }
  };

  if (failed && !book) {
    return (
      <Card>
        <CardHeader title="المسحوبات" />
        <CardContent>
          <p className="text-note text-[var(--sys-destructive)]">تعذّر تحميل المسحوبات — حدّث الصفحة وجرّب من جديد.</p>
        </CardContent>
      </Card>
    );
  }
  if (!book) {
    return (
      <Card>
        <CardHeader title="المسحوبات" />
        <CardContent>
          <SkeletonRows rows={4} />
        </CardContent>
      </Card>
    );
  }

  const active = book.partners.filter((p) => p.isActive);
  const minorOf = (code: string) => book.currencies.find((c) => c.code === code)?.minorUnit ?? 2;
  const partnerName = (id: string | null) => book.partners.find((p) => p.id === id)?.name ?? '—';

  const columns: Column<Row>[] = [
    { key: 'day', label: 'التاريخ', primary: true, render: (r) => arDate(r.withdrawnOn) },
    {
      key: 'partner',
      label: 'الشريك',
      primary: true,
      render: (r) => (
        <>
          {r.partnerName}
          {r.cancelled && (
            <>
              {' '}
              <Badge variant="danger">ملغى</Badge>
            </>
          )}
        </>
      ),
    },
    { key: 'amount', label: 'المبلغ', render: (r) => <Money value={r.amount} currency={r.currencyCode} minorUnit={r.minorUnit} /> },
    { key: 'kind', label: 'من', render: (r) => (r.fromStanding ? 'المبلغ الثابت' : 'مبلغ مكتوب') },
    {
      key: 'note',
      label: 'ملاحظة',
      wide: true,
      render: (r) => (r.cancelled ? `أُلغي: ${r.cancelled.reason}` : r.note || '—'),
    },
    { key: 'by', label: 'سجّله', render: (r) => r.createdByName ?? '—' },
    {
      key: 'act',
      label: 'إجراء',
      render: (r) =>
        r.cancelled ? null : (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => {
              setCancelError(null);
              setReason('');
              setCancelling(r);
            }}
          >
            إلغاء
          </Button>
        ),
    },
  ];

  const stores = [...new Set(book.byStore.map((t) => t.storeId))];

  return (
    <>
      <Card>
        <CardHeader
          title="المسحوبات"
          subtitle="سجلّ لِلّي أخده كل شريك، بالمتجر والعملة. ما بيحرّك محفظة، وما بيغيّر الربح ولا حساب الشركاء."
        />
        <CardContent className="space-y-4">
          <div className="w-56">
            <Input label="تاريخ السحب" type="date" value={day} onChange={(e) => setDay(e.target.value)} />
          </div>
          {error && <p className={ERROR_BOX}>{error}</p>}
          {done && <p className="text-note text-[var(--sys-success)]">{done}</p>}

          {active.length === 0 ? (
            <EmptyState
              title="ما في شركاء محفوظين"
              why="سجّل الشركاء من «قواعد المال» — بعدها بتحط لكل واحد مبلغه الثابت بكل عملة."
              action={{ label: 'افتح قواعد المال', href: '/finance/rules' }}
            />
          ) : (
            <ul className="divide-y divide-[var(--sys-border)]">
              {active.map((p) => {
                const mine = book.standing.filter((s) => s.partnerId === p.id);
                return (
                  <li key={p.id} className="space-y-2 py-3">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="text-sm font-bold text-[var(--sys-heading)]">{p.name}</span>
                      <Button type="button" size="sm" variant="secondary" onClick={() => openStanding(p.id)}>
                        المبالغ الثابتة
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          setDraftError(null);
                          setDraft({ partnerId: p.id, currencyCode: book.currencies[0]?.code ?? '', amount: '', note: '' });
                        }}
                      >
                        مبلغ تاني
                      </Button>
                    </div>
                    {mine.length === 0 ? (
                      <p className="text-note text-[var(--sys-muted)]">ما في مبلغ ثابت — حطّه من «المبالغ الثابتة» أو سجّل «مبلغ تاني».</p>
                    ) : (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {mine.map((s) => {
                          const key = `${p.id}|${s.currencyCode}`;
                          return (
                            <div key={key} className="flex flex-wrap items-end gap-2">
                              <Input
                                label={`المبلغ (${s.currencyCode})`}
                                type="number"
                                inputMode="decimal"
                                step="any"
                                value={boxes[key] ?? String(s.amount)}
                                onChange={(e) => setBoxes((b) => ({ ...b, [key]: e.target.value }))}
                              />
                              <Button type="button" size="sm" loading={pressing === key} onClick={() => pressStanding(p.id, s.currencyCode, s.amount)}>
                                سجّل مسحوب
                              </Button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader title="مجموع المسحوبات بهالمتجر" subtitle="لكل شريك بكل عملة لحالها — العملات ما بتنجمع مع بعض." />
        <CardContent>
          {book.totals.length === 0 ? (
            <p className="text-note text-[var(--sys-muted)]">ما في مسحوبات بهالمتجر.</p>
          ) : (
            <ul className="divide-y divide-[var(--sys-border)]">
              {book.totals.map((t) => (
                <li key={`${t.partnerId}|${t.currencyCode}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
                  <span className="text-sm font-bold text-[var(--sys-heading)]">{t.partnerName}</span>
                  <span className="text-note text-[var(--sys-muted)] tabular-nums">{t.count} مسحوب</span>
                  <span className="ms-auto text-sm font-bold text-[var(--sys-heading)]">
                    <Money value={t.total} currency={t.currencyCode} minorUnit={t.minorUnit} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {stores.length > 0 && (
        <Card>
          <CardHeader title="المسحوبات بكل المتاجر" subtitle="لكل متجر، لكل شريك، بكل عملة لحالها." />
          <CardContent>
            <ul className="divide-y divide-[var(--sys-border)]">
              {stores.map((storeId) => {
                const lines = book.byStore.filter((t) => t.storeId === storeId);
                return (
                  <li key={storeId} className="space-y-1 py-2">
                    <span className="text-sm font-bold text-[var(--sys-heading)]">{lines[0]?.storeName ?? '—'}</span>
                    {lines.map((t) => (
                      <div key={`${t.partnerId}|${t.currencyCode}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-note">
                        <span className="text-[var(--sys-muted-foreground)]">{t.partnerName}</span>
                        <span className="ms-auto font-bold text-[var(--sys-heading)]">
                          <Money value={t.total} currency={t.currencyCode} minorUnit={t.minorUnit} />
                        </span>
                      </div>
                    ))}
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader title="سجل المسحوبات" subtitle="كل مسحوب بتاريخه. «إلغاء» بيكتب سطر عكسي بالسبب — والمسحوب بيضل مكتوب «ملغى»." />
        <CardContent className="p-0">
          <Rows
            rows={book.rows}
            keyOf={(r) => r.id}
            columns={columns}
            empty={<EmptyState title="ما في مسحوبات مسجَّلة بهالمتجر" why="اضغط «سجّل مسحوب» جنب مبلغ الشريك الثابت، أو «مبلغ تاني»." />}
          />
        </CardContent>
      </Card>

      {/* A figure typed for this press, in any currency of the stores. */}
      <Modal isOpen={!!draft} onClose={() => setDraft(null)} title="مسحوب بمبلغ تاني" subtitle={`لـ${partnerName(draft?.partnerId ?? null)} — بتاريخ ${day}`}>
        {draft && (
          <form onSubmit={submitDraft} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <Select label="العملة *" value={draft.currencyCode} onChange={(e) => setDraft({ ...draft, currencyCode: e.target.value })} required>
                {book.currencies.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.ar} ({c.code})
                  </option>
                ))}
              </Select>
              <Input
                label="المبلغ *"
                type="number"
                inputMode="decimal"
                step="any"
                value={draft.amount}
                onChange={(e) => setDraft({ ...draft, amount: e.target.value })}
                required
              />
            </div>
            <Textarea label="ملاحظة" rows={2} value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
            {draftError && <p className={ERROR_BOX}>{draftError}</p>}
            <div className="flex justify-end space-x-2 pt-2">
              <Button type="button" variant="secondary" onClick={() => setDraft(null)}>
                تراجع
              </Button>
              <Button type="submit" loading={draftBusy}>
                سجّل المسحوب
              </Button>
            </div>
          </form>
        )}
      </Modal>

      {/* The standing amounts of one partner: one box per currency of the stores; an empty box clears it. */}
      <Modal
        isOpen={!!standingOf}
        onClose={() => setStandingOf(null)}
        title="المبالغ الثابتة"
        subtitle={`لـ${partnerName(standingOf)} — بتنكتب مرة وحدة، وبتعبّي «سجّل مسحوب». الخانة الفاضية بتشيل العملة.`}
      >
        <form onSubmit={submitStanding} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            {book.currencies.map((c) => (
              <Input
                key={c.code}
                label={`${c.ar} (${c.code})`}
                type="number"
                inputMode="decimal"
                step="any"
                value={standingBoxes[c.code] ?? ''}
                onChange={(e) => setStandingBoxes((b) => ({ ...b, [c.code]: e.target.value }))}
              />
            ))}
          </div>
          {standingError && <p className={ERROR_BOX}>{standingError}</p>}
          <div className="flex justify-end space-x-2 pt-2">
            <Button type="button" variant="secondary" onClick={() => setStandingOf(null)}>
              تراجع
            </Button>
            <Button type="submit" loading={standingBusy}>
              احفظ المبالغ
            </Button>
          </div>
        </form>
      </Modal>

      {/* Cancel: a reversing row with the reason; the original stays, marked «ملغى». */}
      <Modal isOpen={!!cancelling} onClose={() => setCancelling(null)} title="إلغاء مسحوب" subtitle="بيكتب سطر عكسي بالسبب — والمسحوب بيضل بالسجل مكتوب «ملغى»">
        <form onSubmit={submitCancel} className="space-y-4">
          <p className="text-sm text-[var(--sys-heading)]">
            {cancelling?.partnerName} — {cancelling && <Money value={cancelling.amount} currency={cancelling.currencyCode} minorUnit={minorOf(cancelling.currencyCode)} />}
          </p>
          <Textarea label="سبب الإلغاء *" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} required minLength={3} />
          {cancelError && <p className={ERROR_BOX}>{cancelError}</p>}
          <div className="flex justify-end space-x-2 pt-2">
            <Button type="button" variant="secondary" onClick={() => setCancelling(null)}>
              تراجع
            </Button>
            <Button type="submit" variant="danger" loading={cancelBusy} disabled={reason.trim().length < 3}>
              ألغِ المسحوب
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
