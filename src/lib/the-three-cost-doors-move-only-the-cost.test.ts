import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE THREE DOORS THAT COSTED AN ORDER THEIR OWN WAY — AND ONLY THE COST MOVES (the owner, 3/11: «صلّحهن مع مراجع فلوس»)
 *
 * «سعر تكلفة المنتج يكون ثابت… ثابت لكل الطلبات وما يتغير تحت اي ظرف» (1/11). Three places did not follow it (RV574–RV576):
 *
 *   · Telegram read the NEWEST batch's unit cost (even an empty batch) where every other door reads `unitCostsOf`;
 *   · the win-back copied the cancelled order's cost as it stood, figure or not;
 *   · a delivery on an empty or short shelf kept the creation-time estimate, figure or not.
 *
 * THIS IS A DIFFERENTIAL TEST, NOT A DESCRIPTION. Every write each door makes — every create, update and createMany, with its
 * arguments — was RECORDED against the code BEFORE the fix (`the-three-cost-doors-move-only-the-cost.golden.json`, recorded on
 * main 53a54aca with `RECORD_COST_GOLDEN=1`). After the fix the same scenarios run again, and:
 *
 *   1. every write is IDENTICAL to the recording once the cost of goods is taken out of it — the price, the total, the COD, the
 *      discount, the lines, the shares, the statuses, the shelf, the ledger, the notes: nothing else moved;
 *   2. the cost of goods is what the owner's rule says, scenario by scenario, beside what it was before (the table at the bottom).
 *
 * The worked example of the PR is the fixture: a product with a fixed cost of 5, its newest batch at 7, the average of what is
 * on hand 6, and an order of 2 paid pieces + 1 gift = 3 units.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const GOLDEN = join(process.cwd(), 'src/lib/the-three-cost-doors-move-only-the-cost.golden.json');
const RECORD = process.env.RECORD_COST_GOLDEN === '1';
const NOW = new Date('2026-11-03T09:00:00.000Z');

type Row = Record<string, any>;
interface World {
  figures: Record<string, number>;
  batches: Row[];
  order: Row | null;
  orderItems: Row[];
}

