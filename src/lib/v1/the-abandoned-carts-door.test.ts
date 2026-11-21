import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

/**
 * «السلات المهجورة» AT THE LANDING DOOR (contract oms-lp.v1 §9), answering — with the REAL key check, the REAL
 * idempotency ledger and the real upsert, over an in-memory database. `the-systems-door.test.ts` sweeps the two routes for
 * the key, the claim and the tenant; this file holds what they decide.
 */

type Row = Record<string, any>;

const h = vi.hoisted(() => {
  const state = {
    tokens: new Map<string, Row>(),
    idem: new Map<string, Row>(),
    carts: [] as Row[],
    activities: [] as Row[],
    aliases: [] as Row[],
    orders: [] as Row[],
    products: [] as Row[],
    seq: 0,
  };
  return { state, logAudit: vi.fn() };
});

vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => h.logAudit(...a) }));
// A cart with a name now becomes an order by itself (the owner, 17/11). That step is held by
// `a-cart-with-a-name-becomes-an-order.test.ts`; here it makes nothing, so this file keeps holding the cart door alone.
vi.mock('@/lib/abandoned-cart-orders', () => ({ autoOrderForCart: async () => ({ kind: 'NONE' }) }));
// A cart whose customer already has an order closes itself (21/11) — held by
// `a-cart-whose-customer-ordered-closes-itself.test.ts`; here nobody has one.
vi.mock('@/lib/cart-has-order', () => ({ closeCartIfOrdered: async () => null }));

