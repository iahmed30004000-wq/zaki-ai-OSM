import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { placeStore, previewPlacement, PlacementRefused, RECOUNT_FIRST_AR, type PlacementCount } from './warehouse-placement';
import { reserveOrderLines } from './reservation';

/**
 * THE OPENING PLACEMENT — conservation on random stores, the exactness refusal, once per store, the preview ≡ the press,
 * the lock, and the edge cases of the row (a product with no stock, one only with the courier, a batch at cost zero with
 * its reason, a product with combinations).
 *
 * The database is an in-memory one that answers the queries these modules send — with its own `where` evaluator, so
 * which rows count is decided by the code under test. It knows ONLY the tables a placement may touch: a read or a write
 * of any other (a movement, a wallet, an expense) throws, which is how «the placement writes no adjustment and no money»
 * is enforced here rather than hoped. Every expected figure below is computed by THIS file from the rows, never by the
 * function under test.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- an in-memory row; every field is read by name
type Row = Record<string, any>;

const ALLOWED_TABLES = ['productionBatch', 'product', 'productVariant', 'orderItem', 'orderAddOn', 'order', 'store', 'warehouse', 'warehousePlacement'];

function scalarMatches(v: unknown, cond: unknown): boolean {
  if (cond === null) return v === null || v === undefined;
  if (cond instanceof Date) return v instanceof Date && v.getTime() === cond.getTime();
  if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
    const c = cond as Row;
    if ('in' in c && !(c.in as unknown[]).includes(v)) return false;
    if ('notIn' in c && (c.notIn as unknown[]).includes(v)) return false;
    if ('not' in c) {
      if (c.not === null ? v === null || v === undefined : v === c.not) return false;
    }
    if ('gt' in c && !((v as number) > c.gt)) return false;
    if ('gte' in c && !((v as number) >= c.gte)) return false;
    if ('lt' in c && !((v as number) < c.lt)) return false;
    return true;
  }
  return v === cond;
}

function makeDb(data: Record<string, Row[]>) {
  const log: Row[] = [];
  let seq = 0;
  const matches = (table: string, row: Row, where: Row = {}): boolean => {
    for (const [k, cond] of Object.entries(where)) {
      if (cond === undefined) continue;
      if (k === 'OR') { if (!(cond as Row[]).some((w) => matches(table, row, w))) return false; continue; }
      if (k === 'AND') { if (!(cond as Row[]).every((w) => matches(table, row, w))) return false; continue; }
      if (k === 'order' && (table === 'orderItem' || table === 'orderAddOn')) {
        const o = data.order.find((x) => x.id === row.orderId);
        if (!o || !matches('order', o, cond as Row)) return false;
        continue;
      }
      if (!scalarMatches(row[k], cond)) return false;
    }
    return true;
  };
  const project = (r: Row, select?: Row) => {
    if (!select) return { ...r };
    const out: Row = {};
    for (const [k, v] of Object.entries(select)) if (v === true) out[k] = r[k];
    return out;
  };
  const sortBy = (rows: Row[], orderBy?: Row | Row[]) => {
    if (!orderBy) return rows;
    const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]).flatMap((o) => Object.entries(o));
    return [...rows].sort((a, b) => {
      for (const [k, dir] of keys) {
        const x = a[k] instanceof Date ? a[k].getTime() : a[k];
        const y = b[k] instanceof Date ? b[k].getTime() : b[k];
        if (x < y) return dir === 'desc' ? 1 : -1;
        if (x > y) return dir === 'desc' ? -1 : 1;
      }
      return 0;
    });
  };
  const apply = (r: Row, d: Row) => {
    for (const [k, v] of Object.entries(d)) {
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        if ('increment' in v) r[k] += v.increment;
        else if ('decrement' in v) r[k] -= v.decrement;
      } else r[k] = v;
    }
  };
  const table = (name: string) => {
    const rows = () => (data[name] ??= []);
    return {
      findMany: async ({ where, select, orderBy }: Row = {}) => (log.push({ t: name, op: 'read' }), sortBy(rows().filter((r) => matches(name, r, where)), orderBy).map((r) => project(r, select))),
      findFirst: async ({ where, select }: Row = {}) => {
        log.push({ t: name, op: 'read' });
        const r = rows().find((x) => matches(name, x, where));
        return r ? project(r, select) : null;
      },
      findUnique: async ({ where, select }: Row) => {
        log.push({ t: name, op: 'read' });
        const r = rows().find((x) => matches(name, x, where));
        return r ? project(r, select) : null;
      },
      create: async ({ data: d, select }: Row) => {
        log.push({ t: name, op: 'write' });
        if (name === 'warehousePlacement' && rows().some((r) => r.storeId === d.storeId)) throw new Error('unique storeId');
        if (name === 'productionBatch' && rows().some((r) => r.companyId === d.companyId && r.batchNumber === d.batchNumber)) throw new Error('unique batchNumber');
        const row: Row = { id: `${name}-${++seq}`, createdAt: new Date(), ...d };
        rows().push(row);
        return project(row, select);
      },
      updateMany: async ({ where, data: d }: Row) => {
        log.push({ t: name, op: 'write' });
        const hit = rows().filter((r) => matches(name, r, where));
        for (const r of hit) apply(r, d);
        return { count: hit.length };
      },
      update: async ({ where, data: d }: Row) => {
        log.push({ t: name, op: 'write' });
        const r = rows().find((x) => matches(name, x, where))!;
        apply(r, d);
        return { ...r };
      },
      groupBy: async ({ by, where, _sum }: Row) => {
        log.push({ t: name, op: 'read' });
        const groups = new Map<string, Row>();
        for (const r of rows().filter((x) => matches(name, x, where))) {
          const key = (by as string[]).map((b) => r[b]).join('|');
          const g = groups.get(key) ?? { ...Object.fromEntries((by as string[]).map((b) => [b, r[b]])), _sum: Object.fromEntries(Object.keys(_sum).map((k) => [k, 0])) };
          for (const k of Object.keys(_sum)) g._sum[k] += r[k];
          groups.set(key, g);
        }
        return [...groups.values()];
      },
      aggregate: async ({ where, _sum }: Row) => {
        log.push({ t: name, op: 'read' });
        const hit = rows().filter((x) => matches(name, x, where));
        return { _sum: Object.fromEntries(Object.keys(_sum).map((k) => [k, hit.reduce((s, r) => s + r[k], 0)])) };
      },
    };
  };
  const delegates: Row = Object.fromEntries(ALLOWED_TABLES.map((t) => [t, table(t)]));
  delegates.$executeRaw = async (_s: TemplateStringsArray, ...values: unknown[]) => (log.push({ t: 'lock', op: 'lock', values }), 1);
  const tx = new Proxy(delegates, {
    get(target, prop) {
      if (typeof prop === 'string' && !(prop in target) && prop !== 'then') throw new Error(`a placement touched «${prop}»`);
      return target[prop as string];
    },
  });
  const root = new Proxy(
    { ...delegates, $transaction: async (fn: (t: Row) => unknown) => fn(tx) },
    { get: (t, p) => (t as Row)[p as string] }
  );
  return { tx: tx as never, root: root as never, log, data };
}

/* ───────────── a random store ───────────── */

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const C = 'c1';
const S = 's1';
const COUNTRY = 'k1';
const SHIPPING = ['PENDING', 'READY_TO_SHIP', 'READY_FOR_PICKUP', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'PARTIALLY_DELIVERED', 'FAILED_DELIVERY', 'RETURN_REQUESTED', 'RETURNED', 'CANCELLED'];
const CONFIRMATION = ['PENDING', 'CONFIRMED', 'CONFIRMED', 'CONFIRMED', 'REJECTED', 'CANCELLED'];

