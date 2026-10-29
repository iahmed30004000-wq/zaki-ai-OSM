import { whereDelivered } from './order-state';
import { realStoresHere } from './test-store';
import { availableStock } from './reservation';
import type { Prisma } from '@prisma/client';
import { db } from './db';
import { roundMinor } from './money';
import { notSuperseded } from './superseded';

type Tx = Prisma.TransactionClient | typeof db;

/**
 * BUSINESS ANALYSIS over operational data.
 *
 * Not the chat assistant, and not a dashboard. A dashboard shows what
 * happened; this says what is bleeding and what to do about it. Every
 * finding names the number it is based on, because an insight nobody can
 * check is a guess with confidence.
 *
 * Two rules it holds to:
 *
 *  - Nothing is invented. Every figure here is counted from orders that
 *    exist. Where the data cannot answer a question, the answer is "not
 *    enough data", not a plausible-sounding number.
 *
 *  - A finding with too few orders behind it is noise. One return out of two
 *    orders is a 50% return rate and means nothing, so a minimum sample is
 *    required before anything is called out.
 */

/** Below this many orders, a rate is noise rather than a signal. */
export const MIN_SAMPLE = 8;

/** A return rate at or above this is bleeding, not normal variation. */
export const RETURN_ALARM = 0.2;

const RETURNED = ['RETURNED', 'RETURN_REQUESTED'];

export type Severity = 'ALARM' | 'WATCH' | 'GOOD';

/**
 * WHICH QUESTION A FINDING ANSWERS.
 *
 * Four, because they are read by different people at different moments and
 * they fail differently:
 *
 *   leak   money going out that need not — rates over a sample, so they
 *          need history and stay silent until there is some.
 *   queue  work that has stopped moving. COUNTS, not rates, so they are
 *          honest on day one: «nine orders nobody pulled» is true whether
 *          the business is a week or a decade old.
 *   risk   something that will break soon rather than something that
 *          already did — stock that runs out before the orders promising
 *          it, a statement nobody closed.
 *   team   people, measured against the store's own average rather than a
 *          number somebody imagined.
 */
export type Family = 'leak' | 'queue' | 'risk' | 'team';

export interface Finding {
  /** Stable key so the screen can group and the reader can refer to it. */
  key: string;
  /** The tab it belongs under. */
  family: Family;
  title: string;
  /** The number this rests on, spelled out. */
  evidence: string;
  /** What to actually do. Never "consider optimising". */
  action: string;
  severity: Severity;
  /** Whatever the finding is about, for a link. */
  subject?: { kind: 'product' | 'region' | 'customer' | 'courier'; id: string; name: string };
  metric?: number;
}

interface Scope {
  companyId: string;
  storeId: string;
  minorUnit: number;
  currency: string;
}

function severityFor(rate: number): Severity {
  if (rate >= RETURN_ALARM) return 'ALARM';
  if (rate >= RETURN_ALARM / 2) return 'WATCH';
  return 'GOOD';
}

const pct = (n: number) => `${Math.round(n * 1000) / 10}%`;

/**
 * Products losing money to returns.
 *
 * A returned parcel costs the delivery both ways and earns nothing, so a
 * product with a high return rate can be unprofitable while looking like a
 * bestseller on revenue.
 */
