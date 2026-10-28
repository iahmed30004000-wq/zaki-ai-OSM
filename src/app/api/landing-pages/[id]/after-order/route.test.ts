import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «بقلي انو الخدمة غير مفعلة لما اجي اعملها من صفحة الهبوط» — WHAT THE EDITOR IS TOLD, AND BY WHOM.
 *
 * The landing editor's «بعد الطلب» line used to decide «شغّال» by itself (`postOrderOffer && isActive !== false`,
 * and an offer has no `isActive`), so a stopped bundle read «شغّال» while the thank-you screen showed nothing. This
 * door answers for ONE page with the order door's own function, and the claims here are that it is that function:
 *
 *   · the offer is `postOrderOfferFor`'s, the same id and the same charged price — measured by calling the real
 *     function over the same rows, not by restating it;
 *   · the figures are rounded by the PAGE'S store (a Jordanian one, three places), not by anything else in reach;
 *   · when the door answers null, the first flagged row in the door's own order says why;
 *   · a page outside this company and store is a 404, and not one offer is read for it;
 *   · both permissions are asked, and `canManage` is the person's `offers.manage`.
 *
 * The rows below are queried by a small evaluator of the `where` each query sends, so the predicate the code really
 * passes is what decides — a fake that handed every query the same list would agree with any predicate at all.
 */

type Row = {
  id: string;
  companyId: string;
  productId: string;
  name: string;
  quantity: number;
  freeQuantity: number;
  sellingPrice: number;
  discount: number;
  compareAtPrice: number | null;
  isDefault: boolean;
  deliveryIncluded: boolean;
  endsAt: Date | null;
  postOrderOffer: boolean;
  status: string;
  sortOrder: number;
};

const { db, store, denied, grants, context } = vi.hoisted(() => {
  const store: { offers: Row[]; page: Record<string, unknown> | null } = { offers: [], page: null };

  /** One `where` against one row. An operator this does not know throws, so an unread predicate cannot pass. */
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([key, want]) => {
      if (key === 'OR') return (want as Record<string, unknown>[]).some((w) => matches(row, w));
      if (want === null) return row[key] === null;
      if (typeof want === 'object' && !(want instanceof Date)) {
        const ops = want as Record<string, unknown>;
        return Object.entries(ops).every(([op, value]) => {
          if (op === 'gt') return row[key] instanceof Date && (row[key] as Date) > (value as Date);
          throw new Error(`fake db: unknown operator ${op}`);
        });
      }
      return row[key] === want;
    });

  const findMany = vi.fn(
    async (args: {
      where: Record<string, unknown>;
      orderBy?: Record<string, 'asc' | 'desc'>[];
      take?: number;
      select?: Record<string, boolean>;
    }) => {
      const order = args.orderBy ?? [];
      const found = store.offers
        .filter((o) => matches(o, args.where))
        .sort((a, b) => {
          for (const step of order) {
            const [field, dir] = Object.entries(step)[0] as [keyof Row, 'asc' | 'desc'];
            const x = a[field] as number;
            const y = b[field] as number;
            if (x !== y) return dir === 'asc' ? x - y : y - x;
          }
          return 0;
        })
        .slice(0, args.take ?? Infinity);
      const pick = args.select;
      return pick
        ? found.map((o) => Object.fromEntries(Object.keys(pick).map((k) => [k, (o as Record<string, unknown>)[k]])))
        : found;
    }
  );

  return {
    store,
    denied: new Set<string>(),
    grants: new Set<string>(),
    // The selection's own country rounds to two places — the page's store, to three. Only one of them may decide.
    context: { user: { id: 'u1' }, companyId: 'c1', storeId: 's1', country: { currencyCode: 'USD', minorUnit: 2 } },
    db: {
      landingPage: {
        findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
          const p = store.page;
          if (!p) return null;
          return p.id === where.id && p.companyId === where.companyId && p.storeId === where.storeId
            ? { product: p.product, store: p.store }
            : null;
        }),
      },
      offer: { findMany },
      // `evidencedWasPrices`: no delivered order has proved a «was» price, so none is shown.
      order: { groupBy: vi.fn(async () => []) },
    },
  };
});

vi.mock('@/lib/db', () => ({ db, default: db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: async () => context }));
vi.mock('@/lib/authorization', () => ({
  requirePermission: async (permission: string) => {
    if (denied.has(permission)) throw new Error(`Forbidden: missing required permission ${permission}`);
    return context.user;
  },
  can: (_user: unknown, permission: string) => grants.has(permission),
}));

