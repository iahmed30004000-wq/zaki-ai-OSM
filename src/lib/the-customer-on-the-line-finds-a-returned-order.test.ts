import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — «الزبون على الخط» WITH «الطلب يرجع للطابور فوراً» ON (the owner, 9/11)
 *
 * The mode sends an order back to the pool after a call of ANY kind or with a date — not only after a no-answer — so the customer who
 * rings back must find it, and the agent who picks up must take it:
 *
 *  1. An open, never-shipped, unheld order with ANY attempt, or a promised date, is a returned order: found by the search and taken
 *     (a dated one before its date; one pressed «لا يرد» ten minutes ago — the ready-time is ignored: he is on the line NOW).
 *  2. Nothing else moves: an order nobody rang and nobody promised stays the pull’s (`NEVER_CALLED`); a colleague who has STARTED on it
 *     keeps it; an order held for a colleague is refused; a shipped one is closed — each with its own sentence, unchanged.
 *  3. A colleague’s untouched pull of an order that has an answered call or a date is taken from her (the owner’s 7/11 case, widened).
 *  4. The HAND LIMIT binds the take (five, with the owner’s sentence); the PACE does not.
 *  5. A card shows no name, phone or address — the widened read selects none.
 *  6. With the mode OFF the same worlds answer as they always did: the order with no no-answer on it is not found.
 *
 * The in-memory database of `customer-on-the-line.test.ts` (which applies the filters it is given — SQL’s three values), copied here
 * whole: its fidelity (a `select`, a nested `where`, a `_count`) is what makes these answers the filters’ own.
 * Blockers: no money, no order creation, no migration.
 * ═══════════════════════════════════════════════════════════════════════
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const { sw, rsw } = vi.hoisted(() => ({
  sw: { value: { enabled: false, enabledAt: null } as { enabled: boolean; enabledAt: Date | null } },
  rsw: { value: { enabled: false, enabledAt: null } as { enabled: boolean; enabledAt: Date | null } },
}));

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
    /**
     * Every WRITE and through which client: `tx` is the transaction's own client (what `db.$transaction(fn)` hands `fn`), `root` is
     * the shared `db`. `duringTx` is true when a transaction was open at that moment — a write on `root` then has left the
     * transaction it belonged in, and a take that does that is not one transaction any more.
     */
    ops: [] as { op: string; via: 'tx' | 'root'; duringTx: boolean }[],
    /** Transactions open right now. */
    openTx: 0,
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
    const record = (op: string) => void world.ops.push({ op, via: tx ? 'tx' : 'root', duringTx: world.openTx > 0 });
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
          record('order.updateMany');
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
      orderClaimHistory: {
        create: async ({ data }: Row) => {
          record('orderClaimHistory.create');
          world.history.push({ ...data, createdAt: data.createdAt ?? new Date() });
        },
      },
      orderStatusLog: {
        create: async ({ data }: Row) => {
          record('orderStatusLog.create');
          world.statusLogs.push(data);
        },
      },
      orderActivity: {
        create: async ({ data }: Row) => {
          record('orderActivity.create');
          world.activities.push(data);
        },
      },
      notification: {
        create: async ({ data }: Row) => {
          record('notification.create');
          world.notifications.push({ ...data, createdAt: new Date() });
        },
      },
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
        world.openTx++;
        try {
          return await fn(client(state));
        } finally {
          world.openTx--;
          state.releases.forEach((r) => r());
        }
      },
    },
  };
});


vi.mock('./no-answer-rounds-switch', () => ({ roundsSwitch: async () => sw.value }));
vi.mock('./no-answer-returns-switch', () => ({ returnsSwitch: async () => rsw.value }));

const { takeOnTheLine, searchOnTheLine, callbackVerdict, CUSTOMER_CALLED_BACK_REASON, TAKEN_ON_THE_LINE_REASON } = await import('./customer-on-the-line');
const { RETURNS_MODE, CLAIM_CAPS } = await import('./confirmation-queue');
const { handLimitMessage } = await import('./no-answer-returns');

