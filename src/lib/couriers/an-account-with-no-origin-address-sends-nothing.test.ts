import { beforeEach, describe, expect, it, vi } from 'vitest';

const { db, adapterFor, logAudit } = vi.hoisted(() => ({
  db: {
    shippingBatch: { findFirst: vi.fn() },
    order: { findMany: vi.fn(), updateMany: vi.fn() },
    orderActivity: { create: vi.fn() },
    deliveryFee: { findMany: vi.fn() },
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
  },
  adapterFor: vi.fn(),
  logAudit: vi.fn(),
}));
vi.mock('../db', () => ({ db }));
vi.mock('./index', () => ({ adapterFor: (...a: unknown[]) => adapterFor(...a) }));
vi.mock('../audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));

import { dispatchBatch } from './dispatch';
import { LogesTechsAdapter, type LogesTechsConfig } from './logestechs';
import { dispatchReasonAr, groupDispatchReasons } from '../dispatch-reason';
import { encryptJson } from '../secrets';

/**
 * «الباشا رفض: Invalid Parameter 'model.addressLine1' null (400)» — 131 TIMES.
 *
 * BATCH-2026-0006 (2/11, الباشا on LogesTechs, 131 orders) came back «رُحّل 0 • فشل 131», every order refused with the
 * same English sentence. Every order failing alike is a field common to every request: the ORIGIN address. The saved
 * account had no «عنوان الانطلاق» (the form and the route called it optional), the adapter sent '' and their server
 * reads '' as null.
 *
 * Here: an account with no origin sends NOTHING — no claim, no request — and every order of the batch says why in one
 * Arabic sentence; an order with no address of its own is refused by name before its claim while the rest go on; and
 * the adapter never puts an empty address on the wire. The adapter in these tests is the REAL one, with a fetch that
 * counts: a guard that forgot to look would show up as a request, not as a passing mock.
 */

const ORIGIN_SENTENCE = 'عنوان الانطلاق فاضي بحساب الشركة — اضغط «تغيير الحساب» واكتبه، الشركة بترفض الطرد بدونه';
const ADDRESS_SENTENCE = 'الطلب بلا عنوان — اكتب العنوان بالطلب وأعد الترحيل';

const created = () => new Response(JSON.stringify({ barcode: 'BC-1', id: 1 }), { status: 200 });

function realAdapter(origin: string, fetchImpl: typeof fetch, over: Partial<LogesTechsConfig> = {}) {
  return new LogesTechsAdapter({
    email: 'shop@example.com',
    password: 'secret-pass',
    companyId: 744,
    sender: { name: 'متجر', phone: '0790000000' },
    origin: { addressLine1: origin, cityId: 36237 },
    fetchImpl,
    ...over,
  });
}

const counter = () => {
  const bodies: { originAddress: { addressLine1: string }; destinationAddress: { addressLine1: string } }[] = [];
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body ?? '{}')));
    return created();
  }) as unknown as typeof fetch & { mock: { calls: unknown[][] } };
  return { fetchImpl, bodies };
};

const order = (id: string, over: Record<string, unknown> = {}) => ({
  id, orderNumber: `ORD-2026-${id}`, merchantRef: null, trackingNumber: null, currency: 'SYP',
  quantity: 1, freeQuantity: 0, customerNotes: null, deliveryProviderId: 'dp1', deliveryAddress: null,
  items: [], addOns: [],
  customer: { fullName: 'زبون', rawPhone: '0999111222', phone: '999111222', altPhone: null, address: 'شارع بغداد' },
  regionId: 'r1', region: { name: 'دمشق' }, store: { country: { code: 'SY' } },
  ...over,
});

const input = { batchId: 'b1', companyId: 'c1', storeId: 's1', userId: 'u1' };

