'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { apiJson } from '@/lib/api-client';
import { RiEyeLine, RiInformationLine, RiLoader4Line, RiPercentLine, RiShoppingBagLine, RiTrophyLine } from '@remixicon/react';
import { Rows } from '@/components/ui/Rows';
import { MIN_DELIVERED, MIN_VISITORS, type Verdict } from '@/lib/page-verdict';

/**
 * تحليلات صفحات الهبوط — for the screen's one date window.
 *
 * Views, orders and the rate between them; per page, per device and per
 * campaign. This used to be a table in settings showing lifetime totals of
 * the eight newest pages, under a link to "full analytics" that led here to
 * nothing. Setup is in settings; reading is here.
 */

interface Row {
  key: string;
  label: string;
  hint?: string;
  views: number;
  orders: number;
  conversion: number | null;
}

interface Data {
  countingSince: string | null;
  totals: Row;
  byPage: Row[];
  byDevice: Row[];
  byCampaign: Row[];
  /** One per product that has more than one page — see `pageVerdicts`. */
  verdicts?: { productId: string; productName: string; pages: number; verdict: Verdict }[];
  /** The server's count beside the browser's, for the week before the page is cached — see `CountCheck`. */
  countCheck: CountCheckData | null;
}

interface CountCheckData {
  since: string;
  server: number;
  browser: number;
  byPage: { key: string; label: string; server: number; browser: number }[];
}

export function LandingAnalyticsTab({ dateQuery, from }: { dateQuery: string; from: string }) {
  const [data, setData] = useState<Data | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setData(null);
    setFailed(false);
    apiJson<Data>(`/api/growth/landing-analytics?${dateQuery}`)
      .then(setData)
      .catch(() => setFailed(true));
  }, [dateQuery]);

  if (failed) {
    return <p className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] p-6 text-center text-xs text-[var(--sys-muted-foreground)]">تعذّر تحميل التحليلات.</p>;
  }
  if (!data) {
    return (
      <div className="flex h-40 items-center justify-center text-[var(--sys-muted-foreground)]">
        <RiLoader4Line className="h-4 w-4 animate-spin" />
      </div>
    );
  }

  // Views began to be counted by day on the day this shipped. A window that
  // reaches back further — or has no start at all — shows its orders but not
  // the views behind them.
  const partial = !data.countingSince || !from || data.countingSince > from;

  return (
    <div className="space-y-4" dir="rtl">
      <div className="grid grid-cols-3 gap-3">
        <Tile icon={<RiEyeLine className="h-4 w-4" />} label="المشاهدات" value={fmt(data.totals.views)} />
        <Tile icon={<RiShoppingBagLine className="h-4 w-4" />} label="الطلبات" value={fmt(data.totals.orders)} />
        <Tile icon={<RiPercentLine className="h-4 w-4" />} label="نسبة التحويل" value={pct(data.totals.conversion)} />
      </div>

      {partial && (
        <p className="flex items-start gap-1.5 rounded-lg bg-[var(--sys-surface-strong)] px-3 py-2 text-xs leading-relaxed text-[var(--sys-foreground)]">
          <RiInformationLine className="mt-0.5 h-4 w-4 shrink-0" />
          {data.countingSince
            ? `المشاهدات تُعدّ يومياً منذ ${data.countingSince}. عمود الطلبات يشمل المدة كلها، أما نسبة التحويل فتُحسب من طلبات الأيام التي عُدّت فيها المشاهدات فقط.`
            : 'لم تُسجَّل مشاهدات بعد — تُعدّ من أول زيارة لصفحة منشورة. الطلبات تظهر من الآن.'}
        </p>
      )}

      <Table title="حسب الصفحة" rows={data.byPage} empty="لا زيارات ولا طلبات من صفحات الهبوط في هذه المدة." linkPages />

      {data.countCheck && <CountCheckBlock check={data.countCheck} />}

      {/*
        THE VERDICT BETWEEN TWO PAGES FOR ONE PRODUCT.

        It was computed and reachable by nobody: `pageVerdict` shipped with
        its floors, its margin and its refusals, and no screen asked it
        anything. Here, under the per-page table, because the question
        «أيُّهما غلب» is the one a seller has while reading that table.

        AND IT IS A SENTENCE, NOT A SWITCH. «النظام بيقترح الفائز مع حجم
        العيّنة — ما بيطفّي الخاسر لحاله»: there is no button in this block,
        and the module behind it has no way to turn a page off.
      */}
      {data.verdicts !== undefined && data.verdicts.length > 0 && (
        <section className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)]">
          <h3 className="border-b border-[var(--sys-surface-strong)] px-4 py-2.5 text-sm font-bold text-[var(--sys-heading)]">
            <RiTrophyLine className="me-1 inline h-4 w-4" />
            المقارنة بين نسخ الصفحة
          </h3>
          <div className="divide-y divide-[var(--sys-surface-strong)]">
            {data.verdicts.map((v) => (
              <VerdictBlock key={v.productId} {...v} />
            ))}
          </div>
          <p className="border-t border-[var(--sys-surface-strong)] px-4 py-2.5 text-xs leading-relaxed text-[var(--sys-muted)]">
            المقياس: طلبات مُسلَّمة ومحصَّلة لكل 100 زائر — لا عدد النماذج المرسلة. صفحةٌ تجمع نماذج كثيرة
            وترتجع كثيراً خاسرة، وأجرةُ المندوب تُدفع في الاتجاهين. هذا اقتراحٌ مع حجم العيّنة، ولا يُطفئ
            النظامُ أيَّ صفحة من تلقاء نفسه.
          </p>
        </section>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <Table title="حسب الجهاز" rows={data.byDevice} empty="لا بيانات." />
        <Table title="حسب الحملة" rows={data.byCampaign} empty="لا حملات لها زيارات أو طلبات في هذه المدة." />
      </div>
      <p className="text-xs leading-relaxed text-[var(--sys-muted)]">
        المشاهدة زيارة حقيقية لصفحة منشورة — المعاينة من لوحة التحكم وروابط المعاينة في المحادثات لا تُعدّ. الطلب
        كل طلب جاء من صفحة هبوط خلال المدة، والحملة من رمز ?c= في رابطها.
      </p>
    </div>
  );
}

