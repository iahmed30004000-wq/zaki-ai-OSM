'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Card, CardHeader, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Money } from '@/components/ui/Money';
import { apiJson } from '@/lib/api-client';
import { FAULT_AR, lossDisplayLines, type Fault, type LossLine, type LossReport } from '@/lib/loss-analysis';
import { RiAlertLine, RiLoader4Line, RiPhoneLine, RiTruckLine } from '@remixicon/react';

/**
 * WHY ORDERS DIED — in two halves, because they are two different bills.
 *
 * The dashboard showed `rejected: 41` and, beside it, which product was
 * rejected most. Neither says why, and «why» is the only part anybody can
 * do something about. The three fields holding the answer were written on
 * every order and read by no report.
 *
 * BEFORE CONFIRMATION there is no money column, on purpose. Nothing was
 * spent: no fee, no stock, no parcel. Putting a currency figure on an order
 * that never shipped would mean counting revenue we never had as a loss, and
 * the biggest number on the screen would be the one nobody could defend.
 *
 * AFTER SHIPPING every row is an invoice — the fee out, the fee back, and
 * the goods when they return damaged.
 *
 * And one line at the end that neither half can give alone: what the
 * expensive half spent on failures the cheap half exists to catch.
 *
 * «أُغلق بلا رد» IS DRAWN AS ONE ROW (the planner 15/11, answer 8): the two stored codes of the no-answer close are summed into it and listed under it, indented, with their own
 * labels and counts (`lossDisplayLines`). The payload this panel receives is untouched — two codes, as ever; a company with only one of them sees today's row.
 */

const FAULT_TINT: Record<Fault, string> = {
  OUR_DATA: 'bg-[var(--sys-destructive-soft)] text-[var(--sys-destructive)] border-[var(--sys-destructive-border)]',
  OUR_REACH: 'bg-[var(--sys-warning-soft)] text-[var(--sys-warning)] border-[var(--sys-warning)]/30',
  CUSTOMER: 'bg-[var(--sys-surface)] text-[var(--sys-muted-foreground)] border-[var(--sys-border)]',
  OUTSIDE: 'bg-[var(--sys-surface)] text-[var(--sys-muted-foreground)] border-[var(--sys-border)]',
  UNKNOWN: 'bg-[var(--sys-surface)] text-[var(--sys-muted)] border-[var(--sys-border)]',
};

// `moneyWithheld`: the server zeroed every money figure for a reader without «عرض المالية».
type Loaded = LossReport & { scanned: number; total: number; truncated: boolean; moneyWithheld?: boolean };

