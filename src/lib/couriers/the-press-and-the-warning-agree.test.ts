import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — «رحّل إلى الشركة» works without anyone typing the fourteen codes
 *
 * The owner, 2/11: «بدي حل لموضوع ترحيل الطلبات مش زابط عندك ال api… اعتمدو كود المدينة اللي هو المحافظة للمدن والقرى والأحياء».
 * Until now the press refused every parcel whose governorate had no number typed in «رمزها عند الشركة», and nobody ever
 * typed one.
 *
 *  1. A governorate nobody typed a code for takes its city from the courier's own list (Basha's sheet) — with no fee row
 *     at all, and with a fee row that has no code.
 *  2. A typed code still wins, even when it looks wrong (the box already warns about a Region Id).
 *  3. What the list cannot answer — a governorate it does not name, an order with no governorate — is still refused by
 *     name before the claim and before any call (`NO_COURIER_CITY`), and a courier we hold no list for is unchanged.
 *  4. The WARNING above the press and the REFUSAL at the press are the same decision, for the same data: parameterised
 *     below, over one fake database that both of them read.
 *
 * Blockers: no money arithmetic changed, order creation untouched, nothing written but what the press already wrote.
 * ═══════════════════════════════════════════════════════════════════════
 */

/*
 * ONE FAKE DATABASE FOR BOTH.
 *
 * The press (`dispatchBatch`) and the warning (`courierCityGaps`) read different tables in different shapes — orders one
 * by one, orders grouped by governorate, fee rows for one courier, fee rows for several, region names — so the fake is a
 * small in-memory table that honours the filters they ask with (the courier, `courierCityId` not null, the batch, the ids).
 * A query that dropped its filter would then return the wrong rows instead of the right ones by luck.
 */
