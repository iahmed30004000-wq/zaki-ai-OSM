import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { memoryDb, type Row } from './stock-transfers.memory-db.test';
import { approveDifference, cancelTransfer, receiveSchema, receiveTransfer, sendSchema, sendTransfer, shownTo, StockTransferRefused } from './stock-transfers';
import { approveExit, rejectExit, requestExit, requestSchema, StockExitRefused } from './stock-exits';
import { countsSchema, placeStore, previewPlacement, PlacementRefused } from './warehouse-placement';
import { countPlan, drawPlan, placesOfVariants } from './variant-stock';

/**
 * COMBINATIONS IN THE STOCK DOCUMENTS (the warehouse plan, W8b) — the transfer, the exit and the opening placement carry
 * a product's combinations, and their pieces move through the one writer of a combination's count.
 *
 * Every figure asserted is computed HERE from the rows (`product_variant_stock`, `variant_stock_movements`, the batches),
 * never by the function under test. After every step of every scenario:
 *   • per combination: `onHand` = Σ its places = Σ its ledger lines, and no place below zero;
 *   • per place (a warehouse, a transfer's road): Σ of the product's combinations there = the product's units there (the
 *     scenarios start with the two equal, and every document moves both together);
 *   • the product's «دخل» (Σ produced) never moves; Σ remaining and Σ sold move only by what an approved exit or an
 *     approved transfer shortfall took out — counted from the documents by this file.
 */

const C1 = 'c1';
const S1 = 's1';
const ME = 'u-sender';
const HER = 'u-receiver';
const THIRD = 'u-approver';
type MayUse = (w: { id: string }) => Promise<boolean>;
const yes: MayUse = async () => true;

function batch(id: string, over: Row = {}): Row {
  return {
    id,
    companyId: C1,
    storeId: S1,
    productId: 'p1',
    batchNumber: `RCV-${id}`,
    quantityProduced: 10,
    quantitySold: 0,
    quantityRemaining: 10,
    quantityMovedIn: 0,
    quantityMovedOut: 0,
    manufacturingCost: 0,
    packagingCost: 0,
    rawMaterialCost: 0,
    otherCosts: 0,
    totalProductionCost: 20,
    costPerUnit: 2,
    productionDate: new Date('2026-10-01'),
    createdAt: new Date('2026-10-01T08:00:00Z'),
    status: 'COMPLETED',
    notes: null,
    warehouseId: 'wA',
    inTransitTransferId: null,
    splitFromBatchId: null,
    ...over,
  };
}

/** A combination's place row and the ledger line that put its pieces there (so Σ ledger = onHand from the start). */
function place(id: string, variantId: string, warehouseId: string | null, onHand: number) {
  return {
    place: { id, companyId: C1, variantId, warehouseId, onHand },
    line: {
      id: `l-${id}`,
      companyId: C1,
      storeId: S1,
      productId: variantId.startsWith('v') ? 'p1' : 'p3',
      variantId,
      warehouseId,
      type: 'COUNT',
      quantity: onHand,
      placeAfter: onHand,
      onHandAfter: 0,
      reason: 'عدّ',
    },
  };
}

/**
 * The store, placed. p1 has two combinations: wA holds 10 + 6 units (b1, b2) = v1 ×9 + v2 ×7; wB holds 5 (bB) = v1 ×2 +
 * v2 ×3. p2 has none (wA 10). v1 = 11, v2 = 10 on the books.
 */
function world(extra: Row = {}) {
  const places = [place('pv1A', 'v1', 'wA', 9), place('pv2A', 'v2', 'wA', 7), place('pv1B', 'v1', 'wB', 2), place('pv2B', 'v2', 'wB', 3)];
  return memoryDb({
    country: [{ id: 'k1', companyId: C1, isActive: true, minorUnit: 2 }],
    store: [{ id: S1, companyId: C1, countryId: 'k1', name: 'المتجر' }],
    warehouse: [
      { id: 'wA', companyId: C1, countryId: 'k1', name: 'أ', isActive: true },
      { id: 'wB', companyId: C1, countryId: 'k1', name: 'ب', isActive: true },
    ],
    warehousePlacement: [{ id: 'pl1', companyId: C1, storeId: S1 }],
    product: [
      { id: 'p1', companyId: C1, storeId: S1, name: 'قميص', variantOptions: '[]' },
      { id: 'p2', companyId: C1, storeId: S1, name: 'كاسة' },
      { id: 'p3', companyId: C1, storeId: S1, name: 'بنطلون' },
    ],
    productVariant: [
      { id: 'v1', companyId: C1, productId: 'p1', label: 'أسود · L', status: 'ACTIVE', sortOrder: 0, onHand: 11 },
      { id: 'v2', companyId: C1, productId: 'p1', label: 'كحلي · M', status: 'ACTIVE', sortOrder: 1, onHand: 10 },
      // p3's only combination is archived: p3 need not name it, but may.
      { id: 'x1', companyId: C1, productId: 'p3', label: 'قديم', status: 'ARCHIVED', sortOrder: 0, onHand: 0 },
    ],
    productVariantStock: places.map((p) => p.place),
    variantStockMovement: places.map((p) => p.line),
    productionBatch: [
      batch('b1'),
      batch('b2', { productionDate: new Date('2026-10-05'), quantityProduced: 9, quantitySold: 3, quantityRemaining: 6, costPerUnit: 3 }),
      batch('bB', { warehouseId: 'wB', quantityProduced: 5, quantityRemaining: 5, costPerUnit: 1 }),
      batch('c1b', { productId: 'p2' }),
    ],
    ...extra,
  });
}

type M = ReturnType<typeof memoryDb>;

/* ───────────── the figures, from the rows ───────────── */

