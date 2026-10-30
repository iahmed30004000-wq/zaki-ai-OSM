import { describe, expect, it, vi } from 'vitest';
import { DELIVERED_SHIPPING } from './order-state';
import { deliveredUnitsByProduct } from './product-sold';

/**
 * «SOLD» HAS ONE SOURCE (RV87): the lines of orders that reached the door as delivered — never the batch counter.
 * What is held here is the arithmetic, the scope of the question, and that it is units and nothing else.
 */

function client(settled: unknown[], unsettled: unknown[]) {
  const groupBy = vi.fn(async (args: { where: { deliveredQty: unknown } }) => (args.where.deliveredQty === null ? unsettled : settled));
  return { groupBy, orderItem: { groupBy } } as never as { groupBy: typeof groupBy; orderItem: { groupBy: typeof groupBy } };
}

const ask = (c: ReturnType<typeof client>, over: Record<string, unknown> = {}) =>
  deliveredUnitsByProduct(c as never, { companyId: 'c1', storeId: 's1', productIds: ['p1', 'p2'], ...over });

describe('the arithmetic', () => {
  it('— what the door settled, plus quantity and gift on the lines it did not', async () => {
    const c = client(
      [{ productId: 'p1', _sum: { deliveredQty: 20 } }],
      [{ productId: 'p1', _sum: { quantity: 30, freeQuantity: 10 } }, { productId: 'p2', _sum: { quantity: 7, freeQuantity: 0 } }]
    );
    expect([...(await ask(c))]).toEqual([['p1', 60], ['p2', 7]]);
  });

  it('— a missing sum is nothing, not NaN, and one missing figure does not eat the other', async () => {
    const c = client([{ productId: 'p1', _sum: {} }], [{ productId: 'p1', _sum: { quantity: 3, freeQuantity: null } }, { productId: 'p2', _sum: { quantity: null, freeQuantity: 2 } }]);
    expect([...(await ask(c))]).toEqual([['p1', 3], ['p2', 2]]);
  });

  it('— a product nobody received is absent, so the caller reads it as 0', async () => {
    const c = client([], []);
    const out = await ask(c);
    expect(out.size).toBe(0);
    expect(out.get('p1') ?? 0).toBe(0);
  });
});

describe('what is asked of the database', () => {
  it('— two counts, one row per product, about these products on delivered orders of this company and store', async () => {
    const c = client([], []);
    await ask(c);
    expect(c.groupBy).toHaveBeenCalledTimes(2);
    for (const [args] of c.groupBy.mock.calls as unknown as Array<[any]>) {
      expect(args.by).toEqual(['productId']);
      expect(args.where.companyId).toBe('c1');
      expect(args.where.productId).toEqual({ in: ['p1', 'p2'] });
      expect(args.where.order).toEqual({ companyId: 'c1', storeId: 's1', shippingStatus: { in: [...DELIVERED_SHIPPING] } });
    }
  });

  it('— with no store the question is the company’s', async () => {
    const c = client([], []);
    await ask(c, { storeId: null });
    for (const [args] of c.groupBy.mock.calls as unknown as Array<[any]>) {
      expect(args.where.order).toEqual({ companyId: 'c1', shippingStatus: { in: [...DELIVERED_SHIPPING] } });
    }
  });

  it('— NEGATIVE: no products, no question at all', async () => {
    const c = client([{ productId: 'x', _sum: { deliveredQty: 9 } }], []);
    const out = await ask(c, { productIds: [] });
    expect(out.size).toBe(0);
    expect(c.groupBy).not.toHaveBeenCalled();
  });

  it('— and only units are summed: no price, no total, no cost', async () => {
    const c = client([], []);
    await ask(c);
    const sums = (c.groupBy.mock.calls as unknown as Array<[any]>).flatMap(([a]) => Object.keys(a._sum)).sort();
    expect(sums).toEqual(['deliveredQty', 'freeQuantity', 'quantity']);
  });
});