/** The ids each raw call was made for: the claim (UPDATE … RETURNING) and the lost-claim read both carry the order id. */
const claimedIds = () =>
  db.$queryRaw.mock.calls
    .filter((c) => (c[0] as string[]).join(' ').includes('UPDATE'))
    .map((c) => c.slice(1).find((v) => typeof v === 'string' && v.startsWith('o')));

beforeEach(() => {
  vi.clearAllMocks();
  db.shippingBatch.findFirst.mockResolvedValue({
    id: 'b1', batchNumber: 'BATCH-2026-0006', status: 'READY',
    // A company with no list of city ids of ours: the id comes from the typed fee row below, nothing else.
    provider: { id: 'dp1', name: 'الباشا', code: 'HALA', adapterCode: 'LOGESTECHS', apiEnabled: true, companyId: 'c1', storeId: 's1' },
  });
  db.deliveryFee.findMany.mockResolvedValue([{ regionId: 'r1', courierCityId: 445053 }]);
  db.order.updateMany.mockResolvedValue({ count: 1 });
  db.$queryRaw.mockImplementation(async (frags: string[], ...vals: unknown[]) =>
    frags.join(' ').includes('UPDATE') ? [{ id: vals[0], totalAmount: 20 }] : [{ tracking: null }],
  );
  db.$executeRaw.mockResolvedValue(1);
});

