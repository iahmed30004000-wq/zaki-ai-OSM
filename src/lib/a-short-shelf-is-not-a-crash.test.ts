import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A SHORT SHELF IS NOT A CRASH.
 *
 * `drawDownStock` refuses to take more units than a shelf holds, and says
 * so in a sentence written for the person who will fix it:
 *
 *     المخزون غير كافٍ: المتاح 3 والمطلوب 10
 *
 * `api-error.ts` had no branch for it, so the request answered **500 «حدث
 * خطأ داخلي. أعد المحاولة، وإن تكرّر أبلغ مدير النظام»**. A warehouse clerk
 * was told the system had broken and to call the administrator, for a
 * condition that is ordinary, expected and entirely theirs to resolve — and
 * the two numbers that tell them HOW FAR short they are were thrown away on
 * the way out.
 *
 * ONE BRANCH, NOT ONE PER DOOR. Six doors reach this thrower:
 *
 *   · `POST /api/inventory` (recount shortfall) — calls it directly
 *   · `PATCH /api/orders/[id]`                 ⎫
 *   · `POST  /api/orders/[id]/shipping`        ⎪ through
 *   · `POST  /api/finance/statements/[id]`     ⎬ `consumeOrderStock`
 *   · `POST  /api/ops/tracking/write-off`      ⎪
 *   · `POST  /api/ops/tracking/deliver`        ⎭ (via `partial-delivery.ts`)
 *
 * and the divergence between two of them is what produced the single-batch
 * draw-down defect `7c98b01` deleted. So the answer lives in the shared
 * mapper every one of them already funnels through, and this file holds all
 * three layers:
 *
 *   1. THE MAPPING, as status and body — including that the gate which
 *      refuses to echo Prisma's messages is untouched.
 *   2. TWO REAL DOORS, by behaviour — the real `drawDownStock` running
 *      against a short shelf, through the real route, read back as an HTTP
 *      status and an Arabic body.
 *   3. EVERY DOOR, by enumeration — so the seventh, added tomorrow, cannot
 *      quietly answer 500 again.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, requirePermission, logAudit } = vi.hoisted(() => ({
  db: {
    product: { findFirst: vi.fn() },
    order: { findFirst: vi.fn(), update: vi.fn() },
    // An order with no add-ons, unless a test says otherwise — plain functions, so a mock reset leaves them answering.
    orderAddOn: { aggregate: async () => ({ _sum: { reservedQty: 0 } }), findMany: async () => [], update: async () => ({}), updateMany: async () => ({ count: 0 }) },
    orderItem: { updateMany: vi.fn() },
    orderActivity: { create: vi.fn(), findFirst: vi.fn() },
    // The write-off door now writes the closing receipt after the shelf is drawn (it is never reached on a short shelf).
    returnReceipt: { create: async () => ({ id: 'rr1' }) },
    inventoryMovement: { findFirst: vi.fn(), create: vi.fn() },
    // No fixed cost for any product here: the order's cost is what the batches say (plain function, so a mock reset leaves it answering).
    productFixedCost: { findMany: async () => [] },
    productionBatch: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      aggregate: vi.fn(),
      count: vi.fn(),
    },
    $transaction: vi.fn(),
  },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));

import { Prisma } from '@prisma/client';
import { apiError } from './api-error';
import { stripComments, stripTemplates } from './guard-source';
import { POST as writeOff } from '@/app/api/ops/tracking/write-off/route';
import { POST as inventoryPost } from '@/app/api/inventory/route';

const COMPANY = 'c1';
const MUBARAK = 's-mubarak';
const PRODUCT = '11111111-1111-4111-8111-111111111111';
const ORDER = '22222222-2222-4222-8222-222222222222';

/** The sentence `receiving.ts` actually throws, as it is thrown. */
const SHORT = (available: number, wanted: number) =>
  new Error(`المخزون غير كافٍ: المتاح ${available} والمطلوب ${wanted}`);

/**
 * ───────────────────────────────────────────────────────────────────────────
 * 1 · THE MAPPING
 * ───────────────────────────────────────────────────────────────────────────
 */