const VARIANTS = ['v1', 'v2'];
const placesOf = (m: M, v: string) => m.data.productVariantStock.filter((r) => r.variantId === v);
const onHand = (m: M, v: string) => m.data.productVariant.find((r) => r.id === v)!.onHand;
const at = (m: M, v: string, warehouseId: string | null, road: string | null = null) =>
  placesOf(m, v)
    .filter((r) => r.warehouseId === warehouseId && (r.inTransitTransferId ?? null) === road)
    .reduce((s, r) => s + r.onHand, 0);
const units = (m: M, warehouseId: string | null, road: string | null = null, productId = 'p1') =>
  m.data.productionBatch
    .filter((b) => b.productId === productId && (b.warehouseId ?? null) === warehouseId && (b.inTransitTransferId ?? null) === road)
    .reduce((s, b) => s + b.quantityRemaining, 0);
const book = (m: M, productId = 'p1') => {
  const rs = m.data.productionBatch.filter((b) => b.productId === productId);
  return { produced: rs.reduce((s, r) => s + r.quantityProduced, 0), sold: rs.reduce((s, r) => s + r.quantitySold, 0), remaining: rs.reduce((s, r) => s + r.quantityRemaining, 0) };
};

/** The invariants of the head comment; returns a list of what broke (empty = held). */
function broken(m: M): string[] {
  const out: string[] = [];
  for (const v of VARIANTS) {
    const ps = placesOf(m, v);
    const sum = ps.reduce((s, r) => s + r.onHand, 0);
    const ledger = m.data.variantStockMovement.filter((l) => l.variantId === v).reduce((s, l) => s + l.quantity, 0);
    if (onHand(m, v) !== sum) out.push(`${v}: onHand ${onHand(m, v)} ≠ Σ places ${sum}`);
    if (ledger !== sum) out.push(`${v}: Σ ledger ${ledger} ≠ Σ places ${sum}`);
    if (ps.some((p) => p.onHand < 0)) out.push(`${v}: a place below zero`);
  }
  const keys = new Set<string>();
  for (const r of m.data.productVariantStock) keys.add(`${r.warehouseId ?? ''}|${r.inTransitTransferId ?? ''}`);
  for (const b of m.data.productionBatch.filter((x) => x.productId === 'p1')) keys.add(`${b.warehouseId ?? ''}|${b.inTransitTransferId ?? ''}`);
  for (const k of keys) {
    const [w, road] = k.split('|');
    const pieces = VARIANTS.reduce((s, v) => s + at(m, v, w || null, road || null), 0);
    const u = units(m, w || null, road || null);
    if (pieces !== u) out.push(`place ${k}: pieces ${pieces} ≠ units ${u}`);
  }
  return out;
}

/* ───────────── the doors ───────────── */

const tx = (m: M) => (fn: (t: Row) => Promise<unknown>) => (m.db as Row).$transaction(fn) as Promise<Row>;
const send = (m: M, lines: Row[], over: Row = {}, by = ME) =>
  tx(m)((t) => sendTransfer(t as never, { companyId: C1, storeId: S1, sentById: by, mayUse: yes, body: { fromWarehouseId: 'wA', toWarehouseId: 'wB', lines, ...over } as never }));
const receive = (m: M, id: string, lines: Row[], by = HER) =>
  tx(m)((t) => receiveTransfer(t as never, { companyId: C1, storeId: S1, transferId: id, receivedById: by, mayUse: yes, body: { lines } as never }));
const cancel = (m: M, id: string, by = ME) =>
  tx(m)((t) => cancelTransfer(t as never, { companyId: C1, storeId: S1, transferId: id, cancelledById: by, mayUse: yes, body: { reason: 'غلط بالكمية' } }));
const approve = (m: M, id: string, type: 'LOSS' | 'DAMAGE' = 'LOSS', by = THIRD) =>
  tx(m)((t) => approveDifference(t as never, { companyId: C1, storeId: S1, transferId: id, approvedById: by, mayUse: yes, body: { type, reason: 'انكسرت بالطريق' } }));
const askExit = (m: M, lines: Row[], over: Row = {}, by = ME) =>
  tx(m)((t) => requestExit(t as never, { companyId: C1, storeId: S1, requestedById: by, mayUse: yes, body: { warehouseId: 'wA', reason: 'DAMAGED', note: null, lines, ...over } as never }));
const okExit = (m: M, id: string, by = THIRD) => tx(m)((t) => approveExit(t as never, { companyId: C1, storeId: S1, exitId: id, decidedById: by, mayUse: yes }));
const noExit = (m: M, id: string, by = THIRD) =>
  tx(m)((t) => rejectExit(t as never, { companyId: C1, storeId: S1, exitId: id, decidedById: by, mayUse: yes, body: { reason: 'مش لازم' } }));

async function refused<E extends Error>(p: Promise<unknown>, cls: new (...a: never[]) => E, code: string) {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e, `expected refusal ${code}`).toBeInstanceOf(cls);
  expect((e as unknown as { code: string }).code).toBe(code);
  expect((e as unknown as { errorAr: string }).errorAr).toMatch(/[؀-ۿ]/);
  return e as E & { code: string; errorAr: string; status: number; extra: Row };
}

/** What the list shows a viewer (typed loosely: the rows here are plain objects). */
const show = (t: Row, who: string) => shownTo(t as Parameters<typeof shownTo>[0], who) as Row;

/** Nothing of the database changed — the whole state, compared. */
const frozen = (m: M) => JSON.stringify(m.data);

const L1 = (q1: number, q2: number) => ({ productId: 'p1', quantity: q1 + q2, variants: [{ variantId: 'v1', quantity: q1 }, { variantId: 'v2', quantity: q2 }].filter((v) => v.quantity > 0) });

/* ───────────── the transfer ───────────── */