const rbac = await import('./rbac');
const { db } = await import('./db');

const NOW = new Date('2026-11-04T09:00:00Z');
const AGO = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const AHEAD = (h: number) => new Date(NOW.getTime() + h * 3_600_000);
const SCOPE = { companyId: 'c1', storeId: 's1' };
const SARA = { id: 'sara', role: 'CONFIRMATION_AGENT' };
const ON = { enabled: true, enabledAt: AGO(24 * 5) };
const OFF = { enabled: false, enabledAt: null };

let seq = 0;
function order(over: Row = {}): Row {
  const o = {
    id: `o${++seq}`, orderNumber: `ORD-${seq}`, companyId: 'c1', storeId: 's1', customerId: 'cust1',
    claimedById: null, claimedAt: null, currentOwnerId: null, assignedToId: null, assignedAt: null,
    confirmationStatus: 'IN_PROGRESS', status: 'IN_PROGRESS', shippingStatus: 'NOT_READY', shippingBatchId: null, trackingNumber: null, labelPrintedAt: null,
    signatureStatus: 'UNSIGNED', lockedById: null, lockExpiresAt: null, createdById: null, moderatorId: null, replacesOrderId: null,
    postponedUntil: null, nextFollowUpAt: null, createdAt: AGO(30), regionName: 'دمشق', items: [{ productName: 'ساعة' }], version: 1,
    ...over,
  };
  world.orders.push(o);
  return o;
}
const attempt = (o: Row, result: string, createdAt: Date) => void world.attempts.push({ orderId: o.id, result, createdAt });
const claim = (o: Row, userId: string, createdAt: Date, reason = 'PULL_NEXT') => void world.history.push({ orderId: o.id, action: 'CLAIMED', userId, createdAt, reason });
const release = (o: Row, userId: string, createdAt: Date, reason: string) => void world.history.push({ orderId: o.id, action: 'RELEASED', userId, createdAt, reason });

/** What the mode leaves in the pool: the order Hind worked, and sent back — by a date (she promised one to the customer). */
function sentBackWithADate(over: Row = {}): Row {
  const o = order({ confirmationStatus: 'POSTPONED', postponedUntil: AHEAD(20), nextFollowUpAt: AHEAD(20), ...over });
  claim(o, 'hind', AGO(4));
  attempt(o, 'OPENED', AGO(3));
  release(o, 'hind', AGO(2), 'DATE_RETURNED');
  return o;
}
/** …by the idle release, after a call that WAS answered: no no-answer on it, and no date. */
function sentBackAfterAnAnsweredCall(over: Row = {}): Row {
  const o = order(over);
  claim(o, 'hind', AGO(5));
  attempt(o, 'ANSWERED', AGO(4));
  release(o, 'hind', AGO(2), 'AUTO_RELEASE_IDLE_RETURNED');
  return o;
}
/** …by her «لا يرد» ten minutes ago: not ready for three working hours yet. */
function sentBackJustNow(over: Row = {}): Row {
  const o = order(over);
  claim(o, 'hind', AGO(1));
  attempt(o, 'NO_ANSWER', new Date(NOW.getTime() - 10 * 60_000));
  release(o, 'hind', new Date(NOW.getTime() - 9 * 60_000), 'NO_ANSWER_RETURNED');
  return o;
}
/** The live agents’ envelope — `orders.view` at ASSIGNED — through the REAL `orderVisibilityWhere`. */
const envelope = () =>
  rbac.orderVisibilityWhere({
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
  } as never) as Row;
const cards = async () =>
  (await searchOnTheLine(db as never, { scope: SCOPE, userId: 'sara', phone: '0966793918', countryCode: 'SY', visibility: envelope(), now: NOW }))!;
const take = (orderId: string) => takeOnTheLine({ scope: SCOPE, user: SARA, orderId, visibility: envelope(), now: NOW });