export function LossPanel({ period }: { period: string }) {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await apiJson<Loaded>(`/api/analytics/loss?period=${period}`));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذّر التحميل');
    }
  }, [period]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return null;
  if (!data) {
    return (
      <Card>
        <CardContent>
          <p className="flex items-center justify-center gap-2 py-8 text-sm text-[var(--sys-muted-foreground)]">
            <RiLoader4Line className="w-4 h-4 animate-spin" /> جارٍ حساب أسباب الخسارة…
          </p>
        </CardContent>
      </Card>
    );
  }

  const nothing = data.before.count === 0 && data.after.count === 0;

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <RiAlertLine className="w-4 h-4 text-[var(--sys-destructive)]" aria-hidden />
            أين نخسر الطلبات — ولماذا
          </span>
        }
        subtitle="قبل التأكيد لا تُدفع نقود: الخسارةُ مكالمات. بعد الشحن كلُّ سطرٍ فاتورة."
      />
      <CardContent className="space-y-4">
        {nothing ? (
          <EmptyState
            title="لا طلبَ خسرناه في هذه الفترة"
            why="يُقرأ هذا من سبب الرفض المُسجَّل قبل التأكيد، وسببِ فشل التوصيل أو الإرجاع بعد الشحن. فراغُه يعني أنّ لا طلبَ أُغلق بأيٍّ منها."
          />
        ) : (
          <>
            {/* ── The sentence the whole panel exists for ── */}
            {data.preventable.count > 0 && (
              <div className="rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] px-3 py-2.5">
                {data.moneyWithheld ? (
                  // The same sentence without the money, which this reader's key does not show.
                  <p className="text-sm text-[var(--sys-heading)]">
                    <b className="text-[var(--sys-destructive)]">{data.preventable.count} شحنةً</b> فشلت لسببٍ عندنا
                    — رقمٌ خاطئ، عنوانٌ لم يُعرف، موعدٌ لم يُتَّفق عليه. كلُّها كانت تُكتشف بمكالمةٍ قبل دفع أجرة المندوب.
                  </p>
                ) : (
                <p className="text-sm text-[var(--sys-heading)]">
                  <b className="text-[var(--sys-destructive)]">
                    <Money value={data.preventable.money} tone="lost" />
                  </b>{' '}
                  دُفعت على {data.preventable.count} شحنةً فشلت لسببٍ عندنا — رقمٌ خاطئ، عنوانٌ لم
                  يُعرف، موعدٌ لم يُتَّفق عليه. كلُّها كانت تُكتشف بمكالمةٍ قبل دفع أجرة المندوب.
                </p>
                )}
                {data.after.money > 0 && (
                  <p className="mt-1 text-xs text-[var(--sys-destructive)]">
                    {data.preventable.shareOfAfterMoney}% من كلفةِ ما فشل بعد الشحن.
                  </p>
                )}
              </div>
            )}

            <Half
              icon={<RiPhoneLine className="w-4 h-4 text-[var(--sys-warning)]" aria-hidden />}
              title="قبل التأكيد"
              note="لا شيء أُنفق — الطلب لم يُشحن. العددُ والنسبةُ فقط."
              half={data.before}
              withMoney={false}
            />
            <Half
              icon={<RiTruckLine className="w-4 h-4 text-[var(--sys-destructive)]" aria-hidden />}
              title="بعد الشحن"
              withMoney={!data.moneyWithheld}
              note={
                data.moneyWithheld
                  ? 'العدد والسبب — كلفتها (الأجرة والبضاعة) بمفتاح «عرض المالية».'
                  : 'أجرةُ الذهاب + أجرةُ الإرجاع + البضاعةُ إن رجعت تالفة.'
              }
              half={data.after}
            />

            {data.truncated && (
              <p className="text-xs text-[var(--sys-warning)]">
                قُرئ {data.scanned} من {data.total} طلباً — الفترةُ أوسع من أن تُقرأ دفعةً واحدة، فضيّقها.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * THE CELLS OF ONE LINE — the reason, whose defect it is, how many, and where money is shown what it cost: a fragment, so they are the `li`'s own children, as they always were.
 * A detail line (one of the two codes under «أُغلق بلا رد») is the same cells, quieter, without the fault tag its row above already carries.
 */
function LossCells({ line: l, withMoney, detail = false }: { line: LossLine; withMoney: boolean; detail?: boolean }) {
  return (
    <>
      <span
        className={`${detail ? 'text-xs text-[var(--sys-muted-foreground)]' : 'text-sm text-[var(--sys-heading)]'} min-w-0 flex-1 truncate`}
        title={l.label}
      >
        {l.label}
      </span>
      {!detail && (
        <span className={`shrink-0 text-xs px-2 py-0.5 rounded-md border ${FAULT_TINT[l.fault]}`}>
          {FAULT_AR[l.fault]}
        </span>
      )}
      <span className="tabular-nums shrink-0 text-xs text-[var(--sys-muted-foreground)]">
        {l.count} · {l.share}%
      </span>
      {withMoney && (
        <span className={`tabular-nums shrink-0 ${detail ? 'text-xs' : 'text-sm font-semibold'} text-[var(--sys-destructive)] w-20 text-end`}>
          {l.money > 0 ? <Money value={l.money} tone="lost" /> : '—'}
        </span>
      )}
    </>
  );
}

function Half({
  icon,
  title,
  note,
  half,
  withMoney,
}: {
  icon: React.ReactNode;
  title: string;
  note: string;
  half: LossReport['before'];
  withMoney: boolean;
}) {
  if (half.count === 0) return null;
  return (
    <section className="space-y-2">
      <header className="flex flex-wrap items-baseline gap-2">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-[var(--sys-heading)]">
          {icon}
          {title}
        </span>
        <span className="tabular-nums text-sm font-bold text-[var(--sys-heading)]">{half.count}</span>
        {withMoney && half.money > 0 && (
          <span className="text-sm font-bold text-[var(--sys-destructive)]">
            <Money value={half.money} tone="lost" />
          </span>
        )}
        <span className="text-xs text-[var(--sys-muted-foreground)]">{note}</span>
      </header>

      <ul className="rounded-lg border border-[var(--sys-border)] divide-y divide-[var(--sys-border)]">
        {/* «أُغلق بلا رد» is ONE row with the two stored codes under it (`lossDisplayLines`) — a display only: the payload above still holds two. */}
        {lossDisplayLines(half).map((l) => (
          // A plain line is the very `li` it always was (the cells are its direct children); only the merged row carries the two codes under it, on a line of their own.
          <li key={`${l.field}:${l.reason}`} className="flex flex-wrap items-center gap-2 px-3 py-2">
            <LossCells line={l} withMoney={withMoney} />
            {l.detail && (
              <ul className="basis-full space-y-1 ps-5" aria-label={`تفصيل «${l.label}»`}>
                {l.detail.map((d) => (
                  <li key={`${d.field}:${d.reason}`} className="flex flex-wrap items-center gap-2">
                    <LossCells line={d} withMoney={withMoney} detail />
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>

      {/*
        WHAT WAS STORED THAT WE DO NOT UNDERSTAND.
        Said out loud with its count. A report that folds unrecognised values
        into «أخرى» claims to have read them.
      */}
      {half.unclassified.count > 0 && (
        <p className="text-xs text-[var(--sys-muted-foreground)]">
          منها {half.unclassified.count} بسببٍ غيرِ مُصنَّف — نصٌّ حرّ لا ينتمي إلى أيّ قائمة. يُعَدّ
          ولا يُجمع مع «أخرى»، ونصُّه نفسه على الطلب وفي شاشة المرتجعات.
        </p>
      )}
    </section>
  );
}
