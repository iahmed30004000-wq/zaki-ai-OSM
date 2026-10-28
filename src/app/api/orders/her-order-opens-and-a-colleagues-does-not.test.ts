import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «طلباتي» WITHOUT «عرض الطلبات» — EVERY DOOR SHE WORKS AN ORDER THROUGH.
 *
 * «كموظف تأكيد ماتقدر تسحب او تعدل على طلب الا اذا كانت ظاهرة عندك كل
 * الطلبات اللي بالموقع..»
 *
 * The REAL routes, the REAL `rbac.ts` and the REAL `authorization.ts`, with a
 * session holding the shipped agent's keys and «عرض الطلبات» unticked. The
 * database is a small table that answers each query by its WHERE — so a door
 * that asks the wrong question gets the wrong row back, instead of whatever a
 * mock was told to return. Every test has the two halves:
 *
 *   · her own order opens, takes a call, a lock and an edit, is decided,
 *     given back, asked about and read for its customer's history — and the
 *     next pull is no longer refused for it;
 *   · a colleague's order, an order she holds in another store, and an order
 *     of the pool she never pulled answer 404 at every one of those doors,
 *     with nothing written and no model asked; the list and the pool stay
 *     403; the moderator is still kept off the queue.
 * ═══════════════════════════════════════════════════════════════════════
 */

type Row = Record<string, unknown>;