vi.mock('@/lib/db', () => {
  const s = h.state;
  const dup = () => new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });
  const byWhere = (where: Row) =>
    where.companyId_externalId
      ? s.carts.find((c) => c.companyId === where.companyId_externalId.companyId && c.externalId === where.companyId_externalId.externalId)
      : s.carts.find((c) => c.id === where.id);
  const pick = (row: Row | undefined, select?: Row) => {
    if (!row) return null;
    if (!select) return { ...row };
    return Object.fromEntries(Object.keys(select).map((k) => [k, row[k]]));
  };
  const apply = (row: Row, data: Row) => {
    for (const [k, v] of Object.entries(data)) {
      if (k === 'activities') {
        s.activities.push({ id: `a${++s.seq}`, cartId: row.id, ...(v as Row).create });
      } else if (v && typeof v === 'object' && 'increment' in (v as Row)) {
        row[k] = (row[k] ?? 0) + (v as Row).increment;
      } else {
        row[k] = v;
      }
    }
    row.updatedAt = new Date();
  };
  const db = {
    systemToken: {
      findUnique: vi.fn(async ({ where }: Row) => s.tokens.get(where.tokenHash) ?? null),
      update: vi.fn(async () => ({})),
    },
    idempotencyRecord: {
      create: vi.fn(async ({ data }: Row) => {
        const k = `${data.companyId}:${data.key}`;
        if (s.idem.has(k)) throw dup();
        s.idem.set(k, { ...data });
        return data;
      }),
      findUnique: vi.fn(async ({ where }: Row) => s.idem.get(`${where.companyId_key.companyId}:${where.companyId_key.key}`) ?? null),
      update: vi.fn(async ({ where, data }: Row) => {
        const row = s.idem.get(`${where.companyId_key.companyId}:${where.companyId_key.key}`)!;
        Object.assign(row, data);
        return row;
      }),
      deleteMany: vi.fn(async ({ where }: Row) => {
        const k = `${where.companyId}:${where.key}`;
        if (s.idem.get(k)?.status === 0) s.idem.delete(k);
        return { count: 1 };
      }),
    },
    product: {
      findFirst: vi.fn(async ({ where }: Row) => {
        const p = s.products.find((x) => x.id === where.id && x.companyId === where.companyId);
        return p ? { id: p.id, name: p.name, store: { country: { code: p.country } } } : null;
      }),
    },
    country: { findFirst: vi.fn(async ({ where }: Row) => (where.code === 'JO' ? { id: 'jo' } : null)) },
    region: { findMany: vi.fn(async () => [{ id: 'amm', name: 'عمّان' }, { id: 'irb', name: 'إربد' }]) },
    order: {
      findFirst: vi.fn(async ({ where }: Row) => {
        const o = s.orders.find((x) => x.companyId === where.companyId && (where.orderNumber ? x.orderNumber === where.orderNumber : x.id === where.id));
        return o ? { id: o.id } : null;
      }),
    },
    abandonedCart: {
      findUnique: vi.fn(async ({ where, select }: Row) => pick(byWhere(where), select)),
      create: vi.fn(async ({ data, select }: Row) => {
        if (s.carts.some((c) => c.companyId === data.companyId && c.externalId === data.externalId)) throw dup();
        const row: Row = { id: `cart${++s.seq}`, attempts: 0, assignedToId: null, orderId: null, nextFollowUpAt: null, createdAt: new Date() };
        apply(row, data);
        s.carts.push(row);
        return pick(row, select);
      }),
      update: vi.fn(async ({ where, data, select }: Row) => {
        const row = byWhere(where);
        if (!row) throw new Error('no row');
        apply(row, data);
        return pick(row, select);
      }),
      // The second visit's lookup: same company, product and phone keys, an open status, seen since the window opened.
      findFirst: vi.fn(async ({ where, select }: Row) => {
        const hits = s.carts
          .filter(
            (c) =>
              c.companyId === where.companyId &&
              c.productId === where.productId &&
              where.phoneNormalized.in.includes(c.phoneNormalized) &&
              where.status.in.includes(c.status) &&
              c.lastSeenAt >= where.lastSeenAt.gte
          )
          .sort((a, b) => +b.lastSeenAt - +a.lastSeenAt);
        return pick(hits[0], select);
      }),
    },
    abandonedCartAlias: {
      findUnique: vi.fn(async ({ where }: Row) => {
        const a = s.aliases.find((x) => x.companyId === where.companyId_externalId.companyId && x.externalId === where.companyId_externalId.externalId);
        if (!a) return null;
        const c = s.carts.find((x) => x.id === a.cartId)!;
        return { cart: { id: c.id, lastSeenAt: c.lastSeenAt } };
      }),
      create: vi.fn(async ({ data }: Row) => {
        if (s.aliases.some((x) => x.companyId === data.companyId && x.externalId === data.externalId)) throw dup();
        s.aliases.push({ ...data });
        return data;
      }),
    },
    abandonedCartActivity: {
      create: vi.fn(async ({ data }: Row) => {
        s.activities.push({ id: `a${++s.seq}`, ...data });
        return data;
      }),
    },
  };
  return { db, default: db };
});

import { hashToken } from './system-token';
import { POST as putCart } from '@/app/api/v1/landing/abandoned-carts/route';
import { POST as recovered } from '@/app/api/v1/landing/abandoned-carts/[externalId]/recovered/route';

const KEY_A = 'zk1_company_a_landing_key';
const KEY_B = 'zk1_company_b_landing_key';
const REPLIES_ONLY_READ = 'zk1_products_read_only_key';

const CART = {
  externalId: 'lead-1',
  landingPageId: 'lp1',
  landingPageName: 'رمانة',
  landingPageUrl: 'https://pages.zakiai.io/lp/rummana',
  productId: 'p1',
  productName: 'دبس رمان',
  customerName: 'محمد',
  phone: '962791234567',
  city: 'عمّان',
  country: 'JO',
  firstSeenAt: '2026-11-15T10:00:00.000Z',
  lastSeenAt: '2026-11-15T10:04:00.000Z',
};

