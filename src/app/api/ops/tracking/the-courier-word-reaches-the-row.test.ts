import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LEAN_CAP } from '@/lib/parcel-tracking/list';

/**
 * «الشركة بتقول» — THE DOOR PUTS WHAT THE COMPANY SAID ON EACH ROW, AND CHANGES NOTHING ELSE.
 *
 * Delivered parcels are mostly never reported to the people who chase them, so a list full of parcels our own state shows
 * «مشحون ومتأخر» holds many the company says it delivered. The poll already keeps that word (a COURIER_SAID line); the
 * door now carries it on each row — `{ status, label, note, at, ageMinutes }` or null — and lets the list be narrowed by it
 * (`?said=`). What is held here, end to end:
 *
 *   • the words are written by the REAL feed (the real LogesTechs adapter's event through the real gate) and read by the
 *     real door and the real list — only the database is a fake, and it enforces the question it is asked (the state
 *     clauses, the sight clause), so a parcel a person may not read is not in the answer;
 *   • a word only decorates: the rows, their order, the late flags, the alerts, the chips, the badge and «الكل» are
 *     exactly what they were without it, and nothing is written;
 *   • no word, or a word equal to the parcel's own state, is `null`; of two words the newest counts;
 *   • the list is read ONCE for the words — one grouped question for the whole list, never one per row;
 *   • the word is not money: whoever may read a row sees its word, and the word never makes a row readable.
 */

const { db, requireContext, requirePermission, held } = vi.hoisted(() => ({
  db: {
    order: { findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    orderStatusLog: { findMany: vi.fn() },
    orderChangeRequest: { findMany: vi.fn() },
    orderActivity: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
    deliveryFee: { findMany: vi.fn() },
    deliveryProvider: { findMany: vi.fn() },
    region: { findMany: vi.fn() },
  },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  held: new Set<string>(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({
  requirePermission: (...a: unknown[]) => requirePermission(...a),
  can: (_user: unknown, key: string) => held.has(key),
}));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: vi.fn().mockResolvedValue(undefined) }));

import { GET } from './route';
import { applyCourierEvent } from '@/lib/couriers/apply-event';
import { COURIER_SAID } from '@/lib/couriers/courier-said';
import { theCompanySends } from '@/lib/couriers/courier-said-lines.fixture';

// A Prisma-shaped fake and a JSON body: their shapes are the code under test's, not this file's.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

const get = (qs = '') => GET(new Request(`http://localhost/api/ops/tracking${qs ? `?${qs}` : ''}`));

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(Date.now() - ms);

const BASHA = '11111111-1111-4111-8111-111111111111';
const R1 = '33333333-3333-4333-8333-333333333333';

/** One parcel as the DATABASE has it. By default a Basha parcel on the road, one day out, inside its three-day line. */
const parcel = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  companyId: 'c1',
  storeId: 's1',
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
  customer: { fullName: 'زبون', phone: '0912345678', city: 'دمشق' },
  region: { id: R1, name: 'دمشق' },
  deliveryProvider: { id: BASHA, name: 'الباشا', kind: 'COMPANY', apiEnabled: true, adapterCode: 'LOGESTECHS' },
  _count: { deliveryAttempts: 0, notes: 0 },
  ...over,
});
type Parcel = ReturnType<typeof parcel>;

/** Just enough of Prisma's `where` for the clauses this door writes: `AND`, `OR`, equality, `in`, `notIn`, `not`. Relation filters (a search) are not part of these tests. */
function matches(where: Loose, row: Loose): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, cond]: [string, Loose]) => {
    if (key === 'AND') return cond.every((w: Loose) => matches(w, row));
    if (key === 'OR') return cond.some((w: Loose) => matches(w, row));
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('in' in cond) return cond.in.includes(row[key]);
      if ('notIn' in cond) return !cond.notIn.includes(row[key]);
      if ('not' in cond) return row[key] !== cond.not;
      return true;
    }
    return row[key] === cond;
  });
}

let world: Parcel[];
/** The activity table: every line the real gate wrote, with the moment it was written. */
let table: (Record<string, Loose> & { createdAt: Date })[];
/** The moment the next line is written at. */
let clock: number;

/** The company says `code` about a parcel our state shows as `state` — through the real adapter and the real gate. */
async function companySays(orderId: string, code: string, over: { notes?: string; state?: string; at?: Date } = {}) {
  if (over.at) clock = over.at.getTime();
  const event = await theCompanySends(code, over.notes ?? '');
  return applyCourierEvent({
    order: { id: orderId, companyId: 'c1', shippingStatus: over.state ?? world.find((p) => p.id === orderId)?.shippingStatus ?? 'SHIPPED' },
    event,
    courierName: 'الباشا',
    source: 'POLL',
  });
}