const { fake, state, aiChat, reserveOrderLines } = vi.hoisted(() => {
  const tables = {
    orders: [] as Row[],
    attempts: [] as Row[],
    notes: [] as Row[],
    requests: [] as Row[],
    issues: [] as Row[],
    customers: [] as Row[],
    users: [] as Row[],
  };
  /** Every write any door makes, by model and verb — «nothing written» is this list being empty. */
  const writes: string[] = [];

  const same = (a: unknown, b: unknown) =>
    a instanceof Date || b instanceof Date ? +new Date(a as Date) === +new Date(b as Date) : a === b;

  /** One field against one filter: a value, null, or the operators these doors use. */
  function holds(value: unknown, filter: unknown): boolean {
    if (filter === null) return value === null || value === undefined;
    if (typeof filter !== 'object' || filter instanceof Date) return same(value ?? null, filter);
    return Object.entries(filter as Record<string, unknown>).every(([op, arg]) => {
      switch (op) {
        case 'in':
          return (arg as unknown[]).some((x) => same(value, x));
        case 'notIn':
          return !(arg as unknown[]).some((x) => same(value, x));
        case 'not':
          return !holds(value, arg);
        case 'equals':
          return holds(value, arg);
        case 'lt':
          return value != null && +(value as number) < +(arg as number);
        case 'lte':
          return value != null && +(value as number) <= +(arg as number);
        case 'gt':
          return value != null && +(value as number) > +(arg as number);
        case 'gte':
          return value != null && +(value as number) >= +(arg as number);
        default:
          throw new Error(`the fake table does not know «${op}» — teach it before trusting it`);
      }
    });
  }

  function matches(row: Row, where: unknown): boolean {
    if (!where) return true;
    return Object.entries(where as Record<string, unknown>).every(([key, value]) => {
      if (key === 'AND') return (Array.isArray(value) ? value : [value]).every((w) => matches(row, w));
      if (key === 'OR') return (value as unknown[]).some((w) => matches(row, w));
      if (key === 'NOT') return !(Array.isArray(value) ? value : [value]).some((w) => matches(row, w));
      if (key === 'contactAttempts') {
        const theirs = tables.attempts.filter((a) => a.orderId === row.id);
        const rel = value as { none?: unknown; some?: unknown };
        if ('none' in rel) return !theirs.some((a) => matches(a, rel.none));
        if ('some' in rel) return theirs.some((a) => matches(a, rel.some));
      }
      return holds(row[key], value);
    });
  }

  function apply(row: Row, data: Row) {
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === 'object' && !(v instanceof Date) && 'increment' in v) {
        row[k] = Number(row[k] ?? 0) + Number((v as { increment: number }).increment);
      } else row[k] = v;
    }
  }

  let seq = 0;
  const table = (name: keyof typeof tables, model: string) => ({
    findFirst: async (q: { where?: unknown } = {}) => {
      const hit = tables[name].find((r) => matches(r, q.where));
      return hit ? { ...hit } : null;
    },
    findUnique: async (q: { where: unknown }) => {
      const hit = tables[name].find((r) => matches(r, q.where));
      return hit ? { ...hit } : null;
    },
    findMany: async (q: { where?: unknown } = {}) => tables[name].filter((r) => matches(r, q.where)).map((r) => ({ ...r })),
    count: async (q: { where?: unknown } = {}) => tables[name].filter((r) => matches(r, q.where)).length,
    create: async (q: { data: Row }) => {
      writes.push(`${model}.create`);
      const created = { id: `${model}-${++seq}`, createdAt: new Date(), ...q.data };
      tables[name].push(created);
      return { ...created };
    },
    update: async (q: { where: unknown; data: Row }) => {
      writes.push(`${model}.update`);
      const hit = tables[name].find((r) => matches(r, q.where));
      if (!hit) throw new Error(`${model}.update: no row`);
      apply(hit, q.data);
      return { ...hit };
    },
    updateMany: async (q: { where: unknown; data: Row }) => {
      const hits = tables[name].filter((r) => matches(r, q.where));
      if (hits.length) writes.push(`${model}.updateMany`);
      for (const h of hits) apply(h, q.data);
      return { count: hits.length };
    },
  });

  const recorded = (model: string) => ({
    create: async (q: { data: Row }) => {
      writes.push(`${model}.create`);
      return { id: `${model}-${++seq}`, ...q.data };
    },
    createMany: async () => {
      writes.push(`${model}.createMany`);
      return { count: 0 };
    },
    deleteMany: async () => {
      writes.push(`${model}.deleteMany`);
      return { count: 0 };
    },
  });

  const db: Row = {
    order: { ...table('orders', 'order'), groupBy: async () => [] },
    orderContactAttempt: {
      ...table('attempts', 'orderContactAttempt'),
      // The last attempt first, the way the attempt-number query asks for it.
      findFirst: async (q: { where?: unknown }) => {
        const hits = tables.attempts.filter((r) => matches(r, q.where));
        return hits.length ? { ...hits.sort((a, b) => Number(b.attemptNumber) - Number(a.attemptNumber))[0] } : null;
      },
    },
    orderNote: table('notes', 'orderNote'),
    orderChangeRequest: table('requests', 'orderChangeRequest'),
    orderIssue: table('issues', 'orderIssue'),
    customer: table('customers', 'customer'),
    user: table('users', 'user'),
    shippingBatch: { findFirst: async () => null },
    returnReceipt: { count: async () => 0 },
    orderClaimHistory: recorded('orderClaimHistory'),
    orderActivity: recorded('orderActivity'),
    orderStatusLog: recorded('orderStatusLog'),
    orderItem: recorded('orderItem'),
  };
  db.$transaction = async (fn: (tx: Row) => unknown) => fn(db);

  return {
    fake: { db, tables, writes },
    state: { user: null as unknown as SessionUser, storeId: 's1' },
    aiChat: vi.fn(async () => 'ابدئي بالسلام عليكم'),
    reserveOrderLines: vi.fn(async () => undefined),
  };
});

