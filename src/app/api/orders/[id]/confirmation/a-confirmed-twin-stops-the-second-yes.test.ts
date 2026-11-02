import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionUser } from '@/types/auth';
import { stripComments } from '@/lib/guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — A CONFIRMED TWIN STOPS THE SECOND «نعم» (the owner, 2/11)
 *
 * His words: «فرض الزبون غبي بعت طلبو 3 مرات، عندي 3 بنات تأكيد، كل طلب سحبتو بنت مختلفة، بنزلو 3 طلبات مؤكدة. زبون غبي تاني طلب من
 * ماسنجر ومن السايت كمان بنتين بسحبو. بدنا حل للكيس هاد». The advisory flag told each agent about a twin minutes old and refused
 * nothing; three agents each confirmed their own copy, so three parcels were to go to one person.
 *
 *  1. `confirm` — and only `confirm` — on an order with no `replacesOrderId`, first thing inside the confirming transaction: a
 *     per-customer advisory lock, THEN the twins are read through the same transaction. A twin is another CONFIRMED order of the same
 *     company, store and customer, still ours (the courier has not taken it), created in the last 72 hours, sharing a product.
 *  2. Twins and no word from her ⇒ 409 `TWIN_CONFIRMED` { error, errorAr, code, twins:[{ orderNumber, confirmedAt, confirmedByName }] },
 *     NOTHING written, nothing reserved, no customer data in the body, never a 500. With `acknowledgeTwin: true` ⇒ it goes through and
 *     ONE `TWIN_CONFIRM_ACKNOWLEDGED` history row names the numbers she was told, in her name.
 *  3. Two agents pressing at the same instant queue at the lock and the second reads the first's committed yes — modelled below with a
 *     mutex per lock key and READ COMMITTED visibility, so that taking the lock out (or reading before it) makes the three of them confirm.
 *  4. Every refusal the door had stays where it was and in its order; a bound agent still works through the REAL permission engine.
 *
 * WHAT THIS CANNOT PROVE, SAID PLAINLY: that Postgres grants `pg_advisory_xact_lock` the way the mutex below does. It proves that the
 * lock is the first statement, that the read and the write follow it inside ONE transaction, and — given a lock that serialises and
 * READ COMMITTED reads — that the result is one yes. The Postgres half is Postgres's documented contract, not this file's.
 * ═══════════════════════════════════════════════════════════════════════
 */

type Row = Record<string, unknown>;