const { db, world, writes, mocks } = vi.hoisted(() => {
  const world: World = { figures: {}, batches: [], order: null, orderItems: [] };
  const writes: { call: string; args: unknown }[] = [];
  const WRITE = /^(create|createMany|update|updateMany|upsert|delete|deleteMany)$/;

  const byWhere = (b: Row, where: Row) => {
    if (where.companyId && b.companyId !== where.companyId) return false;
    if (where.productId !== undefined) {
      if (typeof where.productId === 'string' && b.productId !== where.productId) return false;
      if (where.productId?.in && !where.productId.in.includes(b.productId)) return false;
    }
    if (where.quantityRemaining?.gt !== undefined && !(b.quantityRemaining > where.quantityRemaining.gt)) return false;
    if (where.storeId && b.storeId !== where.storeId) return false;
    return true;
  };
  const asc = (a: Row, b: Row) => +new Date(a.productionDate) - +new Date(b.productionDate);

  const handlers: Record<string, Record<string, (args: any) => unknown>> = {
    user: { findFirst: () => ({ id: 'u-admin', role: 'COMPANY_ADMIN' }) },
    store: {
      findFirst: () => ({ id: 's1', countryId: 'co1', country: { currencyCode: 'JOD', orderPrefix: 'ORD', minorUnit: 3 } }),
    },
    product: {
      // Answers the `include: { batches: … orderBy productionDate desc, take 1 }` the way Prisma would — empty batches included.
      findFirst: ({ where, include }: Row) => {
        if (where.id !== 'p1' || where.companyId !== 'c1') return null;
        const row: Row = { id: 'p1', companyId: 'c1', name: 'كريم', image: null, basePrice: 12.5 };
        if (include?.batches) {
          row.batches = world.batches
            .filter((b) => b.productId === 'p1' && b.companyId === 'c1')
            .sort((a, b) => -asc(a, b))
            .slice(0, include.batches.take ?? undefined);
        }
        return row;
      },
    },
    productFixedCost: {
      findMany: ({ where }: Row) =>
        Object.entries(world.figures)
          .filter(([productId]) => where.companyId === 'c1' && where.productId.in.includes(productId))
          .map(([productId, amount]) => ({ productId, amount })),
    },
    productionBatch: {
      findMany: ({ where }: Row) => world.batches.filter((b) => byWhere(b, where)).sort(asc).map((b) => ({ ...b })),
      update: ({ where, data }: Row) => Object.assign(world.batches.find((b) => b.id === where.id)!, data),
      aggregate: ({ where }: Row) => ({
        _sum: { quantityRemaining: world.batches.filter((b) => byWhere(b, where)).reduce((n, b) => n + b.quantityRemaining, 0) },
      }),
    },
    order: {
      findFirst: () => (world.order ? { ...world.order } : null),
      create: ({ data }: Row) => ({ id: 'o-new', orderNumber: data.orderNumber, createdAt: NOW, source: data.source }),
      update: () => ({}),
    },
    orderItem: {
      findMany: () => world.orderItems.map((l) => ({ ...l })),
      create: () => ({}),
      createMany: ({ data }: Row) => ({ count: data.length }),
      updateMany: () => ({ count: 0 }),
    },
    orderAddOn: { updateMany: () => ({ count: 0 }) },
    orderActivity: { findFirst: () => null, create: () => ({}) },
    orderStatusLog: { findFirst: () => ({ createdAt: new Date(NOW.getTime() - 40 * 86_400_000) }), create: () => ({}) },
    orderNote: { create: () => ({}) },
    customer: { update: () => ({}) },
    inventoryMovement: { findFirst: () => null, create: () => ({}) },
    company: { findUnique: () => ({ settings: null }) },
  };

  const db: Row = {};
  for (const [model, fns] of Object.entries(handlers)) {
    db[model] = {};
    for (const [fn, impl] of Object.entries(fns)) {
      db[model][fn] = vi.fn(async (args: unknown) => {
        if (WRITE.test(fn)) writes.push({ call: `${model}.${fn}`, args: JSON.parse(JSON.stringify(args)) });
        return impl(args);
      });
    }
  }
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));

  const mocks = {
    requireContext: vi.fn(),
    requirePermission: vi.fn(),
  };
  return { db, world, writes, mocks };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/notify', () => ({ notify: vi.fn() }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/recent-twin-order', () => ({ flagRecentTwins: vi.fn() }));
vi.mock('@/lib/regions', () => ({ resolveRegionId: vi.fn(async () => 'r1') }));
vi.mock('@/lib/delivery-fees', () => ({ priceIncludesDeliveryFor: vi.fn(async () => false) }));
vi.mock('@/lib/order-ref', () => ({ orderRefFields: vi.fn(async () => ({ orderNumber: 'ORD-2026-0100', merchantRef: 'ORD-2026-0100' })) }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => mocks.requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => mocks.requirePermission(...a), can: () => true }));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: vi.fn() }));

import { createTelegramOrder } from './telegram/order-creation';
import { POST as offerWinback } from '@/app/api/confirmation/winback/route';
import { consumeOrderStock } from './stock-consumption';

const SOURCE_ID = '11111111-1111-4111-8111-111111111111';
const user = { id: 'u-sup', name: 'مشرفة', role: 'CONFIRMATION_SUPERVISOR', status: 'ACTIVE' };

/** On hand: 5 units at 5 (old) and 5 at 7 (newest) — average 6, newest 7. */
const SHELF = () => [
  { id: 'b-old', companyId: 'c1', storeId: 's1', productId: 'p1', productionDate: '2026-09-01', quantityRemaining: 5, quantitySold: 0, costPerUnit: 5 },
  { id: 'b-new', companyId: 'c1', storeId: 's1', productId: 'p1', productionDate: '2026-10-01', quantityRemaining: 5, quantitySold: 0, costPerUnit: 7 },
];

const telegram = () =>
  createTelegramOrder({
    companyId: 'c1',
    storeId: 's1',
    customer: { id: 'cu1', firstOrderDate: null, totalOrders: 0 },
    product: { id: 'p1', name: 'كريم', image: null, basePrice: 12.5 },
    line: { product: { id: 'p1', name: 'كريم', image: null, basePrice: 12.5 }, offer: null, quantity: 2, freeQuantity: 1, unitPrice: 12.5, offerDiscount: 0 } as never,
    address: 'دمشق — المزة',
    governorate: 'دمشق',
    telegram: { messageId: 'm1', chatId: 'chat1', threadId: null },
  });