vi.mock('@/lib/db', () => ({ db: fake.db }));
vi.mock('@/lib/geo-context', () => ({
  requireContext: async () => ({
    user: state.user,
    companyId: 'c1',
    storeId: state.storeId,
    countryId: 'co1',
    country: {
      id: 'co1', code: 'JO', name: 'الأردن', currencyCode: 'JOD', minorUnit: 3, timezone: 'Asia/Amman',
      workHoursStart: '00:00', workHoursEnd: '23:59', weekendDays: [], allowNegativeStock: false,
    },
  }),
}));
// `requirePermission` is the real one; only the session it reads is this test's.
vi.mock('@/lib/auth', () => ({ requireAuth: async () => state.user }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(), redactCustomerForAudit: (c: unknown) => c }));
vi.mock('@/lib/notification', () => ({ createNotification: vi.fn(async () => 0) }));
vi.mock('@/lib/notify', () => ({ notify: vi.fn(), afterResponse: vi.fn() }));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: vi.fn() }));
vi.mock('@/lib/apps/events', () => ({ emitAppEvent: vi.fn() }));
vi.mock('@/lib/conversions/emit', () => ({ queueConversions: vi.fn() }));
vi.mock('@/lib/reservation', () => ({ reserveOrderLines, releaseOrderLines: vi.fn() }));
vi.mock('@/lib/order-timeline', () => ({ orderTimeline: async () => [] }));
vi.mock('@/lib/customer-risk', () => ({
  customerRisk: async () => ({ tier: 'SAFE', returnRate: 0, orders: 1, returns: 0, requiresPrepaymentOrApproval: false }),
  customerHistory: async () => [],
}));
vi.mock('@/lib/ai-rate', () => ({ tooManyAiCalls: () => null }));
vi.mock('@/lib/ai-provider', () => ({
  aiChat,
  describeRoute: async () => ({ provider: 'LOCAL', model: 'llama3.1:8b', keyFrom: 'none', baseUrl: 'http://127.0.0.1:11434' }),
  AiNotConfigured: class AiNotConfigured extends Error {},
}));

import * as orderRoute from '@/app/api/orders/[id]/route';
import * as listRoute from '@/app/api/orders/route';
import * as timelineRoute from '@/app/api/orders/[id]/timeline/route';
import * as notesRoute from '@/app/api/orders/[id]/notes/route';
import * as attemptsRoute from '@/app/api/orders/[id]/contact-attempts/route';
import * as lockRoute from '@/app/api/orders/[id]/lock/route';
import * as confirmationRoute from '@/app/api/orders/[id]/confirmation/route';
import * as claimRoute from '@/app/api/orders/[id]/claim/route';
import * as changeRequestsRoute from '@/app/api/orders/[id]/change-requests/route';
import * as shapeRiskRoute from '@/app/api/orders/[id]/shape-risk/route';
import * as issuesRoute from '@/app/api/confirmation/issues/route';
import * as historyRoute from '@/app/api/customers/[id]/history/route';
import * as assistantRoute from '@/app/api/ai/confirmation/route';
import * as pullRoute from '@/app/api/confirmation/pull/route';
import * as queueRoute from '@/app/api/confirmation/queue/route';
import * as mineRoute from '@/app/api/confirmation/mine/route';

/* ─────────────────────────────── who ─────────────────────────────── */

type Scope = 'ALL_COMPANY' | 'ASSIGNED' | 'OWN';
function person(id: string, role: string, grants: Record<string, Scope>): SessionUser {
  return {
    id, email: `${id}@x.test`, name: id === 'u1' ? 'سارة' : id, role: role as SessionUser['role'], status: 'ACTIVE',
    companyId: 'c1', permissions: Object.keys(grants),
    effectiveGrants: {
      fullAccess: false,
      grants: Object.fromEntries(Object.entries(grants).map(([k, scope]) => [k, { scope, scopeIds: null }])),
    },
  };
}

/**
 * The shipped «موظف التأكيد» (permission-engine migration + stage 2 + 15/10),
 * with «عرض الطلبات» unticked — and «إشكالات الإدخال» added, so the issue
 * door is asked about the ORDER rather than refusing on the key.
 */