describe('a transfer carries the combinations: source → road → destination, the total never moves', () => {
  it('send: each combination leaves its source place for the road; onHand and the product book stand still', async () => {
    const m = world();
    const before = book(m);
    const { transfer } = await send(m, [L1(4, 3), { productId: 'p2', quantity: 2 }]);
    expect(broken(m)).toEqual([]);
    expect([at(m, 'v1', 'wA'), at(m, 'v2', 'wA')]).toEqual([5, 4]);
    expect([at(m, 'v1', null, transfer.id), at(m, 'v2', null, transfer.id)]).toEqual([4, 3]);
    expect([onHand(m, 'v1'), onHand(m, 'v2')]).toEqual([11, 10]);
    expect(book(m)).toEqual(before);
    // The ledger: one TRANSFER_OUT line per place moved, naming the document and (for the road) the transfer.
    const lines = m.data.variantStockMovement.filter((l) => l.type === 'TRANSFER_OUT');
    expect(lines.map((l) => [l.variantId, l.warehouseId, l.inTransitTransferId ?? null, l.quantity, l.referenceId])).toEqual([
      ['v1', 'wA', null, -4, transfer.id],
      ['v1', null, transfer.id, 4, transfer.id],
      ['v2', 'wA', null, -3, transfer.id],
      ['v2', null, transfer.id, 3, transfer.id],
    ]);
    // The document keeps the combinations under its product line; the product without them has none.
    expect(transfer.lines.find((l: Row) => l.productId === 'p1').variants).toEqual([
      { variantId: 'v1', quantitySent: 4, quantityReceived: null },
      { variantId: 'v2', quantitySent: 3, quantityReceived: null },
    ]);
    expect('variants' in transfer.lines.find((l: Row) => l.productId === 'p2')).toBe(false);
  });

  it('a full receipt lands every combination in the destination; a short one leaves the rest on the road until approved out', async () => {
    const m = world();
    const { transfer: t1 } = await send(m, [L1(4, 3)]);
    await receive(m, t1.id, [L1(4, 3)]);
    expect(broken(m)).toEqual([]);
    expect([at(m, 'v1', 'wB'), at(m, 'v2', 'wB'), at(m, 'v1', null, t1.id), at(m, 'v2', null, t1.id)]).toEqual([6, 6, 0, 0]);
    expect([onHand(m, 'v1'), onHand(m, 'v2')]).toEqual([11, 10]);

    const { transfer: t2 } = await send(m, [L1(3, 2)]);
    const before = book(m);
    const got = await receive(m, t2.id, [{ productId: 'p1', quantity: 3, variants: [{ variantId: 'v1', quantity: 3 }, { variantId: 'v2', quantity: 0 }] }]);
    expect(got.transfer.status).toBe('RECEIVED_WITH_DIFFERENCE');
    expect(broken(m)).toEqual([]);
    expect([at(m, 'v1', null, t2.id), at(m, 'v2', null, t2.id)]).toEqual([0, 2]);
    expect([onHand(m, 'v1'), onHand(m, 'v2')]).toEqual([11, 10]);

    await approve(m, t2.id, 'DAMAGE');
    expect(broken(m)).toEqual([]);
    // Only the 2 pieces of v2 left the store — and the product's book lost exactly 2 units.
    expect([onHand(m, 'v1'), onHand(m, 'v2')]).toEqual([11, 8]);
    expect(book(m)).toEqual({ produced: before.produced, sold: before.sold + 2, remaining: before.remaining - 2 });
    const out = m.data.variantStockMovement.filter((l) => l.type === 'DAMAGE');
    expect(out.map((l) => [l.variantId, l.quantity, l.onHandAfter, l.inTransitTransferId])).toEqual([['v2', -2, 8, t2.id]]);
  });

  it('cancel before receipt: every combination goes back to the source; nothing deleted', async () => {
    const m = world();
    const { transfer } = await send(m, [L1(5, 1)]);
    await cancel(m, transfer.id);
    expect(broken(m)).toEqual([]);
    expect([at(m, 'v1', 'wA'), at(m, 'v2', 'wA'), at(m, 'v1', null, transfer.id)]).toEqual([9, 7, 0]);
    expect(m.data.variantStockMovement.filter((l) => l.type === 'TRANSFER_BACK').map((l) => [l.variantId, l.quantity])).toEqual([
      ['v1', -5],
      ['v1', 5],
      ['v2', -1],
      ['v2', 1],
    ]);
    expect(m.data.stockTransferLineVariant).toHaveLength(2);
  });

  it('NEGATIVE: a product with active combinations must name them; one without may not; each must be its own', async () => {
    const m = world();
    const was = frozen(m);
    await refused(send(m, [{ productId: 'p1', quantity: 2 }]), StockTransferRefused, 'VARIANTS_REQUIRED');
    await refused(send(m, [{ productId: 'p2', quantity: 2, variants: [{ variantId: 'v1', quantity: 2 }] }]), StockTransferRefused, 'VARIANTS_NOT_ALLOWED');
    await refused(send(m, [{ productId: 'p1', quantity: 2, variants: [{ variantId: 'x1', quantity: 2 }] }]), StockTransferRefused, 'VARIANT_NOT_FOUND');
    expect(frozen(m)).toBe(was);
  });

  it('NEGATIVE: the sum rule — a line whose combinations do not add up to it, or name one twice, is refused before anything is read', async () => {
    const m = world();
    const was = frozen(m);
    const e = await refused(send(m, [{ productId: 'p1', quantity: 5, variants: [{ variantId: 'v1', quantity: 2 }, { variantId: 'v2', quantity: 2 }] }]), StockTransferRefused, 'VARIANTS_SUM');
    expect(e.errorAr).toContain('(4)');
    expect(e.errorAr).toContain('(5)');
    expect(e.status).toBe(400);
    await refused(send(m, [{ productId: 'p1', quantity: 4, variants: [{ variantId: 'v1', quantity: 2 }, { variantId: 'v1', quantity: 2 }] }]), StockTransferRefused, 'VARIANT_TWICE');
    expect(frozen(m)).toBe(was);
  });

  it('NEGATIVE: a combination not free in the source is refused, named — even when the product line is free', async () => {
    const m = world();
    const was = frozen(m);
    // wA holds 16 units of p1 (free), but only 9 of v1.
    const e = await refused(send(m, [L1(10, 0)]), StockTransferRefused, 'VARIANTS_NOT_ENOUGH_FREE');
    expect(e.status).toBe(409);
    expect(e.errorAr).toContain('أسود · L');
    expect(e.extra.variantsShort).toEqual([{ productId: 'p1', variantId: 'v1', name: 'قميص', label: 'أسود · L', asked: 10, free: 9 }]);
    expect(frozen(m)).toBe(was);
  });

  it('NEGATIVE: pieces held by a pending exit and by open orders sourced from the warehouse are not free', async () => {
    const m = world({
      order: [{ id: 'o1', companyId: C1, storeId: S1, confirmationStatus: 'CONFIRMED', shippingStatus: 'READY_TO_SHIP', sourceWarehouseId: 'wA' }],
      orderItem: [{ id: 'oi1', orderId: 'o1', companyId: C1, productId: 'p1', reservedQty: 2 }],
      orderItemVariant: [{ id: 'oiv1', orderItemId: 'oi1', orderId: 'o1', companyId: C1, productId: 'p1', variantId: 'v1', quantity: 2, freeQuantity: 0 }],
    });
    await askExit(m, [L1(3, 0)]);
    // v1 in wA: 9 − 2 (the order) − 3 (the exit) = 4.
    await refused(send(m, [L1(5, 0)]), StockTransferRefused, 'VARIANTS_NOT_ENOUGH_FREE');
    const { transfer } = await send(m, [L1(4, 0)]);
    expect(at(m, 'v1', null, transfer.id)).toBe(4);
    expect(broken(m)).toEqual([]);
  });

  it('NEGATIVE: the receipt counts every combination sent, once, never above what was sent, adding up to the line', async () => {
    const m = world();
    const { transfer } = await send(m, [L1(4, 3), { productId: 'p2', quantity: 2 }]);
    const was = frozen(m);
    const p2 = { productId: 'p2', quantity: 2 };
    await refused(receive(m, transfer.id, [{ productId: 'p1', quantity: 7 }, p2]), StockTransferRefused, 'VARIANT_COUNTS_INVALID');
    await refused(receive(m, transfer.id, [{ productId: 'p1', quantity: 4, variants: [{ variantId: 'v1', quantity: 4 }] }, p2]), StockTransferRefused, 'VARIANT_COUNTS_INVALID');
    await refused(receive(m, transfer.id, [L1(5, 2), p2]), StockTransferRefused, 'VARIANT_COUNT_OVER_SENT');
    await refused(receive(m, transfer.id, [{ ...L1(4, 3), quantity: 6 }, p2]), StockTransferRefused, 'VARIANTS_SUM');
    await refused(receive(m, transfer.id, [L1(4, 3), { ...p2, variants: [{ variantId: 'v1', quantity: 2 }] }]), StockTransferRefused, 'VARIANT_COUNTS_INVALID');
    expect(frozen(m)).toBe(was);
  });

  it('the receipt is blind per combination too: which combinations were sent, never how many, until it is received', async () => {
    const m = world();
    const { transfer } = await send(m, [L1(4, 3)]);
    const toHer = show(transfer, HER);
    expect(toHer.lines[0]).toEqual({
      productId: 'p1',
      quantitySent: null,
      quantityReceived: null,
      difference: null,
      variants: [
        { variantId: 'v1', quantitySent: null, quantityReceived: null, difference: null },
        { variantId: 'v2', quantitySent: null, quantityReceived: null, difference: null },
      ],
    });
    expect(show(transfer, ME).lines[0].variants?.map((v: Row) => v.quantitySent)).toEqual([4, 3]);
    const { transfer: after } = await receive(m, transfer.id, [{ productId: 'p1', quantity: 6, variants: [{ variantId: 'v1', quantity: 4 }, { variantId: 'v2', quantity: 2 }] }]);
    expect(show(after, HER).lines[0].variants?.map((v: Row) => [v.quantitySent, v.quantityReceived, v.difference])).toEqual([
      [4, 4, 0],
      [3, 2, 1],
    ]);
  });

  it('replays: the same id with the same combinations is that transfer; other combinations under the id are a conflict', async () => {
    const m = world();
    const id = '00000000-0000-4000-8000-000000000001';
    await send(m, [L1(4, 3)], { id });
    const was = frozen(m);
    const again = await send(m, [{ ...L1(4, 3), variants: [{ variantId: 'v2', quantity: 3 }, { variantId: 'v1', quantity: 4 }] }], { id });
    expect(again.replay).toBe(true);
    expect(frozen(m)).toBe(was);
    await refused(send(m, [L1(5, 2)], { id }), StockTransferRefused, 'TRANSFER_EXISTS');
    // The receipt's replay: the same counts by the same hand → done; other combination counts → refused.
    await receive(m, id, [L1(4, 2)]);
    const was2 = frozen(m);
    expect((await receive(m, id, [L1(4, 2)])).replay).toBe(true);
    expect(frozen(m)).toBe(was2);
    await refused(receive(m, id, [L1(3, 3)]), StockTransferRefused, 'ALREADY_RECEIVED');
  });
});

