import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — «لصق الباركودات» (RV165, the owner 3/11)
 *
 * A batch handed to the courier before «رحّل إلى الشركة» can never be dispatched again (`BATCH_NOT_READY`), and the order's
 * own door refuses a barcode after «مشحون». Its parcels are made at the courier's portal by hand and the barcodes come back
 * as lines «رقم الطلب, الباركود».
 *
 *  1. `POST /api/shipping-batches/:id/tracking` reads the lines (comma, tab or spaces; our number or our reference) and
 *     answers one result per line: written / unchanged / refused with an Arabic reason. `dryRun` writes nothing.
 *  2. It works on a batch in any state — a handed-over one above all.
 *  3. It asks `ops.ship` (the dispatch's key); the batch is read inside the session's company AND store.
 *  4. Refused: an order not in this batch; a different barcode already on the order (unless `overwrite`); one barcode for
 *     two orders; a barcode held by another order of the company; a malformed barcode (4–64, no space inside).
 *  5. The write is one transaction, conditional on what was read; one activity row and one audit row per order changed.
 *     Only `trackingNumber` and the version are written — no money, no status, no stock.
 * ═══════════════════════════════════════════════════════════════════════
 */

type Row = {
  id: string; orderNumber: string; merchantRef: string | null; trackingNumber: string | null;
  companyId: string; storeId: string; shippingBatchId: string | null; version: number;
};

const { db, requireContext, can, world } = vi.hoisted(() => {
  const world = { orders: [] as Row[], batches: [] as { id: string; batchNumber: string; companyId: string; storeId: string; status: string }[] };
  const pick = (row: Record<string, unknown>, select?: Record<string, boolean>) =>
    select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k]])) : { ...row };
  const fits = (row: Record<string, unknown>, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, want]) => {
      if (want && typeof want === 'object' && 'in' in (want as object)) return (want as { in: unknown[] }).in.includes(row[k]);
      return row[k] === want;
    });
  const db: Record<string, any> = {
    shippingBatch: {
      findFirst: vi.fn(async ({ where, select }: any) => {
        const b = world.batches.find((x) => fits(x, where));
        return b ? pick(b, select) : null;
      }),
    },
    order: {
      findMany: vi.fn(async ({ where, select }: any) => world.orders.filter((o) => fits(o, where)).map((o) => pick(o, select))),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const hit = world.orders.filter((o) => fits(o, where));
        for (const o of hit) {
          o.trackingNumber = data.trackingNumber;
          if (data.version?.increment) o.version += data.version.increment;
        }
        return { count: hit.length };
      }),
    },
    orderActivity: { createMany: vi.fn(async ({ data }: any) => ({ count: data.length })) },
    auditLog: { createMany: vi.fn(async ({ data }: any) => ({ count: data.length })) },
  };
  // The transaction is the same client; a throw inside it is what a rollback looks like from here.
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return { db, requireContext: vi.fn(), can: vi.fn(), world };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ can: (...a: unknown[]) => can(...a) }));

import { POST } from './route';

const ID = 'batch-4';
const call = (body: unknown, id = ID) =>
  POST(
    new Request(`http://localhost/api/shipping-batches/${id}/tracking`, { method: 'POST', body: JSON.stringify(body) }),
    { params: Promise.resolve({ id }) },
  );

const order = (n: string, over: Partial<Row> = {}): Row => ({
  id: `o${n}`, orderNumber: `ORD-2026-${n}`, merchantRef: null, trackingNumber: null,
  companyId: 'c1', storeId: 's1', shippingBatchId: ID, version: 1, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({ user: { id: 'u1', name: 'قباص', role: 'WAREHOUSE' }, companyId: 'c1', storeId: 's1' });
  can.mockImplementation((_u: unknown, k: string) => k === 'ops.ship');
  // Handed over (SHIPPED) — the batch the dispatch refuses for good.
  world.batches = [
    { id: ID, batchNumber: 'BATCH-2026-0004', companyId: 'c1', storeId: 's1', status: 'SHIPPED' },
    { id: 'batch-other-store', batchNumber: 'BATCH-2026-0009', companyId: 'c1', storeId: 's2', status: 'SHIPPED' },
  ];
  world.orders = [
    order('0722'),
    order('0963', { merchantRef: 'SHOP-77' }),
    order('0100', { trackingNumber: 'OLD12345' }),
    order('0200', { trackingNumber: 'SAME9999' }),
    // Another batch of this store, and an order of another store holding a barcode.
    order('0555', { shippingBatchId: 'batch-5' }),
    order('0900', { storeId: 's2', shippingBatchId: 'batch-other-store', trackingNumber: 'TAKEN-S2' }),
    order('0901', { shippingBatchId: 'batch-5', trackingNumber: 'TAKEN-S1' }),
  ];
});

