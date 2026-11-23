'use client';

import React, { useCallback, useState } from 'react';
import Link from 'next/link';
import { RiEyeLine } from '@remixicon/react';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { Money } from '@/components/ui/Money';
import { Badge } from '@/components/ui/Badge';
import { IconButton } from '@/components/ui/IconButton';
import { Rows, type Column } from '@/components/ui/Rows';
import { EmptyState } from '@/components/ui/EmptyState';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { Segmented } from '@/components/ui/Segmented';
import { DateRange, initialRange, type Range } from '@/components/ui/DateRange';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { apiJson } from '@/lib/api-client';
import { arDate } from '@/lib/format';
import { MOVEMENT_CATEGORY_AR } from '@/lib/movement-category-words';
import type { WithdrawalsBook } from '@/lib/partner-withdrawals';
import { HistoryExport } from './HistoryExport';
import { MovementDetails, RealDateCell } from './RealDateDetails';

/**
 * «المسحوبات» — ONE PLACE TO READ THE PARTNERS' WITHDRAWALS, WHICH ARE WALLET MOVEMENTS (23/11, F7). READ-ONLY.
 *
 * «والحركات تكون من المحافظ، وآخر شي تكون زي داشبورد للشركاء والسحوبات… ما بدي الحركات المالية بكل مكان، خلص مكان واحد» — and
 * «السحوبات الأساسية بتتسجّل سحب من المحفظة بالعملة. مثال أحمد سحب 1000 USDT و1000 دينار و1000 ليرة وهكذا، بدون ما يجيني سعر الصرف»
 * (the owner). A withdrawal is recorded in ONE place: the wallet («حركة جديدة» ← «سحب شريك»), in the wallet's own currency. This tab
 * only reads them: per partner PER CURRENCY (never summed across currencies), per store, over a span on the real date, with the eye
 * and a way to the movement in its wallet. A reversed draw is struck through and counted nowhere — it is reversed at its wallet.
 *
 * Every figure is the server's (`GET /api/finance/partners/withdrawals`). Nothing here writes.
 */

type Row = WithdrawalsBook['rows'][number];
type Legacy = WithdrawalsBook['legacy'][number];

/** Said beside a currency whose draws carry no worth in the store's currency: they are not in the partner's share yet. */
export const UNVALUED_LINE = 'سحوبات بعملة تانية — لا تدخل بحساب نصيب الشريك بالدولار بعد';

export function WithdrawalsSection() {
  const [book, setBook] = useState<WithdrawalsBook | null>(null);
  const [failed, setFailed] = useState(false);
  const [span, setSpan] = useState<'all' | 'range'>('all');
  const [range, setRange] = useState<Range>(() => initialRange('30d'));
  const [detailsId, setDetailsId] = useState<string | null>(null);

  const query = span === 'range' ? `?from=${range.from}&to=${range.to}` : '';
  const load = useCallback(async () => {
    try {
      const answer = await apiJson<WithdrawalsBook>(`/api/finance/partners/withdrawals${query}`);
      if (!answer || !Array.isArray(answer.partners) || !Array.isArray(answer.rows) || !Array.isArray(answer.totals)) throw new Error('not a book');
      setBook(answer);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [query]);
  // A new span is a new question: the key makes the hook ask it (the load itself is read through its ref).
  useLiveRefresh(load, { key: query });

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

  return (
    <>
      <Card>
        <CardHeader
          title="المسحوبات"
          subtitle="كل مسحوب حركة صادرة من محفظة («سحب شريك») بعملة المحفظة، وهون بتشوفهم كلهم بمكان واحد. التسجيل من المحفظة بس."
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
          <p className="text-note text-[var(--sys-muted)]">
            لتسجيل مسحوب: افتح{' '}
            <Link href="/finance/wallets" className="font-medium text-[var(--sys-primary)] hover:underline">
              المحافظ
            </Link>{' '}
            ← «حركة جديدة» ← «سحب شريك».
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader
          title="مجموع المسحوبات بهالمتجر"
          subtitle="لكل شريك بكل عملة لحالها — العملات ما بتنجمع مع بعض. المعكوس ما بينحسب."
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
                  {t.currencyCode !== store && t.valueCount > 0 && (
                    <span className="w-full text-end text-note text-[var(--sys-muted)]">
                      منها {t.valueCount} مكتوب جنبها ما يعادلها: <Money value={t.valueTotal} currency={store} minorUnit={book.storeCurrency.minorUnit} />
                    </span>
                  )}
                  {t.unvaluedCount > 0 && (
                    <span className="w-full text-end text-note text-[var(--sys-warning)]">
                      {UNVALUED_LINE} (<Money value={t.unvaluedTotal} currency={t.currencyCode} minorUnit={t.minorUnit} />)
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
            empty={<EmptyState title="ما في مسحوبات بهالمتجر" why="المسحوب بينسجّل من المحفظة: «حركة جديدة» ← «سحب شريك»." />}
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
