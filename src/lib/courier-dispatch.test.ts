import { beforeEach, describe, expect, it, vi } from 'vitest';

const { db, adapterFor, logAudit } = vi.hoisted(() => ({
  db: {
    shippingBatch: { findFirst: vi.fn() },
    order: { findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    orderActivity: { create: vi.fn() },
    deliveryFee: { findMany: vi.fn() },
    /*
     * The claim is one conditional UPDATE … RETURNING, so the double has to
     * speak raw SQL. `$queryRaw` is called as a tagged template: the first
     * argument is the SQL fragments, the rest the values.
     */
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
  },
  adapterFor: vi.fn(),
  logAudit: vi.fn(),
}));
vi.mock('./db', () => ({ db }));
vi.mock('./couriers', () => ({ adapterFor: (...a: unknown[]) => adapterFor(...a) }));
vi.mock('./audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));

import { dispatchBatch } from './courier-dispatch';
import { markOutcomeUnknown } from './couriers/types';
import { groupDispatchReasons } from './dispatch-reason';

/**
 * Handing orders to the courier and taking back the barcode.
 *
 * The expensive mistakes here are physical: a second create is a second
 * parcel, billed and collected twice, with a customer opening the door to a
 * duplicate. And an all-or-nothing dispatch holds seventeen good parcels
 * hostage to one bad phone number.
 */

const order = (over: Record<string, unknown> = {}) => ({
  id: 'o1', orderNumber: 'SY-2026-0001', merchantRef: 'SY-2026-0001',
  trackingNumber: null, totalAmount: 60, currency: 'USD',
  quantity: 2, freeQuantity: 1, customerNotes: null, deliveryProviderId: 'p1',
  customer: { fullName: 'زبون', rawPhone: '0999111222', phone: '999111222', address: 'شارع' },
  region: { name: 'دمشق' },
  ...over,
});

const createShipment = vi.fn();
const input = { batchId: 'b1', companyId: 'c1', storeId: 's1', userId: 'u1' };

beforeEach(() => {
  vi.clearAllMocks();
  db.shippingBatch.findFirst.mockResolvedValue({
    id: 'b1', batchNumber: 'BATCH-2026-0001', status: 'READY',
    provider: { id: 'p1', code: 'BASHA', apiEnabled: true, companyId: 'c1', storeId: 's1' },
  });
  adapterFor.mockReturnValue({ code: 'LOGESTECHS', automated: true, createShipment });
  createShipment.mockResolvedValue({ trackingNumber: 'BC-777' });
  db.order.update.mockResolvedValue({});
  db.order.updateMany.mockResolvedValue({ count: 1 });
  db.deliveryFee.findMany.mockResolvedValue([]);
  // By default the claim is won: the ordinary case is one dispatcher.
  db.$queryRaw.mockImplementation(async (frags: string[]) =>
    frags.join(' ').includes('UPDATE') ? [{ id: 'o1' }] : [{ tracking: null }]
  );
  db.$executeRaw.mockResolvedValue(1);
});

/** The SQL of each raw call, whitespace-flattened, with its values. */
const raw = (fn: { mock: { calls: unknown[][] } }) =>
  fn.mock.calls.map((c) => ({
    sql: (c[0] as string[]).join(' ? ').replace(/\s+/g, ' ').trim(),
    args: c.slice(1),
  }));

describe('dispatching a batch', () => {
  it('stores the courier barcode as the tracking number', async () => {
    db.order.findMany.mockResolvedValue([order()]);
    const res = await dispatchBatch(input);
    expect(res.sent).toBe(1);
    expect(db.order.updateMany.mock.calls[0][0].data.trackingNumber).toBe('BC-777');
  });

  it('sends OUR order number as the merchant reference', async () => {
    // That is the key their statement line is matched back on.
    db.order.findMany.mockResolvedValue([order()]);
    await dispatchBatch(input);
    expect(createShipment.mock.calls[0][0].merchantRef).toBe('SY-2026-0001');
  });

  it('counts gift units as pieces — they are parcels too', async () => {
    db.order.findMany.mockResolvedValue([order()]);
    await dispatchBatch(input);
    expect(createShipment.mock.calls[0][0].pieces).toBe(3);
  });

  it('sends the phone as the customer typed it', async () => {
    // Couriers dial it, and the normalized form can lose the leading zero
    // their system expects.
    db.order.findMany.mockResolvedValue([order()]);
    await dispatchBatch(input);
    expect(createShipment.mock.calls[0][0].customer.phone).toBe('0999111222');
  });

  it('never creates a second parcel for an order that already has one', async () => {
    // The whole reason this is not a blind retry: a duplicate is a real
    // parcel, billed and collected twice.
    db.order.findMany.mockResolvedValue([order({ trackingNumber: 'BC-OLD' })]);
    const res = await dispatchBatch(input);
    expect(createShipment).not.toHaveBeenCalled();
    expect(res.outcomes[0].skipped).toBe('ALREADY_SENT');
    expect(res.sent).toBe(0);
  });

  it('ships the good ones when one fails', async () => {
    db.order.findMany.mockResolvedValue([
      order({ id: 'o1', orderNumber: 'SY-1' }),
      order({ id: 'o2', orderNumber: 'SY-2' }),
      order({ id: 'o3', orderNumber: 'SY-3' }),
    ]);
    createShipment
      .mockResolvedValueOnce({ trackingNumber: 'BC-1' })
      .mockRejectedValueOnce(new Error('LOGESTECHS_CITY_UNKNOWN: لم يُعرف رمز المدينة'))
      .mockResolvedValueOnce({ trackingNumber: 'BC-3' });

    const res = await dispatchBatch(input);
    expect(res.sent).toBe(2);
    expect(res.failed).toBe(1);
    expect(db.order.updateMany).toHaveBeenCalledTimes(2);
  });

  it("keeps the courier's own words about why", async () => {
    // "city unknown" and "invalid phone" are different problems; a generic
    // failure teaches nobody anything.
    db.order.findMany.mockResolvedValue([order()]);
    createShipment.mockRejectedValue(new Error('LOGESTECHS_CITY_UNKNOWN: لم يُعرف رمز المدينة'));
    const res = await dispatchBatch(input);
    expect(res.outcomes[0].error).toContain('CITY_UNKNOWN');
  });

  it('does not call a manual courier that has no API', async () => {
    adapterFor.mockReturnValue({ code: 'MANUAL', automated: false, createShipment });
    db.order.findMany.mockResolvedValue([order()]);
    const res = await dispatchBatch(input);
    expect(createShipment).not.toHaveBeenCalled();
    expect(res.outcomes[0].skipped).toBe('NOT_AUTOMATED');
  });

  it('skips an order with no courier assigned', async () => {
    db.order.findMany.mockResolvedValue([order({ deliveryProviderId: null })]);
    const res = await dispatchBatch(input);
    expect(res.outcomes[0].skipped).toBe('NO_PROVIDER');
  });

  it('refuses a batch of another company', async () => {
    db.shippingBatch.findFirst.mockResolvedValue(null);
    await expect(dispatchBatch(input)).rejects.toThrow('BATCH_NOT_FOUND');
  });

  it('can be narrowed to a retry of named orders', async () => {
    db.order.findMany.mockResolvedValue([order()]);
    await dispatchBatch({ ...input, orderIds: ['o1'] });
    expect(db.order.findMany.mock.calls[0][0].where.id).toEqual({ in: ['o1'] });
  });
});


/**
 * The courier's own id for the destination.
 *
 * Their API will not take a shipment without it. Before this, the adapter
 * searched their system by the region's Arabic name on every single parcel
 * — a round trip needing their password, and a match that takes the first
 * of several hits when a governorate and a district share a name.
 */
describe("addressing a parcel with the courier's own city id", () => {
  it('sends the id agreed for that region', async () => {
    db.deliveryFee.findMany.mockResolvedValue([{ regionId: 'r1', courierCityId: 566090 }]);
    db.order.findMany.mockResolvedValue([order({ regionId: 'r1' })]);
    await dispatchBatch(input);
    expect(createShipment.mock.calls[0][0].cityId).toBe(566090);
  });

  it('leaves the adapter to ask when we hold no id for that region', async () => {
    db.deliveryFee.findMany.mockResolvedValue([{ regionId: 'elsewhere', courierCityId: 566090 }]);
    db.order.findMany.mockResolvedValue([order({ regionId: 'r1' })]);
    await dispatchBatch(input);
    // undefined, not someone else's city: a parcel sent to the wrong
    // governorate is only discovered when the driver calls.
    expect(createShipment.mock.calls[0][0].cityId).toBeUndefined();
  });

  it('reads the ids once for the batch, not once per parcel', async () => {
    db.deliveryFee.findMany.mockResolvedValue([{ regionId: 'r1', courierCityId: 566090 }]);
    db.order.findMany.mockResolvedValue([
      order({ id: 'o1', regionId: 'r1' }),
      order({ id: 'o2', regionId: 'r1' }),
      order({ id: 'o3', regionId: 'r1' }),
    ]);
    await dispatchBatch(input);
    expect(db.deliveryFee.findMany).toHaveBeenCalledOnce();
  });
});


/**
 * Each store holds its OWN account with the same courier. Creating a parcel
 * under another store's row means their login, their statement and their
 * money — discovered when the collection lands in the wrong books.
 *
 * The pickers only offer the right couriers. These are the calls that go
 * round the pickers.
 */
describe("a courier that is not this store's", () => {
  it('refuses a courier owned by another store', async () => {
    db.shippingBatch.findFirst.mockResolvedValue({
      id: 'b1', batchNumber: 'BATCH-2026-0001',
      provider: { id: 'p1', code: 'BASHA', apiEnabled: true, companyId: 'c1', storeId: 'OTHER-STORE' },
    });
    await expect(dispatchBatch(input)).rejects.toThrow('COURIER_NOT_IN_STORE');
    expect(createShipment).not.toHaveBeenCalled();
  });

  // Not placed in a store is usable by NOBODY. A row nobody owns being
  // usable by everybody is the leak this exists to close.
  it('refuses one that was never placed in a store', async () => {
    db.shippingBatch.findFirst.mockResolvedValue({
      id: 'b1', batchNumber: 'BATCH-2026-0001',
      provider: { id: 'p1', code: 'BASHA', apiEnabled: true, companyId: 'c1', storeId: null },
    });
    await expect(dispatchBatch(input)).rejects.toThrow('COURIER_NOT_IN_STORE');
    expect(createShipment).not.toHaveBeenCalled();
  });

  it("allows the store's own", async () => {
    db.shippingBatch.findFirst.mockResolvedValue({
      id: 'b1', batchNumber: 'BATCH-2026-0001', status: 'READY',
      provider: { id: 'p1', code: 'BASHA', apiEnabled: true, companyId: 'c1', storeId: 's1' },
    });
    db.order.findMany.mockResolvedValue([order()]);
    await dispatchBatch(input);
    expect(createShipment).toHaveBeenCalledOnce();
  });
});

/**
 * TWO PEOPLE PRESSING «DISPATCH» ON ONE BATCH.
 *
 * The old guard read `trackingNumber` once, before the loop, and trusted it
 * for the whole run. Two runs overlapping therefore both saw null, both
 * created a parcel at the courier, and the second barcode overwrote the
 * first — leaving a real parcel, billed and out for delivery, that nothing
 * in this system could name. The row is claimed now, and the database, not
 * the snapshot, decides who won.
 */
describe('one parcel per order, decided by the row and not by the snapshot', () => {
  beforeEach(() => {
    db.order.findMany.mockResolvedValue([order()]);
  });

  it('claims the order before a word is said to the courier', async () => {
    await dispatchBatch(input);
    const claim = raw(db.$queryRaw)[0];
    expect(claim.sql).toMatch(/UPDATE "orders"[\s\S]*courier_send_started_at/);
    // Both conditions, or the claim is not a claim: an order already sent
    // and an order already claimed must BOTH fail to be taken.
    expect(claim.sql).toContain('"trackingNumber" IS NULL');
    expect(claim.sql).toContain('"courier_send_started_at" IS NULL');
    expect(claim.args).toEqual(['o1']);
    expect(
      db.$queryRaw.mock.invocationCallOrder[0],
      'كُلِّمت الشركةُ قبل حجز الطلب'
    ).toBeLessThan(createShipment.mock.invocationCallOrder[0]);
  });

  it('leaves the parcel alone when another run already holds it', async () => {
    db.$queryRaw.mockImplementation(async (frags: string[]) =>
      frags.join(' ').includes('UPDATE') ? [] : [{ tracking: null }]
    );
    const res = await dispatchBatch(input);
    expect(createShipment, 'أرسلت طرداً ثانياً لطلبٍ قيد الإرسال').not.toHaveBeenCalled();
    expect(res.outcomes[0].skipped).toBe('SEND_IN_FLIGHT');
    expect(res.skipped).toBe(1);
  });

  it('calls it already sent when the row turns out to carry a barcode', async () => {
    db.$queryRaw.mockImplementation(async (frags: string[]) =>
      frags.join(' ').includes('UPDATE') ? [] : [{ tracking: 'BC-EARLIER' }]
    );
    const res = await dispatchBatch(input);
    expect(createShipment).not.toHaveBeenCalled();
    expect(res.outcomes[0].skipped).toBe('ALREADY_SENT');
  });

  it('never overwrites a barcode that arrived while the courier was answering', async () => {
    db.order.updateMany.mockResolvedValue({ count: 0 });
    const res = await dispatchBatch(input);
    // Two parcels exist now. Saying so is the only honest outcome —
    // overwriting would erase the first one's number for good.
    expect(res.sent).toBe(0);
    expect(res.failed).toBe(1);
    expect(res.outcomes[0].error).toContain('BC-777');
  });

  it('records the barcode only while the order still has none', async () => {
    await dispatchBatch(input);
    expect(db.order.updateMany.mock.calls[0][0].where).toMatchObject({ id: 'o1', trackingNumber: null });
  });
});

/**
 * A REFUSAL AND A SILENCE ARE DIFFERENT NEWS.
 *
 * «Unknown city» means nothing was created: fix the field, send again. A
 * request that timed out may have created the parcel and simply not said
 * so — pressing retry on THAT is how one order becomes two waybills.
 */
describe('what happens to the claim when the call fails', () => {
  beforeEach(() => {
    db.order.findMany.mockResolvedValue([order()]);
  });

  it('gives the order back after a refusal, so the correction can be sent', async () => {
    createShipment.mockRejectedValue(new Error('LOGESTECHS_CITY_UNKNOWN: لم يُعرف رمز المدينة'));
    const res = await dispatchBatch(input);
    expect(raw(db.$executeRaw)[0]?.sql, 'لم يُفكّ الحجز بعد رفضٍ صريح').toMatch(
      /UPDATE "orders"[\s\S]*courier_send_started_at" = NULL/
    );
    expect(res.outcomes[0].outcomeUnknown).toBeUndefined();
  });

  it('keeps the claim when the courier never answered, and says why', async () => {
    const timedOut = markOutcomeUnknown(new Error('LOGESTECHS_TIMEOUT: لم تردّ شركةُ الشحن'));
    createShipment.mockRejectedValue(timedOut);
    const res = await dispatchBatch(input);
    expect(db.$executeRaw, 'فكَّ الحجزَ بعد صمتٍ — الضغطةُ التالية تصنع طرداً ثانياً').not.toHaveBeenCalled();
    expect(res.outcomes[0].outcomeUnknown).toBe(true);
    expect(res.outcomes[0].error).toContain('اسأل الشركة');
  });

  it('counts an unknown outcome as a failure, not as a quiet skip', async () => {
    createShipment.mockRejectedValue(markOutcomeUnknown(new Error('LOGESTECHS_TIMEOUT')));
    const res = await dispatchBatch(input);
    // It must appear in the failed count: a number the operator reads as
    // «nothing to do here» would bury the one parcel that needs a call.
    expect(res.failed).toBe(1);
    expect(res.skipped).toBe(0);
  });
});

/**
 * A GOVERNORATE THE COURIER HAS NO ID FOR IS REFUSED BEFORE ANYTHING HAPPENS.
 *
 * السويداء is not in Basha's list. Its order used to be claimed, searched for
 * by name over the network, failed with an English error code and released.
 * Now: refused before the claim and before any call, with the governorate
 * named — and the rest of the batch still goes.
 */
describe('a region with no courier id', () => {
  beforeEach(() => {
    adapterFor.mockReturnValue({ code: 'LOGESTECHS', automated: true, needsCourierCityId: true, createShipment });
    db.deliveryFee.findMany.mockResolvedValue([{ regionId: 'r-dam', courierCityId: 445053 }]);
  });

  it('is refused by name, not claimed, and the courier is not asked — the next order still goes', async () => {
    db.order.findMany.mockResolvedValue([
      order({ id: 'o-sw', orderNumber: 'SY-1', regionId: 'r-sw', region: { name: 'السويداء' } }),
      order({ id: 'o-dam', orderNumber: 'SY-2', regionId: 'r-dam', region: { name: 'دمشق' } }),
    ]);
    db.$queryRaw.mockImplementation(async (frags: string[]) =>
      frags.join(' ').includes('UPDATE') ? [{ id: 'o-dam' }] : [{ tracking: null }]
    );
    const res = await dispatchBatch(input);
    const sw = res.outcomes.find((o) => o.orderId === 'o-sw')!;
    expect(sw).toMatchObject({ ok: false, skipped: 'NO_COURIER_CITY', regionName: 'السويداء' });
    // Only Damascus reached the courier, with its id.
    expect(createShipment).toHaveBeenCalledTimes(1);
    expect(createShipment.mock.calls[0][0].cityId).toBe(445053);
    // And the Suwayda row was never claimed.
    const claims = raw(db.$queryRaw).filter((c) => c.sql.includes('UPDATE'));
    expect(claims.every((c) => !c.args.includes('o-sw'))).toBe(true);
  });

  it('an adapter that needs no courier id is not held by it', async () => {
    adapterFor.mockReturnValue({ code: 'OTHER', automated: true, createShipment });
    db.order.findMany.mockResolvedValue([order({ regionId: 'r-sw', region: { name: 'السويداء' } })]);
    const res = await dispatchBatch(input);
    expect(res.sent).toBe(1);
  });

  it('the second phone travels with the parcel', async () => {
    db.order.findMany.mockResolvedValue([
      order({ regionId: 'r-dam', customer: { fullName: 'زبون', rawPhone: '0999111222', phone: '999111222', altPhone: '0988777666', address: 'شارع' } }),
    ]);
    await dispatchBatch(input);
    expect(createShipment.mock.calls[0][0].customer.altPhone).toBe('0988777666');
  });

  it('a second phone stored without its zero (the storefront form) reaches them as it is dialled', async () => {
    db.order.findMany.mockResolvedValue([
      order({
        regionId: 'r-dam',
        store: { country: { code: 'SY' } },
        customer: { fullName: 'زبون', rawPhone: '0999111222', phone: '999111222', altPhone: '988777666', address: 'شارع' },
      }),
    ]);
    await dispatchBatch(input);
    expect(createShipment.mock.calls[0][0].customer.altPhone).toBe('0988777666');
  });
});

/**
 * BATCH-2026-0003: THIRTY-FIVE REFUSED, ONE WITHOUT A CODE — AND THE SECOND PRESS.
 *
 * «رُحّل 0 · تُخطّي 1 · فشل 35», each failure the courier's own sentence. The batch stays in «قيد التجميع», the button
 * stays, and pressing it again after the fix must send ONLY what was never sent: an order with a barcode is not sent
 * twice, and one whose claim is held (a timeout — the parcel may exist) is not sent at all.
 */
describe('the batch that failed thirty-five of thirty-six, and the second press', () => {
  const REFUSAL = 'الباشا رفض: رقم تعريف الشركة غير صحيح (400)';
  const many = (n: number, over: (i: number) => Record<string, unknown> = () => ({})) =>
    Array.from({ length: n }, (_, i) =>
      order({ id: `o${i + 1}`, orderNumber: `ORD-2026-${String(i + 1).padStart(4, '0')}`, regionId: 'r-dam', ...over(i) }),
    );

  beforeEach(() => {
    adapterFor.mockReturnValue({ code: 'LOGESTECHS', automated: true, needsCourierCityId: true, createShipment });
    db.deliveryFee.findMany.mockResolvedValue([{ regionId: 'r-dam', courierCityId: 445053 }]);
    // Every claim is won unless a test says otherwise (the claim is keyed by the order id in the first value).
    db.$queryRaw.mockImplementation(async (frags: string[], id: string) =>
      frags.join(' ').includes('UPDATE') ? [{ id }] : [{ tracking: null }],
    );
  });

  it('35 refused + 1 with no code: the summary, and the reasons the screen will group', async () => {
    db.order.findMany.mockResolvedValue([
      ...many(35),
      order({ id: 'o-sw', orderNumber: 'ORD-2026-0508', regionId: 'r-sw', region: { name: 'السويداء' } }),
    ]);
    createShipment.mockRejectedValue(new Error(REFUSAL));
    const res = await dispatchBatch(input);

    expect({ sent: res.sent, skipped: res.skipped, failed: res.failed }).toEqual({ sent: 0, skipped: 1, failed: 35 });
    const groups = groupDispatchReasons(res.outcomes);
    expect(groups.map((g) => [g.count, g.reason])).toEqual([
      [35, REFUSAL],
      [1, expect.stringContaining('السويداء: لا رمز لها عند الشركة بعد')],
    ]);
    expect(groups[0].orderNumbers).toHaveLength(35);
    // Every refusal released its claim: the second press can send them.
    expect(db.$executeRaw).toHaveBeenCalledTimes(35);
  });

  it('the second press after the fix sends only the unsent — a sent one and a held one are left alone', async () => {
    db.order.findMany.mockResolvedValue([
      order({ id: 'sent', orderNumber: 'ORD-A', regionId: 'r-dam', trackingNumber: 'KSA-OLD' }),
      order({ id: 'held', orderNumber: 'ORD-B', regionId: 'r-dam' }),
      order({ id: 'fresh-1', orderNumber: 'ORD-C', regionId: 'r-dam' }),
      order({ id: 'fresh-2', orderNumber: 'ORD-D', regionId: 'r-dam' }),
    ]);
    // `held` lost its claim — an earlier send timed out and is still holding it, with no barcode yet.
    db.$queryRaw.mockImplementation(async (frags: string[], id: string) => {
      const sql = frags.join(' ');
      if (sql.includes('UPDATE')) return id === 'held' ? [] : [{ id }];
      return [{ tracking: null }];
    });
    createShipment
      .mockResolvedValueOnce({ trackingNumber: 'KSA-NEW-1' })
      .mockResolvedValueOnce({ trackingNumber: 'KSA-NEW-2' });

    const res = await dispatchBatch(input);

    expect(createShipment, 'أُرسل أكثر من الطلبين غير المرسلين').toHaveBeenCalledTimes(2);
    expect(createShipment.mock.calls.map((c) => c[0].orderId)).toEqual(['fresh-1', 'fresh-2']);
    const by = Object.fromEntries(res.outcomes.map((o) => [o.orderId, o]));
    expect(by.sent).toMatchObject({ ok: false, skipped: 'ALREADY_SENT' });
    expect(by.held).toMatchObject({ ok: false, skipped: 'SEND_IN_FLIGHT' });
    expect(res.sent).toBe(2);
    // The barcode that was already there is never written over.
    const written = db.order.updateMany.mock.calls.map((c) => c[0].where.id);
    expect(written).toEqual(['fresh-1', 'fresh-2']);
    for (const call of db.order.updateMany.mock.calls) expect(call[0].where).toMatchObject({ trackingNumber: null });
  });

  it('an order that timed out on the first press is not sent again on the second — its claim is held', async () => {
    db.order.findMany.mockResolvedValue(many(1));
    createShipment.mockRejectedValueOnce(markOutcomeUnknown(new Error('LOGESTECHS_TIMEOUT: لم تردّ')));
    await dispatchBatch(input);
    expect(db.$executeRaw, 'فُكَّ الحجز بعد صمت').not.toHaveBeenCalled();

    // Second press: the row still carries the claim, so the database refuses it a second time.
    createShipment.mockClear();
    db.$queryRaw.mockImplementation(async (frags: string[]) => (frags.join(' ').includes('UPDATE') ? [] : [{ tracking: null }]));
    const res = await dispatchBatch(input);
    expect(createShipment).not.toHaveBeenCalled();
    expect(res.outcomes[0].skipped).toBe('SEND_IN_FLIGHT');
  });

  it('the courier’s display name reaches the adapter, so a refusal can say «الباشا رفض»', async () => {
    db.shippingBatch.findFirst.mockResolvedValue({
      id: 'b1', batchNumber: 'BATCH-2026-0003', status: 'READY',
      provider: { id: 'p1', name: 'الباشا', code: 'BASHA', apiEnabled: true, companyId: 'c1', storeId: 's1' },
    });
    db.order.findMany.mockResolvedValue([]);
    await dispatchBatch(input);
    expect(db.shippingBatch.findFirst.mock.calls[0][0].select.provider.select).toMatchObject({ name: true });
    expect(adapterFor.mock.calls[0][0]).toMatchObject({ name: 'الباشا', code: 'BASHA' });
  });

  it('a batch with nothing refused has no reason groups at all', async () => {
    db.order.findMany.mockResolvedValue(many(2));
    createShipment.mockResolvedValueOnce({ trackingNumber: 'K1' }).mockResolvedValueOnce({ trackingNumber: 'K2' });
    const res = await dispatchBatch(input);
    expect(groupDispatchReasons(res.outcomes)).toEqual([]);
  });
});

/**
 * ONLY A TROLLEY STILL BEING FILLED IS SENT.
 *
 * The batch status was never read: a batch already handed to the courier
 * (or closed) could be dispatched again from a stale screen or a direct
 * call, creating parcels at the company after the driver had left.
 */
describe('a batch that is not READY', () => {
  const batchIs = (status: string) =>
    db.shippingBatch.findFirst.mockResolvedValue({
      id: 'b1', batchNumber: 'BATCH-2026-0001', status,
      provider: { id: 'p1', code: 'BASHA', apiEnabled: true, companyId: 'c1', storeId: 's1' },
    });

  it.each(['SHIPPED', 'CLOSED'])('is refused when %s, and nothing is read or sent', async (status) => {
    batchIs(status);
    db.order.findMany.mockResolvedValue([order()]);

    await expect(dispatchBatch(input)).rejects.toThrow('BATCH_NOT_READY');

    expect(createShipment, 'انبعت طرد من دفعة مسلّمة').not.toHaveBeenCalled();
    expect(db.order.findMany).not.toHaveBeenCalled();
    expect(db.$queryRaw, 'انكتبت مطالبة على طلب من دفعة مسلّمة').not.toHaveBeenCalled();
  });

  it('still sends a READY one', async () => {
    batchIs('READY');
    db.order.findMany.mockResolvedValue([order()]);

    const res = await dispatchBatch(input);

    expect(res.sent).toBe(1);
  });

  it('and a missing batch is still «not found», not «not ready»', async () => {
    db.shippingBatch.findFirst.mockResolvedValue(null);

    await expect(dispatchBatch(input)).rejects.toThrow('BATCH_NOT_FOUND');
  });
});
