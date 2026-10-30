import { db } from '../../db';
import type { JobDefinition, JobResult } from '../runner';
import { adapterFor } from '../../couriers';
import { applyCourierEvent } from '../../couriers/apply-event';
import { clearMiss, missingHours, recordMiss } from '../../couriers/missing-shipment';
import { isAnOutage, outageReason } from '../../couriers/outage';
import { stampCourierPolled } from '../../couriers/poll-stamp';
import { createNotification } from '../../notification';
import { SHIPPING_STATUS_AR } from '../../shipping-workflow';

/**
 * Asks each integrated courier where its parcels are.
 *
 * A status that would decide whether money is owed is NEVER applied here —
 * isAutoApplicable refuses DELIVERED, RETURNED and CANCELLED, and an
 * unrecognised code maps to null. Those stay a human decision taken against
 * the courier's statement. This job moves parcels along the in-transit
 * states and nothing else.
 */
/** Parcels asked about per courier per sweep — the rest wait for the next sweep. */
export const POLL_BATCH = 60;
/** Barcodes asked at once: the first ten tell us whether the courier is reachable at all. */
const POLL_CHUNK = 10;

/*
 * WHERE EACH COURIER'S SWEEP STOPPED IS IN THE DATABASE (RV146).
 *
 * `orders.courier_polled_at` is the last time the courier was asked about the parcel. The sweep takes the parcels never
 * asked about first, then the ones asked longest ago — so a courier with more than POLL_BATCH parcels in transit is
 * walked through fairly, and a deploy or a restart no longer sends it back to the same first sixty (the old cursor
 * lived in the process). The stamp is written by raw SQL (couriers/poll-stamp), after the courier answered, for the
 * parcels that were actually asked — never for a courier that did not answer at all.
 */

/**
 * THE TRIAL SWITCH. `COURIER_POLL_DRY_RUN=1` (or `true`): the sweep asks the courier, runs every guard, and writes the
 * result as the job's own sentence — and writes NOTHING else: no status, no stamp, no timeline row, no miss count, no
 * alert. Off by default, so an unset variable is today's behaviour.
 */
export function courierPollIsDryRun(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.COURIER_POLL_DRY_RUN?.trim().toLowerCase();
  return v === '1' || v === 'true';
}

const statusWord = (status: string): string => SHIPPING_STATUS_AR[status as keyof typeof SHIPPING_STATUS_AR] ?? status;

export const syncCourierStatus: JobDefinition = {
  name: 'sync-courier-status',
  everySeconds: 120,
  description: 'تحديث حالات الشحنات من شركات الشحن المرتبطة',
  async run(): Promise<JobResult> {
    const dryRun = courierPollIsDryRun();
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
    // A trial only: what the sweep would have done, said instead of done.
    const wouldMove: string[] = [];
    let wouldCountMissing = 0;

    for (const provider of providers) {
      const adapter = adapterFor(provider);
      if (!adapter.automated) {
        // Said, not skipped in silence: «لا تحديثات» read as «nothing moved» when nothing was even asked.
        notPolled.push(provider.name);
        continue;
      }

      // One read, its `where` written in place: a-bench-is-not-the-business finds this site by reading it.
      // Never asked first (null), then asked longest ago; `id` only breaks a tie so the order is the same every time.
      const inTransit = await db.order.findMany({
        where: {
          companyId: provider.companyId,
          deliveryProviderId: provider.id,
          trackingNumber: { not: null },
          shippingStatus: { in: ['READY_FOR_PICKUP', 'SHIPPED', 'OUT_FOR_DELIVERY', 'FAILED_DELIVERY'] },
        },
        select: {
          id: true, trackingNumber: true, shippingStatus: true, companyId: true, storeId: true,
          orderNumber: true, trackingMissCount: true, trackingMissingSince: true,
          trackingMissingAlertedAt: true,
          // Read so the status's own timestamp is stamped when it is still empty (apply-event).
          shippedAt: true, outForDeliveryAt: true, failedAt: true,
        },
        orderBy: [{ courierPolledAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
        take: POLL_BATCH,
      });
      if (inTransit.length === 0) continue;

      /*
       * IS THE COURIER THERE AT ALL?
       *
       * The first chunk decides. When every barcode in it (two or more) answers with an error, the courier is down
       * or our account is refused — that is not sixty lost parcels, and counting it as sixty misses would raise
       * sixty «مفقودة» alerts after three sweeps. The courier is skipped and named; nothing is recorded as missing.
       * The error class each answer carries says WHY, so the name comes with its reason (couriers/outage).
       */
      const events: Awaited<ReturnType<typeof adapter.fetchEvents>> = [];
      let reachable = true;
      for (let i = 0; i < inTransit.length; i += POLL_CHUNK) {
        const chunk = await adapter.fetchEvents(inTransit.slice(i, i + POLL_CHUNK).map((o) => o.trackingNumber!));
        if (i === 0 && isAnOutage(chunk)) {
          reachable = false;
          unreachable.push(`${provider.name} (${outageReason(chunk)})`);
          break;
        }
        events.push(...chunk);
      }
      // Nothing was learned, so nothing is stamped: the same parcels are asked again as soon as it answers.
      if (!reachable) continue;
      // It answered, so these parcels HAVE been asked, whatever it said about each. Not in a trial.
      if (!dryRun) await stampCourierPolled(provider.companyId, inTransit.map((o) => o.id));
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
          // A trial counts the miss and does not record it: a recorded miss is what raises the alert.
          if (dryRun) {
            wouldCountMissing++;
            continue;
          }
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
        if (!dryRun && (order.trackingMissCount > 0 || order.trackingMissingAlertedAt)) {
          await clearMiss(db, order);
        }

        // The same gate the webhook goes through — see couriers/apply-event.
        const outcome = await applyCourierEvent({
          order,
          event,
          courierName: provider.name,
          source: 'POLL',
          dryRun,
        });
        if (outcome === 'APPLIED') {
          applied++;
          if (dryRun) wouldMove.push(`${order.orderNumber}: ${statusWord(order.shippingStatus)} ← ${statusWord(event.status ?? event.rawStatus)}`);
        } else if (outcome === 'NOT_AUTO_APPLICABLE') skipped.push(event.rawStatus);
      }
    }

    if (dryRun) {
      // A trial writes nothing but this sentence, and `processed` stays 0: nothing was processed.
      const shown = wouldMove.slice(0, 10).join('، ') + (wouldMove.length > 10 ? '، …' : '');
      const trial = [
        `تجربة بلا كتابة: كان سيُحدَّث ${applied} شحنة${shown ? ` (${shown})` : ''}`,
        skipped.length ? `${skipped.length} حالة تحتاج قراراً بشرياً` : null,
        wouldCountMissing ? `${wouldCountMissing} شحنة لم تردّ عنها الشركة` : null,
        notPolled.length ? `لا يُستطلع: ${notPolled.join('، ')}` : null,
      ].filter(Boolean);
      if (unreachable.length) {
        throw new Error(`تعذّر الوصول إلى ${unreachable.join('، ')} — تجربة بلا كتابة. ${trial.join(' · ')}`.trim());
      }
      return { processed: 0, detail: trial.join(' · ') };
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