export async function returningProducts(tx: Tx, scope: Scope): Promise<Finding[]> {
  const items = await tx.orderItem.findMany({
    where: { order: { companyId: scope.companyId, storeId: scope.storeId, ...notSuperseded } },
    select: {
      productId: true,
      productName: true,
      order: { select: { shippingStatus: true, totalAmount: true, deliveryFee: true } },
    },
  });

  const byProduct = new Map<string, { name: string; orders: number; returned: number; lostFees: number }>();
  for (const item of items) {
    const entry = byProduct.get(item.productId) ?? { name: item.productName, orders: 0, returned: 0, lostFees: 0 };
    entry.orders++;
    if (RETURNED.includes(item.order.shippingStatus)) {
      entry.returned++;
      // The fee is spent whether or not the customer takes the parcel.
      entry.lostFees += Number(item.order.deliveryFee ?? 0);
    }
    byProduct.set(item.productId, entry);
  }

  const findings: Finding[] = [];
  for (const [productId, p] of byProduct) {
    if (p.orders < MIN_SAMPLE) continue;
    const rate = p.returned / p.orders;
    if (rate < RETURN_ALARM / 2) continue;

    findings.push({
      key: `product-returns:${productId}`,
      family: 'leak',
      title: `${p.name}: مرتجعات ${pct(rate)}`,
      evidence: `${p.returned} مرتجعاً من ${p.orders} طلباً${p.lostFees > 0 ? ` · أجور توصيل ضائعة ${roundMinor(p.lostFees, scope.minorUnit)} ${scope.currency}` : ''}`,
      action:
        rate >= RETURN_ALARM
          ? 'راجع وصف المنتج وصوره وسعره — هذه النسبة تأكل ربحه. أو اشترط دفعاً مسبقاً عليه.'
          : 'راقبه: نسبته أعلى من المعتاد ولم تبلغ حد الخطر بعد.',
      severity: severityFor(rate),
      subject: { kind: 'product', id: productId, name: p.name },
      metric: rate,
    });
  }

  return findings.sort((a, b) => (b.metric ?? 0) - (a.metric ?? 0));
}

/**
 * Regions that return.
 *
 * A region returning far above the rest is usually one thing: the courier
 * serves it badly. That is a courier conversation, not a marketing one.
 */
export async function returningRegions(tx: Tx, scope: Scope): Promise<Finding[]> {
  const orders = await tx.order.findMany({
    where: { companyId: scope.companyId, storeId: scope.storeId, regionId: { not: null }, ...notSuperseded },
    select: { regionId: true, shippingStatus: true, region: { select: { name: true } } },
  });

  const byRegion = new Map<string, { name: string; orders: number; returned: number }>();
  for (const o of orders) {
    const entry = byRegion.get(o.regionId!) ?? { name: o.region?.name ?? '—', orders: 0, returned: 0 };
    entry.orders++;
    if (RETURNED.includes(o.shippingStatus)) entry.returned++;
    byRegion.set(o.regionId!, entry);
  }

  const total = orders.length;
  const totalReturned = orders.filter((o) => RETURNED.includes(o.shippingStatus)).length;
  const average = total > 0 ? totalReturned / total : 0;

  const findings: Finding[] = [];
  for (const [regionId, r] of byRegion) {
    if (r.orders < MIN_SAMPLE) continue;
    const rate = r.returned / r.orders;
    // Only worth saying when it is clearly worse than the rest, not merely high.
    if (rate < RETURN_ALARM || rate <= average * 1.3) continue;

    findings.push({
      key: `region-returns:${regionId}`,
      family: 'leak',
      title: `${r.name}: مرتجعات ${pct(rate)} مقابل ${pct(average)} للمتجر`,
      evidence: `${r.returned} مرتجعاً من ${r.orders} طلباً في هذه المحافظة`,
      action: 'غالباً مشكلة تغطية عند شركة الشحن في هذه المحافظة — جرّب جهة أخرى عليها وقارن.',
      severity: 'ALARM',
      subject: { kind: 'region', id: regionId, name: r.name },
      metric: rate,
    });
  }

  return findings.sort((a, b) => (b.metric ?? 0) - (a.metric ?? 0));
}

/**
 * Customers to stop shipping to.
 *
 * Feeds the blacklist: this is the evidence for the decision, and the
 * decision stays a person's.
 */