describe('the mapper names a short shelf', () => {
  it('answers 409 and not 500 — the request was fine, the shelf was not', () => {
    const out = apiError(SHORT(3, 10));
    expect(out.status, 'رفٌّ قاصرٌ ليس عطلاً داخليّاً').toBe(409);
    expect(out.body.code).toBe('INSUFFICIENT_STOCK');
    // The thing that was actually wrong before: this exact body.
    expect(out.body.error).not.toBe('حدث خطأ داخلي');
    expect(out.body.errorAr).not.toMatch(/حدث خطأ داخلي/);
  });

  it('keeps both numbers, because «how far short» is the only actionable part', () => {
    const { body } = apiError(SHORT(3, 10));
    expect(body.errorAr).toContain('المتاح 3');
    expect(body.errorAr).toContain('والمطلوب 10');
    // And they are this call's numbers, not a constant: a second shortage
    // reads its own.
    expect(apiError(SHORT(50, 60)).body.errorAr).toContain('المتاح 50');
    expect(apiError(SHORT(50, 60)).body.errorAr).not.toContain('المتاح 3');
  });

  it('and says what to do, which is the same step at every one of the doors', () => {
    const { body } = apiError(SHORT(3, 10));
    expect(body.errorAr).toMatch(/استلم الكمية الناقصة/);
    expect(body.errorAr).toMatch(/أنقص الكمية المطلوبة/);
  });

  it('is Arabic throughout, and carries no path and no stack', () => {
    const { body } = apiError(SHORT(3, 10));
    expect(body.errorAr, 'الرسالةُ للمستودعيِّ بالعربيّة').toMatch(/[\u0600-\u06FF]/);
    expect(body.errorAr).not.toMatch(/[A-Za-z]:[\\/]/);
    expect(body.errorAr).not.toMatch(/\/(?:home|Users|var|opt|srv|app)\//);
    expect(body.errorAr).not.toMatch(/\n/);
    expect(body.errorAr).not.toMatch(/\bat \w+ \(/);
  });

  /**
   * THE GATE IS UNTOUCHED, which is the part of this file that has to be
   * run rather than claimed. `ours` refuses Prisma classes by name,
   * multi-line messages, filesystem paths and anything over two hundred
   * characters — and widening the MATCH must not widen what is ECHOED.
   */
  it('and refuses to echo the same words out of something it did not write', () => {
    const prisma = new Prisma.PrismaClientKnownRequestError(
      'المخزون غير كافٍ: المتاح 3 والمطلوب 10',
      { code: 'P2010', clientVersion: '6' }
    );
    expect(apiError(prisma).status).toBe(500);
    expect(apiError(prisma).body.error).toBe('حدث خطأ داخلي');

    const withPath = new Error(
      'المخزون غير كافٍ: المتاح 3 والمطلوب 10 — C:\\Users\\LOQ\\Documents\\osm\\src\\lib\\receiving.ts:153'
    );
    expect(apiError(withPath).status).toBe(500);

    const multiline = new Error('المخزون غير كافٍ: المتاح 3\n  at drawDownStock (receiving.ts:153)');
    expect(apiError(multiline).status).toBe(500);
  });

  /**
   * AND IT IS NOT MISTAKEN FOR A MISSING RECORD.
   *
   * «غير كافٍ» and «غير موجود» share a word, and the branch below this one
   * answers 404. A stock shortage answered 404 would be a second wrong
   * answer rather than a fixed one, so the two are kept apart — proven by
   * running both sentences through.
   */
  it('and a missing record still answers 404, while a short shelf answers 409', () => {
    expect(apiError(new Error('المحفظة غير موجودة')).status).toBe(404);
    expect(apiError(SHORT(3, 10)).status).toBe(409);
  });
});

/**
 * ───────────────────────────────────────────────────────────────────────────
 * 2 · TWO REAL DOORS, BY BEHAVIOUR
 *
 * NOTHING BELOW THE ROUTE IS MOCKED. `consumeOrderStock`, `drawDownStock`
 * and `onHandTotal` are the real functions; only `@/lib/db` is a fake, and
 * that fake applies the `where` and the `orderBy` it is handed — a fake that
 * sorted ascending whichever direction it was given is how a mutation
 * survived in `7c98b01`.
 * ───────────────────────────────────────────────────────────────────────────
 */

type Row = Record<string, any>;

function matchesWhere(row: Row, where: Row): boolean {
  for (const [key, want] of Object.entries(where)) {
    if (want && typeof want === 'object' && Array.isArray(want.in)) {
      if (!want.in.includes(row[key])) return false;
    } else if (want && typeof want === 'object' && 'gt' in want) {
      if (!((row[key] ?? 0) > want.gt)) return false;
    } else if (row[key] !== want) {
      return false;
    }
  }
  return true;
}

/** Batches on a shelf, as the database holds them. */
const batch = (id: string, storeId: string | null, qty: number): Row => ({
  id,
  companyId: COMPANY,
  storeId,
  productId: PRODUCT,
  quantityRemaining: qty,
  quantitySold: 0,
  costPerUnit: 4,
  productionDate: new Date('2026-01-01'),
});

let shelf: Row[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  shelf = [];

  requirePermission.mockResolvedValue(undefined);
  requireContext.mockResolvedValue({
    user: { id: 'u1' },
    companyId: COMPANY,
    storeId: MUBARAK,
    countryId: 'co1',
    country: { currencyCode: 'SYP', minorUnit: 2, allowNegativeStock: false },
  });

  db.productionBatch.findMany.mockImplementation(async ({ where, orderBy }: any) => {
    const rows = shelf.filter((b) => matchesWhere(b, where)).map((b) => ({ ...b }));
    // DIRECTION INCLUDED. A fake that always sorts ascending swallows a flip
    // of the draw-down's own `productionDate: 'asc'`.
    const specs: Array<[string, string]> = (Array.isArray(orderBy) ? orderBy : [orderBy ?? {}]).flatMap(
      (o: any) => Object.entries<string>(o ?? {})
    );
    for (const [key, dir] of [...specs].reverse()) {
      rows.sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0));
      if (dir === 'desc') rows.reverse();
    }
    return rows;
  });
  db.productionBatch.findFirst.mockImplementation(async ({ where }: any) =>
    shelf.filter((b) => matchesWhere(b, where)).map((b) => ({ ...b }))[0] ?? null
  );
  db.productionBatch.update.mockImplementation(async ({ where, data }: any) => {
    const row = shelf.find((b) => b.id === where.id)!;
    Object.assign(row, data);
    return row;
  });
  db.productionBatch.aggregate.mockImplementation(async ({ where }: any) => ({
    _sum: {
      quantityRemaining: shelf
        .filter((b) => matchesWhere(b, where))
        .reduce((s, b) => s + (b.quantityRemaining ?? 0), 0),
    },
  }));
  db.inventoryMovement.findFirst.mockResolvedValue(null);
  db.inventoryMovement.create.mockImplementation(async ({ data }: any) => ({ id: 'm1', ...data }));
  db.orderItem.updateMany.mockResolvedValue({ count: 0 });
  db.orderActivity.create.mockResolvedValue({ id: 'a1' });
  // The repeat key: a review line already on the order says it was consumed (none until a test writes one).
  db.orderActivity.findFirst.mockImplementation(async ({ where }: any) =>
    db.orderActivity.create.mock.calls.map((c: any) => c[0].data).find((d: any) => d.orderId === where.orderId && d.action === where.action) ?? null
  );
  db.order.update.mockResolvedValue({ id: ORDER, orderNumber: 'ORD-1', shippingStatus: 'RETURNED', version: 2 });
  // A transaction that lets a throw out, which is the behaviour at issue.
  db.$transaction.mockImplementation(async (fn: any) => fn(db));
});