const asked = (action: string) => db.orderActivity.findMany.mock.calls.map((c) => c[0]).filter((a: Loose) => a.where.action === action);

beforeEach(() => {
  vi.clearAllMocks();
  held.clear();
  held.add('ops.track');
  world = [];
  table = [];
  clock = Date.now() - 2 * HOUR;
  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'موظفة متابعة' },
    companyId: 'c1',
    storeId: 's1',
    country: { minorUnit: 2, currencyCode: 'USD', code: 'SY' },
  });
  requirePermission.mockResolvedValue({});
  // The database answers the question it is asked: the state clauses and the sight clause are enforced, not just recorded.
  db.order.findMany.mockImplementation(async (args: Loose) => world.filter((p) => matches(args.where, p)).slice(0, args.take ?? world.length));
  db.orderStatusLog.findMany.mockResolvedValue([]);
  db.orderChangeRequest.findMany.mockResolvedValue([]);
  db.orderActivity.create.mockImplementation(async ({ data }: { data: Record<string, Loose> }) => {
    const row = { id: `L${String(table.length + 1).padStart(4, '0')}`, ...data, createdAt: new Date(clock) };
    table.push(row);
    clock += 1000;
    return row;
  });
  db.orderActivity.findFirst.mockImplementation(
    async ({ where }: Loose) => [...table].reverse().find((r) => r.orderId === where.orderId && r.action === where.action) ?? null
  );
  db.orderActivity.findMany.mockImplementation(async (args: Loose) => {
    const rows = table.filter((r) => args.where.orderId.in.includes(r.orderId) && r.action === args.where.action);
    // Newest first, and only when the question says so.
    return args.orderBy ? rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id)) : rows;
  });
  db.deliveryFee.findMany.mockResolvedValue([{ deliveryProviderId: BASHA, regionId: R1, lateThresholdDays: 3 }]);
  db.deliveryProvider.findMany.mockResolvedValue([{ id: BASHA, name: 'الباشا', apiEnabled: true, adapterCode: 'LOGESTECHS' }]);
  db.region.findMany.mockResolvedValue([{ id: R1, name: 'دمشق' }]);
});