/* ───────────── the exit ───────────── */

describe('an exit carries the combinations: held while pending, out of the store when approved', () => {
  it('request holds the pieces (nothing moves); approve takes them out of THAT warehouse and the total falls by them', async () => {
    const m = world();
    const before = book(m);
    const { exit } = await askExit(m, [L1(2, 1)]);
    expect(broken(m)).toEqual([]);
    expect(m.data.stockExitLineVariant.map((r) => [r.variantId, r.quantity])).toEqual([
      ['v1', 2],
      ['v2', 1],
    ]);
    expect([onHand(m, 'v1'), onHand(m, 'v2')]).toEqual([11, 10]);
    await okExit(m, exit.id);
    expect(broken(m)).toEqual([]);
    expect([at(m, 'v1', 'wA'), at(m, 'v2', 'wA'), at(m, 'v1', 'wB')]).toEqual([7, 6, 2]);
    expect([onHand(m, 'v1'), onHand(m, 'v2')]).toEqual([9, 9]);
    expect(book(m)).toEqual({ produced: before.produced, sold: before.sold + 3, remaining: before.remaining - 3 });
    expect(m.data.variantStockMovement.filter((l) => l.type === 'EXIT').map((l) => [l.variantId, l.warehouseId, l.quantity, l.referenceId])).toEqual([
      ['v1', 'wA', -2, exit.id],
      ['v2', 'wA', -1, exit.id],
    ]);
  });

  it('reject releases the hold; nothing else moves', async () => {
    const m = world();
    const { exit } = await askExit(m, [L1(9, 0)]);
    await refused(send(m, [L1(1, 0)]), StockTransferRefused, 'VARIANTS_NOT_ENOUGH_FREE');
    const placesBefore = JSON.stringify(m.data.productVariantStock);
    await noExit(m, exit.id);
    expect(JSON.stringify(m.data.productVariantStock)).toBe(placesBefore);
    await send(m, [L1(1, 0)]);
    expect(broken(m)).toEqual([]);
  });

  it('NEGATIVE: an exit names the combinations by the same rules as a transfer', async () => {
    const m = world();
    const was = frozen(m);
    await refused(askExit(m, [{ productId: 'p1', quantity: 2 }]), StockExitRefused, 'VARIANTS_REQUIRED');
    await refused(askExit(m, [{ productId: 'p1', quantity: 3, variants: [{ variantId: 'v1', quantity: 2 }] }]), StockExitRefused, 'VARIANTS_SUM');
    // wB holds 5 units of the product (free) but only 2 of v1.
    await refused(askExit(m, [L1(4, 0)], { warehouseId: 'wB' }), StockExitRefused, 'VARIANTS_NOT_ENOUGH_FREE');
    expect(frozen(m)).toBe(was);
  });

  it('NEGATIVE: the warehouse no longer holds a combination’s pieces at approval → refused whole, nothing written', async () => {
    const m = world();
    const { exit } = await askExit(m, [L1(3, 0)]);
    // A delivery drew v1's pieces from wA meanwhile (the place falls, its ledger line says so — the books stay true).
    const row = m.data.productVariantStock.find((r) => r.id === 'pv1A')!;
    row.onHand = 2;
    m.data.productVariant.find((r) => r.id === 'v1')!.onHand -= 7;
    m.data.variantStockMovement.push({ id: 'sale', variantId: 'v1', warehouseId: 'wA', quantity: -7, type: 'SALE' });
    const was = frozen(m);
    const e = await refused(okExit(m, exit.id), StockExitRefused, 'VARIANT_NOT_ON_SHELF');
    expect(e.extra).toMatchObject({ variantId: 'v1', onShelf: 2, asked: 3 });
    expect(frozen(m)).toBe(was);
  });
});

