import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COURIER_SAID, SAID_STATUSES } from '@/lib/couriers/courier-said';
import { wordLine } from '@/lib/couriers/courier-said-lines.fixture';
import { TRACKING_ACK_ACTION } from '@/lib/parcel-tracking/alert';

/**
 * THE FOLLOW-UP LIST READS THE ACTIVITY TABLE WITH THE COMPANY NAMED — AND A FAILED READ OF THE COMPANY'S WORD DOES NOT TAKE THE
 * LIST DOWN.
 *
 * `order_activities` has one index that starts with an order, and it starts with the company: `(companyId, orderId)`. PostgreSQL 16
 * cannot skip a first column, so a read that asks `orderId IN (…)` and never names the company cannot use it. The door reads the
 * table three times for one answer — the company's words (for every parcel the list holds), the acknowledgements (for the parcels
 * that can carry an alert) and, for the page it draws, the acknowledgements again — and each of them names the door's own company.
 *
 * The database here is as strict as that index: a read of the table that does not name the company is REFUSED, and one that does
 * gets that company's lines only. So a line of ANOTHER company on the very same order is never in an answer, and a read that forgot
 * the company would not come back with the right rows — it would not come back at all.
 *
 * And the word is decoration. While nobody asked for it, a failed read of it draws the list without words (as if the poll had never
 * written a line) and says so ONCE in the log: the reason, and over how many parcels — never the question, which holds what the
 * person typed in the search box. When the person asked for it, the question cannot be answered: the door's usual error answer.
 * Every other read still fails the list.
 */

const { db, requireContext, requirePermission } = vi.hoisted(() => ({
  db: {
    order: { findMany: vi.fn() },
    orderStatusLog: { findMany: vi.fn() },
    orderChangeRequest: { findMany: vi.fn() },
    orderActivity: { findMany: vi.fn() },
    deliveryFee: { findMany: vi.fn() },
    deliveryProvider: { findMany: vi.fn() },
    region: { findMany: vi.fn() },
    settlementMatch: { findMany: vi.fn() },
  },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a), can: () => true }));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: vi.fn().mockResolvedValue(undefined) }));

import { GET } from './route';

// A Prisma-shaped fake and a JSON body: their shapes are the code under test's, not this file's.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

const get = (qs = '') => GET(new Request(`http://localhost/api/ops/tracking${qs ? `?${qs}` : ''}`));

// The moment of the answer is frozen: an age in minutes cannot flip between two answers a few milliseconds apart.
const NOW = new Date('2026-11-09T09:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

// The company and the store are different strings on purpose: a read that took one for the other would find nothing.
const COMPANY = 'company-7';
const STORE = 'store-3';
const OTHER_COMPANY = 'company-9';
const BASHA = '11111111-1111-4111-8111-111111111111';
const R1 = '33333333-3333-4333-8333-333333333333';

/** One parcel as the DATABASE has it: on the road, one day out, inside its three-day line, a Basha parcel. */
const parcel = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  companyId: COMPANY,
  storeId: STORE,
  orderNumber: `ORD-${id}`,
  merchantRef: null,
  trackingNumber: `KSA-${id}`,
  confirmationStatus: 'CONFIRMED',
  updatedAt: ago(0),
  createdAt: ago(5 * DAY),
  shippingStatus: 'SHIPPED',
  settlementStatus: 'NOT_APPLICABLE',
  shippedAt: ago(DAY),
  deliveredAt: null,
  returnedAt: null,
  outForDeliveryAt: null,
  deliveryFailureReason: null,
  totalAmount: 20,
  deliveryFee: 3,
  priceIncludesDelivery: false,
  collectedAmount: null,
  items: [{ quantity: 1, freeQuantity: 0, unitPrice: 20, discountShare: 0, lineTotal: 20, deliveredQty: null }],
  addOns: [],
  returnReceipt: null,
  currency: 'USD',
  regionId: R1,
  deliveryProviderId: BASHA,
  customer: { fullName: 'زبون الفحص الوهمي', phone: '0912345678', city: 'دمشق' },
  region: { id: R1, name: 'دمشق' },
  deliveryProvider: { id: BASHA, name: 'الباشا', kind: 'COMPANY', apiEnabled: true, adapterCode: 'LOGESTECHS' },
  _count: { deliveryAttempts: 0, notes: 0 },
  ...over,
});

type ReadName = 'order' | 'log' | 'change' | 'fee' | 'provider' | 'region' | 'said' | 'ack';
interface ActivityRow {
  id: string;
  companyId: string;
  orderId: string;
  action: string;
  newStatus: string | null;
  metadata: string | null;
  createdAt: Date;
}

