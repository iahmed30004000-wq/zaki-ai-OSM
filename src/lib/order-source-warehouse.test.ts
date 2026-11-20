import { describe, expect, it, vi } from 'vitest';
import { sourceWarehouseNames, withSourceWarehouseName, type WarehouseNameReader } from './order-source-warehouse';

/**
 * «طلع من مخزن كذا» (W4d) — THE NAME, ONE OPTIONAL FIELD, AND NOTHING AT ALL FOR AN ORDER WITH NO SOURCE WAREHOUSE.
 *
 *   • no id → no read (an unplaced store's page costs the database nothing new);
 *   • the read names the company, so another company's warehouse id finds no name;
 *   • the row loses the id it was read for, and gains the name only when there is one.
 */

const W1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const W2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

/** A fake that answers the question it is asked: the company and the ids are enforced, not just recorded. */
function fakeReader() {
  const table = [
    { id: W1, companyId: 'c1', name: 'المخزن الشمالي' },
    { id: W2, companyId: 'c1', name: 'المخزن الجنوبي' },
    { id: OTHER, companyId: 'c2', name: 'مخزن شركة تانية' },
  ];
  const findMany = vi.fn(async (args: { where: { companyId: string; id: { in: string[] } } }) =>
    table.filter((w) => w.companyId === args.where.companyId && args.where.id.in.includes(w.id)).map(({ id, name }) => ({ id, name })),
  );
  return { reader: { warehouse: { findMany } } as WarehouseNameReader, findMany };
}

describe('sourceWarehouseNames', () => {
  it('— no id, no read: an empty page, a page of nulls and a page of undefineds ask the database nothing', async () => {
    const { reader, findMany } = fakeReader();
    for (const ids of [[], [null], [null, undefined, ''], [undefined]]) {
      expect((await sourceWarehouseNames(reader, 'c1', ids)).size).toBe(0);
    }
    expect(findMany).not.toHaveBeenCalled();
  });

  it('and one read for the whole page, each id once, naming the company', async () => {
    const { reader, findMany } = fakeReader();
    const names = await sourceWarehouseNames(reader, 'c1', [W1, null, W2, W1, W1]);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0]).toEqual({ where: { companyId: 'c1', id: { in: [W1, W2] } }, select: { id: true, name: true } });
    expect([...names.entries()]).toEqual([
      [W1, 'المخزن الشمالي'],
      [W2, 'المخزن الجنوبي'],
    ]);
  });

  it('NEGATIVE: another company’s warehouse finds no name', async () => {
    const { reader } = fakeReader();
    const names = await sourceWarehouseNames(reader, 'c1', [OTHER]);
    expect(names.has(OTHER)).toBe(false);
  });
});

describe('withSourceWarehouseName', () => {
  const names = new Map([[W1, 'المخزن الشمالي']]);

  it('— a row with a source warehouse leaves with the name and without the id', () => {
    expect(withSourceWarehouseName({ id: 'o1', sourceWarehouseId: W1 }, names)).toEqual({ id: 'o1', sourceWarehouseName: 'المخزن الشمالي' });
  });

  it('NEGATIVE: a row with none leaves exactly as it would have — no name key, no id key', () => {
    for (const row of [{ id: 'o1', sourceWarehouseId: null }, { id: 'o1', sourceWarehouseId: undefined }, { id: 'o1' }]) {
      const out = withSourceWarehouseName(row, names);
      expect(out).toEqual({ id: 'o1' });
      expect(Object.keys(out)).toEqual(['id']);
    }
  });

  it('NEGATIVE: an id whose name was not found (another company’s, a deleted row) adds nothing', () => {
    const out = withSourceWarehouseName({ id: 'o1', sourceWarehouseId: OTHER }, names);
    expect(Object.keys(out)).toEqual(['id']);
  });
});
