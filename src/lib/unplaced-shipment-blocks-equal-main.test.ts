import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

vi.mock('./db', () => ({ db: {} }));

import * as today from './operations';
import { shipDb, type Row } from './shipment-warehouse.memory-db.test';

/**
 * A STORE THAT IS NOT PLACED IN WAREHOUSES IS ASKED EXACTLY WHAT MAIN ASKED (the warehouse plan, W4a).
 *
 * `shipmentBlocks`, `shipmentBlocksBulk` and `preparationGroups` learned to ask a warehouse's shelf when they are handed
 * one. A store that is not placed is never handed one, and must get main's answers AND main's questions: the same blocks
 * in the same order with the same words, the same preparation groups, and the same reads of the same tables with the
 * same arguments (`calls`), over many random stores, at a frozen clock.
 *
 * The frozen file beside this test (`shipment-blocks.main-golden.json`) holds what `git show osm/main:src/lib/operations.ts`
 * (main d3e8a349) answered and asked for the very same scenarios, run against the in-memory database
 * (`shipment-warehouse.memory-db.test.ts`). This test runs today's code and compares everything, `toEqual`.
 *
 * TO REGENERATE (only if main itself changes these functions):
 *   git show <main-sha>:src/lib/operations.ts > src/lib/operations.w4a-main.ts
 *   W4A_WRITE_GOLDEN=1 npx vitest run src/lib/unplaced-shipment-blocks-equal-main.test.ts
 *   rm src/lib/operations.w4a-main.ts
 */

const GOLDEN = join(process.cwd(), 'src/lib/shipment-blocks.main-golden.json');
const N = 200;
const SEED = 20261120;
const NOW = new Date('2026-11-20T09:00:00Z');

/** A small seeded generator (mulberry32): the same scenarios on every machine. */
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

function scenario(i: number) {
  const r = rng(SEED + i);
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const pickOne = <T,>(xs: readonly T[]) => xs[int(0, xs.length - 1)];
  const products = ['p1', 'p2', 'p3', 'p4'].slice(0, int(1, 4));
  const stores = ['s1', 's2'];
  const day = 24 * 60 * 60 * 1000;

  const productionBatch: Row[] = [];
  for (const storeId of stores) {
    for (const productId of products) {
      for (let k = int(0, 2); k > 0; k--) {
        productionBatch.push({ id: `b${productionBatch.length}`, companyId: 'c1', storeId, productId, quantityRemaining: int(-1, 9), warehouseId: null, inTransitTransferId: null });
      }
    }
  }
  const order: Row[] = [];
  const orderItem: Row[] = [];
  const orderAddOn: Row[] = [];
  const customers = ['cu1', 'cu2', 'cu3', 'cu4'];
  const n = int(2, 9);
  for (let k = 0; k < n; k++) {
    const id = `o${k}`;
    order.push({
      id,
      orderNumber: `ORD-${k}`,
      companyId: 'c1',
      storeId: k % 4 === 3 ? 's2' : 's1',
      customerId: pickOne(customers),
      regionId: r() < 0.15 ? null : pickOne(['r1', 'r2']),
      deliveryProviderId: r() < 0.2 ? null : pickOne(['dp1', 'dp2']),
      confirmationStatus: pickOne(['CONFIRMED', 'CONFIRMED', 'CONFIRMED', 'CANCELLED', 'PENDING']),
      shippingStatus: pickOne(['NOT_READY', 'NOT_READY', 'PACKING', 'SHIPPED', 'OUT_FOR_DELIVERY', 'RETURNED', 'RETURN_REQUESTED', 'DELIVERED']),
      returnedAt: r() < 0.5 ? new Date(NOW.getTime() - int(1, 60) * day) : null,
      updatedAt: new Date(NOW.getTime() - int(0, 60) * day),
      createdAt: new Date(NOW.getTime() - int(0, 10) * day - k),
      sourceWarehouseId: null,
      customer: { fullName: `زبون ${k}` },
    });
    for (let l = int(0, 2); l > 0; l--) {
      const productId = pickOne(products);
      const quantity = int(0, 4);
      const freeQuantity = int(0, 1);
      orderItem.push({
        id: `i${orderItem.length}`, companyId: 'c1', orderId: id, productId, productName: `منتج ${productId}`, quantity, freeQuantity,
        reservedQty: r() < 0.6 ? quantity + freeQuantity : int(0, quantity), variantSummary: null, createdAt: new Date(NOW.getTime() + orderItem.length),
      });
    }
    if (r() < 0.3) {
      const productId = pickOne(products);
      const quantity = int(1, 3);
      orderAddOn.push({ id: `a${orderAddOn.length}`, companyId: 'c1', orderId: id, productId, productName: `إضافة ${productId}`, quantity, reservedQty: r() < 0.5 ? quantity : 0 });
    }
  }
  const deliveryFee = [
    { id: 'f1', deliveryProviderId: 'dp1', regionId: 'r1', isActive: true },
    { id: 'f2', deliveryProviderId: 'dp2', regionId: 'r2', isActive: r() < 0.5 },
  ];
  return {
    seed: {
      store: [
        { id: 's1', companyId: 'c1', countryId: 'k1', isTest: false },
        { id: 's2', companyId: 'c1', countryId: 'k1', isTest: false },
      ],
      productionBatch,
      order,
      orderItem,
      orderAddOn,
      deliveryFee,
    },
    allowNegativeStock: r() < 0.5,
    withBatchIds: r() < 0.7,
  };
}