describe('a delivery on a short shelf is recorded; a recount that cannot be covered says so', () => {
  /**
   * `POST /api/ops/tracking/write-off` — the smallest of the five doors
   * that reach `drawDownStock` through `consumeOrderStock`, and the one
   * `7c98b01` rewired. The order wants ten; the shelf has three.
   */
  const writeOffReq = () =>
    writeOff(
      new Request('http://localhost/api/ops/tracking/write-off', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: ORDER, reason: 'الشركة لم تُرجع البضاعة بعد شهر' }),
      })
    );

  beforeEach(() => {
    db.order.findFirst.mockImplementation(async () => ({
      id: ORDER,
      orderNumber: 'ORD-2026-0099',
      shippingStatus: 'RETURN_REQUESTED',
      trackingNumber: 'TRK-1',
      totalAmount: 100,
      deliveryProvider: { name: 'شركة' },
      replacedBy: null,
      // `consumeOrderStock` reads these off its own `order.findFirst`.
      storeId: MUBARAK,
      items: [{ productId: PRODUCT, productName: 'كريم مرطّب للوجه', quantity: 10, freeQuantity: 0 }],
      store: { country: { minorUnit: 2 } },
    }));
  });

  /*
   * CHANGED 30/10 (P0-13, OLD → NEW): this door used to refuse with 409 «المخزون غير كافٍ» when the shelf held
   * less than the order, and the order stayed «مطلوب إرجاعه» for ever. Reason: the goods HAVE left — the write-off
   * records a fact, and a record that refuses to be written leaves the books describing a parcel that does not
   * exist (LAUNCH_LINE P0-13: «بابٌ يسجّل ما حدث فعلاً يجب أن يكتب السجلَّ ويُظهر الفرق، لا أن يرفض»). The refusal
   * stays where it belongs — the stocktake door below, which is not recording a delivery.
   */
  it('a write-off on a short shelf is RECORDED, not refused — the order closes', async () => {
    shelf.push(batch('b-three', MUBARAK, 3));

    const res = await writeOffReq();
    const body = await res.json();

    expect(res.status, JSON.stringify(body)).toBe(200);
    const wroteOff = db.order.update.mock.calls.some((c: any) => c[0].data?.shippingStatus === 'RETURNED');
    expect(wroteOff, 'الطلبُ أُغلق كخسارةٍ رغم قِصَر الرفّ').toBe(true);
  });

  it('and the shelf gives what it HAS and never goes below zero', async () => {
    shelf.push(batch('b-three', MUBARAK, 3));
    await writeOffReq();

    expect(shelf[0].quantityRemaining, 'لا رصيدَ سالباً').toBe(0);
    expect(shelf[0].quantitySold).toBe(3);
    // One ledger line, for the 3 that existed — none for the 7 that did not.
    expect(db.inventoryMovement.create).toHaveBeenCalledTimes(1);
    expect(db.inventoryMovement.create.mock.calls[0][0].data.quantity).toBe(-3);
  });

  it('and the 7 it could not give are SAID on the order, as a review line with no money in it', async () => {
    shelf.push(batch('b-three', MUBARAK, 3));
    await writeOffReq();

    const said = db.orderActivity.create.mock.calls.map((c: any) => c[0].data).filter((d: any) => d.action === 'STOCK_SHORT_AT_DELIVERY');
    expect(said, 'سطرُ مراجعةٍ واحد').toHaveLength(1);
    expect(said[0].orderId).toBe(ORDER);
    expect(JSON.parse(said[0].metadata)).toMatchObject({ short: 7, lines: [{ productId: PRODUCT, need: 10, taken: 3, short: 7 }] });
    // And nothing with a price: a short order keeps its ESTIMATE. 3 units at 4 is a cost of part of the parcel, and
    // written over the whole order's estimate it would raise the profit on goods that were all handed over.
    const costWrites = db.order.update.mock.calls.map((c: any) => c[0].data?.estimatedCostOfGoods).filter((v: unknown) => v !== undefined);
    expect(costWrites).toEqual([]);
  });

  it('and a shelf that is EMPTY records the delivery too, with no movement at all', async () => {
    const res = await writeOffReq();
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect(db.inventoryMovement.create, 'لا سطرَ سجلٍّ لبضاعةٍ لم تكن على الرفّ').not.toHaveBeenCalled();
    const said = db.orderActivity.create.mock.calls.map((c: any) => c[0].data).filter((d: any) => d.action === 'STOCK_SHORT_AT_DELIVERY');
    expect(JSON.parse(said[0].metadata)).toMatchObject({ short: 10 });
    expect(db.order.update.mock.calls.some((c: any) => c[0].data?.estimatedCostOfGoods !== undefined), 'لا كلفةَ تُكتب فوق التقدير').toBe(false);
  });

  it('while a shelf that can cover it still passes — the branch refuses nothing else', async () => {
    shelf.push(batch('b-ten', MUBARAK, 10));

    const res = await writeOffReq();
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect(shelf[0].quantityRemaining).toBe(0);
    // The door's own write — `consumeOrderStock` writes the consumed cost
    // onto the same row, so the count alone would not say which happened.
    const wroteOff = db.order.update.mock.calls.some(
      (c: any) => c[0].data?.shippingStatus === 'RETURNED'
    );
    expect(wroteOff, 'الطلبُ أُغلق كخسارةٍ بعدَ خصمٍ تامّ').toBe(true);
  });

  /**
   * `POST /api/inventory` (recount) — the one door that calls
   * `drawDownStock` directly rather than through `consumeOrderStock`.
   *
   * THE SHORTFALL HERE IS REACHABLE AND NOT CONTRIVED. The door reads the
   * figure to correct with `onHandTotal`, which sums `{ companyId,
   * productId }` with no store clause, and then hands the shortfall to
   * `drawDownStock` WITH the store. A batch that carries no store — which
   * is what this door's two siblings wrote for as long as they existed —
   * is counted by the first and unreachable by the second, so the door asks
   * for more than its own shelf can give. (The same gap opens without any
   * unplaced batch at all: the `onHandTotal` read is outside the
   * transaction and the draw-down is inside it, so a delivery committing
   * between the two leaves the door asking for units that have just left.)
   */
  const recount = (countedQuantity: number) =>
    inventoryPost(
      new Request('http://localhost/api/inventory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'recount',
          productId: PRODUCT,
          countedQuantity,
          reason: 'جرد نهاية الشهر',
        }),
      })
    );

  beforeEach(() => {
    db.product.findFirst.mockResolvedValue({
      id: PRODUCT,
      name: 'كريم مرطّب للوجه',
      sourceType: 'MANUFACTURED',
    });
  });

  it('the stocktake door answers 409 too, by the same branch', async () => {
    shelf.push(batch('b-placed', MUBARAK, 50));
    shelf.push(batch('b-unplaced', null, 10));

    const res = await recount(0);
    const body = await res.json();

    expect(res.status, JSON.stringify(body)).toBe(409);
    expect(body.code).toBe('INSUFFICIENT_STOCK');
    // 60 counted by `onHandTotal`, 50 reachable by the draw-down.
    expect(body.errorAr).toContain('المتاح 50');
    expect(body.errorAr).toContain('والمطلوب 60');
  });

  it('and leaves the shelf and the ledger untouched when it refuses', async () => {
    shelf.push(batch('b-placed', MUBARAK, 50));
    shelf.push(batch('b-unplaced', null, 10));
    await recount(0);

    expect(shelf.map((b) => b.quantityRemaining)).toEqual([50, 10]);
    expect(db.inventoryMovement.create).not.toHaveBeenCalled();
  });

  it('while a stocktake its own shelf can cover is recorded as before', async () => {
    shelf.push(batch('b-placed', MUBARAK, 50));

    const res = await recount(45);
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect(shelf[0].quantityRemaining).toBe(45);
    expect(db.inventoryMovement.create).toHaveBeenCalledTimes(1);
  });
});

