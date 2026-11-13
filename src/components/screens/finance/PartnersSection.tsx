'use client';

import React, { useCallback, useState } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { Money } from '@/components/ui/Money';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Rows, type Column } from '@/components/ui/Rows';
import { EmptyState } from '@/components/ui/EmptyState';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { useApp } from '@/context/AppContext';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { apiJson } from '@/lib/api-client';
import { userCan } from '@/lib/can';
import { arDateTime } from '@/lib/format';
import type { PartnerDrawRow, PartnerStatement, StatementLine } from '@/lib/partner-statement-core';

/**
 * «الشركاء» — EACH PARTNER'S SHARE OF THE NET PROFIT, WHAT HE HAS DRAWN, AND «مكسور عليه» (13/11), under the profit it divides.
 *
 * «الربح لازم يتم توزيعه وفق هاي النسب — الربح الصافي انا بحكي … اذا حد تجاوز نسبة سحبة نسبة الربح بينعد مكسور عليه» (the owner).
 *
 * THE FIGURES ARE THE SERVER'S. The share, the balance and «مكسور عليه» come from `GET /api/finance/partners/statement`
 * (`lib/partner-statement.ts`), which cuts them from the very number the profit screen prints under «صافي الربح»; nothing here
 * adds, divides or compares money. The net profit that was divided is printed on the section itself, so what each share is a share
 * OF is never a guess. Drawn only for who holds `finance.partners`; the screen asks for nothing otherwise.
 *
 * NO PERIOD, BECAUSE THE SCREEN HAS NONE: «صافي الربح» above is since the beginning, so every column is since the beginning, and an
 * over-draw carries forward by construction. The shares are today's shares for all history — the section says so in its subtitle.
 *
 * «مكسور عليه» IS A COUNT, NOT A REFUSAL: a red chip with the amount beside the partner, and nothing is blocked anywhere.
 * «عكس» on a draw uses the wallet's own reversal door (the cash box's key, and the partners' key for this kind).
 */

/** The decimals a figure needs: the currency's own, and never fewer than the figure has. */
const digitsFor = (floor: number, value: number) => Math.min(6, Math.max(floor, (String(value).split('.')[1] ?? '').length));