const { model, als, requireContext, assertOrderAccess, reserveOrderLines, endOrder } = await vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks');

  /** What has been COMMITTED. A reader at READ COMMITTED sees this and nothing else of anybody's. */
  const committed = {
    orders: [] as Row[],
    items: [] as Row[],
    activities: [] as Row[],
    statusLogs: [] as Row[],
    users: [] as Row[],
  };
  /** Every statement, in the order it ran, tagged with the transaction it ran in: «tx1:lock», «tx1:twins», … */
  const log: string[] = [];
  let txSeq = 0;
  let attempts = 1;
  let lockless = false;
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));

  /* ───────── a `where`, answered the way Postgres would; an operator it does not know throws ───────── */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Where = any;
  const sameDate = (a: unknown, b: unknown) => a instanceof Date && b instanceof Date && +a === +b;
  function holds(value: unknown, filter: Where): boolean {
    if (filter === null) return value === null || value === undefined;
    if (filter instanceof Date) return sameDate(value, filter);
    if (typeof filter !== 'object') return value === filter;
    return Object.entries(filter as Record<string, unknown>).every(([op, arg]) => {
      switch (op) {
        case 'in':
          return (arg as unknown[]).includes(value);
        case 'notIn':
          return !(arg as unknown[]).includes(value);
        case 'not':
          return !holds(value, arg);
        case 'gte':
          return value instanceof Date && +value >= +(arg as Date);
        default:
          throw new Error(`the fake database does not know the operator «${op}» — teach it before trusting it`);
      }
    });
  }
  function matches(row: Row, where: Where): boolean {
    return Object.entries(where as Record<string, unknown>).every(([key, value]) => {
      if (key === 'AND') return (Array.isArray(value) ? value : [value]).every((w) => matches(row, w as Where));
      if (key === 'OR') return (value as Where[]).some((w) => matches(row, w));
      if (key === 'items') {
        const rel = value as { some?: Where };
        if (!rel.some) throw new Error('the fake database only knows `items.some`');
        return committed.items.filter((i) => i.orderId === row.id).some((i) => matches(i, rel.some));
      }
      if (key === 'shippingBatch') {
        const rel = value as { is?: Where };
        if (!rel.is) throw new Error('the fake database only knows `shippingBatch.is`');
        return row.shippingBatch !== null && row.shippingBatch !== undefined && matches(row.shippingBatch as Row, rel.is);
      }
      return holds(row[key], value);
    });
  }
  function compare(a: Row, b: Row, orderBy: Row[]): number {
    for (const clause of orderBy) {
      const [field, spec] = Object.entries(clause)[0] as [string, string | { sort: string; nulls?: string }];
      const dir = typeof spec === 'string' ? spec : spec.sort;
      const nulls = typeof spec === 'string' ? 'first' : (spec.nulls ?? 'first');
      const av = a[field] as Date | null;
      const bv = b[field] as Date | null;
      if (!av && !bv) continue;
      if (!av) return nulls === 'last' ? 1 : -1;
      if (!bv) return nulls === 'last' ? -1 : 1;
      if (+av !== +bv) return (+av - +bv) * (dir === 'desc' ? -1 : 1);
    }
    return 0;
  }
  function apply(row: Row, data: Row) {
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === 'object' && !(v instanceof Date) && 'increment' in (v as object)) {
        row[k] = Number(row[k] ?? 0) + Number((v as { increment: number }).increment);
      } else row[k] = v;
    }
  }

  /* ───────── one advisory lock per key: FIFO, released at commit or rollback ───────── */
  const tails = new Map<string, Promise<void>>();

  interface TxState {
    id: number;
    pending: (() => void)[];
    releases: (() => void)[];
  }

  /** A client: the root one (`tx` null — every statement commits on its own) or one transaction's. */
  function client(tx: TxState | null) {
    const tag = tx ? `tx${tx.id}` : 'root';
    const write = (fn: () => void) => (tx ? tx.pending.push(fn) : fn());
    return {
      order: {
        findMany: async (q: { where: Where; orderBy?: Row[]; take?: number; select: Row }) => {
          await tick();
          log.push(`${tag}:twins`);
          return committed.orders
            .filter((r) => matches(r, q.where))
            .sort((a, b) => compare(a, b, q.orderBy ?? []))
            .slice(0, q.take ?? 1000)
            .map((r) => {
              const confirmer = committed.users.find((u) => u.id === r.confirmedById);
              return { orderNumber: r.orderNumber, confirmedAt: r.confirmedAt ?? null, confirmer: confirmer ? { name: confirmer.name } : null };
            });
        },
        findUnique: async (q: { where: { id: string } }) => {
          await tick();
          const hit = committed.orders.find((r) => r.id === q.where.id);
          return hit ? { ...hit } : null;
        },
        updateMany: async (q: { where: Where; data: Row }) => {
          await tick();
          log.push(`${tag}:update`);
          const hits = committed.orders.filter((r) => matches(r, q.where));
          if (hits.length) write(() => hits.forEach((h) => apply(h, q.data)));
          return { count: hits.length };
        },
      },
      orderItem: {
        findMany: async (q: { where: { orderId: string }; select: Row }) => {
          await tick();
          log.push(`${tag}:lines`);
          return committed.items.filter((i) => i.orderId === q.where.orderId).map((i) => ({ productId: i.productId }));
        },
      },
      orderActivity: {
        create: async (q: { data: Row }) => {
          await tick();
          log.push(`${tag}:activity:${String(q.data.action)}`);
          write(() => committed.activities.push({ ...q.data }));
          return q.data;
        },
      },
      orderStatusLog: {
        create: async (q: { data: Row }) => {
          await tick();
          log.push(`${tag}:statuslog`);
          write(() => committed.statusLogs.push({ ...q.data }));
          return q.data;
        },
      },
      orderContactAttempt: { count: async () => attempts },
      customer: { findUnique: async () => null },
      user: { findUnique: async () => null },
      $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        if (!tx) throw new Error('an advisory lock taken outside a transaction protects nothing');
        await tick();
        const sql = strings.join('?');
        if (!sql.includes('pg_advisory_xact_lock')) throw new Error(`unexpected raw statement: ${sql}`);
        const key = String(values[0]);
        log.push(`${tag}:lock:${key}`);
        if (lockless) return 1;
        const prev = tails.get(key) ?? Promise.resolve();
        let release!: () => void;
        const mine = new Promise<void>((r) => (release = r));
        tails.set(key, prev.then(() => mine));
        tx.releases.push(release);
        await prev;
        log.push(`${tag}:lock-granted:${key}`);
        return 1;
      },
    };
  }

  const root = client(null);
  const db = {
    ...root,
    $transaction: async (fn: (t: unknown) => Promise<unknown>) => {
      const state: TxState = { id: ++txSeq, pending: [], releases: [] };
      log.push(`tx${state.id}:begin`);
      try {
        const out = await fn(client(state));
        // COMMIT first, release the locks after: the next holder must find this transaction's work already visible.
        for (const apply_ of state.pending) apply_();
        log.push(`tx${state.id}:commit`);
        return out;
      } catch (e) {
        log.push(`tx${state.id}:rollback`);
        throw e;
      } finally {
        for (const release of state.releases) release();
      }
    },
  };

  const als = new AsyncLocalStorage<SessionUser>();
  const fallback = { current: null as unknown as SessionUser };
  return {
    model: {
      db,
      committed,
      log,
      reset() {
        committed.orders.length = committed.items.length = committed.activities.length = committed.statusLogs.length = committed.users.length = 0;
        log.length = 0;
        tails.clear();
        txSeq = 0;
        attempts = 1;
        lockless = false;
      },
      setAttempts(n: number) {
        attempts = n;
      },
      fallback,
    },
    als,
    requireContext: vi.fn(async () => ({
      user: als.getStore() ?? fallback.current,
      companyId: 'c1',
      storeId: 's1',
      country: { allowNegativeStock: false },
    })),
    assertOrderAccess: vi.fn(async (id: string) => {
      const hit = committed.orders.find((r) => r.id === id);
      return hit ? { allowed: true, order: { ...hit } } : { allowed: false, reason: 'NOT_FOUND' };
    }),
    reserveOrderLines: vi.fn(async () => undefined),
    // The reject door is its own (and has its own tests); here it only has to END the order, as the real one does.
    endOrder: vi.fn(async (input: { orderId: string; endAs: string; data?: Row }) => {
      const hit = committed.orders.find((r) => r.id === input.orderId);
      if (hit) apply(hit, { confirmationStatus: input.endAs, status: input.endAs, version: { increment: 1 }, ...input.data });
      return { ok: true };
    }),
  };
});