/**
 * ───────────────────────────────────────────────────────────────────────────
 * 3 · EVERY DOOR, BY ENUMERATION
 *
 * Two doors proven by behaviour is two of six. The defect's shape is not a
 * wrong number — it is ONE DOOR out of several answering differently from
 * the rest, which is what `7c98b01` found and what no behavioural test of
 * the other five can see. So the doors are FOUND rather than listed: every
 * route under `src/app/api` that reaches `drawDownStock`, directly or
 * through `consumeOrderStock` / `restoreOrderStock` / `recordPartialDelivery`,
 * must route its `catch` through the shared mapper.
 *
 * Comments and template literals are blanked first, so a route that merely
 * MENTIONS `apiError` in prose does not pass.
 * ───────────────────────────────────────────────────────────────────────────
 */

const REPO = process.cwd();

/** What, when called, can end in `drawDownStock`. */
const REACHES_SHELF = /\b(?:drawDownStock|consumeOrderStock|restoreOrderStock|recordPartialDelivery)\s*\(/;
/** The shared mapper, by either of the two names it is used under. */
const SHARED_MAPPER = /\b(?:apiErrorResponse|apiError)\s*\(/;

function routeFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      routeFiles(full, out);
    } else if (entry === 'route.ts') {
      out.push(full);
    }
  }
  return out;
}

