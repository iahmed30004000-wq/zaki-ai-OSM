import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { memoryDb, type Row } from './stock-transfers.memory-db.test';
import { approveAbroad, approveDifference, cancelTransfer, receiveTransfer, sendTransfer, shownTo } from './stock-transfers';
import { arrivalCost, normalizeLanded } from './stock-transfer-cost';

/**
 * 22/11 (F2): ONE CURRENCY = TODAY, BYTE FOR BYTE. The exchange rate exists only between two currencies; every other
 * transfer must cost, write and answer exactly what `osm/main` (01eedfb6, before F2) did. This file runs 200 seeded
 * random scenarios — inside one store, between two stores of one country, and between two countries that keep the SAME
 * currency (with the owner's press) — through send · approve · receive (counts and typed landed lines) · replay · cancel ·
 * the difference, plus 2,000 direct `arrivalCost` cases, and compares everything written (batches, ledger, transfers,
 * lines), every refusal code, and every answer (`shownTo` to a cost holder) with the golden file that THE SAME FILE wrote
 * when run against `osm/main` (F2_WRITE_GOLDEN=1, in a worktree of main). Dates and random batch-number suffixes are the
 * only things masked.
 */

const GOLDEN = join(__dirname, 'stock-transfer-rate.main-golden.json');
const C1 = 'c1';
const ME = 'u-sender';
const HER = 'u-receiver';
const THIRD = 'u-approver';
const OWNER = 'u-owner';
const yes = async () => true;

function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function world(r: () => number) {
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const minor = () => [0, 2, 3][int(0, 2)];
  const cost = () => Math.round(r() * 5000) / [1, 100, 10000][int(0, 2)];
  let n = 0;
  const batches: Row[] = [];
  for (const productId of ['p1', 'p2']) {
    for (let i = 0; i < int(1, 3); i++) {
      const produced = int(1, 20);
      const sold = int(0, Math.max(0, produced - 1));
      batches.push({
        id: `b${++n}`,
        companyId: C1,
        storeId: 's1',
        productId,
        batchNumber: `RCV-${n}`,
        quantityProduced: produced,
        quantitySold: sold,
        quantityRemaining: produced - sold,
        quantityMovedIn: 0,
        quantityMovedOut: 0,
        manufacturingCost: 0,
        packagingCost: 0,
        rawMaterialCost: 0,
        otherCosts: 0,
        totalProductionCost: 0,
        costPerUnit: cost(),
        productionDate: new Date(`2026-10-${String(1 + n).padStart(2, '0')}`),
        createdAt: new Date(`2026-10-${String(1 + n).padStart(2, '0')}T08:00:00Z`),
        status: 'COMPLETED',
        notes: null,
        warehouseId: r() < 0.8 ? 'wA' : 'wB',
        inTransitTransferId: null,
        splitFromBatchId: null,
      });
    }
  }
  return memoryDb({
    // ONE currency everywhere — two countries that both keep JOD included.
    country: [
      { id: 'k1', companyId: C1, isActive: true, minorUnit: minor(), currencyCode: 'JOD' },
      { id: 'k2', companyId: C1, isActive: true, minorUnit: minor(), currencyCode: 'JOD' },
    ],
    store: [
      { id: 's1', companyId: C1, countryId: 'k1', name: 'المتجر' },
      { id: 's2', companyId: C1, countryId: 'k1', name: 'متجر تاني' },
      { id: 's3', companyId: C1, countryId: 'k2', name: 'متجر البلد التاني' },
    ],
    warehouse: [
      { id: 'wA', companyId: C1, countryId: 'k1', name: 'أ', isActive: true },
      { id: 'wB', companyId: C1, countryId: 'k1', name: 'ب', isActive: true },
      { id: 'wJ', companyId: C1, countryId: 'k2', name: 'ج', isActive: true },
    ],
    warehousePlacement: [
      { id: 'pl1', companyId: C1, storeId: 's1' },
      { id: 'pl2', companyId: C1, storeId: 's2' },
      { id: 'pl3', companyId: C1, storeId: 's3' },
    ],
    product: [
      { id: 'p1', companyId: C1, storeId: 's1', name: 'منتج ١' },
      { id: 'p2', companyId: C1, storeId: 's1', name: 'منتج ٢' },
      { id: 'q1', companyId: C1, storeId: 's2', name: 'توأم ١' },
      { id: 'q2', companyId: C1, storeId: 's2', name: 'توأم ٢' },
      { id: 'r1', companyId: C1, storeId: 's3', name: 'توأم بعيد ١' },
      { id: 'r2', companyId: C1, storeId: 's3', name: 'توأم بعيد ٢' },
    ],
    productPair: [
      { id: 'pr1', companyId: C1, productAId: 'p1', storeAId: 's1', productBId: 'q1', storeBId: 's2', hint: null, createdById: ME },
      { id: 'pr2', companyId: C1, productAId: 'p2', storeAId: 's1', productBId: 'q2', storeBId: 's2', hint: null, createdById: ME },
      { id: 'pr3', companyId: C1, productAId: 'p1', storeAId: 's1', productBId: 'r1', storeBId: 's3', hint: null, createdById: ME },
      { id: 'pr4', companyId: C1, productAId: 'p2', storeAId: 's1', productBId: 'r2', storeBId: 's3', hint: null, createdById: ME },
    ],
    productionBatch: batches,
  });
}