beforeEach(() => {
  seq = 0;
  world.orders = [];
  world.attempts = [];
  world.history = [];
  world.statusLogs = [];
  world.activities = [];
  world.notifications = [];
  world.writes = [];
  world.ops = [];
  world.openTx = 0;
  world.locks = [];
  world.beforeWrite = null;
  world.onLock = null;
  world.lockless = false;
  world.users = new Map([
    ['sara', { id: 'sara', name: 'سارة', status: 'ACTIVE' }],
    ['hind', { id: 'hind', name: 'هند', status: 'ACTIVE' }],
    ['noor', { id: 'noor', name: 'نور', status: 'ACTIVE' }],
  ]);
  world.customers = new Map([['cust1', { id: 'cust1', phone: '966793918', fullName: 'زبون', address: 'شارع' }]]);
  sw.value = ON;
  rsw.value = ON;
});

describe('ON — the customer rings back for an order the mode sent back', () => {
  it('a dated order (no no-answer on it, a date still ahead) is FOUND and TAKEN — today it is invisible', async () => {
    const o = sentBackWithADate();
    const [card] = await cards();
    expect(card).toMatchObject({ id: o.id, takeable: true, holder: 'بالطابور', code: null });
    const got = await take(o.id);
    expect(got).toEqual({ ok: true, orderId: o.id, orderNumber: o.orderNumber });
    expect(o).toMatchObject({ claimedById: 'sara', currentOwnerId: 'sara', confirmationStatus: 'IN_PROGRESS', claimedAt: NOW });
    // The pull’s own claim line says how she got it; the date and the attempts are what they were.
    expect(world.history.filter((h) => h.orderId === o.id && h.action === 'CLAIMED').at(-1)).toMatchObject({ userId: 'sara', reason: CUSTOMER_CALLED_BACK_REASON });
    expect(o.postponedUntil).toEqual(AHEAD(20));
    expect(world.attempts).toHaveLength(1);
  });

  it('an order sent back after an ANSWERED call (no no-answer, no date) is found and taken too', async () => {
    const o = sentBackAfterAnAnsweredCall();
    expect((await cards()).map((c) => [c.id, c.takeable])).toEqual([[o.id, true]]);
    expect((await take(o.id)).ok).toBe(true);
  });

  it('the ready-time is ignored: an order pressed «لا يرد» ten minutes ago — not pullable for three hours — is taken on the line', async () => {
    const o = sentBackJustNow();
    expect((await take(o.id)).ok).toBe(true);
    expect(o.claimedById).toBe('sara');
  });

  it('a dated order is also taken when it carries only the follow-up date (the other column)', async () => {
    const o = sentBackWithADate({ postponedUntil: null, confirmationStatus: 'FOLLOW_UP_REQUIRED' });
    expect((await take(o.id)).ok).toBe(true);
  });

  it('OFF — the same worlds answer as ever: an order with no no-answer on it is not found, and not taken', async () => {
    rsw.value = OFF;
    const dated = sentBackWithADate();
    const answered = sentBackAfterAnAnsweredCall();
    expect(await cards()).toEqual([]);
    for (const o of [dated, answered]) expect(await take(o.id)).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(world.orders.every((o) => o.claimedById === null)).toBe(true);
  });

  it.each([
    ['its own switch off', () => { rsw.value = OFF; }],
    ['the rounds off (whatever the mode’s own switch holds)', () => { sw.value = OFF; }],
  ])('%s: the mode is off, so the dated order is not found', async (_name, set) => {
    set();
    sentBackWithADate();
    expect(await cards()).toEqual([]);
  });
});

