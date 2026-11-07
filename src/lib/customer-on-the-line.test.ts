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
 *   · never rung → NEVER_CALLED; a colleague holds it and HAS STARTED → HELD_BY_COLLEAGUE with her name; shipped → CLOSED; another
 *     store or outside her envelope and not unanswered → NOT_FOUND; held for a colleague → RESERVED_FOR_COLLEAGUE; at the cap →
 *     CAP_TOTAL;
 *   · two agents at once: one wins, the other is told who has it — with the customer lock, and with the write's own guard when
 *     the lock serialises nothing (the control);
 *   · the search: exact number only, ten at most, her store and her envelope, no customer field on a card.
 *
 * AND (the owner, 7/11 — «حلّ الثغرتين») THE ORDER A COLLEAGUE PULLED AND HAS NOT STARTED ON IS TAKEN FROM HER:
 *
 *   · the search finds an unanswered order at the desk whoever holds it, and the card names her; the write is NOT widened;
 *   · the verdict table — hers · a colleague's untouched (takeable) · touched by OPENED / a message / a no-answer / an answer, an
 *     attempt exactly AT `claimedAt` · no no-answer on the order · closed or shipped · claim time unknown · an unheld retry as it was;
 *   · the one guarded write — the claim she READ (holder, `claimedAt`, nothing logged since): a colleague who re-pulled, an attempt
 *     that landed between the read and the write, a third agent's claim and a shipment each leave the order where it was;
 *   · what it writes: a RELEASED line for her, the CLAIMED line with `fromUserId`, the status note, ONE notice, his twins follow;
 *   · the cap and the customer's lock bind on that path too, and the claim she takes from is the one she saw before she waited.
 *
 * Four assertions of the earlier rule were changed by that decision, each marked where it stands: a colleague's order is no longer
 * "neither listed nor taken" when it is unanswered, and one she has not started on is no longer refused.
 *
 * WHAT THIS CANNOT PROVE: that Postgres's advisory lock behaves as the mutex here does (the pull's own test says the same), nor
 * that a transaction in flight on another connection is invisible to the write's snapshot the way a hook between statements is.
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
    notifications: [] as Row[],
    /** Every `updateMany` the database was asked for, as asked — so a test can read the guard a write carried. */
    writes: [] as { where: Row; data: Row }[],
    /** The customer locks taken, by key. */
    locks: [] as string[],
    /** Runs once, inside a write, after the transaction's reads and before the database evaluates it: somebody else's commit in that gap. */
    beforeWrite: null as null | (() => void),
    /** Runs once, when a transaction is granted the customer's lock: what committed while it waited. */
    onLock: null as null | (() => void),
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
          world.writes.push({ where, data });
          const hook = world.beforeWrite;
          world.beforeWrite = null;
          hook?.();
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
      notification: { create: async ({ data }: Row) => void world.notifications.push({ ...data, createdAt: new Date() }) },
      $executeRaw: async (_strings: TemplateStringsArray, key: string) => {
        if (!tx) return 0;
        world.locks.push(key);
        if (!world.lockless) {
          const before = tails.get(key) ?? Promise.resolve();
          let release!: () => void;
          const mine = new Promise<void>((r) => (release = r));
          tails.set(key, before.then(() => mine));
          tx.releases.push(release);
          await before;
        }
        const hook = world.onLock;
        world.onLock = null;
        hook?.();
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

const {
  takeOnTheLine,
  searchOnTheLine,
  callbackVerdict,
  callbackTakeFromColleagueWhere,
  callbackTakeWhere,
  CUSTOMER_CALLED_BACK_REASON,
  TAKEN_ON_THE_LINE_REASON,
  CALLBACK_SEARCH_LIMIT,
} = await import('./customer-on-the-line');
const { CLAIM_CAPS, OPEN_CONFIRMATION } = await import('./confirmation-queue');
const { NO_ANSWER_RESULTS } = await import('./confirmation-workflow');
const { pullLockKey } = await import('./twins-follow-the-pull');
const { db } = await import('./db');
const rbac = await import('./rbac');

const NOW = new Date('2026-11-04T09:00:00Z');
const AGO = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const SCOPE = { companyId: 'c1', storeId: 's1' };
const SARA = { id: 'sara', role: 'CONFIRMATION_AGENT' };
const HIND = { id: 'hind', role: 'CONFIRMATION_AGENT' };
const NOOR = { id: 'noor', role: 'CONFIRMATION_AGENT' };

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
/**
 * THE OWNER'S CASE (7/11): Sara rang him, nobody answered, the order went back to the pool, HIND pulled it at `claimedAt` — and
 * now the customer rings SARA. Hind has logged nothing on it unless a test says so.
 */
const CLAIMED_AT = AGO(1);
function pulledByColleague(over: Row = {}): Row {
  const o = order({ claimedById: 'hind', claimedAt: CLAIMED_AT, currentOwnerId: 'hind', confirmationStatus: 'IN_PROGRESS', status: 'IN_PROGRESS', ...over });
  world.history.push({ orderId: o.id, action: 'CLAIMED', userId: 'sara', createdAt: AGO(6) });
  world.attempts.push({ orderId: o.id, result: 'NO_ANSWER', createdAt: AGO(5) });
  world.history.push({ orderId: o.id, action: 'RELEASED', userId: 'sara', createdAt: AGO(2) });
  world.history.push({ orderId: o.id, action: 'CLAIMED', userId: 'hind', reason: 'PULL_NEXT', createdAt: CLAIMED_AT });
  return o;
}
/** One more attempt on the order — by whoever, of whatever kind. */
const touch = (o: Row, result: string, createdAt: Date) => void world.attempts.push({ orderId: o.id, result, createdAt });
const claimLines = (o: Row) => world.history.filter((h) => h.orderId === o.id);
/** The lines the story itself has written before any take: Sara pulled it, it went back, Hind pulled it. */
const STORY_LINES = 3;
const take = (orderId: string, user = SARA, visibility: Row = {}) =>
  takeOnTheLine({ scope: SCOPE, user, orderId, visibility, now: NOW });

beforeEach(() => {
  seq = 0;
  world.orders = [];
  world.attempts = [];
  world.history = [];
  world.statusLogs = [];
  world.activities = [];
  world.notifications = [];
  world.writes = [];
  world.locks = [];
  world.beforeWrite = null;
  world.onLock = null;
  world.lockless = false;
  world.users = new Map([
    ['sara', { id: 'sara', name: 'سارة', status: 'ACTIVE' }],
    ['hind', { id: 'hind', name: 'هند', status: 'ACTIVE' }],
    ['noor', { id: 'noor', name: 'نور', status: 'ACTIVE' }],
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
    // The take of an UNHELD order is as it was (7/11): nobody to tell, nobody to name, no release written for a colleague.
    expect(world.notifications).toHaveLength(0);
    expect(world.history.some((h) => h.reason === TAKEN_ON_THE_LINE_REASON)).toBe(false);
    expect(JSON.parse(claim!.metadata)).toEqual({ role: 'CONFIRMATION_AGENT' });
    expect(world.statusLogs[0].note).toBe('الزبون اتصل — أخدته على الخط');
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

  it('a colleague’s that she HAS STARTED on — with her name, and nothing written (7/11: one she has not started on is taken, below)', async () => {
    // Overturned by the owner on 7/11: this order used to be refused for a colleague's claim alone. It is refused now because she
    // has logged something on it since she pulled it.
    const o = releasedRetry({ claimedById: 'hind', claimedAt: AGO(1), confirmationStatus: 'IN_PROGRESS' });
    touch(o, 'OPENED', AGO(0.5));
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
    // 7/11: a colleague's order that carries a no-answer is readable now (below); one nobody ever rang is still not found.
    const quiet = order({ claimedById: 'hind', claimedAt: AGO(1), confirmationStatus: 'IN_PROGRESS' });
    expect(await take(quiet.id, SARA, { id: '__no_access__' })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect([fresh.claimedById, quiet.claimedById]).toEqual([null, 'hind']);
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
    expect(Object.keys(card).sort()).toEqual(['code', 'fromColleague', 'governorate', 'holder', 'id', 'message', 'orderNumber', 'product', 'status', 'takeable']);
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

  it('NEGATIVE: never-called is still refused, and a colleague’s order nobody ever rang is neither listed nor taken', async () => {
    // 7/11: "a colleague's is neither listed nor taken" held while any colleague-held order was outside this envelope. One that
    // carries a no-answer is listed now (below); this one has none, so it is exactly as before.
    const fresh = order({ confirmationStatus: 'NEW' });
    const hers = order({ claimedById: 'hind', claimedAt: AGO(1), confirmationStatus: 'IN_PROGRESS' });
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

/* ════════════════ 7/11 — A COLLEAGUE PULLED IT AND HAS DONE NOTHING ON IT ════════════════ */

const STARTED = 'الطلب مع هند وهي بدأت عليه — حوّلي الزبون إلها أو للمشرفة';
const PLAIN = 'الطلب مع هند — ما بتاخديه، حوّلي الزبون إلها أو للمشرفة';

describe('the verdict for an order a colleague holds — pure (the owner, 7/11)', () => {
  const base = {
    claimedById: 'hind',
    claimerName: 'هند',
    claimedAt: CLAIMED_AT,
    confirmationStatus: 'IN_PROGRESS',
    shippingStatus: 'NOT_READY',
    attempts: [{ result: 'NO_ANSWER', createdAt: AGO(5) }] as { result: string; createdAt: Date }[],
  };
  const verdict = (over: Row = {}) => callbackVerdict('sara', { ...base, ...over } as never);

  it('hers is hers — said as hers', () => {
    expect(verdict({ claimedById: 'sara' })).toMatchObject({ ok: false, code: 'ALREADY_YOURS' });
  });

  it('a colleague’s with nothing logged since she pulled it is takeable, and names her and her claim', () => {
    expect(verdict()).toEqual({ ok: true, fromColleague: { id: 'hind', name: 'هند', claimedAt: CLAIMED_AT } });
  });

  it.each(['OPENED', 'MESSAGE_SENT', 'NO_ANSWER', 'BUSY', 'UNREACHABLE', 'ANSWERED', 'CALLBACK_REQUESTED', 'WRONG_NUMBER', 'CONFIRMED', 'OTHER'])(
    'NEGATIVE: %s logged since she pulled it — she has started on it, and the sentence says so',
    (result) => {
      expect(verdict({ attempts: [...base.attempts, { result, createdAt: AGO(0.5) }] })).toEqual({ ok: false, code: 'HELD_BY_COLLEAGUE', message: STARTED });
    }
  );

  it('an attempt exactly AT claimedAt counts as started; one a millisecond earlier does not', () => {
    expect(verdict({ attempts: [...base.attempts, { result: 'OPENED', createdAt: CLAIMED_AT }] })).toEqual({ ok: false, code: 'HELD_BY_COLLEAGUE', message: STARTED });
    expect(verdict({ attempts: [...base.attempts, { result: 'OPENED', createdAt: new Date(CLAIMED_AT.getTime() - 1) }] }).ok).toBe(true);
  });

  it('what happened BEFORE she pulled it does not make her start: the first agent’s no-answer is what makes it takeable', () => {
    expect(verdict({ attempts: [{ result: 'NO_ANSWER', createdAt: AGO(5) }, { result: 'ANSWERED', createdAt: AGO(4) }] }).ok).toBe(true);
  });

  it('NEGATIVE: not one no-answer on the order — "not started", and why it still stays with her', () => {
    const why = 'الطلب مع هند ولسا ما بدأت عليه. هالطلب ما حدا اتصل فيه لسا — بيضل معها، مش على الخط';
    expect(verdict({ attempts: [] })).toEqual({ ok: false, code: 'HELD_BY_COLLEAGUE', message: why });
    // An answer before she pulled it is not a no-answer either.
    expect(verdict({ attempts: [{ result: 'ANSWERED', createdAt: AGO(5) }] })).toEqual({ ok: false, code: 'HELD_BY_COLLEAGUE', message: why });
  });

  it.each<[string, Row, string]>([
    ['decided', { confirmationStatus: 'CONFIRMED' }, 'خلص من التأكيد'],
    ['cancelled', { confirmationStatus: 'CANCELLED' }, 'ملغى'],
    ['shipped', { shippingStatus: 'READY_TO_SHIP' }, 'للشحن'],
    ['in a batch', { shippingBatchId: 'b1' }, 'للشحن'],
    ['with a tracking number', { trackingNumber: 'T-1' }, 'للشحن'],
    ['with a printed label', { labelPrintedAt: AGO(1) }, 'للشحن'],
  ])('NEGATIVE: %s — "not started", and what closed it', (_name, over, piece) => {
    const got = verdict(over);
    expect(got).toMatchObject({ ok: false, code: 'HELD_BY_COLLEAGUE' });
    const message = (got as { message: string }).message;
    expect(message).toContain('الطلب مع هند ولسا ما بدأت عليه.');
    expect(message).toContain(piece);
  });

  it('NEGATIVE: "started" is said before "closed" — what she did is the first fact', () => {
    expect(verdict({ shippingStatus: 'READY_TO_SHIP', attempts: [...base.attempts, { result: 'OPENED', createdAt: AGO(0.5) }] })).toMatchObject({ message: STARTED });
  });

  it('NEGATIVE: nobody recorded when she pulled it — nobody can say she has done nothing since: the plain sentence, no take', () => {
    expect(verdict({ claimedAt: null })).toEqual({ ok: false, code: 'HELD_BY_COLLEAGUE', message: PLAIN });
    expect(verdict({ claimedAt: undefined })).toEqual({ ok: false, code: 'HELD_BY_COLLEAGUE', message: PLAIN });
    expect(verdict({ claimedAt: 'not a date' })).toEqual({ ok: false, code: 'HELD_BY_COLLEAGUE', message: PLAIN });
  });

  it('her name is «موظفة تانية» when the account has none', () => {
    expect(verdict({ claimerName: null, attempts: [...base.attempts, { result: 'OPENED', createdAt: AGO(0.5) }] })).toMatchObject({
      message: 'الطلب مع موظفة تانية وهي بدأت عليه — حوّلي الزبون إلها أو للمشرفة',
    });
  });

  it('an UNHELD retry is exactly as it was: takeable, naming nobody', () => {
    expect(verdict({ claimedById: null, claimerName: null, claimedAt: null, confirmationStatus: 'NO_ANSWER' })).toEqual({ ok: true });
  });
});

describe('a colleague pulled it and has done nothing on it — taken from her (the owner, 7/11)', () => {
  it('she gets it: the pull’s fields, Hind’s RELEASED line, the CLAIMED line naming Hind, the note, ONE notice — and his twin follows her', async () => {
    const o = pulledByColleague();
    const twin = order({ confirmationStatus: 'NEW' });
    expect(await take(o.id)).toEqual({ ok: true, orderId: o.id, orderNumber: o.orderNumber });
    expect(o).toMatchObject({ claimedById: 'sara', currentOwnerId: 'sara', claimedAt: NOW, confirmationStatus: 'IN_PROGRESS', status: 'IN_PROGRESS', version: 2 });

    // The two lines the take wrote, Hind’s side first — after the lines the story already had.
    const lines = claimLines(o);
    expect(lines).toHaveLength(STORY_LINES + 2);
    expect(lines.slice(-2).map((l) => [l.action, l.userId, l.reason])).toEqual([
      ['RELEASED', 'hind', TAKEN_ON_THE_LINE_REASON],
      ['CLAIMED', 'sara', CUSTOMER_CALLED_BACK_REASON],
    ]);
    expect(lines[STORY_LINES]).toMatchObject({ companyId: 'c1', orderId: o.id });
    expect(lines[STORY_LINES + 1]).toMatchObject({ companyId: 'c1', orderId: o.id });
    // Nobody released it: the metadata says so, and says who took it.
    expect(JSON.parse(lines[STORY_LINES].metadata)).toEqual({ automatic: false, takenBy: 'sara' });
    expect(JSON.parse(lines[STORY_LINES + 1].metadata)).toEqual({ role: 'CONFIRMATION_AGENT', fromUserId: 'hind' });

    expect(world.statusLogs).toEqual([
      expect.objectContaining({
        orderId: o.id,
        previousValue: 'IN_PROGRESS',
        newValue: 'IN_PROGRESS',
        changedById: 'sara',
        note: 'الزبون اتصل — أخدته على الخط من هند',
      }),
    ]);

    // ONE notice, to the colleague, in the shape of the release notice (`auto-release.ts`).
    expect(world.notifications).toEqual([
      expect.objectContaining({
        companyId: 'c1',
        storeId: 's1',
        userId: 'hind',
        type: 'SYSTEM_ALERT',
        link: '/confirmation/mine',
        title: `انسحب ${o.orderNumber} منك`,
        message: `الطلب ${o.orderNumber} انسحب منك: الزبون اتصل بزميلتك وما كنتِ اتصلتِ فيه`,
      }),
    ]);

    // His other waiting order follows her, exactly as at the pull; and no call is invented for her.
    expect(twin).toMatchObject({ assignedToId: 'sara', assignedAt: NOW, claimedById: null });
    expect(world.attempts).toHaveLength(1);
  });

  it('the ONE write is guarded on the claim she read: that holder, that moment, still open, never shipped, nothing logged since', async () => {
    const o = pulledByColleague();
    await take(o.id);
    const main = world.writes.filter((w) => w.data.claimedById === 'sara');
    expect(main).toHaveLength(1);
    expect(main[0].where).toMatchObject({
      id: o.id,
      companyId: 'c1',
      storeId: 's1',
      claimedById: 'hind',
      claimedAt: CLAIMED_AT,
      confirmationStatus: { in: OPEN_CONFIRMATION },
      shippingStatus: 'NOT_READY',
      shippingBatchId: null,
      trackingNumber: null,
      labelPrintedAt: null,
      contactAttempts: { none: { createdAt: { gte: CLAIMED_AT } } },
    });
    // ...and the no-answer it was granted for is asked again, in the write.
    expect(main[0].where.AND).toEqual([{ contactAttempts: { some: { result: { in: [...NO_ANSWER_RESULTS] } } } }]);
    expect(main[0].data).toMatchObject({ claimedById: 'sara', claimedAt: NOW, currentOwnerId: 'sara', confirmationStatus: 'IN_PROGRESS', status: 'IN_PROGRESS', version: { increment: 1 } });
  });

  it('under the customer’s lock — the very key the pull takes', async () => {
    const o = pulledByColleague();
    await take(o.id);
    expect(world.locks).toEqual([pullLockKey('cust1')]);
  });

  it('whatever open status the order stands in, only what she logged matters', async () => {
    for (const status of OPEN_CONFIRMATION) {
      const o = pulledByColleague({ confirmationStatus: status });
      expect((await take(o.id)).ok, status).toBe(true);
      expect(o, status).toMatchObject({ claimedById: 'sara', confirmationStatus: 'IN_PROGRESS' });
    }
  });

  it('NEGATIVE: one she HAS started on — refused with her name and the "started" sentence; nothing written, nobody told', async () => {
    for (const result of ['OPENED', 'MESSAGE_SENT', 'NO_ANSWER', 'ANSWERED']) {
      const o = pulledByColleague();
      touch(o, result, AGO(0.5));
      expect(await take(o.id), result).toMatchObject({ ok: false, code: 'HELD_BY_COLLEAGUE', heldBy: 'هند', message: STARTED });
      expect(o.claimedById, result).toBe('hind');
      expect(o.version).toBe(1);
    }
    expect(world.statusLogs).toHaveLength(0);
    expect(world.notifications).toHaveLength(0);
  });

  it('NEGATIVE: a brand-new order a colleague pulled (not one no-answer on it) stays with her — the pull’s rule, not the phone’s', async () => {
    const o = order({ claimedById: 'hind', claimedAt: CLAIMED_AT, confirmationStatus: 'IN_PROGRESS' });
    expect(await take(o.id)).toMatchObject({ ok: false, code: 'HELD_BY_COLLEAGUE', heldBy: 'هند' });
    expect(o.claimedById).toBe('hind');
    expect(world.notifications).toHaveLength(0);
  });

  it('NEGATIVE: one that has left the desk — shipped or decided — is not taken from her', async () => {
    for (const over of [{ shippingStatus: 'READY_TO_SHIP' }, { confirmationStatus: 'CONFIRMED' }, { trackingNumber: 'T-9' }]) {
      const o = pulledByColleague(over);
      expect(await take(o.id), JSON.stringify(over)).toMatchObject({ ok: false, code: 'HELD_BY_COLLEAGUE' });
      expect(o.claimedById).toBe('hind');
    }
    expect(world.notifications).toHaveLength(0);
  });

  it('NEGATIVE: at the cap — the cap’s sentence, and nothing is taken from her', async () => {
    for (let i = 0; i < CLAIM_CAPS.total; i++) order({ customerId: null, claimedById: 'sara', confirmationStatus: 'IN_PROGRESS' });
    const o = pulledByColleague();
    expect(await take(o.id)).toMatchObject({ ok: false, code: 'CAP_TOTAL' });
    expect(o.claimedById).toBe('hind');
    expect(world.notifications).toHaveLength(0);
    expect(claimLines(o)).toHaveLength(STORY_LINES);
  });

  it('NEGATIVE: another store’s — not found, and not taken', async () => {
    const o = pulledByColleague({ storeId: 's2' });
    expect(await take(o.id)).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(o.claimedById).toBe('hind');
  });

  it('taking it back: the colleague who was robbed can take it from the one who took it, while she has done nothing on it', async () => {
    const o = pulledByColleague();
    await take(o.id, SARA);
    // Time passes; Hind’s customer rings Hind. Sara has logged nothing, so the rule is the same in both directions.
    const back = await takeOnTheLine({ scope: SCOPE, user: HIND, orderId: o.id, visibility: {}, now: new Date(NOW.getTime() + 60_000) });
    expect(back).toMatchObject({ ok: true });
    expect(o.claimedById).toBe('hind');
    expect(world.notifications.map((n) => n.userId)).toEqual(['hind', 'sara']);
  });
});

describe('the write is the claim she read — and nothing since', () => {
  /** Nothing was written: the order is where it was, its version unmoved, and not one line or notice exists beyond the story's own. */
  const nothingWritten = (o: Row, holder = 'hind') => {
    expect(o.claimedById).toBe(holder);
    expect(o.version).toBe(1);
    expect(world.statusLogs).toHaveLength(0);
    expect(world.notifications).toHaveLength(0);
    expect(claimLines(o)).toHaveLength(STORY_LINES);
  };

  it('an attempt that lands between her read and her write: refused — and the sentence says she has started', async () => {
    const o = pulledByColleague();
    world.beforeWrite = () => touch(o, 'OPENED', NOW);
    expect(await take(o.id)).toMatchObject({ ok: false, code: 'HELD_BY_COLLEAGUE', heldBy: 'هند', message: STARTED });
    nothingWritten(o);
  });

  it('…even one logged in the very instant she pulled it (the filter is >=, not >)', async () => {
    const o = pulledByColleague();
    world.beforeWrite = () => touch(o, 'OPENED', CLAIMED_AT);
    expect(await take(o.id)).toMatchObject({ ok: false, code: 'HELD_BY_COLLEAGUE', message: STARTED });
    nothingWritten(o);
  });

  it('the colleague let it go and pulled it AGAIN since: a new claim — TAKEN_MEANWHILE, nothing written', async () => {
    const o = pulledByColleague();
    world.beforeWrite = () => void (o.claimedAt = AGO(0.2));
    expect(await take(o.id)).toMatchObject({ ok: false, code: 'TAKEN_MEANWHILE' });
    nothingWritten(o);
  });

  it('another agent holds it by then: the take is refused and says who', async () => {
    const o = pulledByColleague();
    world.beforeWrite = () => {
      o.claimedById = 'noor';
      o.claimedAt = AGO(0.2);
    };
    const got = await take(o.id);
    expect(got).toMatchObject({ ok: false, code: 'HELD_BY_COLLEAGUE', heldBy: 'نور' });
    expect(got.ok === false && got.message).toContain('نور');
    nothingWritten(o, 'noor');
  });

  it('nobody holds it by then (she let go of it): TAKEN_MEANWHILE — this is the unheld door’s order now', async () => {
    const o = pulledByColleague();
    world.beforeWrite = () => {
      o.claimedById = null;
      o.claimedAt = null;
    };
    expect(await take(o.id)).toMatchObject({ ok: false, code: 'TAKEN_MEANWHILE' });
    expect(o.claimedById).toBeNull();
    expect(world.notifications).toHaveLength(0);
  });

  it.each<[string, string, unknown, string]>([
    ['shipped', 'shippingStatus', 'READY_TO_SHIP', 'للشحن'],
    ['given a tracking number', 'trackingNumber', 'T-9', 'للشحن'],
    ['given a label', 'labelPrintedAt', AGO(0.1), 'للشحن'],
    ['put in a batch', 'shippingBatchId', 'b1', 'للشحن'],
    ['decided', 'confirmationStatus', 'CONFIRMED', 'خلص من التأكيد'],
  ])('it is %s between the read and the write: refused, and what closed it is said', async (_name, field, value, piece) => {
    const o = pulledByColleague();
    world.beforeWrite = () => void (o[field] = value);
    const got = await take(o.id);
    expect(got).toMatchObject({ ok: false, code: 'HELD_BY_COLLEAGUE', heldBy: 'هند' });
    expect(got.ok === false && got.message).toContain(piece);
    expect(o.claimedById).toBe('hind');
    expect(o.version).toBe(1);
    expect(world.notifications).toHaveLength(0);
    expect(claimLines(o)).toHaveLength(STORY_LINES);
  });
});

describe('the claim she takes from is the one she saw before she waited at the customer’s lock', () => {
  it('the colleague pulled it again while she waited: nothing is taken — look again', async () => {
    const o = pulledByColleague();
    world.onLock = () => void (o.claimedAt = AGO(0.4));
    expect(await take(o.id)).toMatchObject({ ok: false, code: 'TAKEN_MEANWHILE' });
    expect(o.claimedById).toBe('hind');
    expect(o.version).toBe(1);
    expect(world.notifications).toHaveLength(0);
  });

  it('another agent pulled it while she waited: nothing is taken, and she is told who has it', async () => {
    const o = pulledByColleague();
    world.onLock = () => {
      o.claimedById = 'noor';
      o.claimedAt = AGO(0.4);
    };
    expect(await take(o.id)).toMatchObject({ ok: false, code: 'HELD_BY_COLLEAGUE', heldBy: 'نور' });
    expect(o.claimedById).toBe('noor');
    expect(world.notifications).toHaveLength(0);
    expect(claimLines(o)).toHaveLength(STORY_LINES);
  });

  it('two agents press at once on the same colleague’s order: one takes it, the other is told who has it, and the colleague hears once', async () => {
    const o = pulledByColleague();
    const [a, b] = await Promise.all([take(o.id, SARA), take(o.id, NOOR)]);
    expect([a, b].filter((r) => r.ok)).toHaveLength(1);
    const winner = a.ok ? SARA : NOOR;
    const lost = [a, b].find((r) => !r.ok)!;
    expect(lost).toMatchObject({ ok: false, code: 'HELD_BY_COLLEAGUE', heldBy: winner === SARA ? 'سارة' : 'نور' });
    expect(o.claimedById).toBe(winner.id);
    expect(world.notifications).toHaveLength(1);
    expect(world.notifications[0].userId).toBe('hind');
    expect(world.history.filter((h) => h.reason === TAKEN_ON_THE_LINE_REASON)).toHaveLength(1);
  });

  it('CONTROL — the lock serialising nothing: the write’s own guard still lets only one through, and the colleague is told once', async () => {
    world.lockless = true;
    const o = pulledByColleague();
    const [a, b] = await Promise.all([take(o.id, SARA), take(o.id, NOOR)]);
    expect([a, b].filter((r) => r.ok)).toHaveLength(1);
    expect([a, b].find((r) => !r.ok)).toMatchObject({ code: 'HELD_BY_COLLEAGUE' });
    expect(world.notifications).toHaveLength(1);
    expect(world.history.filter((h) => h.reason === TAKEN_ON_THE_LINE_REASON)).toHaveLength(1);
  });
});

describe('the write is as strict as it was for an unheld order, and exact for a colleague’s (the read was widened, the write was not)', () => {
  it('callbackTakeWhere — the unheld guard — matches a released retry and NOT a colleague’s pull, however untouched', () => {
    const retry = releasedRetry();
    const pulled = pulledByColleague();
    expect(tri(view(retry), callbackTakeWhere(retry.id, 'sara', NOW))).toBe(true);
    expect(tri(view(pulled), callbackTakeWhere(pulled.id, 'sara', NOW))).not.toBe(true);
    expect(callbackTakeWhere(retry.id, 'sara', NOW)).toMatchObject({ claimedById: null });
  });

  it('callbackTakeFromColleagueWhere matches THAT claim and nothing else: the holder, the moment, the desk, the attempts', () => {
    const pulled = pulledByColleague();
    const where = (id = 'hind', at: Date = CLAIMED_AT) => callbackTakeFromColleagueWhere(pulled.id, { id, claimedAt: at });
    expect(tri(view(pulled), where())).toBe(true);
    expect(tri(view(pulled), where('noor')), 'another holder').not.toBe(true);
    expect(tri(view(pulled), where('hind', AGO(0.5))), 'another moment').not.toBe(true);
    for (const [k, v] of [['shippingStatus', 'READY_TO_SHIP'], ['confirmationStatus', 'CANCELLED'], ['trackingNumber', 'T']] as const) {
      const saved = pulled[k];
      pulled[k] = v;
      expect(tri(view(pulled), where()), k).not.toBe(true);
      pulled[k] = saved;
    }
    touch(pulled, 'OPENED', CLAIMED_AT);
    expect(tri(view(pulled), where()), 'an attempt in the instant she pulled it').not.toBe(true);
  });
});

describe('the search finds an unanswered order a colleague holds, and names her (the owner, 7/11)', () => {
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
  const envelope = () => rbac.orderVisibilityWhere(ASSIGNED_SARA) as Row;
  const cardsFor = async (visibility: Row = envelope()) =>
    (await searchOnTheLine(db as never, { scope: SCOPE, userId: 'sara', phone: '0966793918', countryCode: 'SY', visibility, now: NOW }))!;

  it('an untouched colleague’s order is a card with her name and a button; one she has started on is a card with her name and the reason', async () => {
    const untouched = pulledByColleague();
    const started = pulledByColleague();
    touch(started, 'OPENED', AGO(0.5));
    expect(tri(view(untouched), envelope()), 'her envelope alone does not admit a colleague’s order').not.toBe(true);
    const by = Object.fromEntries((await cardsFor()).map((c) => [c.id, c]));
    expect(by[untouched.id]).toMatchObject({ takeable: true, holder: 'هند', fromColleague: 'هند', code: null, message: null, product: 'ساعة', governorate: 'دمشق' });
    expect(by[started.id]).toMatchObject({ takeable: false, holder: 'هند', fromColleague: null, code: 'HELD_BY_COLLEAGUE', message: STARTED });
  });

  it('NEGATIVE: a card that is not takeable from a colleague names nobody as the one it is taken from', async () => {
    const retry = releasedRetry();
    const hers = order({ claimedById: 'sara', claimedAt: AGO(1), confirmationStatus: 'IN_PROGRESS' });
    touch(hers, 'NO_ANSWER', AGO(3));
    const by = Object.fromEntries((await cardsFor()).map((c) => [c.id, c]));
    expect(by[retry.id]).toMatchObject({ takeable: true, fromColleague: null, holder: 'بالطابور' });
    expect(by[hers.id]).toMatchObject({ takeable: false, fromColleague: null, holder: 'معك', code: 'ALREADY_YOURS' });
  });

  it('NEGATIVE: an order that carries no no-answer is listed only where it is already in her envelope', async () => {
    const quiet = order({ claimedById: 'hind', claimedAt: AGO(1), confirmationStatus: 'IN_PROGRESS' });
    const typedByHer = order({ claimedById: 'hind', claimedAt: AGO(1), confirmationStatus: 'IN_PROGRESS', createdById: 'sara' });
    const ids = (await cardsFor()).map((c) => c.id);
    expect(ids).not.toContain(quiet.id);
    expect(ids).toContain(typedByHer.id);
    const card = (await cardsFor()).find((c) => c.id === typedByHer.id)!;
    expect(card).toMatchObject({ takeable: false, holder: 'هند', fromColleague: null, code: 'HELD_BY_COLLEAGUE' });
    expect(card.message).toContain('ولسا ما بدأت عليه');
  });

  it('NEGATIVE: another store’s or another company’s order, and another customer’s — never, whoever holds them', async () => {
    const mine = pulledByColleague();
    pulledByColleague({ storeId: 's2' });
    pulledByColleague({ companyId: 'c2' });
    pulledByColleague({ customerId: 'cust2' });
    expect((await cardsFor()).map((c) => c.id)).toEqual([mine.id]);
  });

  it('carries no name, phone or address: the colleague’s name is HER account’s, and the keys of a card are the same', async () => {
    pulledByColleague();
    const cards = await cardsFor();
    expect(cards).toHaveLength(1);
    expect(Object.keys(cards[0]).sort()).toEqual(['code', 'fromColleague', 'governorate', 'holder', 'id', 'message', 'orderNumber', 'product', 'status', 'takeable']);
    expect(JSON.stringify(cards)).not.toMatch(/966793918|زبون|شارع/);
    expect(cards[0].holder).toBe('هند');
  });

  it('the take’s first read agrees with the search: found and taken, found and refused, or not found', async () => {
    const untouched = pulledByColleague();
    const started = pulledByColleague();
    touch(started, 'OPENED', AGO(0.5));
    const quiet = order({ claimedById: 'hind', claimedAt: AGO(1), confirmationStatus: 'IN_PROGRESS' });
    expect(await take(started.id, SARA, envelope())).toMatchObject({ ok: false, code: 'HELD_BY_COLLEAGUE', heldBy: 'هند' });
    expect(await take(quiet.id, SARA, envelope())).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(await take(untouched.id, SARA, envelope())).toMatchObject({ ok: true, orderId: untouched.id });
    expect([started.claimedById, quiet.claimedById, untouched.claimedById]).toEqual(['hind', 'hind', 'sara']);
  });

  it('a decided colleague’s order is outside her envelope and is no unanswered order at the desk: not found; for a wider envelope, refused with why', async () => {
    const decided = pulledByColleague({ confirmationStatus: 'CONFIRMED' });
    expect((await cardsFor()).map((c) => c.id)).not.toContain(decided.id);
    expect(await take(decided.id, SARA, envelope())).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    const wide = (await cardsFor({})).find((c) => c.id === decided.id)!;
    expect(wide).toMatchObject({ takeable: false, code: 'HELD_BY_COLLEAGUE' });
    expect(wide.message).toContain('خلص من التأكيد');
  });
});