const { db, state, adapterFor, createShipment } = vi.hoisted(() => {
  interface Fee { deliveryProviderId: string; regionId: string; courierCityId: number | null }
  interface Parcel { id: string; orderNumber: string; regionId: string | null; regionName: string | null }
  const state = {
    provider: {
      id: 'p1', name: 'الباشا', code: 'BASHA', adapterCode: 'LOGESTECHS', apiEnabled: true, apiConfig: {}, apiCredentials: 'sealed',
      companyId: 'c1', storeId: 's1',
    },
    fees: [] as Fee[],
    parcels: [] as Parcel[],
    regions: [] as { id: string; name: string }[],
  };
  const ids = (v: unknown): string[] | null => (v && typeof v === 'object' && 'in' in v ? (v as { in: string[] }).in : null);
  const db = {
    shippingBatch: {
      findFirst: vi.fn(async () => ({ id: 'b1', batchNumber: 'BATCH-2026-0009', status: 'READY', provider: state.provider })),
    },
    deliveryProvider: {
      findMany: vi.fn(async (args: { where: { id: unknown } }) => (ids(args.where.id)?.includes(state.provider.id) ? [state.provider] : [])),
    },
    deliveryFee: {
      findMany: vi.fn(async (args: { where: { deliveryProviderId?: unknown; courierCityId?: { not: null } } }) => {
        const one = typeof args.where.deliveryProviderId === 'string' ? [args.where.deliveryProviderId] : ids(args.where.deliveryProviderId);
        return state.fees.filter(
          (f) => (one ? one.includes(f.deliveryProviderId) : true) && (args.where.courierCityId ? f.courierCityId !== null : true),
        );
      }),
    },
    region: {
      findMany: vi.fn(async (args: { where: { id: unknown } }) => {
        const wanted = ids(args.where.id) ?? [];
        return state.regions.filter((r) => wanted.includes(r.id));
      }),
    },
    order: {
      // What the press reads: this batch's parcels, in the shape it selects.
      findMany: vi.fn(async (args: { where: { shippingBatchId: string; id?: unknown } }) => {
        const only = ids(args.where.id);
        return state.parcels
          .filter((p) => (only ? only.includes(p.id) : true))
          .map((p) => ({
            id: p.id, orderNumber: p.orderNumber, merchantRef: null, trackingNumber: null, currency: 'SYP', quantity: 1, freeQuantity: 0,
            customerNotes: null, deliveryProviderId: state.provider.id, deliveryAddress: null, items: [], addOns: [],
            customer: { fullName: 'زبون', rawPhone: '0999111222', phone: '999111222', altPhone: null, address: 'شارع' },
            regionId: p.regionId, region: p.regionName ? { name: p.regionName } : null, store: { country: { code: 'SY' } },
          }));
      }),
      // What the warning reads: the parcels the press would still claim, counted per governorate.
      groupBy: vi.fn(async (args: { where: { shippingBatchId: unknown; trackingNumber: null; shippingStatus: string; confirmationStatus: string } }) => {
        const inTheseBatches = ids(args.where.shippingBatchId)?.includes('b1') ?? false;
        const stillToSend = args.where.trackingNumber === null && args.where.shippingStatus === 'READY_FOR_PICKUP' && args.where.confirmationStatus === 'CONFIRMED';
        if (!inTheseBatches || !stillToSend) return [];
        const counts = new Map<string | null, number>();
        for (const p of state.parcels) counts.set(p.regionId, (counts.get(p.regionId) ?? 0) + 1);
        return [...counts].map(([regionId, n]) => ({ shippingBatchId: 'b1', regionId, _count: { _all: n } }));
      }),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    orderActivity: { create: vi.fn(async () => ({})) },
    // The claim is one conditional UPDATE … RETURNING: always won here — what is under test is what happens before it.
    $queryRaw: vi.fn(async (frags: string[], id: string) => (frags.join(' ').includes('UPDATE') ? [{ id, totalAmount: 60 }] : [{ tracking: null }])),
    $executeRaw: vi.fn(async () => 1),
  };
  const createShipment = vi.fn(async () => ({ trackingNumber: 'BC-1' }));
  // What `adapterFor` decides, in the one way these tests need: an API-enabled courier is sent to AND needs the id; the rest is manual.
  const adapterFor = vi.fn((p: { apiEnabled?: boolean } | null) =>
    p?.apiEnabled
      ? { code: 'LOGESTECHS', automated: true, needsCourierCityId: true, createShipment }
      : { code: 'MANUAL', automated: false, createShipment },
  );
  return { db, state, adapterFor, createShipment };
});

vi.mock('../db', () => ({ db }));
vi.mock('./index', () => ({ adapterFor: (...a: unknown[]) => (adapterFor as (...x: unknown[]) => unknown)(...a) }));
vi.mock('../audit', () => ({ logAudit: vi.fn() }));

import { dispatchBatch } from './dispatch';
import { courierCityGaps } from './city-gaps';

const press = () => dispatchBatch({ batchId: 'b1', companyId: 'c1', storeId: 's1', userId: 'u1' });
const warning = () => courierCityGaps({ companyId: 'c1', storeId: 's1', batches: [{ id: 'b1', status: 'READY', deliveryProviderId: 'p1' }] });

const BASHA = state.provider;
const typed = (regionId: string, courierCityId: number | null, deliveryProviderId = 'p1') => ({ deliveryProviderId, regionId, courierCityId });

beforeEach(() => {
  vi.clearAllMocks();
  state.provider = { ...BASHA };
  state.fees = [];
  state.parcels = [];
  state.regions = [];
});

/** One parcel to this governorate (id and name; null = an order with no governorate). */
const oneParcelTo = (region: { id: string; name: string } | null) => {
  state.parcels = [{ id: 'o1', orderNumber: 'ORD-2026-0001', regionId: region?.id ?? null, regionName: region?.name ?? null }];
  state.regions = region ? [region] : [];
};

const SWEIDA = { id: 'r-sweida', name: 'السويداء' };
const IDLIB = { id: 'r-idlib', name: 'إدلب' };
const DEIR = { id: 'r-deir', name: 'دير الزور' };
const BAGHDAD = { id: 'r-baghdad', name: 'بغداد' };

interface Case {
  title: string;
  /** Changes to the courier row: its code, or switching its API off. */
  courier?: Partial<typeof BASHA>;
  fees: ReturnType<typeof typed>[];
  region: { id: string; name: string } | null;
  /** The city id the courier is told; null = the parcel is refused (and warned about). */
  sends: number | null;
}

const CASES: Case[] = [
  { title: 'nothing typed and no fee row at all: the list’s city for the governorate', fees: [], region: SWEIDA, sends: 445153 },
  { title: 'a fee row exists but carries no code: the list’s city', fees: [typed('r-sweida', null)], region: SWEIDA, sends: 445153 },
  { title: 'the hamza is folded: our «إدلب» is their «ادلب»', fees: [], region: IDLIB, sends: 570148 },
  { title: 'no city is named like the governorate: «مدينة دير الزور», the placeholder one', fees: [], region: DEIR, sends: 949546 },
  { title: 'the courier’s code in lower case finds the same list', courier: { code: 'basha' }, fees: [], region: SWEIDA, sends: 445153 },
  { title: 'a typed code wins over the list', fees: [typed('r-sweida', 999001)], region: SWEIDA, sends: 999001 },
  { title: 'a typed code wins even when it is a Region Id (the box warns, it does not block)', fees: [typed('r-sweida', 3003)], region: SWEIDA, sends: 3003 },
  { title: 'another courier’s typed code for that governorate is not this courier’s', fees: [typed('r-sweida', 999002, 'other')], region: SWEIDA, sends: 445153 },
  { title: 'a typed code for ANOTHER governorate is not this one’s', fees: [typed('r-idlib', 999003)], region: SWEIDA, sends: 445153 },
  { title: 'a governorate the list does not name is refused, by name', fees: [], region: BAGHDAD, sends: null },
  { title: 'an order with no governorate at all is refused', fees: [], region: null, sends: null },
  { title: 'a typed code for a governorate the list does not name still sends', fees: [typed('r-baghdad', 999004)], region: BAGHDAD, sends: 999004 },
  { title: 'a courier on the platform with no list of ours: nothing typed, refused (as it always was)', courier: { code: 'HALA' }, fees: [], region: SWEIDA, sends: null },
  { title: 'the same courier with a typed code: sends it', courier: { code: 'HALA' }, fees: [typed('r-sweida', 777001)], region: SWEIDA, sends: 777001 },
];

describe('the press and the warning before it are the same decision', () => {
  it.each(CASES)('$title', async ({ courier, fees, region, sends }) => {
    state.provider = { ...BASHA, ...courier };
    state.fees = fees;
    oneParcelTo(region);

    const outcome = (await press()).outcomes[0];
    const gap = (await warning()).get('b1');

    const refused = outcome.skipped === 'NO_COURIER_CITY';
    // THE POINT: what the warehouse is warned about is exactly what the press then refuses.
    expect(Boolean(gap), 'the warning and the press disagree').toBe(refused);

    if (sends === null) {
      expect(refused).toBe(true);
      expect(outcome.regionName).toBe(region?.name ?? null);
      expect(gap).toEqual({ count: 1, regions: [region?.name ?? 'بلا محافظة'] });
      // Refused before the claim and before any call.
      expect(createShipment).not.toHaveBeenCalled();
      expect(db.$queryRaw).not.toHaveBeenCalled();
    } else {
      expect(outcome).toMatchObject({ ok: true, trackingNumber: 'BC-1' });
      expect(createShipment).toHaveBeenCalledTimes(1);
      expect((createShipment.mock.calls[0] as unknown as [{ cityId: number }])[0].cityId).toBe(sends);
      expect(gap).toBeUndefined();
    }
  });

  it('a manual courier needs no id from anyone: nothing is sent, nothing is warned', async () => {
    state.provider = { ...BASHA, apiEnabled: false };
    oneParcelTo(SWEIDA);
    expect((await press()).outcomes[0]).toMatchObject({ ok: false, skipped: 'NOT_AUTOMATED' });
    expect((await warning()).size).toBe(0);
    expect(createShipment).not.toHaveBeenCalled();
  });

  it('a mixed trolley: the list gives, the box overrides, and only what neither can answer is refused and warned about', async () => {
    state.fees = [typed('r-sweida', 999001)];
    state.parcels = [
      { id: 'o1', orderNumber: 'ORD-1', regionId: 'r-dam', regionName: 'دمشق' },
      { id: 'o2', orderNumber: 'ORD-2', regionId: 'r-sweida', regionName: 'السويداء' },
      { id: 'o3', orderNumber: 'ORD-3', regionId: 'r-baghdad', regionName: 'بغداد' },
      { id: 'o4', orderNumber: 'ORD-4', regionId: null, regionName: null },
      { id: 'o5', orderNumber: 'ORD-5', regionId: 'r-dam', regionName: 'دمشق' },
    ];
    state.regions = [{ id: 'r-dam', name: 'دمشق' }, SWEIDA, BAGHDAD];

    const res = await press();
    const gap = (await warning()).get('b1');

    const refused = res.outcomes.filter((o) => o.skipped === 'NO_COURIER_CITY').map((o) => o.orderNumber).sort();
    expect(refused).toEqual(['ORD-3', 'ORD-4']);
    expect(res).toMatchObject({ sent: 3, skipped: 2, failed: 0 });
    // Damascus twice from the list, السويداء from the box.
    expect((createShipment.mock.calls as unknown as [{ orderId: string; cityId: number }][]).map((c) => [c[0].orderId, c[0].cityId])).toEqual([
      ['o1', 445053], ['o2', 999001], ['o5', 445053],
    ]);
    // The warning counts the same two parcels and names the same two governorates.
    expect(gap).toEqual({ count: 2, regions: ['بغداد', 'بلا محافظة'] });
  });

  it('the typed ids are read once for the batch, and the list is looked up in memory — no extra query per parcel', async () => {
    state.parcels = Array.from({ length: 5 }, (_, i) => ({ id: `o${i}`, orderNumber: `ORD-${i}`, regionId: 'r-sweida', regionName: 'السويداء' }));
    state.regions = [SWEIDA];
    await press();
    expect(db.deliveryFee.findMany).toHaveBeenCalledTimes(1);
    expect(createShipment).toHaveBeenCalledTimes(5);
  });

  it('what the press asks the fee table: this courier’s rows that carry a code — nobody else’s', async () => {
    oneParcelTo(SWEIDA);
    await press();
    expect(db.deliveryFee.findMany.mock.calls[0][0]).toMatchObject({ where: { deliveryProviderId: 'p1', courierCityId: { not: null } } });
  });
});
