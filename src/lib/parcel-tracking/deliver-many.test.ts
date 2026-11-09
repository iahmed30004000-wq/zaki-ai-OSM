/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from 'vitest';

/**
 * «استلم» FOR A PAGE OF PARCELS — THE RULE, HELD TO THE THINGS IT MUST AGREE WITH.
 *
 * Three agreements, each driven through the real code on the other side and never through a copy of its answer:
 *
 *   · the SCREEN and the DOOR judge the same word the same way — the row is drawn by the list reader (`readTrackingList`), the
 *     door judges with `judgeWord`, and a box is drawn on a row exactly when the door would take it;
 *   · the DOOR and the SINGLE door agree on which states a parcel can be recorded from, and in which sentence a refusal is said:
 *     the list of states and every shared sentence are held to what the real `recordPartialDelivery` does and says;
 *   · the word is read by its CODE — the free note a driver typed never decides — through the very lines the real feed writes.
 */

vi.mock('../db', () => ({ db: {} }));
vi.mock('../stock-consumption', () => ({ consumeOrderStock: vi.fn(async () => ({ taken: 0, short: 0, alreadyDone: false })) }));

import { BULK_DELIVER_MOST, DELIVER_BOX_STATES, canBulkDeliver, hasDeliverBox } from './bulk-deliver';
import { REFUSAL_AR, SINGLE_DOOR_STATES, everyUnitTaken, judgeState, judgeWord, otherWordReason } from './deliver-many';
import { readTrackingList, type LeanParcel } from './list';
import { COURIER_SAID, SAID_STATUSES } from '../couriers/courier-said';
import { wordLine } from '../couriers/courier-said-lines.fixture';
import { LOGESTECHS_STATUS } from '../couriers/logestechs';
import { SHIPPING_STATUSES } from '../shipping-workflow';
import { PartialDeliveryRefused, recordPartialDelivery } from '../partial-delivery';
import { repoFile, stripComments } from '../guard-source';

const NOW = new Date('2026-11-09T12:00:00.000Z');
const HOUR = 3_600_000;
const line = (code: string, over: { notes?: string; hoursAgo?: number; id?: string } = {}) =>
  wordLine({ orderId: 'o1', code, at: new Date(NOW.getTime() - (over.hoursAgo ?? 2) * HOUR), notes: over.notes, id: over.id });

describe('the box and the ticks: one rule, light enough for the screen', () => {
  it('only «مشحون» and «خرج للتوصيل» carry the box', () => {
    expect([...DELIVER_BOX_STATES]).toEqual(['SHIPPED', 'OUT_FOR_DELIVERY']);
    for (const status of SHIPPING_STATUSES) expect(hasDeliverBox(status), status).toBe(status === 'SHIPPED' || status === 'OUT_FOR_DELIVERY');
    expect(hasDeliverBox('')).toBe(false);
  });

  it.each(SHIPPING_STATUSES.flatMap((status) => [...SAID_STATUSES, null, undefined].map((said) => [status, said] as const)))(
    '— %s with the company saying %s: ticked only for a delivered word on a parcel with the box',
    (status, said) => {
      const row = { shippingStatus: status, courierSaid: said === undefined ? undefined : said === null ? null : { status: said } };
      expect(canBulkDeliver(row)).toBe(hasDeliverBox(status) && said === 'DELIVERED');
    }
  );

  it('the cap is fifty — a page is twenty-five, so a page always fits', () => {
    expect(BULK_DELIVER_MOST).toBe(50);
  });

  it('the screen’s file reads nothing from the server: no database, no Prisma, no adapter', () => {
    const src = stripComments(repoFile('src/lib/parcel-tracking/bulk-deliver.ts'));
    expect(src).not.toMatch(/^import /m);
  });
});

