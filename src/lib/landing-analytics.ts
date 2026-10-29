import { db } from './db';
import { localDay, DEVICE_LABEL, type DeviceClass } from './landing-views';
import { pageVerdict, type Verdict } from './page-verdict';
import { notSuperseded } from './superseded';

/**
 * LANDING PAGE ANALYTICS FOR ONE DATE WINDOW — views, orders, conversion;
 * per page, per device, per campaign.
 *
 * Views come from the daily rows (landing_page_views); orders are the
 * orders that came through a landing page in the window, by the order's
 * own landingPageId, deviceClass and campaignId. The same window as every
 * other table on the performance screen.
 *
 * Conversion is orders ÷ views — and only the orders from days whose views
 * were counted. Views are counted from the day this shipped; a window that
 * reaches further back holds orders with no views behind them, and dividing
 * those by the views that were counted produced rates of 200%. So the
 * orders column is every order in the window, and the rate uses the ones
 * since counting began. With no counted views the rate is empty rather
 * than a number that is not true.
 */

export interface AnalyticsRow {
  key: string;
  label: string;
  hint?: string;
  views: number;
  orders: number;
  conversion: number | null;
}

/**
 * THE TWO COUNTS SIDE BY SIDE — the week of comparison before the page is cached.
 *
 * «ابني كاش الصفحة، وخلي العدّ بالطريقتين أسبوع قبل ما نبدّل». Only over the days the browser was counting too
 * (`since` onwards, inside the window): the server's rows reach back months, and comparing those with a week of the
 * browser's would show a «difference» that is only the calendar.
 */
export interface CountCheck {
  since: string;
  server: number;
  browser: number;
  byPage: { key: string; label: string; server: number; browser: number }[];
}

export interface LandingAnalytics {
  /** The first day views were counted for this store, or null if none yet. */
  countingSince: string | null;
  totals: AnalyticsRow;
  byPage: AnalyticsRow[];
  byDevice: AnalyticsRow[];
  byCampaign: AnalyticsRow[];
  /** The server's count beside the browser's — null until the browser has counted a first visit. */
  countCheck: CountCheck | null;
}

export function conversionOf(views: number, orders: number): number | null {
  if (views <= 0) return null;
  return Math.round((orders / views) * 1000) / 10;
}

/** A local "yyyy-MM-dd" as the Date a DATE column compares with. */
const asDateColumn = (day: string) => new Date(`${day}T00:00:00.000Z`);

function row(key: string, label: string, views: number, orders: number, ordersCounted: number, hint?: string): AnalyticsRow {
  return { key, label, ...(hint ? { hint } : {}), views, orders, conversion: conversionOf(views, ordersCounted) };
}

/** Busiest first: the rows a seller acts on are the ones with traffic. */
const byWeight = (a: AnalyticsRow, b: AnalyticsRow) => b.orders - a.orders || b.views - a.views || a.label.localeCompare(b.label);