/**
 * «العدّ بالطريقتين» — THE WEEK OF COMPARISON THE OWNER ASKED FOR.
 *
 * The server counts a visit when it builds the page; the browser counts it when the page opens. A cached page is not
 * built per visit, so before it is switched on both counts run side by side and this block shows them over the same
 * days. A sentence and two numbers per page — no button: switching is the owner's decision, made outside this screen.
 */
function CountCheckBlock({ check }: { check: CountCheckData }) {
  const diff = (server: number, browser: number) =>
    server > 0 ? `${browser >= server ? '+' : ''}${Math.round(((browser - server) / server) * 100)}٪` : '—';
  return (
    <section className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)]">
      <h3 className="border-b border-[var(--sys-surface-strong)] px-4 py-2.5 text-sm font-bold text-[var(--sys-heading)]">
        <RiEyeLine className="me-1 inline h-4 w-4" />
        تجربة العدّ: السيرفر مقابل المتصفح
      </h3>
      <p className="px-4 py-2.5 text-xs leading-relaxed text-[var(--sys-foreground)]">
        من {check.since}: السيرفر عدّ {fmt(check.server)} زيارة، والمتصفح {fmt(check.browser)} — الفرق {diff(check.server, check.browser)}.
      </p>
      <div className="divide-y divide-[var(--sys-surface-strong)]">
        {check.byPage.map((r) => (
          <div key={r.key} className="flex items-center justify-between gap-2 px-4 py-2.5 text-xs">
            <span className="truncate text-[var(--sys-heading)]">{r.label}</span>
            <span className="shrink-0 tabular-nums text-[var(--sys-muted-foreground)]" dir="ltr">
              {fmt(r.server)} · {fmt(r.browser)} · {diff(r.server, r.browser)}
            </span>
          </div>
        ))}
      </div>
      <p className="border-t border-[var(--sys-surface-strong)] px-4 py-2.5 text-xs leading-relaxed text-[var(--sys-muted)]">
        السيرفر يعدّ الزيارة حين يبني الصفحة، والمتصفح حين تُفتح عند الزائر. المتصفح لا يعدّ التحميل المسبق من ميتا
        ولا الروبوتات، فمن الطبيعي أن يكون أقلّ قليلاً. الطلبات والمال لا يتأثران بأيٍّ منهما. بعد أسبوع تقرّر إن
        كنّا ننتقل إلى الكاش.
      </p>
    </section>
  );
}

/**
 * ONE PRODUCT'S PAGES, RANKED — OR WHAT THEY ARE STILL SHORT OF.
 *
 * The two shapes `pageVerdict` answers in are drawn as two different
 * things on purpose. A ranking with «العيّنة صغيرة» written underneath
 * would be read as a ranking; a refusal has to look like a refusal.
 */