export function PartnersSection() {
  const { currentUser } = useApp();
  const mayReverse = userCan(currentUser, 'finance.cashbox') && userCan(currentUser, 'finance.partners');
  const [statement, setStatement] = useState<PartnerStatement | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const answer = await apiJson<PartnerStatement>('/api/finance/partners/statement');
      // An answer that is not a statement is a failure to say so — never a crash of the profit screen it sits on (the screen has
      // died once already on a figure that was not the shape it read: see `profit-summary.test.ts`).
      if (!answer || !Array.isArray(answer.lines) || !Array.isArray(answer.draws) || !answer.trust || !answer.totals) throw new Error('not a statement');
      setStatement(answer);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);
  // A screen left open stays true: it reads again when the person comes back to it (and on first open).
  useLiveRefresh(load);

  const [reversing, setReversing] = useState<PartnerDrawRow | null>(null);
  const [reason, setReason] = useState('');
  const [reverseError, setReverseError] = useState<string | null>(null);
  const [reverseBusy, setReverseBusy] = useState(false);

  const reverse = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reversing) return;
    setReverseBusy(true);
    setReverseError(null);
    try {
      await apiJson(`/api/finance/wallets/${reversing.walletId}/movements`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ movementId: reversing.id, reason: reason.trim() }),
      });
      setReversing(null);
      setReason('');
      await load();
    } catch (err) {
      setReverseError(err instanceof Error ? err.message : 'تعذّر عكس السحب');
    } finally {
      setReverseBusy(false);
    }
  };

  if (failed && !statement) {
    return (
      <Card>
        <CardHeader title="الشركاء" />
        <CardContent>
          <p className="text-xs text-[var(--sys-destructive)]">تعذّر تحميل حساب الشركاء — حدّث الصفحة وجرّب من جديد.</p>
        </CardContent>
      </Card>
    );
  }
  if (!statement) {
    return (
      <Card>
        <CardHeader title="الشركاء" />
        <CardContent>
          <SkeletonRows rows={4} />
        </CardContent>
      </Card>
    );
  }

  const { currency, minorUnit } = statement;
  const money = (value: number | null) => (value === null ? '—' : <Money value={value} currency={currency} minorUnit={minorUnit} />);

  const columns: Column<StatementLine>[] = [
    {
      key: 'name',
      label: 'الشريك',
      primary: true,
      render: (l) => (
        <>
          {l.name}
          {!l.isActive && (
            <>
              {' '}
              <Badge variant="outline">موقوف</Badge>
            </>
          )}
        </>
      ),
    },
    { key: 'share', label: 'النسبة', render: (l) => <span className="tabular-nums">{l.sharePercent}%</span> },
    { key: 'entitlement', label: 'نصيبه من الصافي', render: (l) => money(l.entitlement) },
    { key: 'draws', label: 'سحوباته', render: (l) => money(l.draws) },
    {
      key: 'balance',
      label: 'الرصيد',
      render: (l) =>
        l.balance === null ? '—' : <Money value={l.balance} currency={currency} minorUnit={minorUnit} tone={l.balance < 0 ? 'lost' : undefined} />,
    },
    {
      key: 'broken',
      label: 'مكسور عليه',
      primary: true,
      render: (l) =>
        l.broken === null ? (
          '—'
        ) : l.broken > 0 ? (
          <Badge variant="danger">
            مكسور عليه <Money value={l.broken} currency={currency} minorUnit={minorUnit} />
          </Badge>
        ) : (
          '—'
        ),
    },
  ];

  const drawColumns: Column<PartnerDrawRow>[] = [
    { key: 'date', label: 'التاريخ', primary: true, render: (d) => arDateTime(d.createdAt) },
    {
      key: 'partner',
      label: 'الشريك',
      primary: true,
      render: (d) => (
        <>
          {d.partnerName}
          {d.reversed && (
            <>
              {' '}
              <Badge variant="danger">معكوس</Badge>
            </>
          )}
        </>
      ),
    },
    {
      key: 'amount',
      label: 'المبلغ',
      render: (d) => <Money value={d.amount} currency={d.currencyCode} minorUnit={digitsFor(d.currencyCode === currency ? minorUnit : 2, d.amount)} />,
    },
    {
      key: 'value',
      label: 'يعادل بعملة المتجر',
      render: (d) =>
        d.currencyCode === currency || d.valueInStoreCurrency === null ? (
          '—'
        ) : (
          <Money value={d.valueInStoreCurrency} currency={currency} minorUnit={digitsFor(minorUnit, d.valueInStoreCurrency)} />
        ),
    },
    { key: 'wallet', label: 'المحفظة', render: (d) => d.walletName },
    { key: 'note', label: 'الملاحظة', wide: true, render: (d) => d.note || '—' },
    { key: 'by', label: 'سجّلها', render: (d) => d.createdByName ?? '—' },
    {
      key: 'act',
      label: 'إجراء',
      render: (d) =>
        mayReverse && !d.reversed ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setReverseError(null);
              setReversing(d);
            }}
          >
            عكس
          </Button>
        ) : null,
    },
  ];

  return (
    <>
      <Card>
        <CardHeader
          title="الشركاء"
          subtitle="نصيب كل شريك من صافي الربح، وسحوباته، والرصيد. اللي بيسحب فوق نصيبه بيتسجّل «مكسور عليه» — بيتنعدّ وبيتحمل للقادم وما بينمنع. كل الأرقام من البداية، والنسب هي نسب اليوم على كل التاريخ."
        />
        <CardContent className="p-0">
          <div className="space-y-2 border-b border-[var(--sys-border)] px-5 py-3 text-xs text-[var(--sys-muted-foreground)]">
            <p>
              صافي الربح الموزَّع: <Money value={statement.netProfit} currency={currency} minorUnit={minorUnit} className="font-bold text-[var(--sys-heading)]" />
              {statement.netProfit <= 0 && ' — ما في ربح للتوزيع، فنصيب الكل صفر.'}
            </p>
            {statement.trust.level !== 'STATED' && (
              <p className="text-[var(--sys-warning)]">{statement.trust.ar} — فالتوزيع على رقم ناقص.</p>
            )}
            {statement.uncounted > 0 && (
              <p className="text-[var(--sys-warning)]">
                في {statement.uncounted} سحب بلا قيمة بعملة المتجر أو بلا شريك — ما انحسب على حدا.
              </p>
            )}
          </div>

          {statement.state === 'NO_PARTNERS' ? (
            <EmptyState
              title="ما في شركاء محفوظين"
              why="سجّل الشركاء ونسبهم من «إعدادات النظام» — بعدها بيتوزّع الصافي عليهم وبتنحسب سحوباتهم."
              action={{ label: 'افتح إعدادات النظام', href: '/settings/system' }}
            />
          ) : (
            <>
              {statement.state === 'SHARES_NOT_100' && (
                <p className="border-b border-[var(--sys-border)] px-5 py-3 text-xs text-[var(--sys-destructive)]">
                  مجموع نسب الشركاء الفعّالين {statement.sharesTotal} مش 100 — ما انقسم شي. عدّلها من «إعدادات النظام».
                </p>
              )}
              <Rows rows={statement.lines} keyOf={(l) => l.id} columns={columns} />
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-[var(--sys-border)] px-5 py-3 text-xs text-[var(--sys-muted-foreground)]">
                <span>المجموع</span>
                <span>نصيب: {money(statement.totals.entitlement)}</span>
                <span>سحوبات: {money(statement.totals.draws)}</span>
                <span>مكسور عليه: {money(statement.totals.broken)}</span>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader
          title="سحوبات الشركاء"
          subtitle="كل سحب بتاريخه ومحفظته. «عكس» بيرجّع المبلغ للمحفظة وبيشيله من حساب الشريك، وبيضل السطر مكتوب «معكوس»."
        />
        <CardContent className="p-0">
          <Rows
            rows={statement.draws}
            keyOf={(d) => d.id}
            columns={drawColumns}
            empty={
              <EmptyState
                title="ما في سحوبات مسجَّلة"
                why="السحب بيتسجّل من «حركة جديدة» بشاشة المحافظ، بند «سحب شريك»."
              />
            }
          />
        </CardContent>
      </Card>

      {/* Taking a draw back: the money returns to its wallet, and the draw leaves the partner's account. */}
      <Modal
        isOpen={!!reversing}
        onClose={() => setReversing(null)}
        title="عكس سحب شريك"
        subtitle="بيرجع المبلغ لمحفظته وبيطلع من حساب الشريك — وبيضل السحب مكتوب «معكوس»"
      >
        <form onSubmit={reverse} className="space-y-4">
          <p className="text-sm text-[var(--sys-heading)]">
            {reversing?.partnerName} — {reversing && <Money value={reversing.amount} currency={reversing.currencyCode} minorUnit={digitsFor(2, reversing.amount)} />}
          </p>
          <Textarea label="سبب العكس *" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} required minLength={5} />
          {reverseError && (
            <p className="rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] p-2.5 text-xs text-[var(--sys-destructive)]">
              {reverseError}
            </p>
          )}
          <div className="flex justify-end space-x-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setReversing(null)}>
              تراجع
            </Button>
            <Button type="submit" variant="danger" loading={reverseBusy} disabled={reason.trim().length < 5}>
              اعكس السحب
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