const lost = (estimatedCostOfGoods: number) => ({
  id: SOURCE_ID,
  orderNumber: 'ORD-2026-0052',
  confirmationStatus: 'REJECTED',
  rejectionReason: 'PRICE_TOO_HIGH',
  shippedAt: null,
  shippingStatus: 'NOT_READY',
  returnReceipt: null,
  replacedBy: null,
  replaces: null,
  countryId: 'co1',
  storeId: 's1',
  regionId: 'r1',
  customerId: 'cu1',
  productId: 'p1',
  offerId: null,
  quantity: 2,
  freeQuantity: 1,
  sellingPrice: 25,
  discountAmount: 0,
  shippingCost: 0,
  totalAmount: 25,
  currency: 'JOD',
  priceIncludesDelivery: false,
  productNameSnapshot: 'كريم',
  productImageSnapshot: null,
  moderatorId: 'mod-1',
  estimatedCostOfGoods,
  source: 'TikTok',
  customerNotes: null,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
});

const winback = () =>
  offerWinback(
    new Request('http://localhost/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: SOURCE_ID, discount: 2 }),
    })
  );

const toDeliver = (items: Row[], estimatedCostOfGoods: number, addOns: Row[] = [], minorUnit = 3) => ({
  orderNumber: 'ORD-2026-0090',
  storeId: 's1',
  source: 'Facebook',
  estimatedCostOfGoods,
  items,
  addOns,
  store: { country: { minorUnit } },
});
const deliver = () => consumeOrderStock(db as never, { orderId: 'o-90', companyId: 'c1', userId: 'u-desk' });

const P1 = { productId: 'p1', productName: 'كريم', quantity: 2, freeQuantity: 1, reservedQty: 3 };
const P2 = { productId: 'p2', productName: 'صابون', quantity: 1, freeQuantity: 0, reservedQty: 1 };

interface Scenario {
  name: string;
  door: 'telegram' | 'winback' | 'delivery';
  set: () => void;
  run: () => Promise<unknown>;
  /** The cost the order carries after the fix — the owner's rule. */
  after: number;
}