interface Door {
  rel: string;
  mapped: boolean;
}

function doorsThatReachTheShelf(): Door[] {
  const out: Door[] = [];
  for (const file of routeFiles(join(REPO, 'src', 'app', 'api'))) {
    const src = stripTemplates(stripComments(readFileSync(file, 'utf8')));
    if (!REACHES_SHELF.test(src)) continue;
    out.push({
      rel: relative(REPO, file).split(sep).join('/'),
      mapped: SHARED_MAPPER.test(src),
    });
  }
  return out;
}

describe('every door that can empty a shelf answers through the shared mapper', () => {
  const doors = doorsThatReachTheShelf();

  it('finds the doors that actually exist, so the sweep is not looking at nothing', () => {
    // The five known today, by path. A sixth appearing here is a door
    // somebody must classify; one disappearing is a door that stopped
    // touching stock, and either way this list is the thing to read.
    expect(doors.length, JSON.stringify(doors, null, 1)).toBeGreaterThanOrEqual(5);
    const paths = doors.map((d) => d.rel);
    for (const expected of [
      'src/app/api/inventory/route.ts',
      'src/app/api/orders/[id]/route.ts',
      'src/app/api/orders/[id]/shipping/route.ts',
      'src/app/api/finance/statements/[id]/route.ts',
      'src/app/api/ops/tracking/write-off/route.ts',
      'src/app/api/ops/tracking/deliver/route.ts',
    ]) {
      expect(paths, `${expected} يَستهلِكُ المخزونَ ولم يَرَه الكنس`).toContain(expected);
    }
  });

  it('and every one of them hands its error to the mapper rather than answering alone', () => {
    const unmapped = doors.filter((d) => !d.mapped).map((d) => d.rel);
    expect(
      unmapped,
      'بابٌ يَستهلِكُ المخزونَ ولا يَمُرُّ بالمُحوِّلِ المشترك — رفٌّ قاصرٌ عندَه يُجيبُ ٥٠٠'
    ).toEqual([]);
  });

  /**
   * THE DETECTOR STILL RECOGNISES WHAT IT WAS WRITTEN FOR.
   *
   * Ten vacuous guards have been caught in this audit. These are the ways
   * this one could go blind, each run rather than assumed.
   */
  it('recognises a door that answers alone, and is not fooled by prose', () => {
    const alone = 'await consumeOrderStock(tx, {});\n} catch (e) { return NextResponse.json({ error: String(e) }, { status: 500 }); }';
    const mapped = 'await consumeOrderStock(tx, {});\n} catch (e) { return apiErrorResponse(e); }';

    expect(REACHES_SHELF.test(alone)).toBe(true);
    expect(SHARED_MAPPER.test(alone)).toBe(false);
    expect(SHARED_MAPPER.test(mapped)).toBe(true);

    // A SENTENCE ABOUT THE MAPPER IS NOT THE MAPPER — the exact failure
    // shape this audit keeps finding, in both the forms this repo writes.
    expect(SHARED_MAPPER.test(stripComments(`/* apiErrorResponse(e) */\n${alone}`))).toBe(false);
    expect(SHARED_MAPPER.test(stripComments(`// apiErrorResponse(e)\n${alone}`))).toBe(false);
    expect(SHARED_MAPPER.test(stripTemplates('const s = `apiErrorResponse(e)`;'))).toBe(false);

    // And a door that only MENTIONS the stock functions in prose is not a
    // door that calls them.
    expect(REACHES_SHELF.test(stripComments('// consumeOrderStock(tx, {})\nconst x = 1;'))).toBe(false);
    // The import line alone is not a call, and the names are not substrings
    // of some unrelated identifier.
    expect(REACHES_SHELF.test("import { consumeOrderStock } from '@/lib/stock-consumption';")).toBe(false);
    expect(REACHES_SHELF.test('myConsumeOrderStockWrapper(')).toBe(false);
  });
});