import { GET } from './route';
import { postOrderOfferFor } from '@/lib/offers';

const DAY = 24 * 60 * 60 * 1000;

/** «كريم مرطّب للوجه», base 14, in a Jordanian store — the page's own store, three places. */
const PAGE = {
  id: 'lp1',
  companyId: 'c1',
  storeId: 's1',
  product: { id: 'p1', name: 'كريم مرطّب للوجه' },
  store: { country: { minorUnit: 3 } },
};

function offer(over: Partial<Row>): Row {
  return {
    id: 'o',
    companyId: 'c1',
    productId: 'p1',
    name: 'عرض',
    quantity: 1,
    freeQuantity: 0,
    sellingPrice: 14,
    discount: 0,
    compareAtPrice: null,
    isDefault: false,
    deliveryIncluded: true,
    endsAt: null,
    postOrderOffer: false,
    status: 'ACTIVE',
    sortOrder: 0,
    ...over,
  };
}

/** The page's ordinary bundles — never the after-order one, whatever their state. */
const PAGE_BUNDLES = [
  offer({ id: 'one', name: 'قطعة', sellingPrice: 14, isDefault: true }),
  offer({ id: 'two', name: 'قطعتين', quantity: 2, sellingPrice: 25, sortOrder: 1 }),
];

const ask = async () => {
  const res = await GET(new Request('http://localhost/api/landing-pages/lp1/after-order'), { params: Promise.resolve({ id: 'lp1' }) });
  return { status: res.status, body: await res.json() };
};

/** The offer reads that went past the page: the door's own and the flagged rows. */
const offerReads = () => db.offer.findMany.mock.calls.length;

beforeEach(() => {
  vi.clearAllMocks();
  denied.clear();
  grants.clear();
  context.storeId = 's1';
  context.companyId = 'c1';
  store.page = { ...PAGE };
  store.offers = [...PAGE_BUNDLES];
});

describe('ON — the offer is the order door’s, the same row at the same price', () => {
  it('a flagged, live bundle: the answer is postOrderOfferFor’s own view, rounded by the page’s store', async () => {
    // 14 with a reduction of 3.875: the customer is charged 10.125 at three places, 10.12 at two.
    store.offers.push(offer({ id: 'po', name: 'قطعة كمان', sellingPrice: 14, discount: 3.875, postOrderOffer: true, sortOrder: 2 }));
    const { status, body } = await ask();
    expect(status).toBe(200);

    const door = await postOrderOfferFor(db as never, 'c1', 'p1', 3);
    expect(body.offer).toEqual(JSON.parse(JSON.stringify(door)));
    expect(body.offer).toMatchObject({ id: 'po', name: 'قطعة كمان', quantity: 1, freeQuantity: 0, price: 10.125, listPrice: 14 });
    expect(body).toMatchObject({
      productId: 'p1',
      productName: 'كريم مرطّب للوجه',
      why: null,
      flagged: { id: 'po', name: 'قطعة كمان' },
      flaggedCount: 1,
      minorUnit: 3,
    });
  });

  it('NEGATIVE: the decimals are the page’s store’s — the selection’s two places would charge 10.12', async () => {
    store.offers.push(offer({ id: 'po', sellingPrice: 14, discount: 3.875, postOrderOffer: true }));
    const atTwo = await postOrderOfferFor(db as never, 'c1', 'p1', 2);
    expect(atTwo?.price).toBe(10.12);
    const { body } = await ask();
    expect(body.offer.price).toBe(10.125);
  });

  it('an ordinary bundle of the page is never the offer after the order, however live it is', async () => {
    const { body } = await ask();
    expect(body.offer).toBeNull();
    expect(body.why).toBe('NONE');
  });
});

