import { describe, expect, it } from 'vitest';
import { descendantsOf, splitBatch, SplitRefused } from './batch-split';

/**
 * THE SPLIT — the one primitive by which units change place inside one store. A small in-memory batches table with its
 * own `where`; what is asserted is computed here from the rows.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- an in-memory row; every field is read by name
type Row = Record<string, any>;

function batch(id: string, over: Row = {}): Row {
  return {
    id,
    companyId: 'c1',
    storeId: 's1',
    productId: 'p1',
    batchNumber: `RCV-${id}`,
    quantityProduced: 20,
    quantitySold: 8,
    quantityRemaining: 12,
    quantityMovedIn: 0,
    quantityMovedOut: 0,
    manufacturingCost: 30,
    packagingCost: 5,
    rawMaterialCost: 5,
    otherCosts: 0,
    totalProductionCost: 40,
    costPerUnit: 2,
    productionDate: new Date('2026-10-01'),
    createdAt: new Date('2026-10-01T08:00:00Z'),
    status: 'COMPLETED',
    notes: 'تشغيلة أكتوبر',
    openingCountId: 'oc1',
    warehouseId: 'w1',
    inTransitTransferId: null,
    splitFromBatchId: null,
    ...over,
  };
}

function fake(rows: Row[], opts: { meddle?: (rows: Row[]) => void } = {}) {
  const log: Row[] = [];
  let seq = 0;
  const ok = (r: Row, where: Row) =>
    Object.entries(where).every(([k, v]) => (v && typeof v === 'object' && 'in' in v ? (v.in as unknown[]).includes(r[k]) : r[k] === v));
  const pick = (r: Row, select?: Row) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, r[k]])) : { ...r });
  const tx: Row = {
    productionBatch: {
      findFirst: async ({ where, select }: Row) => {
        log.push({ op: 'read' });
        const r = rows.find((x) => ok(x, where));
        return r ? pick(r, select) : null;
      },
      findMany: async ({ where, select }: Row) => rows.filter((x) => ok(x, where)).map((r) => pick(r, select)),
      updateMany: async ({ where, data }: Row) => {
        opts.meddle?.(rows);
        log.push({ op: 'write' });
        const hit = rows.filter((x) => ok(x, where));
        for (const r of hit) {
          r.quantityRemaining -= data.quantityRemaining.decrement;
          r.quantityMovedOut += data.quantityMovedOut.increment;
        }
        return { count: hit.length };
      },
      create: async ({ data, select }: Row) => {
        log.push({ op: 'write' });
        const row = { id: `t${++seq}`, ...data };
        rows.push(row);
        return pick(row, select);
      },
    },
    $executeRaw: async (_s: TemplateStringsArray, ...values: unknown[]) => (log.push({ op: 'lock', values }), 1),
  };
  return { tx: tx as never, log, rows };
}

const identity = (b: Row) => b.quantityProduced + b.quantityMovedIn - b.quantitySold - b.quantityMovedOut;

describe('splitBatch — the twin', () => {
  it('the parent gives n away (moved out), the twin holds them (moved in) — produced, sold and value unchanged', async () => {
    const { tx, rows } = fake([batch('b1')]);
    const before = { produced: 20, sold: 8, remaining: 12, value: 12 * 2 };
    const { twin } = await splitBatch(tx, { companyId: 'c1', batchId: 'b1', quantity: 5, to: { warehouseId: 'w2' }, hex: 'a1b2c3' });
    const [parent, t] = rows;
    expect(parent).toMatchObject({ quantityRemaining: 7, quantityMovedOut: 5, quantityProduced: 20, quantitySold: 8, warehouseId: 'w1' });
    expect(t).toMatchObject({
      id: twin.id,
      batchNumber: 'RCV-b1~a1b2c3',
      quantityProduced: 0,
      quantitySold: 0,
      quantityMovedIn: 5,
      quantityMovedOut: 0,
      quantityRemaining: 5,
      manufacturingCost: 0,
      packagingCost: 0,
      rawMaterialCost: 0,
      otherCosts: 0,
      totalProductionCost: 0,
      costPerUnit: 2,
      storeId: 's1',
      status: 'COMPLETED',
      notes: 'تشغيلة أكتوبر',
      splitFromBatchId: 'b1',
      warehouseId: 'w2',
      inTransitTransferId: null,
    });
    expect(t.productionDate).toEqual(parent.productionDate);
    expect(t.createdAt).toEqual(parent.createdAt);
    expect('openingCountId' in t).toBe(false);
    for (const b of rows) expect(b.quantityRemaining).toBe(identity(b));
    expect({
      produced: rows.reduce((s, b) => s + b.quantityProduced, 0),
      sold: rows.reduce((s, b) => s + b.quantitySold, 0),
      remaining: rows.reduce((s, b) => s + b.quantityRemaining, 0),
      value: rows.reduce((s, b) => s + b.quantityRemaining * b.costPerUnit, 0),
    }).toEqual(before);
  });

  it('a random six-hex batch number when none is given', async () => {
    const { tx, rows } = fake([batch('b1')]);
    await splitBatch(tx, { companyId: 'c1', batchId: 'b1', quantity: 1, to: { warehouseId: 'w2' } });
    expect(rows[1].batchNumber).toMatch(/^RCV-b1~[0-9a-f]{6}$/);
  });

  it('to a transfer on the road: no warehouse, the transfer named', async () => {
    const { tx, rows } = fake([batch('b1')]);
    await splitBatch(tx, { companyId: 'c1', batchId: 'b1', quantity: 12, to: { inTransitTransferId: 'tr1' } });
    expect(rows[0].quantityRemaining).toBe(0);
    expect(rows[1]).toMatchObject({ warehouseId: null, inTransitTransferId: 'tr1', quantityRemaining: 12 });
  });

  it('a split of a split: the chain keeps the identity, the cost and the date; descendantsOf finds every generation', async () => {
    const { tx, rows } = fake([batch('b1')]);
    const first = await splitBatch(tx, { companyId: 'c1', batchId: 'b1', quantity: 6, to: { warehouseId: 'w2' }, hex: '000001' });
    const second = await splitBatch(tx, { companyId: 'c1', batchId: first.twin.id, quantity: 4, to: { warehouseId: 'w3' }, hex: '000002' });
    const grand = rows.find((r) => r.id === second.twin.id)!;
    expect(grand).toMatchObject({ batchNumber: 'RCV-b1~000001~000002', splitFromBatchId: first.twin.id, costPerUnit: 2, quantityRemaining: 4, quantityProduced: 0 });
    expect(rows.find((r) => r.id === first.twin.id)).toMatchObject({ quantityMovedIn: 6, quantityMovedOut: 4, quantityRemaining: 2 });
    for (const b of rows) expect(b.quantityRemaining).toBe(identity(b));
    expect(rows.reduce((s, b) => s + b.quantityRemaining, 0)).toBe(12);
    expect((await descendantsOf(tx, 'c1', ['b1'])).sort()).toEqual([first.twin.id, second.twin.id].sort());
    expect(await descendantsOf(tx, 'c1', [second.twin.id])).toEqual([]);
  });
});

describe('splitBatch — the lock and the refusals', () => {
  it('takes the product’s stock lock (the reserver’s key) before reading the quantity it decides on', async () => {
    const { tx, log } = fake([batch('b1')]);
    await splitBatch(tx, { companyId: 'c1', batchId: 'b1', quantity: 1, to: { warehouseId: 'w2' } });
    const lock = log.findIndex((l) => l.op === 'lock');
    expect(log[lock].values).toEqual([4711, 'stock:c1:*:p1']);
    // One read to learn the product, the lock, then the read that decides.
    expect(log.slice(0, lock + 2).map((l) => l.op)).toEqual(['read', 'lock', 'read']);
  });

  const refusals: [string, Row, string][] = [
    ['zero units', { quantity: 0 }, 'QUANTITY_INVALID'],
    ['negative units', { quantity: -3 }, 'QUANTITY_INVALID'],
    ['a fraction', { quantity: 1.5 }, 'QUANTITY_INVALID'],
    ['more than the batch holds', { quantity: 13 }, 'NOT_ENOUGH_UNITS'],
    ['a batch of another company', { companyId: 'c2' }, 'BATCH_NOT_FOUND'],
    ['a batch that does not exist', { batchId: 'nope' }, 'BATCH_NOT_FOUND'],
    ['no target', { to: {} }, 'TARGET_INVALID'],
    ['an empty warehouse id', { to: { warehouseId: '' } }, 'TARGET_INVALID'],
  ];
  it.each(refusals)('NEGATIVE: %s — refused in Arabic, nothing written', async (_n, over, code) => {
    const { tx, log, rows } = fake([batch('b1')]);
    const err = await splitBatch(tx, { companyId: 'c1', batchId: 'b1', quantity: 2, to: { warehouseId: 'w2' }, ...over } as never).catch((e) => e);
    expect(err).toBeInstanceOf(SplitRefused);
    expect(err.code).toBe(code);
    expect(err.errorAr).toMatch(/[؀-ۿ]/);
    expect(log.filter((l) => l.op === 'write')).toEqual([]);
    expect(rows).toHaveLength(1);
  });

  it('NEGATIVE: outside a transaction — refused (a lock taken outside one protects nothing)', async () => {
    const { tx } = fake([batch('b1')]);
    const root = { ...(tx as Row), $transaction: async () => undefined };
    expect((await splitBatch(root as never, { companyId: 'c1', batchId: 'b1', quantity: 1, to: { warehouseId: 'w2' } }).catch((e) => e)).code).toBe('NOT_IN_TRANSACTION');
  });

  it('NEGATIVE: a batch changed between the read and the write (a draw-down takes no lock) — the split stops, no twin', async () => {
    const { tx, rows } = fake([batch('b1')], { meddle: (r) => void (r[0].quantityRemaining = 11) });
    const err = await splitBatch(tx, { companyId: 'c1', batchId: 'b1', quantity: 2, to: { warehouseId: 'w2' } }).catch((e) => e);
    expect(err.code).toBe('NOT_ENOUGH_UNITS');
    expect(rows).toHaveLength(1);
    expect(rows[0].quantityMovedOut).toBe(0);
  });
});
