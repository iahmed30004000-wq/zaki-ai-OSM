import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «الزبون على الخط» — DEFINITION OF DONE, ASKED OF AN IN-MEMORY DATABASE THAT APPLIES THE FILTERS IT IS GIVEN.
 *
 * The verdict and the write's guard are both read by the database here (`tri`, SQL's three values), not by a mock told the
 * answer: an order is taken, refused or left because of what the filters say.
 *
 *   · a released retry (≥1 no-answer, nobody reached since the release) is taken: the pull's fields, IN_PROGRESS, history
 *     `CUSTOMER_CALLED_BACK`, and his other waiting orders held for her;
 *   · never rung → NEVER_CALLED; a colleague holds it → HELD_BY_COLLEAGUE with her name; shipped → CLOSED; another store or
 *     outside her envelope → NOT_FOUND; held for a colleague → RESERVED_FOR_COLLEAGUE; at the 300 → CAP_TOTAL;
 *   · two agents at once: one wins, the other is told who has it — with the customer lock, and with the write's own guard when
 *     the lock serialises nothing (the control);
 *   · the search: exact number only, ten at most, her store and her envelope, no customer field on a card.
 *
 * WHAT THIS CANNOT PROVE: that Postgres's advisory lock behaves as the mutex here does (the pull's own test says the same).
 * ═══════════════════════════════════════════════════════════════════════
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const { world } = vi.hoisted(() => ({
  world: {
    orders: [] as Row[],
    users: new Map<string, Row>(),
    customers: new Map<string, Row>(),
    attempts: [] as Row[],
    history: [] as Row[],
    statusLogs: [] as Row[],
    activities: [] as Row[],
    lockless: false,
  },
}));

type Tri = true | false | null;
const and = (xs: Tri[]): Tri => (xs.includes(false) ? false : xs.includes(null) ? null : true);
const or = (xs: Tri[]): Tri => (xs.includes(true) ? true : xs.includes(null) ? null : false);
const time = (v: unknown) => (v instanceof Date ? v.getTime() : (v as number));
function tri(row: Row, where: Row): Tri {
  return and(
    Object.entries(where).map(([key, cond]): Tri => {
      if (key === 'AND') return and((cond as Row[]).map((w) => tri(row, w)));
      if (key === 'OR') return or((cond as Row[]).map((w) => tri(row, w)));
      const value = row[key] ?? null;
      if (cond === null) return value === null;
      if (cond instanceof Date) return value === null ? null : time(value) === cond.getTime();
      if (typeof cond !== 'object') return value === null ? null : value === cond;
      return and(
        Object.entries(cond as Row).map(([op, arg]): Tri => {
          switch (op) {
            case 'not':
              if (arg === null) return value !== null;
              if (typeof arg === 'object') return value === null ? null : (tri({ v: value }, { v: arg }) === false);
              return value === null ? null : value !== arg;
            case 'in': return value === null ? null : (arg as unknown[]).includes(value);
            case 'gt': return value === null ? null : time(value) > time(arg);
            case 'gte': return value === null ? null : time(value) >= time(arg);
            case 'lte': return value === null ? null : time(value) <= time(arg);
            case 'is':
              if (arg === null) return value === null;
              return value === null ? null : tri(value as Row, arg as Row);
            case 'none': return !(value ?? []).some((c: Row) => tri(c, arg as Row) === true);
            case 'some': return (value ?? []).some((c: Row) => tri(c, arg as Row) === true);
            default:
              // A relation written as a plain object (`customer: { phone: … }`): asked of the related row.
              if (value && typeof value === 'object' && !(value instanceof Date)) return tri(value as Row, { [op]: arg });
              throw new Error(`the in-memory database does not know «${op}»`);
          }
        })
      );
    })
  );
}