let keyNo = 0;
const send = (body: unknown, opts: { token?: string | null; key?: string | null } = {}) => {
  const headers: Record<string, string> = {};
  const token = opts.token === undefined ? KEY_A : opts.token;
  if (token) headers.authorization = `Bearer ${token}`;
  const key = opts.key === undefined ? `k${++keyNo}` : opts.key;
  if (key) headers['idempotency-key'] = key;
  return putCart(
    new Request('https://oms.test/api/v1/landing/abandoned-carts', { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) })
  );
};
const recover = (externalId: string, body: unknown, opts: { token?: string; key?: string | null } = {}) => {
  const headers: Record<string, string> = { authorization: `Bearer ${opts.token ?? KEY_A}` };
  const key = opts.key === undefined ? `r${++keyNo}` : opts.key;
  if (key) headers['idempotency-key'] = key;
  return recovered(
    new Request(`https://oms.test/api/v1/landing/abandoned-carts/${encodeURIComponent(externalId)}/recovered`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ externalId }) }
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  const s = h.state;
  s.idem.clear();
  s.carts.length = 0;
  s.activities.length = 0;
  s.aliases.length = 0;
  s.orders.length = 0;
  s.products.length = 0;
  s.tokens.clear();
  const token = (id: string, companyId: string, scopes: string[]) => ({
    id,
    companyId,
    system: 'landing',
    scopes: JSON.stringify(scopes),
    rateLimitPerMin: 600,
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: new Date(),
  });
  s.tokens.set(hashToken(KEY_A), token('ta', 'cA', ['products.read', 'orders.create']));
  s.tokens.set(hashToken(KEY_B), token('tb', 'cB', ['products.read', 'orders.create']));
  s.tokens.set(hashToken(REPLIES_ONLY_READ), token('tr', 'cA', ['products.read']));
  s.products.push({ id: 'p1', companyId: 'cA', name: 'دبس رمان', country: 'JO' });
  s.orders.push({ id: 'ord7', companyId: 'cA', orderNumber: 'JO-2026-0007' });
});

describe('the key comes first, and it is the landing key that already exists', () => {
  it('no key, or a key that matches nothing → 401 in the machine envelope; nothing is written', async () => {
    const none = await send(CART, { token: null });
    expect(none.status).toBe(401);
    expect(((await none.json()) as { error: { code: string } }).error.code).toBe('TOKEN_MISSING');
    const wrong = await send(CART, { token: 'zk1_nobody' });
    expect(wrong.status).toBe(401);
    expect(((await wrong.json()) as { error: { code: string } }).error.code).toBe('TOKEN_INVALID');
    expect(h.state.carts).toHaveLength(0);
  });

  it('a key without orders.create is refused (403 SCOPE_MISSING); the landing key with it needs no new scope', async () => {
    expect((await send(CART, { token: REPLIES_ONLY_READ })).status).toBe(403);
    expect((await send(CART)).status).toBe(201);
  });
});

