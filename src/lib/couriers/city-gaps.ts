import { db } from '../db';
import { adapterFor } from './index';
import { courierCityIdFor, storedCityIds } from './city-id';
import type { CourierCityGap } from './city-gap-line';

/**
 * WHICH PARCELS OF AN OPEN TROLLEY THE COURIER HAS NO CITY ID FOR — SAID BEFORE THE PRESS (RV166).
 *
 * «رحّل إلى الشركة» refuses an order whose governorate has no courier city id (dispatch never calls the courier for it,
 * and `NO_COURIER_CITY` names the governorate afterwards). That is right, but the warehouse learned it only after
 * pressing. This is the same decision made earlier and read-only: for each open trolley whose courier needs a city id,
 * the waiting parcels whose governorate has none. It WARNS and never blocks — the press still sends the others.
 *
 * It repeats the dispatch's own conditions (same adapter question, the same answer for «which id» — `couriers/city-id`:
 * the id typed for the trolley's courier, else the one in the courier's own list — and only the parcels dispatch would
 * still claim), so the warning and the refusal cannot disagree.
 */
/** The governorate of a parcel that has none, as the warning names it. */
const NO_REGION_AR = 'بلا محافظة';

export async function courierCityGaps(input: {
  companyId: string;
  storeId: string;
  batches: { id: string; status: string; deliveryProviderId: string | null }[];
}): Promise<Map<string, CourierCityGap>> {
  const gaps = new Map<string, CourierCityGap>();
  const open = input.batches.filter((b) => b.status === 'READY' && b.deliveryProviderId);
  if (open.length === 0) return gaps;

  // Which of these couriers is sent to by API AND needs the id: the adapter answers, exactly as at the press.
  const providers = await db.deliveryProvider.findMany({
    where: { id: { in: [...new Set(open.map((b) => b.deliveryProviderId!))] }, companyId: input.companyId },
    select: { id: true, name: true, code: true, adapterCode: true, apiEnabled: true, apiConfig: true, apiCredentials: true },
  });
  // courier id → its code (which list we hold for it)
  const needing = new Map(providers.filter((p) => adapterFor(p).needsCourierCityId).map((p) => [p.id, p.code]));
  const batches = open.filter((b) => needing.has(b.deliveryProviderId!));
  if (batches.length === 0) return gaps;

  const parcels = await db.order.groupBy({
    by: ['shippingBatchId', 'regionId'],
    where: {
      companyId: input.companyId,
      storeId: input.storeId,
      shippingBatchId: { in: batches.map((b) => b.id) },
      // What the press would still claim: no barcode, waiting for pickup, confirmed.
      trackingNumber: null,
      shippingStatus: 'READY_FOR_PICKUP',
      confirmationStatus: 'CONFIRMED',
    },
    _count: { _all: true },
  });
  if (parcels.length === 0) return gaps;

  // The ids TYPED for each of these couriers, by courier then region.
  const fees = await db.deliveryFee.findMany({
    where: { deliveryProviderId: { in: [...needing.keys()] }, courierCityId: { not: null } },
    select: { deliveryProviderId: true, regionId: true, courierCityId: true },
  });
  const typed = new Map<string, Map<string, number>>(
    [...needing.keys()].map((id) => [id, storedCityIds(fees.filter((f) => f.deliveryProviderId === id))]),
  );
  const providerOf = new Map(batches.map((b) => [b.id, b.deliveryProviderId!]));

  // The names of every governorate on the trolleys, not only of the ones with no typed id: the courier's own list is
  // asked by NAME, so a parcel with no typed id can still have one.
  const regionIds = [...new Set(parcels.map((p) => p.regionId).filter((v): v is string => !!v))];
  const names = new Map(
    (regionIds.length
      ? await db.region.findMany({ where: { id: { in: regionIds } }, select: { id: true, name: true } })
      : []
    ).map((r) => [r.id, r.name]),
  );

  for (const p of parcels) {
    if (!p.shippingBatchId) continue;
    const providerId = providerOf.get(p.shippingBatchId)!;
    // Exactly the question the press asks of this parcel (`couriers/dispatch`).
    const id = courierCityIdFor({
      providerCode: needing.get(providerId),
      stored: typed.get(providerId) ?? new Map<string, number>(),
      regionId: p.regionId,
      regionName: p.regionId ? names.get(p.regionId) : null,
    });
    if (id !== null) continue;

    const gap = gaps.get(p.shippingBatchId) ?? { count: 0, regions: [] };
    gap.count += p._count._all;
    const name = p.regionId ? names.get(p.regionId) ?? NO_REGION_AR : NO_REGION_AR;
    if (!gap.regions.includes(name)) gap.regions.push(name);
    gaps.set(p.shippingBatchId, gap);
  }
  return gaps;
}
