import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@/lib/guard-source';
import { STATEMENT_CLOSED_SENTENCE } from '@/lib/settlement-gates';
import { WHY } from '@/lib/settlement-decisions';

/**
 * «فيه فرق» — WHAT THE FOLLOW-UP DOOR TELLS THE SCREEN ABOUT A PARCEL WHOSE MATCHING CAME BACK WITH A DIFFERENCE.
 *
 *   «واذا المطابقة رجعت في فرق حط جنبو علامة انو في فرق عشان بنت المتابعة تشيك او اعمل قائمة … تبث فيه وتعتمد رقمنا او رقم الشركة»
 *
 * The door is held key by key: the money sight («عرض التسويات» or «إدارة الصناديق النقدية») sees the mark, its figures and
 * the chip's number; deciding is `settlement.review` and adds the matrix the matching screen's own door answers by; a person
 * with neither gets no field, no number, no read of the match table at all, and a 403 for the chip. The match table here
 * EVALUATES what it is asked — another company's rows and another store's statements are in it.
 */

const { db, requireContext, requirePermission, held } = vi.hoisted(() => ({
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

type Any = Record<string, any>;
const get = (qs = '') => GET(new Request(`http://localhost/api/ops/tracking${qs ? `?${qs}` : ''}`));

const P1 = '11111111-1111-4111-8111-111111111111';
const R1 = '33333333-3333-4333-8333-333333333333';
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

const parcel = (id: string, over: Any = {}) => ({
  id,
  orderNumber: `ORD-${id}`,
  merchantRef: null,
  trackingNumber: `TRK-${id}`,
  confirmationStatus: 'CONFIRMED',
  updatedAt: new Date(),
  createdAt: new Date(),
  shippingStatus: 'DELIVERED',
  settlementStatus: 'PENDING_COLLECTION',
  shippedAt: ago(5),
  deliveredAt: ago(1),
  returnedAt: null,
  outForDeliveryAt: null,
  deliveryFailureReason: null,
  totalAmount: 20,
  deliveryFee: 3,
  priceIncludesDelivery: false,
  collectedAmount: null,
  items: [{ quantity: 1, freeQuantity: 0, unitPrice: 20, discountShare: 0, lineTotal: 20, deliveredQty: 1 }],
  addOns: [],
  returnReceipt: null,
  currency: 'USD',
  regionId: R1,
  deliveryProviderId: P1,
  customer: { fullName: 'زبون', phone: '0912345678', city: 'دمشق' },
  region: { id: R1, name: 'دمشق' },
  deliveryProvider: { id: P1, name: 'أبو علي', kind: 'COMPANY', apiEnabled: false, adapterCode: null },
  _count: { deliveryAttempts: 0, notes: 0 },
  ...over,
});

let mn = 0;
const line = (over: Any = {}) => ({
  merchantRef: 'REF-1',
  barcode: 'TRK-a',
  amount: '17',
  collected: '20',
  fee: '3',
  status: 'تم التوصيل',
  rawRow: 'REF-1 | تم التوصيل | 17',
  receiverName: 'زبون',
  receiverPhone: '0912345678',
  receiverAddress: 'المزة',
  receiverCity: 'دمشق',
  receiverArea: null,
  ...over,
});
/** A match row as the table holds it — Decimals as strings, like Prisma hands them out. */
const mrow = (orderId: string | null, over: Any = {}) => {
  const { statement, ...rest } = over;
  return {
    id: `m${String(++mn).padStart(4, '0')}`,
    companyId: 'c1',
    statementId: 'st1',
    orderId,
    result: 'MISMATCHED',
    resolution: null,
    resolutionNote: null,
    expectedAmount: '20',
    statementAmount: '17',
    difference: '-3',
    note: null,
    createdAt: ago(2),
    statementLine: line(),
    ...rest,
    statement: { storeId: 's1', reference: 'ST-2026-0007', matchingClosedAt: null, ...(statement ?? {}) },
  };
};

/** The Prisma `where`s the door and its helpers use on this table, evaluated. */
const holds = (r: Any, w: Any): boolean =>
  Object.entries(w).every(([k, c]) => {
    if (k === 'OR') return (c as Any[]).some((x) => holds(r, x));
    if (k === 'AND') return (c as Any[]).every((x) => holds(r, x));
    if (k === 'statement') return holds(r.statement, c as Any);
    const v = r[k];
    if (c !== null && typeof c === 'object' && !(c instanceof Date)) {
      if ('in' in c) return (c as Any).in.includes(v);
      if ('notIn' in c) return !(c as Any).notIn.includes(v);
      throw new Error(`the fake table does not know «${Object.keys(c).join(',')}»`);
    }
    return v === c;
  });

let world: ReturnType<typeof parcel>[];
let table: ReturnType<typeof mrow>[];
const askedOfMatches = () => db.settlementMatch.findMany.mock.calls.map((c) => c[0] as Any);

beforeEach(() => {
  vi.clearAllMocks();
  held.clear();
  held.add('ops.track');
  mn = 0;
  world = [parcel('a')];
  table = [];
  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'موظفة متابعة' },
    companyId: 'c1',
    storeId: 's1',
    country: { minorUnit: 2, currencyCode: 'USD', code: 'SY' },
  });
  requirePermission.mockResolvedValue({});
  db.order.findMany.mockImplementation(async (args: Any) =>
    args.where.id ? world.filter((p) => args.where.id.in.includes(p.id)) : world.slice(0, args.take)
  );
  db.orderStatusLog.findMany.mockResolvedValue([]);
  db.orderChangeRequest.findMany.mockResolvedValue([]);
  db.orderActivity.findMany.mockResolvedValue([]);
  db.deliveryFee.findMany.mockResolvedValue([{ deliveryProviderId: P1, regionId: R1, lateThresholdDays: 3 }]);
  db.deliveryProvider.findMany.mockResolvedValue([{ id: P1, name: 'أبو علي' }]);
  db.region.findMany.mockResolvedValue([{ id: R1, name: 'دمشق' }]);
  db.settlementMatch.findMany.mockImplementation(async (args: Any) => table.filter((r) => holds(r, args.where)));
});