function VerdictBlock({
  productName,
  pages,
  verdict,
}: {
  productName: string;
  pages: number;
  verdict: Verdict;
}) {
  return (
    <div className="px-4 py-3">
      <p className="text-xs font-bold text-[var(--sys-heading)]">
        {productName} <span className="font-normal text-[var(--sys-muted)]">· {pages} صفحات</span>
      </p>

      {!verdict.ok ? (
        <p className="mt-1 text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
          لا حكم بعد. المطلوب لكل نسخة {fmt(MIN_VISITORS)} زائر و{fmt(MIN_DELIVERED)} طلبات مُسلَّمة، وما
          زال ينقص:{' '}
          {verdict.waiting
            .map((w) =>
              [
                w.needVisitors > 0 ? `${fmt(w.needVisitors)} زائر` : null,
                w.needDelivered > 0 ? `${fmt(w.needDelivered)} مُسلَّم` : null,
              ]
                .filter(Boolean)
                .join(' و')
            )
            .filter(Boolean)
            .join(' · ')}
        </p>
      ) : (
        <>
          <p className="mt-1 text-xs font-semibold text-[var(--sys-foreground)]">
            {verdict.tooClose
              ? 'الفرق بينهما أصغر من أن يُسمّى فائزاً — اتركهما تعملان.'
              : `المقترَح: «${verdict.ranked.find((r) => r.pageId === verdict.winner)?.label ?? ''}»`}
          </p>
          <div className="mt-1.5 space-y-1">
            {verdict.ranked.map((r) => (
              <div key={r.pageId} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
                <span
                  className={
                    r.pageId === verdict.winner
                      ? 'font-bold text-[var(--sys-primary)]'
                      : 'text-[var(--sys-foreground)]'
                  }
                >
                  {r.label}
                </span>
                <span className="tabular-nums text-[var(--sys-heading)]" dir="ltr">
                  {r.collectedPer100.toFixed(1)}
                </span>
                <span className="text-[var(--sys-muted)]">محصَّل لكل 100 زائر</span>
                {/* The two rates separately: they fail in opposite directions
                    and a blended number hides which one is wrong. */}
                <span className="text-[var(--sys-muted)]">
                  · تحويل {pct(r.conversionRate === null ? null : Math.round(r.conversionRate * 1000) / 10)} · تسليم{' '}
                  {pct(r.deliveryRate === null ? null : Math.round(r.deliveryRate * 1000) / 10)}
                </span>
                {/* The sample travels with the verdict so a person can judge
                    it — this is not a significance test and does not pretend
                    to be one. */}
                <span className="text-[var(--sys-muted)]">
                  · من {fmt(r.visitors)} زائر و{fmt(r.delivered)} مُسلَّم
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Tile({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] p-3">
      <p className="flex items-center gap-1 text-xs font-semibold text-[var(--sys-muted-foreground)]">{icon}{label}</p>
      <p className="mt-1 text-xl font-black tabular-nums text-[var(--sys-heading)]" dir="ltr">{value}</p>
    </div>
  );
}

function Table({ title, rows, empty, linkPages }: { title: string; rows: Row[]; empty: string; linkPages?: boolean }) {
  return (
    <section className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)]">
      <h3 className="border-b border-[var(--sys-surface-strong)] px-4 py-2.5 text-sm font-bold text-[var(--sys-heading)]">{title}</h3>
      {rows.length === 0 || rows.every((r) => !r.views && !r.orders) ? (
        <p className="p-4 text-center text-xs text-[var(--sys-muted)]">{empty}</p>
      ) : (
        <div className="overflow-x-auto">
                    <Rows
            rows={rows}
            keyOf={(r) => r.key}
            columns={[
              { key: 'c0', label: "الاسم", primary: true,
                render: (r) => (
                  <><span className="font-semibold text-[var(--sys-heading)]">
                      {linkPages && r.hint?.startsWith('/lp/') ? (
                        <Link href={r.hint} target="_blank" className="hover:text-[var(--sys-primary)] hover:underline">{r.label}</Link>
                      ) : r.label}
                    </span>
                    {r.hint && !r.hint.startsWith('/lp/') && (
                      <span className="ms-1.5 text-xs text-[var(--sys-muted)]" dir={r.hint.startsWith('?') ? 'ltr' : undefined}>{r.hint}</span>
                    )}</>
                ) },
              { key: 'c1', label: "مشاهدات", primary: true, align: 'end',
                render: (r) => (fmt(r.views)) },
              { key: 'c2', label: "طلبات", align: 'end',
                render: (r) => (fmt(r.orders)) },
              { key: 'c3', label: "التحويل", align: 'end',
                render: (r) => (pct(r.conversion)) },
            ]}
          />
        </div>
      )}
    </section>
  );
}

const fmt = (n: number) => n.toLocaleString('en-US');
const pct = (n: number | null) => (n === null ? '—' : `${n}%`);