export async function landingAnalytics(scope: {
  companyId: string;
  storeId: string;
  start: Date;
  end: Date;
}): Promise<LandingAnalytics> {
  const { companyId, storeId, start, end } = scope;
  const viewWhere = {
    companyId,
    storeId,
    day: { gte: asDateColumn(localDay(start)), lte: asDateColumn(localDay(end)) },
  };
  // A replaced order is left out: the replacement carries its page and campaign now, and both would count the one sale.
  const orderWhere = { companyId, storeId, landingPageId: { not: null }, createdAt: { gte: start, lte: end }, ...notSuperseded };

  const first = await db.landingPageView.findFirst({
    where: { companyId, storeId },
    orderBy: { day: 'asc' },
    select: { day: true },
  });
  // The first counted day, as a local midnight — orders from then on have
  // views behind them. None counted yet: no order does.
  const countedFrom = first
    ? new Date(first.day.getUTCFullYear(), first.day.getUTCMonth(), first.day.getUTCDate())
    : null;
  const rateWhere = countedFrom
    ? { ...orderWhere, createdAt: { gte: countedFrom > start ? countedFrom : start, lte: end } }
    : null;
  const none = async () => [] as never[];

  const [viewsByPage, viewsByDevice, viewsByCampaign, ordersByPage, ordersByDevice, ordersByCampaign, ratePage, rateDevice, rateCampaign] =
    await Promise.all([
      db.landingPageView.groupBy({ by: ['landingPageId'], where: viewWhere, _sum: { count: true } }),
      db.landingPageView.groupBy({ by: ['device'], where: viewWhere, _sum: { count: true } }),
      db.landingPageView.groupBy({ by: ['campaignId'], where: viewWhere, _sum: { count: true } }),
      db.order.groupBy({ by: ['landingPageId'], where: orderWhere, _count: { _all: true } }),
      db.order.groupBy({ by: ['deviceClass'], where: orderWhere, _count: { _all: true } }),
      db.order.groupBy({ by: ['campaignId'], where: orderWhere, _count: { _all: true } }),
      rateWhere ? db.order.groupBy({ by: ['landingPageId'], where: rateWhere, _count: { _all: true } }) : none(),
      rateWhere ? db.order.groupBy({ by: ['deviceClass'], where: rateWhere, _count: { _all: true } }) : none(),
      rateWhere ? db.order.groupBy({ by: ['campaignId'], where: rateWhere, _count: { _all: true } }) : none(),
    ]);

  const sum = (rows: { _sum: { count: number | null } }[]) => rows.reduce((n, r) => n + (r._sum.count ?? 0), 0);
  const cnt = (rows: { _count: { _all: number } }[]) => rows.reduce((n, r) => n + r._count._all, 0);

  // ── per page ──
  const pageIds = [...new Set([
    ...viewsByPage.map((r) => r.landingPageId),
    ...ordersByPage.map((r) => r.landingPageId).filter((id): id is string => !!id),
  ])];
  const pages = pageIds.length
    ? await db.landingPage.findMany({ where: { id: { in: pageIds }, companyId }, select: { id: true, name: true, slug: true } })
    : [];
  const byPage = pageIds.map((id) => {
    const p = pages.find((x) => x.id === id);
    return row(
      id,
      p?.name ?? 'صفحة محذوفة',
      viewsByPage.find((r) => r.landingPageId === id)?._sum.count ?? 0,
      ordersByPage.find((r) => r.landingPageId === id)?._count._all ?? 0,
      ratePage.find((r) => r.landingPageId === id)?._count._all ?? 0,
      p ? `/lp/${p.slug}` : undefined
    );
  }).sort(byWeight);

  // ── per device ──
  const devices: (DeviceClass | null)[] = ['mobile', 'desktop', 'tablet'];
  const byDevice = devices
    .map((d) => row(
      d as string,
      DEVICE_LABEL[d as DeviceClass],
      viewsByDevice.find((r) => r.device === d)?._sum.count ?? 0,
      ordersByDevice.find((r) => r.deviceClass === d)?._count._all ?? 0,
      rateDevice.find((r) => r.deviceClass === d)?._count._all ?? 0
    ));
  // Orders from before the device was recorded: shown, so the rows add up.
  const unknownOrders = ordersByDevice.find((r) => r.deviceClass === null)?._count._all ?? 0;
  if (unknownOrders) byDevice.push(row('unknown', 'غير مسجَّل', 0, unknownOrders, 0, 'طلبات من قبل تسجيل نوع الجهاز'));

  // ── per campaign ──
  const campaignIds = [...new Set([
    ...viewsByCampaign.map((r) => r.campaignId).filter((id) => id !== ''),
    ...ordersByCampaign.map((r) => r.campaignId).filter((id): id is string => !!id),
  ])];
  const campaigns = campaignIds.length
    ? await db.campaign.findMany({ where: { id: { in: campaignIds }, companyId }, select: { id: true, name: true, code: true } })
    : [];
  const byCampaign = campaignIds.map((id) => {
    const c = campaigns.find((x) => x.id === id);
    return row(
      id,
      c?.name ?? 'حملة محذوفة',
      viewsByCampaign.find((r) => r.campaignId === id)?._sum.count ?? 0,
      ordersByCampaign.find((r) => r.campaignId === id)?._count._all ?? 0,
      rateCampaign.find((r) => r.campaignId === id)?._count._all ?? 0,
      c ? `?c=${c.code}` : undefined
    );
  }).sort(byWeight);
  const direct = row(
    'none',
    'بلا حملة',
    viewsByCampaign.find((r) => r.campaignId === '')?._sum.count ?? 0,
    ordersByCampaign.find((r) => r.campaignId === null)?._count._all ?? 0,
    rateCampaign.find((r) => r.campaignId === null)?._count._all ?? 0,
    'زيارات وطلبات لم تأتِ من رابط حملة'
  );
  if (direct.views || direct.orders) byCampaign.push(direct);

  return {
    countingSince: first ? first.day.toISOString().slice(0, 10) : null,
    totals: row('all', 'الكل', sum(viewsByPage), cnt(ordersByPage), cnt(ratePage)),
    byPage,
    byDevice,
    byCampaign,
    countCheck: await countCheckFor({ companyId, storeId, start, end }),
  };
}

