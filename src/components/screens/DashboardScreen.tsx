'use client';

import { plainNumber } from '@/lib/format';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Card, CardHeader, CardContent, KpiCard } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { CreateOrderModal } from '@/components/orders/CreateOrderModal';
import { AiOrderModal } from '@/components/orders/AiOrderModal';
import { useApp } from '@/context/AppContext';
import { canAccessRoute, findRoute } from '@/lib/route-registry';
import { userCan } from '@/lib/can';
import { TEAM_PERMISSIONS } from '@/lib/ai-assistants';
import { apiFetch, saidBy } from '@/lib/api-client';
import { EmptyState } from '@/components/ui/EmptyState';
import Link from 'next/link';
import { RiAddCircleLine, RiArrowRightLine, RiArrowUpCircleLine, RiAwardLine, RiCloseCircleLine, RiFireLine, RiHandCoinLine, RiInboxUnarchiveLine, RiPercentLine, RiMagicLine, RiShoppingBagLine, RiTruckLine, RiWallet3Line } from '@remixicon/react';
import { Money } from '@/components/ui/Money';
import { IntelligenceStrip } from '@/components/growth/IntelligenceStrip';
import { PageHeader } from '@/components/ui/PageHeader';
import { DetailsLink } from '@/components/dashboard/DetailsLinks';
import { PersonNameLink, ProductNameLink } from '@/components/dashboard/NameLinks';
import { LossPanel } from '@/components/dashboard/LossPanel';
import { WorkToday } from '@/components/dashboard/WorkToday';
import { healthOf, type Health } from '@/lib/health';
import { HealthChip } from '@/components/ui/HealthChip';
import type { Trust } from '@/lib/cod-vitals';
import { STATE_TONE, type CoreState } from '@/lib/order-state';
import { TONE_DOT, TONE_TEXT } from '@/components/ui/StatusChip';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';

const PERIODS = [
  { key: 'today', ar: 'اليوم' },
  { key: '7d', ar: '7 أيام' },
  { key: '30d', ar: '30 يوم' },
  { key: 'month', ar: 'هذا الشهر' },
  { key: 'all', ar: 'الكل' },
] as const;