export async function riskyCustomers(tx: Tx, scope: Scope): Promise<Finding[]> {
  const orders = await tx.order.findMany({
    where: { companyId: scope.companyId, storeId: scope.storeId, ...notSuperseded },
    select: {
      customerId: true,
      shippingStatus: true,
      deliveryFee: true,
      customer: { select: { fullName: true, phone: true } },
    },
  });

  const byCustomer = new Map<string, { name: string; phone: string; orders: number; returned: number; lostFees: number }>();
  for (const o of orders) {
    const entry = byCustomer.get(o.customerId) ?? {
      name: o.customer?.fullName ?? '—',
      phone: o.customer?.phone ?? '',
      orders: 0, returned: 0, lostFees: 0,
    };
    entry.orders++;
    if (RETURNED.includes(o.shippingStatus)) {
      entry.returned++;
      entry.lostFees += Number(o.deliveryFee ?? 0);
    }
    byCustomer.set(o.customerId, entry);
  }

  const findings: Finding[] = [];
  for (const [customerId, c] of byCustomer) {
    // A person is not a product: three refusals is a pattern even though
    // three orders is a small sample.
    if (c.returned < 3) continue;

    findings.push({
      key: `customer-returns:${customerId}`,
      family: 'leak',
      title: `${c.name}: رفض الاستلام ${c.returned} مرات`,
      evidence: `${c.returned} مرتجعاً من ${c.orders} طلباً · أجور ضائعة ${roundMinor(c.lostFees, scope.minorUnit)} ${scope.currency}`,
      action: 'أضف رقمه إلى القائمة السوداء، أو اشترط عليه الدفع المسبق قبل الشحن.',
      severity: 'ALARM',
      subject: { kind: 'customer', id: customerId, name: `${c.name} · ${c.phone}` },
      metric: c.returned,
    });
  }

  return findings.sort((a, b) => (b.metric ?? 0) - (a.metric ?? 0));
}

/**
 * Orders whose delivery fee eats the margin.
 *
 * With the price including delivery, a cheap order in an expensive region
 * can arrive at a loss without anything looking wrong.
 */
export async function thinMarginRegions(tx: Tx, scope: Scope): Promise<Finding[]> {
  const orders = await tx.order.findMany({
    where: {
      companyId: scope.companyId,
      storeId: scope.storeId,
      // A partial delivery is the thinnest margin there is — the full
      // delivery fee was paid against a reduced collected amount — and it
      // was the one case this finding could not see.
      ...whereDelivered(),
      regionId: { not: null },
    },
    select: {
      regionId: true, totalAmount: true, collectedAmount: true, deliveryFee: true,
      region: { select: { name: true } },
    },
  });

  const byRegion = new Map<string, { name: string; orders: number; thin: number; fees: number; revenue: number }>();
  for (const o of orders) {
    // Against what was actually collected where the door recorded it: on a
    // partial delivery the fee was paid in full and less money came back,
    // which is the whole point of looking at this.
    const total = Number(o.collectedAmount ?? o.totalAmount);
    const fee = Number(o.deliveryFee ?? 0);
    if (total <= 0) continue;

    const entry = byRegion.get(o.regionId!) ?? { name: o.region?.name ?? '—', orders: 0, thin: 0, fees: 0, revenue: 0 };
    entry.orders++;
    entry.fees += fee;
    entry.revenue += total;
    // A third of the order going to delivery is where it stops being worth it.
    if (fee / total >= 0.33) entry.thin++;
    byRegion.set(o.regionId!, entry);
  }

  const findings: Finding[] = [];
  for (const [regionId, r] of byRegion) {
    if (r.orders < MIN_SAMPLE || r.thin === 0) continue;
    const share = r.thin / r.orders;
    if (share < 0.25) continue;

    findings.push({
      key: `thin-margin:${regionId}`,
      family: 'leak',
      title: `${r.name}: ${r.thin} طلباً من ${r.orders} ثلث قيمته أجرة توصيل`,
      evidence: `أجور ${roundMinor(r.fees, scope.minorUnit)} من مبيعات ${roundMinor(r.revenue, scope.minorUnit)} ${scope.currency}`,
      action: 'ارفع حد الطلب الأدنى لهذه المحافظة، أو تفاوض على أجرتها مع شركة الشحن.',
      severity: 'WATCH',
      subject: { kind: 'region', id: regionId, name: r.name },
      metric: share,
    });
  }

  return findings.sort((a, b) => (b.metric ?? 0) - (a.metric ?? 0));
}

