import { describe, expect, it, vi } from 'vitest';
import { AGES, NO_COURIER, RETURN_STATUSES, ageWhere, noBarcodeWhere, viewScope, type Age } from './returns-filters';
import { NO_COURIER_AR, returnsFacts } from './returns-list';

/**
 * THE NUMBERS BESIDE THE OPTIONS, AGAINST A DATABASE THAT REALLY ANSWERS THEM.
 *
 * A fake that records what it was asked can only say «the scope was in the question». This one holds parcels and
 * evaluates the `where` it is handed, so the claims are about ANSWERS: that each number is the number of rows its
 * choice brings, that the two views add up, that nothing of another company or store is in any of them, and that no
 * filter narrows another filter's numbers.
 */

const NOW = new Date('2026-10-21T12:00:00.000Z');
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

type Any = Record<string, any>;

function matches(where: Any, row: Any): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'AND') return (cond as Any[]).every((w) => matches(w, row));
    if (key === 'OR') return (cond as Any[]).some((w) => matches(w, row));
    const value = row[key];
    if (cond === null) return value === null;
    if (typeof cond !== 'object' || cond instanceof Date) return value === cond;
    return Object.entries(cond as Any).every(([op, arg]) => {
      if (op === 'in') return (arg as unknown[]).includes(value);
      if (op === 'isNot') return arg === null ? value !== null : value !== arg;
      if (!(value instanceof Date)) return false;
      const a = value.getTime();
      const b = (arg as Date).getTime();
      if (op === 'gt') return a > b;
      if (op === 'lte') return a <= b;
      throw new Error(`the evaluator does not know «${op}»`);
    });
  });
}

interface Row {
  id: string;
  companyId: string;
  storeId: string;
  shippingStatus: string;
  /** The courier's barcode — null or blank is «no barcode». */
  trackingNumber: string | null;
  returnReceipt: { id: string } | null;
  deliveryProviderId: string | null;
  returnedAt: Date | null;
  failedAt: Date | null;
  deliveredAt: Date | null;
  updatedAt: Date;
}

let n = 0;
const row = (over: Partial<Row> = {}): Row => ({
  id: `o${++n}`,
  companyId: 'c1',
  storeId: 's1',
  shippingStatus: 'RETURNED',
  trackingNumber: `TRK-${n}`,
  returnReceipt: null,
  deliveryProviderId: 'p1',
  returnedAt: ago(1),
  failedAt: null,
  deliveredAt: null,
  updatedAt: ago(1),
  ...over,
});

const PROVIDERS = [
  { id: 'p1', companyId: 'c1', name: 'ناقل' },
  { id: 'p2', companyId: 'c1', name: 'أمان' },
  { id: 'p3', companyId: 'c1', name: 'بشائر' },
  { id: 'px', companyId: 'c2', name: 'شركة غيرنا' },
];

function dbOf(rows: Row[]) {
  const pick = (where: Any) => rows.filter((r) => matches(where ?? {}, r as unknown as Any));
  const counts: Any[] = [];
  const findProviders = vi.fn(async ({ where }: { where: Any }) => PROVIDERS.filter((p) => matches(where, p as Any)).map(({ id, name }) => ({ id, name })));
  return {
    counts,
    findProviders,
    db: {
      order: {
        count: async ({ where }: { where: Any }) => {
          counts.push(where);
          return pick(where).length;
        },
        groupBy: async ({ by, where }: { by: (keyof Row)[]; where: Any }) => {
          const groups = new Map<unknown, number>();
          for (const r of pick(where)) groups.set(r[by[0]], (groups.get(r[by[0]]) ?? 0) + 1);
          return [...groups].map(([value, count]) => ({ [by[0]]: value, _count: { _all: count } }));
        },
      },
      deliveryProvider: { findMany: findProviders },
    } as unknown as Parameters<typeof returnsFacts>[0],
  };
}

const scope = { companyId: 'c1', storeId: 's1' };
const facts = (rows: Row[], view: 'pending' | 'received' = 'pending') => {
  const { db } = dbOf(rows);
  return returnsFacts(db, { scope, view, now: NOW });
};

/** A shop with every kind of parcel in it. */
function shop(): Row[] {
  return [
    // Waiting, by courier and state.
    row({ shippingStatus: 'RETURNED', deliveryProviderId: 'p1', returnedAt: ago(1) }),
    row({ shippingStatus: 'RETURNED', deliveryProviderId: 'p1', returnedAt: ago(3) }),
    row({ shippingStatus: 'RETURNED', deliveryProviderId: 'p2', returnedAt: ago(9) }),
    row({ shippingStatus: 'FAILED_DELIVERY', deliveryProviderId: 'p1', returnedAt: null, failedAt: ago(5) }),
    row({ shippingStatus: 'PARTIALLY_DELIVERED', deliveryProviderId: 'p2', returnedAt: null, deliveredAt: ago(2) }),
    row({ shippingStatus: 'RETURN_REQUESTED', deliveryProviderId: null, returnedAt: null, updatedAt: ago(0) }),
    // Already counted in.
    row({ returnReceipt: { id: 'r1' }, deliveryProviderId: 'p1' }),
    row({ returnReceipt: { id: 'r2' }, deliveryProviderId: 'p3', shippingStatus: 'DELIVERED' }),
    // Not a return at all, another company's, another store's.
    row({ shippingStatus: 'SHIPPED' }),
    row({ shippingStatus: 'DELIVERED' }),
    row({ companyId: 'c2' }),
    row({ storeId: 's2' }),
  ];
}