const byLine = (body: { lines: { line: number }[] }) => Object.fromEntries(body.lines.map((l) => [l.line, l]));

describe('the paste is read and answered line by line', () => {
  it('comma, tab and spaces; our number or our reference; Arabic digits — and a dry run writes nothing', async () => {
    const res = await call({ dryRun: true, text: 'ORD-2026-0722, 1234567890\r\nshop-77\t١٢٣٤٥٦٧٨٩١\n\n  ord-2026-0200   SAME9999  ' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dryRun).toBe(true);
    expect(body.counts).toEqual({ written: 2, unchanged: 1, refused: 0 });
    const lines = byLine(body);
    expect(lines[1]).toMatchObject({ outcome: 'written', orderNumber: 'ORD-2026-0722', barcode: '1234567890', previous: null });
    expect(lines[2]).toMatchObject({ outcome: 'written', orderNumber: 'ORD-2026-0963', barcode: '1234567891' });
    expect(lines[4]).toMatchObject({ outcome: 'unchanged', code: 'SAME_BARCODE' });
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(world.orders.find((o) => o.id === 'o0722')!.trackingNumber).toBeNull();
  });

  it('writes on a HANDED-OVER batch: only the barcode and the version, one activity and one audit row per order changed', async () => {
    const res = await call({ text: 'ORD-2026-0722,1234567890\nORD-2026-0200,SAME9999' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.counts).toEqual({ written: 1, unchanged: 1, refused: 0 });

    const o = world.orders.find((x) => x.id === 'o0722')!;
    expect(o.trackingNumber).toBe('1234567890');
    expect(o.version).toBe(2);
    expect(world.orders.find((x) => x.id === 'o0200')!.version).toBe(1);

    expect(db.order.updateMany).toHaveBeenCalledTimes(1);
    const { where, data } = db.order.updateMany.mock.calls[0][0];
    // Conditional on what was read, inside this batch, this company, this store.
    expect(where).toEqual({ id: 'o0722', companyId: 'c1', storeId: 's1', shippingBatchId: ID, trackingNumber: null });
    // No money, no status, no stock: the barcode and the version, nothing else.
    expect(Object.keys(data).sort()).toEqual(['trackingNumber', 'version']);

    expect(db.orderActivity.createMany.mock.calls[0][0].data).toHaveLength(1);
    expect(db.orderActivity.createMany.mock.calls[0][0].data[0]).toMatchObject({ orderId: 'o0722', action: 'TRACKING_PASTED', userId: 'u1' });
    const audit = db.auditLog.createMany.mock.calls[0][0].data;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ companyId: 'c1', entity: 'Order', entityId: 'o0722', action: 'ORDER_TRACKING_PASTED' });
    expect(JSON.parse(audit[0].previousData)).toEqual({ trackingNumber: null });
    expect(JSON.parse(audit[0].newData)).toMatchObject({ trackingNumber: '1234567890', batchNumber: 'BATCH-2026-0004' });
  });

  it('nothing to write: no audit and no activity rows', async () => {
    await call({ text: 'ORD-2026-0200 SAME9999' });
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(db.auditLog.createMany).not.toHaveBeenCalled();
    expect(db.orderActivity.createMany).not.toHaveBeenCalled();
  });
});

