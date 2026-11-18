'use client';

import React, { useState, useRef, useCallback } from 'react';
import { Card, CardContent, KpiCard } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { CreateOrderModal } from '@/components/orders/CreateOrderModal';
import { AiOrderModal } from '@/components/orders/AiOrderModal';
import { useApp } from '@/context/AppContext';
import { canAccessRoute, findRoute } from '@/lib/route-registry';
import { userCan } from '@/lib/can';
import { apiFetch, saidBy } from '@/lib/api-client';
import { EmptyState } from '@/components/ui/EmptyState';
import { RiAddCircleLine, RiMagicLine, RiPercentLine, RiTruckLine, RiWallet3Line } from '@remixicon/react';
import { Money } from '@/components/ui/Money';
import { PageShell } from '@/components/ui/PageShell';
import { DateRange, FIVE_OPTIONS, presetRange, toQuery, validRange, type DateOption, type Range } from '@/components/ui/DateRange';
import { DetailsLink } from '@/components/dashboard/DetailsLinks';
import { WorkToday } from '@/components/dashboard/WorkToday';
import { DailyChart } from '@/components/dashboard/DailyChart';
import { healthOf } from '@/lib/health';
import type { Trust } from '@/lib/cod-vitals';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { SkeletonRows } from '@/components/ui/Skeleton';

/**
 * «اليوم» — THREE NUMBERS, WHAT NEEDS YOU NOW, ONE CHART (R9, plan 17/11).
 *
 * The owner's «واجهة 2»: the dashboard had grown to some thirty boxes — six figures, seven state tiles, the whole history's
 * outcomes, the product ranking, the loss reasons, the leaderboard, the intelligence strip — and somebody who sat down to ask
 * «كيف حالي هلق» had to read all of them. It opens now on three figures for the chosen period, the one list of what is waiting for
 * this person, and one chart of the period's days. EVERYTHING ELSE MOVED, NOTHING WAS DROPPED: every block that left is drawn on the
 * performance board (`PerformanceScreen`, the section «من لوحة التحكم»), the same component with the same door, one press away
 * through «التفاصيل».
 */

/** The ready ranges of the date box, in the order it offers them (everything but the picked span). */
const PRESETS = FIVE_OPTIONS.filter((o): o is Exclude<DateOption, 'custom'> => o !== 'custom');