export function DashboardScreen() {
  const { t, isRtl, currentUser } = useApp();

  /**
   * A LINK IS A PROMISE THAT CLICKING LEADS SOMEWHERE.
   *
   * `notification.ts` already says this, and drops a link the recipient's
   * own guard would refuse. This screen did not: signed in as a moderator,
   * its cards offered «طابور التأكيد»، «متابعة الشحن»، «المرتجعات» and
   * «الموظفون», and every one of them landed on «لا تملك صلاحية لهذه
   * الشاشة».
   *
   * The rule is not written a second time here. `canAccessRoute` takes the
   * permission check as a PARAMETER precisely so the sidebar can pass the
   * server's `can` and a screen can pass the client's `userCan`.
   */
  const mayOpen = (path: string): boolean => {
    if (!currentUser) return false;
    const route = findRoute(path.split('?')[0]);
    return !!route && canAccessRoute(currentUser, route, userCan);
  };
  /** The href, or nothing — a card with no link is still a card. */
  const linkTo = (path: string): string | undefined => (mayOpen(path) ? path : undefined);
  const canFinance = userCan(currentUser, 'finance.view');
  /** The rankings and the loss reasons are smart cards (PR-10): the server sends them to this key only. */
  const canInsights = userCan(currentUser, 'insights.view');
  const maySeeColleagues = TEAM_PERMISSIONS.some((p) => userCan(currentUser, p));

  const [period, setPeriod] = useState<'today' | '7d' | '30d' | 'month' | 'all'>('all');
  const [analytics, setAnalytics] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  /** Why the numbers did not come: a refusal or a failure, said — never drawn as zeros. */
  const [refusal, setRefusal] = useState<{ status: number; said: string } | null>(null);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [aiModalOpen, setAiModalOpen] = useState(false);

  // Monotonic request counter — stale (out-of-order) analytics responses are
  // discarded so an older poll can never overwrite a newer result
  const loadAnalyticsSeq = useRef(0);

  const loadAnalytics = useCallback(async () => {
    const seq = ++loadAnalyticsSeq.current;
    setLoading(true);
    try {
      const res = await apiFetch(`/api/analytics?period=${period}`);
      if (seq !== loadAnalyticsSeq.current) return; // stale — discard
      if (res.ok) {
        setRefusal(null);
        setAnalytics(await res.json());
      } else {
        // A refusal means the numbers are not ours to show: whatever an earlier poll left goes too.
        if (res.status === 403) setAnalytics(null);
        const said = await saidBy(res, 'تعذّر تحميل أرقام لوحة التحكم. أعد المحاولة بعد قليل.');
        if (seq === loadAnalyticsSeq.current) setRefusal({ status: res.status, said });
      }
    } catch (e) {
      console.error(e);
      // A dropped connection is not «٠ طلب»: say the numbers did not come (status 0 = no answer at all).
      if (seq === loadAnalyticsSeq.current) {
        setRefusal({ status: 0, said: e instanceof Error && /[\u0600-\u06FF]/.test(e.message) ? e.message : 'تعذّر الاتصال. تحقق من الشبكة وأعد المحاولة.' });
      }
    } finally {
      // Only the latest request may clear the shared loading flag
      if (seq === loadAnalyticsSeq.current) setLoading(false);
    }
  }, [period]);
  /*
   * These twelve lines were written here, in the orders list and in the
   * WhatsApp inbox — three copies of one idea, while fifty-four other
   * screens had none of it. They are `useLiveRefresh` now, which also
   * catches coming back to the WINDOW and not only to the tab: alt-tab
   * fires `focus` and not `visibilitychange`, and that is most of a
   * working day on a desk.
   */
  // «الكل» reads the whole history (see `reportRange`), so it is asked for
  // every two minutes; a named period stays live at thirty seconds.
  useLiveRefresh(loadAnalytics, { everyMs: period === 'all' ? 120_000 : 30_000, key: period });

  const fin = analytics?.financials ?? {
    deliveredRevenue: 0, costOfGoodsSold: 0, shippingCosts: 0,
    commission: 0, operationalExpenses: 0, netProfit: 0, profitMargin: 0,
  };
  const counts = analytics?.ordersCount ?? {
    total: 0, new: 0, contacting: 0, confirmed: 0,
    postponed: 0, rejected: 0, shipped: 0, delivered: 0,
  };
  const rates = analytics?.rates ?? { confirmationRate: 0, deliveryRate: 0 };

  /**
   * THE COD VITALS, AS THE SERVER SENT THEM.
   *
   * Typed here and nowhere recomputed. Two of these are money — what is
   * still owed to us — and money is the server's to compute: the one COD
   * function decides what a parcel was worth, and a browser adding figures
   * up a second time is how two screens come to disagree about one debt.
   *
   * `cost` is not a number at all. It is the verdict on whether the figures
   * that REST on a cost may be printed, and it travels with them so no
   * screen has to remember which ones those are.
   */
  const vitals = analytics?.vitals as
    | {
        door: { delivered: number; failed: number; returned: number; decided: number; returnRate: number | null; failureRate: number | null };
        cost: Trust;
        expenses: { rows: number };
        outstanding: { orders: number; money: number; unrecordedOrders: number };
      }
    | undefined;

  /**
   * WHETHER THE PROFIT LINE MAY BE SAID OUT LOUD AT ALL.
   *
   * On the live database it may not: cost of goods is recorded on 4 of 119
   * delivered orders, and the margin that came out of that was 76.93% —
   * which is revenue with the word «ربح» over it. Every product row on the
   * performance screen read between 76% and 82% for the same reason, and a
   * grade that comes out the same for everybody is the precise shape of the
   * failure that killed the intelligence layer in this product.
   *
   * So the tile shows «—» and says which field is empty, rather than a
   * confident figure somebody would price against. The link behind it still
   * goes to the profit screen, because the point is to get the cost typed
   * in, not to hide the subject.
   */
  const costTrust = vitals?.cost;
  const profitStated = costTrust ? costTrust.level !== 'WITHHELD' : false;
  // An empty expenses table is a second hole in the same figure, and it has
  // no per-order denominator to be a coverage share of — so it is named
  // beside the margin rather than folded into the gate.
  const noExpenses = (vitals?.expenses.rows ?? 0) === 0;


  // Was a hardcoded «$» with a locale's own grouping. The store may be
  // Jordanian or Syrian, and `<Money>` knows which it is.
  const fmt = (n: number) => <Money value={n} />;

  /**
   * THE PREVIOUS PERIOD, SHAPED FOR THE CARD.
   *
   * The card wants a value, a label naming the period, and which way it
   * moved. The DIRECTION is computed here rather than sent, because the
   * server would have to know which way is good for each figure — and
   * `goodWhen` already says that at each call site, once.
   */
  const priorLabel =
    period === 'today' ? 'أمس'
    : period === '7d' ? 'الأسبوع السابق'
    : period === '30d' ? 'الثلاثين السابقة'
    : period === 'month' ? 'الشهر الماضي'
    : 'الفترة السابقة';

  const against = (now: number, before: number | undefined, render: (n: number) => React.ReactNode) => {
    if (before === undefined || before === null) return undefined;
    const direction = now > before ? ('up' as const) : now < before ? ('down' as const) : ('flat' as const);
    // A percentage of a zero base is not a percentage. Say the two figures
    // and let the arrow carry the direction.
    const change =
      before > 0 && now !== before ? `${Math.abs(Math.round(((now - before) / before) * 100))}%` : undefined;
    return { value: render(before), label: priorLabel, direction, change };
  };

  const prevRaw = analytics?.previous ?? null;
  const prev = {
    netProfit: against(fin.netProfit, prevRaw?.netProfit, (n) => fmt(n)),
    deliveredRevenue: against(fin.deliveredRevenue, prevRaw?.deliveredRevenue, (n) => fmt(n)),
    confirmationRate: against(rates.confirmationRate, prevRaw?.confirmationRate, (n) => `${n}%`),
    deliveryRate: against(rates.deliveryRate, prevRaw?.deliveryRate, (n) => `${n}%`),
    // The one comparison on this screen where DOWN is the good direction, so
    // the card is told so at its own call site — the same rule the four
    // above follow, and the reason `against` does not decide it here.
    returnRate: against(vitals?.door.returnRate ?? 0, prevRaw?.returnRate ?? undefined, (n) => `${n}%`),
  };

  /**
   * WHERE EACH FIGURE SITS AGAINST THE BAR.
   *
   * The arrow beside a KPI answers «did it move». Nobody opens this screen
   * to ask that — they open it to ask «هل نحن بخير», and a delivery rate
   * can rise three points and still be under the bar, with a green arrow
   * over it saying the opposite.
   *
   * The sample goes with the rate, because a rate over four orders is not a
   * rate: `healthOf` refuses to judge below the floor and says «لا يكفي»
   * out loud rather than dressing it as «متوسط». The two money figures
   * carry no sample — a margin is a ratio of money, not of observations.
   */
  const verdicts = {
    confirmationRate: healthOf('confirmationRate', rates.confirmationRate, counts.decided ?? counts.total),
    deliveryRate: healthOf('deliveryRate', rates.deliveryRate, counts.confirmed),
    profitMargin: healthOf('profitMargin', fin.profitMargin),
    rejectionRate: healthOf(
      'rejectionRate',
      (counts.decided ?? counts.total) > 0 ? (counts.rejected / (counts.decided ?? counts.total)) * 100 : null,
      counts.decided ?? counts.total
    ),
    /**
     * THE RETURN RATE, AGAINST THE BAR THAT ALREADY EXISTED FOR IT.
     *
     * `health.ts` has carried a `returnRate` bar — 8% good, 15% acceptable —
     * since before any screen showed a return rate. The measured shop is at
     * 22% over 153 decided parcels, which is «ضعيف» with a sample far above
     * the floor: not a quiet quarter, a leak.
     *
     * The sample is what the DOOR decided, not orders created. An order
     * still in a van has not failed, and counting it would make this rate
     * fall every time intake sped up.
     */
    returnRate: healthOf('returnRate', vitals?.door.returnRate ?? null, vitals?.door.decided),
  };

  /*
   * THE COLOUR COMES FROM THE STATE, NOT FROM THIS SCREEN.
   *
   * These seven tiles chose their own, and three of them disagreed with
   * `STATE_TONE`: NEW, CONTACTING and SHIPPED were painted with the accent
   * while the owner calls all three `neutral` — and `order-state.ts` rules
   * that out by name: «there is no informational blue — the action colour
   * is already in the blue family, and a chip painted the same family as a
   * button is a chip people try to press». A person reading «مشحون» in the
   * accent here and in plain foreground on the orders list is reading two
   * different claims about the same parcel.
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

  // The icon is a COMPONENT, not a character. An emoji here was drawn by
  // the operating system: a flat outline on this desk, a gradient sticker
  // on the phone in the warehouse, and neither one the colour of the card
  // it sits in.
  // And each row reuses the icon this screen ALREADY spends on that idea:
  // the bag is an order here and on the orders card, the wallet is profit
  // here and in the net-profit tile, the truck is a delivery in both. Four
  // new drawings would have been four more concepts for the same four.
  const rankings: {
    icon: typeof RiShoppingBagLine;
    label: string;
    name?: string;
    /** The product's id — what makes the name a link. */
    id?: string;
    value: React.ReactNode;
    tint: string;
    text: string;
  }[] = [
    { icon: RiShoppingBagLine, label: 'الأكثر طلباً', name: analytics?.rankings?.mostRequested?.name, id: analytics?.rankings?.mostRequested?.id, value: `${analytics?.rankings?.mostRequested?.totalOrders ?? 0} طلب`, tint: 'bg-[var(--sys-surface)] border-[var(--sys-primary-soft)]', text: 'text-[var(--sys-primary)]' },
    /**
     * «الأكثر ربحاً» ONLY WHERE A PROFIT WAS ACTUALLY MEASURED.
     *
     * Two things were wrong with this row and they compounded. It printed
     * `+$` and a raw float — a hardcoded dollar sign on a shop that may be
     * Jordanian or Syrian, with none of `<Money>`'s grouping or minor unit.
     * And with cost recorded on 4 of 119 delivered orders, ranking by profit
     * is ranking by revenue: measured on all three stores in the database,
     * «الأكثر ربحاً» named the SAME product as «الأكثر توصيلاً» every time.
     *
     * So it names a product when the cost data can support the word, and
     * says which field is empty when it cannot.
     */
    // A product's profit is money: without «عرض المالية» the tile is not drawn at all.
    ...(!canFinance ? [] : [profitStated
      ? { icon: RiWallet3Line, label: 'الأكثر ربحاً', name: analytics?.rankings?.mostProfitable?.name, id: analytics?.rankings?.mostProfitable?.id, value: fmt(analytics?.rankings?.mostProfitable?.netProfit ?? 0), tint: 'bg-[var(--sys-success-soft)]', text: 'text-[var(--sys-success)]' }
      : { icon: RiWallet3Line, label: 'الأكثر ربحاً', name: undefined, value: 'كلفة البضاعة غير مسجَّلة', tint: 'bg-[var(--sys-surface)] border-[var(--sys-border)]', text: 'text-[var(--sys-muted-foreground)]' }]),
    { icon: RiTruckLine, label: 'الأكثر توصيلاً', name: analytics?.rankings?.mostDelivered?.name, id: analytics?.rankings?.mostDelivered?.id, value: `${analytics?.rankings?.mostDelivered?.deliveredOrders ?? 0} توصيل`, tint: 'bg-[var(--sys-warning-soft)] border-[var(--sys-warning)]/30', text: 'text-[var(--sys-warning)]' },
    { icon: RiCloseCircleLine, label: 'الأكثر رفضاً', name: analytics?.rankings?.highestRejection?.name, id: analytics?.rankings?.highestRejection?.id, value: `${analytics?.rankings?.highestRejection?.rejectedOrders ?? 0} رفض`, tint: 'bg-[var(--sys-destructive-soft)] border-[var(--sys-destructive-border)]', text: 'text-[var(--sys-destructive)]' },
  ];

  // The numbers were refused or failed and there is nothing earlier to show: say so,
  // rather than drawing «٠» under every tile as if the shop had sold nothing.
  if (refusal && !analytics) {
    return (
      <div className="space-y-6">
        <PageHeader title={t.dashboard} />
        <Card>
          <CardContent>
            <EmptyState
              title={refusal.status === 403 ? 'لا تملك صلاحية «عرض التقارير»' : 'تعذّر تحميل أرقام لوحة التحكم'}
              why={refusal.status === 403 ? 'أرقام لوحة التحكم تُقرأ بصلاحية «عرض التقارير». اطلبها من مدير النظام.' : refusal.said}
              action={refusal.status === 403 ? undefined : { label: 'إعادة المحاولة', onClick: () => void loadAnalytics() }}
            />
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-6">
        {/* ─── Header ─── */}
        <PageHeader title={t.dashboard}
            description="متابعة المبيعات والتكاليف وأداء الفريق والأرباح الحقيقية — لحظة بلحظة"
            actions={
              <><div className="flex min-w-0 items-center gap-2 flex-wrap">
            {/* Period selector */}
            <div className="bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg p-1 flex text-xs font-medium text-[var(--sys-foreground)] shadow-raised">
              {PERIODS.map((p) => (
                <button
                  key={p.key}
                  onClick={() => setPeriod(p.key)}
                  className={`flex h-11 items-center px-3 md:h-auto md:py-1.5 rounded-lg transition-colors cursor-pointer ${
                    // Chosen, not lost. This was the colour that means
                    // "late, or money lost", used to mean "selected".
                    period === p.key ? 'bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] font-bold shadow-raised' : 'hover:bg-[var(--sys-surface)]'
                  }`}
                >
                  {p.ar}
                </button>
              ))}
            </div>

            {/* The performance board is the DETAIL of this screen (see `DetailsLinks`). */}
            <DetailsLink />

            {/* Both open the order-creation door, which asks «إنشاء طلب»; without
                it they were buttons whose form always failed. */}
            {userCan(currentUser, 'orders.create') && (
            <>
            <Button
              variant="outline"
              onClick={() => setAiModalOpen(true)}
              className="items-center gap-1.5 text-[var(--sys-primary)] border-[var(--sys-primary)]/35 hover:bg-[var(--sys-primary-soft)]"
            >
              <RiMagicLine className="w-4 h-4" />
              <span>إدخال بالذكاء الاصطناعي</span>
            </Button>

            <Button onClick={() => setCreateModalOpen(true)} className="bg-[var(--sys-destructive)] hover:bg-[var(--sys-destructive)]/85 items-center">
              <RiAddCircleLine className="w-4 h-4" />
              <span>طلب سريع</span>
            </Button>
            </>
            )}
          </div></>
            }
          />

        {/* ─── What is waiting for THIS person, before anything else ───
             «شغلك اليوم»: the counts the header chips hold, given room to say
             what each is for. It leads the page because the tiles below say
             how the month is going, and somebody who has just sat down needs
             to know what to do first. It opens with «مهمّتك الجاية» — one
             sentence and one button — and follows it with the grid. Draws
             nothing for a person with no kind of work, and nothing until the
             server has answered. */}
        <WorkToday />

        {/* ─── What needs a person, before what merely happened ───
             Above the KPIs on purpose: the tiles say how the month is
             going, and this says what is stuck right now. A dashboard
             that leads with the month is read once a month. */}
        <IntelligenceStrip />

        {/*
          ─── THE SIX NUMBERS A CASH-ON-DELIVERY SHOP IS RUN ON ───

          Four were here, and they were chosen before anybody read the data.
          Measured on the live database, two of them needed a gate and two
          more numbers were missing entirely:

            THE PROFIT AND ITS MARGIN came out at 76.93% — impossible in this
            trade, and produced by a cost of goods recorded on 4 of 119
            delivered orders against an empty expenses table. So the tile is
            GATED: it prints the figure when the cost data can carry it, and
            says which field is empty when it cannot. That is the whole lesson
            of the intelligence layer this product had to abandon, where every
            customer graded the same.

            THE RETURN RATE was nowhere in this product at all. 34 of 153
            parcels that reached a verdict at the door came back — 22% against
            a bar of 8% — and a return is the one loss in this trade that is
            billed twice, out and back.

            THE MONEY NOT YET COLLECTED was nowhere either. 2461.50 across 119
            delivered orders is sitting with couriers, which is to say ALL of
            the revenue the tile beside it reports as earned. A dashboard that
            prints «إيراد» and never prints «لم يُحصَّل» is describing a
            business that has been paid.

          The first four keep their order and their grid: they are what people
          already look for, and the two new ones sit under them rather than
          shouldering one of them out. The confirmation rate stays — at 97%
          over 165 decided orders it is «جيّد» every morning and teaches
          little, but it is the phone room's own figure and dropping it would
          leave that team without a number on the screen they open.
        */}
        {/*
          THE GRID FOLLOWS THE NUMBER OF CARDS, so no row ends half empty.

          Six cards (with finance) in four columns left a last row of two and
          two holes; three cards (without) left one hole. Six go three-by-two
          from `lg` and two-by-three below it; three go in a single row from
          `md`. One column on a phone: a money figure does not fit half a
          phone's width.
        */}
        <div className={canFinance ? 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4' : 'grid grid-cols-1 md:grid-cols-3 gap-4'}>
          {canFinance && (
            <KpiCard
              title={t.netProfit}
              rule="إيراد الطلبات الموصَّلة ناقص كلفة البضاعة ناقص أجور التوصيل ناقص العمولات ناقص المصاريف التشغيليّة المسجَّلة في المدّة. الموصَّل وحده يُحسَب — طلب في الفان ما إله ربح بعد. والمدّة هي المختارة فوق."
              value={profitStated ? fmt(fin.netProfit) : '—'}
              /**
               * When the figure is stated, the margin goes under it — and an
               * empty expenses table is named beside it, because subtracting
               * zero expenses and calling the result «صافي» is the same
               * silence in a different field. When it is withheld, the
               * subtitle is the reason, which names the field to go and fill.
               */
              subtitle={
                profitStated
                  ? `${t.profitMargin} ${fin.profitMargin}%${noExpenses ? ' — لا مصاريف مسجَّلة في هذه المدة' : ''}`
                  : costTrust?.ar
              }
              icon={RiWallet3Line}
              previous={profitStated ? prev.netProfit : undefined}
              health={profitStated ? verdicts.profitMargin : undefined}
              goodWhen="rising"
              href={linkTo("/finance/profit")}
            />
          )}

          {canFinance && (
            <KpiCard
              title={t.deliveredRevenue}
              rule="مجموع المحصَّل فعلاً للطلبات اللي انحصّلت، زائد إجمالي الطلبات الموصَّلة اللي ما انسجّل إلها تحصيل. الموصَّل وحده، وبالمدّة المختارة فوق."
              value={fmt(fin.deliveredRevenue)}
              subtitle={`${counts.delivered} طلب موصّل`}
              icon={RiArrowUpCircleLine}
              previous={prev.deliveredRevenue}
              goodWhen="rising"
              href={linkTo("/orders?state=DELIVERED")}
            />
          )}

          <KpiCard
            title={t.confirmationRate}
            rule="المؤكَّد ÷ (المؤكَّد + المرفوض). مقسوم على اللي **انبتّ فيه** لا على كلّ الطلبات — لأنّ القسمة على الكلّ بتحسب اللي ما حدا شافه بعد فشلاً، فالنسبة بتنزل كلّ ما زاد الإدخال. والمرفوض هو رفض تأكيد بس، مش طرد رجع."
            value={`${rates.confirmationRate}%`}
            subtitle={`${counts.confirmed} / ${counts.decided ?? counts.total} ${t.decidedOrders}`}
            icon={RiPercentLine}
            previous={prev.confirmationRate}
            health={verdicts.confirmationRate}
            goodWhen="rising"
            href={linkTo("/confirmation/queue") ?? linkTo("/confirmation/mine")}
          />

          <KpiCard
            title={t.deliveryRate}
            rule="الموصَّل ÷ المؤكَّد، بالمدّة المختارة فوق. المقام هو المؤكَّد لأنّ الطلب لازم يتأكّد قبل ما ينشحن."
            value={`${rates.deliveryRate}%`}
            subtitle={`${counts.delivered} / ${counts.confirmed} ${t.confirmedOrders}`}
            icon={RiTruckLine}
            previous={prev.deliveryRate}
            health={verdicts.deliveryRate}
            goodWhen="rising"
            href={linkTo("/ops/tracking")}
          />

          <KpiCard
            title="نسبة الإرجاع"
            rule="المرجَّع ÷ اللي بتّ فيه الباب (موصَّل + فاشل + مرجَّع). مش مقسوم على المُنشَأ: طلب لسّا بالفان ما فشل، وحسابه كان بينزّل النسبة كلّ ما سرّعنا الإدخال."
            value={vitals?.door.returnRate === null || vitals === undefined ? '—' : `${vitals.door.returnRate}%`}
            // Out of what the DOOR decided — delivered, failed and returned
            // — never out of orders created. An order still in a van has not
            // failed, and counting it would make this rate fall every time
            // intake sped up.
            subtitle={`${vitals?.door.returned ?? 0} / ${vitals?.door.decided ?? 0} طلب بتَّ فيه الباب`}
            icon={RiInboxUnarchiveLine}
            previous={prev.returnRate}
            health={verdicts.returnRate}
            goodWhen="falling"
            href={linkTo("/ops/returns")}
          />

          {canFinance && (
            <KpiCard
              title="لم يُحصَّل بعد"
              rule="مجموع مبالغ الطلبات الموصَّلة اللي ما وصل تحصيلها للمحفظة بعد. موصَّل وغير محصَّل بس — لا المشحون ولا المرجَّع."
              value={fmt(vitals?.outstanding.money ?? 0)}
              /**
               * «كل المدة» is not filler — it is the one figure on this screen
               * that ignores the period buttons above it, and it says so.
               * Money a courier owes us is owed whatever month the order was
               * typed in, and an exposure that shrank when somebody clicked
               * «اليوم» would be read as an exposure that shrank.
               *
               * No previous period beside it for the same reason: there is no
               * «last month's outstanding» to compare a standing debt with.
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
            <div key={s.label} className="bg-[var(--sys-card)] rounded-lg border border-[var(--sys-border)]/80 p-4 text-center shadow-raised">
              <span className={`inline-block w-2 h-2 rounded-full ${s.dot} mb-1.5`} />
              <span className="block text-xs font-semibold text-[var(--sys-muted-foreground)] leading-tight">{s.label}</span>
              <span className={`block text-xl font-black mt-1 ${s.value > 0 ? s.color : 'text-[var(--sys-border-strong)]'}`}>
                {s.value}
              </span>
              {/* Only the tile that has a bar carries one. A count of new
                  orders is neither good nor bad, and a chip on it would
                  teach people to ignore the chips that mean something. */}
              {s.health && (
                <span className="mt-1 block">
                  <HealthChip health={s.health} />
                </span>
              )}
            </div>
          ))}
        </div>

        {/* ─── Where every order ended up, in the owner's words ───
            The whole history, not the period above: the server counts it
            (order-outcome.ts) and this only draws the rows it sends. */}
        {analytics?.outcomes?.outcomes?.length > 0 && (
          <Card>
            <CardHeader
              title="حالات الطلبات — كل التاريخ"
              action={
                mayOpen('/orders') ? (
                  <Link href="/orders?state=CLOSED" className="tap-safe text-xs text-[var(--sys-primary)] font-medium hover:underline">
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

        {/* ─── Rankings + Leaderboard ─── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {canInsights && (
          <Card>
            <CardHeader
              title={
                <span className="flex items-center gap-2">
                  <RiFireLine className="w-4 h-4 text-[var(--sys-destructive)]" />
                  ترتيب المنتجات والأرباح
                </span>
              }
              action={
                mayOpen('/products') ? (
                  <Link href="/products" className="tap-safe inline-flex items-center gap-1 text-xs text-[var(--sys-destructive)] font-medium hover:underline">
                    المنتجات
                    {/* The same arrow, from the same set, mirrored the same way
                        as the one at line 219 — not the character ←, whose
                        weight and size are whatever the device's font says. */}
                    <RiArrowRightLine className="icon-mirror h-4 w-4" aria-hidden />
                  </Link>
                ) : undefined
              }
            />
            <CardContent className="space-y-2.5">
              {rankings.map((r) => (
                <div key={r.label} className={`flex items-center justify-between p-3 rounded-lg border ${r.tint}`}>
                  <div className="flex items-center gap-3">
                    <r.icon className={`h-5 w-5 shrink-0 ${r.text}`} aria-hidden />
                    <div>
                      {/* No `uppercase tracking-wide`: the label is Arabic, and
                          spacing a joined script out stops its letters touching. */}
                      <p className={`text-xs font-bold ${r.text}`}>{r.label}</p>
                      {/* THE NAME, RENDERED RATHER THAN SWALLOWED.
                          `productName` takes a product and reads `.name` off
                          it. This was handing it the name itself — a string,
                          which has no `.name` — so it returned '' and all
                          four ranking rows drew a blank line where the
                          product should be. Typing the array found it.
                          The analytics ranking carries one name and no
                          English alternative, so there is nothing to
                          resolve: it is printed. */}
                      <p className="text-sm font-bold text-[var(--sys-heading)] line-clamp-1">
                        {r.name ? <ProductNameLink id={r.id} name={r.name} /> : '—'}
                      </p>
                    </div>
                  </div>
                  {/* One node, already carrying its own unit — a <Money> for
                      the money row and a counted noun for the rest. It used
                      to be a prefix, a raw float and a suffix glued together,
                      and the prefix was a hardcoded «$» on a shop that may
                      be Jordanian or Syrian. */}
                  <span className={`text-sm font-black ${r.text}`}>{r.value}</span>
                </div>
              ))}
            </CardContent>
          </Card>
          )}

          {/*
            RIGHT AFTER «الأكثر رفضاً», because that card names the product
            and this one names the reason — and it takes the period the rest
            of the screen is already showing. No new route and no menu entry:
            the answer to «why are we losing orders» belongs on the screen
            somebody already opens to ask it.
          */}
          {canInsights && <LossPanel period={period} />}

          {/* Colleagues by name: only for the key of a screen that already shows
              them — the server sends no leaderboard to anyone else. */}
          {maySeeColleagues && (
          <Card>
            <CardHeader
              title={
                <span className="flex items-center gap-2">
                  <RiAwardLine className="w-4 h-4 text-[var(--sys-warning)]" />
                  {t.moderatorLeaderboard}
                </span>
              }
              action={
                /* The card stays; only the way OUT of it goes, for whoever
                   would land on «لا تملك صلاحية لهذه الشاشة». */
                mayOpen('/admin/users') ? (
                  <Link href="/admin/users" className="tap-safe inline-flex items-center gap-1 text-xs text-[var(--sys-destructive)] font-medium hover:underline">
                    الفريق
                    <RiArrowRightLine className="icon-mirror h-4 w-4" aria-hidden />
                  </Link>
                ) : undefined
              }
            />
            <CardContent className="p-0">
              <div className="divide-y divide-[var(--sys-border)]">
                {analytics?.moderatorLeaderboard?.map((mod: any, idx: number) => (
                  <div key={mod.id} className="px-6 py-3 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span
                        className={`w-7 h-7 rounded-full text-xs font-black flex items-center justify-center ${
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
                        <p className="text-xs text-[var(--sys-muted)]">
                          {mod.totalOrders} طلب • {mod.confirmedOrders}{' '}
                          مؤكد
                        </p>
                      </div>
                    </div>
                    <div className="text-end">
                      <span className="text-xs font-bold text-[var(--sys-success)] bg-[var(--sys-success-soft)] border-0 px-2 py-0.5 rounded-full">
                        {mod.confirmationRate}%
                      </span>
                      {canFinance && (
                        <p className="text-xs font-semibold text-[var(--sys-foreground)] mt-1" dir="ltr">
                          <Money value={mod.sales} />
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
          )}
        </div>

      </div>

      <CreateOrderModal
        isOpen={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        onSuccess={loadAnalytics}
      />
      <AiOrderModal
        isOpen={aiModalOpen}
        onClose={() => setAiModalOpen(false)}
        onSuccess={loadAnalytics}
      />
    </>
  );
}