vi.mock('@/lib/db', () => ({ db: model.db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...(a as [])) }));
vi.mock('@/lib/authorization', async (orig) => ({ ...(await orig<Record<string, unknown>>()), requirePermission: vi.fn() }));
vi.mock('@/lib/rbac', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertOrderAccess: (...a: unknown[]) => assertOrderAccess(...(a as [string])),
}));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/notify', () => ({ notify: vi.fn() }));
vi.mock('@/lib/reservation', () => ({
  releaseOrderLines: vi.fn(async () => undefined),
  reserveOrderLines: (...a: unknown[]) => reserveOrderLines(...(a as [])),
}));
vi.mock('@/lib/order-cancel', () => ({ endOrder: (...a: unknown[]) => endOrder(...(a as [never])) }));
vi.mock('@/lib/apps/events', () => ({ emitAppEvent: vi.fn() }));
vi.mock('@/lib/conversions/emit', () => ({ queueConversions: vi.fn() }));
vi.mock('@/lib/blacklist', () => ({ AlreadyBlocked: class extends Error {}, blockPhone: vi.fn() }));

import { attachGrants } from '@/lib/authorization';
import { computeEffectiveGrants } from '@/lib/permissions-core';
import { NOT_HELD_MESSAGE, CONTACT_FIRST_MESSAGE, REGION_REQUIRED_MESSAGE } from '@/lib/confirmation-queue';
import { twinConfirmedSentence } from '@/lib/twin-refusal';
import { POST } from './route';

/* ─────────────────────────────── who ─────────────────────────────── */

/** CONFIRMATION_AGENT, live, 1/11: all 22 keys at the whole company (the same list the door tests next door use). */
const LIVE_AGENT = [
  'ai.assist', 'ai.use', 'confirmation.issues', 'confirmation.issues_correct', 'confirmation.pull', 'confirmation.raise_issue',
  'confirmation.reassign', 'confirmation.supervise', 'confirmation.winback', 'confirmation.work', 'customers.view_basic', 'insights.view',
  'orders.change_price', 'orders.claim', 'orders.confirm', 'orders.contact_log', 'orders.edit', 'orders.note', 'orders.rating_link',
  'orders.release', 'orders.request_change', 'orders.view',
];
/** MANAGER, live, cut to what matters: it can take any order (unlock), hand any order out (assign), cancel, supervise and confirm. */
const LIVE_MANAGER = ['orders.view', 'orders.confirm', 'orders.contact_log', 'orders.assign', 'orders.unlock', 'orders.cancel', 'confirmation.supervise'];

async function person(id: string, name: string, role: string, keys: string[]): Promise<SessionUser> {
  const base = { id, email: `${id}@x`, name, role, roleId: `r-${id}`, status: 'ACTIVE', companyId: 'c1' } as unknown as SessionUser;
  const grants = await computeEffectiveGrants(base as never, {
    roleRows: async () => keys.map((k) => ({ permission: k, scope: 'ALL_COMPANY', scopeIds: null })),
    overrideRows: async () => [],
  });
  return attachGrants(base, grants);
}

let SARA: SessionUser;
let REEM: SessionUser;
let HALA: SessionUser;
let MANAGER: SessionUser;

/* ─────────────────────────────── what ─────────────────────────────── */

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

/** Three copies of one order from one customer, each in the hands of a different agent — the owner's case. */
function seed(over: Record<string, Row> = {}) {
  model.reset();
  model.committed.users.push({ id: 'sara', name: 'سارة' }, { id: 'reem', name: 'ريم' }, { id: 'hala', name: 'هالة' }, { id: 'mgr', name: 'المدير' });
  const base = (id: string, n: number, holder: string, extra: Row = {}): Row => ({
    id, orderNumber: `ORD-2026-${n}`, companyId: 'c1', storeId: 's1', customerId: 'cu1', productId: 'p1',
    confirmationStatus: 'IN_PROGRESS', status: 'IN_PROGRESS', shippingStatus: 'NOT_READY',
    shippedAt: null, labelPrintedAt: null, shippingBatchId: null, shippingBatch: null,
    claimedById: holder, lockedById: null, lockExpiresAt: null, confirmedAt: null, confirmedById: null,
    nextFollowUpAt: null, followUpStatus: null, moderatorId: null, replacesOrderId: null,
    regionId: 'r1', version: 3, totalAmount: 25, currency: 'JOD', createdAt: hoursAgo(2),
    ...extra,
  });
  model.committed.orders.push(
    base('o1', 1711, 'sara', over.o1),
    base('o2', 1701, 'reem', over.o2),
    base('o3', 1696, 'hala', over.o3)
  );
  model.committed.items.push(
    { id: 'i1', orderId: 'o1', productId: 'p1' },
    { id: 'i2', orderId: 'o2', productId: 'p1' },
    { id: 'i3', orderId: 'o3', productId: 'p1' }
  );
  model.fallback.current = SARA;
}