let world: ReturnType<typeof parcel>[];
/** The activity table: the lines of every company. */
let table: ActivityRow[];
let statusLogs: { orderId: string; createdAt: Date }[];
let changes: { orderId: string; appliedAt: Date }[];
/** The read that fails, as the Nth time that read is made in one answer (0 is the list's own, 1 the door's own where it reads again). */
let boomAt: { read: ReadName; nth: number; error: Error } | null;
let made: Record<string, number>;
let lines: number;

const boom = new Error('canceling statement due to statement timeout');
const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => undefined);
let logged: ReturnType<typeof quiet>;

/** Every read of the fake database goes through here: it is counted, and it fails if the test says this one — the Nth time — does. */
const gate = (read: ReadName) => {
  const nth = (made[read] = (made[read] ?? -1) + 1);
  if (boomAt && boomAt.read === read && boomAt.nth === nth) throw boomAt.error;
};

/** The company says `code` about a parcel; `before` is how long ago. A line of another company is the same line with another owner. */
const said = (orderId: string, code: string, before: number, companyId = COMPANY) =>
  table.push({ ...wordLine({ orderId, code, at: ago(before), id: `L${++lines}` }), companyId, action: COURIER_SAID });
const acknowledged = (orderId: string, before: number, companyId = COMPANY) =>
  table.push({ id: `A${++lines}`, companyId, orderId, action: TRACKING_ACK_ACTION, newStatus: null, metadata: null, createdAt: ago(before) });

/** Five parcels on the road: one late that the company says it delivered, one the company says came back, a cancelled one somebody has seen, a changed one nobody has, and a quiet one. */
function theShop() {
  world = [
    parcel('a-late', { shippedAt: ago(12 * DAY) }),
    parcel('a-quiet', { shippedAt: ago(DAY) }),
    parcel('a-cancelled', { confirmationStatus: 'CANCELLED', shippedAt: ago(2 * DAY) }),
    parcel('a-changed', { shippedAt: ago(2 * DAY) }),
    parcel('a-plain', { shippedAt: ago(DAY) }),
  ];
  statusLogs = [{ orderId: 'a-cancelled', createdAt: ago(2 * DAY) }];
  changes = [{ orderId: 'a-changed', appliedAt: ago(DAY) }];
  table = [];
  said('a-late', 'DELIVERED_TO_RECIPIENT', 3 * HOUR);
  said('a-quiet', 'RETURNED_BY_RECIPIENT', 5 * HOUR);
  acknowledged('a-cancelled', HOUR);
}

const IDS = ['a-cancelled', 'a-changed', 'a-late', 'a-plain', 'a-quiet'];
const asked = (action: string): Loose[] => db.orderActivity.findMany.mock.calls.map((c) => c[0]).filter((a: Loose) => a.where.action === action);
const row = (body: Loose, id: string): Loose => body.orders.find((o: Loose) => o.id === id);
const NO_WORDS = { DELIVERED: 0, PARTIALLY_DELIVERED: 0, RETURNED: 0, CANCELLED: 0, FAILED_DELIVERY: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  logged = quiet();
  world = [];
  table = [];
  statusLogs = [];
  changes = [];
  boomAt = null;
  made = {};
  lines = 0;
  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'موظفة متابعة' },
    companyId: COMPANY,
    storeId: STORE,
    country: { minorUnit: 2, currencyCode: 'USD', code: 'SY' },
  });
  requirePermission.mockResolvedValue({});
  // The lean read gets every parcel; the page read gets the ids it asked for — in the database's order, NOT the list's.
  db.order.findMany.mockImplementation(async (args: Loose) => {
    gate('order');
    return args.where.id ? world.filter((p) => args.where.id.in.includes(p.id)).reverse() : world.slice(0, args.take);
  });
  db.orderStatusLog.findMany.mockImplementation(async (args: Loose) => {
    gate('log');
    return statusLogs.filter((l) => args.where.orderId.in.includes(l.orderId));
  });
  db.orderChangeRequest.findMany.mockImplementation(async (args: Loose) => {
    gate('change');
    return changes.filter((c) => args.where.orderId.in.includes(c.orderId));
  });
  db.orderActivity.findMany.mockImplementation(async (args: Loose) => {
    if (args.where.action !== COURIER_SAID && args.where.action !== TRACKING_ACK_ACTION) {
      throw new Error(`fake db: the activity table was asked for an action it was not taught: ${args.where.action}`);
    }
    gate(args.where.action === COURIER_SAID ? 'said' : 'ack');
    // The table's only index that starts with an order starts with the company: a read that does not name it is refused, and one that does gets that company's lines only.
    const named = args.where.companyId;
    if (typeof named !== 'string' || named === '') throw new Error('fake db: the activity table was read without naming the company');
    const found = table.filter((r) => r.companyId === named && r.action === args.where.action && args.where.orderId.in.includes(r.orderId));
    // Newest first, and only when the question says so.
    return args.orderBy ? found.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id)) : found;
  });
  db.deliveryFee.findMany.mockImplementation(async () => {
    gate('fee');
    return [{ deliveryProviderId: BASHA, regionId: R1, lateThresholdDays: 3 }];
  });
  db.deliveryProvider.findMany.mockImplementation(async () => {
    gate('provider');
    return [{ id: BASHA, name: 'الباشا', apiEnabled: true, adapterCode: 'LOGESTECHS' }];
  });
  db.settlementMatch.findMany.mockResolvedValue([]);
  db.region.findMany.mockImplementation(async () => {
    gate('region');
    return [{ id: R1, name: 'دمشق' }];
  });
});