const AGENT = person('u1', 'CONFIRMATION_AGENT', {
  'dashboard.view': 'ALL_COMPANY',
  'orders.edit': 'ASSIGNED',
  'orders.claim': 'ALL_COMPANY',
  'orders.release': 'ALL_COMPANY',
  'orders.confirm': 'ALL_COMPANY',
  'orders.contact_log': 'ALL_COMPANY',
  'customers.view_basic': 'ALL_COMPANY',
  'products.view': 'ALL_COMPANY',
  'ai.use': 'ALL_COMPANY',
  'confirmation.pull': 'ALL_COMPANY',
  'confirmation.work': 'ALL_COMPANY',
  'confirmation.issues': 'ALL_COMPANY',
});
/** The moderator's template since 14/10: his own entries; no pull, no work, no supervise. */
const MODERATOR = person('m1', 'MODERATOR', {
  'orders.view': 'OWN',
  'orders.create': 'ALL_COMPANY',
  'orders.edit': 'OWN',
  'orders.claim': 'ALL_COMPANY',
  'orders.confirm': 'ALL_COMPANY',
  'customers.view_basic': 'ALL_COMPANY',
  'confirmation.issues': 'ALL_COMPANY',
});

/* ─────────────────────────────── what ─────────────────────────────── */

const HERS = '11111111-1111-4111-8111-111111111111';
const COLLEAGUES = '22222222-2222-4222-8222-222222222222';
const OTHER_STORE = '33333333-3333-4333-8333-333333333333';
const POOL = '44444444-4444-4444-8444-444444444444';
const MODERATORS_HELD = '55555555-5555-4555-8555-555555555555';

function order(id: string, over: Row = {}): Row {
  return {
    id, orderNumber: `JO-${id.slice(0, 4)}`, companyId: 'c1', storeId: 's1', customerId: 'cu1',
    claimedById: 'u1', claimedAt: new Date(), currentOwnerId: 'u1', assignedToId: null, createdById: null,
    moderatorId: 'mod-7', confirmationStatus: 'IN_PROGRESS', status: 'IN_PROGRESS', shippingStatus: 'NOT_READY',
    signatureStatus: 'UNSIGNED', settlementStatus: 'NOT_APPLICABLE', version: 3,
    lockedById: null, lockedAt: null, lockExpiresAt: null, nextFollowUpAt: null, followUpStatus: null,
    confirmedAt: null, postponedUntil: null, shippedAt: null, labelPrintedAt: null,
    totalAmount: 25, currency: 'JOD', sellingPrice: 25, quantity: 1, productId: 'p1', regionId: null,
    deliveryFee: 0, shippingCost: 0, discountAmount: 0, priceIncludesDelivery: false, customerNotes: null,
    source: 'MANUAL', createdAt: new Date('2026-10-27T08:00:00.000Z'),
    // What the reads include, carried on the row so a door that includes them gets them.
    customer: { id: 'cu1', fullName: 'سعاد', phone: '0790000000', rawPhone: '0790000000', address: 'عمّان', city: 'عمّان' },
    items: [{ id: `it-${id.slice(0, 4)}`, productId: 'p1', productName: 'كريم', quantity: 1, freeQuantity: 0, unitPrice: 25, lineTotal: 25 }],
    commissions: [], addOns: [], claimHistory: [], callLogs: [], activities: [], telegramMessages: [],
    _count: { contactAttempts: 0, deliveryAttempts: 0 },
    ...over,
  };
}

function seed() {
  fake.tables.orders.splice(0, Infinity,
    order(HERS),
    // Transferred to a colleague and pulled by her since: the stale `assignedToId` is still Sara's.
    order(COLLEAGUES, { claimedById: 'u2', currentOwnerId: 'u2', assignedToId: 'u1' }),
    order(OTHER_STORE, { storeId: 's2' }),
    order(POOL, { claimedById: null, claimedAt: null, currentOwnerId: null, confirmationStatus: 'NEW', status: 'NEW' }),
    order(MODERATORS_HELD, { claimedById: 'm1', currentOwnerId: 'm1', moderatorId: 'mod-7' }),
  );
  for (const t of ['attempts', 'notes', 'requests', 'issues'] as const) fake.tables[t].splice(0, Infinity);
  fake.tables.customers.splice(0, Infinity, { id: 'cu1', companyId: 'c1', storeId: 's1', fullName: 'سعاد', phone: '0790000000' });
  fake.tables.users.splice(0, Infinity, { id: 'u1', name: 'سارة' }, { id: 'u2', name: 'ريم' });
  fake.writes.splice(0, Infinity);
}

