import { db } from '../../db';
import type { JobDefinition, JobResult } from '../runner';
import { adapterFor } from '../../couriers';
import { applyCourierEvent } from '../../couriers/apply-event';
import { clearMiss, missingHours, recordMiss } from '../../couriers/missing-shipment';
import { createNotification } from '../../notification';

/**
 * Asks each integrated courier where its parcels are.
 *
 * A status that would decide whether money is owed is NEVER applied here —
 * isAutoApplicable refuses DELIVERED, RETURNED and CANCELLED, and an
 * unrecognised code maps to null. Those stay a human decision taken against
 * the courier's statement. This job moves parcels along the in-transit
 * states and nothing else.
 */
/** Parcels asked about per courier per sweep — the rest wait for the next sweep, in id order. */
export const POLL_BATCH = 60;
/** Barcodes asked at once: the first ten tell us whether the courier is reachable at all. */
const POLL_CHUNK = 10;
/*
 * Where each courier's last sweep stopped. In memory: a restart starts again from the top, which only costs one
 * sweep of fairness. Without it, a courier with more than POLL_BATCH parcels in transit had the same first ones
 * asked about for ever.
 */
const pollCursor = new Map<string, string>();
/** Tests start each case from the top. */
export function forgetCourierPollCursor(): void {
  pollCursor.clear();
}