describe('the word on the row', () => {
  it('— a Basha parcel the company says it delivered carries the word: the company’s name for the code, the state, the date, the age', async () => {
    world = [parcel('a', { shippedAt: ago(10 * DAY) })];
    expect(await companySays('a', 'DELIVERED_TO_RECIPIENT')).toBe('NOT_AUTO_APPLICABLE');
    const body = await (await get()).json();
    expect(body.orders).toHaveLength(1);
    const word = body.orders[0].courierSaid;
    expect(word).toEqual({ status: 'DELIVERED', label: 'تم التوصيل', note: null, at: table[0].createdAt.toISOString(), ageMinutes: expect.any(Number) });
    expect(word.ageMinutes).toBeGreaterThanOrEqual(120);
    expect(word.ageMinutes).toBeLessThan(125);
    // The word is a field. The row's own state is still what the database holds.
    expect(body.orders[0]).toMatchObject({ shippingStatus: 'SHIPPED', late: true, daysInTransit: 10 });
  });

  it('and the six words the company can say come out as their state and their own name', async () => {
    const six = [
      ['DELIVERED_TO_RECIPIENT', 'DELIVERED', 'تم التوصيل'],
      ['PARTIALLY_DELIVERED', 'PARTIALLY_DELIVERED', 'تم توصيلها بشكل جزئي'],
      ['RETURNED_BY_RECIPIENT', 'RETURNED', 'تم ارجاعها'],
      ['DELIVERED_TO_SENDER', 'RETURNED', 'مسلمة الى المرسل'],
      ['CANCELLED', 'CANCELLED', 'ملغاة'],
      ['POSTPONED_DELIVERY', 'FAILED_DELIVERY', 'مؤجلة'],
    ] as const;
    world = six.map(([, ,], i) => parcel(`p${i}`, { shippedAt: ago((10 + i) * DAY) }));
    for (const [i, [code]] of six.entries()) await companySays(`p${i}`, code);
    const body = await (await get()).json();
    for (const [i, [, status, label]] of six.entries()) {
      expect(body.orders.find((o: Loose) => o.id === `p${i}`).courierSaid, `p${i}`).toMatchObject({ status, label, note: null });
    }
  });

  it('and a parcel the company has not spoken about carries `null` — and so does one with no barcode', async () => {
    world = [parcel('quiet'), parcel('unsent', { trackingNumber: null, shippingStatus: 'READY_FOR_PICKUP', shippedAt: null })];
    const body = await (await get()).json();
    expect(body.orders).toHaveLength(2);
    for (const o of body.orders) expect(o.courierSaid, o.id).toBeNull();
  });

  it('and the company’s free note is kept apart: the label is still the code’s name', async () => {
    world = [parcel('a', { shippedAt: ago(10 * DAY) })];
    await companySays('a', 'DELIVERED_TO_RECIPIENT', { notes: 'العميل طلب يؤجّلوها للخميس' });
    const word = (await (await get()).json()).orders[0].courierSaid;
    expect(word).toMatchObject({ status: 'DELIVERED', label: 'تم التوصيل', note: 'العميل طلب يؤجّلوها للخميس' });
  });

  it('— the same word again is one line, so one word; a DIFFERENT word after it is the word', async () => {
    world = [parcel('a', { shippedAt: ago(10 * DAY) })];
    await companySays('a', 'DELIVERED_TO_RECIPIENT');
    await companySays('a', 'DELIVERED_TO_RECIPIENT');
    await companySays('a', 'DELIVERED_TO_RECIPIENT');
    expect(table).toHaveLength(1);
    await companySays('a', 'POSTPONED_DELIVERY');
    expect(table).toHaveLength(2);
    const word = (await (await get()).json()).orders[0].courierSaid;
    expect(word).toMatchObject({ status: 'FAILED_DELIVERY', label: 'مؤجلة' });
  });

  it('and a word equal to the parcel’s own state says nothing: it arrived, the door recorded it, and the company agrees', async () => {
    held.add('settlement.view');
    world = [parcel('a', { shippingStatus: 'SHIPPED' })];
    await companySays('a', 'DELIVERED_TO_RECIPIENT');
    // The door then records the delivery.
    world = [parcel('a', { shippingStatus: 'DELIVERED', settlementStatus: 'PENDING_COLLECTION', deliveredAt: ago(HOUR) })];
    const body = await (await get()).json();
    expect(body.orders).toHaveLength(1);
    expect(body.orders[0].courierSaid).toBeNull();
    expect(body.facts.said.DELIVERED).toBe(0);
  });

  it('and a word OLDER than the parcel’s last change of state still shows while it disagrees — with its age, so the reader can judge it', async () => {
    held.add('settlement.view');
    // The company said «delivered» three days ago; yesterday the door recorded a refusal and the parcel is on its way back.
    world = [parcel('a', { shippingStatus: 'SHIPPED' })];
    await companySays('a', 'DELIVERED_TO_RECIPIENT', { at: ago(3 * DAY) });
    world = [parcel('a', { shippingStatus: 'RETURN_REQUESTED', updatedAt: ago(DAY) })];
    held.add('ops.returns_view');
    const body = await (await get()).json();
    expect(body.orders[0].courierSaid).toMatchObject({ status: 'DELIVERED', label: 'تم التوصيل' });
    expect(body.orders[0].courierSaid.ageMinutes).toBeGreaterThanOrEqual(3 * 24 * 60);
  });

  it('and a damaged line says nothing: the row carries `null`, not a guess from the state', async () => {
    world = [parcel('a', { shippedAt: ago(10 * DAY) })];
    await companySays('a', 'DELIVERED_TO_RECIPIENT');
    table[0].metadata = '{"rawStatus": ';
    const body = await (await get()).json();
    expect(body.orders[0].courierSaid).toBeNull();
  });
});