/* ───────────── the placement ───────────── */

function unplaced(variants: Row[] = []) {
  return memoryDb({
    country: [{ id: 'k1', companyId: C1, isActive: true }],
    store: [{ id: S1, companyId: C1, countryId: 'k1', name: 'المتجر' }],
    warehouse: [
      { id: 'wA', companyId: C1, countryId: 'k1', name: 'أ', isActive: true },
      { id: 'wB', companyId: C1, countryId: 'k1', name: 'ب', isActive: true },
    ],
    product: [{ id: 'p1', companyId: C1, storeId: S1, name: 'قميص', sku: 'Q' }],
    productVariant: variants.length
      ? variants
      : [
          { id: 'v1', companyId: C1, productId: 'p1', label: 'أسود · L', status: 'ACTIVE', sortOrder: 0, onHand: 9 },
          { id: 'v2', companyId: C1, productId: 'p1', label: 'كحلي · M', status: 'ACTIVE', sortOrder: 1, onHand: 7 },
        ],
    productionBatch: [batch('b1', { warehouseId: null }), batch('b2', { warehouseId: null, quantityProduced: 6, quantityRemaining: 6, productionDate: new Date('2026-10-05') })],
  });
}
const counts = (a: Row[], b: Row[]) => [
  { warehouseId: 'wA', lines: [{ productId: 'p1', quantity: a.reduce((s, v) => s + v.quantity, 0), variants: a }] },
  { warehouseId: 'wB', lines: [{ productId: 'p1', quantity: b.reduce((s, v) => s + v.quantity, 0), variants: b }] },
];
const press = (m: M, c: Row[]) =>
  tx(m)((t) => placeStore(t as never, { companyId: C1, storeId: S1, countedByName: 'أمين المخزن', countedAt: new Date('2026-11-19T08:00:00Z'), recordedById: ME, counts: c as never }));