describe('an account with no «عنوان الانطلاق» sends nothing', () => {
  it.each([
    ['empty', ''],
    ['spaces only', '   '],
  ])('origin %s: every order skipped NO_ORIGIN_ADDRESS, zero claims, zero requests', async (_label, origin) => {
    const { fetchImpl } = counter();
    const adapter = realAdapter(origin, fetchImpl);
    const send = vi.spyOn(adapter, 'createShipment');
    adapterFor.mockReturnValue(adapter);
    db.order.findMany.mockResolvedValue([order('o1'), order('o2'), order('o3', { customer: null })]);

    const res = await dispatchBatch(input);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(db.$queryRaw, 'no claim is written — nothing to release afterwards').not.toHaveBeenCalled();
    expect(db.$executeRaw).not.toHaveBeenCalled();
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(res.outcomes.map((o) => o.skipped)).toEqual(['NO_ORIGIN_ADDRESS', 'NO_ORIGIN_ADDRESS', 'NO_ORIGIN_ADDRESS']);
    expect(res.outcomes.map((o) => o.orderNumber)).toEqual(['ORD-2026-o1', 'ORD-2026-o2', 'ORD-2026-o3']);
    expect(res).toMatchObject({ sent: 0, skipped: 3, failed: 0 });
  });

  it('is said ONCE for the batch: one group, every order in it, the account sentence', async () => {
    const { fetchImpl } = counter();
    adapterFor.mockReturnValue(realAdapter('', fetchImpl));
    db.order.findMany.mockResolvedValue(Array.from({ length: 131 }, (_, i) => order(`o${i + 1}`)));

    const res = await dispatchBatch(input);
    const groups = groupDispatchReasons(res.outcomes);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ reason: ORIGIN_SENTENCE, count: 131, outcomeUnknown: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('every order, even one that already carries a barcode or has no address', async () => {
    const { fetchImpl } = counter();
    adapterFor.mockReturnValue(realAdapter('', fetchImpl));
    db.order.findMany.mockResolvedValue([
      order('o1', { trackingNumber: 'BC-OLD' }),
      order('o2', { customer: { fullName: 'زبون', rawPhone: '0999', phone: '999', altPhone: null, address: '' } }),
    ]);
    const res = await dispatchBatch(input);
    expect(res.outcomes.every((o) => o.skipped === 'NO_ORIGIN_ADDRESS')).toBe(true);
  });

  it('the audit row says it was the account, and how many', async () => {
    adapterFor.mockReturnValue(realAdapter('', counter().fetchImpl));
    db.order.findMany.mockResolvedValue([order('o1'), order('o2')]);
    await dispatchBatch(input);
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit.mock.calls[0][0].newData).toMatchObject({ sent: 0, skipped: 2, failed: 0, reason: 'NO_ORIGIN_ADDRESS' });
  });

  it('NEGATIVE: with the address typed, the same batch goes — and the courier is told the address, trimmed', async () => {
    const { fetchImpl, bodies } = counter();
    adapterFor.mockReturnValue(realAdapter('  دمشق — المستودع  ', fetchImpl));
    db.order.findMany.mockResolvedValue([order('o1'), order('o2')]);

    const res = await dispatchBatch(input);

    expect(res).toMatchObject({ sent: 2, skipped: 0, failed: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(bodies[0].originAddress.addressLine1).toBe('دمشق — المستودع');
    expect(claimedIds()).toEqual(['o1', 'o2']);
  });

  it('NEGATIVE: a courier that is not on the platform is not stopped by it (a manual one stays NOT_AUTOMATED)', async () => {
    adapterFor.mockReturnValue({ code: 'MANUAL', automated: false, createShipment: vi.fn() });
    db.order.findMany.mockResolvedValue([order('o1')]);
    const res = await dispatchBatch(input);
    expect(res.outcomes[0].skipped).toBe('NOT_AUTOMATED');
  });
});

describe('the registry keeps a saved account with no origin AUTOMATED, so the batch hears the right sentence', () => {
  it('a stored account like production’s (no originAddress) → NO_ORIGIN_ADDRESS end to end, not «شركة يدوية»', async () => {
    const real = await vi.importActual<typeof import('./index')>('./index');
    process.env.APP_ENCRYPTION_KEY = 'e'.repeat(64);
    const apiCredentials = encryptJson({
      email: 'shop@example.com', password: 'secret-pass', companyId: 744, originCityId: 445053,
      senderName: 'متجر', senderPhone: '0999000000',
    });
    const fetchSpy = vi.fn(async () => created());
    vi.stubGlobal('fetch', fetchSpy);
    try {
      db.shippingBatch.findFirst.mockResolvedValue({
        id: 'b1', batchNumber: 'BATCH-2026-0006', status: 'READY',
        provider: { id: 'dp1', name: 'الباشا', code: 'BASHA', adapterCode: 'LOGESTECHS', apiEnabled: true, apiConfig: {}, apiCredentials, companyId: 'c1', storeId: 's1' },
      });
      adapterFor.mockImplementation(real.adapterFor);
      db.order.findMany.mockResolvedValue([order('o1'), order('o2')]);

      const res = await dispatchBatch(input);

      expect(res.outcomes.map((o) => o.skipped)).toEqual(['NO_ORIGIN_ADDRESS', 'NO_ORIGIN_ADDRESS']);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(db.$queryRaw).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('an order with no address of its own', () => {
  const noAddress = (over: Record<string, unknown> = {}) =>
    order('o1', {
      deliveryAddress: '   ',
      customer: { fullName: 'زبون', rawPhone: '0999111222', phone: '999111222', altPhone: null, address: '  ' },
      ...over,
    });

  it('is skipped NO_ADDRESS before its claim, and the good order of the same batch still goes', async () => {
    const { fetchImpl, bodies } = counter();
    adapterFor.mockReturnValue(realAdapter('المستودع', fetchImpl));
    db.order.findMany.mockResolvedValue([noAddress(), order('o2')]);

    const res = await dispatchBatch(input);

    expect(res.outcomes[0]).toMatchObject({ orderId: 'o1', ok: false, skipped: 'NO_ADDRESS' });
    expect(res.outcomes[1]).toMatchObject({ orderId: 'o2', ok: true, trackingNumber: 'BC-1' });
    expect(claimedIds(), 'the order with no address is never claimed').toEqual(['o2']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(bodies[0].destinationAddress.addressLine1).toBe('شارع بغداد');
    expect(groupDispatchReasons(res.outcomes)).toEqual([
      { reason: ADDRESS_SENTENCE, count: 1, orderNumbers: ['ORD-2026-o1'], outcomeUnknown: false },
    ]);
  });

  it('null on the order and null on the customer is no address either', async () => {
    const { fetchImpl } = counter();
    adapterFor.mockReturnValue(realAdapter('المستودع', fetchImpl));
    db.order.findMany.mockResolvedValue([noAddress({ deliveryAddress: null, customer: null })]);
    const res = await dispatchBatch(input);
    expect(res.outcomes[0].skipped).toBe('NO_ADDRESS');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it('a blank parcel address falls back to the customer’s; a typed one wins, trimmed', async () => {
    const { fetchImpl, bodies } = counter();
    adapterFor.mockReturnValue(realAdapter('المستودع', fetchImpl));
    db.order.findMany.mockResolvedValue([
      order('o1', { deliveryAddress: '' }),
      order('o2', { deliveryAddress: '  حي الميدان  ' }),
    ]);
    const res = await dispatchBatch(input);
    expect(res.sent).toBe(2);
    expect(bodies.map((b) => b.destinationAddress.addressLine1)).toEqual(['شارع بغداد', 'حي الميدان']);
  });

  it('NEGATIVE: the address check does not replace the city check — a governorate with no id is still NO_COURIER_CITY', async () => {
    adapterFor.mockReturnValue(realAdapter('المستودع', counter().fetchImpl));
    db.order.findMany.mockResolvedValue([order('o1', { regionId: 'r9', region: { name: 'مكان' } })]);
    const res = await dispatchBatch(input);
    expect(res.outcomes[0].skipped).toBe('NO_COURIER_CITY');
  });
});

describe('the adapter never puts an empty address on the wire', () => {
  const request = {
    orderId: 'o1', merchantRef: 'ORD-1', codAmount: 20, currencyCode: 'SYP', pieces: 1, cityId: 445053,
    customer: { fullName: 'زبون', phone: '0999', address: 'شارع بغداد', regionName: 'دمشق' },
  };

  it.each(['', '   '])('origin «%s»: throws in Arabic, and makes no request', async (origin) => {
    const { fetchImpl } = counter();
    const e = await realAdapter(origin, fetchImpl).createShipment(request).catch((x: Error) => x);
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).toContain('عنوان الانطلاق فاضي');
    expect((e as Error).message).not.toMatch(/[A-Za-z]/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(['', '  '])('destination «%s»: throws in Arabic, and makes no request', async (address) => {
    const { fetchImpl } = counter();
    const e = await realAdapter('المستودع', fetchImpl)
      .createShipment({ ...request, customer: { ...request.customer, address } })
      .catch((x: Error) => x);
    expect((e as Error).message).toBe(ADDRESS_SENTENCE);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('both lines are sent trimmed, and neither is ever empty', async () => {
    const { fetchImpl, bodies } = counter();
    await realAdapter('  المستودع  ', fetchImpl).createShipment({
      ...request, customer: { ...request.customer, address: '  شارع بغداد  ' },
    });
    expect(bodies[0].originAddress.addressLine1).toBe('المستودع');
    expect(bodies[0].destinationAddress.addressLine1).toBe('شارع بغداد');
  });

  it('says whether the origin is missing, after trimming', () => {
    const f = counter().fetchImpl;
    expect(realAdapter('', f).originAddressMissing).toBe(true);
    expect(realAdapter(' \t ', f).originAddressMissing).toBe(true);
    expect(realAdapter('المستودع', f).originAddressMissing).toBe(false);
  });
});

describe('the two sentences', () => {
  it('NO_ORIGIN_ADDRESS names the account and the button, NO_ADDRESS names the order', () => {
    expect(dispatchReasonAr({ skipped: 'NO_ORIGIN_ADDRESS' })).toBe(ORIGIN_SENTENCE);
    expect(dispatchReasonAr({ skipped: 'NO_ADDRESS' })).toBe(ADDRESS_SENTENCE);
  });
});