export const syncCourierStatus: JobDefinition = {
  name: 'sync-courier-status',
  everySeconds: 120,
  description: 'تحديث حالات الشحنات من شركات الشحن المرتبطة',
  async run(): Promise<JobResult> {
    /*
     * THE PLATFORM AND THE ACCOUNT ARE PART OF THE QUESTION.
     *
     * This read only {id, code, name, apiEnabled, companyId}. A courier like «الباشا» is code BASHA on the
     * LogesTechs platform (adapterCode LOGESTECHS) with its account encrypted on its row — so `adapterFor` keyed on
     * BASHA, found no adapter, handed back the manual one, and the courier was skipped on every sweep. Not one Basha
     * status was ever read from their API.
     */
    const providers = await db.deliveryProvider.findMany({
      where: { isActive: true, apiEnabled: true },
      select: {
        id: true, code: true, name: true, apiEnabled: true, companyId: true,
        adapterCode: true, apiConfig: true, apiCredentials: true,
      },
    });

    let applied = 0;
    let missing = 0;
    const skipped: string[] = [];
    const notPolled: string[] = [];
    const unreachable: string[] = [];

    for (const provider of providers) {
      const adapter = adapterFor(provider);
      if (!adapter.automated) {
        // Said, not skipped in silence: «لا تحديثات» read as «nothing moved» when nothing was even asked.
        notPolled.push(provider.name);
        continue;
      }

      // One read, its `where` written in place: a-bench-is-not-the-business finds this site by reading it.
      const page = (after?: string) =>
        db.order.findMany({
          where: {
            companyId: provider.companyId,
            deliveryProviderId: provider.id,
            trackingNumber: { not: null },
            shippingStatus: { in: ['READY_FOR_PICKUP', 'SHIPPED', 'OUT_FOR_DELIVERY', 'FAILED_DELIVERY'] },
            ...(after ? { id: { gt: after } } : {}),
          },
          select: {
            id: true, trackingNumber: true, shippingStatus: true, companyId: true, storeId: true,
            orderNumber: true, trackingMissCount: true, trackingMissingSince: true,
            trackingMissingAlertedAt: true,
            // Read so the status's own timestamp is stamped when it is still empty (apply-event).
            shippedAt: true, outForDeliveryAt: true, failedAt: true,
          },
          orderBy: { id: 'asc' },
          take: POLL_BATCH,
        });
      const after = pollCursor.get(provider.id);
      let inTransit = await page(after);
      // Past the end: start again from the top.
      if (inTransit.length === 0 && after) inTransit = await page();
      if (inTransit.length === POLL_BATCH) pollCursor.set(provider.id, inTransit[inTransit.length - 1].id);
      else pollCursor.delete(provider.id);
      if (inTransit.length === 0) continue;

      /*
       * IS THE COURIER THERE AT ALL?
       *
       * The first chunk decides. When every barcode in it (two or more) answers with an error, the courier is down
       * or our account is refused — that is not sixty lost parcels, and counting it as sixty misses would raise
       * sixty «مفقودة» alerts after three sweeps. The courier is skipped and named; nothing is recorded as missing.
       */
      const events: Awaited<ReturnType<typeof adapter.fetchEvents>> = [];
      let reachable = true;
      for (let i = 0; i < inTransit.length; i += POLL_CHUNK) {
        const chunk = await adapter.fetchEvents(inTransit.slice(i, i + POLL_CHUNK).map((o) => o.trackingNumber!));
        if (i === 0 && chunk.length >= 2 && chunk.every((e) => e.rawStatus === 'ERROR')) {
          reachable = false;
          break;
        }
        events.push(...chunk);
      }
      if (!reachable) {
        unreachable.push(provider.name);
        continue;
      }
      const byBarcode = new Map(events.map((e) => [e.trackingNumber, e]));

      for (const order of inTransit) {
        const event = byBarcode.get(order.trackingNumber!);

        // NOTHING CAME BACK, OR AN ERROR DID.
        //
        // This used to be a `continue` — the parcel was asked about again
        // in two minutes, and again, for ever, while it sat in SHIPPED and
        // nobody knew. Three misses in a row, with every other barcode in
        // the same sweep answering, is a parcel that is not there.
        if (!event || event.rawStatus === 'ERROR') {
          const outcome = await recordMiss(db, order);
          if (outcome.alertNow) {
            missing++;
            const hours = missingHours(order.trackingMissingSince ?? new Date());
            await createNotification({
              companyId: order.companyId,
              storeId: order.storeId,
              audience: { permission: 'ops.track' },
              type: 'SYSTEM_ALERT',
              title: 'شحنة مفقودة عند شركة الشحن',
              message:
                `الطلب ${order.orderNumber} بباركود ${order.trackingNumber} — ` +
                `${provider.name} لا تعرفه منذ ${hours} ساعة. لم تعد تُستعلَم بصمت.`,
              // The NUMBER, not the id: the tracking screen searches by
              // number, reference, barcode, customer and phone, and an id
              // matches none of them — so this link used to land on every
              // parcel in the store instead of the lost one.
              link: `/ops/tracking?order=${order.orderNumber}`,
            });
          }
          continue;
        }

        // It answered, so it is not missing — and a barcode that goes
        // missing, comes back and goes again is two incidents, the second
        // as worth shouting about as the first.
        if (order.trackingMissCount > 0 || order.trackingMissingAlertedAt) {
          await clearMiss(db, order);
        }

        // The same gate the webhook goes through — see couriers/apply-event.
        const outcome = await applyCourierEvent({
          order,
          event,
          courierName: provider.name,
          source: 'POLL',
        });
        if (outcome === 'APPLIED') applied++;
        else if (outcome === 'NOT_AUTO_APPLICABLE') skipped.push(event.rawStatus);
      }
    }

    const notes = [
      applied ? `حُدِّث ${applied} شحنة` : null,
      skipped.length ? `${skipped.length} حالة تحتاج قراراً بشرياً` : null,
      missing ? `${missing} شحنة مفقودة عند الشركة` : null,
      notPolled.length ? `لا يُستطلع: ${notPolled.join('، ')} — حسابها عند الشركة غير مكتمل أو غير مقروء` : null,
    ].filter(Boolean);

    // The other couriers' work is already written; the run is marked failed so the worker backs off and the jobs
    // screen says which courier could not be reached.
    if (unreachable.length) {
      throw new Error(`تعذّر الوصول إلى ${unreachable.join('، ')} — لم يُعَدّ أي طرد مفقوداً. ${notes.join(' · ')}`.trim());
    }

    return { processed: applied, detail: notes.join(' · ') || 'لا تحديثات' };
  },
};