const asMoney = () => held.add('settlement.view');
const asDecider = () => {
  held.add('settlement.view');
  held.add('settlement.review');
};

describe('what the row carries — for a person who holds the money sight', () => {
  it('the two figures, the gap signed the way a shop reads it, the company’s word and the statement it comes from', async () => {
    asMoney();
    table = [mrow('a')];
    const body = await (await get()).json();
    expect(body.orders).toHaveLength(1);
    expect(body.orders[0].difference).toEqual({
      matchId: table[0].id,
      statementId: 'st1',
      statement: 'ST-2026-0007',
      ours: 20,
      theirs: 17,
      // ours − theirs: the company kept 3 back — a shortage, positive, as `shortfall` of the settlement rule reads it
      gap: 3,
      answered: false,
      resolution: null,
      resolutionNote: null,
      claim: null,
      closed: false,
      note: null,
      decisions: null,
      courierWord: { phrase: 'تم التوصيل', outcome: 'DELIVERED', known: true, label: 'تقول الشركة: سُلِّم' },
      statementLine: expect.objectContaining({ merchantRef: 'REF-1', status: 'تم التوصيل', rawRow: 'REF-1 | تم التوصيل | 17', amount: 17, collected: 20, fee: 3, receiverCity: 'دمشق' }),
    });
  });

  it('numbers, not strings: a Decimal is a figure on the wire', async () => {
    asMoney();
    table = [mrow('a', { expectedAmount: '20.000', statementAmount: '17.500', difference: '-2.500' })];
    const d = (await (await get()).json()).orders[0].difference;
    expect([typeof d.ours, typeof d.theirs, typeof d.gap, typeof d.statementLine.amount]).toEqual(['number', 'number', 'number', 'number']);
    expect([d.ours, d.theirs, d.gap]).toEqual([20, 17.5, 2.5]);
  });

  it('the sign is the shop’s: a company that handed over MORE than we expected is negative — never a silent windfall', async () => {
    asMoney();
    table = [mrow('a', { statementAmount: '22', difference: '2' })];
    expect((await (await get()).json()).orders[0].difference.gap).toBe(-2);
  });

  it('the gap is rounded by the COUNTRY’s minor unit (a dinar has three places), not by a rule of the screen’s', async () => {
    asMoney();
    requireContext.mockResolvedValue({ user: { id: 'u1' }, companyId: 'c1', storeId: 's1', country: { minorUnit: 3, currencyCode: 'JOD', code: 'JO' } });
    table = [mrow('a', { expectedAmount: '20', statementAmount: '17.875', difference: '-2.125' })];
    expect((await (await get()).json()).orders[0].difference.gap).toBe(2.125);
  });

  it('a parcel with no difference carries `difference: null` — present, so the screen can tell «none» from «an older server»', async () => {
    asMoney();
    world = [parcel('a'), parcel('b')];
    table = [mrow('a')];
    const orders = (await (await get()).json()).orders as Any[];
    expect(orders.find((o) => o.id === 'a')!.difference).not.toBeNull();
    expect(orders.find((o) => o.id === 'b')!.difference).toBeNull();
  });

  it('an answered difference carries its answer, its reason and — for «رقمنا» — the claim on the company', async () => {
    asMoney();
    table = [mrow('a', { resolution: 'OURS_STANDS', resolutionNote: 'الشركة بتصلّح الرقم' })];
    const d = (await (await get()).json()).orders[0].difference;
    expect(d).toMatchObject({ answered: true, resolution: 'OURS_STANDS', resolutionNote: 'الشركة بتصلّح الرقم', claim: 3, closed: false });
    table = [mrow('a', { resolution: 'ACCEPTED_COURIER', resolutionNote: 'خصم من الموظفة' })];
    expect((await (await get()).json()).orders[0].difference).toMatchObject({ answered: true, resolution: 'ACCEPTED_COURIER', claim: null });
  });

  it('a closed statement says so — closed, read-only, the answer still shown', async () => {
    asMoney();
    table = [mrow('a', { resolution: 'ACCEPTED_COURIER', resolutionNote: 'خصم', statement: { matchingClosedAt: ago(1) } })];
    expect((await (await get()).json()).orders[0].difference).toMatchObject({ closed: true, answered: true });
  });

  it('the matching’s own sentence about the row travels with it (a fee that differs, a parcel another statement names)', async () => {
    asMoney();
    table = [mrow('a', { expectedAmount: '20', statementAmount: '20', difference: '0', note: 'أجرة التوصيل 4 بدل 3' })];
    const d = (await (await get()).json()).orders[0].difference;
    expect(d).toMatchObject({ gap: 0, note: 'أجرة التوصيل 4 بدل 3' });
  });

  it('the money sight is either key: «إدارة الصناديق النقدية» alone sees the mark and the figures too — and still cannot decide', async () => {
    held.add('finance.cashbox');
    table = [mrow('a')];
    const body = await (await get()).json();
    expect(body.orders[0].difference).toMatchObject({ matchId: table[0].id, ours: 20, theirs: 17, gap: 3, decisions: null });
    expect(body.acts.decide).toBe(false);
  });

  it('but what the COMPANY WROTE on the line is the statement’s content — «عرض التسويات» opens it, the cash box alone does not', async () => {
    held.add('finance.cashbox');
    table = [mrow('a')];
    const body = await (await get()).json();
    expect(body.orders[0].difference.courierWord).toBeNull();
    expect(body.orders[0].difference.statementLine).toBeNull();
    // not a word of the company’s row, its notes or its receiver reaches that person
    for (const secret of ['REF-1 | تم التوصيل | 17', 'المزة', '0912345678', 'تم التوصيل']) expect(JSON.stringify(body.orders[0].difference), secret).not.toContain(secret);
    // «عرض التسويات» alone is enough to read it
    held.clear();
    held.add('ops.track');
    held.add('settlement.view');
    const seen = (await (await get()).json()).orders[0].difference;
    expect(seen.courierWord).toMatchObject({ phrase: 'تم التوصيل' });
    expect(seen.statementLine.rawRow).toBe('REF-1 | تم التوصيل | 17');
  });

  it('on the road: a statement is the proof of delivery, so a parcel that is only SHIPPED carries its difference too', async () => {
    asMoney();
    world = [parcel('a', { shippingStatus: 'SHIPPED', settlementStatus: 'NOT_APPLICABLE', deliveredAt: null })];
    table = [mrow('a')];
    expect((await (await get()).json()).orders[0].difference).not.toBeNull();
  });
});