describe('the views', () => {
  it('— each says how many it holds, whichever is open', async () => {
    for (const view of ['pending', 'received'] as const) {
      const f = await facts(shop(), view);
      expect(f.views).toEqual({ pending: 6, received: 2 });
    }
  });

  it('and they are the rows each view shows — the same question the list asks', async () => {
    const rows = shop();
    const f = await facts(rows);
    for (const v of ['pending', 'received'] as const) {
      expect(f.views[v]).toBe(rows.filter((r) => matches(viewScope(v, scope), r as unknown as Any)).length);
    }
  });

  it('and a parcel of another company or another store is in no number', async () => {
    const rows = [...shop(), ...Array.from({ length: 5 }, () => row({ companyId: 'c2' })), ...Array.from({ length: 5 }, () => row({ storeId: 's2' }))];
    expect((await facts(rows)).views).toEqual({ pending: 6, received: 2 });
  });
});

describe('the states', () => {
  it('— the pending parcels in each of the four, with a zero for a state nobody is in', async () => {
    const f = await facts(shop());
    expect(f.statuses).toEqual({ RETURN_REQUESTED: 1, RETURNED: 3, FAILED_DELIVERY: 1, PARTIALLY_DELIVERED: 1 });
    const none = await facts([row({ shippingStatus: 'RETURNED' })]);
    expect(none.statuses).toEqual({ RETURN_REQUESTED: 0, RETURNED: 1, FAILED_DELIVERY: 0, PARTIALLY_DELIVERED: 0 });
    expect(Object.keys(none.statuses)).toEqual([...RETURN_STATUSES]);
  });

  it('and they add up to the pending view, and a counted-in parcel is in none of them — whatever state it is in now', async () => {
    const f = await facts(shop());
    expect(Object.values(f.statuses).reduce((a, b) => a + b, 0)).toBe(f.views.pending);
  });

  it('and they are the same whichever view is open — the states are of the work', async () => {
    const pending = await facts(shop(), 'pending');
    const received = await facts(shop(), 'received');
    expect(received.statuses).toEqual(pending.statuses);
  });
});

describe('the couriers', () => {
  it('— of the OPEN view, biggest first, named, and «nobody» has a name of its own', async () => {
    const f = await facts(shop(), 'pending');
    expect(f.couriers).toEqual([
      { id: 'p1', name: 'ناقل', count: 3 },
      { id: 'p2', name: 'أمان', count: 2 },
      { id: NO_COURIER, name: NO_COURIER_AR, count: 1 },
    ]);
  });

  it('and the record has its own: the companies that carried what was counted in — equal counts by name', async () => {
    const f = await facts(shop(), 'received');
    expect(f.couriers.map((c) => [c.id, c.name, c.count])).toEqual([
      ['p3', 'بشائر', 1],
      ['p1', 'ناقل', 1],
    ]);
  });

  it('and equal counts keep a stable order — by name — whichever order the database returns the groups in', async () => {
    const mk = (id: string) => row({ deliveryProviderId: id });
    for (const rows of [[mk('p3'), mk('p2')], [mk('p2'), mk('p3')]]) {
      expect((await facts(rows)).couriers.map((c) => c.name)).toEqual(['أمان', 'بشائر']);
    }
  });

  it('and the names are looked up for THIS company only, and not at all when no parcel has a company', async () => {
    const { db, findProviders } = dbOf(shop());
    await returnsFacts(db, { scope, view: 'pending', now: NOW });
    expect(findProviders.mock.calls[0][0].where).toMatchObject({ companyId: 'c1', id: { in: expect.arrayContaining(['p1', 'p2']) } });
    const { db: db2, findProviders: lookups } = dbOf([row({ deliveryProviderId: null })]);
    await returnsFacts(db2, { scope, view: 'pending', now: NOW });
    expect(lookups).not.toHaveBeenCalled();
  });

  it('and a company that is no longer on the list is a dash, not a missing row', async () => {
    const f = await facts([row({ deliveryProviderId: 'gone' })]);
    expect(f.couriers).toEqual([{ id: 'gone', name: '—', count: 1 }]);
  });
});