describe('the states: the single door’s list, held to what the REAL function does', () => {
  it('the states `recordPartialDelivery` takes are exactly SINGLE_DOOR_STATES', async () => {
    const taken: string[] = [];
    for (const status of SHIPPING_STATUSES) {
      const tx = {
        order: {
          findFirst: async () => ({
            id: 'o1', orderNumber: 'X', shippingStatus: status, deliveryFee: 0, customerId: 'cu', priceIncludesDelivery: false,
            deliveredAt: null, returnedAt: null, deliveryProviderId: null, settlementStatus: 'NOT_APPLICABLE',
            items: [{ id: 'i1', productId: 'p', productName: 'n', quantity: 1, freeQuantity: 0, unitPrice: 1, discountShare: 0, lineTotal: 1, deliveredQty: null }],
            addOns: [],
          }),
          update: async () => ({}),
        },
        orderItem: { update: async () => ({}) },
        customer: { update: async () => ({}) },
        deliveryAttempt: { findFirst: async () => null, create: async () => ({}) },
        orderActivity: { create: async () => ({}) },
        orderNote: { create: async () => ({}) },
      };
      try {
        await recordPartialDelivery(tx as never, { companyId: 'c1', orderId: 'o1', lines: [{ itemId: 'i1', deliveredQty: 1 }], minorUnit: 2, userId: 'u1' });
        taken.push(status);
      } catch (e) {
        if (!(e instanceof PartialDeliveryRefused) || e.code !== 'NOT_AT_DOOR') throw e;
      }
    }
    expect(taken.sort()).toEqual([...SINGLE_DOOR_STATES].sort());
  });

  it('the screen’s box is a subset of it — the page never does more than the row', () => {
    for (const status of DELIVER_BOX_STATES) expect(SINGLE_DOOR_STATES).toContain(status);
    // …and the one state the single door takes that the screen draws no box for is the one this door leaves out, in its own sentence.
    const left = SINGLE_DOOR_STATES.filter((s) => !hasDeliverBox(s));
    expect(left).toEqual(['FAILED_DELIVERY']);
    expect(judgeState({ shippingStatus: 'FAILED_DELIVERY', deliveredAt: null, returnedAt: null })).toEqual({ ok: false, code: 'NO_BOX', reason: REFUSAL_AR.NO_BOX });
  });
});

describe('the sentences the two doors share are the single door’s, word for word', () => {
  const refusal = async (over: Record<string, unknown>) => {
    const tx = {
      order: {
        findFirst: async () =>
          over.missing
            ? null
            : { id: 'o1', orderNumber: 'X', shippingStatus: 'SHIPPED', deliveryFee: 0, customerId: 'cu', priceIncludesDelivery: false, deliveredAt: null, returnedAt: null, deliveryProviderId: null, settlementStatus: 'N', items: [{ id: 'i1', productId: 'p', productName: 'n', quantity: 1, freeQuantity: 0, unitPrice: 1, discountShare: 0, lineTotal: 1, deliveredQty: null }], addOns: [], ...over },
      },
    };
    try {
      await recordPartialDelivery(tx as never, { companyId: 'c1', orderId: 'o1', lines: [{ itemId: 'i1', deliveredQty: 1 }], minorUnit: 2, userId: 'u1' });
    } catch (e) {
      return e as PartialDeliveryRefused;
    }
    throw new Error('it was not refused');
  };

  it('«سُجِّل تسليم هذا الطلب مسبقاً» — a delivery date, or a return date', async () => {
    for (const over of [{ deliveredAt: new Date() }, { returnedAt: new Date() }]) {
      const e = await refusal(over);
      expect(e.code).toBe('ALREADY_SETTLED');
      expect(e.message).toBe(REFUSAL_AR.ALREADY_RECORDED);
    }
  });

  it('«لا يمكن تسجيل التسليم قبل خروج الشحنة للتوصيل» — a parcel that never left', async () => {
    const e = await refusal({ shippingStatus: 'READY_FOR_PICKUP' });
    expect(e.code).toBe('NOT_AT_DOOR');
    expect(e.message).toBe(REFUSAL_AR.NOT_AT_DOOR);
  });

  it('«الطلب غير موجود» — and the no-lines sentence is the one the single route says', async () => {
    const e = await refusal({ missing: true });
    expect(e.code).toBe('NOT_FOUND');
    expect(e.message).toBe(REFUSAL_AR.NOT_FOUND);
    expect(repoFile('src/app/api/ops/tracking/deliver/route.ts')).toContain(`'${REFUSAL_AR.NO_LINES}'`);
  });

  it('every sentence is short plain Arabic — no English word, no code name', () => {
    for (const sentence of [...Object.values(REFUSAL_AR), otherWordReason('مؤجلة')]) {
      expect(sentence, sentence).not.toMatch(/[A-Za-z]/);
      expect(sentence.length, sentence).toBeLessThan(90);
    }
  });
});