afterEach(() => {
  logged.mockRestore();
  vi.useRealTimers();
});

describe('the three reads of the activity table each name the door’s own company', () => {
  it('— the company’s words, the list’s acknowledgements and the door’s acknowledgements for the page: all three, with the company the door was handed', async () => {
    theShop();
    expect((await get('limit=100')).status).toBe(200);

    const words = asked(COURIER_SAID);
    expect(words).toHaveLength(1);
    expect(words[0].where).toEqual({ companyId: COMPANY, orderId: { in: expect.any(Array) }, action: COURIER_SAID });
    // …over every parcel the list holds, in one question.
    expect([...words[0].where.orderId.in].sort()).toEqual(IDS);

    const acks = asked(TRACKING_ACK_ACTION);
    expect(acks).toHaveLength(2);
    // The list's own read comes first, for the parcels that can carry an alert (a cancelled one, a changed one) — and names the company.
    expect(acks[0].where).toEqual({ companyId: COMPANY, orderId: { in: expect.any(Array) }, action: TRACKING_ACK_ACTION });
    expect([...acks[0].where.orderId.in].sort()).toEqual(['a-cancelled', 'a-changed']);
    // The door's own read is for every row of the page — and names it too.
    expect(acks[1].where).toEqual({ companyId: COMPANY, orderId: { in: expect.any(Array) }, action: TRACKING_ACK_ACTION });
    expect([...acks[1].where.orderId.in].sort()).toEqual(IDS);

    // Nothing was read of the table that was not one of those three.
    expect(db.orderActivity.findMany).toHaveBeenCalledTimes(3);
  });

  it('— and what the three reads bring is the company’s own: the words on the rows, the alert somebody has seen and the one nobody has', async () => {
    theShop();
    const body = await (await get('limit=100')).json();
    expect(row(body, 'a-late').courierSaid).toMatchObject({ status: 'DELIVERED', label: 'تم التوصيل', ageMinutes: 180 });
    expect(row(body, 'a-quiet').courierSaid).toMatchObject({ status: 'RETURNED', ageMinutes: 300 });
    expect(row(body, 'a-plain').courierSaid).toBeNull();
    expect(row(body, 'a-cancelled').alert).toMatchObject({ kind: 'CANCELLED', acknowledged: true });
    expect(row(body, 'a-changed').alert).toMatchObject({ kind: 'CHANGED', acknowledged: false });
    expect(body.facts.said).toEqual({ ...NO_WORDS, DELIVERED: 1, RETURNED: 1 });
    expect(body.facts.tasks).toMatchObject({ CANCELLED: 0, CHANGED: 1, LATE: 1 });
    // Nothing went wrong on the way: nothing was logged.
    expect(logged).not.toHaveBeenCalled();
  });

  it('— a line of ANOTHER company on the very same orders reaches nobody: the answer is the one without it, word for word', async () => {
    theShop();
    const alone = await (await get('limit=100')).json();

    // Newer than every line of ours: a word on a parcel that has one, words on parcels that have none, and acknowledgements that would hush both alerts.
    said('a-late', 'POSTPONED_DELIVERY', HOUR, OTHER_COMPANY);
    said('a-quiet', 'CANCELLED', HOUR, OTHER_COMPANY);
    said('a-plain', 'DELIVERED_TO_RECIPIENT', HOUR, OTHER_COMPANY);
    acknowledged('a-changed', 10 * 60_000, OTHER_COMPANY);
    acknowledged('a-cancelled', 5 * 60_000, OTHER_COMPANY);
    expect(table.filter((r) => r.companyId === OTHER_COMPANY)).toHaveLength(5);

    const crowded = await (await get('limit=100')).json();
    expect(crowded).toEqual(alone);
    expect(row(crowded, 'a-late').courierSaid).toMatchObject({ status: 'DELIVERED' });
    expect(row(crowded, 'a-plain').courierSaid).toBeNull();
    expect(row(crowded, 'a-changed').alert).toMatchObject({ kind: 'CHANGED', acknowledged: false });
  });

  it('— a list of no parcels reads nothing of the table at all, as it never did', async () => {
    boomAt = { read: 'said', nth: 0, error: boom };
    const res = await get();
    expect(res.status).toBe(200);
    expect((await res.json()).orders).toEqual([]);
    expect(db.orderActivity.findMany).not.toHaveBeenCalled();
    expect(logged).not.toHaveBeenCalled();
  });
});