describe('the ages', () => {
  it('— each pile counts the pending parcels that are that old, and the piles add up to the pending view', async () => {
    const f = await facts(shop());
    // Returned 1, 3 and 9 days ago; failed 5 days ago; part-delivered 2 days ago; requested today (last write).
    expect(f.ages).toEqual({ fresh: 2, few: 2, week: 1, old: 1 });
    expect(Object.values(f.ages).reduce((a, b) => a + b, 0)).toBe(f.views.pending);
  });

  it('and with nothing else chosen, every pile’s number is exactly the rows its choice brings', async () => {
    const rows = shop();
    const f = await facts(rows);
    for (const age of AGES) {
      const brought = rows.filter((r) => matches({ ...viewScope('pending', scope), AND: [ageWhere(age, NOW)] }, r as unknown as Any)).length;
      expect(f.ages[age as Age], age).toBe(brought);
    }
  });

  it('and a parcel counted in is in no pile', async () => {
    const rows = [row({ returnReceipt: { id: 'r' }, returnedAt: ago(20) })];
    expect((await facts(rows)).ages).toEqual({ fresh: 0, few: 0, week: 0, old: 0 });
  });
});

describe('the scope is in every question', () => {
  it('— every count is asked of this company and this store, spread at the top, with the view’s own clauses', async () => {
    const { db, counts } = dbOf(shop());
    await returnsFacts(db, { scope, view: 'pending', now: NOW });
    // the two views, the four ages, and «بلا باركود» — seven questions, each with the scope in it
    expect(counts.length).toBe(2 + AGES.length + 1);
    for (const where of counts) expect(where).toMatchObject({ companyId: 'c1', storeId: 's1' });
  });

  it('and the ages keep the pending scope at the TOP — an age clause beside it, never in its place', async () => {
    const { db, counts } = dbOf(shop());
    await returnsFacts(db, { scope, view: 'pending', now: NOW });
    // «بلا باركود» also carries an AND beside the scope; it is told apart by what it asks, not by its shape
    const aged = counts.filter((w) => w.AND && !(w.AND as Any[]).includes(noBarcodeWhere));
    expect(aged).toHaveLength(AGES.length);
    for (const where of aged) {
      expect(where.shippingStatus).toEqual({ in: [...RETURN_STATUSES] });
      expect(where.returnReceipt).toBeNull();
    }
  });
});

describe('the parcels with no barcode', () => {
  /** A shop in which the barcode is missing in all three ways a database can miss it — and present in two. */
  const mixed = (): Row[] => [
    // waiting
    row({ shippingStatus: 'RETURNED', trackingNumber: 'B1' }),
    row({ shippingStatus: 'RETURNED', trackingNumber: null }),
    row({ shippingStatus: 'RETURNED', trackingNumber: '' }),
    row({ shippingStatus: 'FAILED_DELIVERY', trackingNumber: null, returnedAt: null, failedAt: ago(5) }),
    // counted in
    row({ returnReceipt: { id: 'r1' }, trackingNumber: 'B2' }),
    row({ returnReceipt: { id: 'r2' }, trackingNumber: null }),
    row({ returnReceipt: { id: 'r3' }, trackingNumber: '' }),
    // not ours, and not a return
    row({ companyId: 'c2', trackingNumber: null }),
    row({ storeId: 's2', trackingNumber: null }),
    row({ shippingStatus: 'SHIPPED', trackingNumber: null }),
  ];

  it('— counted inside the view that is open: the waiting ones when it is waiting, the counted ones when it is counted', async () => {
    expect((await facts(mixed(), 'pending')).noBarcode).toBe(3);
    expect((await facts(mixed(), 'received')).noBarcode).toBe(2);
  });

  it('and a blank barcode is no barcode, the same as none at all', async () => {
    const only = [row({ trackingNumber: '' }), row({ trackingNumber: null }), row({ trackingNumber: 'B' })];
    expect((await facts(only, 'pending')).noBarcode).toBe(2);
  });

  it('and it is exactly the rows the list brings when «بلا باركود» is chosen over the open view', async () => {
    const rows = mixed();
    for (const view of ['pending', 'received'] as const) {
      const asked = rows.filter((r) => matches({ ...viewScope(view, scope), AND: [noBarcodeWhere] }, r as unknown as Any)).length;
      expect((await facts(rows, view)).noBarcode).toBe(asked);
    }
  });

  it('and a parcel of another company or another store, or one that is not a return, is in no number', async () => {
    const base = (await facts(mixed(), 'pending')).noBarcode;
    const more = [...mixed(), ...Array.from({ length: 4 }, () => row({ companyId: 'c2', trackingNumber: null })), ...Array.from({ length: 4 }, () => row({ storeId: 's2', trackingNumber: '' }))];
    expect((await facts(more, 'pending')).noBarcode).toBe(base);
  });

  it('and the other dropdowns do not narrow it — like the companies, it counts the open view as a whole', async () => {
    const rows = [row({ deliveryProviderId: 'p1', trackingNumber: null }), row({ deliveryProviderId: 'p2', trackingNumber: null }), row({ deliveryProviderId: null, trackingNumber: null })];
    expect((await facts(rows, 'pending')).noBarcode).toBe(3);
  });

  it('and with every parcel carrying one the number is zero, not missing', async () => {
    expect((await facts([row({ trackingNumber: 'A' }), row({ trackingNumber: 'B' })], 'pending')).noBarcode).toBe(0);
  });
});
