import { describe, expect, it, vi } from 'vitest';

vi.mock('./db', () => ({ db: {} }));

import {
  TWIN_ACTION,
  TWIN_WINDOW_MS,
  findRecentTwins,
  flagRecentTwins,
  twinsFromMetadata,
} from './recent-twin-order';

/**
 * THE SAME CUSTOMER, THE SAME PRODUCT, TEN MINUTES — A FLAG, NEVER A REFUSAL.
 *
 * The fake below does not return what the test tells it to. It holds real-looking orders and answers the query's own
 * `where` the way the database would (equality, `not`, `notIn`, `gte`/`lte`, `in`, `OR`, `items.some`), so a window
 * that is widened, a refusal filter that is dropped or a product test that is loosened changes the ANSWER, which is
 * what a test of a detector has to be able to see.
 */

const AT = new Date('2026-10-29T12:00:00.000Z');
const minutesBefore = (m: number) => new Date(AT.getTime() - m * 60_000);

interface Row {
  id: string;
  orderNumber: string;
  companyId: string;
  customerId: string;
  productId: string;
  items: { productId: string }[];
  confirmationStatus: string;
  replacesOrderId: string | null;
  createdAt: Date;
}

const row = (over: Partial<Row> & Pick<Row, 'id'>): Row => ({
  orderNumber: `N-${over.id}`,
  companyId: 'co1',
  customerId: 'cu1',
  productId: 'p1',
  items: [{ productId: 'p1' }],
  confirmationStatus: 'NEW',
  replacesOrderId: null,
  createdAt: minutesBefore(3),
  ...over,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Where = any;

function matches(r: Row, where: Where): boolean {
  for (const [key, cond] of Object.entries(where as Record<string, unknown>)) {
    if (key === 'OR') {
      if (!(cond as Where[]).some((w) => matches(r, w))) return false;
      continue;
    }
    if (key === 'items') {
      const some = (cond as Where).some as Where;
      if (!r.items.some((i) => matches(i as unknown as Row, some))) return false;
      continue;
    }
    const value = (r as unknown as Record<string, unknown>)[key];
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as Where;
      if ('not' in c && value === c.not) return false;
      if ('in' in c && !c.in.includes(value)) return false;
      if ('notIn' in c && c.notIn.includes(value)) return false;
      if ('gte' in c && !((value as Date) >= c.gte)) return false;
      if ('lte' in c && !((value as Date) <= c.lte)) return false;
    } else if (value !== cond) return false;
  }
  return true;
}

function fakeClient(rows: Row[], opts: { failFind?: boolean; failWrite?: boolean } = {}) {
  const written: Where[] = [];
  const client = {
    order: {
      findMany: vi.fn(async ({ where, take }: { where: Where; take?: number }) => {
        if (opts.failFind) throw new Error('boom');
        return rows
          .filter((r) => matches(r, where))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, take ?? 1000)
          .map((r) => ({ id: r.id, orderNumber: r.orderNumber }));
      }),
    },
    orderActivity: {
      create: vi.fn(async ({ data }: { data: Where }) => {
        if (opts.failWrite) throw new Error('boom');
        written.push(data);
        return data;
      }),
    },
  };
  return { client: client as never, written, raw: client };
}

const Q = { companyId: 'co1', orderId: 'new', customerId: 'cu1', productIds: ['p1'], at: AT };