describe('the opening placement may say which combinations each warehouse holds', () => {
  it('the counted pieces leave «بلا مكان» for their warehouses; the total never moves; the ledger names the placement', async () => {
    const m = unplaced();
    const { placement } = await press(m, counts([{ variantId: 'v1', quantity: 6 }, { variantId: 'v2', quantity: 4 }], [{ variantId: 'v1', quantity: 3 }, { variantId: 'v2', quantity: 3 }]));
    expect(broken(m)).toEqual([]);
    expect([at(m, 'v1', 'wA'), at(m, 'v1', 'wB'), at(m, 'v1', null)]).toEqual([6, 3, 0]);
    expect([at(m, 'v2', 'wA'), at(m, 'v2', 'wB'), at(m, 'v2', null)]).toEqual([4, 3, 0]);
    expect([onHand(m, 'v1'), onHand(m, 'v2')]).toEqual([9, 7]);
    // OPENING (the count it had, «بلا مكان») then PLACEMENT lines, all naming the placement.
    const v1 = m.data.variantStockMovement.filter((l) => l.variantId === 'v1');
    expect(v1.map((l) => [l.type, l.warehouseId, l.quantity])).toEqual([
      ['OPENING', null, 9],
      ['PLACEMENT', 'wA', 6],
      ['PLACEMENT', 'wB', 3],
      ['PLACEMENT', null, -9],
    ]);
    expect(v1.filter((l) => l.type === 'PLACEMENT').every((l) => l.referenceId === placement.id)).toBe(true);
  });

  it('optional: a warehouse line without combinations leaves those pieces «بلا مكان» (W8a), and a combination counted short too', async () => {
    const m = unplaced();
    await press(m, [
      { warehouseId: 'wA', lines: [{ productId: 'p1', quantity: 10, variants: [{ variantId: 'v1', quantity: 5 }, { variantId: 'v2', quantity: 5 }] }] },
      { warehouseId: 'wB', lines: [{ productId: 'p1', quantity: 6 }] },
    ]);
    expect([at(m, 'v1', 'wA'), at(m, 'v1', null), at(m, 'v2', 'wA'), at(m, 'v2', null)]).toEqual([5, 4, 5, 2]);
    for (const v of VARIANTS) {
      const sum = placesOf(m, v).reduce((s2, r) => s2 + r.onHand, 0);
      expect(sum).toBe(onHand(m, v));
      expect(m.data.variantStockMovement.filter((l) => l.variantId === v).reduce((s2, l) => s2 + l.quantity, 0)).toBe(sum);
    }
  });

  it('NEGATIVE: more pieces of a combination than its count, a sum that does not add up, another product’s combination — the preview and the press refuse alike, nothing written', async () => {
    for (const [c, code] of [
      [counts([{ variantId: 'v1', quantity: 8 }, { variantId: 'v2', quantity: 2 }], [{ variantId: 'v1', quantity: 2 }, { variantId: 'v2', quantity: 4 }]), 'VARIANTS_OVER_COUNT'],
      [[{ warehouseId: 'wA', lines: [{ productId: 'p1', quantity: 16, variants: [{ variantId: 'v1', quantity: 9 }] }] }], 'VARIANTS_SUM'],
      [[{ warehouseId: 'wA', lines: [{ productId: 'p1', quantity: 16, variants: [{ variantId: 'v1', quantity: 9 }, { variantId: 'zz', quantity: 7 }] }] }], 'VARIANT_NOT_FOUND'],
    ] as const) {
      const m = unplaced([
        { id: 'v1', companyId: C1, productId: 'p1', label: 'أسود · L', status: 'ACTIVE', sortOrder: 0, onHand: 9 },
        { id: 'v2', companyId: C1, productId: 'p1', label: 'كحلي · M', status: 'ACTIVE', sortOrder: 1, onHand: 7 },
        { id: 'zz', companyId: C1, productId: 'p-other', label: 'غريب', status: 'ACTIVE', sortOrder: 0, onHand: 99 },
      ]);
      const was = frozen(m);
      await refused(tx(m)((t) => previewPlacement(t as never, { companyId: C1, storeId: S1, counts: c as never })), PlacementRefused, code);
      await refused(press(m, c as never), PlacementRefused, code);
      expect(frozen(m)).toBe(was);
    }
  });
});

/* ───────────── a delivery and a count never touch the road ───────────── */

describe('pieces on a road are on no shelf', () => {
  it('a delivery never draws them, and a count never takes them as «بلا مكان»', () => {
    const places = [
      { warehouseId: null, onHand: 5, inTransitTransferId: 't1' },
      { warehouseId: 'wA', onHand: 1 },
      { warehouseId: null, onHand: 2 },
    ];
    expect(drawPlan(places, 10, null)).toEqual([
      { warehouseId: null, delta: -2 },
      { warehouseId: 'wA', delta: -1 },
    ]);
    expect(countPlan(places, 'wA', 6)).toEqual([
      { warehouseId: 'wA', delta: 5 },
      { warehouseId: null, delta: -2 },
    ]);
  });
});

/* ───────────── conservation on random sequences ───────────── */

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

/** What left the store by the documents, counted from the documents (not from the function under test). */
function removed(m: M, productId = 'p1') {
  const exits = m.data.stockExit.filter((e) => e.status === 'APPROVED').map((e) => e.id);
  const out = m.data.stockExitLine.filter((l) => exits.includes(l.exitId) && l.productId === productId).reduce((s, l) => s + l.quantity, 0);
  const approved = m.data.stockTransfer.filter((t) => t.differenceApprovedAt).map((t) => t.id);
  const lost = m.data.stockTransferLine
    .filter((l) => approved.includes(l.transferId) && l.productId === productId)
    .reduce((s, l) => s + l.quantitySent - (l.quantityReceived ?? 0), 0);
  return out + lost;
}