describe('ON — what stays refused, with its own sentence', () => {
  it('an order nobody rang and nobody promised is still the pull’s: NEVER_CALLED', async () => {
    const o = order({ confirmationStatus: 'NEW', status: 'NEW' });
    const [card] = await cards();
    expect(card).toMatchObject({ id: o.id, takeable: false, code: 'NEVER_CALLED' });
    expect(await take(o.id)).toMatchObject({ ok: false, code: 'NEVER_CALLED', message: 'هالطلب ما حدا اتصل فيه لسا — بيوصل بالسحب «اسحب الطلب التالي»، مش على الخط' });
  });

  it('somebody reached the customer after it went back: REACHED_SINCE_RELEASE, as ever', async () => {
    const o = sentBackAfterAnAnsweredCall();
    attempt(o, 'ANSWERED', AGO(1));
    expect(await take(o.id)).toMatchObject({ ok: false, code: 'REACHED_SINCE_RELEASE' });
  });

  it('held for a colleague (a returning customer’s order): refused, and not taken', async () => {
    const o = order({ confirmationStatus: 'NEW', status: 'NEW', assignedToId: 'noor', assignedAt: AGO(1) });
    attempt(o, 'OPENED', AGO(3));
    expect(await take(o.id)).toMatchObject({ ok: false, code: 'RESERVED_FOR_COLLEAGUE' });
    expect(o.claimedById).toBeNull();
  });

  it('on a trolley, or past the desk: not widened to — the order is not even readable on the line, and nothing is taken', async () => {
    const shipped = sentBackWithADate({ shippingBatchId: 'b1' });
    const decided = sentBackAfterAnAnsweredCall({ confirmationStatus: 'CONFIRMED' });
    expect(await cards()).toEqual([]);
    expect(await take(shipped.id)).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(await take(decided.id)).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(world.orders.every((o) => o.claimedById === null)).toBe(true);
  });

  it('a colleague holds it AND HAS STARTED on it: hers — «وهي بدأت عليه»', async () => {
    const o = sentBackWithADate({ claimedById: 'hind', claimedAt: AGO(1), confirmationStatus: 'IN_PROGRESS' });
    attempt(o, 'OPENED', new Date(AGO(1).getTime() + 60_000));
    const got = await take(o.id);
    expect(got).toMatchObject({ ok: false, code: 'HELD_BY_COLLEAGUE', heldBy: 'هند' });
    expect((got as { message: string }).message).toContain('وهي بدأت عليه');
    expect(o.claimedById).toBe('hind');
  });

  it('…and an attempt exactly AT her claim counts as started', async () => {
    const o = sentBackWithADate({ claimedById: 'hind', claimedAt: AGO(1) });
    attempt(o, 'OPENED', AGO(1));
    expect(await take(o.id)).toMatchObject({ ok: false, code: 'HELD_BY_COLLEAGUE' });
  });
});

describe('ON — a colleague’s untouched pull of a returned order is taken from her (the 7/11 case, widened)', () => {
  it('Hind pulled an order that carries a date and an answered call — and logged nothing: Sara takes it, Hind is told', async () => {
    const o = sentBackWithADate({ claimedById: 'hind', claimedAt: AGO(1), currentOwnerId: 'hind', assignedToId: 'hind', assignedAt: AGO(1) });
    claim(o, 'hind', AGO(1));
    const [card] = await cards();
    expect(card).toMatchObject({ id: o.id, takeable: true, fromColleague: 'هند', holder: 'هند' });
    expect((await take(o.id)).ok).toBe(true);
    expect(o).toMatchObject({ claimedById: 'sara', assignedToId: 'sara' });
    expect(world.history.some((h) => h.reason === TAKEN_ON_THE_LINE_REASON && h.userId === 'hind')).toBe(true);
    expect(world.notifications).toHaveLength(1);
    expect(world.notifications[0]).toMatchObject({ userId: 'hind' });
  });

  it('OFF — the same pull is refused, as before: nothing rang, as far as the rule knows', async () => {
    rsw.value = OFF;
    const o = sentBackWithADate({ claimedById: 'hind', claimedAt: AGO(1), currentOwnerId: 'hind' });
    const got = await take(o.id);
    expect(got.ok).toBe(false);
  });

  it('the verdict, asked of facts alone: any attempt or a date is the evidence; with the mode off only a no-answer is', () => {
    // Sent back an hour ago: whatever was logged was logged before it went.
    const base = { claimedById: null, confirmationStatus: 'IN_PROGRESS', shippingStatus: 'NOT_READY', lastReleasedAt: AGO(1), attempts: [] as { result: string; createdAt: Date }[] };
    const answered = { ...base, attempts: [{ result: 'ANSWERED', createdAt: AGO(3) }] };
    const dated = { ...base, nextFollowUpAt: AHEAD(5) };
    expect(callbackVerdict('sara', answered, true)).toEqual({ ok: true });
    expect(callbackVerdict('sara', dated, true)).toEqual({ ok: true });
    expect(callbackVerdict('sara', base, true)).toMatchObject({ ok: false, code: 'NEVER_CALLED' });
    expect(callbackVerdict('sara', answered)).toMatchObject({ ok: false, code: 'NEVER_CALLED' });
    expect(callbackVerdict('sara', dated, false)).toMatchObject({ ok: false, code: 'NEVER_CALLED' });
  });
});