const SCENARIOS: Scenario[] = [
  // ── RV574 · Telegram ────────────────────────────────────────────────────────────────────────────────────────────────
  { name: 'تلجرام · رقم ثابت 5 · أحدث دفعة 7 · متوسط 6', door: 'telegram', set: () => { world.figures = { p1: 5 }; world.batches = SHELF(); }, run: telegram, after: 15 },
  { name: 'تلجرام · بلا رقم · أحدث دفعة 7 · متوسط 6', door: 'telegram', set: () => { world.batches = SHELF(); }, run: telegram, after: 18 },
  {
    name: 'تلجرام · بلا رقم · أحدث دفعة فاضية بـ9 · المتوفر 4 بـ6',
    door: 'telegram',
    set: () => {
      world.batches = [
        { id: 'b-a', companyId: 'c1', storeId: 's1', productId: 'p1', productionDate: '2026-09-01', quantityRemaining: 4, quantitySold: 0, costPerUnit: 6 },
        { id: 'b-z', companyId: 'c1', storeId: 's1', productId: 'p1', productionDate: '2026-10-20', quantityRemaining: 0, quantitySold: 8, costPerUnit: 9 },
      ];
    },
    run: telegram,
    after: 18,
  },
  { name: 'تلجرام · بلا رقم · ولا دفعة', door: 'telegram', set: () => {}, run: telegram, after: 0 },
  { name: 'تلجرام · رقم صفر', door: 'telegram', set: () => { world.figures = { p1: 0 }; world.batches = SHELF(); }, run: telegram, after: 0 },
  // ── RV575 · the win-back ────────────────────────────────────────────────────────────────────────────────────────────
  {
    name: 'استرجاع · رقم ثابت 5 · الملغي انكتب بـ12',
    door: 'winback',
    set: () => {
      world.figures = { p1: 5 };
      world.order = lost(12);
      world.orderItems = [{ productId: 'p1', productName: 'كريم', quantity: 2, freeQuantity: 1, unitPrice: 12.5 }];
    },
    run: winback,
    after: 15,
  },
  {
    name: 'استرجاع · بلا رقم · الملغي انكتب بـ12',
    door: 'winback',
    set: () => {
      world.order = lost(12);
      world.orderItems = [{ productId: 'p1', productName: 'كريم', quantity: 2, freeQuantity: 1, unitPrice: 12.5 }];
    },
    run: winback,
    after: 12,
  },
  {
    name: 'استرجاع · سطرين · رقم للأول بس · الملغي انكتب بـ16',
    door: 'winback',
    set: () => {
      world.figures = { p1: 5 };
      world.order = { ...lost(16), sellingPrice: 29, totalAmount: 29 };
      world.orderItems = [
        { productId: 'p1', productName: 'كريم', quantity: 2, freeQuantity: 1, unitPrice: 12.5 },
        { productId: 'p2', productName: 'صابون', quantity: 1, freeQuantity: 0, unitPrice: 4 },
      ];
    },
    run: winback,
    // NOT EVERY LINE HAS A FIGURE: the copied 16 stays as it was — it may already hold the figure's money (the review of #175, B1)
    after: 16,
  },
  {
    name: 'استرجاع · سطرين · الأول برقم 5 والتاني بلا رقم · الملغي انكتب اليوم بالقاعدة 19 (15 + 4)',
    door: 'winback',
    set: () => {
      world.figures = { p1: 5 };
      world.order = { ...lost(19), sellingPrice: 29, totalAmount: 29 };
      world.orderItems = [
        { productId: 'p1', productName: 'كريم', quantity: 2, freeQuantity: 1, unitPrice: 12.5 },
        { productId: 'p2', productName: 'صابون', quantity: 1, freeQuantity: 0, unitPrice: 4 },
      ];
    },
    run: winback,
    after: 19, // not 19.75 (15 + 19 × 1/4)
  },
  {
    name: 'استرجاع · سطرين · الاتنين برقم (5 و2) · الملغي انكتب بـ16',
    door: 'winback',
    set: () => {
      world.figures = { p1: 5, p2: 2 };
      world.order = { ...lost(16), sellingPrice: 29, totalAmount: 29 };
      world.orderItems = [
        { productId: 'p1', productName: 'كريم', quantity: 2, freeQuantity: 1, unitPrice: 12.5 },
        { productId: 'p2', productName: 'صابون', quantity: 1, freeQuantity: 0, unitPrice: 4 },
      ];
    },
    run: winback,
    after: 17, // 3 × 5 + 1 × 2
  },
  {
    name: 'استرجاع · بلا سطور (الأعمدة المفردة) · رقم 5 · الملغي بـ12',
    door: 'winback',
    set: () => {
      world.figures = { p1: 5 };
      world.order = lost(12);
      world.orderItems = [];
    },
    run: winback,
    after: 15,
  },
  // ── RV576 · the delivery ────────────────────────────────────────────────────────────────────────────────────────────
  { name: 'تسليم · رفّ فاضي · رقم 5 · التقدير 12', door: 'delivery', set: () => { world.figures = { p1: 5 }; world.order = toDeliver([P1], 12); }, run: deliver, after: 15 },
  {
    name: 'تسليم · رفّ ناقص (1 بـ7) · رقم 5 · التقدير 12',
    door: 'delivery',
    set: () => {
      world.figures = { p1: 5 };
      world.batches = [{ id: 'b-one', companyId: 'c1', storeId: 's1', productId: 'p1', productionDate: '2026-10-01', quantityRemaining: 1, quantitySold: 0, costPerUnit: 7 }];
      world.order = toDeliver([P1], 12);
    },
    run: deliver,
    after: 15,
  },
  { name: 'تسليم · رفّ فاضي · بلا رقم · التقدير 12', door: 'delivery', set: () => { world.order = toDeliver([P1], 12); }, run: deliver, after: 12 },
  {
    name: 'تسليم · رفّ كامل · رقم 5',
    door: 'delivery',
    set: () => { world.figures = { p1: 5 }; world.batches = SHELF(); world.order = toDeliver([P1], 12); },
    run: deliver,
    after: 15,
  },
  {
    name: 'تسليم · سطرين · الأول برقم 5 وناقص · التاني بلا رقم · التقدير 16',
    door: 'delivery',
    set: () => {
      world.figures = { p1: 5 };
      world.batches = [{ id: 'b-p2', companyId: 'c1', storeId: 's1', productId: 'p2', productionDate: '2026-10-01', quantityRemaining: 3, quantitySold: 0, costPerUnit: 2 }];
      world.order = toDeliver([P1, P2], 16);
    },
    run: deliver,
    // NOT EVERY LINE HAS A FIGURE: the estimate stays as it was, exactly as before the fix (the review of #175, B1)
    after: 16,
  },
  {
    name: 'تسليم · رفّ فاضي · سطرين: الأول برقم 5 والتاني بلا رقم · التقدير انكتب بالقاعدة 19 (15 + 4)',
    door: 'delivery',
    set: () => { world.figures = { p1: 5 }; world.order = toDeliver([P1, P2], 19); },
    run: deliver,
    after: 19, // not 19.75
  },
  {
    name: 'تسليم · رفّ فاضي · ليرة بلا كسور · الأول برقم 10000 والتاني بلا رقم · التقدير 16000',
    door: 'delivery',
    set: () => {
      world.figures = { p1: 10000 };
      world.order = toDeliver([{ ...P1, quantity: 1, freeQuantity: 0, reservedQty: 1 }, P2], 16000, [], 0);
    },
    run: deliver,
    after: 16000, // not 22000
  },
  {
    name: 'تسليم · رفّ فاضي · سطر بلا رقم + إضافة برقم 5 انقبلت بعدين · التقدير 20',
    door: 'delivery',
    set: () => {
      world.figures = { p1: 5 };
      world.order = toDeliver([{ ...P2, quantity: 2, reservedQty: 2 }], 20, [{ productId: 'p1', productName: 'كريم', quantity: 1 }]);
    },
    run: deliver,
    after: 20, // not 18.333
  },
  {
    name: 'تسليم · رفّ ناقص · سطر برقم 5 + إضافة برقم 2 · التقدير 15',
    door: 'delivery',
    set: () => {
      world.figures = { p1: 5, p3: 2 };
      world.batches = [{ id: 'b-one', companyId: 'c1', storeId: 's1', productId: 'p1', productionDate: '2026-10-01', quantityRemaining: 1, quantitySold: 0, costPerUnit: 7 }];
      world.order = toDeliver([P1], 15, [{ productId: 'p3', productName: 'فرشاة', quantity: 2 }]);
    },
    run: deliver,
    after: 19, // 3 × 5 + 2 × 2 — the add-on's units are goods that left
  },
];