export function DashboardScreen() {
  const { t, currentUser } = useApp();

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

  /**
   * THE PERIOD — THE KIT'S DATE BOX, ITS FIVE OPTIONS (R9).
   *
   * «اليوم» is the STORE's day: the chart's answer carries the store's clock (`timezone`), and from then on every preset is read
   * on it. Clearing the box goes back to «اليوم» — this screen has no «كل التاريخ» any more (the performance board keeps the long
   * windows). «هذا الشهر» and «الكل» left with the old buttons.
   */
  const [timeZone, setTimeZone] = useState<string | undefined>(undefined);
  const [option, setOption] = useState<DateOption>('today');
  const [picked, setPicked] = useState<Range | null>(null);
  const range: Range = option === 'custom' && picked ? picked : presetRange(option === 'custom' ? 'today' : option, new Date(), timeZone)!;
  const choose = (next: Range) => {
    if (!validRange(next)) {
      setOption('today');
      setPicked(null);
      return;
    }
    const preset = PRESETS.find((o) => {
      const r = presetRange(o, new Date(), timeZone)!;
      return r.from === next.from && r.to === next.to;
    });
    setOption(preset ?? 'custom');
    setPicked(preset ? null : next);
  };

  /**
   * THE PERIOD AS `/api/analytics` READS IT — the door is not changed.
   *
   * «اليوم» and «أمس» are the same days by name on both sides, and travel as the name, exactly as before. «آخر 7 أيام» and
   * «آخر 30 يوم» travel as their DAYS (the door's own `7d` is eight days and its `30d` thirty-one — `periodOf` in the kit) with
   * their name beside them, so the server still compares them with the window before. A picked span travels as days alone: there
   * is no named window before it to compare with.
   */
  const period = option === 'custom' ? 'all' : option;
  const days = option === 'today' || option === 'yesterday' ? '' : `&${toQuery(range)}`;

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
      // A REPORT: it runs in the reports lane (six connections) beside the performance board's, so it may wait its turn — a minute, as the
      // board does (`BOARD_WAIT_MS` in PerformanceScreen), not the fifteen seconds every ordinary call gets.
      const res = await apiFetch(`/api/analytics?period=${period}${days}`, { timeoutMs: 60_000 });
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
        setRefusal({ status: 0, said: e instanceof Error && /[؀-ۿ]/.test(e.message) ? e.message : 'تعذّر الاتصال. تحقق من الشبكة وأعد المحاولة.' });
      }
    } finally {
      // Only the latest request may clear the shared loading flag
      if (seq === loadAnalyticsSeq.current) setLoading(false);
    }
  }, [period, days]);
  // Live at thirty seconds, for every period this screen offers (the whole history, which was asked every two minutes, left it).
  useLiveRefresh(loadAnalytics, { everyMs: 30_000, key: `${period}${days}` });

  /**
   * NOTHING IS DRAWN AS A NUMBER BEFORE THE SERVER HAS SENT ONE.
   *
   * `loading` was written on every request and read by nobody, so until the first answer the board painted «٠ طلب»،
   * «٠٪» and «٠ دينار» from the fallbacks below, and then changed them — a lie for the length of a request, on the
   * screen people decide from. Waiting is no analytics AND no refusal: a refusal has its own card above, and an
   * earlier answer keeps standing while a poll is in flight (the next one replaces it without a flash).
   */
  const waiting = !analytics && !refusal;

  const fin = analytics?.financials ?? { netProfit: 0, profitMargin: 0 };
  const counts = analytics?.ordersCount ?? { total: 0, confirmed: 0, delivered: 0 };
  const rates = analytics?.rates ?? { confirmationRate: 0, deliveryRate: 0 };

  /**
   * The cost verdict and the expenses count, as the server sent them — typed here and nowhere recomputed. `cost` is not a
   * number: it is the verdict on whether the figures that REST on a cost may be printed, and it travels with them.
   */
  const vitals = analytics?.vitals as { cost: Trust; expenses: { rows: number } } | undefined;

  /**
   * WHETHER THE PROFIT LINE MAY BE SAID OUT LOUD AT ALL.
   *
   * On the live database it may not: cost of goods is recorded on 4 of 119
   * delivered orders, and the margin that came out of that was 76.93% —
   * which is revenue with the word «ربح» over it.
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
    option === 'today' ? 'أمس'
    : option === 'yesterday' ? 'اليوم اللي قبله'
    : option === '7d' ? 'الأسبوع السابق'
    : option === '30d' ? 'الثلاثين السابقة'
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
    confirmationRate: against(rates.confirmationRate, prevRaw?.confirmationRate, (n) => `${n}%`),
    deliveryRate: against(rates.deliveryRate, prevRaw?.deliveryRate, (n) => `${n}%`),
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
   * out loud rather than dressing it as «متوسط». The money figure carries
   * no sample — a margin is a ratio of money, not of observations.
   */
  const verdicts = {
    confirmationRate: healthOf('confirmationRate', rates.confirmationRate, counts.decided ?? counts.total),
    deliveryRate: healthOf('deliveryRate', rates.deliveryRate, counts.confirmed),
    profitMargin: healthOf('profitMargin', fin.profitMargin),
  };

  const dateBox = (
    <div className="w-56">
      <DateRange value={range} onChange={choose} options={FIVE_OPTIONS} timeZone={timeZone} label="اليوم" />
    </div>
  );

  // The numbers were refused or failed and there is nothing earlier to show: say so,
  // rather than drawing «٠» under every tile as if the shop had sold nothing.
  if (refusal && !analytics) {
    return (
      <PageShell title={t.dashboard} width="wide">
        <Card>
          <CardContent>
            <EmptyState
              title={refusal.status === 403 ? 'لا تملك صلاحية «عرض التقارير»' : 'تعذّر تحميل أرقام لوحة التحكم'}
              why={refusal.status === 403 ? 'أرقام لوحة التحكم تُقرأ بصلاحية «عرض التقارير». اطلبها من مدير النظام.' : refusal.said}
              action={refusal.status === 403 ? undefined : { label: 'إعادة المحاولة', onClick: () => void loadAnalytics() }}
            />
          </CardContent>
        </Card>
      </PageShell>
    );
  }

  return (
    <>
      <PageShell
        title={t.dashboard}
        width="wide"
        description="ثلاث أرقام للمدة، اللي بدّو إياك هلق، ورسم الطلبات كل يوم"
        toolbar={dateBox}
        actions={
          <div className="flex min-w-0 items-center gap-2 flex-wrap">
            {/* Everything that left this screen is on the performance board (see `DetailsLinks`). */}
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
          </div>
        }
      >
        {/* ─── THE THREE NUMBERS, IN ONE ROW ───
            The profit, and the two rates the phone room and the couriers are run on. The other figures (the delivered revenue,
            the return rate, what is still with the couriers) moved WITH their rules to the performance board. Without «عرض
            المالية» the profit card is not drawn, and the row is two. One column on a phone: a money figure does not fit half a
            phone's width. */}
        {waiting ? (
          <div aria-busy={loading}>
            <SkeletonRows rows={3} />
          </div>
        ) : (
        <div className={canFinance ? 'grid grid-cols-1 md:grid-cols-3 gap-4' : 'grid grid-cols-1 md:grid-cols-2 gap-4'}>
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
        </div>
        )}

        {/* ─── «بدّو إياك هلق»: THE ONE LIST OF WHAT IS WAITING FOR THIS PERSON ───
             The server scopes it by permission; it draws nothing for a person with no kind of work, and nothing until the
             server has answered. It opens with «مهمّتك الجاية» — one sentence and one button. */}
        <WorkToday />

        {/* ─── THE ONE CHART: the period's orders, day by day, on the store's clock. ─── */}
        <DailyChart range={range} onTimeZone={setTimeZone} />
      </PageShell>

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