/** Everything JSON-stable: dates out, random twin suffixes and day stamps masked, keys sorted. */
function stable(v: unknown): unknown {
  if (v instanceof Date) return '<date>';
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') {
    const out: Row = {};
    for (const k of Object.keys(v).sort()) {
      const x = (v as Row)[k];
      if (x === undefined) continue;
      out[k] = k === 'batchNumber' && typeof x === 'string' ? x.replace(/~[0-9a-f]{6}/g, '~HEX').replace(/\d{8}/g, 'DAY') : stable(x);
    }
    return out;
  }
  return v;
}

const outcome = (e: unknown) => {
  const x = e as { name?: string; code?: string; errorAr?: string; message?: string };
  return { refused: x?.name ?? 'Error', code: x?.code ?? null, errorAr: x?.errorAr ?? null };
};

async function scenario(seed: number) {
  const r = prng(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const m = world(r);
  const db = m.db as Row;
  const steps: unknown[] = [];
  const step = async (name: string, f: () => Promise<{ transfer: Row; replay: boolean }>) => {
    try {
      const out = await f();
      steps.push({ name, replay: out.replay, answer: stable(shownTo(out.transfer as never, THIRD, { seesCost: true, owner: true })) });
      return out;
    } catch (e) {
      steps.push({ name, ...outcome(e) });
      return null;
    }
  };

  const kind = ['INTERNAL', 'BETWEEN_STORES', 'BETWEEN_COUNTRIES'][int(0, 2)];
  const ends =
    kind === 'INTERNAL'
      ? { fromWarehouseId: 'wA', toWarehouseId: 'wB' }
      : kind === 'BETWEEN_STORES'
        ? { fromWarehouseId: 'wA', toWarehouseId: r() < 0.5 ? 'wA' : 'wB', toStoreId: 's2' }
        : { fromWarehouseId: 'wA', toWarehouseId: 'wJ', toStoreId: 's3' };
  const products = r() < 0.5 ? ['p1'] : ['p1', 'p2'];
  const lines = products.map((productId) => ({ productId, quantity: int(1, 15) }));
  const id = `00000000-0000-4000-8000-${String(seed).padStart(12, '0')}`;
  const body = { id, ...ends, lines, note: r() < 0.3 ? 'ملاحظة' : null };
  const sendOnce = () =>
    step('send', () =>
      db.$transaction((tx: Row) =>
        sendTransfer(tx as never, { companyId: C1, storeId: 's1', sentById: ME, body: body as never, mayUse: yes, mayReachStore: yes, mayAbroad: true })
      )
    );
  const sent = await sendOnce();
  if (r() < 0.2) await sendOnce(); // a replay of the same press
  if (!sent) return { steps, data: stable(m.data) };
  const tid = sent.transfer.id as string;
  const dest = (ends as Row).toStoreId ?? 's1';

  if (kind === 'BETWEEN_COUNTRIES' && r() < 0.85) {
    await step('approve', () =>
      db.$transaction((tx: Row) => approveAbroad(tx as never, { companyId: C1, storeId: 's1', transferId: tid, approvedById: OWNER, isOwner: true, mayUse: yes }))
    );
  }

  const next = r();
  if (next < 0.25) {
    await step('cancel', () =>
      db.$transaction((tx: Row) =>
        cancelTransfer(tx as never, { companyId: C1, storeId: 's1', transferId: tid, cancelledById: ME, mayUse: yes, body: { reason: 'غلط بالكمية' } })
      )
    );
  } else if (next < 0.95) {
    const counts = lines.map((l) => {
      const quantity = r() < 0.6 ? l.quantity : int(0, l.quantity);
      const costs =
        kind !== 'INTERNAL' && quantity > 0 && r() < 0.6
          ? Array.from({ length: int(1, 3) }, () => ({
              kind: ['TRANSPORT', 'CUSTOMS', 'OTHER'][int(0, 2)],
              amount: Math.round(r() * 100000) / [1, 10, 1000, 10000][int(0, 3)],
              note: 'شحن',
            }))
          : undefined;
      return { productId: l.productId, quantity, ...(costs ? { costs } : {}), ...(r() < 0.2 ? { zeroCostReason: 'هدية من المورد' } : {}) };
    });
    const receive = () =>
      step('receive', () =>
        db.$transaction((tx: Row) =>
          receiveTransfer(tx as never, { companyId: C1, storeId: dest, transferId: tid, receivedById: HER, mayUse: yes, mayReachStore: yes, body: { lines: counts } as never })
        )
      );
    const got = await receive();
    if (got && r() < 0.3) await receive(); // a replay of the receipt
    if (got && got.transfer.status === 'RECEIVED_WITH_DIFFERENCE' && r() < 0.7) {
      await step('difference', () =>
        db.$transaction((tx: Row) =>
          approveDifference(tx as never, { companyId: C1, storeId: dest, transferId: tid, approvedById: THIRD, mayUse: yes, body: { type: 'LOSS', reason: 'ضاعت بالطريق' } })
        )
      );
    }
    if (r() < 0.1) {
      await step('cancel-after', () =>
        db.$transaction((tx: Row) =>
          cancelTransfer(tx as never, { companyId: C1, storeId: 's1', transferId: tid, cancelledById: ME, mayUse: yes, body: { reason: 'غلط بالكمية' } })
        )
      );
    }
  }
  const data = m.data;
  return {
    steps,
    data: stable({
      productionBatch: data.productionBatch,
      inventoryMovement: data.inventoryMovement,
      stockTransfer: data.stockTransfer,
      stockTransferLine: data.stockTransferLine,
    }),
  };
}

function arrivalCases() {
  const r = prng(20261122);
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const out: unknown[] = [];
  for (let i = 0; i < 2000; i++) {
    const sent = int(1, 40);
    const received = int(1, sent);
    const minorUnit = [0, 2, 3][int(0, 2)];
    const costOut = Math.round(r() * 1e7) / [1, 100, 10000][int(0, 2)];
    const landed = normalizeLanded(
      Array.from({ length: int(0, 3) }, () => ({ kind: 'TRANSPORT' as const, amount: Math.round(r() * 1e5) / [1, 10, 1000][int(0, 2)] })),
      minorUnit
    );
    out.push({ i, landed, result: arrivalCost({ costOut, sent, received, landed, minorUnit, zeroCostReason: r() < 0.5 ? 'هدية من المورد' : null }) });
  }
  return out;
}

async function everything() {
  const scenarios: unknown[] = [];
  for (let seed = 1; seed <= 200; seed++) scenarios.push({ seed, ...(await scenario(seed)) });
  return JSON.parse(JSON.stringify({ scenarios, arrival: arrivalCases() }));
}

describe('F2 — one currency answers exactly what osm/main answered (frozen golden)', () => {
  it('200 scenarios of send · approve · receive · replay · cancel · difference, and 2,000 arrival costs: identical', async () => {
    const now = await everything();
    if (process.env.F2_WRITE_GOLDEN === '1') {
      writeFileSync(GOLDEN, JSON.stringify(now));
      return;
    }
    expect(existsSync(GOLDEN), 'the golden written against osm/main').toBe(true);
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'));
    // The scenarios really ran the paths (not 300 refusals): received, cancelled and across-country rows exist.
    const statuses = new Set(golden.scenarios.flatMap((s: Row) => (s.data.stockTransfer ?? []).map((t: Row) => `${t.kind}:${t.status}`)));
    for (const k of ['INTERNAL:RECEIVED', 'BETWEEN_STORES:RECEIVED_WITH_DIFFERENCE', 'BETWEEN_COUNTRIES:RECEIVED', 'BETWEEN_STORES:CANCELLED', 'BETWEEN_COUNTRIES:AWAITING_APPROVAL']) {
      expect(statuses.has(k), k).toBe(true);
    }
    for (let i = 0; i < golden.scenarios.length; i++) expect(now.scenarios[i], `seed ${i + 1}`).toEqual(golden.scenarios[i]);
    expect(now.arrival).toEqual(golden.arrival);
  });
});
