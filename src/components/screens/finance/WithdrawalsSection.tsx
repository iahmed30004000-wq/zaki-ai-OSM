'use client';

import React, { useCallback, useState } from 'react';
import Link from 'next/link';
import { RiEyeLine } from '@remixicon/react';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { Money } from '@/components/ui/Money';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Input, Select, Textarea } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Rows, type Column } from '@/components/ui/Rows';
import { EmptyState } from '@/components/ui/EmptyState';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { Segmented } from '@/components/ui/Segmented';
import { DateRange, initialRange, type Range } from '@/components/ui/DateRange';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { apiJson } from '@/lib/api-client';
import { arDate } from '@/lib/format';
import { standingPrefill } from '@/lib/partner-withdrawals-core';
import { MOVEMENT_CATEGORY_AR } from '@/lib/movement-category-words';
import type { WithdrawalsBook } from '@/lib/partner-withdrawals';
import { HistoryExport } from './HistoryExport';
import { MovementDetails, RealDateCell } from './RealDateDetails';

/**
 * «المسحوبات» — ONE PLACE FOR THE PARTNERS' WITHDRAWALS, WHICH ARE WALLET MOVEMENTS (23/11, F7).
 *
 * «والحركات تكون من المحافظ، وآخر شي تكون زي داشبورد للشركاء والسحوبات… ما بدي الحركات المالية بكل مكان، خلص مكان واحد» (the owner).
 *
 * A withdrawal is an OUT wallet movement of «سحب شريك»: the one press here and the wallet dialog both write it through the draws
 * door (`POST /api/finance/partners/draws`, keys «الشركاء والسحوبات» + the cash box's). This tab READS them: the totals per partner and
 * currency (and what they are worth in the store's currency), per store, over the span picked on the real date, and the list with
 * the eye and a way to the movement in its wallet. A reversed draw is listed struck through and counted nowhere — it is reversed at
 * its wallet, never here. The standing amounts are a shortcut: they fill the boxes, the person may change them.
 *
 * Every figure is the server's (`GET /api/finance/partners/withdrawals`); two currencies are never added here.
 */

type Row = WithdrawalsBook['rows'][number];
type Legacy = WithdrawalsBook['legacy'][number];
type Book = WithdrawalsBook & { mayRecord: boolean };
type Box = { walletId: string; amount: string; storeValue: string };
type Draft = { partnerId: string; walletId: string; amount: string; storeValue: string; note: string; fromStanding: boolean };

const ERROR_BOX = 'rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] p-2.5 text-note text-[var(--sys-destructive)]';
export const FROM_STANDING_LINE = 'من المبلغ الثابت للشريك — تقدر تعدّله';

