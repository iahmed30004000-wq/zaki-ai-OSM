'use client';

import React, { useState, useEffect } from 'react';
import { Card, CardHeader, CardContent } from '@/components/ui/Card';
import { useApp } from '@/context/AppContext';
import { apiFetch, apiJson, saidBy } from '@/lib/api-client';
import { EmptyState } from '@/components/ui/EmptyState';
import { DateRange } from '@/components/ui/DateRange';
import { TeamPerformanceTable } from '@/components/performance/TeamPerformanceTable';
import { AttributionTable, type AttributionRow } from '@/components/performance/AttributionTable';
import { LandingAnalyticsTab } from '@/components/performance/LandingAnalyticsTab';
import { userCan } from '@/lib/can';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { ScoreBoard } from '@/components/performance/ScoreBoard';
import { findRoute, routeLabel } from '@/lib/route-registry';
import { RiAlertLine, RiCopperCoinLine, RiEBike2Line, RiInboxUnarchiveLine, RiTrophyLine, RiTruckLine } from '@remixicon/react';
import { Money } from '@/components/ui/Money';
import { PageHeader } from '@/components/ui/PageHeader';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { Rows } from '@/components/ui/Rows';
import { healthOf } from '@/lib/health';
import { HealthChip } from '@/components/ui/HealthChip';
import { BackToDashboardLink } from '@/components/dashboard/DetailsLinks';
import { ChannelScoresSection } from '@/components/growth/ChannelScores';
import type { CourierScore } from '@/lib/couriers/score';
import { rowCostStated, type Trust } from '@/lib/cod-vitals';

/** The last thirty days, which is what "how are we doing" nearly always means. */
function lastThirtyDays() {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 29);
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { from: iso(from), to: iso(to) };
}

type Tab = 'team' | 'landing' | 'scores';

/** One courier as `/api/orders/shipping/performance` answers it. */
interface CourierRow {
  provider: { id: string; name: string; code?: string; kind?: string; isActive?: boolean };
  metrics: {
    assigned: number;
    shipped: number;
    delivered: number;
    failed: number;
    returned: number;
    settled: number;
    successRate: number | null;
    failureRate: number | null;
    returnRate: number | null;
    avgDeliveryHours: number | null;
  };
  score: CourierScore;
  whyNoScore: string | null;
}

/**
 * BEST FIRST, AND THE UNMEASURED ONES LAST RATHER THAN WORST.
 *
 * A courier with no finished parcels has no score, and sorting `null` as a
 * zero would rank a courier nobody has tried below one that fails half its
 * parcels — which is the opposite of true. They go to the end, in their own
 * arrival order, and are drawn with «—» instead of a rank.
 */
function rankCouriers(rows: readonly CourierRow[]): CourierRow[] {
  return [...rows].sort((a, b) => {
    if (a.score.total === null && b.score.total === null) return 0;
    if (a.score.total === null) return 1;
    if (b.score.total === null) return -1;
    return b.score.total - a.score.total;
  });
}