describe('the word only decorates — everything else is what it was without it', () => {
  /** A shop with every kind of row, and (when asked) the company having spoken about most of them. */
  const shopOf = () => [
    parcel('late-a', { shippedAt: ago(12 * DAY) }),
    parcel('late-b', { shippedAt: ago(9 * DAY) }),
    parcel('fresh', { shippedAt: ago(DAY) }),
    parcel('nobarcode', { trackingNumber: null, shippedAt: ago(2 * DAY) }),
    parcel('cancelled-order', { confirmationStatus: 'CANCELLED', shippedAt: ago(2 * DAY) }),
    parcel('failed', { shippingStatus: 'FAILED_DELIVERY', shippedAt: ago(3 * DAY) }),
  ];

  // The body without the field the words add: the rows without `courierSaid`, the facts without the words’ numbers.
  const strip = (body: Loose) => ({
    ...body,
    orders: body.orders.map((o: Loose) => ({ ...o, courierSaid: undefined })),
    facts: { ...body.facts, said: undefined },
  });

  it('— the same rows in the same order, the same late flags, alerts, chips, badge and «الكل», with the words and without', async () => {
    world = shopOf();
    const without = await (await get('limit=100')).json();
    await companySays('late-a', 'DELIVERED_TO_RECIPIENT');
    await companySays('late-b', 'RETURNED_BY_RECIPIENT', { notes: 'العميل رفض' });
    await companySays('fresh', 'CANCELLED');
    await companySays('nobarcode', 'POSTPONED_DELIVERY');
    await companySays('cancelled-order', 'DELIVERED_TO_RECIPIENT');
    const withWords = await (await get('limit=100')).json();

    expect(withWords.orders.map((o: Loose) => o.id)).toEqual(without.orders.map((o: Loose) => o.id));
    expect(strip(withWords)).toEqual(strip(without));
    // …while the words ARE there.
    expect(withWords.orders.filter((o: Loose) => o.courierSaid).map((o: Loose) => o.id).sort()).toEqual(['cancelled-order', 'fresh', 'late-a', 'late-b', 'nobarcode']);
    expect(withWords.facts.said).toEqual({ DELIVERED: 2, PARTIALLY_DELIVERED: 0, RETURNED: 1, CANCELLED: 1, FAILED_DELIVERY: 1 });
    expect(without.facts.said).toEqual({ DELIVERED: 0, PARTIALLY_DELIVERED: 0, RETURNED: 0, CANCELLED: 0, FAILED_DELIVERY: 0 });
  });

  it('and the door writes nothing: no status, no stamp, no line — the word is read, never applied', async () => {
    world = shopOf();
    await companySays('late-a', 'DELIVERED_TO_RECIPIENT');
    const lines = table.length;
    await get('limit=100');
    await get('said=DELIVERED');
    expect(table).toHaveLength(lines);
    expect(db.order.update).not.toHaveBeenCalled();
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(db.orderActivity.create).toHaveBeenCalledTimes(lines);
  });
});