export function WithdrawalsSection() {
  const [book, setBook] = useState<Book | null>(null);
  const [failed, setFailed] = useState(false);
  const [span, setSpan] = useState<'all' | 'range'>('all');
  const [range, setRange] = useState<Range>(() => initialRange('30d'));

  const query = span === 'range' ? `?from=${range.from}&to=${range.to}` : '';
  const load = useCallback(async () => {
    try {
      const answer = await apiJson<Book>(`/api/finance/partners/withdrawals${query}`);
      if (!answer || !Array.isArray(answer.partners) || !Array.isArray(answer.rows) || !Array.isArray(answer.totals)) throw new Error('not a book');
      setBook(answer);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [query]);
  // A new span is a new question: the key makes the hook ask it (the load itself is read through its ref).
  useLiveRefresh(load, { key: query });

  const [boxes, setBoxes] = useState<Record<string, Partial<Box>>>({});
  const [pressing, setPressing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [draftBusy, setDraftBusy] = useState(false);

  const [standingOf, setStandingOf] = useState<string | null>(null);
  const [standingBoxes, setStandingBoxes] = useState<Record<string, { amount: string; storeValue: string }>>({});
  const [standingError, setStandingError] = useState<string | null>(null);
  const [standingBusy, setStandingBusy] = useState(false);

  const [detailsId, setDetailsId] = useState<string | null>(null);

  /** One draw, through the draws door — the wallet's own rules, keys and twin check. The boxes' characters go as typed. */
  const draw = async (body: { walletId: string; partnerId: string; amount: string; storeValue: string; note?: string }, otherCurrency: boolean) =>
    apiJson('/api/finance/partners/draws', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        walletId: body.walletId,
        partnerId: body.partnerId,
        amount: body.amount.trim(),
        ...(otherCurrency ? { valueInStoreCurrency: body.storeValue.trim() } : {}),
        ...(body.note?.trim() ? { note: body.note.trim() } : {}),
      }),
    });

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

  const store = book.storeCurrency.code;
  const active = book.partners.filter((p) => p.isActive);
  const partnerName = (id: string | null) => book.partners.find((p) => p.id === id)?.name ?? '—';
  const walletsIn = (code: string) => book.wallets.filter((w) => w.currencyCode === code);
  const walletOf = (id: string) => book.wallets.find((w) => w.id === id) ?? null;

  /** The box of one standing amount, as it reads now: what the person typed, else the standing figures. */
  const boxOf = (partnerId: string, currencyCode: string): Box => {
    const key = `${partnerId}|${currencyCode}`;
    const typed = boxes[key] ?? {};
    const pre = standingPrefill(book.standing, partnerId, currencyCode, store);
    const wallets = walletsIn(currencyCode);
    const last = book.lastWallet[key];
    return {
      walletId: typed.walletId ?? (wallets.some((w) => w.id === last) ? last : wallets[0]?.id ?? ''),
      amount: typed.amount ?? pre?.amount ?? '',
      storeValue: typed.storeValue ?? pre?.storeValue ?? '',
    };
  };

  const pressStanding = async (partnerId: string, currencyCode: string) => {
    const key = `${partnerId}|${currencyCode}`;
    const box = boxOf(partnerId, currencyCode);
    setPressing(key);
    setError(null);
    setDone(null);
    try {
      await draw({ partnerId, ...box }, currencyCode !== store);
      setDone('انسجّل المسحوب — طلع من المحفظة وانحسب على نصيب الشريك.');
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

  /** «مبلغ تاني»: the wallet decides the currency; the standing figures of that currency fill the boxes, and may be changed. */
  const fillDraft = (d: Draft, walletId: string): Draft => {
    const w = walletOf(walletId);
    const pre = w ? standingPrefill(book.standing, d.partnerId, w.currencyCode, store) : null;
    if (pre) return { ...d, walletId, amount: pre.amount, storeValue: pre.storeValue ?? '', fromStanding: true };
    // No standing figure here: today's boxes — empty, unless the person typed them himself.
    return d.fromStanding ? { ...d, walletId, amount: '', storeValue: '', fromStanding: false } : { ...d, walletId };
  };

  const submitDraft = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    const w = walletOf(draft.walletId);
    setDraftBusy(true);
    setDraftError(null);
    try {
      await draw(draft, !!w && w.currencyCode !== store);
      setDraft(null);
      setDone('انسجّل المسحوب — طلع من المحفظة وانحسب على نصيب الشريك.');
      await load();
    } catch (err) {
      setDraftError(err instanceof Error ? err.message : 'تعذّر تسجيل المسحوب');
    } finally {
      setDraftBusy(false);
    }
  };

  const openStanding = (partnerId: string) => {
    const mine = Object.fromEntries(
      book.standing
        .filter((s) => s.partnerId === partnerId)
        .map((s) => [s.currencyCode, { amount: String(s.amount), storeValue: s.storeCurrencyCode === store && s.storeValue !== null ? String(s.storeValue) : '' }])
    );
    setStandingBoxes(mine);
    setStandingError(null);
    setStandingOf(partnerId);
  };

  const submitStanding = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!standingOf) return;
    setStandingBusy(true);
    setStandingError(null);
    try {
      await apiJson('/api/finance/partners/withdrawals', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          partnerId: standingOf,
          amounts: book.currencies.map((c) => ({
            currencyCode: c.code,
            amount: (standingBoxes[c.code]?.amount ?? '').trim(),
            ...(c.code !== store ? { storeValue: (standingBoxes[c.code]?.storeValue ?? '').trim() } : {}),
          })),
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

  const columns: Column<Row>[] = [
    {
      key: 'day',
      label: 'التاريخ',
      primary: true,
      render: (r) => <RealDateCell realDate={r.realDate} createdAt={String(r.createdAt)} registeredOnAnotherDay={r.registeredOnAnotherDay} />,
    },
    {
      key: 'partner',
      label: 'الشريك',
      primary: true,
      render: (r) => (
        <>
          {r.partnerName}
          {r.wasReversed && (
            <>
              {' '}
              <Badge variant="danger">معكوس</Badge>
            </>
          )}
        </>
      ),
    },
    { key: 'wallet', label: 'المحفظة', render: (r) => r.walletName },
    {
      key: 'amount',
      label: 'المبلغ',
      render: (r) => (
        <span className={r.wasReversed ? 'line-through text-[var(--sys-muted)]' : undefined}>
          <Money value={r.amount} currency={r.currencyCode} minorUnit={r.minorUnit} />
          {r.valueInStoreCurrency !== null && r.currencyCode !== r.storeCurrency && (
            <span className="block text-note text-[var(--sys-muted)]">
              يعادل <Money value={r.valueInStoreCurrency} currency={r.storeCurrency} minorUnit={r.storeMinor} />
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'note',
      label: 'ملاحظة',
      wide: true,
      render: (r) => (r.wasReversed ? `انعكس: ${r.reversedBy?.reversalReason ?? ''}` : r.note || '—'),
    },
    { key: 'by', label: 'سجّله', render: (r) => r.createdByName ?? '—' },
    {
      key: 'act',
      label: 'إجراء',
      render: (r) => (
        <span className="flex flex-wrap items-center gap-2">
          <IconButton size="sm" label="تفاصيل الحركة" onClick={() => setDetailsId(r.id)}>
            <RiEyeLine className="w-4 h-4" />
          </IconButton>
          <Link
            href={`/finance/wallets?wallet=${encodeURIComponent(r.walletId)}&movement=${encodeURIComponent(r.id)}`}
            className="text-note font-medium text-[var(--sys-primary)] hover:underline"
          >
            افتح الحركة بالمحفظة
          </Link>
        </span>
      ),
    },
  ];

  const legacyColumns: Column<Legacy>[] = [
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
    { key: 'note', label: 'ملاحظة', wide: true, render: (r) => (r.cancelled ? `أُلغي: ${r.cancelled.reason}` : r.note || '—') },
    { key: 'by', label: 'سجّله', render: (r) => r.createdByName ?? '—' },
  ];

  const stores = [...new Set(book.byStore.map((t) => t.storeId))];
  const detail = detailsId ? book.rows.find((r) => r.id === detailsId) ?? null : null;
  const draftWallet = draft ? walletOf(draft.walletId) : null;

  return (
    <>
      <Card>
        <CardHeader
          title="المسحوبات"
          subtitle="كل مسحوب حركة صادرة من محفظة («سحب شريك»)، وهون بتشوفهم كلهم بمكان واحد. بينحسب على نصيب الشريك وما بيغيّر الربح."
        />
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <Segmented
              aria-label="الفترة"
              options={[
                { value: 'all', label: 'كل السجل' },
                { value: 'range', label: 'فترة' },
              ]}
              value={span}
              onChange={(v) => setSpan(v === 'range' ? 'range' : 'all')}
            />
            {span === 'range' && <DateRange label="حسب تاريخ الحركة" value={range} onChange={setRange} />}
          </div>
          {error && <p className={ERROR_BOX}>{error}</p>}
          {done && <p className="text-note text-[var(--sys-success)]">{done}</p>}

          {!book.mayRecord && (
            <p className="text-note text-[var(--sys-muted)]">
              تسجيل مسحوب بيطلّع مصاري من محفظة، فبدّو كمان صلاحية «تسجيل حركات الصندوق». بتقدر تشوف وتحط المبالغ الثابتة.
            </p>
          )}

          {active.length === 0 ? (
            <EmptyState
              title="ما في شركاء محفوظين"
              why="سجّل الشركاء من «قواعد المال» — بعدها بتحط لكل واحد مبلغه الثابت بكل عملة."
              action={{ label: 'افتح قواعد المال', href: '/finance/rules' }}
            />
          ) : (
            <>
              <ul className="divide-y divide-[var(--sys-border)]">
                {active.map((p) => {
                  const mine = book.standing.filter((s) => s.partnerId === p.id && book.currencies.some((c) => c.code === s.currencyCode));
                  return (
                    <li key={p.id} className="space-y-2 py-3">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span className="text-sm font-bold text-[var(--sys-heading)]">{p.name}</span>
                        <Button type="button" size="sm" variant="secondary" onClick={() => openStanding(p.id)}>
                          المبالغ الثابتة
                        </Button>
                        {book.mayRecord && (
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            disabled={book.wallets.length === 0}
                            onClick={() => {
                              setDraftError(null);
                              const first = book.wallets[0]?.id ?? '';
                              setDraft(fillDraft({ partnerId: p.id, walletId: first, amount: '', storeValue: '', note: '', fromStanding: false }, first));
                            }}
                          >
                            مبلغ تاني
                          </Button>
                        )}
                      </div>
                      {mine.length === 0 ? (
                        <p className="text-note text-[var(--sys-muted)]">ما في مبلغ ثابت — حطّه من «المبالغ الثابتة» أو سجّل «مبلغ تاني».</p>
                      ) : (
                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                          {mine.map((s) => {
                            const key = `${p.id}|${s.currencyCode}`;
                            const box = boxOf(p.id, s.currencyCode);
                            const wallets = walletsIn(s.currencyCode);
                            const other = s.currencyCode !== store;
                            const set = (patch: Partial<Box>) => setBoxes((b) => ({ ...b, [key]: { ...b[key], ...patch } }));
                            return (
                              <div key={key} className="space-y-1">
                                <div className="flex flex-wrap items-end gap-2">
                                  {book.mayRecord && (
                                    <Select
                                      label="من محفظة"
                                      value={box.walletId}
                                      onChange={(e) => set({ walletId: e.target.value })}
                                      disabled={wallets.length === 0}
                                    >
                                      {wallets.length === 0 && <option value="">ما في محفظة بـ{s.currencyCode}</option>}
                                      {wallets.map((w) => (
                                        <option key={w.id} value={w.id}>
                                          {w.name}
                                        </option>
                                      ))}
                                    </Select>
                                  )}
                                  <Input
                                    label={`المبلغ (${s.currencyCode})`}
                                    type="number"
                                    inputMode="decimal"
                                    step="any"
                                    value={box.amount}
                                    onChange={(e) => set({ amount: e.target.value })}
                                  />
                                  {other && (
                                    <Input
                                      label={`ما يعادله بعملة المتجر (${store})`}
                                      type="number"
                                      inputMode="decimal"
                                      step="any"
                                      value={box.storeValue}
                                      onChange={(e) => set({ storeValue: e.target.value })}
                                    />
                                  )}
                                  {book.mayRecord && (
                                    <Button
                                      type="button"
                                      size="sm"
                                      loading={pressing === key}
                                      disabled={!box.walletId || !box.amount.trim() || (other && !box.storeValue.trim())}
                                      onClick={() => pressStanding(p.id, s.currencyCode)}
                                    >
                                      سجّل مسحوب
                                    </Button>
                                  )}
                                </div>
                                <p className="text-note text-[var(--sys-muted)]">{FROM_STANDING_LINE}</p>
                                {book.mayRecord && wallets.length === 0 && (
                                  <p className="text-note text-[var(--sys-warning)]">ما في محفظة شغّالة بعملة {s.currencyCode} بهالمتجر — افتح وحدة من «المحافظ».</p>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader
          title="مجموع المسحوبات بهالمتجر"
          subtitle="لكل شريك بكل عملة لحالها، وجنبها كم بتساوي بعملة المتجر — هاد الرقم اللي بينحسب على نصيبه. المعكوس ما بينحسب."
        />
        <CardContent>
          {book.totals.length === 0 ? (
            <p className="text-note text-[var(--sys-muted)]">ما في مسحوبات بهالمتجر{span === 'range' ? ' بهالفترة' : ''}.</p>
          ) : (
            <ul className="divide-y divide-[var(--sys-border)]">
              {book.totals.map((t) => (
                <li key={`${t.partnerId}|${t.currencyCode}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
                  <span className="text-sm font-bold text-[var(--sys-heading)]">{t.partnerName}</span>
                  <span className="text-note text-[var(--sys-muted)] tabular-nums">{t.count} مسحوب</span>
                  <span className="ms-auto text-sm font-bold text-[var(--sys-heading)]">
                    <Money value={t.total} currency={t.currencyCode} minorUnit={t.minorUnit} />
                  </span>
                  {t.currencyCode !== store && (
                    <span className="w-full text-end text-note text-[var(--sys-muted)]">
                      يعادل <Money value={t.valueTotal} currency={store} minorUnit={book.storeCurrency.minorUnit} />
                    </span>
                  )}
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
        <CardHeader
          title="سجل المسحوبات"
          subtitle="كل مسحوب بتاريخ حركته. العين بتفتح التفاصيل، والعكس بيصير من المحفظة بقيد عكسي — والمعكوس بيضل مكتوب ومشطوب."
        />
        <CardContent className="p-0">
          {/* «سحب السجل» (F5): the same movements as this list, as Excel or a page to print, by the filters chosen here. */}
          <HistoryExport
            list="withdrawals"
            realLabel="حسب تاريخ الحركة"
            choices={[
              { key: 'partnerId', label: 'الشريك', options: book.partners.map((p) => ({ value: p.id, label: p.name })) },
              { key: 'currency', label: 'العملة', options: book.currencies.map((c) => ({ value: c.code, label: c.code })) },
            ]}
          />
          <Rows
            rows={book.rows}
            keyOf={(r) => r.id}
            columns={columns}
            empty={<EmptyState title="ما في مسحوبات بهالمتجر" why="اضغط «سجّل مسحوب» جنب مبلغ الشريك الثابت، أو «مبلغ تاني»، أو من المحفظة «سحب شريك»." />}
          />
        </CardContent>
      </Card>

      {book.legacy.length > 0 && (
        <Card>
          <CardHeader
            title="قديمة — غير مربوطة بمحفظة"
            subtitle="انسجّلت قبل ما يصير المسحوب حركة محفظة. للقراءة بس: ما بتنحسب بأي مجموع ولا على نصيب حدا، وما بتنمسح."
          />
          <CardContent className="p-0">
            {book.legacyTotals.length > 0 && (
              <ul className="divide-y divide-[var(--sys-border)] px-4">
                {book.legacyTotals.map((t) => (
                  <li key={`${t.partnerId}|${t.currencyCode}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 text-note">
                    <span className="text-[var(--sys-muted-foreground)]">{t.partnerName} — مكتوب بالسجل القديم</span>
                    <span className="ms-auto font-bold text-[var(--sys-heading)]">
                      <Money value={t.total} currency={t.currencyCode} minorUnit={t.minorUnit} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <Rows rows={book.legacy} keyOf={(r) => r.id} columns={legacyColumns} empty={null} />
          </CardContent>
        </Card>
      )}

      {/* A figure typed for this press, out of any wallet of this store; the standing figures fill it when there are some. */}
      <Modal isOpen={!!draft} onClose={() => setDraft(null)} title="مسحوب بمبلغ تاني" subtitle={`لـ${partnerName(draft?.partnerId ?? null)}`}>
        {draft && (
          <form onSubmit={submitDraft} className="space-y-4">
            <Select label="من محفظة *" value={draft.walletId} onChange={(e) => setDraft(fillDraft(draft, e.target.value))} required>
              {book.wallets.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name} ({w.currencyCode})
                </option>
              ))}
            </Select>
            <div className="grid grid-cols-2 gap-3">
              <Input
                label={`المبلغ (${draftWallet?.currencyCode ?? ''}) *`}
                type="number"
                inputMode="decimal"
                step="any"
                value={draft.amount}
                onChange={(e) => setDraft({ ...draft, amount: e.target.value, fromStanding: false })}
                required
              />
              {draftWallet && draftWallet.currencyCode !== store && (
                <Input
                  label={`ما يعادله بعملة المتجر (${store}) *`}
                  type="number"
                  inputMode="decimal"
                  step="any"
                  value={draft.storeValue}
                  onChange={(e) => setDraft({ ...draft, storeValue: e.target.value })}
                  required
                />
              )}
            </div>
            {draft.fromStanding && <p className="text-note text-[var(--sys-muted)]">{FROM_STANDING_LINE}</p>}
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

      {/* The standing amounts of one partner: one box per currency of the stores, and beside a foreign one its worth in the store's. */}
      <Modal
        isOpen={!!standingOf}
        onClose={() => setStandingOf(null)}
        title="المبالغ الثابتة"
        subtitle={`لـ${partnerName(standingOf)} — بتنكتب مرة وحدة، وبتعبّي «سجّل مسحوب» وحركة المحفظة. الخانة الفاضية بتشيل العملة.`}
      >
        <form onSubmit={submitStanding} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            {book.currencies.map((c) => (
              <React.Fragment key={c.code}>
                <Input
                  label={`${c.ar} (${c.code})`}
                  type="number"
                  inputMode="decimal"
                  step="any"
                  value={standingBoxes[c.code]?.amount ?? ''}
                  onChange={(e) => setStandingBoxes((b) => ({ ...b, [c.code]: { storeValue: b[c.code]?.storeValue ?? '', amount: e.target.value } }))}
                />
                {c.code !== store ? (
                  <Input
                    label={`ما يعادله بـ${store}`}
                    type="number"
                    inputMode="decimal"
                    step="any"
                    value={standingBoxes[c.code]?.storeValue ?? ''}
                    onChange={(e) => setStandingBoxes((b) => ({ ...b, [c.code]: { amount: b[c.code]?.amount ?? '', storeValue: e.target.value } }))}
                  />
                ) : (
                  <span className="self-end pb-2 text-note text-[var(--sys-muted)]">عملة المتجر</span>
                )}
              </React.Fragment>
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

      {detail && (
        <MovementDetails
          movement={{
            ...detail,
            direction: detail.direction === 'IN' ? 'IN' : 'OUT',
            createdAt: String(detail.createdAt),
            reversedBy: detail.reversedBy ? { ...detail.reversedBy, createdAt: String(detail.reversedBy.createdAt) } : null,
          }}
          currency={detail.currencyCode}
          minorUnit={detail.minorUnit}
          categoryLabel={MOVEMENT_CATEGORY_AR[detail.category] ?? detail.category}
          listed={new Set<string>()}
          onOpen={() => undefined}
          onClose={() => setDetailsId(null)}
        />
      )}
    </>
  );
}