describe('the state half, in the single door’s order', () => {
  const order = (shippingStatus: string, over: Record<string, unknown> = {}) => ({ shippingStatus, deliveredAt: null, returnedAt: null, ...over }) as any;

  it('a date wins over the state: «recorded before» is said before «not at the door»', () => {
    expect(judgeState(order('DELIVERED', { deliveredAt: new Date() }))).toMatchObject({ ok: false, code: 'ALREADY_RECORDED' });
    expect(judgeState(order('SHIPPED', { returnedAt: new Date() }))).toMatchObject({ ok: false, code: 'ALREADY_RECORDED' });
    expect(judgeState(order('DELIVERED'))).toMatchObject({ ok: false, code: 'NOT_AT_DOOR' });
  });

  it.each(SHIPPING_STATUSES)('— %s', (status) => {
    const verdict = judgeState(order(status));
    if (status === 'SHIPPED' || status === 'OUT_FOR_DELIVERY') expect(verdict).toEqual({ ok: true });
    else if (status === 'FAILED_DELIVERY') expect(verdict).toMatchObject({ ok: false, code: 'NO_BOX' });
    else expect(verdict).toMatchObject({ ok: false, code: 'NOT_AT_DOOR' });
  });
});

describe('the word half: the NEWEST line, read by its CODE, from the lines the real feed writes', () => {
  const judged = (lines: ReturnType<typeof line>[], state = 'SHIPPED') => {
    // The list asks the database for them newest first; the door asks for ONE, the newest. Both end up at the same line.
    const newest = [...lines].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))[0];
    return judgeWord(state, newest, NOW);
  };

  it.each(Object.entries(LOGESTECHS_STATUS).filter(([, s]) => s && (SAID_STATUSES as readonly string[]).includes(s)))(
    'the company’s code %s (→ %s): accepted only for the one that means «تم التوصيل»',
    (code, status) => {
      const verdict = judged([line(code)]);
      expect(verdict.ok, code).toBe(status === 'DELIVERED');
    }
  );

  it('the driver’s free note never decides, in either direction', () => {
    expect(judged([line('DELIVERED_TO_RECIPIENT', { notes: 'العميل طلب يأجّلها' })]).ok).toBe(true);
    expect(judged([line('POSTPONED_DELIVERY', { notes: 'تم التوصيل' })])).toMatchObject({ ok: false, code: 'OTHER_WORD', reason: otherWordReason('مؤجلة') });
    expect(judged([line('PARTIALLY_DELIVERED', { notes: 'تم التوصيل' })])).toMatchObject({ ok: false, code: 'OTHER_WORD' });
  });

  it('no line at all is a word the company never said', () => {
    expect(judgeWord('SHIPPED', undefined, NOW)).toEqual({ ok: false, code: 'NO_WORD', reason: REFUSAL_AR.NO_WORD });
  });

  it('two lines: the newer one decides, in either order of arrival', () => {
    const delivered = line('DELIVERED_TO_RECIPIENT', { hoursAgo: 5, id: 'a' });
    const postponed = line('POSTPONED_DELIVERY', { hoursAgo: 1, id: 'b' });
    expect(judged([delivered, postponed]).ok).toBe(false);
    expect(judged([postponed, delivered]).ok).toBe(false);
    const takenBack = line('DELIVERED_TO_RECIPIENT', { hoursAgo: 1, id: 'c' });
    const earlier = line('POSTPONED_DELIVERY', { hoursAgo: 5, id: 'd' });
    expect(judged([earlier, takenBack]).ok).toBe(true);
    expect(judged([takenBack, earlier]).ok).toBe(true);
  });

  it('a damaged line says nothing: bad metadata, no date, a state that is not one of the five', () => {
    const base = line('DELIVERED_TO_RECIPIENT');
    expect(judgeWord('SHIPPED', { ...base, metadata: '{oops' }, NOW)).toMatchObject({ ok: false, code: 'UNCLEAR_WORD' });
    expect(judgeWord('SHIPPED', { ...base, metadata: null }, NOW)).toMatchObject({ ok: false, code: 'UNCLEAR_WORD' });
    expect(judgeWord('SHIPPED', { ...base, createdAt: new Date('nope') }, NOW)).toMatchObject({ ok: false, code: 'UNCLEAR_WORD' });
    expect(judgeWord('SHIPPED', { ...base, newStatus: 'OUT_FOR_DELIVERY' }, NOW)).toMatchObject({ ok: false, code: 'UNCLEAR_WORD' });
  });

  it('a word that AGREES with the parcel’s own state says nothing new', () => {
    expect(judgeWord('DELIVERED', line('DELIVERED_TO_RECIPIENT'), NOW)).toMatchObject({ ok: false, code: 'UNCLEAR_WORD' });
  });
});