describe('conservation: 300 random sequences of send → receive (whole, short, zero) → difference, cancel, exit approve / reject', () => {
  it('after every step: onHand = Σ places = Σ ledger; pieces = units in every place; the book moves only by what left', async () => {
    let steps = 0;
    let refusals = 0;
    const kinds = new Set<string>();
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed);
      const int = (n: number) => Math.floor(r() * n);
      const m = world();
      const start = book(m);
      for (let k = 0; k < 14; k++) {
        const kind = ['send', 'send', 'receive', 'receive', 'cancel', 'difference', 'exit', 'approve', 'reject'][int(9)];
        const from = r() < 0.5 ? 'wA' : 'wB';
        const transfers = m.data.stockTransfer;
        const exits = m.data.stockExit;
        const before = frozen(m);
        try {
          if (kind === 'send') {
            const q1 = int(5);
            const q2 = int(5) + (q1 === 0 ? 1 : 0);
            await send(m, [L1(q1, q2), ...(r() < 0.3 ? [{ productId: 'p2', quantity: 1 + int(3) }] : [])], { fromWarehouseId: from, toWarehouseId: from === 'wA' ? 'wB' : 'wA' });
          } else if (kind === 'receive' && transfers.length) {
            const t = transfers[int(transfers.length)];
            const lines = m.data.stockTransferLine
              .filter((l) => l.transferId === t.id)
              .map((l) => {
                const vs = m.data.stockTransferLineVariant
                  .filter((v) => v.lineId === l.id)
                  .map((v) => ({ variantId: v.variantId, quantity: r() < 0.6 ? v.quantitySent : int(v.quantitySent + 1) }));
                return vs.length
                  ? { productId: l.productId, quantity: vs.reduce((s, v) => s + v.quantity, 0), variants: vs }
                  : { productId: l.productId, quantity: r() < 0.7 ? l.quantitySent : int(l.quantitySent + 1) };
              });
            await receive(m, t.id, lines);
          } else if (kind === 'cancel' && transfers.length) {
            await cancel(m, transfers[int(transfers.length)].id);
          } else if (kind === 'difference' && transfers.length) {
            await approve(m, transfers[int(transfers.length)].id, r() < 0.5 ? 'LOSS' : 'DAMAGE');
          } else if (kind === 'exit') {
            await askExit(m, [L1(int(3), 1 + int(2))], { warehouseId: from });
          } else if (kind === 'approve' && exits.length) {
            await okExit(m, exits[int(exits.length)].id);
          } else if (kind === 'reject' && exits.length) {
            await noExit(m, exits[int(exits.length)].id);
          }
        } catch (e) {
          if (!(e instanceof StockTransferRefused) && !(e instanceof StockExitRefused)) throw e;
          refusals++;
          // A refusal writes nothing.
          expect(frozen(m), `seed ${seed} step ${k} (${kind}) refused but wrote`).toBe(before);
        }
        steps++;
        expect(broken(m), `seed ${seed} step ${k} (${kind})`).toEqual([]);
        const gone = removed(m);
        expect(book(m), `seed ${seed} step ${k}`).toEqual({ produced: start.produced, sold: start.sold + gone, remaining: start.remaining - gone });
        expect(onHand(m, 'v1') + onHand(m, 'v2'), `seed ${seed} step ${k}`).toBe(21 - gone);
      }
      for (const l of m.data.variantStockMovement) kinds.add(l.type);
    }
    // Not vacuous: every kind of move happened somewhere, and refusals happened too.
    expect(steps).toBe(300 * 14);
    expect(refusals).toBeGreaterThan(100);
    expect([...kinds].sort()).toEqual(['COUNT', 'DAMAGE', 'EXIT', 'LOSS', 'TRANSFER_BACK', 'TRANSFER_IN', 'TRANSFER_OUT']);
  });
});

/* ───────────── locks ───────────── */

describe('locks: the combination rows LAST, all at once, sorted', () => {
  it('a send locks the product, then the warehouses, then — after every batch write — the combinations in ONE sorted statement', async () => {
    const m = world();
    await send(m, [{ productId: 'p1', quantity: 5, variants: [{ variantId: 'v2', quantity: 2 }, { variantId: 'v1', quantity: 3 }] }]);
    const variantLocks = m.locks.filter((l) => l.includes('"product_variants"'));
    expect(variantLocks).toHaveLength(1);
    expect(variantLocks[0]).toMatch(/FOR UPDATE :: v1,v2$/);
    const firstVariantLock = m.locks.findIndex((l) => l.includes('"product_variants"'));
    const warehouseLock = m.locks.findIndex((l) => l.includes('"warehouses"'));
    expect(warehouseLock).toBeGreaterThan(-1);
    expect(warehouseLock).toBeLessThan(firstVariantLock);
    // Writes: every batch write comes before the first combination write.
    const lastBatch = Math.max(m.touched.lastIndexOf('productionBatch.update'), m.touched.lastIndexOf('productionBatch.create'), m.touched.lastIndexOf('productionBatch.updateMany'));
    const firstPiece = m.touched.findIndex((t) => t.startsWith('productVariantStock.'));
    expect(lastBatch).toBeGreaterThan(-1);
    expect(firstPiece).toBeGreaterThan(lastBatch);
  });

  it('two documents naming the same combinations in opposite orders lock them in the same order', async () => {
    const m = world();
    await askExit(m, [{ productId: 'p1', quantity: 2, variants: [{ variantId: 'v2', quantity: 1 }, { variantId: 'v1', quantity: 1 }] }]);
    await askExit(m, [{ productId: 'p1', quantity: 2, variants: [{ variantId: 'v1', quantity: 1 }, { variantId: 'v2', quantity: 1 }] }], {}, HER);
    await okExit(m, m.data.stockExit[0].id);
    await okExit(m, m.data.stockExit[1].id);
    const variantLocks = m.locks.filter((l) => l.includes('"product_variants"'));
    expect(variantLocks).toHaveLength(2);
    expect(new Set(variantLocks.map((l) => l.split(' :: ')[1]))).toEqual(new Set(['v1,v2']));
  });
});

/* ───────────── no money ───────────── */