/** She rang: a contact attempt on her order, as the strip would have written it. */
const rang = (orderId = HERS) =>
  fake.tables.attempts.push({ id: `a-${orderId}`, orderId, companyId: 'c1', employeeId: 'u1', attemptNumber: 1, result: 'NO_ANSWER' });

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const json = (body: unknown, method = 'POST', url = 'http://x/') =>
  new Request(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/* ───────────────────────── every door she works through ───────────────────────── */

interface Door {
  name: string;
  call: (id: string) => Promise<Response>;
  /** The history refuses in its own words, with 403 — every other door says «not found». */
  refused: number;
}

const DOORS: Door[] = [
  { name: 'GET /api/orders/[id]', refused: 404, call: (id) => orderRoute.GET(new Request(`http://x/api/orders/${id}`), params(id)) },
  { name: 'GET …/timeline', refused: 404, call: (id) => timelineRoute.GET(new Request('http://x/'), params(id)) },
  { name: 'GET …/notes', refused: 404, call: (id) => notesRoute.GET(new Request('http://x/'), params(id)) },
  { name: 'POST …/notes', refused: 404, call: (id) => notesRoute.POST(json({ body: 'الزبون طلب يتصلوا بعد المغرب' }), params(id)) },
  { name: 'GET …/contact-attempts', refused: 404, call: (id) => attemptsRoute.GET(new Request('http://x/'), params(id)) },
  {
    name: 'POST …/contact-attempts', refused: 404,
    call: (id) => attemptsRoute.POST(json({ contactMethod: 'PHONE', result: 'NO_ANSWER' }), params(id)),
  },
  { name: 'POST …/lock', refused: 404, call: (id) => lockRoute.POST(new Request('http://x/', { method: 'POST' }), params(id)) },
  {
    name: 'PATCH /api/orders/[id]', refused: 404,
    call: (id) => orderRoute.PATCH(json({ expectedVersion: 3, customerAddress: 'الدوار السابع' }, 'PATCH'), params(id)),
  },
  {
    name: 'POST …/confirmation', refused: 404,
    call: (id) => confirmationRoute.POST(json({ action: 'confirm', expectedVersion: 3 }), params(id)),
  },
  {
    name: 'DELETE …/claim', refused: 404,
    call: (id) => claimRoute.DELETE(new Request('http://x/?reason=%D8%A7%D9%86%D8%AA%D9%87%D9%89', { method: 'DELETE' }), params(id)),
  },
  {
    name: 'POST …/change-requests', refused: 404,
    call: (id) =>
      changeRequestsRoute.POST(
        json({ intent: 'EDIT', reason: 'الزبون غيّر العنوان', changes: { customerAddress: { to: 'الدوار السابع' } } }),
        params(id)
      ),
  },
  { name: 'GET …/shape-risk', refused: 404, call: (id) => shapeRiskRoute.GET(new Request('http://x/'), params(id)) },
  {
    name: 'POST /api/confirmation/issues', refused: 404,
    call: (id) => issuesRoute.POST(json({ orderId: id, reason: 'WRONG_ADDRESS' })),
  },
  { name: 'POST /api/ai/confirmation', refused: 404, call: (id) => assistantRoute.POST(json({ orderId: id })) },
  {
    name: 'GET /api/customers/[id]/history', refused: 403,
    call: (id) => historyRoute.GET(new Request(`http://x/api/customers/cu1/history?exclude=${id}`), params('cu1')),
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  seed();
  state.user = AGENT;
  state.storeId = 's1';
});

describe('NEGATIVE: what is not hers stays shut, at every door — and nothing is written', () => {
  describe.each([
    ['a colleague’s order (transferred away from her; the stale assignment still names her)', COLLEAGUES],
    ['an order she holds in ANOTHER store, while she stands in this one', OTHER_STORE],
    ['an order of the pool she never pulled', POOL],
  ])('%s', (_name, id) => {
    it.each(DOORS.map((d) => [d.name, d] as const))('%s', async (_door, door) => {
      rang(id); // even a call on record does not make it hers
      fake.writes.splice(0, Infinity);
      const res = await door.call(id);
      expect(res.status, `${door.name} فتح طلباً ليس بين يديها`).toBe(door.refused);
      expect(fake.writes, `${door.name} كتب على طلب ليس لها`).toEqual([]);
      expect(aiChat, 'سُئل النموذج عن طلب ليس لها').not.toHaveBeenCalled();
    });
  });

  it('and «الطلبات» — the list, and the pool by query string — stay 403', async () => {
    expect((await listRoute.GET(new Request('http://x/api/orders'))).status).toBe(403);
    expect((await listRoute.GET(new Request('http://x/api/orders?queue=available'))).status).toBe(403);
  });

  it('and auto-released, then pulled by a colleague: gone from her doors', async () => {
    // The same order, after the ninety-minute release and somebody else's pull.
    const row = fake.tables.orders.find((o) => o.id === HERS)!;
    Object.assign(row, { claimedById: 'u2', currentOwnerId: 'u2', claimedAt: new Date() });
    expect((await orderRoute.GET(new Request('http://x/'), params(HERS))).status).toBe(404);
    expect((await confirmationRoute.POST(json({ action: 'confirm', expectedVersion: 3 }), params(HERS))).status).toBe(404);
  });
});

describe('POSITIVE: the order she holds is worked from start to finish without «عرض الطلبات»', () => {
  it('opens — and offers no neighbours to walk to', async () => {
    const res = await orderRoute.GET(new Request(`http://x/api/orders/${HERS}`), params(HERS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.order.id).toBe(HERS);
    expect(body.previousOrderId).toBeNull();
    expect(body.nextOrderId).toBeNull();
  });

  it('its history, notes and calls read; a note is written', async () => {
    expect((await timelineRoute.GET(new Request('http://x/'), params(HERS))).status).toBe(200);
    expect((await notesRoute.GET(new Request('http://x/'), params(HERS))).status).toBe(200);
    expect((await attemptsRoute.GET(new Request('http://x/'), params(HERS))).status).toBe(200);
    expect((await shapeRiskRoute.GET(new Request('http://x/'), params(HERS))).status).toBe(200);
    const note = await notesRoute.POST(json({ body: 'الزبون طلب يتصلوا بعد المغرب' }), params(HERS));
    expect(note.status).toBe(201);
    expect(fake.tables.notes.map((n) => n.orderId)).toEqual([HERS]);
  });

  it('a call is recorded on it', async () => {
    const res = await attemptsRoute.POST(json({ contactMethod: 'PHONE', result: 'NO_ANSWER' }), params(HERS));
    expect(res.status).toBe(200);
    expect(fake.tables.attempts).toMatchObject([{ orderId: HERS, employeeId: 'u1', result: 'NO_ANSWER' }]);
  });

  it('it is locked and the customer’s address corrected', async () => {
    rang();
    expect((await lockRoute.POST(new Request('http://x/', { method: 'POST' }), params(HERS))).status).toBe(200);
    expect(fake.tables.orders.find((o) => o.id === HERS)!.lockedById).toBe('u1');

    const res = await orderRoute.PATCH(json({ expectedVersion: 3, customerAddress: 'الدوار السابع' }, 'PATCH'), params(HERS));
    expect(res.status).toBe(200);
    expect(fake.tables.customers[0].address).toBe('الدوار السابع');
    expect(fake.tables.orders.find((o) => o.id === HERS)!.version).toBe(4);
  });

  it('it is confirmed', async () => {
    rang();
    const res = await confirmationRoute.POST(json({ action: 'confirm', expectedVersion: 3 }), params(HERS));
    expect(res.status).toBe(200);
    expect(fake.tables.orders.find((o) => o.id === HERS)!.confirmationStatus).toBe('CONFIRMED');
    expect(reserveOrderLines).toHaveBeenCalledTimes(1);
  });

  it('it is given back to the pool', async () => {
    const res = await claimRoute.DELETE(
      new Request('http://x/?reason=%D8%A7%D9%86%D8%AA%D9%87%D9%89', { method: 'DELETE' }),
      params(HERS)
    );
    expect(res.status).toBe(200);
    expect(fake.tables.orders.find((o) => o.id === HERS)!.claimedById).toBeNull();
  });

  it('a change is asked for, an entry issue raised on what a moderator typed', async () => {
    rang();
    const asked = await changeRequestsRoute.POST(
      json({ intent: 'EDIT', reason: 'الزبون غيّر العنوان', changes: { customerAddress: { to: 'الدوار السابع' } } }),
      params(HERS)
    );
    expect(asked.status).toBe(201);
    const issue = await issuesRoute.POST(json({ orderId: HERS, reason: 'WRONG_ADDRESS' }));
    expect(issue.status).toBe(201);
  });

  it('the assistant answers about it', async () => {
    const res = await assistantRoute.POST(json({ orderId: HERS }));
    expect(res.status).toBe(200);
    expect(aiChat).toHaveBeenCalledTimes(1);
  });

  it('and its customer’s history opens from it', async () => {
    const res = await historyRoute.GET(new Request(`http://x/api/customers/cu1/history?exclude=${HERS}`), params('cu1'));
    expect(res.status).toBe(200);
    // …and only from it: no order in hand, no history.
    expect((await historyRoute.GET(new Request('http://x/api/customers/cu1/history'), params('cu1'))).status).toBe(403);
  });

  it('and once she has rung, the next pull is no longer refused for it', async () => {
    const before = await pullRoute.POST();
    expect(before.status).toBe(409);
    expect((await before.json()).code).toBe('UNTOUCHED_ORDER');

    // The call, recorded through the work door — the one that answered 404 before.
    const call = await attemptsRoute.POST(json({ contactMethod: 'PHONE', result: 'NO_ANSWER' }), params(HERS));
    expect(call.status).toBe(200);

    const after = await pullRoute.POST();
    expect(after.status, 'السحب ما زال مرفوضاً بعد ما سجّلت المحاولة').toBe(201);
    expect(fake.tables.orders.find((o) => o.id === POOL)!.claimedById).toBe('u1');
  });
});

describe('NEGATIVE: the moderator is where he was', () => {
  beforeEach(() => {
    state.user = MODERATOR;
  });

  it('refused the pull, the queue and «طلباتي»', async () => {
    expect((await pullRoute.POST()).status).toBe(403);
    expect((await queueRoute.GET()).status).toBe(403);
    expect((await mineRoute.GET(new Request('http://x/api/confirmation/mine'))).status).toBe(403);
  });

  it('and an order he holds but did not enter does not open — he has no `confirmation.work`', async () => {
    const row = fake.tables.orders.find((o) => o.id === MODERATORS_HELD)!;
    row.moderatorId = 'mod-7';
    expect((await orderRoute.GET(new Request('http://x/'), params(MODERATORS_HELD))).status).toBe(404);
    expect((await confirmationRoute.POST(json({ action: 'confirm', expectedVersion: 3 }), params(MODERATORS_HELD))).status).toBe(404);
  });

  it('while what he entered still opens for him, exactly as before', async () => {
    const row = fake.tables.orders.find((o) => o.id === MODERATORS_HELD)!;
    row.moderatorId = 'm1';
    expect((await orderRoute.GET(new Request('http://x/'), params(MODERATORS_HELD))).status).toBe(200);
  });
});