/**
 * THE SCREEN AND THE DOOR, ON THE SAME PARCELS. The row’s word is made by the list reader over the same table of lines the door
 * reads one from; a box is drawn exactly when the door would accept the word. Nothing here is hand-keyed except the lines.
 */
describe('a box is drawn on a row exactly when the door would take its word', () => {
  type Case = { name: string; state: string; lines: ReturnType<typeof line>[] };
  const cases: Case[] = [
    { name: 'delivered, shipped', state: 'SHIPPED', lines: [line('DELIVERED_TO_RECIPIENT')] },
    { name: 'delivered, out for delivery', state: 'OUT_FOR_DELIVERY', lines: [line('DELIVERED_TO_RECIPIENT')] },
    { name: 'delivered with a note that says otherwise', state: 'SHIPPED', lines: [line('DELIVERED_TO_RECIPIENT', { notes: 'مؤجلة' })] },
    { name: 'postponed with a note that says delivered', state: 'SHIPPED', lines: [line('POSTPONED_DELIVERY', { notes: 'تم التوصيل' })] },
    { name: 'part delivery', state: 'OUT_FOR_DELIVERY', lines: [line('PARTIALLY_DELIVERED')] },
    { name: 'returned', state: 'SHIPPED', lines: [line('RETURNED_BY_RECIPIENT')] },
    { name: 'cancelled', state: 'SHIPPED', lines: [line('CANCELLED')] },
    { name: 'no word', state: 'SHIPPED', lines: [] },
    { name: 'delivered then postponed', state: 'SHIPPED', lines: [line('DELIVERED_TO_RECIPIENT', { hoursAgo: 6, id: 'x1' }), line('POSTPONED_DELIVERY', { hoursAgo: 1, id: 'x2' })] },
    { name: 'postponed then delivered', state: 'SHIPPED', lines: [line('POSTPONED_DELIVERY', { hoursAgo: 6, id: 'y1' }), line('DELIVERED_TO_RECIPIENT', { hoursAgo: 1, id: 'y2' })] },
    { name: 'delivered, but our state is already delivered', state: 'DELIVERED', lines: [line('DELIVERED_TO_RECIPIENT')] },
    { name: 'delivered, failed attempt', state: 'FAILED_DELIVERY', lines: [line('DELIVERED_TO_RECIPIENT')] },
    { name: 'delivered, not yet picked up', state: 'READY_FOR_PICKUP', lines: [line('DELIVERED_TO_RECIPIENT')] },
  ];

  it('— for thirteen kinds of parcel in ONE list read, the row’s box and the door’s verdict agree', async () => {
    const parcels: LeanParcel[] = cases.map((c, i) => ({
      id: `p${i}`, shippingStatus: c.state, settlementStatus: 'NOT_APPLICABLE', trackingNumber: `T${i}`, shippedAt: new Date(NOW.getTime() - 3 * 86_400_000),
      deliveredAt: null, returnedAt: null, deliveryProviderId: null, regionId: null, confirmationStatus: 'CONFIRMED', updatedAt: NOW,
    }));
    const table = cases.flatMap((c, i) => c.lines.map((l) => ({ ...l, orderId: `p${i}`, action: COURIER_SAID })));
    const db = {
      order: { findMany: async () => parcels },
      deliveryFee: { findMany: async () => [] },
      orderStatusLog: { findMany: async () => [] },
      orderChangeRequest: { findMany: async () => [] },
      orderActivity: {
        findMany: async (args: any) => {
          if (args.where.action !== COURIER_SAID) return [];
          // The list names the company in this question (the table's only index that starts with an order leads with it).
          if (args.where.companyId !== 'c1') throw new Error('the fake database: the activity read does not name the company');
          const keys = [].concat(args.orderBy ?? []) as Record<string, 'asc' | 'desc'>[];
          return table
            .filter((l) => args.where.orderId.in.includes(l.orderId))
            .sort((a, b) => {
              for (const k of keys) {
                const [f, dir] = Object.entries(k)[0];
                const x = (a as any)[f] instanceof Date ? (a as any)[f].getTime() : String((a as any)[f]);
                const y = (b as any)[f] instanceof Date ? (b as any)[f].getTime() : String((b as any)[f]);
                if (x !== y) return (x < y ? -1 : 1) * (dir === 'desc' ? -1 : 1);
              }
              return 0;
            });
        },
      },
      deliveryProvider: { findMany: async () => [] },
      region: { findMany: async () => [] },
    };
    const list = await readTrackingList(db as never, { companyId: 'c1', where: {}, now: NOW, task: null, courier: null, region: null, age: null, page: 1, limit: 100 });
    expect(list.ids).toHaveLength(cases.length);

    let boxes = 0;
    cases.forEach((c, i) => {
      const said = list.courierSaid.get(`p${i}`) ?? null;
      const drawn = canBulkDeliver({ shippingStatus: c.state, courierSaid: said });
      const newest = [...table.filter((l) => l.orderId === `p${i}`)].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))[0];
      const state = judgeState({ shippingStatus: c.state, deliveredAt: null, returnedAt: null });
      const taken = state.ok && judgeWord(c.state, newest, NOW).ok;
      expect(drawn, c.name).toBe(taken);
      if (drawn) boxes++;
    });
    // Four of the thirteen carry a box: the two plain delivered words, the delivered word with a note that says otherwise, and
    // the delivered word that came after a postponement.
    expect(boxes).toBe(4);
  });
});