/** What a write says once the cost of goods is taken out of it — and the delivery's own cost write, which carries nothing else. */
function withoutTheCost(list: { call: string; args: any }[]) {
  return list
    .filter((w) => !(w.call === 'order.update' && Object.keys(w.args?.data ?? {}).join() === 'estimatedCostOfGoods'))
    .map((w) => {
      if (!w.args?.data || Array.isArray(w.args.data)) return w;
      const { estimatedCostOfGoods: _cost, ...rest } = w.args.data;
      return { ...w, args: { ...w.args, data: rest } };
    });
}

/** The cost of goods the order carries after the door: written by the door, else what it already had. */
function costOf(s: Scenario, list: { call: string; args: any }[]): number {
  if (s.door === 'delivery') {
    const written = list.filter((w) => w.call === 'order.update' && w.args?.data?.estimatedCostOfGoods !== undefined);
    return written.length ? written[written.length - 1].args.data.estimatedCostOfGoods : (world.order?.estimatedCostOfGoods as number);
  }
  return list.find((w) => w.call === 'order.create')!.args.data.estimatedCostOfGoods;
}

const golden: Record<string, { cost: number; writes: unknown[] }> = !RECORD && existsSync(GOLDEN) ? JSON.parse(readFileSync(GOLDEN, 'utf8')) : {};
const recorded: typeof golden = {};
const table: string[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  writes.length = 0;
  world.figures = {};
  world.batches = [];
  world.order = null;
  world.orderItems = [];
  mocks.requireContext.mockResolvedValue({
    user,
    companyId: 'c1',
    storeId: 's1',
    countryId: 'co1',
    country: { id: 'co1', code: 'JO', currencyCode: 'JOD', minorUnit: 3, orderPrefix: 'ORD', allowNegativeStock: false },
  });
  mocks.requirePermission.mockResolvedValue(user);
});