describe('the chip: «فيه فرق» with the server’s number, and the rows it brings', () => {
  it('the number is counted over every parcel — not the page — and is exactly what the press brings, unanswered first', async () => {
    asMoney();
    world = Array.from({ length: 30 }, (_, i) => parcel(`p${String(i).padStart(2, '0')}`, { shippedAt: ago(40 - i) }));
    // every third parcel has a difference; those at index 3 and 12 are answered
    table = world
      .filter((_, i) => i % 3 === 0)
      .map((p, i) => mrow(p.id, i === 1 || i === 4 ? { resolution: 'ACCEPTED_COURIER' } : {}));
    const all = await (await get('limit=5')).json();
    expect(all.facts.difference).toBe(10);
    expect(all.count).toBe(5);
    const chip = await (await get('task=DIFFERENCE&limit=100')).json();
    expect(chip.pagination.total).toBe(10);
    expect(chip.orders).toHaveLength(10);
    const answered = chip.orders.map((o: Any) => o.difference.answered);
    // the unanswered first, then the answered — never interleaved
    expect(answered).toEqual([...answered].sort((a, b) => Number(a) - Number(b)));
    expect(answered.filter(Boolean)).toHaveLength(2);
    // and every row that is not in the chip has none
    for (const o of all.orders) expect(o.difference === null || chip.orders.some((c: Any) => c.id === o.id)).toBe(true);
  });

  it('the other chips and the badge are counted as they always were — a difference adds to none of them', async () => {
    asMoney();
    world = [parcel('a'), parcel('b')];
    table = [mrow('a')];
    const withDiff = await (await get()).json();
    table = [];
    const without = await (await get()).json();
    expect(withDiff.facts.tasks).toEqual(without.facts.tasks);
    expect(withDiff.facts.total).toBe(without.facts.total);
    expect(withDiff.lateCount).toBe(without.lateCount);
    expect(without.facts.difference).toBe(0);
  });

  it('an unknown word is still a 400 in Arabic, never a quiet «everything»', async () => {
    asMoney();
    const res = await get('task=DIFFERENC');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ errorAr: 'المهمة غير معروف: DIFFERENC' });
  });

  it('the chip does not widen the question: under the default state a delivered parcel that is already settled is still not asked for — it shows under «مسلَّم» or «الكل»', async () => {
    asMoney();
    await get('task=DIFFERENCE');
    const asked = db.order.findMany.mock.calls[0][0] as Any;
    expect(asked.where.AND[0].OR).toContainEqual({ shippingStatus: { in: ['DELIVERED', 'PARTIALLY_DELIVERED'] }, settlementStatus: { not: 'SETTLED' } });
    // and with the state that includes them, they are asked for and carry their difference — answerable only as «قيد المراجعة»
    db.order.findMany.mockClear();
    world = [parcel('a', { settlementStatus: 'SETTLED' })];
    table = [mrow('a')];
    const body = await (await get('task=DIFFERENCE&status=every')).json();
    expect((db.order.findMany.mock.calls[0][0] as Any).where.AND).not.toContainEqual(expect.objectContaining({ OR: expect.anything() }));
    expect(body.orders[0].difference).toMatchObject({ matchId: table[0].id, answered: false });
  });

  it('is one of the choices a state can be combined with — «مسلَّم» only, for a person who may see delivered parcels', async () => {
    asMoney();
    world = [parcel('a'), parcel('b', { shippingStatus: 'SHIPPED', settlementStatus: 'NOT_APPLICABLE', deliveredAt: null })];
    table = [mrow('a'), mrow('b')];
    const body = await (await get('task=DIFFERENCE&status=DELIVERED')).json();
    expect(body.applied).toMatchObject({ task: 'DIFFERENCE', status: 'DELIVERED' });
    const asked = db.order.findMany.mock.calls[0][0] as Any;
    expect(asked.where.AND).toContainEqual({ shippingStatus: 'DELIVERED' });
  });
});