export function PerformanceScreen() {
  const { t, currentUser } = useApp();
  // Two readings of the same window: who did the work, and what the landing
  // pages brought. The second is marketing data and needs its own
  // permission; the tab is simply absent without it (the API refuses too).
  const canLanding = userCan(currentUser, 'landing_pages.view');
  // The score board is its own decision: these are people's numbers, not
  // the shop's, and the key that opens the reports does not open them.
  const canScores = userCan(currentUser, 'team.monitor');
  // The money columns and «الأكثر ربحاً»: the finance key's, as the server now sends them.
  const canFinance = userCan(currentUser, 'finance.view');
  /** The four headlines, the per-product return columns and the channel scores are smart cards (PR-10). */
  const canInsights = userCan(currentUser, 'insights.view');
  const [tab, setTab] = useState<Tab>('team');
  // Opened from a link (?tab=landing) — read after mount, so the server
  // render and the first client render agree.
  useEffect(() => {
    const asked = new URLSearchParams(window.location.search).get('tab');
    if (canLanding && asked === 'landing') setTab('landing');
    if (canScores && asked === 'scores') setTab('scores');
  }, [canLanding, canScores]);
  const pickTab = (next: Tab) => {
    setTab(next);
    const url = new URL(window.location.href);
    if (next === 'team') url.searchParams.delete('tab');
    else url.searchParams.set('tab', next);
    window.history.replaceState(null, '', url);
  };
  // ONE date filter for the whole screen. There used to be an English
  // period strip here and no filter at all on the people below it, so the
  // product table and the team table were answering about different spans
  // of time on the same page.
  const [range, setRange] = useState(lastThirtyDays);
  const [analytics, setAnalytics] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  /** Why the numbers did not come: a refusal or a failure, said — never drawn as zeros. */
  const [refusal, setRefusal] = useState<{ status: number; said: string } | null>(null);
  // Who is doing the work, and how well. The endpoints behind these were
  // built and never connected: this screen was a second copy of the
  // dashboard's analytics, and neither answered "which agent" or
  // "which courier".
  const [team, setTeam] = useState<any[] | null>(null);
  const [totals, setTotals] = useState<any>(null);
  const [couriers, setCouriers] = useState<CourierRow[] | null>(null);
  /**
   * WHETHER «COLLECTED» MAY BE SCORED AT ALL, for the whole shop. Kept
   * beside the list rather than inside each row: it is a fact about the
   * settlement process, and repeating it on three rows would read as three
   * separate problems.
   */
  const [collection, setCollection] = useState<Trust | null>(null);
  /** Best first; the unmeasured ones last rather than worst. */
  const ranked = rankCouriers(couriers ?? []);
  // Who brought the business, and through which door. Same window as
  // everything else on this screen.
  const [moderators, setModerators] = useState<AttributionRow[] | null>(null);
  const [channels, setChannels] = useState<AttributionRow[] | null>(null);
  const [attrTotals, setAttrTotals] = useState<{ moderators: AttributionRow; channels: AttributionRow } | null>(null);

  /** Empty dates mean "the whole window"; the server clamps it to 90 days. */
  const dateQuery = range.from && range.to ? `startDate=${range.from}&endDate=${range.to}` : 'period=all';

  useEffect(() => {
    setTeam(null);
    // The table of the confirmation team is `team.monitor`'s (PR-10): nobody is asked what they may not read, and a 403 is
    // never drawn as an empty table.
    if (!canScores) return;
    // The team endpoint's totals belong to the TEAM table. They were being
    // put into `attrTotals`, which is the attribution tables' state, while
    // the attribution endpoint's totals were being put into `totals`, which
    // is the team table's — so each table's footer was summing the other
    // table's rows. Two states, two endpoints, swapped once.
    apiJson<{ employees: any[]; totals: any }>(`/api/orders/confirmation/team?${dateQuery}`)
      .then((d) => {
        setTeam(d.employees ?? []);
        setTotals(d.totals ?? null);
      })
      .catch(() => setTeam([]));
  }, [dateQuery, canScores]);

  useEffect(() => {
    setModerators(null);
    setChannels(null);
    setAttrTotals(null);
    apiJson<{
      moderators: AttributionRow[];
      channels: AttributionRow[];
      totals?: { moderators: AttributionRow; channels: AttributionRow };
    }>(`/api/growth/attribution?${dateQuery}`)
      .then((d) => {
        setModerators(d.moderators ?? []);
        setChannels(d.channels ?? []);
        setAttrTotals(d.totals ?? null);
      })
      .catch(() => {
        setModerators([]);
        setChannels([]);
        setAttrTotals(null);
      });
  }, [dateQuery]);

  useEffect(() => {
    apiJson<{ providers: CourierRow[]; collection: Trust }>('/api/orders/shipping/performance')
      .then((d) => {
        setCouriers(d.providers ?? []);
        setCollection(d.collection ?? null);
      })
      .catch(() => setCouriers([]));
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      // Its OWN door (`reports.view`) — not the dashboard's: a person who may open this board
      // and not the dashboard (a bookkeeper) reads the same numbers here.
      const res = await apiFetch(`/api/analytics/performance?${dateQuery}`);
      if (res.ok) {
        const data = await res.json();
        setRefusal(null);
        setAnalytics(data);
      } else {
        if (res.status === 403) setAnalytics(null);
        setRefusal({ status: res.status, said: await saidBy(res, 'تعذّر تحميل أرقام لوحة الأداء. أعد المحاولة بعد قليل.') });
      }
    } catch (e) {
      console.error(e);
      // A dropped connection is not «٠ طلب»: say the numbers did not come (status 0 = no answer at all).
      setRefusal({ status: 0, said: e instanceof Error && /[\u0600-\u06FF]/.test(e.message) ? e.message : 'تعذّر الاتصال. تحقق من الشبكة وأعد المحاولة.' });
    } finally {
      setLoading(false);
    }
  };
  // Loads on mount, when the dates move, and again when the person comes back to the screen:
  // a board left open all day must not go on saying this morning's numbers.
  useLiveRefresh(loadData, { key: dateQuery });

  /**
   * THE VITALS THE SERVER SENT, AND THE VERDICT ON THE COST DATA.
   *
   * Nothing here is recomputed from money. `cost` is not a figure — it is
   * whether the figures that REST on a cost may be printed at all, and it
   * governs three places on this screen: the «الأكثر ربحاً» card, the net
   * profit column, and the margin column. On the measured database it says
   * no: cost of goods is recorded on 4 of 119 delivered orders, and the
   * margins this table printed were 80.7%, 82.3%, 82.2%, 80%, 81.7% and 76%
   * — six products, one number, which is what a missing input looks like
   * when somebody draws a figure over it.
   */
  const vitals = analytics?.vitals as
    | {
        door: { delivered: number; failed: number; returned: number; decided: number; returnRate: number | null };
        cost: Trust;
        /** ABSENT without `insights.view` — a smart card, never a list of zeros. */
        returnsByProduct?: { productId: string; returned: number; decided: number; rate: number | null }[];
      }
    | undefined;
  const costStated = vitals ? vitals.cost.level !== 'WITHHELD' : false;

  /** Returns per product, by id, for the two columns and the headline card. */
  const returnsOf = new Map((vitals?.returnsByProduct ?? []).map((r) => [r.productId, r]));

  // Already sorted by parcels-back on the server; the name comes from
  // `productStats` in the same payload rather than a second lookup, so the
  // card and the table can never spell one product two ways.
  const topReturnedRow = (vitals?.returnsByProduct ?? []).find((r) => r.returned > 0);
  const topReturned = topReturnedRow
    ? {
        ...topReturnedRow,
        name: (analytics?.productStats ?? []).find((p: any) => p.id === topReturnedRow.productId)?.name as
          | string
          | undefined,
      }
    : null;

  // Refused or failed with nothing earlier to show: say so, rather than drawing «٠» under every
  // table as if the shop had sold nothing in this window.
  if (refusal && !analytics) {
    return (
      <div className="space-y-6">
        <PageHeader title={routeLabel('/growth/performance')} />
        <Card>
          <CardContent>
            <EmptyState
              title={refusal.status === 403 ? 'لا تملك صلاحية «عرض التقارير»' : 'تعذّر تحميل أرقام لوحة الأداء'}
              why={refusal.status === 403 ? 'أرقام لوحة الأداء تُقرأ بصلاحية «عرض التقارير». اطلبها من مدير النظام.' : refusal.said}
              action={refusal.status === 403 ? undefined : { label: 'إعادة المحاولة', onClick: () => void loadData() }}
            />
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-6">
        {/* Header */}
        <PageHeader title={routeLabel('/growth/performance')}
            description="ربح كل منتج، وترتيب المنتجات، وأداء الفريق — للمدة المختارة"
            actions={
              <><div className="flex items-center gap-2 flex-wrap gap-y-2">
            <BackToDashboardLink />
            <div className="w-56">
              <DateRange value={range} onChange={setRange} label="كل المدة" />
            </div>
            {/* The «تصدير CSV» that stood here opened /api/reports/export with
                no parameters: EVERY order, whatever range was picked in the box
                beside it. The orders screen exports what its filters match. */}
          </div></>
            }
          />

        {(canLanding || canScores) && (
          <div className="flex gap-6 border-b border-[var(--sys-border)] text-sm" role="tablist">
            {([
              ['team', 'المنتجات والفريق والقنوات'],
              ...(canScores ? [['scores', 'سكور الموظفين'] as [Tab, string]] : []),
              ...(canLanding ? [['landing', 'تحليلات صفحات الهبوط'] as [Tab, string]] : []),
            ] as [Tab, string][]).map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                onClick={() => pickTab(key)}
                className={`-mb-px border-b-2 pb-2.5 font-semibold transition-colors ${
                  tab === key ? 'border-[var(--sys-primary)] text-[var(--sys-primary)]' : 'border-transparent text-[var(--sys-muted-foreground)] hover:text-[var(--sys-foreground)]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        {tab === 'scores' && canScores ? (
          // Its OWN window — the week or month the owner set in the score
          // settings — not the date range above. The score is comparable
          // across months only if everybody's is measured over the same
          // span, which a free-hand date picker would quietly break.
          <ScoreBoard />
        ) : tab === 'landing' && canLanding ? (
          <LandingAnalyticsTab dateQuery={dateQuery} from={range.from} />
        ) : !analytics ? (
          // Nothing is drawn as a number before the server has sent one: a refusal returned above, so no analytics here
          // means the first answer is still on its way — and the cards below would read «٠ طلب» until it lands.
          <div aria-busy={loading}>
            <SkeletonRows rows={6} />
          </div>
        ) : (
        <>
        {/*
          ─── THE FOUR HEADLINES, AND WHY IT IS FOUR AND NOT FIVE ───

          «الأكثر تأكيداً» is gone. Measured on all three stores in the live
          database, it named the SAME product as «الأكثر طلباً» every time —
          which is what a 97% confirmation rate does to it: confirmed orders
          are very nearly total orders, so the two cards have the same
          argmax and one of them is a second drawing of the other.

          «الأكثر ربحاً» stays, but only when there is a profit to rank. With
          cost of goods recorded on 4 of 119 delivered orders, ranking by
          profit IS ranking by revenue — and measured, it named the same
          product as «الأكثر توصيلاً» in all three stores too. So the card
          says which field is empty rather than crowning the same product a
          third time under a money word.

          «الأكثر إرجاعاً» takes the freed slot. It is the only one of these
          five questions that costs money twice — the outbound fee and the
          fee to bring it back — and nothing in this product answered it.
        */}
        {canInsights && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Rank
            icon={<RiTrophyLine className="w-4 h-4" />}
            label="الأكثر طلباً"
            name={analytics?.rankings?.mostRequested?.name}
            note={`${analytics?.rankings?.mostRequested?.totalOrders || 0} طلب`}
          />
          {canFinance && (
          <Rank
            icon={<RiCopperCoinLine className="w-4 h-4" />}
            label="الأكثر ربحاً"
            name={costStated ? analytics?.rankings?.mostProfitable?.name : undefined}
            note={
              costStated ? (
                <>صافي <Money value={analytics?.rankings?.mostProfitable?.netProfit || 0} /></>
              ) : (
                'كلفة البضاعة غير مسجَّلة'
              )
            }
          />
          )}
          <Rank
            icon={<RiTruckLine className="w-4 h-4" />}
            label="الأكثر توصيلاً"
            name={analytics?.rankings?.mostDelivered?.name}
            note={`${analytics?.rankings?.mostDelivered?.deliveredOrders || 0} موصَّل`}
          />
          <Rank
            icon={<RiInboxUnarchiveLine className="w-4 h-4" />}
            label="الأكثر إرجاعاً"
            name={topReturned?.name}
            note={
              topReturned
                ? `${topReturned.returned} من ${topReturned.decided} بتَّ فيه الباب`
                : 'لا مرتجعات في هذه المدة'
            }
            warn
          />
        </div>
        )}

        {/*
          THE WHOLE COMPANY'S RETURN RATE, ABOVE THE TABLE THAT BREAKS IT UP.

          It belongs here rather than only on the dashboard because every
          per-product rate below is read against it: a product at 24% in a
          shop at 22% is normal, and the same product in a shop at 6% is the
          problem. Measured: 34 of 153 parcels that reached a verdict came
          back, against a bar of 8% good and 15% acceptable.
        */}
        {vitals && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] px-4 py-3">
            <span className="inline-flex items-center gap-1.5 text-xs font-bold text-[var(--sys-heading)]">
              <RiAlertLine className="w-4 h-4 text-[var(--sys-warning)]" aria-hidden />
              الإرجاع في هذه المدة
            </span>
            <span className="text-sm font-black tabular-nums text-[var(--sys-heading)]">
              {vitals.door.returnRate === null ? '—' : `${vitals.door.returnRate}%`}
            </span>
            <span className="text-xs text-[var(--sys-muted-foreground)] tabular-nums">
              {vitals.door.returned} من {vitals.door.decided} طلب بتَّ فيه الباب
            </span>
            <HealthChip
              className="ms-auto"
              withWhy
              health={healthOf('returnRate', vitals.door.returnRate, vitals.door.decided)}
            />
          </div>
        )}

        {/* Section 18: Product Profit Analysis Table */}
        <Card>
          <CardHeader
            title="ربح كل منتج"
            /**
             * THE SUBTITLE SAYS WHETHER THE TABLE'S MONEY COLUMNS MEAN
             * ANYTHING, BEFORE ANYBODY READS THEM.
             *
             * It used to describe the arithmetic — «الإيراد ناقص الكلفة» —
             * which is true and useless: the arithmetic was never the
             * problem, the empty cost field was. Now it names the coverage
             * out loud, and the two profit columns below refuse per row.
             */
            subtitle={
              vitals ? `${vitals.cost.ar} · الإيراد من الموصَّل فقط، ناقص كلفة البضاعة وكلفة الشحن` : undefined
            }
          />
          <CardContent className="p-0">
            <div className="overflow-x-auto">
                            <Rows
                rows={(analytics?.productStats ?? [])}
                keyOf={(prod: any) => prod.id}
                columns={[
                  { key: 'c0', label: "المنتج", primary: true,
                    render: (prod: any) => (
                  <><span className="font-bold text-[var(--sys-heading)] block">{prod.name}</span>
                        <span className="font-mono text-xs text-[var(--sys-muted)]">{prod.sku}</span></>
                ) },
                  { key: 'c1', label: "الطلبات", primary: true,
                    render: (prod: any) => (prod.totalOrders) },
                  // Hidden from the phone cards, not from the table. With a
                  // 97% confirmation rate «مؤكد» is «الطلبات» again to within
                  // a few orders, and a card that spends a line on it spends
                  // it instead of on what came back.
                  { key: 'c2', label: "مؤكد", hideOnPhone: true,
                    render: (prod: any) => (prod.confirmedOrders) },
                  { key: 'c3', label: "موصَّل",
                    render: (prod: any) => (prod.deliveredOrders) },
                  { key: 'c4', label: "مرفوض على الهاتف", hideOnPhone: true,
                    render: (prod: any) => (prod.rejectedOrders) },
                  /**
                   * AND WHAT CAME BACK FROM THE DOOR, WHICH IS THE OTHER
                   * HALF OF THE SAME QUESTION AND THE EXPENSIVE ONE.
                   *
                   * «مرفوض» beside it is a refusal on the PHONE: nothing was
                   * spent, no parcel moved, no fee was paid. This column is
                   * a refusal AFTER the fee — billed out and billed back —
                   * and the table had no column for it at all, so the
                   * cheapest loss was reported per product and the dearest
                   * one was not reported anywhere.
                   */
                  ...(!canInsights ? [] : [
                  { key: 'c5', label: "مرتجع من الباب",
                    render: (prod: any) => (returnsOf.get(prod.id)?.returned ?? 0) },
                  { key: 'c6', label: "نسبة الإرجاع",
                    render: (prod: any) => {
                      const r = returnsOf.get(prod.id);
                      // The verdict rather than the bare percentage, because
                      // one parcel back out of two is «50%» and means
                      // nothing — `healthOf` refuses a sample under ten and
                      // says «لا يكفي» instead of dressing it as a rate.
                      return (
                        <span className="inline-flex items-center gap-1.5">
                          <span className="tabular-nums">{r?.rate === null || !r ? '—' : `${r.rate}%`}</span>
                          {r && <HealthChip health={healthOf('returnRate', r.rate, r.decided)} />}
                        </span>
                      );
                    } },
                  ]),
                  // The five money columns, only with «عرض المالية».
                  ...(!canFinance ? [] : [
                  { key: 'c7', label: "إيراد الموصَّل",
                    render: (prod: any) => (
                  <><Money value={prod.revenue} /></>
                ) },
                  { key: 'c8', label: "كلفة البضاعة",
                    render: (prod: any) => (
                  rowCostStated(prod)
                    ? <Money value={-prod.cogs} />
                    : <span className="text-[var(--sys-muted)]">غير مسجَّلة</span>
                ) },
                  { key: 'c9', label: "كلفة الشحن", hideOnPhone: true,
                    render: (prod: any) => (
                  <><Money value={-prod.shippingCost} /></>
                ) },
                  /**
                   * THE TWO COLUMNS THAT REFUSE THEMSELVES, ROW BY ROW.
                   *
                   * The table-wide verdict in the subtitle answers «is this
                   * shop's cost data usable». It cannot answer «is THIS
                   * product's margin usable», and on the measured data the
                   * two differ: 5 of the 7 products that sold carry no cost
                   * at all while 2 carry one. Gated only at the top, the two
                   * true rows would be blanked with the five false ones;
                   * gated nowhere, a product whose cost nobody has typed
                   * printed «82%» — the revenue, in a green pill, called a
                   * margin.
                   */
                  { key: 'c10', label: "صافي الربح",
                    render: (prod: any) => (
                  rowCostStated(prod)
                    ? <Money value={prod.netProfit} />
                    : <span className="text-[var(--sys-muted)]">—</span>
                ) },
                  { key: 'c11', label: "هامش الربح",
                    render: (prod: any) => (
                  rowCostStated(prod)
                    ? <span className="font-bold text-[var(--sys-primary)] bg-[var(--sys-primary-soft)] px-2 py-0.5 rounded-lg text-xs">
                          {prod.profitMargin}%
                        </span>
                    : <span className="text-[var(--sys-muted)]" title="لا كلفة مسجَّلة لهذا المنتج — الهامش سيكون الإيراد نفسه">—</span>
                ) },
                  ]),
                ]}
              />
            </div>
          </CardContent>
        </Card>

        {/* Confirmation agents */}
        {canScores && (
        <Card>
          <CardHeader
            title="أداء موظفي التأكيد"
            subtitle="الأزمنة بدقائق العمل — خارج الدوام والعطلة لا يُحتسب — والقيم وسيط لا متوسط"
          />
          <CardContent className="p-0">
            <TeamPerformanceTable rows={team as any} totals={totals} />
          </CardContent>
        </Card>
        )}

        {/* Who brought it in */}
        <Card>
          <CardHeader
            title="أداء المودريتورية"
            subtitle="ما جلبه كلٌّ منهم وما بقي منه — النسب من الخطوة التي قبلها، لا من أعلى القمع"
          />
          <CardContent className="p-0">
            <AttributionTable rows={moderators} totals={attrTotals?.moderators} empty="لا طلبات منسوبة لمودريتر في هذه المدة." />
          </CardContent>
        </Card>

        {/* Which door it came through */}
        <Card>
          <CardHeader
            title="أداء القنوات"
            subtitle="الباب الذي جاء منه الطلب — وعمود «للطلب الواحد» يفرّق بين مصدر كبير ومصدر جيد"
          />
          <CardContent className="p-0">
            <AttributionTable rows={channels} totals={attrTotals?.channels} empty="لا طلبات مرتبطة بقناة في هذه المدة." />
          </CardContent>
        </Card>

        {/* What each of those doors DELIVERED and COLLECTED — the score that used to sit at the foot of the channels settings. */}
        {canInsights && <ChannelScoresSection />}

        {/* Couriers */}
        <Card>
          <CardHeader
            title="أداء شركات الشحن"
            subtitle="سكور من 100 على ما أنجزه كلُّ مندوب — ومعه الأرقام التي بُني منها"
          />
          <CardContent className="p-0">
            {couriers === null ? (
              <div className="p-4"><SkeletonRows rows={5} /></div>
            ) : couriers.length === 0 ? (
              <p className="p-6 text-sm text-[var(--sys-muted)] text-center">لا شركات شحن بعد.</p>
            ) : (
              <>
                {/*
                  WHY A SCORE IS OUT OF LESS THAN A HUNDRED, said once above
                  the list. Without it a reader sees «70 من 70» and assumes
                  the engine is broken.

                  AND IT NAMES NO FIGURE. The first version of this sentence
                  said «يُحسب كل سكور من 80» — which is wrong whenever a
                  SECOND band is also unmeasured, and on this database speed
                  always is, so every row read «من 70» under a sentence
                  promising 80. Each row carries its own «من X»; this says
                  only which band is out and why.
                */}
                {collection?.level === 'WITHHELD' && (
                  <p className="mx-5 mb-2 rounded-lg border border-[var(--sys-border)] bg-[var(--sys-surface)] p-3 text-xs text-[var(--sys-muted-foreground)]">
                    <span className="font-semibold text-[var(--sys-heading)]">التحصيل خارج السكور: </span>
                    {collection.ar} لذلك يبقى بند «نسبة التحصيل» بلا نقاط حتى تُسوّى أول شحنة — وكل سكور
                    يُحسب من المجموع الظاهر بجانبه، لا من 100.
                  </p>
                )}
                <ul className="divide-y divide-[var(--sys-border)]">
                  {ranked.map((c, i) => (
                    <li key={c.provider.id} className="px-5 py-3">
                      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                        {/*
                          The rank is drawn only for a courier that HAS one.
                          Numbering the ungraded ones 2 and 3 reads as
                          «worse», and they are not worse — they are
                          unmeasured.
                        */}
                        <span className="w-5 text-xs font-black tabular-nums text-[var(--sys-muted)]">
                          {c.score.total === null ? '—' : i + 1}
                        </span>
                        <span className="inline-flex items-center gap-1.5 text-sm font-bold text-[var(--sys-heading)]">
                          {c.provider.kind === 'AGENT' ? (
                            <RiEBike2Line className="w-4 h-4 text-[var(--sys-primary)]" />
                          ) : (
                            <RiTruckLine className="w-4 h-4 text-[var(--sys-muted)]" />
                          )}
                          {c.provider.name}
                        </span>

                        {c.score.total === null ? (
                          <span className="ms-auto text-xs text-[var(--sys-muted-foreground)]">{c.whyNoScore}</span>
                        ) : (
                          <span className="ms-auto inline-flex items-baseline gap-1 tabular-nums">
                            <span className="text-lg font-black text-[var(--sys-heading)]">{c.score.total}</span>
                            <span className="text-xs text-[var(--sys-muted-foreground)]">من {c.score.possible}</span>
                          </span>
                        )}
                      </div>

                      {/*
                        WHICH BAND COST THE POINTS, always. Somebody told
                        «your courier scored 72» can do nothing with it;
                        somebody told the returns cost eight of twenty can.
                      */}
                      {c.score.total !== null && (
                        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                          {c.score.bands.map((b) => (
                            <li key={b.key} className="text-xs text-[var(--sys-muted-foreground)]">
                              {b.ar}{' '}
                              <span className="tabular-nums text-[var(--sys-foreground)]">
                                {b.value === null
                                  ? 'لم يُقَس'
                                  : b.unit === 'hours'
                                    ? `${b.value} س`
                                    : `${Math.round(b.value)}%`}
                              </span>{' '}
                              <span className="tabular-nums font-semibold text-[var(--sys-heading)]">
                                {b.points === null ? '—' : `${b.points}/${b.weight}`}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}

                      {/* The plain counts, so the score can be checked against
                          the parcels it was built from. */}
                      <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--sys-muted)] tabular-nums">
                        <span>{c.metrics.assigned} مُسند</span>
                        <span className="text-[var(--sys-success)]">{c.metrics.delivered} مسلَّم</span>
                        <span className="text-[var(--sys-destructive)]">{c.metrics.returned} مرتجع</span>
                        <span>{c.metrics.settled} مسوّى</span>
                        <span>
                          متوسط التوصيل{' '}
                          {c.metrics.avgDeliveryHours === null ? '—' : `${c.metrics.avgDeliveryHours} س`}
                        </span>
                      </p>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </CardContent>
        </Card>
        </>
        )}
      </div>
    </>
  );
}

function Metric({ label, value, tone }: { label: string; value: number | string; tone?: string }) {
  return (
    <span className="text-[var(--sys-muted-foreground)]">
      {label}: <span className={`tabular-nums font-semibold ${tone ?? 'text-[var(--sys-heading)]'}`}>{value}</span>
    </span>
  );
}

/**
 * One headline. The five of them used to be red emoji boxes with English
 * capitals — the only place in the system that looked like that.
 */
function Rank({
  icon,
  label,
  name,
  note,
  warn,
}: {
  icon: React.ReactNode;
  label: string;
  name?: string;
  note: React.ReactNode;
  warn?: boolean;
}) {
  const tone = warn ? 'text-[var(--sys-warning)]' : 'text-[var(--sys-primary)]';
  return (
    <div className="bg-[var(--sys-card)] border border-[var(--sys-border)] p-4 rounded-lg">
      <span className={`text-xs font-bold ${tone} inline-flex items-center gap-1.5`}>
        {icon}
        {label}
      </span>
      <p className="font-bold text-[var(--sys-heading)] text-sm mt-1.5 line-clamp-1" title={name}>
        {name || '—'}
      </p>
      <p className="text-xs text-[var(--sys-muted-foreground)] font-semibold mt-0.5 tabular-nums">{note}</p>
    </div>
  );
}