describe('ON — the hand limit binds the take, and the pace does not', () => {
  const holdFive = () => {
    for (let i = 0; i < RETURNS_MODE.handLimit; i++) {
      const mine = order({ customerId: `c${i}`, claimedById: 'sara', claimedAt: AGO(0.1), currentOwnerId: 'sara' });
      claim(mine, 'sara', AGO(0.1));
      attempt(mine, 'OPENED', AGO(0.05));
    }
  };

  it('five in her hands: refused with the owner’s sentence, and nothing is written', async () => {
    holdFive();
    const o = sentBackWithADate();
    const got = await take(o.id);
    expect(got).toEqual({ ok: false, code: 'CAP_TOTAL', message: handLimitMessage(RETURNS_MODE.handLimit) });
    expect(o.claimedById).toBeNull();
    expect(world.statusLogs).toHaveLength(0);
  });

  it('four in her hands: the fifth is taken', async () => {
    holdFive();
    world.orders.splice(world.orders.findIndex((r) => r.claimedById === 'sara'), 1);
    const o = sentBackWithADate();
    expect((await take(o.id)).ok).toBe(true);
  });

  it('OFF — the same five are nothing: the cap is 500', async () => {
    rsw.value = OFF;
    holdFive();
    const o = sentBackJustNow();
    expect((await take(o.id)).ok).toBe(true);
    expect(CLAIM_CAPS.total).toBe(500);
  });

  it('forty pulls this hour do not stop the customer on the line', async () => {
    for (let i = 0; i < 40; i++) world.history.push({ orderId: `x${i}`, action: 'CLAIMED', userId: 'sara', reason: 'PULL_NEXT', createdAt: AGO(0.2) });
    const o = sentBackWithADate();
    expect((await take(o.id)).ok).toBe(true);
  });

  it('his other waiting orders follow her only inside the room that is left: five minus what she holds minus this one', async () => {
    for (let i = 0; i < 3; i++) {
      const mine = order({ customerId: `c${i}`, claimedById: 'sara', claimedAt: AGO(0.1), currentOwnerId: 'sara' });
      claim(mine, 'sara', AGO(0.1));
      attempt(mine, 'OPENED', AGO(0.05));
    }
    const o = sentBackWithADate();
    const twins = Array.from({ length: 4 }, () => order({ confirmationStatus: 'NEW', status: 'NEW' }));
    await take(o.id);
    // 5 − 3 in her hands − the one she takes = 1 twin held for her.
    expect(twins.filter((tw) => tw.assignedToId === 'sara')).toHaveLength(1);
  });
});

describe('ON — a card still shows no name, phone or address', () => {
  it('the widened read selects none of them: the keys of a card are the same ten', async () => {
    sentBackWithADate();
    const [card] = await cards();
    expect(Object.keys(card).sort()).toEqual(['code', 'fromColleague', 'governorate', 'holder', 'id', 'message', 'orderNumber', 'product', 'status', 'takeable']);
    expect(JSON.stringify(card)).not.toMatch(/966793918|زبون|شارع/);
  });
});