describe('who may decide — and what the door tells the screen it may draw', () => {
  it('«مراجعة المطابقات» adds the matrix of the matching screen: each answer allowed, or the sentence why not', async () => {
    asDecider();
    table = [mrow('a')];
    const body = await (await get()).json();
    expect(body.acts.decide).toBe(true);
    expect(body.orders[0].difference.decisions).toEqual({
      ACCEPTED_COURIER: { allowed: true, why: null },
      OURS_STANDS: { allowed: true, why: null },
      UNDER_REVIEW: { allowed: true, why: null },
    });
  });

  it('the sentence is the door’s own: a parcel only on the road cannot be claimed against — the matching screen says exactly this', async () => {
    asDecider();
    world = [parcel('a', { shippingStatus: 'SHIPPED', settlementStatus: 'NOT_APPLICABLE', deliveredAt: null })];
    table = [mrow('a')];
    const d = (await (await get()).json()).orders[0].difference;
    expect(d.decisions.OURS_STANDS).toEqual({ allowed: false, why: WHY.notDeliveredYet });
    expect(d.decisions.ACCEPTED_COURIER.allowed).toBe(true);
    expect(d.decisions.UNDER_REVIEW.allowed).toBe(true);
  });

  it('a parcel already settled elsewhere: both figures are refused with the sentence, only «قيد المراجعة» stays', async () => {
    asDecider();
    world = [parcel('a', { settlementStatus: 'SETTLED' })];
    table = [mrow('a')];
    const d = (await (await get()).json()).orders[0].difference;
    expect(d.decisions).toEqual({
      ACCEPTED_COURIER: { allowed: false, why: WHY.settled },
      OURS_STANDS: { allowed: false, why: WHY.settled },
      UNDER_REVIEW: { allowed: true, why: null },
    });
  });

  it('a closed statement takes no answer: every saying carries the one sentence of a closed statement, and the row says closed', async () => {
    asDecider();
    table = [mrow('a', { statement: { matchingClosedAt: ago(1) } })];
    const d = (await (await get()).json()).orders[0].difference;
    expect(d.closed).toBe(true);
    for (const k of ['ACCEPTED_COURIER', 'OURS_STANDS', 'UNDER_REVIEW']) expect(d.decisions[k], k).toEqual({ allowed: false, why: STATEMENT_CLOSED_SENTENCE });
  });

  it('NEGATIVE: the money sight without «مراجعة المطابقات» is told «no» and gets no matrix — it may see, not decide', async () => {
    asMoney();
    table = [mrow('a')];
    const body = await (await get()).json();
    expect(body.acts.decide).toBe(false);
    expect(body.orders[0].difference.decisions).toBeNull();
  });

  it('NEGATIVE: «مراجعة المطابقات» WITHOUT the money sight is not enough — it is never drawn without the figures it answers', async () => {
    held.add('settlement.review');
    table = [mrow('a')];
    const body = await (await get()).json();
    expect(body.acts.decide).toBe(false);
    expect(body.access.money).toBe(false);
    expect(body.orders[0]).not.toHaveProperty('difference');
  });

  it('the matrix is read for the page’s differences in one go — three reads however many rows carry one', async () => {
    asDecider();
    world = Array.from({ length: 12 }, (_, i) => parcel(`q${i}`));
    table = world.map((p) => mrow(p.id));
    await get();
    const afterTwelve = db.settlementMatch.findMany.mock.calls.length;
    vi.clearAllMocks();
    world = world.slice(0, 2);
    table = world.map((p) => mrow(p.id));
    db.order.findMany.mockImplementation(async (args: Any) => (args.where.id ? world.filter((p) => args.where.id.in.includes(p.id)) : world.slice(0, args.take)));
    db.settlementMatch.findMany.mockImplementation(async (args: Any) => table.filter((r) => holds(r, args.where)));
    db.orderStatusLog.findMany.mockResolvedValue([]);
    db.orderChangeRequest.findMany.mockResolvedValue([]);
    db.orderActivity.findMany.mockResolvedValue([]);
    db.deliveryFee.findMany.mockResolvedValue([]);
    db.deliveryProvider.findMany.mockResolvedValue([]);
    db.region.findMany.mockResolvedValue([]);
    await get();
    expect(db.settlementMatch.findMany.mock.calls.length).toBe(afterTwelve);
    // two to find them (the lines that disagreed, the clean ones of those), one to read the page's rows whole, one for «held elsewhere»
    expect(afterTwelve).toBe(4);
  });
});