/** The server's count and the browser's, over the same days — see `CountCheck`. Reads two tables; computes no money. */
export async function countCheckFor(scope: { companyId: string; storeId: string; start: Date; end: Date }): Promise<CountCheck | null> {
  const { companyId, storeId, start, end } = scope;
  const firstBrowser = await db.landingPageBrowserView.findFirst({
    where: { companyId, storeId },
    orderBy: { day: 'asc' },
    select: { day: true },
  });
  if (!firstBrowser) return null;
  const since = firstBrowser.day.toISOString().slice(0, 10);
  const from = localDay(start) > since ? localDay(start) : since;
  const to = localDay(end);
  if (from > to) return null;
  const where = { companyId, storeId, day: { gte: asDateColumn(from), lte: asDateColumn(to) } };
  const [server, browser] = await Promise.all([
    db.landingPageView.groupBy({ by: ['landingPageId'], where, _sum: { count: true } }),
    db.landingPageBrowserView.groupBy({ by: ['landingPageId'], where, _sum: { count: true } }),
  ]);
  const ids = [...new Set([...server.map((r) => r.landingPageId), ...browser.map((r) => r.landingPageId)])];
  const pages = ids.length
    ? await db.landingPage.findMany({ where: { id: { in: ids }, companyId }, select: { id: true, name: true } })
    : [];
  const of = (rows: { landingPageId: string; _sum: { count: number | null } }[], id: string) =>
    rows.find((r) => r.landingPageId === id)?._sum.count ?? 0;
  const byPage = ids
    .map((id) => ({ key: id, label: pages.find((p) => p.id === id)?.name ?? 'صفحة محذوفة', server: of(server, id), browser: of(browser, id) }))
    .sort((a, b) => b.server + b.browser - (a.server + a.browser));
  return {
    since: from,
    server: byPage.reduce((n, r) => n + r.server, 0),
    browser: byPage.reduce((n, r) => n + r.browser, 0),
    byPage,
  };
}

/**
 * THE NUMBERS A VERDICT BETWEEN TWO PAGES IS MADE OF.
 *
 * Separate from `landingAnalytics` above, which answers «how is the
 * performance screen doing» for one window across every page. This answers
 * a different question — «which of these two won» — and it needs two
 * columns that one does not: how many orders ARRIVED, and how many were
 * PAID for. «الصفحة الفائزة هي الي بتطلّع أكتر طلبات مُسلَّمة ومحصَّلة لكل
 * ١٠٠ زائر.»
 *
 * The verdict itself is `pageVerdict`, and it is deliberately somewhere
 * else: this reads, that decides, and the deciding has no database in it
 * at all — which is how «ما بيطفّي الخاسر لحاله» is kept true by
 * construction rather than by discipline.
 *
 * COLLECTED IS A SUBSET OF DELIVERED and is read from the settlement
 * status, not inferred from the delivery date: a parcel handed over on
 * Tuesday whose cash reaches the company on Friday is delivered on Tuesday
 * and collected on Friday, and a page judged on the first of those is
 * judged on money that has not arrived.
 */
