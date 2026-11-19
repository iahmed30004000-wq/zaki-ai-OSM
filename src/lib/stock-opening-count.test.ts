import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * THE STOCK A STORE STARTED WITH, AND WHO COUNTED IT.
 *
 * A physical count already existed — the «الجرد» door on `/api/inventory`
 * takes a counted quantity and a written reason and enters any surplus at the
 * cost of the stock already there. That is not rebuilt, and units still land
 * in `ProductionBatch` through `receiveStock`, which is the only place units
 * live.
 *
 * What is added is who counted, and the fact that ONE count is the one the
 * business started from. And a rule borrowed from the recount door's own
 * reasoning: a zero unit cost is refused unless somebody writes down why.
 */

vi.mock('./receiving', () => ({
  receiveStock: vi.fn(async (_tx: unknown, input: Record<string, unknown>) => ({
    batch: { id: `b-${input.productId}`, batchNumber: `RCV-${input.productId}` },
    movement: {},
    balanceAfter: input.quantity,
  })),
}));

import { OpeningStockRefused, recordOpeningStockCount } from './stock-opening-count';
import { receiveStock } from './receiving';
import { ALL_CATALOG_KEYS } from './permission-catalog';
import { repoFile, stripComments } from './guard-source';

function fakeTx(opts: { existing?: unknown; moved?: number; productIds?: string[] } = {}) {
  const created: Record<string, unknown>[] = [];
  const updated: Record<string, unknown>[] = [];
  return {
    tx: {
      // 19/11 (W2a): the count takes its lines' stock locks, then asks «is this store placed in warehouses?» — never, here.
      $executeRaw: vi.fn(async () => 1),
      warehousePlacement: { findUnique: vi.fn(async () => null) },
      stockOpeningCount: {
        findUnique: vi.fn(async () => opts.existing ?? null),
        create: vi.fn(async (a: { data: Record<string, unknown> }) => {
          created.push(a.data);
          return { id: 'count-1', ...a.data };
        }),
      },
      inventoryMovement: { count: vi.fn(async () => opts.moved ?? 0) },
      product: {
        findMany: vi.fn(async (a: { where: { id: { in: string[] } } }) => {
          const allowed = opts.productIds ?? a.where.id.in;
          return a.where.id.in.filter((id) => allowed.includes(id)).map((id) => ({ id, name: `منتج ${id}` }));
        }),
      },
      productionBatch: {
        update: vi.fn(async (a: Record<string, unknown>) => {
          updated.push(a);
          return {};
        }),
      },
    } as never,
    created,
    updated,
  };
}

const base = {
  companyId: 'co1',
  storeId: 'st1',
  countedByName: 'أبو محمّد',
  countedAt: new Date('2026-10-01T06:00:00Z'),
  recordedById: 'u1',
  now: new Date('2026-10-01T09:00:00Z'),
  lines: [{ productId: 'p1', countedQty: 40, unitCost: 2.5 }],
};

beforeEach(() => vi.clearAllMocks());