describe('the sight: no money sight → no field, no number, no read, and a 403 for the chip', () => {
  it('the match table is never read for a person without it — not even to count', async () => {
    table = [mrow('a')];
    const res = await get();
    expect(res.status).toBe(200);
    expect(db.settlementMatch.findMany).not.toHaveBeenCalled();
  });

  it('the row has no `difference` at all, `facts` carries no number for it and `acts.decide` is «no»', async () => {
    table = [mrow('a')];
    const body = await (await get()).json();
    expect(body.access).toEqual({ money: false, returns: false, collect: false });
    expect(body.orders).toHaveLength(1);
    expect(body.orders[0]).not.toHaveProperty('difference');
    expect(body.facts).not.toHaveProperty('difference');
    expect(body.acts.decide).toBe(false);
    expect(JSON.stringify(body)).not.toContain('ST-2026-0007');
  });

  it('`?task=DIFFERENCE` is a 403 in the door’s own sentence — as for «بانتظار التحصيل» — and the parcels are not even read', async () => {
    table = [mrow('a')];
    const res = await get('task=DIFFERENCE');
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).toContain('settlement.view');
    expect(db.order.findMany).not.toHaveBeenCalled();
    expect(db.settlementMatch.findMany).not.toHaveBeenCalled();
  });

  it('a parcel on the road is still on the list for them — only the difference is withheld', async () => {
    world = [parcel('a', { shippingStatus: 'SHIPPED', settlementStatus: 'NOT_APPLICABLE', deliveredAt: null })];
    table = [mrow('a')];
    const body = await (await get()).json();
    expect(body.orders).toHaveLength(1);
    expect(body.orders[0]).not.toHaveProperty('difference');
  });

  it('the person must hold «متابعة الشحن» first: without it nothing is answered, and nothing read', async () => {
    requirePermission.mockRejectedValue(new Error('Forbidden: missing required permission ops.track'));
    asDecider();
    const res = await get();
    expect(res.status).toBe(403);
    expect(db.settlementMatch.findMany).not.toHaveBeenCalled();
  });
});