describe('a failed read of the company’s word does not take the follow-up list down', () => {
  it('— nobody asked for the word: the list is drawn without words — the body of a shop the poll never wrote a line for — and the log says so once', async () => {
    theShop();
    boomAt = { read: 'said', nth: 0, error: boom };
    const res = await get('limit=100');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(logged).toHaveBeenCalledTimes(1);

    expect(body.orders.map((o: Loose) => o.courierSaid)).toEqual([null, null, null, null, null]);
    expect(body.facts.said).toEqual(NO_WORDS);
    expect(body.applied.said).toBeNull();

    // The same shop, the poll never having written a line: the very same body, row for row and number for number.
    table = table.filter((r) => r.action !== COURIER_SAID);
    boomAt = null;
    made = {};
    expect(body).toEqual(await (await get('limit=100')).json());
  });

  it.each(SAID_STATUSES)('— the person asked for the word (%s): the door’s usual error answer, no list — an unfiltered one would be a wrong answer, an empty one a false «nobody»', async (choice) => {
    theShop();
    boomAt = { read: 'said', nth: 0, error: boom };
    const res = await get(`said=${choice}`);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.errorAr).toBe('حدث خطأ داخلي. أعد المحاولة، وإن تكرّر أبلغ مدير النظام.');
    expect(body).not.toHaveProperty('orders');
    // The door logged the error itself, once; the list added no line of its own.
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0][0]).toBe(boom);
  });

  const OTHER_READS: [string, ReadName, number][] = [
    ['the list’s own read of the parcels', 'order', 0],
    ['the read of the page’s parcels in full', 'order', 1],
    ['the companies’ names', 'provider', 0],
    ['the lateness lines, as the list reads them', 'fee', 0],
    ['the lateness lines, as the page reads them', 'fee', 1],
    ['the cancellation log, as the list reads it', 'log', 0],
    ['the cancellation log, as the page reads it', 'log', 1],
    ['the applied changes, as the list reads them', 'change', 0],
    ['the applied changes, as the page reads them', 'change', 1],
    ['the list’s acknowledgements', 'ack', 0],
    ['the page’s acknowledgements', 'ack', 1],
    ['the governorates’ names', 'region', 0],
  ];

  it.each(OTHER_READS)('— %s failing still fails the whole answer: the door’s usual error, no list', async (_what, read, nth) => {
    theShop();
    boomAt = { read, nth, error: boom };
    const res = await get('limit=100');
    expect(res.status).toBe(500);
    expect(await res.json()).not.toHaveProperty('orders');
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0][0]).toBe(boom);
  });

  it('— the log line holds the reason and the number of parcels — never the question: not the phone typed in the search box, not the customers, not the company, not the error whole', async () => {
    theShop();
    // A database error can carry the statement that failed (a driver puts the SQL and its values in `meta`): only its message may be logged.
    const driverError = Object.assign(new Error('canceling statement due to statement timeout'), {
      code: 'P2010',
      meta: { query: `SELECT "orderId" FROM "order_activities" WHERE "orderId" IN ('a-late') AND "customerPhone" = '0912345678'` },
    });
    boomAt = { read: 'said', nth: 0, error: driverError };
    const res = await get(`q=${encodeURIComponent('0912345678')}`);
    expect(res.status).toBe(200);
    expect(logged).toHaveBeenCalledTimes(1);

    // Exactly three things: that it failed, why (the message — a string), and over how many parcels.
    expect(logged.mock.calls[0]).toEqual([expect.stringContaining('could not be read'), driverError.message, '(5 parcels)']);
    const everything = JSON.stringify(logged.mock.calls);
    for (const leak of ['0912345678', 'زبون الفحص', 'الوهمي', 'دمشق', 'KSA-', 'ORD-', 'P2010', 'order_activities', COMPANY, STORE, 'a-late']) {
      expect(everything, leak).not.toContain(leak);
    }
  });
});