function randomStore(seed: number) {
  const r = rng(seed);
  const int = (n: number) => Math.floor(r() * n);
  const days = [0, 1, 2, 5].map((d) => new Date(Date.UTC(2026, 9, 1 + d)));
  const data: Record<string, Row[]> = {
    store: [{ id: S, companyId: C, countryId: COUNTRY }, { id: 's2', companyId: C, countryId: COUNTRY }],
    warehouse: [
      { id: 'w1', companyId: C, countryId: COUNTRY, isActive: true },
      { id: 'w2', companyId: C, countryId: COUNTRY, isActive: true },
      { id: 'w3', companyId: C, countryId: COUNTRY, isActive: true },
    ],
    warehousePlacement: [],
    product: [],
    productVariant: [],
    productionBatch: [],
    order: [],
    orderItem: [],
    orderAddOn: [],
  };
  let created = 0;
  const nProducts = 1 + int(6);
  for (let p = 0; p < nProducts; p++) {
    const id = `p${p}`;
    data.product.push({ id, companyId: C, storeId: S, name: `منتج ${p}`, sku: `SKU${p}` });
    if (r() < 0.2) data.productVariant.push({ id: `v${p}`, companyId: C, productId: id, status: 'ACTIVE' });
    for (let b = int(5); b > 0; b--) {
      const produced = int(40);
      const sold = int(produced + 1);
      // Now and then a row the shelf owes (a negative remaining) — it must net against the courier units, not be placed.
      const remaining = r() < 0.08 ? -int(3) - 1 : produced - sold;
      const cost = r() < 0.15 ? 0 : Math.round(r() * 100000) / 10000;
      data.productionBatch.push({
        id: `b${p}-${b}`,
        companyId: C,
        storeId: S,
        productId: id,
        batchNumber: `RCV-${p}-${b}`,
        quantityProduced: produced,
        // A row that owes units has sold more than it produced: the identity holds before the placement, so it can be held after.
        quantitySold: produced - remaining,
        quantityRemaining: remaining,
        quantityMovedIn: 0,
        quantityMovedOut: 0,
        costPerUnit: cost,
        totalProductionCost: cost * produced,
        manufacturingCost: 0,
        productionDate: days[int(days.length)],
        createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, ++created)),
        status: 'COMPLETED',
        notes: cost === 0 ? 'عيّنة مجانية' : null,
        warehouseId: null,
        inTransitTransferId: null,
        splitFromBatchId: null,
        openingCountId: null,
      });
    }
  }
  const nOrders = int(10);
  for (let o = 0; o < nOrders; o++) {
    const shipping = SHIPPING[int(SHIPPING.length)];
    data.order.push({
      id: `o${o}`,
      storeId: r() < 0.85 ? S : 's2',
      confirmationStatus: CONFIRMATION[int(CONFIRMATION.length)],
      shippingStatus: shipping,
      shippedAt: r() < 0.3 ? new Date() : null,
      labelPrintedAt: r() < 0.3 ? new Date() : null,
    });
    for (let i = int(3); i > 0; i--) {
      const productId = `p${int(nProducts)}`;
      data.orderItem.push({ id: `oi${o}-${i}`, orderId: `o${o}`, companyId: C, productId, reservedQty: int(4) });
    }
    if (r() < 0.3) data.orderAddOn.push({ id: `oa${o}`, orderId: `o${o}`, companyId: C, productId: `p${int(nProducts)}`, reservedQty: int(3) });
  }
  return { data, r };
}