describe('the scope — the company and the store are in every question, and in its effect', () => {
  it('every read of the match table names the company (its index starts with it), and the reads of statements name the store', async () => {
    asDecider();
    table = [mrow('a')];
    await get();
    const asked = askedOfMatches();
    expect(asked.length).toBeGreaterThan(0);
    for (const q of asked) expect(q.where.companyId, JSON.stringify(q.where)).toBe('c1');
    // the lean reads and the page's own read are scoped to the statement's store too
    expect(asked.filter((q) => q.where.statement?.storeId === 's1').length).toBeGreaterThanOrEqual(3);
  });

  it('another company’s rows are never a difference of this company’s parcel — even with the same order id', async () => {
    asMoney();
    table = [mrow('a', { companyId: 'c2', resolutionNote: 'سرّ الشركة الثانية' })];
    const body = await (await get()).json();
    expect(body.orders[0].difference).toBeNull();
    expect(body.facts.difference).toBe(0);
    expect(JSON.stringify(body)).not.toContain('سرّ الشركة الثانية');
  });

  it('a statement of another store never marks this store’s parcel', async () => {
    asMoney();
    table = [mrow('a', { statement: { storeId: 's2' } })];
    const body = await (await get()).json();
    expect(body.orders[0].difference).toBeNull();
    expect(body.facts.difference).toBe(0);
  });

  it('a clean line of another company never ends this company’s difference', async () => {
    asMoney();
    table = [mrow('a', { createdAt: ago(3) }), mrow('a', { companyId: 'c2', result: 'MATCHED', createdAt: ago(1) })];
    expect((await (await get()).json()).orders[0].difference).not.toBeNull();
  });
});

describe('a row that is gone between the two reads, and a table that is slow', () => {
  it('the chip counted it, the page’s own read no longer finds it: the row draws no mark and the page is still answered', async () => {
    asMoney();
    table = [mrow('a')];
    let calls = 0;
    db.settlementMatch.findMany.mockImplementation(async (args: Any) => {
      calls += 1;
      // the lean reads (the first two) see the row; the page's own read (by id) finds nothing — a re-run deleted it meanwhile
      return args.where.id ? [] : table.filter((r) => holds(r, args.where));
    });
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.orders[0].difference).toBeNull();
    expect(body.facts.difference).toBe(1);
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it('a failed read of the match table is the door’s ordinary error — never a quiet «no difference»', async () => {
    asMoney();
    db.settlementMatch.findMany.mockRejectedValue(new Error('connection lost'));
    const res = await get();
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});

describe('it adds no write — the door and its helpers only read', () => {
  const read = (rel: string) => stripComments(readFileSync(join(process.cwd(), rel), 'utf8'));
  for (const rel of ['src/lib/parcel-tracking/difference.ts', 'src/lib/parcel-tracking/difference-words.ts']) {
    it(`${rel} writes nothing, moves no money and opens no transaction`, () => {
      const src = read(rel);
      expect(src).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/);
      expect(src).not.toMatch(/recordMovement|\$transaction|\$executeRaw|\$queryRaw/);
    });
  }

  it('the route’s own source has no write either', () => {
    const src = read('src/app/api/ops/tracking/route.ts');
    expect(src).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/);
    expect(src).not.toMatch(/recordMovement|\$transaction/);
  });
});
