import { db } from './db';
import { adapterFor } from './couriers';
import type { CourierCityGap } from './courier-city-gap-line';

/**
 * WHICH PARCELS OF AN OPEN TROLLEY THE COURIER HAS NO CITY ID FOR — SAID BEFORE THE PRESS (RV166).
 *
 * «رحّل إلى الشركة» refuses an order whose governorate has no courier city id (dispatch never calls the courier for it,
 * and `NO_COURIER_CITY` names the governorate afterwards). That is right, but the warehouse learned it only after
 * pressing. This is the same decision made earlier and read-only: for each open trolley whose courier needs a city id,
 * the waiting parcels whose governorate has none. It WARNS and never blocks — the press still sends the others.
 *
 * It repeats the dispatch's own conditions (same adapter question, the fee row of the trolley's courier, only the
 * parcels dispatch would still claim), so the warning and the refusal cannot disagree.
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
  const needing = new Set(providers.filter((p) => adapterFor(p).needsCourierCityId).map((p) => p.id));
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

  const fees = await db.deliveryFee.findMany({
    where: { deliveryProviderId: { in: [...needing] }, courierCityId: { not: null } },
    select: { deliveryProviderId: true, regionId: true },
  });
  const known = new Set(fees.map((f) => `${f.deliveryProviderId}|${f.regionId}`));
  const providerOf = new Map(batches.map((b) => [b.id, b.deliveryProviderId!]));

  const missing = parcels.filter(
    (p) => p.shippingBatchId && !known.has(`${providerOf.get(p.shippingBatchId)}|${p.regionId ?? ''}`),
  );
  if (missing.length === 0) return gaps;

  const regionIds = [...new Set(missing.map((p) => p.regionId).filter((v): v is string => !!v))];
  const names = new Map(
    (regionIds.length
      ? await db.region.findMany({ where: { id: { in: regionIds } }, select: { id: true, name: true } })
      : []
    ).map((r) => [r.id, r.name]),
  );

  for (const p of missing) {
    const batchId = p.shippingBatchId!;
    const gap = gaps.get(batchId) ?? { count: 0, regions: [] };
    gap.count += p._count._all;
    const name = p.regionId ? names.get(p.regionId) ?? NO_REGION_AR : NO_REGION_AR;
    if (!gap.regions.includes(name)) gap.regions.push(name);
    gaps.set(batchId, gap);
  }
  return gaps;
}