describe('a signed opening stock count', () => {
  it('puts the units where units live, through the one intake', async () => {
    const { tx, created, updated } = fakeTx();
    const out = await recordOpeningStockCount(tx, base);

    expect(created[0]).toMatchObject({ storeId: 'st1', countedByName: 'أبو محمّد', recordedById: 'u1' });
    // Not a second stock table: the same receiveStock every other intake uses.
    expect(receiveStock).toHaveBeenCalledTimes(1);
    expect((receiveStock as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1]).toMatchObject({
      storeId: 'st1',
      productId: 'p1',
      quantity: 40,
      unitCost: 2.5,
    });
    // And the batch points back, so the count's lines are its batches.
    expect(updated[0]).toMatchObject({ where: { id: 'b-p1' }, data: { openingCountId: 'count-1' } });
    expect(out.placed).toEqual([{ productId: 'p1', qty: 40, batchNumber: 'RCV-p1' }]);
  });

  it('keeps the counter and the recorder apart', async () => {
    const { tx, created } = fakeTx();
    await recordOpeningStockCount(tx, base);
    expect(created[0].countedByName).toBe('أبو محمّد');
    expect(created[0].recordedById).toBe('u1');
    expect(created[0].countedByName).not.toBe(created[0].recordedById);
  });

  /**
   * A COUNTED ZERO IS A FACT, AND IT OPENS NO BATCH.
   *
   * «We counted this product and there were none» is worth recording, but a
   * zero-quantity batch would sit in every FIFO draw-down for ever for nothing.
   */
  it('records a counted zero without opening an empty batch', async () => {
    const { tx, updated } = fakeTx({ productIds: ['p1', 'p2'] });
    const out = await recordOpeningStockCount(tx, {
      ...base,
      lines: [
        { productId: 'p1', countedQty: 40, unitCost: 2.5 },
        { productId: 'p2', countedQty: 0, unitCost: 3 },
      ],
    });
    expect(receiveStock).toHaveBeenCalledTimes(1);
    expect(updated).toHaveLength(1);
    expect(out.placed).toEqual([
      { productId: 'p1', qty: 40, batchNumber: 'RCV-p1' },
      { productId: 'p2', qty: 0, batchNumber: null },
    ]);
  });

  it('carries the counter’s name onto every batch it opens', async () => {
    const { tx } = fakeTx();
    await recordOpeningStockCount(tx, base);
    const note = (receiveStock as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1] as { note: string };
    expect(note.note).toContain('أبو محمّد');
    expect(note.note).toContain('العدّ الافتتاحيّ');
  });

  it('allows a zero cost when somebody writes down why', async () => {
    const { tx } = fakeTx();
    await recordOpeningStockCount(tx, {
      ...base,
      lines: [{ productId: 'p1', countedQty: 5, unitCost: 0, zeroCostReason: 'عيّنات مجانية من المورّد' }],
    });
    expect(receiveStock).toHaveBeenCalledTimes(1);
  });
});

describe('and it is refused', () => {
  const refuse = async (opts: Parameters<typeof fakeTx>[0], input: Partial<typeof base> = {}) => {
    const { tx, created, updated } = fakeTx(opts);
    const e = await recordOpeningStockCount(tx, { ...base, ...input }).then(
      () => null,
      (x: unknown) => x as OpeningStockRefused
    );
    return { e, created, updated };
  };

  it('a second time, naming who counted the first time', async () => {
    const { e } = await refuse({
      existing: { countedByName: 'سامر', countedAt: new Date('2026-09-30T05:00:00Z') },
    });
    expect(e).toBeInstanceOf(OpeningStockRefused);
    expect(e!.code).toBe('ALREADY_COUNTED');
    expect(e!.message).toContain('سامر');
  });

  /**
   * AFTER THE FIRST MOVEMENT IT IS A STOCKTAKE, NOT AN OPENING BALANCE.
   *
   * And the recount door already does stocktakes, against on-hand, with a
   * written reason. Pointing there beats building a second one.
   */
  it('once stock has moved, and it names the door to use instead', async () => {
    const { e } = await refuse({ moved: 7 });
    expect(e!.code).toBe('STOCK_HAS_MOVED');
    expect(e!.message).toContain('7');
    expect(e!.message, 'لا يقول إلى أين يذهب').toContain('الجرد');
  });

  it('without a counter', async () => {
    const { e } = await refuse({}, { countedByName: 'أ' });
    expect(e!.code).toBe('NO_COUNTER');
  });

  it('with a count time in the future', async () => {
    const { e } = await refuse({}, { countedAt: new Date('2026-10-03T00:00:00Z') });
    expect(e!.code).toBe('COUNT_IN_FUTURE');
  });

  it('with no lines at all', async () => {
    const { e } = await refuse({}, { lines: [] });
    expect(e!.code).toBe('NO_LINES');
  });

  it('with one product counted twice', async () => {
    const { e } = await refuse({}, {
      lines: [
        { productId: 'p1', countedQty: 4, unitCost: 1 },
        { productId: 'p1', countedQty: 9, unitCost: 1 },
      ],
    });
    expect(e!.code).toBe('DUPLICATE_PRODUCT');
  });

  it('with a fractional or negative quantity', async () => {
    expect((await refuse({}, { lines: [{ productId: 'p1', countedQty: 2.5, unitCost: 1 }] })).e!.code).toBe('QUANTITY_INVALID');
    expect((await refuse({}, { lines: [{ productId: 'p1', countedQty: -1, unitCost: 1 }] })).e!.code).toBe('QUANTITY_INVALID');
  });

  /**
   * THE ONE THAT PROTECTS THE PROFIT REPORT.
   *
   * Cost is read at the moment a unit sells, so a zero-cost batch reports pure
   * profit for ever and no later edit reaches it. The recount door refuses to
   * do this silently; so does this.
   */
  it('with a zero unit cost nobody explained', async () => {
    const { e, created } = await refuse({}, { lines: [{ productId: 'p1', countedQty: 5, unitCost: 0 }] });
    expect(e!.code).toBe('ZERO_COST_UNEXPLAINED');
    expect(e!.message).toContain('ربحاً صافياً');
    expect(created, 'كُتب عدٌّ مرفوض').toEqual([]);
  });

  it('with a product that belongs to another store', async () => {
    const { e } = await refuse({ productIds: [] });
    expect(e!.code).toBe('PRODUCT_NOT_IN_STORE');
  });

  it('and nothing is written on any refusal', async () => {
    const { created, updated } = await refuse({ moved: 3 });
    expect(created).toEqual([]);
    expect(updated).toEqual([]);
    expect(receiveStock, 'أُدخلت بضاعةٌ رغم الرفض').not.toHaveBeenCalled();
  });
});