/**
 * WORK THAT HAS STOPPED MOVING.
 *
 * Every finding above this line is a RATE: returns over orders, fees over
 * revenue. A rate needs history, and it stays silent until there is some —
 * correctly, because one return out of two orders means nothing.
 *
 * These are COUNTS, and that difference is the point. «Nine orders nobody
 * has pulled, the oldest waiting eleven hours» is exactly as true on the
 * first day as on the thousandth, and it is the thing an operations lead
 * actually opens a dashboard to find out. A queue does not need a sample;
 * it needs somebody to look at it.
 */

/** Hours a new order may sit in the pool before nobody has pulled it. */
export const POOL_HOURS = 6;
/** Days a confirmed order may wait in the warehouse before it is stuck. */
export const READY_DAYS = 2;
/** Days a return may be in the air before somebody chases it. */
export const RETURN_DAYS = 7;

const hoursSince = (d: Date, now: Date) => Math.floor((now.getTime() - d.getTime()) / 3_600_000);
const daysSince = (d: Date, now: Date) => Math.floor((now.getTime() - d.getTime()) / 86_400_000);

/**
 * Arabic counts one, two, and many differently, and a system that says
 * «منذ 2 يوماً» is a system nobody wrote the Arabic for.
 */
function ago(d: Date, now: Date): string {
  const h = hoursSince(d, now);
  if (h < 1) return 'أقل من ساعة';
  if (h < 24) return h === 1 ? 'ساعة' : h === 2 ? 'ساعتين' : h <= 10 ? `${h} ساعات` : `${h} ساعة`;
  const days = Math.floor(h / 24);
  return days === 1 ? 'يوم' : days === 2 ? 'يومين' : days <= 10 ? `${days} أيام` : `${days} يوماً`;
}

/**
 * The pool nobody pulled from.
 *
 * A new order is money already spent on an ad and a customer already
 * waiting. The count matters less than the OLDEST one: five orders pulled
 * within the hour is a busy team, and one order sitting since yesterday is
 * a customer who has bought from somebody else by now.
 */