describe('every unit, as the single door’s `outcome: ALL` expands it', () => {
  it('quantity plus gift units, per line, in the order of the lines', () => {
    expect(everyUnitTaken([{ id: 'a', quantity: 2, freeQuantity: 1 }, { id: 'b', quantity: 1, freeQuantity: 0 }])).toEqual([
      { itemId: 'a', deliveredQty: 3 },
      { itemId: 'b', deliveredQty: 1 },
    ]);
    expect(everyUnitTaken([])).toEqual([]);
  });

  it('the single route expands with the same expression (the pin that keeps the two apart from drifting)', () => {
    const src = stripComments(repoFile('src/app/api/ops/tracking/deliver/route.ts'));
    expect(src).toMatch(/asked\.outcome === 'ALL' \? i\.quantity \+ i\.freeQuantity : 0/);
    expect(stripComments(repoFile('src/lib/parcel-tracking/deliver-many.ts'))).toMatch(/deliveredQty: i\.quantity \+ i\.freeQuantity/);
  });
});

describe('the list, its door and the single door know nothing of the press — what they answer is what they answered', () => {
  it('no file the press reads from mentions it: the list’s wire shape and the single door are the ones they were', () => {
    for (const file of [
      'src/app/api/ops/tracking/route.ts',
      'src/app/api/ops/tracking/deliver/route.ts',
      'src/lib/parcel-tracking/list.ts',
      'src/lib/parcel-tracking/sight.ts',
      'src/lib/parcel-tracking/said.ts',
      'src/lib/couriers/courier-said.ts',
      'src/lib/couriers/courier-said-read.ts',
      'src/lib/partial-delivery.ts',
    ]) {
      expect(repoFile(file), file).not.toMatch(/deliver-many|bulk-deliver|deliverMany|canBulkDeliver|BULK_DELIVER|BulkDeliver/);
    }
  });

  it('the press reads the company’s word and writes the delivery only through the two functions the rest of the product already uses', () => {
    const src = stripComments(repoFile('src/lib/parcel-tracking/deliver-many.ts'));
    expect(src).toMatch(/courierSaidAgainst\(/);
    expect(src).toMatch(/recordPartialDelivery\(tx, \{/);
    expect((src.match(/recordPartialDelivery\(/g) ?? []).length).toBe(1);
    // It reaches for no stock function, no wallet and no statement of its own.
    expect(src).not.toMatch(/consumeOrderStock|drawDownStock|recordMovement|settleStatement|markPayableForOrders/);
    expect(src).not.toMatch(/wallet|collectedAmount|settlementStatus/i);
  });
});
