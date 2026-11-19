'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Card, CardHeader, CardContent, KpiCard } from '@/components/ui/Card';
import { StatTile } from '@/components/ui/StatTile';
import { useApp } from '@/context/AppContext';
import { apiFetch, apiJson, saidBy } from '@/lib/api-client';
import { EmptyState } from '@/components/ui/EmptyState';
import { DateRange, todayRange } from '@/components/ui/DateRange';
import { TeamPerformanceTable } from '@/components/performance/TeamPerformanceTable';
import { AttributionTable, type AttributionRow } from '@/components/performance/AttributionTable';
import { LandingAnalyticsTab } from '@/components/performance/LandingAnalyticsTab';
import { userCan } from '@/lib/can';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { ScoreBoard } from '@/components/performance/ScoreBoard';
import { TeamMemberDrawer, type DrawerPerson } from '@/components/performance/TeamMemberDrawer';
import { readReportRange, searchWithRange, writeReportRange } from '@/lib/report-range';
import { EodReportForm } from '@/components/performance/EodReportForm';
import { NoAnswerWatch } from '@/components/performance/NoAnswerWatch';
import { findRoute, routeLabel } from '@/lib/route-registry';
import { RiAlertLine, RiArrowRightLine, RiArrowUpCircleLine, RiAwardLine, RiCopperCoinLine, RiEBike2Line, RiHandCoinLine, RiInboxUnarchiveLine, RiTrophyLine, RiTruckLine } from '@remixicon/react';
import Link from 'next/link';
import { plainNumber } from '@/lib/format';
import { TEAM_PERMISSIONS } from '@/lib/ai-assistants';
import { useMayOpen } from '@/hooks/useMayOpen';
import { STATE_TONE, type CoreState } from '@/lib/order-state';
import { TONE_DOT, TONE_TEXT } from '@/components/ui/StatusChip';
import { IntelligenceStrip } from '@/components/growth/IntelligenceStrip';
import { LossPanel } from '@/components/dashboard/LossPanel';
import { PersonNameLink, ProductNameLink } from '@/components/dashboard/NameLinks';
import { Money } from '@/components/ui/Money';
import { PageShell } from '@/components/ui/PageShell';
import { Tabs } from '@/components/ui/Tabs';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { Rows } from '@/components/ui/Rows';
import { healthOf, type Health } from '@/lib/health';
import { HealthChip } from '@/components/ui/HealthChip';
import { BackToDashboardLink } from '@/components/dashboard/DetailsLinks';
import { ChannelScoresSection } from '@/components/growth/ChannelScores';
import type { CourierScore } from '@/lib/couriers/score';
import { rowCostStated, type Trust } from '@/lib/cod-vitals';

type Tab = 'team' | 'landing' | 'scores' | 'noanswer' | 'eod';

/**
 * HOW LONG THE BOARD WAITS FOR A REPORT — a minute, not the fifteen seconds every other call gets (the owner, 13/11: «لوحة الأداء بتضل
 * تعلق»).
 *
 * A page of this board asks for four reports at once. The server now runs them in their own small lane and shares one computation
 * between the askers (`lib/heavy-lane.ts`), but a report is still real work, and giving up at fifteen seconds drew «تعذّر تحميل
 * أرقام لوحة الأداء» over a computation that was about to finish. The server keeps computing after the client gives up, so «إعادة
 * المحاولة» finds it done — and a minute is long enough that it rarely has to.
 */
const BOARD_WAIT_MS = 60_000;