const rowOf = (id: string) => model.committed.orders.find((r) => r.id === id) as Row;
const statusOf = (id: string) => rowOf(id).confirmationStatus;
const activities = (action?: string) => model.committed.activities.filter((a) => !action || a.action === action);

async function send(user: SessionUser, id: string, body: Record<string, unknown> = {}, over: { omitVersion?: boolean } = {}) {
  return als.run(user, async () => {
    const payload = { action: 'confirm', ...(over.omitVersion ? {} : { expectedVersion: rowOf(id).version }), ...body };
    const res = await POST(
      new Request('http://localhost/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
      { params: Promise.resolve({ id }) }
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  SARA = await person('sara', 'سارة', 'CONFIRMATION_AGENT', LIVE_AGENT);
  REEM = await person('reem', 'ريم', 'CONFIRMATION_AGENT', LIVE_AGENT);
  HALA = await person('hala', 'هالة', 'CONFIRMATION_AGENT', LIVE_AGENT);
  MANAGER = await person('mgr', 'المدير', 'MANAGER', LIVE_MANAGER);
  seed();
});

/** The first confirmed twin of the scenario: Sara's copy, confirmed an hour ago. */
const sarasYes = { confirmationStatus: 'CONFIRMED', status: 'CONFIRMED', confirmedAt: hoursAgo(1), confirmedById: 'sara' };

/* ═══════════════════ the owner's case ═══════════════════ */

describe('three copies of one order, three agents — the owner’s case', () => {
  it('one after the other: the first yes stands, the second and the third are refused and are told whose it is', async () => {
    const first = await send(SARA, 'o1');
    expect(first.status, JSON.stringify(first.body)).toBe(200);

    const second = await send(REEM, 'o2');
    const third = await send(HALA, 'o3');

    for (const refused of [second, third]) {
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      expect(refused.body.code).toBe('TWIN_CONFIRMED');
      const [named] = refused.body.twins as { orderNumber: string; confirmedByName: string }[];
      expect(named.orderNumber).toBe('ORD-2026-1711');
      expect(named.confirmedByName).toBe('سارة');
    }
    expect([statusOf('o1'), statusOf('o2'), statusOf('o3')]).toEqual(['CONFIRMED', 'IN_PROGRESS', 'IN_PROGRESS']);
  });

  it('all three pressing in the same instant: they queue at the customer’s lock and exactly one yes comes out', async () => {
    const [a, b, c] = await Promise.all([send(SARA, 'o1'), send(REEM, 'o2'), send(HALA, 'o3')]);

    const answers = [a, b, c].map((r) => r.status).sort();
    expect(answers, JSON.stringify([a.body, b.body, c.body])).toEqual([200, 409, 409]);
    expect([statusOf('o1'), statusOf('o2'), statusOf('o3')].filter((s) => s === 'CONFIRMED')).toHaveLength(1);
    expect(reserveOrderLines).toHaveBeenCalledTimes(1);
    // …and the two refused were not refused blindly: each is told the number that won.
    const winner = [a, b, c].findIndex((r) => r.status === 200);
    const winnerNumber = ['ORD-2026-1711', 'ORD-2026-1701', 'ORD-2026-1696'][winner];
    for (const r of [a, b, c].filter((x) => x.status === 409)) {
      expect((r.body.twins as { orderNumber: string }[]).map((t) => t.orderNumber)).toEqual([winnerNumber]);
    }
  });

  it('the lock really serialised them: the second transaction was granted it only after the first had committed', async () => {
    await Promise.all([send(SARA, 'o1'), send(REEM, 'o2')]);
    const log = model.log;
    const granted = log.findIndex((l) => l.includes(':lock-granted:'));
    const secondGranted = log.findIndex((l, i) => i > granted && l.includes(':lock-granted:'));
    const firstCommit = log.findIndex((l) => l.endsWith(':commit') || l.endsWith(':rollback'));
    expect(secondGranted, log.join('\n')).toBeGreaterThan(firstCommit);
  });

  it('then each refused agent rejects her copy as a duplicate with the reason that already exists — one confirmed, two rejected, one parcel', async () => {
    await send(SARA, 'o1');
    const refusedByReem = await send(REEM, 'o2');
    const refusedByHala = await send(HALA, 'o3');
    expect([refusedByReem.status, refusedByHala.status]).toEqual([409, 409]);

    const rejectedByReem = await send(REEM, 'o2', { action: 'reject', rejectionReason: 'DUPLICATE_ORDER' });
    const rejectedByHala = await send(HALA, 'o3', { action: 'reject', rejectionReason: 'DUPLICATE_ORDER' });

    expect([rejectedByReem.status, rejectedByHala.status]).toEqual([200, 200]);
    expect([statusOf('o1'), statusOf('o2'), statusOf('o3')]).toEqual(['CONFIRMED', 'REJECTED', 'REJECTED']);
    expect(endOrder).toHaveBeenCalledTimes(2);
    expect(endOrder.mock.calls[0][0]).toMatchObject({ orderId: 'o2', endAs: 'REJECTED', data: { rejectionReason: 'DUPLICATE_ORDER' } });
  });

  it('the customer who really wants two: she confirms the second with her word and both stand — and the history says she knew', async () => {
    await send(SARA, 'o1');
    const second = await send(REEM, 'o2', { acknowledgeTwin: true });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect([statusOf('o1'), statusOf('o2')]).toEqual(['CONFIRMED', 'CONFIRMED']);
    expect(activities('TWIN_CONFIRM_ACKNOWLEDGED')).toHaveLength(1);
  });
});

/* ═══════════════════ the refusal ═══════════════════ */

describe('the 409', () => {
  beforeEach(() => {
    seed({ o3: sarasYes });
  });

  it('is { error, errorAr, code, twins } — the sentence twice, the code, and the other order by number, time and colleague', async () => {
    const res = await send(SARA, 'o1');
    expect(res.status).toBe(409);
    expect(Object.keys(res.body).sort()).toEqual(['code', 'error', 'errorAr', 'twins']);
    expect(res.body.code).toBe('TWIN_CONFIRMED');
    expect(res.body.error).toBe(twinConfirmedSentence(['ORD-2026-1696']));
    expect(res.body.errorAr).toBe(res.body.error);
    const [t] = res.body.twins as Row[];
    expect(Object.keys(t).sort()).toEqual(['confirmedAt', 'confirmedByName', 'orderNumber']);
    expect(t.orderNumber).toBe('ORD-2026-1696');
    expect(t.confirmedByName).toBe('سارة');
    expect(new Date(t.confirmedAt as string).getTime()).toBeGreaterThan(Date.now() - 2 * 3_600_000);
  });

  it('carries no customer data and no id — not even the twin’s own row id', async () => {
    model.committed.orders.forEach((o) => Object.assign(o, { customer: { fullName: 'سعاد محمود', phone: '0790000000', address: 'عمّان - الجبيهة' } }));
    const said = JSON.stringify((await send(SARA, 'o1')).body);
    for (const leak of ['سعاد', '0790000000', 'الجبيهة', 'cu1', '"o3"', 'o3"', 'p1']) expect(said, leak).not.toContain(leak);
  });

  it('writes NOTHING: the order keeps its status and its version, no log, no activity, no reservation, no event', async () => {
    const before = JSON.stringify(rowOf('o1'));
    await send(SARA, 'o1');
    expect(JSON.stringify(rowOf('o1'))).toBe(before);
    expect(model.committed.statusLogs).toEqual([]);
    expect(model.committed.activities).toEqual([]);
    expect(reserveOrderLines).not.toHaveBeenCalled();
    expect(model.log.filter((l) => l.endsWith(':update'))).toEqual([]);
    expect(model.log[model.log.length - 1]).toMatch(/:rollback$/);
  });

  it('is a 409 and never a 500, whoever asks and however many twins there are', async () => {
    seed({ o2: sarasYes, o3: sarasYes });
    for (const who of [[SARA, 'o1'], [MANAGER, 'o1']] as const) {
      const res = await send(who[0], who[1]);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('TWIN_CONFIRMED');
      expect((res.body.twins as unknown[]).length).toBe(2);
    }
  });

  it('names at most five, however many there are', async () => {
    seed({ o3: sarasYes });
    for (let i = 0; i < 7; i++) {
      model.committed.orders.push({ ...rowOf('o3'), id: `x${i}`, orderNumber: `ORD-X${i}`, confirmedAt: hoursAgo(10 + i) });
      model.committed.items.push({ id: `ix${i}`, orderId: `x${i}`, productId: 'p1' });
    }
    expect(((await send(SARA, 'o1')).body.twins as unknown[]).length).toBe(5);
  });
});

/* ═══════════════════ her word ═══════════════════ */

describe('acknowledgeTwin: true — «طلب تاني فعلاً»', () => {
  beforeEach(() => {
    seed({ o3: sarasYes });
  });

  it('goes through: confirmed, written once, reserved once, the status log written as for any yes', async () => {
    const res = await send(REEM, 'o2', { acknowledgeTwin: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(statusOf('o2')).toBe('CONFIRMED');
    expect(rowOf('o2')).toMatchObject({ confirmedById: 'reem', version: 4 });
    expect(reserveOrderLines).toHaveBeenCalledTimes(1);
    expect(model.committed.statusLogs).toHaveLength(1);
  });

  it('and leaves ONE history row in her name, naming the orders she was told about, and nothing else', async () => {
    await send(REEM, 'o2', { acknowledgeTwin: true });
    const rows = activities('TWIN_CONFIRM_ACKNOWLEDGED');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      companyId: 'c1',
      orderId: 'o2',
      userId: 'reem',
      action: 'TWIN_CONFIRM_ACKNOWLEDGED',
      metadata: JSON.stringify({ twins: ['ORD-2026-1696'] }),
    });
  });

  it('only a literal true counts — a string, a number, an object or nothing leaves the refusal where it was', async () => {
    for (const word of ['true', 'yes', 1, {}, [], null, false]) {
      const res = await send(REEM, 'o2', { acknowledgeTwin: word });
      expect(res.status, JSON.stringify(word)).toBe(409);
    }
    expect(statusOf('o2')).toBe('IN_PROGRESS');
  });

  it('with no twin there is nothing to acknowledge: it confirms and writes no acknowledgement', async () => {
    seed();
    const res = await send(SARA, 'o1', { acknowledgeTwin: true });
    expect(res.status).toBe(200);
    expect(activities('TWIN_CONFIRM_ACKNOWLEDGED')).toEqual([]);
  });

  it('is read for `confirm` alone: it opens no other action (a reject with it is a reject, a cancel is still a manager’s)', async () => {
    const res = await send(REEM, 'o2', { action: 'reject', rejectionReason: 'DUPLICATE_ORDER', acknowledgeTwin: true });
    expect(res.status).toBe(200);
    expect(statusOf('o2')).toBe('REJECTED');
    expect(activities('TWIN_CONFIRM_ACKNOWLEDGED')).toEqual([]);
    const cancel = await send(REEM, 'o2', { action: 'cancel', note: 'تجربة الإلغاء', acknowledgeTwin: true });
    expect(cancel.status).toBe(403);
  });
});

/* ═══════════════════ the statements, in order ═══════════════════ */

describe('the statements, in the order they run — all inside ONE transaction', () => {
  it('lock → the order’s lines → the twins → the update → the status log, every one of them the same transaction’s', async () => {
    const res = await send(SARA, 'o1');
    expect(res.status).toBe(200);
    const mine = model.log.filter((l) => l.startsWith('tx1:'));
    expect(mine.map((l) => l.replace(/^tx1:/, '').replace(/^lock:.*/, 'lock').replace(/^lock-granted:.*/, 'granted'))).toEqual([
      'begin', 'lock', 'granted', 'lines', 'twins', 'update', 'statuslog', 'activity:STATUS_CHANGED', 'commit',
    ]);
    // nothing of the guard went through the root client — a lock taken there would be dropped in the same breath
    expect(model.log.filter((l) => l.startsWith('root:'))).toEqual([]);
  });

  it('the lock is one per CUSTOMER — «twin:<customerId>» — so two customers never wait for each other', async () => {
    await send(SARA, 'o1');
    expect(model.log).toContain('tx1:lock:twin:cu1');
    model.committed.orders.push({ ...rowOf('o2'), id: 'o9', orderNumber: 'ORD-9', customerId: 'cu2', claimedById: 'reem' });
    model.committed.items.push({ id: 'i9', orderId: 'o9', productId: 'p1' });
    const other = await send(REEM, 'o9');
    // the first customer's yes is no twin of the second customer's order, and the lock it took is a different one
    expect(other.status, JSON.stringify(other.body)).toBe(200);
    expect(model.log).toContain('tx2:lock:twin:cu2');
  });

  it('a different customer’s confirmed order of the same product is no twin (the lock is not the only thing that is per customer)', async () => {
    seed({ o3: { ...sarasYes, customerId: 'cu2' } });
    expect((await send(SARA, 'o1')).status).toBe(200);
  });

  it.each([
    ['start', { action: 'start' }, 'NEW'],
    ['contact_result', { action: 'contact_result', result: 'NO_ANSWER' }, 'IN_PROGRESS'],
    ['schedule_follow_up', { action: 'schedule_follow_up', nextFollowUpAt: new Date(Date.now() + 86_400_000).toISOString() }, 'IN_PROGRESS'],
  ])('%s takes no lock and reads no twins — even with a confirmed twin standing', async (_name, body, from) => {
    seed({ o1: { confirmationStatus: from }, o3: sarasYes });
    const res = await send(SARA, 'o1', body);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(model.log.some((l) => l.includes(':lock') || l.endsWith(':twins') || l.endsWith(':lines'))).toBe(false);
  });

  it.each([
    ['reject', { action: 'reject', rejectionReason: 'DUPLICATE_ORDER' }, 'reem', 'o2'],
    ['cancel', { action: 'cancel', note: 'الزبون ألغى بالهاتف' }, 'manager', 'o1'],
  ])('%s goes the way it always went (the ending helper) — no lock, no twin read', async (_name, body, who, id) => {
    seed({ o3: sarasYes });
    const res = await send(who === 'manager' ? MANAGER : REEM, id, body);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(endOrder).toHaveBeenCalledTimes(1);
    expect(model.log.some((l) => l.includes(':lock') || l.endsWith(':twins'))).toBe(false);
  });

  it('a replacement or a win-back repeats on purpose: no lock, no read, and it confirms with a twin standing', async () => {
    seed({ o1: { replacesOrderId: 'old-order' }, o3: sarasYes });
    const res = await send(SARA, 'o1');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(model.log.some((l) => l.includes(':lock') || l.endsWith(':twins') || l.endsWith(':lines'))).toBe(false);
  });
});

/* ═══════════════════ everything the door asked before ═══════════════════ */

describe('every refusal the door had stays where it was, and in its order', () => {
  beforeEach(() => {
    seed({ o3: sarasYes });
  });
  /** Did the confirming transaction, its lock or the twin read run at all? */
  const guardRan = () => model.log.some((l) => l.includes(':lock') || l.endsWith(':twins') || l.endsWith(':begin'));

  it('NOT_HELD first: an unheld order is refused 403 before the guard is asked, ack or no ack', async () => {
    seed({ o3: sarasYes, o1: { claimedById: null } });
    for (const body of [{}, { acknowledgeTwin: true }]) {
      const res = await send(SARA, 'o1', body);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('NOT_HELD');
      expect(res.body.errorAr).toBe(NOT_HELD_MESSAGE);
    }
    expect(guardRan()).toBe(false);
  });

  it('a colleague’s order is not hers either, with twins or without', async () => {
    const res = await send(SARA, 'o2', { acknowledgeTwin: true });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_HELD');
    expect(guardRan()).toBe(false);
  });

  it('the editing lock: an ACTIVE foreign lock is 423 before the guard', async () => {
    seed({ o3: sarasYes, o1: { lockedById: 'reem', lockExpiresAt: new Date(Date.now() + 600_000) } });
    const res = await send(SARA, 'o1');
    expect(res.status).toBe(423);
    expect(guardRan()).toBe(false);
  });

  it('contact first: no attempt on the order is 409 CONTACT_FIRST, not TWIN_CONFIRMED', async () => {
    model.setAttempts(0);
    const res = await send(SARA, 'o1');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONTACT_FIRST');
    expect(res.body.errorAr).toBe(CONTACT_FIRST_MESSAGE);
    expect(guardRan()).toBe(false);
  });

  it('region first: no governorate is 409 REGION_REQUIRED, not TWIN_CONFIRMED — even for the manager', async () => {
    seed({ o3: sarasYes, o1: { regionId: null, claimedById: null } });
    const res = await send(MANAGER, 'o1');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('REGION_REQUIRED');
    expect(res.body.errorAr).toBe(REGION_REQUIRED_MESSAGE);
    expect(guardRan()).toBe(false);
  });

  it('the transition table: a state the yes cannot come from is INVALID_TRANSITION, before the guard', async () => {
    seed({ o3: sarasYes, o1: { confirmationStatus: 'REJECTED' } });
    const res = await send(SARA, 'o1');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INVALID_TRANSITION');
    expect(guardRan()).toBe(false);
  });

  it('expectedVersion is still mandatory: without it 400 VERSION_REQUIRED, before the transaction and its lock', async () => {
    const res = await send(SARA, 'o1', {}, { omitVersion: true });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VERSION_REQUIRED');
    expect(guardRan()).toBe(false);
  });

  it('a stale version with no twin is still 409 VERSION_CONFLICT, and writes nothing', async () => {
    seed();
    const res = await send(SARA, 'o1', { expectedVersion: 1 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('VERSION_CONFLICT');
    expect(statusOf('o1')).toBe('IN_PROGRESS');
    expect(model.committed.statusLogs).toEqual([]);
  });

  it('a stale version WITH her acknowledgement is VERSION_CONFLICT and leaves no acknowledgement behind (the transaction rolled back)', async () => {
    const res = await send(SARA, 'o1', { expectedVersion: 1, acknowledgeTwin: true });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('VERSION_CONFLICT');
    expect(activities('TWIN_CONFIRM_ACKNOWLEDGED')).toEqual([]);
    expect(statusOf('o1')).toBe('IN_PROGRESS');
  });

  it('a stale version with a twin standing is asked the twin question first (it reads before it writes) — the answer is a 409 either way', async () => {
    const res = await send(SARA, 'o1', { expectedVersion: 1 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TWIN_CONFIRMED');
  });
});

/* ═══════════════════ the real engine ═══════════════════ */

describe('through the REAL permission engine — a bound agent, and the people who are not', () => {
  beforeEach(() => {
    seed({ o3: sarasYes });
  });

  it('the agent who holds her copy: refused with the twin question, then confirmed with her word — hold and acknowledgement together', async () => {
    const asked = await send(REEM, 'o2');
    expect(asked.status).toBe(409);
    expect(asked.body.code).toBe('TWIN_CONFIRMED');
    const answered = await send(REEM, 'o2', { acknowledgeTwin: true });
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    expect(statusOf('o2')).toBe('CONFIRMED');
  });

  it('her word does not open a door she is bound by: an order nobody holds is still NOT_HELD with the acknowledgement', async () => {
    seed({ o3: sarasYes, o2: { claimedById: null } });
    const res = await send(REEM, 'o2', { acknowledgeTwin: true });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_HELD');
    expect(statusOf('o2')).toBe('IN_PROGRESS');
  });

  it('the manager (not bound by the holder rule) is asked the same question and answers it the same way', async () => {
    seed({ o3: sarasYes, o1: { claimedById: null } });
    const asked = await send(MANAGER, 'o1');
    expect(asked.body.code).toBe('TWIN_CONFIRMED');
    const answered = await send(MANAGER, 'o1', { acknowledgeTwin: true });
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    expect(activities('TWIN_CONFIRM_ACKNOWLEDGED')[0]).toMatchObject({ userId: 'mgr' });
  });
});

/* ═══════════════════ what the twin must be ═══════════════════ */

describe('the door asks the right question of the database', () => {
  it.each([
    ['a twin the courier already has', { shippingStatus: 'SHIPPED' }],
    ['a twin on a trolley the press has closed', { shippingBatchId: 'b1', shippingBatch: { status: 'CLOSED' } }],
    ['a twin that was cancelled', { confirmationStatus: 'CANCELLED' }],
    ['a twin that was rejected', { confirmationStatus: 'REJECTED' }],
    ['a twin older than seventy-two hours', { createdAt: hoursAgo(73) }],
  ])('%s is no twin: the second yes goes through', async (name, over) => {
    seed({ o3: { ...sarasYes, ...over } });
    const res = await send(SARA, 'o1');
    expect(res.status, name + ' ' + JSON.stringify(res.body)).toBe(200);
  });

  it('a confirmed order of ANOTHER product is no twin: the second yes goes through', async () => {
    seed({ o3: sarasYes });
    rowOf('o3').productId = 'p9';
    model.committed.items.find((i) => i.orderId === 'o3')!.productId = 'p9';
    const res = await send(SARA, 'o1');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it.each([
    ['a parcel packed and labelled on an OPEN trolley', { shippingStatus: 'READY_FOR_PICKUP', labelPrintedAt: hoursAgo(1), shippingBatchId: 'b1', shippingBatch: { status: 'READY' } }],
    ['a twin still being packed', { shippingStatus: 'PACKING' }],
    ['a twin 71 hours old', { createdAt: hoursAgo(71) }],
  ])('%s IS a twin (the owner’s line: until «إغلاق الشحنة» it is still ours)', async (_name, over) => {
    seed({ o3: { ...sarasYes, ...over } });
    const res = await send(SARA, 'o1');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TWIN_CONFIRMED');
  });

  it('a basket whose second line repeats the twin’s product is a repeat', async () => {
    seed({ o3: sarasYes });
    rowOf('o1').productId = 'p-head';
    model.committed.items.push({ id: 'i1b', orderId: 'o1', productId: 'p1' });
    model.committed.items.find((i) => i.id === 'i1')!.productId = 'p-head';
    expect((await send(SARA, 'o1')).status).toBe(409);
  });
});

/* ═══════════════════ where it stands in the file ═══════════════════ */

describe('where the guard stands in the door’s source', () => {
  const door = stripComments(readFileSync(join(process.cwd(), 'src/app/api/orders/[id]/confirmation/route.ts'), 'utf8'));
  const tx = door.slice(door.indexOf('db.$transaction(async (tx) => {'));

  it('is asked INSIDE the non-reject transaction, with its client, before the first write — and only for `confirm`', () => {
    expect(door.indexOf('db.$transaction(')).toBeGreaterThan(door.indexOf('endOrder({'));
    expect(tx).toMatch(/if \(action === 'confirm'\) \{\s*const twins = await guardConfirmAgainstTwins\(tx, \{/);
    expect(tx.indexOf('guardConfirmAgainstTwins(tx')).toBeLessThan(tx.indexOf('tx.order.updateMany'));
    expect(tx.indexOf('guardConfirmAgainstTwins(tx')).toBeGreaterThan(-1);
  });

  it('comes after every refusal it must not outrank, in the source as in the behaviour', () => {
    const guard = door.indexOf('guardConfirmAgainstTwins(tx');
    for (const earlier of [
      "authorize(user, 'orders.confirm', order)",
      'mustHoldToWork(',
      'order.lockedById &&',
      'needsContactFirst({',
      'needsRegionFirst(order)',
      'isValidTransition(from, target)',
      "typeof expectedVersion !== 'number'",
    ]) {
      expect(door.indexOf(earlier), earlier).toBeGreaterThan(-1);
      expect(door.indexOf(earlier), earlier).toBeLessThan(guard);
    }
  });

  it('refuses with the sentinel, answers it as a 409 in the catch before the generic handler, and asks for a literal true', () => {
    expect(tx).toContain('if (acknowledgeTwin !== true) throw new TwinConfirmedRefusal(twins);');
    const catchAt = door.indexOf('catch (error: any)');
    expect(door.indexOf('error instanceof TwinConfirmedRefusal', catchAt)).toBeGreaterThan(catchAt);
    expect(door.indexOf('error instanceof TwinConfirmedRefusal', catchAt)).toBeLessThan(door.indexOf('apiError(error)'));
    expect(door).toMatch(/NextResponse\.json\(twinConfirmedBody\(error\.twins\), \{ status: 409 \}\)/);
  });

  it('never writes the acknowledgement itself — the screens do, through one body builder — and records it through the helper', () => {
    expect(door).not.toMatch(/acknowledgeTwin:\s*true/);
    expect(door).toContain('recordTwinAcknowledged(tx,');
  });

  it('exports only its handler: a route file may not export a helper (the build refuses it)', () => {
    expect([...door.matchAll(/^export (?:async )?(?:function|const) (\w+)/gm)].map((m) => m[1])).toEqual(['POST']);
  });
});