describe('POST /abandoned-carts — create or update one cart', () => {
  it('without Idempotency-Key → 400 { error: { code: IDEMPOTENCY_KEY_REQUIRED } }', async () => {
    const res = await send(CART, { key: null });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(h.state.carts).toHaveLength(0);
  });

  it('a new cart → 201 { id, status: NEW }, linked to the company’s product and the matched region', async () => {
    const res = await send(CART);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; status: string };
    expect(body).toEqual({ id: expect.any(String), status: 'NEW' });
    const row = h.state.carts[0];
    expect(row).toMatchObject({
      companyId: 'cA',
      externalId: 'lead-1',
      source: 'LANDING_PAGE',
      productId: 'p1',
      phone: '962791234567',
      phoneNormalized: '791234567',
      regionId: 'amm',
      country: 'JO',
      status: 'NEW',
    });
    expect(h.state.activities.map((a) => a.action)).toEqual(['RECEIVED']);
  });

  it('the same externalId again (a new key) → 200 and still ONE cart, with the new data', async () => {
    const first = (await (await send(CART)).json()) as { id: string };
    const again = await send({ ...CART, customerName: 'محمد علي', phone: '0791234567', lastSeenAt: '2026-11-15T10:20:00.000Z' });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ id: first.id, status: 'NEW' });
    expect(h.state.carts).toHaveLength(1);
    expect(h.state.carts[0]).toMatchObject({ customerName: 'محمد علي', phone: '0791234567', phoneNormalized: '791234567' });
  });

  it('another company with the same externalId → a separate cart (the company is the key’s, never the body’s)', async () => {
    await send(CART);
    const other = await send({ ...CART, companyId: 'cA' }, { token: KEY_B });
    expect(other.status).toBe(201);
    expect(h.state.carts.map((c) => c.companyId).sort()).toEqual(['cA', 'cB']);
    // Company B does not sell p1: the cart is kept, with no product link and the page's product name.
    const b = h.state.carts.find((c) => c.companyId === 'cB')!;
    expect(b.productId).toBeNull();
    expect(b.productName).toBe('دبس رمان');
  });

  it('a cart the team already worked (CONTACTED) is updated and KEEPS its status, its attempts and its assignee', async () => {
    await send(CART);
    Object.assign(h.state.carts[0], { status: 'CONTACTED', attempts: 2, assignedToId: 'u1' });
    const res = await send({ ...CART, city: 'إربد' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('CONTACTED');
    expect(h.state.carts[0]).toMatchObject({ status: 'CONTACTED', attempts: 2, assignedToId: 'u1', city: 'إربد', regionId: 'irb' });
  });

  it('the same Idempotency-Key again → the same answer, and nothing written twice', async () => {
    const first = await send(CART, { key: 'cart:lead-1:1' });
    const firstBody = await first.json();
    const writes = h.state.activities.length;
    const replay = await send(CART, { key: 'cart:lead-1:1' });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstBody);
    expect(h.state.activities.length).toBe(writes);
    expect(h.state.carts).toHaveLength(1);
  });

  it('empty or null name, city and product are taken; an unknown product keeps the cart', async () => {
    const res = await send({ ...CART, customerName: '', city: null, productId: null, productName: 'منتج', country: '' });
    expect(res.status).toBe(201);
    expect(h.state.carts[0]).toMatchObject({ customerName: null, city: null, productId: null, productName: 'منتج', country: null });
    const unknown = await send({ ...CART, externalId: 'lead-2', productId: 'not-ours' });
    expect(unknown.status).toBe(201);
    expect(h.state.carts[1].productId).toBeNull();
  });

  it('no externalId or no phone → 400 { error: "<Arabic>" }, the visitor-readable shape, and the key is not held', async () => {
    for (const body of [{ ...CART, externalId: '' }, { ...CART, phone: '  ' }, { ...CART, phone: undefined }]) {
      const res = await send(body, { key: 'k-bad' });
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: unknown };
      expect(typeof json.error).toBe('string');
      expect(json.error).toMatch(/[؀-ۿ]/);
    }
    expect(h.state.carts).toHaveLength(0);
    expect(h.state.idem.size).toBe(0);
    // A refusal keeps no key: the corrected cart under the same key is a new request.
    expect((await send(CART, { key: 'k-bad' })).status).toBe(201);
  });

  it('a body that is not JSON → 400 with a sentence', async () => {
    const res = await send('{not json', {});
    expect(res.status).toBe(400);
    expect(typeof ((await res.json()) as { error: unknown }).error).toBe('string');
  });
});