export async function unpulledPool(tx: Tx, scope: Scope, now = new Date()): Promise<Finding[]> {
  const waiting = await tx.order.findMany({
    where: {
      companyId: scope.companyId,
      storeId: scope.storeId,
      confirmationStatus: 'NEW',
      claimedById: null,
    },
    select: { createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  if (waiting.length === 0) return [];

  const oldest = waiting[0].createdAt;
  const stale = hoursSince(oldest, now);
  const overdue = waiting.filter((o) => hoursSince(o.createdAt, now) >= POOL_HOURS).length;

  return [
    {
      key: 'queue-pool',
      family: 'queue',
      title: `${waiting.length} طلباً لم يسحبها أحد`,
      evidence:
        overdue > 0
          ? `أقدمها منذ ${ago(oldest, now)} · ${overdue} منها تجاوزت ${POOL_HOURS} ساعات`
          : `أقدمها منذ ${ago(oldest, now)}`,
      action:
        overdue > 0
          ? 'افتح «الطلبات الجديدة» ووزّعها، أو زد عدد المؤكِّدين في هذه الفترة.'
          : 'الطابور يتحرّك. لا إجراء.',
      severity: overdue > 0 ? (stale >= POOL_HOURS * 4 ? 'ALARM' : 'WATCH') : 'GOOD',
      metric: waiting.length,
    },
  ];
}

/**
 * Follow-ups whose date has passed.
 *
 * The status is stored, not computed here: a scheduled call becomes OVERDUE
 * in the same place the schedule lives, so this counts rather than decides.
 */
export async function overdueFollowUps(tx: Tx, scope: Scope): Promise<Finding[]> {
  const n = await tx.order.count({
    where: {
      companyId: scope.companyId,
      storeId: scope.storeId,
      followUpStatus: 'OVERDUE',
    },
  });
  if (n === 0) return [];

  return [
    {
      key: 'queue-followups',
      family: 'queue',
      title: `${n} متابعة فات موعدها`,
      evidence: `${n} طلباً وُعد صاحبه باتصال ولم يأتِ`,
      action: 'افتح «الطلبات المؤجلة» وصفِّ المتأخّر منها اليوم — الوعد الفائت يُقرأ رفضاً.',
      severity: n >= 10 ? 'ALARM' : 'WATCH',
      metric: n,
    },
  ];
}

/**
 * Confirmed, packed, and still here.
 *
 * The customer has agreed and the stock is reserved against their order:
 * every day it sits, that stock is promised to somebody who does not have
 * it and unavailable to somebody who would.
 */
export async function readyNotShipped(tx: Tx, scope: Scope, now = new Date()): Promise<Finding[]> {
  const rows = await tx.order.findMany({
    where: {
      companyId: scope.companyId,
      storeId: scope.storeId,
      shippingStatus: { in: ['READY_FOR_SHIPPING', 'READY_FOR_PICKUP', 'PACKING'] },
    },
    select: { updatedAt: true },
    orderBy: { updatedAt: 'asc' },
  });
  const stuck = rows.filter((r) => daysSince(r.updatedAt, now) >= READY_DAYS);
  if (stuck.length === 0) return [];

  return [
    {
      key: 'queue-ready',
      family: 'queue',
      title: `${stuck.length} طلباً جاهزاً لم يُشحن`,
      evidence: `أقدمها واقف منذ ${ago(stuck[0].updatedAt, now)} · مخزونها محجوز طوال هذه المدة`,
      action: 'أنشئ شحنة من «إنشاء شحنة»، أو أعد المخزون إن كان الطلب لن يخرج.',
      severity: stuck.length >= 10 ? 'ALARM' : 'WATCH',
      metric: stuck.length,
    },
  ];
}

/**
 * Returns still in the air.
 *
 * A parcel coming back is stock the balance does not have and money the
 * statement is still holding. Nobody opens a screen called "returns in
 * transit", so it is counted here.
 */
export async function returnsNotReceived(tx: Tx, scope: Scope, now = new Date()): Promise<Finding[]> {
  const rows = await tx.order.findMany({
    where: {
      companyId: scope.companyId,
      storeId: scope.storeId,
      shippingStatus: { in: ['RETURN_REQUESTED', 'WAITING_RETURN'] },
    },
    select: { updatedAt: true },
    orderBy: { updatedAt: 'asc' },
  });
  const late = rows.filter((r) => daysSince(r.updatedAt, now) >= RETURN_DAYS);
  if (late.length === 0) return [];

  return [
    {
      key: 'queue-returns',
      family: 'queue',
      title: `${late.length} مرتجعاً لم يصل`,
      evidence: `أقدمه منذ ${ago(late[0].updatedAt, now)} · بضاعة خارج الرصيد ومال معلّق`,
      action: 'طالب شركة الشحن بها، أو استلمها في «المرتجعات» إن كانت وصلت ولم تُسجَّل.',
      severity: late.length >= 5 ? 'ALARM' : 'WATCH',
      metric: late.length,
    },
  ];
}

/**
 * STOCK THAT RUNS OUT BEFORE THE ORDERS PROMISING IT.
 *
 * Not "low stock" — a threshold somebody invents. This compares what is
 * free against what has ALREADY been promised to customers who said yes
 * and are waiting. A shortfall here is not a warning about the future; it
 * is a set of orders that cannot ship, and nobody has been told.
 */
export async function stockShortfall(tx: Tx, scope: Scope): Promise<Finding[]> {
  const pending = await tx.order.findMany({
    where: {
      companyId: scope.companyId,
      storeId: scope.storeId,
      confirmationStatus: 'CONFIRMED',
      shippingStatus: { in: ['NOT_READY', 'READY_FOR_SHIPPING', 'PACKING'] },
    },
    select: { productId: true, quantity: true, product: { select: { name: true } } },
  });
  if (pending.length === 0) return [];

  const need = new Map<string, { name: string; qty: number; orders: number }>();
  for (const o of pending) {
    const e = need.get(o.productId) ?? { name: o.product?.name ?? '—', qty: 0, orders: 0 };
    e.qty += o.quantity;
    e.orders++;
    need.set(o.productId, e);
  }

  const findings: Finding[] = [];
  for (const [productId, n] of need) {
    const free = await availableStock(tx, scope.companyId, productId, undefined, scope.storeId);
    // `availableStock` already subtracts what is reserved, so a positive
    // number is genuinely free. The shortfall is what these orders need
    // beyond it.
    const short = n.qty - Math.max(0, free);
    if (short <= 0) continue;
    findings.push({
      key: `risk-stock:${productId}`,
      family: 'risk',
      title: `${n.name}: ينقص ${short} قطعة`,
      evidence: `${n.orders} طلباً مؤكّداً تطلب ${n.qty} والمتاح ${Math.max(0, free)}`,
      action: 'أدخل تشغيلة أو استلم بضاعة، أو اتّصل بأصحاب الطلبات قبل أن يسألوا.',
      severity: 'ALARM',
      subject: { kind: 'product', id: productId, name: n.name },
      metric: short,
    });
  }
  return findings.sort((a, b) => (b.metric ?? 0) - (a.metric ?? 0));
}

/**
 * Statements nobody closed.
 *
 * An open statement is money the courier is holding and the books have not
 * counted. It ages quietly, because no screen shows a statement that is
 * merely old.
 */
export async function staleStatements(tx: Tx, scope: Scope, now = new Date()): Promise<Finding[]> {
  /*
   * AND NOT THE TEST BENCH'S. A bench exists to try a product in front of
   * real traffic, so its parcels really ship and a courier really hands
   * in a statement for them — and an unclosed bench statement raised as a
   * finding about the BUSINESS is the «أرقامٌ لا تدخل أيَّ حسبة» rule
   * broken in the one screen built to tell the owner what is wrong.
   *
   * This is the only company-wide money aggregate that needed the filter:
   * measured, the other thirty are either scoped to named ids or sit on a
   * table that carries no store at all. See src/lib/test-store.ts.
   *
   * ── WHY IT IS A LIST OF STORE IDS, AND NOT `...realStoresOnly()` ──
   *
   * `CourierStatement` has a `storeId` COLUMN and no `store` RELATION, so
   * the filter every other money read spells `{ store: { isTest: false } }`
   * has nothing to stand on here. This query used to spread it anyway, and
   * Prisma answered at RUNTIME with «Unknown argument `store`» — which took
   * the whole of GET /api/growth/intelligence down, because `allFindings`
   * awaits its eleven finders together. Nothing caught it until the dev
   * server was run and the dashboard loaded:
   *
   *   · TypeScript does not check a SPREAD for excess properties, so
   *     `{ status, ...realStoresOnly() }` type-checks on any model at all;
   *   · every test of this product mocks Prisma, and a mock accepts
   *     whatever it is handed.
   *
   * No relation is added, because that is a migration and this is a fix.
   * The stores are asked first and the statements are asked about THEM: a
   * statement whose store is not a real store of this company is not one
   * this finding is about — which is what the relation filter would have
   * said. `a-bench-is-not-the-business.test.ts` Ⅳ holds the line both ways:
   * every store filter in the source sits on a model that really has a
   * `store`, and this function's `where` is checked against the generated
   * data model.
   */
  const realStores = await tx.store.findMany({
    where: { companyId: scope.companyId, ...realStoresHere() },
    select: { id: true },
  });
  // No real store, no statement to be late about — and `in: []` is a query for nothing.
  if (realStores.length === 0) return [];

  const open = await tx.courierStatement.findMany({
    where: {
      companyId: scope.companyId,
      status: 'OPEN',
      storeId: { in: realStores.map((s) => s.id) },
    },
    select: { createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  const old = open.filter((s) => daysSince(s.createdAt, now) >= 14);
  if (old.length === 0) return [];

  return [
    {
      key: 'risk-statements',
      family: 'risk',
      title: `${old.length} كشفاً مفتوحاً منذ أكثر من أسبوعين`,
      evidence: `أقدمه منذ ${ago(old[0].createdAt, now)} · مال لدى شركة الشحن لم يدخل الدفاتر`,
      action: 'طابق الكشف وأغلقه من «التحصيل والكشوف».',
      severity: old.length >= 3 ? 'ALARM' : 'WATCH',
      metric: old.length,
    },
  ];
}

/**
 * PEOPLE, AGAINST THIS STORE'S OWN AVERAGE.
 *
 * Never against a number somebody imagined a good confirmation rate to be.
 * A 60% rate is poor in one market and excellent in another, and the only
 * honest comparison available here is the store's own.
 *
 * A moderator under the sample is skipped rather than flattered: three
 * orders and one rejection is not a 33% rejection rate, it is three orders.
 */
export async function moderatorRates(tx: Tx, scope: Scope): Promise<Finding[]> {
  /**
   * `moderatorId`, because that is who the leaderboard already means.
   *
   * There are four fields that could be called "whose order this is" —
   * moderator, current owner, assignee, claimer — and they are set on 150,
   * 17, 1 and 17 of the same 166 orders. Picking a different one here
   * would put two different answers to «كم أكّد فلان» on two screens, and
   * the one people already read is `analytics.ts`'s leaderboard.
   */
  const rows = await tx.order.findMany({
    where: {
      companyId: scope.companyId,
      storeId: scope.storeId,
      moderatorId: { not: null },
      confirmationStatus: { in: ['CONFIRMED', 'REJECTED', 'CANCELLED'] },
      // The replacement carries the moderator, so the replaced order would
      // be a second confirmation for the same sale.
      ...notSuperseded,
    },
    select: { moderatorId: true, confirmationStatus: true, moderator: { select: { name: true } } },
  });
  if (rows.length < MIN_SAMPLE) return [];

  const by = new Map<string, { name: string; total: number; confirmed: number }>();
  for (const r of rows) {
    const id = r.moderatorId!;
    const e = by.get(id) ?? { name: r.moderator?.name ?? '—', total: 0, confirmed: 0 };
    e.total++;
    if (r.confirmationStatus === 'CONFIRMED') e.confirmed++;
    by.set(id, e);
  }

  const average = rows.filter((r) => r.confirmationStatus === 'CONFIRMED').length / rows.length;

  /**
   * A COMPARISON NEEDS SOMEBODY TO COMPARE WITH.
   *
   * With one moderator the store average IS that moderator, so the gap is
   * always zero and the tab renders empty — which reads as broken rather
   * than as calm. Measured on this data: one person, 147 decided orders,
   * every one confirmed. There is nothing to say, and saying nothing is
   * the part that misleads.
   */
  const measurable = [...by.values()].filter((m) => m.total >= MIN_SAMPLE);
  if (measurable.length < 2) {
    return [
      {
        key: 'team-nocompare',
        family: 'team',
        title: 'لا مقارنة بعد',
        evidence:
          measurable.length === 1
            ? `${measurable[0].name} وحدها حسمت ما يكفي (${measurable[0].total} طلباً) — فهي نفسها متوسّط المتجر`
            : `لا أحد حسم ${MIN_SAMPLE} طلبات بعد`,
        action: 'هذا التبويب يقارن كلّ مؤكِّد بمتوسّط المتجر، ويحتاج شخصين على الأقل فوق العيّنة.',
        severity: 'GOOD',
      },
    ];
  }

  const findings: Finding[] = [];
  for (const [id, m] of by) {
    if (m.total < MIN_SAMPLE) continue;
    const rate = m.confirmed / m.total;
    const gap = rate - average;
    // Only a gap worth a conversation. A point either way is noise.
    if (Math.abs(gap) < 0.1) continue;

    findings.push({
      key: `team-rate:${id}`,
      family: 'team',
      title: `${m.name}: تأكيد ${pct(rate)} مقابل ${pct(average)} للمتجر`,
      evidence: `${m.confirmed} مؤكّداً من ${m.total} طلباً حسمها`,
      action:
        gap < 0
          ? 'استمع لتسجيلاته أو راجع ملاحظاته — الفجوة تحت متوسّط المتجر بفارق يستحقّ السؤال.'
          : 'افهم ما يفعله واكتبه: هذه فجوة فوق المتوسّط تستحقّ أن تصير قاعدة.',
      severity: gap < 0 ? 'WATCH' : 'GOOD',
      metric: Math.abs(gap),
    });
  }
  return findings.sort((a, b) => (b.metric ?? 0) - (a.metric ?? 0));
}

/** A detector: reads the store, returns what it found. */
export type Detector = { name: string; run: (tx: Tx, scope: Scope) => Promise<Finding[]> };

/** The eleven detectors, in the order their findings are first read. */
const DETECTORS: Detector[] = [
  // leak — rates, silent until there is history
  { name: 'riskyCustomers', run: (tx, scope) => riskyCustomers(tx, scope) },
  { name: 'returningProducts', run: (tx, scope) => returningProducts(tx, scope) },
  { name: 'returningRegions', run: (tx, scope) => returningRegions(tx, scope) },
  { name: 'thinMarginRegions', run: (tx, scope) => thinMarginRegions(tx, scope) },
  // queue — counts, true on day one
  { name: 'unpulledPool', run: (tx, scope) => unpulledPool(tx, scope) },
  { name: 'overdueFollowUps', run: (tx, scope) => overdueFollowUps(tx, scope) },
  { name: 'readyNotShipped', run: (tx, scope) => readyNotShipped(tx, scope) },
  { name: 'returnsNotReceived', run: (tx, scope) => returnsNotReceived(tx, scope) },
  // risk — what breaks next
  { name: 'stockShortfall', run: (tx, scope) => stockShortfall(tx, scope) },
  { name: 'staleStatements', run: (tx, scope) => staleStatements(tx, scope) },
  // team — against the store's own average
  { name: 'moderatorRates', run: (tx, scope) => moderatorRates(tx, scope) },
];

/**
 * EVERY DETECTOR ON ITS OWN.
 *
 * The eleven used to run inside one Promise.all, so a single query that
 * threw — one did, in staleStatements — took the whole screen and every
 * card down with it. Now a detector that throws is skipped, named in the
 * log and in the returned skipped list, and the other ten still answer. Silence about a
 * broken detector is not the same as «nothing found», which is why the
 * names are returned and not swallowed.
 */
export async function runDetectors(
  tx: Tx,
  scope: Scope,
  detectors: Detector[] = DETECTORS,
): Promise<{ findings: Finding[]; skipped: string[] }> {
  const settled = await Promise.allSettled(detectors.map((d) => d.run(tx, scope)));
  const skipped: string[] = [];
  const groups: Finding[][] = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      groups.push(r.value);
      return;
    }
    skipped.push(detectors[i].name);
    console.error('Intelligence detector skipped (non-fatal): ' + detectors[i].name, r.reason);
  });

  const order: Record<Severity, number> = { ALARM: 0, WATCH: 1, GOOD: 2 };
  return { findings: groups.flat().sort((a, b) => order[a.severity] - order[b.severity]), skipped };
}

/** The families, in the order the tabs show them. */
export const FAMILIES: { key: Family; label: string; blurb: string }[] = [
  { key: 'queue', label: 'طوابير', blurb: 'عملٌ توقّف عن الحركة' },
  { key: 'risk', label: 'خطر', blurb: 'ما سينكسر قريباً' },
  { key: 'leak', label: 'استنزاف', blurb: 'مالٌ يخرج بلا داعٍ' },
  { key: 'team', label: 'أداء', blurb: 'الفريق مقابل متوسّط المتجر' },
];