describe('OFF — and the first flagged row, in the door’s order, says why', () => {
  it('NONE: nothing flagged — and no row to act on', async () => {
    const { body } = await ask();
    expect(body).toMatchObject({ offer: null, why: 'NONE', flagged: null, flaggedCount: 0, productName: 'كريم مرطّب للوجه' });
  });

  it('STOPPED: flagged and switched off — the row the panel’s old count read as «شغّال»', async () => {
    store.offers.push(offer({ id: 'po', name: 'قطعة كمان', sellingPrice: 10, postOrderOffer: true, status: 'INACTIVE' }));
    const { body } = await ask();
    expect(body).toMatchObject({ offer: null, why: 'STOPPED', flagged: { id: 'po', name: 'قطعة كمان' }, flaggedCount: 1 });
  });

  it('ENDED: flagged, ACTIVE, and its ending has passed', async () => {
    store.offers.push(offer({ id: 'po', name: 'قطعة كمان', sellingPrice: 10, postOrderOffer: true, endsAt: new Date(Date.now() - DAY) }));
    const { body } = await ask();
    expect(body).toMatchObject({ offer: null, why: 'ENDED', flagged: { id: 'po' }, flaggedCount: 1 });
  });

  it('NEGATIVE: an ending still ahead is not ENDED — it is on', async () => {
    store.offers.push(offer({ id: 'po', sellingPrice: 10, postOrderOffer: true, endsAt: new Date(Date.now() + DAY) }));
    const { body } = await ask();
    expect(body.why).toBeNull();
    expect(body.offer.id).toBe('po');
  });

  it('stopped AND finished reads STOPPED — the switch is the first thing to undo', async () => {
    store.offers.push(offer({ id: 'po', postOrderOffer: true, status: 'INACTIVE', endsAt: new Date(Date.now() - DAY) }));
    expect((await ask()).body.why).toBe('STOPPED');
  });

  it('two flagged rows: the first by sortOrder decides, then by quantity — and the count says two', async () => {
    const ended = offer({ id: 'ended', postOrderOffer: true, endsAt: new Date(Date.now() - DAY), sortOrder: 0 });
    const stopped = offer({ id: 'stopped', postOrderOffer: true, status: 'INACTIVE', sortOrder: 1 });
    store.offers.push(stopped, ended);
    expect((await ask()).body).toMatchObject({ why: 'ENDED', flagged: { id: 'ended' }, flaggedCount: 2 });

    store.offers = [...PAGE_BUNDLES, { ...stopped, sortOrder: 0, quantity: 2 }, { ...ended, sortOrder: 0, quantity: 1 }];
    expect((await ask()).body).toMatchObject({ why: 'ENDED', flagged: { id: 'ended' } });

    store.offers = [...PAGE_BUNDLES, { ...stopped, sortOrder: 0 }, { ...ended, sortOrder: 1 }];
    expect((await ask()).body).toMatchObject({ why: 'STOPPED', flagged: { id: 'stopped' } });
  });

  it('two flagged rows, the first stopped and the second live: on, with the second — as the door picks', async () => {
    store.offers.push(
      offer({ id: 'stopped', postOrderOffer: true, status: 'INACTIVE', sortOrder: 0 }),
      offer({ id: 'live', name: 'قطعتين كمان', quantity: 2, sellingPrice: 20, postOrderOffer: true, sortOrder: 1 })
    );
    const { body } = await ask();
    expect(body).toMatchObject({ why: null, flagged: { id: 'live' }, flaggedCount: 2 });
    expect(body.offer).toMatchObject({ id: 'live', quantity: 2, price: 20, listPrice: null });
  });

  it('NO_PRODUCT: a page with no product is an answer, and no offer is read', async () => {
    store.page = { ...PAGE, product: null };
    const { status, body } = await ask();
    expect(status).toBe(200);
    expect(body).toMatchObject({ productId: null, offer: null, why: 'NO_PRODUCT', flagged: null, flaggedCount: 0 });
    expect(offerReads()).toBe(0);
  });
});

describe('whose page, and who may ask', () => {
  it('the page is read as the page itself is read: its id, the company, the selected store', async () => {
    await ask();
    expect(db.landingPage.findFirst.mock.calls[0][0].where).toEqual({ id: 'lp1', companyId: 'c1', storeId: 's1' });
  });

  it('NEGATIVE: a page of another store is a 404, and not one of its offers is read', async () => {
    context.storeId = 's2';
    const { status, body } = await ask();
    expect(status).toBe(404);
    expect(body.error).toBe('صفحة الهبوط غير موجودة');
    expect(offerReads()).toBe(0);
  });

  it('NEGATIVE: a page of another company is a 404 too', async () => {
    context.companyId = 'c2';
    expect((await ask()).status).toBe(404);
    expect(offerReads()).toBe(0);
  });

  it.each(['landing_pages.view', 'offers.view'])('NEGATIVE: without %s it is refused, and nothing is read', async (permission) => {
    denied.add(permission);
    const { status } = await ask();
    expect(status).toBe(403);
    expect(db.landingPage.findFirst).not.toHaveBeenCalled();
    expect(offerReads()).toBe(0);
  });

  it('canManage is the person’s offers.manage — true with it, false without', async () => {
    expect((await ask()).body.canManage).toBe(false);
    grants.add('offers.manage');
    expect((await ask()).body.canManage).toBe(true);
  });
});