/** The couriers' door (`/api/orders/shipping/performance`) takes no window: it counts every parcel each company ever held. */
const COURIERS_WINDOW_LINE = 'كل التاريخ — ما بتتبع المدة المختارة فوق.';

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
    if (canScores && asked === 'noanswer') setTab('noanswer');
    if (canScores && asked === 'eod') setTab('eod');
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
  // Opens on TODAY (the owner, 17/11): thirty days of everything was the slow way in. أمس, 7 أيام, 30 يوم and a custom span are one press away.
  const [range, setRange] = useState(todayRange);
  /*
   * THE SHARED RANGE OF THE FOUR REPORT TABS (R14a1, 18/11) — «مدة وحدة بتضل لما أتنقّل بين التقارير».
   * Read once after mount (the server render and the first client render agree on today): the address, then the one stored key.
   * Nothing stored («today») leaves the board on its own today. Every change is written back to the key, and an address that
   * already carried a range is kept in step with it (the address wins over the storage, so a reload would otherwise go back).
   */
  useEffect(() => {
    const { range: shared, source } = readReportRange(window.location.search);
    if (source !== 'today') setRange(shared);
  }, []);
  const pickRange = useCallback((next: { from: string; to: string }) => {
    setRange(next);
    const kept = next.from && next.to ? next : null;
    writeReportRange(kept);
    try {
      const q = new URLSearchParams(window.location.search);
      if (q.has('from') || q.has('to')) {
        window.history.replaceState(window.history.state, '', `${window.location.pathname}${searchWithRange(window.location.search, kept)}`);
      }
    } catch {
      /* an address that cannot be rewritten still has the stored key */
    }
  }, []);
  /** The person whose drawer is open — from a row of the team table or of «سكور الموظفين». */
  const [opened, setOpened] = useState<DrawerPerson | null>(null);
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
  /** The words the team door sends for each of its figures — the drawer prints them under the same figures. */
  const [definitions, setDefinitions] = useState<Record<string, string> | null>(null);
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
  /**
   * The loss panel (moved from «اليوم», R9) asks its door with `?period=` and nothing else. Its door reads the days beside the name
   * and they win over it (`reportRange`), so this board's window travels as `all` plus the days; empty dates are `all` alone.
   */
  const lossPeriod = range.from && range.to ? `all&${dateQuery}` : 'all';
  /** Colleagues by name (the leaderboard moved from «اليوم»): only for the key of a screen that already shows them. */
  const maySeeColleagues = TEAM_PERMISSIONS.some((p) => userCan(currentUser, p));

  /**
   * A TABLE THAT DID NOT COME IS NOT AN EMPTY TABLE, AND THE NEWEST ANSWER WINS (13/11).
   *
   * Each of the three tables below failed into «no rows» — a timeout read as «لا شركات شحن بعد» or an empty team, which says nobody
   * worked. A failure is now its own state, drawn with the shared `EmptyState` and a retry, exactly as this screen already does for
   * the vitals. And when the window changed while an old answer was still on its way, the old one used to land last and overwrite the
   * new window's table: each loader numbers its calls and applies only the newest (a retry is just another call).
   */
  const teamSeq = useRef(0);
  const attrSeq = useRef(0);
  const couriersSeq = useRef(0);
  const [teamFailed, setTeamFailed] = useState(false);
  const [attrFailed, setAttrFailed] = useState(false);
  const [couriersFailed, setCouriersFailed] = useState(false);

  const loadTeam = useCallback(() => {
    const mine = ++teamSeq.current;
    setTeam(null);
    setTeamFailed(false);
    // The table of the confirmation team is `team.monitor`'s (PR-10): nobody is asked what they may not read, and a 403 is
    // never drawn as an empty table.
    if (!canScores) return;
    // The team endpoint's totals belong to the TEAM table. They were being
    // put into `attrTotals`, which is the attribution tables' state, while
    // the attribution endpoint's totals were being put into `totals`, which
    // is the team table's — so each table's footer was summing the other
    // table's rows. Two states, two endpoints, swapped once.
    apiJson<{ employees: any[]; totals: any; definitions?: Record<string, string> }>(`/api/orders/confirmation/team?${dateQuery}`, { timeoutMs: BOARD_WAIT_MS })
      .then((d) => {
        if (mine !== teamSeq.current) return;
        setTeam(d.employees ?? []);
        setTotals(d.totals ?? null);
        setDefinitions(d.definitions ?? null);
      })
      .catch(() => {
        if (mine !== teamSeq.current) return;
        setTeam([]);
        setTeamFailed(true);
      });
  }, [dateQuery, canScores]);
  useEffect(() => {
    loadTeam();
  }, [loadTeam]);

  const loadAttribution = useCallback(() => {
    const mine = ++attrSeq.current;
    setModerators(null);
    setChannels(null);
    setAttrTotals(null);
    setAttrFailed(false);
    apiJson<{
      moderators: AttributionRow[];
      channels: AttributionRow[];
      totals?: { moderators: AttributionRow; channels: AttributionRow };
    }>(`/api/growth/attribution?${dateQuery}`, { timeoutMs: BOARD_WAIT_MS })
      .then((d) => {
        if (mine !== attrSeq.current) return;
        setModerators(d.moderators ?? []);
        setChannels(d.channels ?? []);
        setAttrTotals(d.totals ?? null);
      })
      .catch(() => {
        if (mine !== attrSeq.current) return;
        setModerators([]);
        setChannels([]);
        setAttrTotals(null);
        setAttrFailed(true);
      });
  }, [dateQuery]);
  useEffect(() => {
    loadAttribution();
  }, [loadAttribution]);

  const loadCouriers = useCallback(() => {
    const mine = ++couriersSeq.current;
    setCouriers(null);
    setCouriersFailed(false);
    apiJson<{ providers: CourierRow[]; collection: Trust }>('/api/orders/shipping/performance', { timeoutMs: BOARD_WAIT_MS })
      .then((d) => {
        if (mine !== couriersSeq.current) return;
        setCouriers(d.providers ?? []);
        setCollection(d.collection ?? null);
      })
      .catch(() => {
        if (mine !== couriersSeq.current) return;
        setCouriers([]);
        setCouriersFailed(true);
      });
  }, []);
  useEffect(() => {
    loadCouriers();
  }, [loadCouriers]);

  const loadData = async () => {
    setLoading(true);
    try {
      // Its OWN door (`reports.view`) — not the dashboard's: a person who may open this board
      // and not the dashboard (a bookkeeper) reads the same numbers here.
      const res = await apiFetch(`/api/analytics/performance?${dateQuery}`, { timeoutMs: BOARD_WAIT_MS });
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
      <PageShell title={routeLabel('/growth/performance')}>
        <Card>
          <CardContent>
            <EmptyState
              title={refusal.status === 403 ? 'لا تملك صلاحية «عرض التقارير»' : 'تعذّر تحميل أرقام لوحة الأداء'}
              why={refusal.status === 403 ? 'أرقام لوحة الأداء تُقرأ بصلاحية «عرض التقارير». اطلبها من مدير النظام.' : refusal.said}
              action={refusal.status === 403 ? undefined : { label: 'إعادة المحاولة', onClick: () => void loadData() }}
            />
          </CardContent>
        </Card>
      </PageShell>
    );
  }

  return (
      <PageShell title={routeLabel('/growth/performance')}
            description="ربح كل منتج، وترتيب المنتجات، وأداء الفريق — للمدة المختارة"
            actions={
              <><div className="flex items-center gap-2 flex-wrap gap-y-2">
            <BackToDashboardLink />
            {/* Not on «لا رد»: that tab carries its own dates, and two pickers on one screen would answer two windows. */}
            {tab !== 'noanswer' && (
            <div className="w-56">
              <DateRange value={range} onChange={pickRange} label="كل المدة" />
            </div>
            )}
            {/* The «تصدير CSV» that stood here opened /api/reports/export with
                no parameters: EVERY order, whatever range was picked in the box
                beside it. The orders screen exports what its filters match. */}
          </div></>
            }
          >

        {(canLanding || canScores) && (
          <Tabs
            tabs={([
              ['team', 'المنتجات والفريق والقنوات'],
              ...(canScores ? [['scores', 'سكور الموظفين'] as [Tab, string]] : []),
              // The same people as the team table (`team.monitor`): what each agent holds now, and when customers pick up.
              ...(canScores ? [['noanswer', 'لا رد والطلبات المحجوزة'] as [Tab, string]] : []),
              // The team leader's end-of-day report (step H2): the same key as the team table, `team.monitor`.
              ...(canScores ? [['eod', 'تقرير نهاية اليوم'] as [Tab, string]] : []),
              ...(canLanding ? [['landing', 'تحليلات صفحات الهبوط'] as [Tab, string]] : []),
            ] as [Tab, string][]).map(([key, label]) => ({ key, label }))}
            value={tab}
            onChange={(key) => pickTab(key as Tab)}
          />
        )}

        {tab === 'eod' && canScores ? (
          <EodReportForm />
        ) : tab === 'noanswer' && canScores ? (
          // Read only, and its own dates: the board is «now», and the answer-rate report under it defaults to fourteen days.
          <NoAnswerWatch />
        ) : tab === 'scores' && canScores ? (
          // Its OWN window — the week or month the owner set in the score
          // settings — not the date range above. The score is comparable
          // across months only if everybody's is measured over the same
          // span, which a free-hand date picker would quietly break.
          <ScoreBoard onOpen={setOpened} />
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
        {/* What left «اليوم» (R9, 18/11): the strip, the other figures, the state tiles and the whole history's outcomes. */}
        <FromTheDashboard analytics={analytics} canFinance={canFinance} />

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
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
          <Rank
            icon={<RiTrophyLine className="w-4 h-4" />}
            label="الأكثر طلباً"
            name={analytics?.rankings?.mostRequested?.name}
            id={analytics?.rankings?.mostRequested?.id}
            note={`${analytics?.rankings?.mostRequested?.totalOrders || 0} طلب`}
          />
          {canFinance && (
          <Rank
            icon={<RiCopperCoinLine className="w-4 h-4" />}
            label="الأكثر ربحاً"
            name={costStated ? analytics?.rankings?.mostProfitable?.name : undefined}
            id={analytics?.rankings?.mostProfitable?.id}
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
            id={analytics?.rankings?.mostDelivered?.id}
            note={`${analytics?.rankings?.mostDelivered?.deliveredOrders || 0} موصَّل`}
          />
          <Rank
            icon={<RiInboxUnarchiveLine className="w-4 h-4" />}
            label="الأكثر إرجاعاً"
            name={topReturned?.name}
            id={topReturned?.productId}
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
          <Card plain className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3">
            <span className="inline-flex items-center gap-1.5 text-note font-bold text-[var(--sys-heading)]">
              <RiAlertLine className="w-4 h-4 text-[var(--sys-warning)]" aria-hidden />
              الإرجاع في هذه المدة
            </span>
            <span className="text-sm font-black tabular-nums text-[var(--sys-heading)]">
              {vitals.door.returnRate === null ? '—' : `${vitals.door.returnRate}%`}
            </span>
            <span className="text-note text-[var(--sys-muted-foreground)] tabular-nums">
              {vitals.door.returned} من {vitals.door.decided} طلب بتَّ فيه الباب
            </span>
            <HealthChip
              className="ms-auto"
              withWhy
              health={healthOf('returnRate', vitals.door.returnRate, vitals.door.decided)}
            />
          </Card>
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
                        <span className="font-mono text-note text-[var(--sys-muted)]">{prod.sku}</span></>
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
                    ? <span className="font-bold text-[var(--sys-primary)] bg-[var(--sys-primary-soft)] px-2 py-0.5 rounded-lg text-note">
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

        {/*
          WHY ORDERS DIED, RIGHT AFTER THE TABLE THAT COUNTS THEM PER PRODUCT («مرفوض على الهاتف», «مرتجع من الباب»). Moved
          from «اليوم» (R9, 18/11), the same panel and the same door, over this board's own window.
        */}
        {canInsights && <LossPanel period={lossPeriod} />}

        {/* Confirmation agents */}
        {canScores && (
        <Card>
          <CardHeader
            title="أداء موظفي التأكيد"
            subtitle="الأزمنة بدقائق العمل — خارج الدوام والعطلة لا يُحتسب — والقيم وسيط لا متوسط"
          />
          <CardContent className="p-0">
            {teamFailed ? (
              <EmptyState
                title="تعذّر تحميل جدول الفريق"
                why="لم يصل الجواب في الوقت المناسب — وهذا لا يعني أن أحداً لم يعمل. أعد المحاولة."
                action={{ label: 'إعادة المحاولة', onClick: loadTeam }}
              />
            ) : (
              <TeamPerformanceTable rows={team as any} totals={totals} onOpen={(r) => setOpened({ id: r.id, name: r.name })} />
            )}
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
            {attrFailed ? (
              <EmptyState
                title="تعذّر تحميل أرقام المودريتورية"
                why="لم يصل الجواب في الوقت المناسب — وهذا لا يعني أنه لا توجد طلبات. أعد المحاولة."
                action={{ label: 'إعادة المحاولة', onClick: loadAttribution }}
              />
            ) : (
              <AttributionTable rows={moderators} totals={attrTotals?.moderators} empty="لا طلبات منسوبة لمودريتر في هذه المدة." />
            )}
          </CardContent>
        </Card>

        {/* The leaderboard that stood on «اليوم» (R9, 18/11): colleagues by name, only for the key of a screen that shows them. */}
        {maySeeColleagues && <ModeratorLeaderboard rows={analytics?.moderatorLeaderboard} canFinance={canFinance} />}

        {/* Which door it came through */}
        <Card>
          <CardHeader
            title="أداء القنوات"
            subtitle="الباب الذي جاء منه الطلب — وعمود «للطلب الواحد» يفرّق بين مصدر كبير ومصدر جيد"
          />
          <CardContent className="p-0">
            {attrFailed ? (
              <EmptyState
                title="تعذّر تحميل أرقام القنوات"
                why="لم يصل الجواب في الوقت المناسب — وهذا لا يعني أنه لا توجد طلبات. أعد المحاولة."
                action={{ label: 'إعادة المحاولة', onClick: loadAttribution }}
              />
            ) : (
              <AttributionTable rows={channels} totals={attrTotals?.channels} empty="لا طلبات مرتبطة بقناة في هذه المدة." />
            )}
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
            {/* Its door takes no window — every parcel a courier ever held — said beside its numbers (R14a1, 18/11). */}
            <p className="px-5 pt-3 text-note text-[var(--sys-muted-foreground)]">{COURIERS_WINDOW_LINE}</p>
            {couriers === null ? (
              <div className="p-4"><SkeletonRows rows={5} /></div>
            ) : couriersFailed ? (
              <EmptyState
                title="تعذّر تحميل شركات الشحن"
                why="لم يصل الجواب في الوقت المناسب — وهذا لا يعني أنه لا توجد شركات شحن. أعد المحاولة."
                action={{ label: 'إعادة المحاولة', onClick: loadCouriers }}
              />
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
                  <Card plain padding="sm" className="mx-5 mb-2 text-note text-[var(--sys-muted-foreground)]">
                    <span className="font-semibold text-[var(--sys-heading)]">التحصيل خارج السكور: </span>
                    {collection.ar} لذلك يبقى بند «نسبة التحصيل» بلا نقاط حتى تُسوّى أول شحنة — وكل سكور
                    يُحسب من المجموع الظاهر بجانبه، لا من 100.
                  </Card>
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
                        <span className="w-5 text-note font-black tabular-nums text-[var(--sys-muted)]">
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
                          <span className="ms-auto text-note text-[var(--sys-muted-foreground)]">{c.whyNoScore}</span>
                        ) : (
                          <span className="ms-auto inline-flex items-baseline gap-1 tabular-nums">
                            <span className="text-lg font-black text-[var(--sys-heading)]">{c.score.total}</span>
                            <span className="text-note text-[var(--sys-muted-foreground)]">من {c.score.possible}</span>
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
                            <li key={b.key} className="text-note text-[var(--sys-muted-foreground)]">
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
                      <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-note text-[var(--sys-muted)] tabular-nums">
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
      {/* ONE drawer for both tables that list people: the same door as the team table, with the table's exact query. */}
      <TeamMemberDrawer person={opened} query={dateQuery} definitions={definitions} onClose={() => setOpened(null)} />
      </PageShell>
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
  id,
  note,
  warn,
}: {
  icon: React.ReactNode;
  label: string;
  name?: string;
  /** The product's id — what makes the name a link to it (the ranking that stood on «اليوم» had it; R9 carried it here). */
  id?: string;
  note: React.ReactNode;
  warn?: boolean;
}) {
  const tone = warn ? 'text-[var(--sys-warning)]' : 'text-[var(--sys-primary)]';
  return (
    <Card plain padding="md">
      <span className={`text-note font-bold ${tone} inline-flex items-center gap-1.5`}>
        {icon}
        {label}
      </span>
      <p className="font-bold text-[var(--sys-heading)] text-sm mt-1.5 line-clamp-1" title={name}>
        {name ? <ProductNameLink id={id} name={name} /> : '—'}
      </p>
      <p className="text-note text-[var(--sys-muted-foreground)] font-semibold mt-0.5 tabular-nums">{note}</p>
    </Card>
  );
}

/* ═══════════════════ FROM «اليوم» (R9, plan 17/11 — 18/11) ═══════════════════
 *
 * The dashboard became «اليوم»: three figures, one list, one chart. Everything else it drew was MOVED here, the same blocks over
 * the same builder (`/api/analytics/performance` is `answerAnalytics`, the dashboard's own answer and projection): the intelligence
 * strip, the three other figures with their rules, the seven state tiles and the whole history's outcomes — and, further down the
 * board, the loss panel and the leaderboard. The product ranking was not moved: this board's four headlines are its rows (the same
 * `rankings` fields, their names now linking to the product as they did there), and the refusals per product are the table's
 * «مرفوض على الهاتف».
 *
 * The figures here carry no «previous period» arrow: this board asks by days, and the door compares only a named window.
 */
function FromTheDashboard({ analytics, canFinance }: { analytics: any; canFinance: boolean }) {
  const { t } = useApp();
  const mayOpen = useMayOpen();
  /** The href, or nothing — a card with no link is still a card, and a link that ends in a refusal is worse than none. */
  const linkTo = (path: string): string | undefined => (mayOpen(path) ? path : undefined);

  const fin = analytics?.financials ?? { deliveredRevenue: 0 };
  const counts = analytics?.ordersCount ?? {
    total: 0, new: 0, contacting: 0, confirmed: 0,
    postponed: 0, rejected: 0, shipped: 0, delivered: 0,
  };
  const vitals = analytics?.vitals as
    | {
        door: { delivered: number; failed: number; returned: number; decided: number; returnRate: number | null };
        outstanding: { orders: number; money: number; unrecordedOrders: number };
      }
    | undefined;

  const verdicts = {
    rejectionRate: healthOf(
      'rejectionRate',
      (counts.decided ?? counts.total) > 0 ? (counts.rejected / (counts.decided ?? counts.total)) * 100 : null,
      counts.decided ?? counts.total
    ),
    /**
     * THE RETURN RATE, AGAINST THE BAR THAT ALREADY EXISTED FOR IT. The sample is what the DOOR decided, not orders created: an
     * order still in a van has not failed, and counting it would make this rate fall every time intake sped up.
     */
    returnRate: healthOf('returnRate', vitals?.door.returnRate ?? null, vitals?.door.decided),
  };

  /*
   * THE COLOUR COMES FROM THE STATE, NOT FROM THIS SCREEN: «مشحون» in the accent here and in plain foreground on the orders list
   * would be two different claims about the same parcel.
   */
  const tile = (
    label: string,
    value: number,
    state: CoreState
  ): { label: string; value: number; color: string; dot: string; health?: Health } => {
    const tone = STATE_TONE[state];
    return { label, value, color: TONE_TEXT[tone], dot: TONE_DOT[tone] };
  };

  const statusTiles = [
    tile(t.NEW, counts.new, 'NEW'),
    // «قيد التأكيد» — the legacy CONTACTING column's own state.
    tile(t.CONTACTING, counts.contacting, 'CLAIMED'),
    tile(t.CONFIRMED, counts.confirmed, 'CONFIRMED'),
    tile(t.POSTPONED, counts.postponed, 'POSTPONED'),
    tile(t.SHIPPED, counts.shipped, 'SHIPPED'),
    tile(t.DELIVERED, counts.delivered, 'DELIVERED'),
    // A rejected order derives to CANCELLED, which is where its tone lives.
    { ...tile(t.REJECTED, counts.rejected, 'CANCELLED'), health: verdicts.rejectionRate },
  ];

  return (
    <>
      {/* What needs a person, before what merely happened. Draws nothing while loading and nothing when all is quiet. */}
      <IntelligenceStrip />

      <div className={canFinance ? 'grid grid-cols-1 md:grid-cols-3 gap-4' : 'grid grid-cols-1 gap-4'}>
        {canFinance && (
          <KpiCard
            title={t.deliveredRevenue}
            rule="مجموع المحصَّل فعلاً للطلبات اللي انحصّلت، زائد إجمالي الطلبات الموصَّلة اللي ما انسجّل إلها تحصيل. الموصَّل وحده، وبالمدّة المختارة فوق."
            value={<Money value={fin.deliveredRevenue} />}
            subtitle={`${counts.delivered} طلب موصّل`}
            icon={RiArrowUpCircleLine}
            goodWhen="rising"
            href={linkTo("/orders?state=DELIVERED")}
          />
        )}

        <KpiCard
          title="نسبة الإرجاع"
          rule="المرجَّع ÷ اللي بتّ فيه الباب (موصَّل + فاشل + مرجَّع). مش مقسوم على المُنشَأ: طلب لسّا بالفان ما فشل، وحسابه كان بينزّل النسبة كلّ ما سرّعنا الإدخال."
          value={vitals?.door.returnRate === null || vitals === undefined ? '—' : `${vitals.door.returnRate}%`}
          subtitle={`${vitals?.door.returned ?? 0} / ${vitals?.door.decided ?? 0} طلب بتَّ فيه الباب`}
          icon={RiInboxUnarchiveLine}
          health={verdicts.returnRate}
          goodWhen="falling"
          href={linkTo("/ops/returns")}
        />

        {canFinance && (
          <KpiCard
            title="لم يُحصَّل بعد"
            rule="مجموع مبالغ الطلبات الموصَّلة اللي ما وصل تحصيلها للمحفظة بعد. موصَّل وغير محصَّل بس — لا المشحون ولا المرجَّع."
            value={<Money value={vitals?.outstanding.money ?? 0} />}
            /**
             * «كل المدة» is not filler — it is the one figure that ignores the dates above it, and it says so. Money a courier owes
             * us is owed whatever month the order was typed in.
             */
            subtitle={
              `${vitals?.outstanding.orders ?? 0} طلب مسلَّم بانتظار التحصيل — كل المدة` +
              (vitals?.outstanding.unrecordedOrders
                ? ` · و${vitals.outstanding.unrecordedOrders} مسلَّم بلا حالة تحصيل مكتوبة`
                : '')
            }
            icon={RiHandCoinLine}
            href={linkTo("/finance/collection")}
          />
        )}
      </div>

      {/* ─── Order Status Tiles ─── */}
      <div className="grid grid-cols-4 sm:grid-cols-7 gap-3">
        {statusTiles.map((s) => (
          <StatTile
            key={s.label}
            label={
              <span className="inline-flex items-center gap-1.5">
                <span className={`inline-block w-2 h-2 rounded-full ${s.dot}`} aria-hidden />
                {s.label}
              </span>
            }
            value={<span className={s.value > 0 ? s.color : 'text-[var(--sys-border-strong)]'}>{s.value}</span>}
            /* Only the tile that has a bar carries one: a count of new orders is neither good nor bad. */
            caption={s.health && <HealthChip health={s.health} />}
          />
        ))}
      </div>

      {/* ─── Where every order ended up, in the owner's words ───
          The whole history, not the dates above: the server counts it (order-outcome.ts) and this only draws the rows it sends. */}
      {analytics?.outcomes?.outcomes?.length > 0 && (
        <Card>
          <CardHeader
            title="حالات الطلبات — كل التاريخ"
            action={
              mayOpen('/orders') ? (
                <Link href="/orders?state=CLOSED" className="tap-safe text-sm text-[var(--sys-primary)] font-medium hover:underline">
                  الطلبات المغلقة
                </Link>
              ) : undefined
            }
          />
          <ul className="divide-y divide-[var(--sys-border)]">
            {analytics.outcomes.outcomes.map((r: { key: string; label: string; count: number; closed: boolean }) => (
              <li key={r.key} className="flex items-center justify-between px-4 py-2.5 text-sm">
                <span className="flex items-center gap-2">
                  <span className={`inline-block w-2 h-2 rounded-full ${r.closed ? 'bg-[var(--sys-success)]' : 'bg-[var(--sys-warning)]'}`} />
                  <span className="text-[var(--sys-heading)]">{r.label}</span>
                </span>
                <span className="font-bold tabular-nums">{plainNumber(r.count)}</span>
              </li>
            ))}
            <li className="flex items-center justify-between px-4 py-2.5 text-sm bg-[var(--sys-surface)]">
              <span className="font-semibold">المجموع</span>
              <span className="font-black tabular-nums">{plainNumber(analytics.outcomes.total)}</span>
            </li>
          </ul>
        </Card>
      )}
    </>
  );
}

/** The moderators' leaderboard, as it stood on «اليوم» (R9 moved it): the server sends it only to the key of a screen that shows colleagues. */
function ModeratorLeaderboard({
  rows,
  canFinance,
}: {
  rows?: { id: string; name: string; totalOrders: number; confirmedOrders: number; confirmationRate: number; sales: number }[];
  canFinance: boolean;
}) {
  const { t } = useApp();
  const mayOpen = useMayOpen();
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <RiAwardLine className="w-4 h-4 text-[var(--sys-warning)]" />
            {t.moderatorLeaderboard}
          </span>
        }
        action={
          /* The card stays; only the way OUT of it goes, for whoever would land on «لا تملك صلاحية لهذه الشاشة». */
          mayOpen('/admin/users') ? (
            <Link href="/admin/users" className="tap-safe inline-flex items-center gap-1 text-sm text-[var(--sys-destructive)] font-medium hover:underline">
              الفريق
              <RiArrowRightLine className="icon-mirror h-4 w-4" aria-hidden />
            </Link>
          ) : undefined
        }
      />
      <CardContent className="p-0">
        <div className="divide-y divide-[var(--sys-border)]">
          {rows?.map((mod, idx) => (
            <div key={mod.id} className="px-6 py-3 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span
                  className={`w-7 h-7 rounded-full text-note font-black flex items-center justify-center ${
                    idx === 0
                      ? 'bg-[var(--sys-warning-soft)] text-[var(--sys-warning)] ring-2 ring-[var(--sys-warning)]/60'
                      : idx === 1
                      ? 'bg-[var(--sys-border)] text-[var(--sys-foreground)]'
                      : 'bg-[var(--sys-surface)] text-[var(--sys-muted-foreground)]'
                  }`}
                >
                  {idx + 1}
                </span>
                <div>
                  <p className="text-sm font-bold text-[var(--sys-heading)]">
                    <PersonNameLink id={mod.id} name={mod.name} />
                  </p>
                  <p className="text-note text-[var(--sys-muted)]">
                    {mod.totalOrders} طلب • {mod.confirmedOrders}{' '}
                    مؤكد
                  </p>
                </div>
              </div>
              <div className="text-end">
                <span className="text-note font-bold text-[var(--sys-success)] bg-[var(--sys-success-soft)] border-0 px-2 py-0.5 rounded-full">
                  {mod.confirmationRate}%
                </span>
                {canFinance && (
                  <p className="text-note font-semibold text-[var(--sys-foreground)] mt-1" dir="ltr">
                    <Money value={mod.sales} />
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