/** An order as the database would join it. */
function view(o: Row): Row {
  return {
    ...o,
    contactAttempts: world.attempts.filter((a) => a.orderId === o.id),
    claimHistory: world.history.filter((h) => h.orderId === o.id),
    assignee: o.assignedToId ? world.users.get(o.assignedToId) ?? null : null,
    claimer: o.claimedById ? world.users.get(o.claimedById) ?? null : null,
    customer: o.customerId ? world.customers.get(o.customerId) ?? null : null,
    region: o.regionName ? { name: o.regionName } : null,
    items: o.items ?? [],
  };
}
const sortBy = (rows: Row[], orderBy?: Row | Row[]) => {
  const keys = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []).flatMap((x) => Object.entries(x));
  return [...rows].sort((a, b) => {
    for (const [k, dir] of keys) {
      const av = time(a[k]) ?? 0;
      const bv = time(b[k]) ?? 0;
      if (av !== bv) return (av < bv ? -1 : 1) * (dir === 'desc' ? -1 : 1);
    }
    return 0;
  });
};
/** Only the keys asked for — a read that forgets a column it uses fails here. */
function project(row: Row, select?: Row): Row {
  if (!select) return row;
  const out: Row = {};
  for (const [k, s] of Object.entries(select)) {
    if (s === true) out[k] = row[k] ?? null;
    else if (k === '_count') out[k] = Object.fromEntries(Object.keys(s.select).map((r) => [r, (row[r] ?? []).length]));
    else if (Array.isArray(row[k])) {
      let list = (row[k] as Row[]).filter((c) => !s.where || tri(c, s.where) === true);
      list = sortBy(list, s.orderBy);
      if (s.take) list = list.slice(0, s.take);
      out[k] = list.map((c) => project(c, s.select));
    } else out[k] = row[k] ? project(row[k], s.select) : null;
  }
  return out;
}

vi.mock('./db', () => {
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));
  const tails = new Map<string, Promise<void>>();
  type TxState = { releases: (() => void)[] } | null;
  const hits = (where: Row) => world.orders.filter((o) => tri(view(o), where ?? {}) === true);

  function client(tx: TxState) {
    return {
      order: {
        findMany: async ({ where, orderBy, take, select }: Row) => {
          await tick();
          const found = sortBy(hits(where), orderBy);
          return (take ? found.slice(0, take) : found).map((o) => project(view(o), select));
        },
        findFirst: async ({ where, orderBy, select }: Row) => {
          await tick();
          const found = sortBy(hits(where), orderBy)[0];
          return found ? project(view(found), select) : null;
        },
        count: async ({ where }: Row) => {
          await tick();
          return hits(where).length;
        },
        updateMany: async ({ where, data }: Row) => {
          await tick();
          const rows = hits(where);
          for (const o of rows) {
            for (const [k, v] of Object.entries(data)) o[k] = v && typeof v === 'object' && 'increment' in (v as Row) ? (o[k] ?? 0) + (v as Row).increment : v;
          }
          return { count: rows.length };
        },
      },
      orderClaimHistory: { create: async ({ data }: Row) => void world.history.push({ ...data, createdAt: data.createdAt ?? new Date() }) },
      orderStatusLog: { create: async ({ data }: Row) => void world.statusLogs.push(data) },
      orderActivity: { create: async ({ data }: Row) => void world.activities.push(data) },
      $executeRaw: async (_strings: TemplateStringsArray, key: string) => {
        if (world.lockless || !tx) return 0;
        const before = tails.get(key) ?? Promise.resolve();
        let release!: () => void;
        const mine = new Promise<void>((r) => (release = r));
        tails.set(key, before.then(() => mine));
        tx.releases.push(release);
        await before;
        return 0;
      },
    };
  }
  const root = client(null);
  return {
    db: {
      ...root,
      $transaction: async (fn: (c: unknown) => Promise<unknown>) => {
        const state = { releases: [] as (() => void)[] };
        try {
          return await fn(client(state));
        } finally {
          state.releases.forEach((r) => r());
        }
      },
    },
  };
});