describe('POST /abandoned-carts/:externalId/recovered — the customer ordered by himself', () => {
  it('→ RECOVERED and linked to the order when the number is this company’s', async () => {
    await send(CART);
    const res = await recover('lead-1', { orderNumber: 'JO-2026-0007' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: h.state.carts[0].id, status: 'RECOVERED' });
    expect(h.state.carts[0]).toMatchObject({ status: 'RECOVERED', orderId: 'ord7' });
    expect(h.logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'ABANDONED_CART_RECOVERED', userId: null }));
  });

  it('with orderNumber null (the order is still queued) → RECOVERED, no link', async () => {
    await send(CART);
    expect((await recover('lead-1', { orderNumber: null })).status).toBe(200);
    expect(h.state.carts[0]).toMatchObject({ status: 'RECOVERED', orderId: null });
  });

  it('a repeat → 200 with no change (another key, same answer)', async () => {
    await send(CART);
    await recover('lead-1', { orderNumber: 'JO-2026-0007' });
    const lines = h.state.activities.length;
    const again = await recover('lead-1', { orderNumber: 'JO-2026-0007' });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { status: string }).status).toBe('RECOVERED');
    expect(h.state.activities.length).toBe(lines);
  });

  it('a cart this company does not have → 404 { error: { code: NOT_FOUND } } — even if another company has it', async () => {
    await send(CART, { token: KEY_B });
    const res = await recover('lead-1', { orderNumber: null });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
    // …and the key was given back.
    expect(h.state.idem.size).toBe(1);
  });

  it('needs Idempotency-Key too', async () => {
    await send(CART);
    const res = await recover('lead-1', { orderNumber: null }, { key: null });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('a cart the TEAM already converted keeps CONVERTED; the page’s order goes into its history', async () => {
    await send(CART);
    Object.assign(h.state.carts[0], { status: 'CONVERTED', orderId: 'ordTeam' });
    const res = await recover('lead-1', { orderNumber: 'JO-2026-0007' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('CONVERTED');
    expect(h.state.carts[0]).toMatchObject({ status: 'CONVERTED', orderId: 'ordTeam' });
    expect(h.state.activities.at(-1)).toMatchObject({ action: 'RECOVERED', toStatus: 'CONVERTED' });
  });
});

describe('one cart per customer per product, not one per visit (the owner, 21/11)', () => {
  // The owner's screenshot: the same phone and product, two visits five minutes apart, each its own externalId.
  const FIRST = { ...CART, externalId: 'visit-1', customerName: 'عادل شهاب', phone: '0791234567', lastSeenAt: '2026-11-21T08:05:00.000Z', firstSeenAt: '2026-11-21T08:00:00.000Z' };
  const SECOND = { ...CART, externalId: 'visit-2', customerName: 'عادل شهاي', phone: '0791234567', city: 'إربد', lastSeenAt: '2026-11-21T08:10:00.000Z', firstSeenAt: '2026-11-21T08:09:00.000Z' };

  it('a second visit → 200 with the FIRST cart’s id; still one row, its data updated, its first moment kept, the visit remembered', async () => {
    const first = (await (await send(FIRST)).json()) as { id: string };
    const res = await send(SECOND);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: first.id, status: 'NEW' });
    expect(h.state.carts).toHaveLength(1);
    expect(h.state.carts[0]).toMatchObject({
      externalId: 'visit-1',
      customerName: 'عادل شهاي',
      city: 'إربد',
      regionId: 'irb',
      firstSeenAt: new Date('2026-11-21T08:00:00.000Z'),
      lastSeenAt: new Date('2026-11-21T08:10:00.000Z'),
    });
    expect(h.state.aliases).toEqual([{ companyId: 'cA', externalId: 'visit-2', cartId: first.id }]);
    expect(h.state.activities.at(-1)).toMatchObject({ action: 'UPDATED', metadata: JSON.stringify({ alias: 'visit-2' }) });
  });

  it('an empty field in the second visit never wipes what the first one brought', async () => {
    await send(FIRST);
    await send({ ...SECOND, customerName: '', city: null });
    expect(h.state.carts[0]).toMatchObject({ customerName: 'عادل شهاب', city: 'عمّان', regionId: 'amm' });
  });

  it('a re-send under the second visit’s id → the same cart again, no second alias; the same key replays', async () => {
    const first = (await (await send(FIRST)).json()) as { id: string };
    await send(SECOND);
    const again = await send({ ...SECOND, customerName: 'عادل شهاب', lastSeenAt: '2026-11-21T08:30:00.000Z' });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ id: first.id, status: 'NEW' });
    expect(h.state.carts).toHaveLength(1);
    expect(h.state.aliases).toHaveLength(1);
    expect(h.state.carts[0]).toMatchObject({ customerName: 'عادل شهاب', firstSeenAt: new Date('2026-11-21T08:00:00.000Z') });
    const writes = h.state.activities.length;
    const a = await (await send(SECOND, { key: 'cart:visit-2:9' })).json();
    expect(await (await send(SECOND, { key: 'cart:visit-2:9' })).json()).toEqual(a);
    expect(h.state.activities.length).toBe(writes + 1);
  });

  it('/recovered under the second visit’s id finds the same cart', async () => {
    const first = (await (await send(FIRST)).json()) as { id: string };
    await send(SECOND);
    const res = await recover('visit-2', { orderNumber: 'JO-2026-0007' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: first.id, status: 'RECOVERED' });
    expect(h.state.carts[0]).toMatchObject({ status: 'RECOVERED', orderId: 'ord7' });
  });

  it('a cart the team worked keeps its status when a second visit folds into it', async () => {
    await send(FIRST);
    Object.assign(h.state.carts[0], { status: 'CALLBACK', attempts: 1, assignedToId: 'u1' });
    const res = await send(SECOND);
    expect(((await res.json()) as { status: string }).status).toBe('CALLBACK');
    expect(h.state.carts).toHaveLength(1);
    expect(h.state.carts[0]).toMatchObject({ status: 'CALLBACK', attempts: 1, assignedToId: 'u1' });
  });

  it('NEGATIVE: another product → two carts', async () => {
    h.state.products.push({ id: 'p2', companyId: 'cA', name: 'زيت', country: 'JO' });
    await send(FIRST);
    expect((await send({ ...SECOND, productId: 'p2' })).status).toBe(201);
    expect(h.state.carts).toHaveLength(2);
    expect(h.state.aliases).toHaveLength(0);
  });

  it('NEGATIVE: another phone → two carts', async () => {
    await send(FIRST);
    expect((await send({ ...SECOND, phone: '0795555555' })).status).toBe(201);
    expect(h.state.carts).toHaveLength(2);
  });

  it('NEGATIVE: a product unknown here is never merged (two unknowns are not known to be the same)', async () => {
    await send({ ...FIRST, productId: 'not-ours' });
    expect((await send({ ...SECOND, productId: 'not-ours' })).status).toBe(201);
    expect(h.state.carts).toHaveLength(2);
  });

  it('NEGATIVE: another company → its own cart', async () => {
    h.state.products.push({ id: 'p1', companyId: 'cB', name: 'دبس رمان', country: 'JO' });
    await send(FIRST);
    expect((await send(SECOND, { token: KEY_B })).status).toBe(201);
    expect(h.state.carts.map((c) => c.companyId).sort()).toEqual(['cA', 'cB']);
  });

  it('NEGATIVE: a closed cart (an order, «غير مهتم», «رقم غير صالح») → a new cart', async () => {
    for (const status of ['CONVERTED', 'RECOVERED', 'NOT_INTERESTED', 'INVALID']) {
      h.state.carts.length = 0;
      h.state.aliases.length = 0;
      await send(FIRST);
      h.state.carts[0].status = status;
      expect((await send(SECOND)).status, status).toBe(201);
      expect(h.state.carts, status).toHaveLength(2);
      expect(h.state.carts[0].status, status).toBe(status);
    }
  });

  it('NEGATIVE: the first visit seen more than a day before → a new cart', async () => {
    await send(FIRST);
    expect((await send({ ...SECOND, lastSeenAt: '2026-11-22T08:06:00.000Z' })).status).toBe(201);
    expect(h.state.carts).toHaveLength(2);
  });
});