describe('what counts as a twin', () => {
  it('the same customer and the same product three minutes earlier', async () => {
    const { client } = fakeClient([row({ id: 'a' })]);
    expect(await findRecentTwins(client, Q)).toEqual([{ id: 'a', orderNumber: 'N-a' }]);
  });

  it('the product may be on any line, not only the head', async () => {
    const { client } = fakeClient([row({ id: 'a', productId: 'p9', items: [{ productId: 'p9' }, { productId: 'p1' }] })]);
    expect(await findRecentTwins(client, Q)).toHaveLength(1);
  });

  it('a basket whose second product repeats counts: the new order’s products are all asked', async () => {
    const { client } = fakeClient([row({ id: 'a', productId: 'p2', items: [{ productId: 'p2' }] })]);
    expect(await findRecentTwins(client, { ...Q, productIds: ['p1', 'p2'] })).toHaveLength(1);
  });

  it('eleven minutes earlier is not a twin, and ten is', async () => {
    const { client } = fakeClient([
      row({ id: 'old', createdAt: minutesBefore(11) }),
      row({ id: 'edge', createdAt: minutesBefore(TWIN_WINDOW_MS / 60_000) }),
    ]);
    expect((await findRecentTwins(client, Q)).map((t) => t.id)).toEqual(['edge']);
  });

  it('another product is not a twin', async () => {
    const { client } = fakeClient([row({ id: 'a', productId: 'p2', items: [{ productId: 'p2' }] })]);
    expect(await findRecentTwins(client, Q)).toEqual([]);
  });

  it('another customer is not a twin', async () => {
    const { client } = fakeClient([row({ id: 'a', customerId: 'cu2' })]);
    expect(await findRecentTwins(client, Q)).toEqual([]);
  });

  it('another company is not a twin', async () => {
    const { client } = fakeClient([row({ id: 'a', companyId: 'co2' })]);
    expect(await findRecentTwins(client, Q)).toEqual([]);
  });

  it('the order itself is never its own twin', async () => {
    const { client } = fakeClient([row({ id: 'new', createdAt: AT })]);
    expect(await findRecentTwins(client, Q)).toEqual([]);
  });

  it('an order that was refused or cancelled is not a twin: asking again after «لا» is how people buy', async () => {
    const { client } = fakeClient([
      row({ id: 'r', confirmationStatus: 'REJECTED' }),
      row({ id: 'c', confirmationStatus: 'CANCELLED' }),
    ]);
    expect(await findRecentTwins(client, Q)).toEqual([]);
  });

  it('a confirmed one still is: the customer may be ordering the same thing twice', async () => {
    const { client } = fakeClient([row({ id: 'k', confirmationStatus: 'CONFIRMED' })]);
    expect(await findRecentTwins(client, Q)).toHaveLength(1);
  });

  it('a replacement or a win-back is a repeat on purpose and is not a twin', async () => {
    const { client } = fakeClient([row({ id: 'rep', replacesOrderId: 'old-order' })]);
    expect(await findRecentTwins(client, Q)).toEqual([]);
  });

  it('an order written after the new one (a late retry) is not a twin', async () => {
    const { client } = fakeClient([row({ id: 'later', createdAt: new Date(AT.getTime() + 60_000) })]);
    expect(await findRecentTwins(client, Q)).toEqual([]);
  });

  it('no products means nothing to compare, and no query', async () => {
    const { client, raw } = fakeClient([row({ id: 'a' })]);
    expect(await findRecentTwins(client, { ...Q, productIds: [] })).toEqual([]);
    expect(raw.order.findMany).not.toHaveBeenCalled();
  });

  it('names at most five, newest first — a customer who rang fifty times needs a count, not a list', async () => {
    const many = Array.from({ length: 8 }, (_, i) => row({ id: `t${i}`, createdAt: minutesBefore(1 + i * 0.5) }));
    const { client } = fakeClient(many);
    const twins = await findRecentTwins(client, Q);
    expect(twins).toHaveLength(5);
    expect(twins[0].id).toBe('t0');
  });
});

describe('the flag', () => {
  it('is one history row on the NEW order, naming the twins', async () => {
    const { client, written } = fakeClient([row({ id: 'a' })]);
    const out = await flagRecentTwins(client, { ...Q, userId: 'u1' });
    expect(out).toHaveLength(1);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ companyId: 'co1', orderId: 'new', userId: 'u1', action: TWIN_ACTION });
    expect(twinsFromMetadata(written[0].metadata)).toEqual([{ id: 'a', orderNumber: 'N-a' }]);
    expect(JSON.parse(written[0].metadata).windowMinutes).toBe(10);
  });

  it('is nothing at all when there is no twin: no row, no noise', async () => {
    const { client, written } = fakeClient([row({ id: 'old', createdAt: minutesBefore(30) })]);
    expect(await flagRecentTwins(client, Q)).toEqual([]);
    expect(written).toEqual([]);
  });

  it('never throws when the search fails: the order is saved and the note is advice', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { client, written } = fakeClient([row({ id: 'a' })], { failFind: true });
    await expect(flagRecentTwins(client, Q)).resolves.toEqual([]);
    expect(written).toEqual([]);
    quiet.mockRestore();
  });

  it('never throws when the write fails either', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { client } = fakeClient([row({ id: 'a' })], { failWrite: true });
    await expect(flagRecentTwins(client, Q)).resolves.toEqual([]);
    quiet.mockRestore();
  });

  it('and what it logs when it fails is a name, never the customer', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { client } = fakeClient([row({ id: 'a' })], { failFind: true });
    await flagRecentTwins(client, { ...Q, userId: '0932323642' });
    const said = JSON.stringify(spy.mock.calls);
    expect(said).not.toContain('0932323642');
    spy.mockRestore();
  });

  it('writes nothing but the one history row: no order, no line, no stock, no money', async () => {
    const { raw } = fakeClient([row({ id: 'a' })]);
    await flagRecentTwins(raw as never, Q);
    expect(Object.keys(raw)).toEqual(['order', 'orderActivity']);
    expect(Object.keys(raw.order)).toEqual(['findMany']);
    expect(Object.keys(raw.orderActivity)).toEqual(['create']);
  });
});

describe('reading the flag back', () => {
  it('a well-formed row reads', () => {
    expect(twinsFromMetadata(JSON.stringify({ twins: [{ id: 'a', orderNumber: 'N-1', extra: 'x' }] }))).toEqual([
      { id: 'a', orderNumber: 'N-1' },
    ]);
  });

  it.each([null, undefined, '', 'not json', '{}', '{"twins":"x"}', '{"twins":[1,null,{"id":3}]}'])(
    'anything that is not a flag reads as none: %s',
    (m) => {
      expect(twinsFromMetadata(m as string | null | undefined)).toEqual([]);
    }
  );
});