const { takeOnTheLine, searchOnTheLine, callbackVerdict, CUSTOMER_CALLED_BACK_REASON, CALLBACK_SEARCH_LIMIT } = await import(
  './customer-on-the-line'
);
const { db } = await import('./db');
const rbac = await import('./rbac');

const NOW = new Date('2026-11-04T09:00:00Z');
const AGO = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const SCOPE = { companyId: 'c1', storeId: 's1' };
const SARA = { id: 'sara', role: 'CONFIRMATION_AGENT' };
const HIND = { id: 'hind', role: 'CONFIRMATION_AGENT' };

let seq = 0;
function order(over: Row = {}): Row {
  const o = {
    id: `o${++seq}`,
    orderNumber: `ORD-${seq}`,
    companyId: 'c1',
    storeId: 's1',
    customerId: 'cust1',
    claimedById: null,
    claimedAt: null,
    currentOwnerId: null,
    assignedToId: null,
    assignedAt: null,
    confirmationStatus: 'NO_ANSWER',
    status: 'NEW',
    shippingStatus: 'NOT_READY',
    shippingBatchId: null,
    trackingNumber: null,
    labelPrintedAt: null,
    signatureStatus: 'UNSIGNED',
    lockedById: null,
    lockExpiresAt: null,
    createdById: null,
    moderatorId: null,
    replacesOrderId: null,
    createdAt: AGO(30),
    regionName: 'دمشق',
    items: [{ productName: 'ساعة' }],
    version: 1,
    ...over,
  };
  world.orders.push(o);
  return o;
}
/** Rung by `who`, nobody answered, and let go back to the pool. */
function releasedRetry(over: Row = {}): Row {
  const o = order(over);
  world.history.push({ orderId: o.id, action: 'CLAIMED', userId: 'hind', createdAt: AGO(6) });
  world.attempts.push({ orderId: o.id, result: 'NO_ANSWER', createdAt: AGO(5) });
  world.history.push({ orderId: o.id, action: 'RELEASED', userId: 'hind', createdAt: AGO(2) });
  return o;
}
const take = (orderId: string, user = SARA, visibility: Row = {}) =>
  takeOnTheLine({ scope: SCOPE, user, orderId, visibility, now: NOW });

beforeEach(() => {
  seq = 0;
  world.orders = [];
  world.attempts = [];
  world.history = [];
  world.statusLogs = [];
  world.activities = [];
  world.lockless = false;
  world.users = new Map([
    ['sara', { id: 'sara', name: 'سارة', status: 'ACTIVE' }],
    ['hind', { id: 'hind', name: 'هند', status: 'ACTIVE' }],
  ]);
  world.customers = new Map([
    ['cust1', { id: 'cust1', phone: '966793918', fullName: 'زبون', address: 'شارع' }],
    ['cust2', { id: 'cust2', phone: '944000111', fullName: 'تاني', address: 'شارع' }],
  ]);
});

describe('a released retry is taken — the pull’s write, and its history says how', () => {
  it('claims it for her, IN_PROGRESS, with CUSTOMER_CALLED_BACK, and his waiting order follows her', async () => {
    const o = releasedRetry();
    const twin = order({ confirmationStatus: 'NEW' });
    const got = await take(o.id);
    expect(got).toEqual({ ok: true, orderId: o.id, orderNumber: o.orderNumber });
    expect(o).toMatchObject({ claimedById: 'sara', currentOwnerId: 'sara', claimedAt: NOW, confirmationStatus: 'IN_PROGRESS', status: 'IN_PROGRESS', version: 2 });
    const claim = world.history.filter((h) => h.orderId === o.id && h.action === 'CLAIMED').at(-1);
    expect(claim).toMatchObject({ userId: 'sara', reason: CUSTOMER_CALLED_BACK_REASON, companyId: 'c1' });
    expect(world.statusLogs).toEqual([expect.objectContaining({ orderId: o.id, previousValue: 'NO_ANSWER', newValue: 'IN_PROGRESS' })]);
    expect(twin).toMatchObject({ assignedToId: 'sara', assignedAt: NOW, claimedById: null });
    // No call is invented for her: the attempts are what they were.
    expect(world.attempts).toHaveLength(1);
  });

  it('works for an order she gave back by hand (NEW again) as for one a round let go', async () => {
    const o = releasedRetry({ confirmationStatus: 'NEW' });
    expect((await take(o.id)).ok).toBe(true);
  });

  it('and a no-answer that was BUSY or UNREACHABLE counts the same', async () => {
    const o = releasedRetry();
    world.attempts[0].result = 'UNREACHABLE';
    expect((await take(o.id)).ok).toBe(true);
  });
});