describe('the door', () => {
  /** The permission that already governs putting stock in. No new key. */
  it('is the receiving door’s own permission', () => {
    const route = stripComments(repoFile('src/app/api/inventory/opening-count/route.ts'));
    expect(route).toContain("requirePermission('inventory.adjust')");
    expect(route).toContain("requirePermission('inventory.view')");
    const keys = [...ALL_CATALOG_KEYS].filter((k) => k.startsWith('inventory.'));
    // 20/11 (W3a): old ['inventory.adjust', 'inventory.view']; new + the three keys of the stock transfer (send, receive, approve a
    // shortfall), granted by no migration. The opening count still asks only the two above (pinned by the lines before).
    expect(keys.sort(), 'مفتاح صلاحية جديد يحتاج منحاً').toEqual(['inventory.adjust', 'inventory.difference_approve', 'inventory.transfer', 'inventory.transfer_receive', 'inventory.view']);
  });

  it('runs every rule inside the transaction that writes', () => {
    const route = stripComments(repoFile('src/app/api/inventory/opening-count/route.ts'));
    expect(route).toMatch(/db\.\$transaction\(\(tx\) =>\s*recordOpeningStockCount\(tx, \{/);
    expect(route).toContain('OpeningStockRefused');
    expect(route, 'الرفض يعود 500 بدل 409').toMatch(/'STOCK_HAS_MOVED' \? 409/);
  });

  /**
   * THE STORE COMES FROM THE SESSION, NEVER THE BODY.
   *
   * A body that names its own store is a body that can count stock onto
   * somebody else's shelf.
   */
  it('takes the store from the session and not from the request', () => {
    const route = stripComments(repoFile('src/app/api/inventory/opening-count/route.ts'));
    expect(route).toContain('await requireContext()');
    // The schema block itself, not a window that runs past it into the
    // handler — where `storeId` legitimately appears, read from the session.
    const schema = route.slice(route.indexOf('const bodySchema'), route.indexOf('export async function'));
    expect(schema, 'المتجر يُقرأ من الجسم').not.toContain('storeId');
  });

  it('and the screen offers it only while it is still possible', () => {
    const banner = stripComments(repoFile('src/components/inventory/OpeningStockCount.tsx'));
    expect(banner).toContain('state.countable');
    expect(banner, 'لا يقول من عدَّ').toContain('عدَّه');
    // A blank is not a counted zero, and the screen says so before submitting.
    expect(banner).toContain('المتروكُ فارغاً ليس صفراً');
  });

  /** The stock's own intake still owns the stock. */
  it('places what it creates in a store, so the ledger can see it', () => {
    const receiving = stripComments(repoFile('src/lib/receiving.ts'));
    expect(receiving).toMatch(/storeId: input\.storeId \?\? null/);
    // Both writes: the batch and the movement.
    expect((receiving.match(/storeId: input\.storeId \?\? null/g) ?? []).length).toBe(2);
    const door = stripComments(repoFile('src/app/api/inventory/route.ts'));
    expect((door.match(/receiveStock\(tx, \{\s*companyId,\s*storeId,/g) ?? []).length).toBe(2);
  });
});