export async function pageNumbersFor(scope: {
  companyId: string;
  storeId: string;
  pageIds: string[];
  start: Date;
  end: Date;
}): Promise<Map<string, { visitors: number; orders: number; delivered: number; collected: number }>> {
  const { companyId, storeId, pageIds, start, end } = scope;
  const out = new Map<string, { visitors: number; orders: number; delivered: number; collected: number }>();
  if (pageIds.length === 0) return out;
  // EVERY PAGE ASKED ABOUT GETS AN ANSWER, including one with no rows at
  // all. A map that simply omitted it would make a page nobody visited
  // vanish from its own comparison — and `pageVerdict` reads the floors by
  // subtraction, so an absent number becomes NaN, NaN > 0 is false, and the
  // page would be reported as having CLEARED the floors it never reached.
  for (const id of pageIds) out.set(id, { visitors: 0, orders: 0, delivered: 0, collected: 0 });

  const base = { companyId, storeId, landingPageId: { in: pageIds }, ...notSuperseded };
  const window = { createdAt: { gte: start, lte: end } };

  const [views, orders, delivered, collected] = await Promise.all([
    db.landingPageView.groupBy({
      by: ['landingPageId'],
      where: { companyId, storeId, landingPageId: { in: pageIds }, day: { gte: asDateColumn(localDay(start)), lte: asDateColumn(localDay(end)) } },
      _sum: { count: true },
    }),
    db.order.groupBy({ by: ['landingPageId'], where: { ...base, ...window }, _count: { _all: true } }),
    db.order.groupBy({
      by: ['landingPageId'],
      where: { ...base, ...window, deliveredAt: { not: null } },
      _count: { _all: true },
    }),
    db.order.groupBy({
      by: ['landingPageId'],
      // The money, not the parcel. SETTLED and COLLECTED are the two
      // states in which the company has it.
      where: { ...base, ...window, deliveredAt: { not: null }, settlementStatus: { in: ['COLLECTED', 'SETTLED'] } },
      _count: { _all: true },
    }),
  ]);

  for (const row of views) {
    const r = out.get(row.landingPageId ?? '');
    if (r) r.visitors = row._sum.count ?? 0;
  }
  for (const [rows, key] of [[orders, 'orders'], [delivered, 'delivered'], [collected, 'collected']] as const) {
    for (const row of rows) {
      const r = out.get(row.landingPageId ?? '');
      if (r) r[key] = row._count._all;
    }
  }
  return out;
}

/**
 * WHICH PAGES ARE EVEN BEING COMPARED.
 *
 * «نسخ صفحة لاختبار A/B: نفس المنتج، بنية أو مظهر أو عنوان مختلف، رابط
 * مختلف، والإسناد منفصل.» That sentence is the whole grouping rule, and it
 * is already true of the data: two pages selling one product ARE the test,
 * whether one was duplicated from the other or written from scratch.
 *
 * SO NOTHING RECORDS A LINEAGE, AND NOTHING SHOULD. A `variantOf` column
 * would have to be kept honest by every page that is ever created,
 * duplicated or re-pointed at another product, and the one page somebody
 * built by hand instead of duplicating would sit outside its own test. The
 * product is the thing the comparison is actually about.
 *
 * A product with one page is not a comparison and is left out — `pageVerdict`
 * would refuse it anyway, and a screen full of «صفحة واحدة لا حكم لها» is a
 * screen nobody reads.
 */
export async function pageVerdicts(scope: {
  companyId: string;
  storeId: string;
  start: Date;
  end: Date;
}): Promise<{ productId: string; productName: string; pages: number; verdict: Verdict }[]> {
  const { companyId, storeId, start, end } = scope;

  const pages = await db.landingPage.findMany({
    where: { companyId, storeId, productId: { not: null } },
    select: { id: true, name: true, productId: true, product: { select: { name: true } } },
    orderBy: { createdAt: 'asc' },
  });

  const groups = new Map<string, { productName: string; pages: { id: string; name: string }[] }>();
  for (const p of pages) {
    const key = p.productId!;
    const g = groups.get(key) ?? { productName: p.product?.name ?? '—', pages: [] };
    g.pages.push({ id: p.id, name: p.name });
    groups.set(key, g);
  }
  const tested = [...groups.entries()].filter(([, g]) => g.pages.length >= 2);
  if (tested.length === 0) return [];

  const numbers = await pageNumbersFor({
    companyId,
    storeId,
    pageIds: tested.flatMap(([, g]) => g.pages.map((p) => p.id)),
    start,
    end,
  });

  return tested.map(([productId, g]) => ({
    productId,
    productName: g.productName,
    pages: g.pages.length,
    verdict: pageVerdict(
      g.pages.map((p) => ({
        pageId: p.id,
        // The PAGE's name, not the product's: both rows describe one product
        // and what a seller needs is which of their two pages it was.
        label: p.name,
        // Never undefined — `pageNumbersFor` pre-fills every id it is given,
        // and the test beside it holds that. A `?? { …zeros }` here looked
        // careful and was unreachable: no mutation could make it fire, which
        // is the honest sign that it was defending against nothing.
        ...numbers.get(p.id)!,
      }))
    ),
  }));
}