afterAll(() => {
  vi.useRealTimers();
  if (RECORD) writeFileSync(GOLDEN, JSON.stringify(recorded, null, 2) + '\n');
  else if (table.length) console.log(['| الحالة | قبل | بعد |', '|---|---|---|', ...table].join('\n'));
});

describe('each scenario of the three doors, against what the code wrote BEFORE the fix', () => {
  it('the recording exists and covers every scenario (a scenario with no recording is not a comparison)', () => {
    if (RECORD) return;
    expect(Object.keys(golden).sort()).toEqual(SCENARIOS.map((s) => s.name).sort());
  });

  it.each(SCENARIOS)('$name', async (s) => {
    s.set();
    const result = await s.run();
    if (s.door === 'telegram') expect(result).toMatchObject({ ok: true });
    if (s.door === 'winback') expect((result as Response).status, JSON.stringify(await (result as Response).clone().json())).toBe(200);
    const list = writes.map((w) => ({ call: w.call, args: w.args as any }));
    const cost = costOf(s, list);

    if (RECORD) {
      recorded[s.name] = { cost, writes: list };
      return;
    }
    const before = golden[s.name];
    expect(before, `لا تسجيل لـ«${s.name}»`).toBeDefined();
    // 1. EVERYTHING BUT THE COST IS WHAT IT WAS — the price, the total, the COD, the lines, the shelf, the ledger, the notes.
    expect(withoutTheCost(list)).toEqual(withoutTheCost(before.writes as never));
    // 2. AND THE COST IS THE OWNER'S RULE.
    expect(cost).toBe(s.after);
    table.push(`| ${s.name} | ${before.cost} | ${cost} |`);
  });
});

describe('the recording is a real one, not an empty file that agrees with anything', () => {
  it('every door wrote something in every scenario, and the money columns are in it', () => {
    if (RECORD) return;
    for (const s of SCENARIOS) expect(golden[s.name].writes.length, s.name).toBeGreaterThan(0);
    const tg = golden['تلجرام · رقم ثابت 5 · أحدث دفعة 7 · متوسط 6'].writes.find((w: any) => w.call === 'order.create') as any;
    expect(tg.args.data).toMatchObject({ totalAmount: 25, sellingPrice: 25, quantity: 2, freeQuantity: 1 });
    const wb = golden['استرجاع · رقم ثابت 5 · الملغي انكتب بـ12'].writes.find((w: any) => w.call === 'order.create') as any;
    expect(wb.args.data).toMatchObject({ totalAmount: 23, sellingPrice: 25, discountAmount: 2 });
  });

  it('and before the fix the three doors were wrong exactly as the backlog says (RV574–RV576)', () => {
    if (RECORD) return;
    expect(golden['تلجرام · رقم ثابت 5 · أحدث دفعة 7 · متوسط 6'].cost).toBe(15); // the figure already won at Telegram
    expect(golden['تلجرام · بلا رقم · أحدث دفعة 7 · متوسط 6'].cost).toBe(21); // the newest batch, not the average
    expect(golden['تلجرام · بلا رقم · أحدث دفعة فاضية بـ9 · المتوفر 4 بـ6'].cost).toBe(27); // even an empty batch
    expect(golden['استرجاع · رقم ثابت 5 · الملغي انكتب بـ12'].cost).toBe(12); // the copy ignored the figure
    expect(golden['تسليم · رفّ فاضي · رقم 5 · التقدير 12'].cost).toBe(12); // the empty shelf kept the old estimate
    expect(golden['تسليم · رفّ ناقص (1 بـ7) · رقم 5 · التقدير 12'].cost).toBe(12); // so did the short one
  });
});