describe('NEGATIVE — every guard refuses', () => {
  it('without `ops.ship`: 403, nothing read', async () => {
    can.mockImplementation((_u: unknown, k: string) => k === 'ops.batches');
    const res = await call({ text: 'ORD-2026-0722,1234567890' });
    expect(res.status).toBe(403);
    expect((await res.json()).errorAr).toContain('إنشاء الشحنات');
    expect(db.shippingBatch.findFirst).not.toHaveBeenCalled();
    expect(db.order.findMany).not.toHaveBeenCalled();
  });

  it('another store’s batch: 404, the batch is asked inside the session’s company and store, and no order is read', async () => {
    const res = await call({ text: 'ORD-2026-0900,1234567890' }, 'batch-other-store');
    expect(res.status).toBe(404);
    expect(db.shippingBatch.findFirst.mock.calls[0][0].where).toEqual({ id: 'batch-other-store', companyId: 'c1', storeId: 's1' });
    expect(db.order.findMany).not.toHaveBeenCalled();
  });

  it('an unknown batch: 404', async () => {
    expect((await call({ text: 'ORD-2026-0722,1234567890' }, 'nope')).status).toBe(404);
  });

  it('an order of ANOTHER batch is refused and not written', async () => {
    const body = await (await call({ text: 'ORD-2026-0555,1234567890\nORD-NOPE,1234567891' })).json();
    expect(body.lines.map((l: { code: string }) => l.code)).toEqual(['NOT_IN_BATCH', 'NOT_IN_BATCH']);
    expect(body.lines[0].reason).toBe('الطلب مش من هالدفعة');
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(world.orders.find((o) => o.id === 'o0555')!.trackingNumber).toBeNull();
  });

  it('a different barcode already on the order is NOT overwritten without `overwrite` — and is with it', async () => {
    const refused = await (await call({ text: 'ORD-2026-0100,NEW55555' })).json();
    expect(refused.lines[0]).toMatchObject({ outcome: 'refused', code: 'HAS_OTHER_BARCODE' });
    expect(refused.lines[0].reason).toContain('عليه باركود تاني');
    expect(world.orders.find((o) => o.id === 'o0100')!.trackingNumber).toBe('OLD12345');

    const written = await (await call({ text: 'ORD-2026-0100,NEW55555', overwrite: true })).json();
    expect(written.lines[0]).toMatchObject({ outcome: 'written', previous: 'OLD12345' });
    expect(db.order.updateMany.mock.calls[0][0].where.trackingNumber).toBe('OLD12345');
    expect(world.orders.find((o) => o.id === 'o0100')!.trackingNumber).toBe('NEW55555');
    expect(JSON.parse(db.auditLog.createMany.mock.calls[0][0].data[0].previousData)).toEqual({ trackingNumber: 'OLD12345' });
  });

  it('one barcode pasted for two orders: both lines refused, nothing written', async () => {
    const body = await (await call({ text: 'ORD-2026-0722,DUP12345\nORD-2026-0963,DUP12345' })).json();
    expect(body.counts).toEqual({ written: 0, unchanged: 0, refused: 2 });
    expect(body.lines.every((l: { code: string }) => l.code === 'BARCODE_TWICE')).toBe(true);
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('one order pasted with two barcodes: both lines refused', async () => {
    const body = await (await call({ text: 'ORD-2026-0722,AAAA1111\nORD-2026-0722,BBBB2222' })).json();
    expect(body.lines.map((l: { code: string }) => l.code)).toEqual(['ORDER_TWICE', 'ORDER_TWICE']);
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('a barcode already on another order of the company is refused — named only when that order is of this store', async () => {
    const body = await (await call({ text: 'ORD-2026-0722,TAKEN-S1\nORD-2026-0963,TAKEN-S2' })).json();
    expect(body.lines[0]).toMatchObject({ outcome: 'refused', code: 'BARCODE_TAKEN' });
    expect(body.lines[0].reason).toContain('ORD-2026-0901');
    expect(body.lines[1]).toMatchObject({ outcome: 'refused', code: 'BARCODE_TAKEN' });
    expect(body.lines[1].reason).not.toContain('ORD-2026-0900');
    expect(db.order.findMany.mock.calls[1][0].where).toEqual({ companyId: 'c1', trackingNumber: { in: ['TAKEN-S1', 'TAKEN-S2'] } });
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('a malformed barcode is refused: too short, too long, a space inside, a letter that is not Latin, a line with one value', async () => {
    const body = await (
      await call({ text: `ORD-2026-0722,123\nORD-2026-0722,${'9'.repeat(65)}\nORD-2026-0722 12 34567\nORD-2026-0722,باركود12\nORD-2026-0963` })
    ).json();
    expect(body.lines.map((l: { code: string }) => l.code)).toEqual([
      'BARCODE_LENGTH', 'BARCODE_LENGTH', 'BARCODE_HAS_SPACE', 'BARCODE_CHARS', 'LINE_INCOMPLETE',
    ]);
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('a barcode that moved between the read and the write stops the whole paste (409), nothing of it kept', async () => {
    db.order.updateMany.mockImplementationOnce(async () => ({ count: 1 })).mockImplementationOnce(async () => ({ count: 0 }));
    const res = await call({ text: 'ORD-2026-0722,1234567890\nSHOP-77,1234567891' });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('BARCODE_MOVED');
    expect(db.auditLog.createMany).not.toHaveBeenCalled();
  });

  it('an empty batch is refused (409); an empty or missing paste is a 400', async () => {
    world.orders = world.orders.filter((o) => o.shippingBatchId !== ID);
    expect((await call({ text: 'ORD-2026-0722,1234567890' })).status).toBe(409);
    expect((await call({ text: 'ORD-2026-0722,1234567890', dryRun: true })).status).toBe(409);
    expect((await call({ text: '  \n ' })).status).toBe(400);
    expect((await call({})).status).toBe(400);
  });
});