/**
 * Every read, as a count and a digest of the exact calls with their arguments (in full they would be megabytes). The digest
 * is written in base64url, never in hex: a run of 32 hex letters is what the secret scanner reads as a vendor secret.
 */
const asked = (calls: unknown[]) => ({ n: calls.length, digest: createHash('sha256').update(JSON.stringify(calls)).digest('base64url') });

type Ops = Pick<typeof today, 'shipmentBlocks' | 'shipmentBlocksBulk' | 'preparationGroups'>;

async function run(ops: Ops) {
  const out: unknown[] = [];
  for (let i = 0; i < N; i++) {
    const s = scenario(i);
    const m = shipDb(s.seed);
    const s1 = s.seed.order.filter((o) => o.storeId === 's1');
    const ids = s1.map((o) => o.id);
    const opts = { allowNegativeStock: s.allowNegativeStock, ...(s.withBatchIds ? { batchOrderIds: [...ids, ids[0]].filter(Boolean) } : {}) };
    const single: Record<string, unknown> = {};
    for (const o of s1) {
      single[o.id] = await ops.shipmentBlocks(
        m.db,
        { id: o.id, companyId: o.companyId, storeId: o.storeId, customerId: o.customerId, regionId: o.regionId, deliveryProviderId: o.deliveryProviderId },
        opts
      );
    }
    const singleCalls = m.calls.splice(0);
    const bulk = await ops.shipmentBlocksBulk(
      m.db,
      s.seed.order.map((o) => ({
        id: o.id, companyId: o.companyId, storeId: o.storeId, customerId: o.customerId, regionId: o.regionId, deliveryProviderId: o.deliveryProviderId,
        items: s.seed.orderItem.filter((it) => it.orderId === o.id).map((it) => ({ productId: it.productId, productName: it.productName, quantity: it.quantity, freeQuantity: it.freeQuantity })),
        addOns: s.seed.orderAddOn.filter((a) => a.orderId === o.id).map((a) => ({ productId: a.productId, productName: a.productName, quantity: a.quantity })),
      })),
      opts
    );
    const bulkCalls = m.calls.splice(0);
    const prep = await ops.preparationGroups(m.db, { companyId: 'c1', storeId: 's1' });
    const prepCalls = m.calls.splice(0);
    out.push(JSON.parse(JSON.stringify({ i, single, bulk: Object.fromEntries(bulk), prep, reads: { single: asked(singleCalls), bulk: asked(bulkCalls), prep: asked(prepCalls) } })));
  }
  return out;
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterAll(() => {
  vi.useRealTimers();
});

describe('a store that is not placed: main’s answers and main’s questions, over random stores', () => {
  it(`${N} scenarios — the blocks, the list, the preparation groups and every read`, async () => {
    if (process.env.W4A_WRITE_GOLDEN === '1') {
      const mainCopy = join(process.cwd(), 'src/lib/operations.w4a-main.ts');
      expect(existsSync(mainCopy), 'git show <main>:src/lib/operations.ts > src/lib/operations.w4a-main.ts').toBe(true);
      const main = (await import(/* @vite-ignore */ pathToFileURL(mainCopy).href)) as Ops;
      // One scenario per line, so a change shows as the scenarios it moved.
      writeFileSync(GOLDEN, '[\n' + (await run(main)).map((x) => JSON.stringify(x)).join(',\n') + '\n]\n');
    }
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as unknown[];
    expect(golden).toHaveLength(N);
    const mine = await run(today);
    for (let i = 0; i < N; i++) expect(mine[i], `scenario ${i}`).toEqual(golden[i]);
  });

  it('and the scenarios are not empty: blocks of every kind, shortages hard and soft, and preparation groups', () => {
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as { single: Record<string, { code: string; hard: boolean }[]>; prep: unknown[] }[];
    const blocks = golden.flatMap((g) => Object.values(g.single).flat());
    const codes = new Set(blocks.map((b) => b.code));
    for (const c of ['STOCK_SHORTAGE', 'NO_REGION', 'NO_FEE_ROW', 'PREVIOUS_SHIPMENT_IN_TRANSIT', 'RECENT_RETURN', 'DUPLICATE_IN_BATCH']) expect(codes, c).toContain(c);
    expect(blocks.some((b) => b.code === 'STOCK_SHORTAGE' && b.hard)).toBe(true);
    expect(blocks.some((b) => b.code === 'STOCK_SHORTAGE' && !b.hard)).toBe(true);
    expect(golden.filter((g) => g.prep.length > 0).length).toBeGreaterThan(N / 3);
  });
});