/* ───────────── the figures, computed here and only here ───────────── */

const GONE = ['SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'PARTIALLY_DELIVERED', 'FAILED_DELIVERY', 'RETURN_REQUESTED', 'RETURNED'];
const holds = (o: Row) => o.storeId === S && !['REJECTED', 'CANCELLED'].includes(o.confirmationStatus) && !['DELIVERED', 'CANCELLED'].includes(o.shippingStatus);
const left = (o: Row) => !!o.shippedAt || GONE.includes(o.shippingStatus) || !!o.labelPrintedAt || o.shippingStatus === 'READY_FOR_PICKUP';

function heldBy(data: Record<string, Row[]>, productId: string, also: (o: Row) => boolean = () => true) {
  let n = 0;
  for (const line of [...data.orderItem, ...data.orderAddOn]) {
    if (line.productId !== productId || line.reservedQty <= 0) continue;
    const o = data.order.find((x) => x.id === line.orderId)!;
    if (holds(o) && also(o)) n += line.reservedQty;
  }
  return n;
}

const round4 = (n: number) => Number(n.toFixed(4));

/** The balances screen's figures of each product, as that screen adds them, plus the draw order of unit costs. */
function figures(data: Record<string, Row[]>) {
  const out: Row = {};
  for (const p of data.product) {
    const bs = data.productionBatch.filter((b) => b.productId === p.id);
    const remaining = bs.reduce((s, b) => s + b.quantityRemaining, 0);
    const reserved = heldBy(data, p.id);
    const fifo: number[] = [];
    for (const b of [...bs].filter((x) => x.quantityRemaining > 0).sort((a, c) => a.productionDate - c.productionDate || a.createdAt - c.createdAt)) {
      for (let i = 0; i < b.quantityRemaining; i++) fifo.push(b.costPerUnit);
    }
    out[p.id] = {
      onShelf: remaining,
      reserved,
      available: remaining - reserved,
      in: bs.reduce((s, b) => s + b.quantityProduced, 0),
      out: bs.reduce((s, b) => s + b.quantitySold, 0),
      value: round4(bs.filter((b) => b.quantityRemaining > 0).reduce((s, b) => s + b.quantityRemaining * b.costPerUnit, 0)),
      totalCost: round4(bs.reduce((s, b) => s + b.totalProductionCost, 0)),
      fifo,
    };
  }
  return out;
}

/** Counts that agree with the book: each product's to-place split at random across the warehouses given. */
function exactCounts(data: Record<string, Row[]>, r: () => number, warehouses: string[]): PlacementCount[] | null {
  const counts: PlacementCount[] = warehouses.map((w) => ({ warehouseId: w, lines: [] }));
  for (const p of data.product) {
    const onHand = data.productionBatch.filter((b) => b.productId === p.id).reduce((s, b) => s + b.quantityRemaining, 0);
    const toPlace = onHand - heldBy(data, p.id, left);
    if (toPlace < 0) return null;
    let rest = toPlace;
    warehouses.forEach((w, i) => {
      const n = i === warehouses.length - 1 ? rest : Math.floor(r() * (rest + 1));
      rest -= n;
      if (n > 0 || r() < 0.5) counts[i].lines.push({ productId: p.id, quantity: n });
    });
  }
  return counts;
}

const press = (tx: never, counts: PlacementCount[]) =>
  placeStore(tx, { companyId: C, storeId: S, countedByName: 'أمين المخزن', countedAt: new Date('2026-11-01T10:00:00Z'), recordedById: 'u1', counts, now: new Date('2026-11-02T10:00:00Z') });

/* ───────────── conservation ───────────── */

describe('the placement moves no figure — conservation on random stores', () => {
  const SCENARIOS = 400;
  it(`${SCENARIOS} random stores: every balance figure, Σ produced, Σ sold, the stock value and the FIFO cost order are unchanged; every unit not with the courier has a place`, async () => {
    let placedStores = 0;
    let twins = 0;
    for (let seed = 1; seed <= SCENARIOS; seed++) {
      const { data, r } = randomStore(seed);
      const order = ['w1', 'w2', 'w3'].slice(0, 1 + Math.floor(r() * 3));
      const counts = exactCounts(data, r, order);
      if (!counts) continue;
      const before = figures(data);
      const { tx, log } = makeDb(data);
      const { plan } = await press(tx, counts);
      placedStores++;
      const after = figures(data);
      expect(after, `seed ${seed}`).toEqual(before);

      for (const p of data.product) {
        const bs = data.productionBatch.filter((b) => b.productId === p.id);
        // Unplaced, net, is exactly the units with the courier.
        expect(bs.filter((b) => b.warehouseId === null).reduce((s, b) => s + b.quantityRemaining, 0), `seed ${seed} ${p.id}`).toBe(heldBy(data, p.id, left));
        // And each warehouse holds exactly what was counted in it.
        for (const c of counts) {
          const counted = c.lines.find((l) => l.productId === p.id)?.quantity ?? 0;
          expect(bs.filter((b) => b.warehouseId === c.warehouseId).reduce((s, b) => s + b.quantityRemaining, 0), `seed ${seed} ${p.id} ${c.warehouseId}`).toBe(counted);
        }
        for (const b of bs) {
          // Every row's identity.
          expect(b.quantityRemaining).toBe(b.quantityProduced + b.quantityMovedIn - b.quantitySold - b.quantityMovedOut);
          expect(b.inTransitTransferId).toBeNull();
          if (b.splitFromBatchId) {
            twins++;
            const parent = data.productionBatch.find((x) => x.id === b.splitFromBatchId)!;
            expect(b.quantityProduced).toBe(0);
            expect(b.quantitySold).toBe(0);
            expect(b.totalProductionCost).toBe(0);
            expect(b.costPerUnit).toBe(parent.costPerUnit);
            expect(b.productionDate).toEqual(parent.productionDate);
            expect(b.createdAt).toEqual(parent.createdAt);
            expect(b.notes).toBe(parent.notes);
            expect(b.openingCountId ?? null).toBeNull();
            expect(b.batchNumber).toMatch(new RegExp(`^${parent.batchNumber}~[0-9a-f]{6}$`));
            expect(b.warehouseId).not.toBeNull();
          }
        }
        // A row holding nothing or less is never touched.
        for (const b of bs.filter((x) => !x.splitFromBatchId && x.quantityMovedOut === 0 && x.quantityRemaining <= 0)) expect(b.warehouseId).toBeNull();
      }
      // It wrote only batches and its own row — never a movement, a wallet, an expense.
      expect(new Set(log.filter((l) => l.op === 'write').map((l) => l.t))).toEqual(new Set(plan.steps.length ? ['warehousePlacement', 'productionBatch'] : ['warehousePlacement']));
    }
    expect(placedStores, 'the generator must produce placeable stores').toBeGreaterThan(SCENARIOS / 2);
    expect(twins, 'and stores whose batches are shared between warehouses').toBeGreaterThan(50);
  });
});

/* ───────────── the preview is the press ───────────── */

describe('the preview ≡ what the placement then does', () => {
  it('on random stores: the same table, the same steps — and the preview wrote nothing', async () => {
    let compared = 0;
    for (let seed = 1000; seed < 1150; seed++) {
      const { data, r } = randomStore(seed);
      const counts = exactCounts(data, r, ['w2', 'w1']);
      if (!counts) continue;
      const snapshot = structuredClone(data);
      const { tx, root, log } = makeDb(data);
      const preview = await previewPlacement(root, { companyId: C, storeId: S, counts });
      expect(log.filter((l) => l.op === 'write')).toEqual([]);
      expect(data).toEqual(snapshot);
      const { plan } = await press(tx, counts);
      expect(plan).toEqual(preview);
      // And the rows are what the steps said.
      for (const step of plan.steps) {
        const b = data.productionBatch.find((x) => x.id === step.batchId)!;
        expect([b.warehouseId, b.quantityRemaining]).toEqual([step.keep.warehouseId, step.keep.quantity]);
        const kids = data.productionBatch.filter((x) => x.splitFromBatchId === b.id);
        expect(kids.map((k) => [k.warehouseId, k.quantityRemaining])).toEqual(step.twins.map((t) => [t.warehouseId, t.quantity]));
      }
      compared++;
    }
    expect(compared).toBeGreaterThan(50);
  });

  it('a preview of counts that disagree says which products and how, and says the recount sentence', async () => {
    const { data } = randomStore(7);
    data.product = [{ id: 'p0', companyId: C, storeId: S, name: 'منتج', sku: null }];
    data.productionBatch = data.productionBatch.filter((b) => b.productId === 'p0');
    data.orderItem = [];
    data.orderAddOn = [];
    data.productionBatch = [{ ...baseBatch('b1', 10, 1.5) }];
    const { root } = makeDb(data);
    const plan = await previewPlacement(root, { companyId: C, storeId: S, counts: [{ warehouseId: 'w1', lines: [{ productId: 'p0', quantity: 9 }] }] });
    expect(plan.exact).toBe(false);
    expect(plan.steps).toEqual([]);
    expect(plan.differing.map((d) => [d.productId, d.toPlace, d.counted, d.difference])).toEqual([['p0', 10, 9, -1]]);
  });
});

function baseBatch(id: string, remaining: number, cost: number, over: Row = {}): Row {
  return {
    id,
    companyId: C,
    storeId: S,
    productId: 'p0',
    batchNumber: `RCV-${id}`,
    quantityProduced: remaining,
    quantitySold: 0,
    quantityRemaining: remaining,
    quantityMovedIn: 0,
    quantityMovedOut: 0,
    costPerUnit: cost,
    totalProductionCost: cost * remaining,
    productionDate: new Date('2026-10-01'),
    createdAt: new Date(`2026-10-01T00:00:${String(id.length).padStart(2, '0')}Z`),
    status: 'COMPLETED',
    notes: null,
    warehouseId: null,
    inTransitTransferId: null,
    splitFromBatchId: null,
    openingCountId: null,
    ...over,
  };
}

function oneProductStore(batches: Row[], extra: Partial<Record<string, Row[]>> = {}) {
  return {
    store: [{ id: S, companyId: C, countryId: COUNTRY }],
    warehouse: [
      { id: 'w1', companyId: C, countryId: COUNTRY, isActive: true },
      { id: 'w2', companyId: C, countryId: COUNTRY, isActive: true },
      { id: 'wOff', companyId: C, countryId: COUNTRY, isActive: false },
      { id: 'wAbroad', companyId: C, countryId: 'k2', isActive: true },
      { id: 'wForeign', companyId: 'c2', countryId: COUNTRY, isActive: true },
    ],
    warehousePlacement: [],
    product: [{ id: 'p0', companyId: C, storeId: S, name: 'منتج', sku: null }],
    productVariant: [],
    productionBatch: batches,
    order: [],
    orderItem: [],
    orderAddOn: [],
    ...extra,
  } as Record<string, Row[]>;
}

/* ───────────── exactness and once ───────────── */

describe('a count must equal the book exactly, and a store is placed once', () => {
  it('NEGATIVE: one unit off is refused with the products and the recount sentence — and nothing is written', async () => {
    const data = oneProductStore([baseBatch('b1', 10, 2), baseBatch('b22', 5, 3)]);
    const snapshot = structuredClone(data);
    const { tx, log } = makeDb(data);
    const err = await press(tx, [{ warehouseId: 'w1', lines: [{ productId: 'p0', quantity: 16 }] }]).catch((e) => e);
    expect(err).toBeInstanceOf(PlacementRefused);
    expect(err.code).toBe('NOT_EXACT');
    expect(err.errorAr).toContain(RECOUNT_FIRST_AR);
    expect(err.errorAr).toContain('«منتج» (لازم 15، انعدّ 16)');
    expect(err.differing.map((d: Row) => d.productId)).toEqual(['p0']);
    expect(log.filter((l) => l.op === 'write')).toEqual([]);
    expect(data).toEqual(snapshot);
  });

  it('NEGATIVE: a product nobody counted is a count of zero — refused while the book holds units of it', async () => {
    const data = oneProductStore([baseBatch('b1', 3, 2)]);
    const err = await press(makeDb(data).tx, [{ warehouseId: 'w1', lines: [] }]).catch((e) => e);
    expect(err.code).toBe('NOT_EXACT');
  });

  it('NEGATIVE: a second placement of the same store is refused, by name and date', async () => {
    const data = oneProductStore([baseBatch('b1', 10, 2)]);
    const { tx } = makeDb(data);
    await press(tx, [{ warehouseId: 'w1', lines: [{ productId: 'p0', quantity: 10 }] }]);
    const err = await press(tx, [{ warehouseId: 'w1', lines: [{ productId: 'p0', quantity: 10 }] }]).catch((e) => e);
    expect(err.code).toBe('ALREADY_PLACED');
    expect(err.errorAr).toContain('أمين المخزن');
    expect(data.warehousePlacement).toHaveLength(1);
    // And the preview says so too.
    const again = await previewPlacement(makeDb(data).root, { companyId: C, storeId: S, counts: [] }).catch((e) => e);
    expect(again.code).toBe('ALREADY_PLACED');
  });

  it('NEGATIVE: a batch that already has a place is refused (a placement is the first)', async () => {
    const data = oneProductStore([baseBatch('b1', 10, 2, { warehouseId: 'w2' })]);
    const err = await press(makeDb(data).tx, [{ warehouseId: 'w1', lines: [{ productId: 'p0', quantity: 10 }] }]).catch((e) => e);
    expect(err.code).toBe('ALREADY_HAS_PLACES');
  });
});

/* ───────────── the checks on the counts ───────────── */

describe('the counts are checked before anything is read under the lock', () => {
  const cases: [string, PlacementCount[], string][] = [
    ['no warehouse at all', [], 'NO_WAREHOUSE'],
    ['the same warehouse twice', [{ warehouseId: 'w1', lines: [] }, { warehouseId: 'w1', lines: [] }], 'WAREHOUSE_TWICE'],
    ['a warehouse that does not exist', [{ warehouseId: 'nope', lines: [] }], 'WAREHOUSE_NOT_FOUND'],
    ['a warehouse of ANOTHER COMPANY (not found, by the company filter)', [{ warehouseId: 'wForeign', lines: [] }], 'WAREHOUSE_NOT_FOUND'],
    ['a warehouse of another country', [{ warehouseId: 'wAbroad', lines: [] }], 'WAREHOUSE_OTHER_COUNTRY'],
    ['a stopped warehouse', [{ warehouseId: 'wOff', lines: [] }], 'WAREHOUSE_STOPPED'],
    ['a product of another store', [{ warehouseId: 'w1', lines: [{ productId: 'pX', quantity: 1 }] }], 'PRODUCT_NOT_IN_STORE'],
    ['a product twice in one warehouse', [{ warehouseId: 'w1', lines: [{ productId: 'p0', quantity: 1 }, { productId: 'p0', quantity: 1 }] }], 'PRODUCT_TWICE'],
    ['a negative count', [{ warehouseId: 'w1', lines: [{ productId: 'p0', quantity: -1 }] }], 'QUANTITY_INVALID'],
    ['a fractional count', [{ warehouseId: 'w1', lines: [{ productId: 'p0', quantity: 1.5 }] }], 'QUANTITY_INVALID'],
  ];
  it.each(cases)('NEGATIVE: %s', async (_name, counts, code) => {
    const data = oneProductStore([baseBatch('b1', 2, 1)]);
    const { tx, log } = makeDb(data);
    const err = await press(tx, counts).catch((e) => e);
    expect(err).toBeInstanceOf(PlacementRefused);
    expect(err.code).toBe(code);
    expect(err.errorAr).toMatch(/[؀-ۿ]/);
    expect(log.filter((l) => l.op === 'write' || l.op === 'lock')).toEqual([]);
  });

  it('NEGATIVE: no counter’s name, and a count in the future', async () => {
    const data = oneProductStore([]);
    const base = { companyId: C, storeId: S, recordedById: 'u1', counts: [{ warehouseId: 'w1', lines: [] }], now: new Date('2026-11-02T10:00:00Z') };
    expect((await placeStore(makeDb(data).tx, { ...base, countedByName: '  ab ', countedAt: new Date('2026-11-01') }).catch((e) => e)).code).toBe('NO_COUNTER');
    expect((await placeStore(makeDb(data).tx, { ...base, countedByName: 'أمين', countedAt: new Date('2026-11-03') }).catch((e) => e)).code).toBe('COUNT_IN_FUTURE');
  });

  it('NEGATIVE: a store of another company is not found', async () => {
    const data = oneProductStore([]);
    data.store = [{ id: S, companyId: 'c2', countryId: COUNTRY }];
    expect((await press(makeDb(data).tx, [{ warehouseId: 'w1', lines: [] }]).catch((e) => e)).code).toBe('STORE_NOT_FOUND');
  });
});

/* ───────────── the distribution ───────────── */

describe('how the units are divided — warehouses in the order given, oldest batch first', () => {
  it('a batch that goes whole to one warehouse is given it, with no twin; a shared one is split, oldest first', async () => {
    const data = oneProductStore([
      baseBatch('old', 6, 1, { productionDate: new Date('2026-09-01') }),
      baseBatch('mid', 10, 2, { productionDate: new Date('2026-09-10') }),
      baseBatch('new', 4, 3, { productionDate: new Date('2026-09-20') }),
    ]);
    await press(makeDb(data).tx, [
      { warehouseId: 'w2', lines: [{ productId: 'p0', quantity: 9 }] },
      { warehouseId: 'w1', lines: [{ productId: 'p0', quantity: 11 }] },
    ]);
    const row = (id: string) => data.productionBatch.find((b) => b.id === id)!;
    const twinsOf = (id: string) => data.productionBatch.filter((b) => b.splitFromBatchId === id).map((b) => [b.warehouseId, b.quantityRemaining]);
    expect([row('old').warehouseId, row('old').quantityRemaining, twinsOf('old')]).toEqual(['w2', 6, []]);
    expect([row('mid').warehouseId, row('mid').quantityRemaining, row('mid').quantityMovedOut, twinsOf('mid')]).toEqual(['w2', 3, 7, [['w1', 7]]]);
    expect([row('new').warehouseId, twinsOf('new')]).toEqual(['w1', []]);
  });

  it('a product only with the courier: nothing is counted, nothing is touched, it stays unplaced', async () => {
    const data = oneProductStore([baseBatch('b1', 4, 2)], {
      order: [{ id: 'o1', storeId: S, confirmationStatus: 'CONFIRMED', shippingStatus: 'SHIPPED', shippedAt: new Date(), labelPrintedAt: new Date() }],
      orderItem: [{ id: 'i1', orderId: 'o1', companyId: C, productId: 'p0', reservedQty: 4 }],
    });
    const { tx } = makeDb(data);
    const { plan } = await press(tx, [{ warehouseId: 'w1', lines: [] }]);
    expect(plan.rows[0]).toMatchObject({ onHand: 4, withCourier: 4, toPlace: 0, counted: 0 });
    expect(plan.steps).toEqual([]);
    expect(data.productionBatch[0]).toMatchObject({ warehouseId: null, quantityRemaining: 4, quantityMovedOut: 0 });
  });

  it('the courier’s units are the newest and stay in the batch row; the placed part leaves as a twin', async () => {
    const data = oneProductStore([baseBatch('b1', 10, 2)], {
      order: [{ id: 'o1', storeId: S, confirmationStatus: 'CONFIRMED', shippingStatus: 'READY_FOR_PICKUP', shippedAt: null, labelPrintedAt: null }],
      orderItem: [{ id: 'i1', orderId: 'o1', companyId: C, productId: 'p0', reservedQty: 3 }],
    });
    await press(makeDb(data).tx, [{ warehouseId: 'w1', lines: [{ productId: 'p0', quantity: 7 }] }]);
    expect(data.productionBatch.map((b) => [b.id === 'b1' ? 'parent' : 'twin', b.warehouseId, b.quantityRemaining])).toEqual([
      ['parent', null, 3],
      ['twin', 'w1', 7],
    ]);
  });

  it('NEGATIVE: an order only CONFIRMED (not left), a DELIVERED one, a REJECTED one and another store’s do not count as with the courier', async () => {
    const data = oneProductStore([baseBatch('b1', 10, 2)], {
      order: [
        { id: 'o1', storeId: S, confirmationStatus: 'CONFIRMED', shippingStatus: 'READY_TO_SHIP', shippedAt: null, labelPrintedAt: null },
        { id: 'o2', storeId: S, confirmationStatus: 'CONFIRMED', shippingStatus: 'DELIVERED', shippedAt: new Date(), labelPrintedAt: new Date() },
        { id: 'o3', storeId: S, confirmationStatus: 'REJECTED', shippingStatus: 'SHIPPED', shippedAt: new Date(), labelPrintedAt: null },
        { id: 'o4', storeId: 's2', confirmationStatus: 'CONFIRMED', shippingStatus: 'SHIPPED', shippedAt: new Date(), labelPrintedAt: null },
        // …while a labelled parcel still on our side IS committed (the waybill line), and so is a returned one not yet received.
        { id: 'o5', storeId: S, confirmationStatus: 'CONFIRMED', shippingStatus: 'READY_TO_SHIP', shippedAt: null, labelPrintedAt: new Date() },
        { id: 'o6', storeId: S, confirmationStatus: 'CONFIRMED', shippingStatus: 'RETURNED', shippedAt: new Date(), labelPrintedAt: null },
      ],
      orderItem: ['o1', 'o2', 'o3', 'o4', 'o5', 'o6'].map((o, i) => ({ id: `i${i}`, orderId: o, companyId: C, productId: 'p0', reservedQty: 1 })),
      orderAddOn: [{ id: 'a1', orderId: 'o5', companyId: C, productId: 'p0', reservedQty: 1 }],
    });
    const plan = await previewPlacement(makeDb(data).root, { companyId: C, storeId: S, counts: [] });
    expect(plan.rows[0]).toMatchObject({ onHand: 10, withCourier: 3, toPlace: 7 });
  });

  it('a product with no stock at all: a row of zeros, placed by a count of zero', async () => {
    const data = oneProductStore([]);
    const { plan } = await press(makeDb(data).tx, [{ warehouseId: 'w1', lines: [{ productId: 'p0', quantity: 0 }] }]);
    expect(plan.rows[0]).toMatchObject({ onHand: 0, withCourier: 0, toPlace: 0, counted: 0, difference: 0 });
    expect(data.warehousePlacement).toHaveLength(1);
  });

  it('a batch at cost zero keeps its reason and its zero on every part', async () => {
    const data = oneProductStore([baseBatch('b1', 8, 0, { notes: 'عيّنة مجانية من المورّد', totalProductionCost: 0 })]);
    await press(makeDb(data).tx, [
      { warehouseId: 'w1', lines: [{ productId: 'p0', quantity: 5 }] },
      { warehouseId: 'w2', lines: [{ productId: 'p0', quantity: 3 }] },
    ]);
    expect(data.productionBatch.map((b) => [b.warehouseId, b.quantityRemaining, b.costPerUnit, b.notes])).toEqual([
      ['w1', 5, 0, 'عيّنة مجانية من المورّد'],
      ['w2', 3, 0, 'عيّنة مجانية من المورّد'],
    ]);
  });

  it('a product with combinations is placed as a product, and the table says so', async () => {
    const data = oneProductStore([baseBatch('b1', 4, 1)], { productVariant: [{ id: 'v1', companyId: C, productId: 'p0', status: 'ACTIVE' }] });
    const { plan } = await press(makeDb(data).tx, [{ warehouseId: 'w1', lines: [{ productId: 'p0', quantity: 4 }] }]);
    expect(plan.rows[0].hasVariants).toBe(true);
    expect(data.productionBatch[0].warehouseId).toBe('w1');
  });
});

/* ───────────── the lock ───────────── */

describe('the placement takes the reserver’s lock, on every product, before it reads the book', () => {
  it('the same advisory keys as `reserveOrderLines`, every product of the store, sorted, before the first batch read', async () => {
    const data = oneProductStore([baseBatch('b1', 4, 1)]);
    data.product.push({ id: 'p9', companyId: C, storeId: S, name: 'تاني', sku: null });
    const { tx, log } = makeDb(data);
    await press(tx, [{ warehouseId: 'w1', lines: [{ productId: 'p0', quantity: 4 }] }]);
    const firstBatchRead = log.findIndex((l) => l.t === 'productionBatch');
    const locks = log.slice(0, firstBatchRead).filter((l) => l.op === 'lock').map((l) => l.values);
    // Both products, before the book is read — and in one order, the one every locker uses.
    expect(locks).toHaveLength(2);
    expect(locks.map((v) => String(v[1]))).toEqual(locks.map((v) => String(v[1])).sort());

    // What the reserver takes for p0 and p9, read off a real run of `reserveOrderLines`.
    const reserverKeys: unknown[][] = [];
    const reserverTx = {
      orderItem: {
        findMany: async () => [
          { id: 'i1', companyId: C, productId: 'p0', productName: 'x', quantity: 1, freeQuantity: 0, reservedQty: 1, variantSummary: null },
          { id: 'i2', companyId: C, productId: 'p9', productName: 'y', quantity: 1, freeQuantity: 0, reservedQty: 1, variantSummary: null },
        ],
      },
      orderAddOn: { findMany: async () => [] },
      $executeRaw: async (_s: TemplateStringsArray, ...v: unknown[]) => (reserverKeys.push(v), 1),
    };
    await reserveOrderLines(reserverTx as never, 'o1', { allowNegativeStock: false });
    expect(reserverKeys).toHaveLength(2);
    for (const key of reserverKeys) expect(locks).toContainEqual(key);
  });
});

/* ───────────── no money ───────────── */

describe('the placement and the split touch no money', () => {
  it.each(['src/lib/warehouse-placement.ts', 'src/lib/batch-split.ts', 'src/lib/placement-door.ts', 'src/app/api/inventory/placement/route.ts', 'src/app/api/inventory/placement/preview/route.ts'])(
    '%s imports nothing from wallets, expenses, profit, commission or settlement',
    (rel) => {
      const src = readFileSync(join(process.cwd(), rel), 'utf8');
      const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
      expect(imports.filter((i) => /wallet|expense|profit|financ|commission|settlement|money/i.test(i))).toEqual([]);
    }
  );
});