describe('what stays refused', () => {
  it('a brand-new order nobody rang — the pull’s, not the phone’s', async () => {
    const o = order({ confirmationStatus: 'NEW' });
    expect(await take(o.id)).toMatchObject({ ok: false, code: 'NEVER_CALLED' });
    expect(o.claimedById).toBeNull();
  });

  it('a released order that was only ever OPENED (a dialler, not a call) is never-called too', async () => {
    const o = order();
    world.attempts.push({ orderId: o.id, result: 'OPENED', createdAt: AGO(3) });
    expect(await take(o.id)).toMatchObject({ ok: false, code: 'NEVER_CALLED' });
  });

  it('a colleague’s — with her name, and nothing written', async () => {
    const o = releasedRetry({ claimedById: 'hind', claimedAt: AGO(1), confirmationStatus: 'IN_PROGRESS' });
    const got = await take(o.id);
    expect(got).toMatchObject({ ok: false, code: 'HELD_BY_COLLEAGUE', heldBy: 'هند' });
    expect(got.ok === false && got.message).toContain('هند');
    expect(o.claimedById).toBe('hind');
    expect(world.statusLogs).toHaveLength(0);
  });

  it('a shipped one, and a decided one', async () => {
    const shipped = releasedRetry({ shippingStatus: 'READY_TO_SHIP' });
    const labelled = releasedRetry({ labelPrintedAt: AGO(1) });
    const cancelled = releasedRetry({ confirmationStatus: 'CANCELLED' });
    for (const o of [shipped, labelled, cancelled]) {
      expect(await take(o.id)).toMatchObject({ ok: false, code: 'CLOSED' });
      expect(o.claimedById).toBeNull();
    }
  });

  it('another store’s order, and one outside her «عرض الطلبات» envelope that is no released retry — not found', async () => {
    const elsewhere = releasedRetry({ storeId: 's2' });
    expect(await take(elsewhere.id)).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    const fresh = order({ confirmationStatus: 'NEW' });
    expect(await take(fresh.id, SARA, { id: '__no_access__' })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    const hers = releasedRetry({ claimedById: 'hind', confirmationStatus: 'IN_PROGRESS' });
    expect(await take(hers.id, SARA, { id: '__no_access__' })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect([fresh.claimedById, hers.claimedById]).toEqual([null, 'hind']);
  });

  it('held for a colleague (a hold that stands) — her name, no take', async () => {
    // A hold is an order that has just arrived and was never claimed; a no-answer on it can only have been logged by somebody
    // the hold rule does not bind. Rare — and refused all the same.
    const o = order({ confirmationStatus: 'NEW', assignedToId: 'hind', assignedAt: AGO(1) });
    world.attempts.push({ orderId: o.id, result: 'NO_ANSWER', createdAt: AGO(1) });
    expect(await take(o.id)).toMatchObject({ ok: false, code: 'RESERVED_FOR_COLLEAGUE' });
    expect(o.claimedById).toBeNull();
  });

  it('somebody reached him after the release — not a retry any more', async () => {
    const o = releasedRetry();
    world.attempts.push({ orderId: o.id, result: 'ANSWERED', createdAt: AGO(1) });
    expect(await take(o.id)).toMatchObject({ ok: false, code: 'REACHED_SINCE_RELEASE' });
  });

  it('at the 300 — the cap’s own sentence', async () => {
    for (let i = 0; i < 300; i++) order({ customerId: null, claimedById: 'sara', confirmationStatus: 'IN_PROGRESS' });
    const o = releasedRetry();
    expect(await take(o.id)).toMatchObject({ ok: false, code: 'CAP_TOTAL' });
    expect(o.claimedById).toBeNull();
  });

  it('already hers — said as hers, nothing written twice', async () => {
    const o = releasedRetry({ claimedById: 'sara', confirmationStatus: 'IN_PROGRESS' });
    expect(await take(o.id)).toMatchObject({ ok: true, alreadyYours: true });
    expect(world.statusLogs).toHaveLength(0);
  });
});

describe('two agents on the same customer at once — one wins', () => {
  it('with the customer lock: the second waits, then is told who has it', async () => {
    const o = releasedRetry();
    const [a, b] = await Promise.all([take(o.id, SARA), take(o.id, HIND)]);
    const won = [a, b].filter((r) => r.ok);
    expect(won).toHaveLength(1);
    const lost = [a, b].find((r) => !r.ok)!;
    expect(lost).toMatchObject({ code: 'HELD_BY_COLLEAGUE' });
    expect(world.history.filter((h) => h.reason === CUSTOMER_CALLED_BACK_REASON)).toHaveLength(1);
  });

  it('CONTROL — the lock serialising nothing: the write’s own guard still lets only one through', async () => {
    world.lockless = true;
    const o = releasedRetry();
    const [a, b] = await Promise.all([take(o.id, SARA), take(o.id, HIND)]);
    expect([a, b].filter((r) => r.ok)).toHaveLength(1);
    expect(world.history.filter((h) => h.reason === CUSTOMER_CALLED_BACK_REASON)).toHaveLength(1);
  });
});

describe('the search', () => {
  const search = (phone: string, visibility: Row = {}) =>
    searchOnTheLine(db as never, { scope: SCOPE, userId: 'sara', phone, countryCode: 'SY', visibility, now: NOW });

  it('finds his orders by any spelling of the whole number, and says which she may take and why not', async () => {
    const retry = releasedRetry();
    const fresh = order({ confirmationStatus: 'NEW' });
    const hers = releasedRetry({ claimedById: 'hind', confirmationStatus: 'IN_PROGRESS' });
    for (const typed of ['0966793918', '+963 966 793 918', '٠٩٦٦٧٩٣٩١٨']) {
      const cards = (await search(typed))!;
      const by = Object.fromEntries(cards.map((c) => [c.id, c]));
      expect(by[retry.id]).toMatchObject({ takeable: true, holder: 'بالطابور', governorate: 'دمشق', product: 'ساعة' });
      expect(by[fresh.id]).toMatchObject({ takeable: false, code: 'NEVER_CALLED' });
      expect(by[hers.id]).toMatchObject({ takeable: false, code: 'HELD_BY_COLLEAGUE', holder: 'هند' });
    }
  });

  it('carries no name, phone or address — the keys of a card are these and no others', async () => {
    releasedRetry();
    const [card] = (await search('0966793918'))!;
    expect(Object.keys(card).sort()).toEqual(['code', 'governorate', 'holder', 'id', 'message', 'orderNumber', 'product', 'status', 'takeable']);
    expect(JSON.stringify(card)).not.toMatch(/966793918|زبون|شارع/);
  });

  it('is exact: a prefix finds nothing, a short number is not searched at all', async () => {
    releasedRetry();
    expect(await search('09667')).toBeNull();
    expect(await search('09667939')).toEqual([]);
  });

  it(`is ${CALLBACK_SEARCH_LIMIT} at most, her store only, and inside her envelope`, async () => {
    for (let i = 0; i < 14; i++) releasedRetry();
    releasedRetry({ storeId: 's2' });
    releasedRetry({ customerId: 'cust2' });
    const cards = (await search('0966793918'))!;
    expect(cards).toHaveLength(CALLBACK_SEARCH_LIMIT);
    expect(cards.every((c) => world.orders.find((o) => o.id === c.id)!.storeId === 's1')).toBe(true);
    // Outside her envelope she still reads the released retries — exactly what she may take — and nothing else.
    order({ confirmationStatus: 'NEW' });
    const outside = (await search('0966793918', { id: '__no_access__' }))!;
    expect(outside.length).toBeGreaterThan(0);
    expect(outside.every((c) => c.takeable)).toBe(true);
  });
});

describe('the live agent’s envelope (orders.view at ASSIGNED), through the REAL orderVisibilityWhere — review of #197', () => {
  const { orderVisibilityWhere } = rbac;
  const ASSIGNED_SARA = {
    id: 'sara', email: 's@x.test', name: 'سارة', role: 'CONFIRMATION_AGENT', status: 'ACTIVE', companyId: 'c1',
    permissions: ['orders.view', 'confirmation.work', 'confirmation.pull'],
    effectiveGrants: {
      fullAccess: false,
      grants: {
        'orders.view': { scope: 'ASSIGNED', scopeIds: null },
        'confirmation.work': { scope: 'ALL_COMPANY', scopeIds: null },
        'confirmation.pull': { scope: 'ALL_COMPANY', scopeIds: null },
      },
    },
  } as never;
  const envelope = () => orderVisibilityWhere(ASSIGNED_SARA) as Row;
  const roundReleased = () => releasedRetry({ confirmationStatus: 'IN_PROGRESS' });

  it('a round-released order left IN_PROGRESS — outside the ASSIGNED envelope by itself — is found and taken', async () => {
    const o = roundReleased();
    expect(tri(view(o), envelope()), 'the envelope alone does not admit it — the case the review found').not.toBe(true);
    const cards = (await searchOnTheLine(db as never, { scope: SCOPE, userId: 'sara', phone: '0966793918', countryCode: 'SY', visibility: envelope(), now: NOW }))!;
    expect(cards.map((c) => [c.id, c.takeable])).toEqual([[o.id, true]]);
    expect(await take(o.id, SARA, envelope())).toMatchObject({ ok: true, orderId: o.id });
    expect(o.claimedById).toBe('sara');
  });

  it('NEGATIVE: never-called is still refused, and a colleague’s is neither listed nor taken', async () => {
    const fresh = order({ confirmationStatus: 'NEW' });
    const hers = releasedRetry({ claimedById: 'hind', claimedAt: AGO(1), confirmationStatus: 'IN_PROGRESS' });
    const cards = (await searchOnTheLine(db as never, { scope: SCOPE, userId: 'sara', phone: '0966793918', countryCode: 'SY', visibility: envelope(), now: NOW }))!;
    expect(cards.map((c) => [c.id, c.code])).toEqual([[fresh.id, 'NEVER_CALLED']]);
    expect(await take(fresh.id, SARA, envelope())).toMatchObject({ ok: false, code: 'NEVER_CALLED' });
    expect(await take(hers.id, SARA, envelope())).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect([fresh.claimedById, hers.claimedById]).toEqual([null, 'hind']);
  });
});

describe('the verdict, pure', () => {
  const base = { claimedById: null, confirmationStatus: 'NO_ANSWER', shippingStatus: 'NOT_READY', attempts: [{ result: 'NO_ANSWER', createdAt: AGO(3) }] };
  it('a reach BEFORE the last release does not stop it — only one after', () => {
    expect(callbackVerdict('sara', { ...base, attempts: [...base.attempts, { result: 'ANSWERED', createdAt: AGO(4) }], lastReleasedAt: AGO(2) }).ok).toBe(true);
    expect(callbackVerdict('sara', { ...base, attempts: [...base.attempts, { result: 'ANSWERED', createdAt: AGO(1) }], lastReleasedAt: AGO(2) }).ok).toBe(false);
  });
});