describe('the list is read ONCE for the words', () => {
  it('— one grouped question for every parcel the list holds, newest first, with the page of 25 and the lean list alike: never one per row', async () => {
    world = Array.from({ length: 40 }, (_, i) => parcel(`p${String(i).padStart(2, '0')}`, { shippedAt: ago((20 + i) * DAY) }));
    for (const p of world) await companySays(p.id, 'DELIVERED_TO_RECIPIENT');
    db.orderActivity.findMany.mockClear();
    const res = await get();
    const body = await res.json();
    expect(body.orders).toHaveLength(25);
    expect(body.orders.every((o: Loose) => o.courierSaid?.status === 'DELIVERED')).toBe(true);
    const questions = asked(COURIER_SAID);
    expect(questions).toHaveLength(1);
    // …over all forty parcels the list holds, not the 25 on the page and not one at a time.
    expect(questions[0].where.orderId.in).toHaveLength(40);
    expect(questions[0].orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    // The whole answer cost the activity table those two questions and no more (the words, and the acknowledgements — and the latter only when there is a parcel that can carry an alert).
    expect(db.orderActivity.findMany.mock.calls.length).toBeLessThanOrEqual(2);
    expect(db.order.findMany).toHaveBeenCalledTimes(2);
  });

  it('and the list still reads its lean parcels with the bound it always had', async () => {
    world = [parcel('a')];
    await get();
    expect(db.order.findMany.mock.calls[0][0].take).toBe(LEAN_CAP + 1);
  });
});

describe('the filter «الشركة بتقول»', () => {
  const company = () => [
    parcel('d1', { shippedAt: ago(12 * DAY) }),
    parcel('d2', { shippedAt: ago(11 * DAY) }),
    parcel('r1', { shippedAt: ago(10 * DAY) }),
    parcel('c1', { shippedAt: ago(1 * DAY) }),
    parcel('none', { shippedAt: ago(2 * DAY) }),
  ];
  const said = async () => {
    await companySays('d1', 'DELIVERED_TO_RECIPIENT');
    await companySays('d2', 'DELIVERED_TO_RECIPIENT');
    await companySays('r1', 'RETURNED_BY_RECIPIENT');
    await companySays('c1', 'CANCELLED');
  };

  it('— narrows the list to the parcels whose word it is, and the chips, «الكل» and the badge describe what is left', async () => {
    world = company();
    await said();
    const body = await (await get('said=DELIVERED&limit=100')).json();
    expect(body.orders.map((o: Loose) => o.id).sort()).toEqual(['d1', 'd2']);
    expect(body.pagination.total).toBe(2);
    expect(body.facts.total).toBe(2);
    expect(body.facts.tasks.LATE).toBe(2);
    expect(body.lateCount).toBe(2);
    expect(body.applied.said).toBe('DELIVERED');
  });

  it('and each choice has its number — over the whole list, the same whichever choice is made', async () => {
    world = company();
    await said();
    const plain = (await (await get()).json()).facts.said;
    expect(plain).toEqual({ DELIVERED: 2, PARTIALLY_DELIVERED: 0, RETURNED: 1, CANCELLED: 1, FAILED_DELIVERY: 0 });
    for (const k of Object.keys(plain)) {
      const body = await (await get(`said=${k}&limit=100`)).json();
      expect(body.orders, k).toHaveLength(plain[k]);
      expect(body.facts.said, k).toEqual(plain);
    }
  });

  it('and «all», blank or nothing is no choice — the default view is the default view', async () => {
    world = company();
    await said();
    const plain = await (await get('limit=100')).json();
    for (const qs of ['said=all', 'said=', 'said=%20']) {
      const body = await (await get(`${qs}&limit=100`)).json();
      expect(body.orders.map((o: Loose) => o.id), qs).toEqual(plain.orders.map((o: Loose) => o.id));
      expect(body.applied.said, qs).toBeNull();
    }
  });

  it('NEGATIVE: a word that is not one of the five is a 400 in Arabic — the database is not even asked', async () => {
    world = company();
    for (const bad of ['SHIPPED', 'DELIVERED_TO_RECIPIENT', 'delivered', 'none']) {
      db.order.findMany.mockClear();
      const res = await get(`said=${bad}`);
      expect(res.status, bad).toBe(400);
      const body = await res.json();
      expect(body.errorAr).toBe(`كلمة الشركة غير معروف: ${bad}`);
      expect(db.order.findMany).not.toHaveBeenCalled();
    }
  });
});

describe('who sees which rows — the word is not money, and never widens a list', () => {
  it('— a person without the money keys sees the word on the rows on the road, and the delivered rows are still not theirs', async () => {
    world = [
      parcel('road', { shippedAt: ago(10 * DAY) }),
      parcel('arrived', { shippingStatus: 'DELIVERED', settlementStatus: 'PENDING_COLLECTION', deliveredAt: ago(HOUR) }),
    ];
    await companySays('road', 'DELIVERED_TO_RECIPIENT');
    await companySays('arrived', 'RETURNED_BY_RECIPIENT', { state: 'SHIPPED' });
    const body = await (await get('limit=100')).json();
    expect(body.access).toEqual({ money: false, returns: false, collect: false });
    expect(body.orders.map((o: Loose) => o.id)).toEqual(['road']);
    expect(body.orders[0].courierSaid).toMatchObject({ status: 'DELIVERED', label: 'تم التوصيل' });
    // The delivered row’s word is in nobody’s row and nobody’s number: it is not a row this person may read.
    expect(body.facts.said).toEqual({ DELIVERED: 1, PARTIALLY_DELIVERED: 0, RETURNED: 0, CANCELLED: 0, FAILED_DELIVERY: 0 });
  });

  it('and the word is not a way into the other level: asking for the delivered parcels’ word is an empty answer, not a 403 and not their rows', async () => {
    world = [
      parcel('arrived', { shippingStatus: 'DELIVERED', settlementStatus: 'PENDING_COLLECTION', deliveredAt: ago(HOUR) }),
    ];
    await companySays('arrived', 'RETURNED_BY_RECIPIENT', { state: 'SHIPPED' });
    const res = await get('said=RETURNED');
    expect(res.status).toBe(200);
    expect((await res.json()).orders).toEqual([]);
    // A chip or a state that IS the other level's rows is still refused in the door's own sentence.
    expect((await get('status=DELIVERED')).status).toBe(403);
  });

  it('and with «عرض التسويات» the same rows carry their words too — and the word is never one of the courier’s money fields', async () => {
    held.add('settlement.view');
    world = [
      parcel('arrived', { shippingStatus: 'DELIVERED', settlementStatus: 'PENDING_COLLECTION', deliveredAt: ago(HOUR) }),
    ];
    await companySays('arrived', 'RETURNED_BY_RECIPIENT', { state: 'SHIPPED' });
    const body = await (await get('said=RETURNED')).json();
    expect(body.orders).toHaveLength(1);
    expect(body.orders[0].courierSaid).toMatchObject({ status: 'RETURNED', label: 'تم ارجاعها' });
    expect(Object.keys(body.orders[0].courierSaid).sort()).toEqual(['ageMinutes', 'at', 'label', 'note', 'status']);
  });
});