describe('NO MONEY: the combination lines import nothing of wallets, expenses or profit', () => {
  it('variant-lines.ts walked through every module it loads', () => {
    const ROOT = process.cwd();
    const seen = new Set<string>();
    const walk = (rel: string) => {
      if (seen.has(rel)) return;
      seen.add(rel);
      const src = readFileSync(join(ROOT, rel), 'utf8');
      for (const [, spec] of src.matchAll(/from\s+['"](\.\/[^'"]+)['"]/g)) {
        const next = `src/lib/${spec.replace('./', '')}.ts`;
        try {
          readFileSync(join(ROOT, next));
        } catch {
          continue;
        }
        walk(next);
      }
    };
    walk('src/lib/variant-lines.ts');
    expect(seen.has('src/lib/variant-stock.ts')).toBe(true);
    expect([...seen].filter((f) => /wallet|expense|profit|financ|commission|settlement/i.test(f))).toEqual([]);
  });
});

/* ───────────── the bodies, and what a screen reads of the road ───────────── */

describe('the doors’ bodies carry the combinations, in Arabic', () => {
  it('send, receive, exit and placement keep `variants`; a bad one is refused with an Arabic sentence', () => {
    const line = { productId: 'p1', quantity: 2, variants: [{ variantId: 'v1', quantity: 2 }] };
    expect(sendSchema.parse({ fromWarehouseId: 'wA', toWarehouseId: 'wB', lines: [line] }).lines[0].variants).toEqual(line.variants);
    expect(requestSchema.parse({ warehouseId: 'wA', reason: 'DAMAGED', lines: [line] }).lines[0].variants).toEqual(line.variants);
    expect(receiveSchema.parse({ lines: [{ ...line, variants: [{ variantId: 'v1', quantity: 0 }] }] }).lines[0].variants).toEqual([{ variantId: 'v1', quantity: 0 }]);
    expect(countsSchema.parse([{ warehouseId: 'wA', lines: [line] }])[0].lines[0].variants).toEqual(line.variants);
    for (const bad of [{ variantId: 'v1', quantity: 0 }, { variantId: '', quantity: 1 }, { variantId: 'v1', quantity: 1.5 }]) {
      const res = sendSchema.safeParse({ fromWarehouseId: 'wA', toWarehouseId: 'wB', lines: [{ productId: 'p1', quantity: 1, variants: [bad] }] });
      expect(res.success).toBe(false);
      expect(res.error!.issues[0].message).toMatch(/[؀-ۿ]/);
    }
    // A line with no combinations parses to what it always parsed to: no `variants` key appears.
    expect('variants' in sendSchema.parse({ fromWarehouseId: 'wA', toWarehouseId: 'wB', lines: [{ productId: 'p2', quantity: 1 }] }).lines[0]).toBe(false);
  });

  it('the variants screen reads the road as ONE figure per combination (never per transfer), apart from the shelves', async () => {
    const m = world();
    await send(m, [L1(2, 0)]);
    await send(m, [L1(1, 0)], { fromWarehouseId: 'wB', toWarehouseId: 'wA' });
    const places = await placesOfVariants(m.tx as never, [{ id: 'v1', onHand: 11 }]);
    expect(places.get('v1')).toEqual([
      { warehouseId: 'wA', onHand: 7 },
      { warehouseId: 'wB', onHand: 1 },
      { warehouseId: null, onHand: 3, inTransit: true },
    ]);
  });
});

/* ───────────── review round 1 (20/11): the order of a send's writes, two holes the breaks found ───────────── */

describe('review: a send writes its combination rows only after every batch row', () => {
  it('the combination document rows and the pieces come after the last batch write (a delivery locks batch rows, then combination rows)', async () => {
    const m = world();
    await send(m, [L1(4, 3), { productId: 'p2', quantity: 2 }]);
    const lastBatch = Math.max(
      m.touched.lastIndexOf('productionBatch.update'),
      m.touched.lastIndexOf('productionBatch.create'),
      m.touched.lastIndexOf('productionBatch.updateMany')
    );
    const firstLineVariant = m.touched.indexOf('stockTransferLineVariant.create');
    const firstPiece = m.touched.findIndex((t) => t.startsWith('productVariantStock.') || t.startsWith('productVariant.') || t.startsWith('variantStockMovement.'));
    expect(lastBatch).toBeGreaterThan(-1);
    expect(firstLineVariant).toBeGreaterThan(lastBatch);
    expect(firstPiece).toBeGreaterThan(lastBatch);
    // And the combinations' row lock is taken after the last batch write too: no lock statement and no combination
    // write happens in between the batch writes.
    expect(m.touched.slice(0, lastBatch + 1).filter((t) => /Variant/.test(t))).toEqual([]);
  });
});

describe('review: holds are per warehouse, and an exit replay compares the combinations', () => {
  it('a pending exit from ANOTHER warehouse holds none of this warehouse’s pieces', async () => {
    const m = world();
    // wB holds v1 ×2; an exit from wB holds both.
    await askExit(m, [L1(2, 0)], { warehouseId: 'wB' });
    // wA still has all 9 of v1 free: a send of 9 from wA goes.
    const { transfer } = await send(m, [L1(9, 0)]);
    expect(at(m, 'v1', null, transfer.id)).toBe(9);
    // …while from wB nothing of v1 is free now.
    await refused(send(m, [L1(1, 0)], { fromWarehouseId: 'wB', toWarehouseId: 'wA' }), StockTransferRefused, 'VARIANTS_NOT_ENOUGH_FREE');
    expect(broken(m)).toEqual([]);
  });

  it('the same exit id with other combinations is EXIT_EXISTS; with the same ones (any order) it is the replay', async () => {
    const m = world();
    const id = '00000000-0000-4000-a000-000000000077';
    await askExit(m, [L1(2, 1)], { id });
    const was = frozen(m);
    const again = await askExit(m, [{ ...L1(2, 1), variants: [{ variantId: 'v2', quantity: 1 }, { variantId: 'v1', quantity: 2 }] }], { id });
    expect(again.replay).toBe(true);
    expect(frozen(m)).toBe(was);
    await refused(askExit(m, [L1(1, 2)], { id }), StockExitRefused, 'EXIT_EXISTS');
    expect(frozen(m)).toBe(was);
  });
});
