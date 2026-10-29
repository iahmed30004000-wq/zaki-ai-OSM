import { db } from '../db';
import { decryptSecret } from '../secrets';
import { BACKOFF, MAX_ATTEMPTS } from '../apps/events';
import { buildUserData, customerPhoneFacts, matchQuality } from './hash';
import { sendEvents, explainCapiError, CapiError, type CapiEvent } from './meta-capi';
import {
  conversionEventId, isTooOldForMeta, META_EVENT_MAX_AGE_DAYS, salesPageOf,
  type ConversionTrigger,
} from './types';
import { pixelReaches, scopeServesPage } from '../tracking/tracking-types';

/**
 * FROM A MOMENT IN AN ORDER TO A NUMBER IN ADS MANAGER.
 *
 * Two halves, deliberately apart. The order writes a row saying that a
 * conversion is owed; a worker sends it later. Never inline: an order must
 * not fail to save because Meta is slow, and a sale that happened has
 * happened whatever any advertising platform thinks about it.
 *
 * The retry schedule is the one the webhook outbox already uses — imported,
 * not copied. Two schedules drifting apart is how a system ends up with two
 * answers to "how patient are we".
 */

/**
 * Write down every conversion this moment owes.
 *
 * NEVER THROWS. Announcing what happened must not be able to undo it: an
 * order that confirmed has confirmed, even if this table is missing, the
 * database is busy, or somebody deleted a pixel mid-request.
 */
export async function queueConversions(
  companyId: string,
  trigger: ConversionTrigger,
  orderId: string
): Promise<number> {
  try {
    // Only an order that came through a selling page — see `salesPageOf`.
    // One typed in from a chat, a call or a sheet is owed nothing.
    const order = await db.order.findFirst({
      where: { id: orderId, companyId },
      select: { source: true, landingPageId: true, storeId: true, countryId: true },
    });
    const page = order ? salesPageOf(order) : null;
    if (!order || !page) return 0;

    const candidates = await db.customConversion.findMany({
      where: {
        companyId,
        trigger,
        enabled: true,
        // A pixel that is switched off, or has no token, cannot receive
        // anything. Queuing for it would build a backlog that fails on
        // every attempt and tells the seller nothing they can act on.
        pixel: { enabled: true, capiToken: { not: null } },
      },
      select: { id: true, pixel: { select: { scope: true, storeId: true, countryId: true } } },
    });
    // And only to a pixel that page loads: the same store/country rule and
    // kind-of-page rule as the browser, so a store's pixel never hears about
    // another store's sale.
    const origin = { storeId: order.storeId, countryId: order.countryId };
    const conversions = candidates.filter(
      (c) => pixelReaches(c.pixel, origin) && scopeServesPage(c.pixel.scope, page)
    );
    if (conversions.length === 0) return 0;

    const { count } = await db.conversionDelivery.createMany({
      data: conversions.map((c) => ({
        companyId,
        conversionId: c.id,
        orderId,
        eventId: conversionEventId(c.id, orderId),
        status: 'PENDING',
        // Due immediately. The delay in this feature is the worker's tick,
        // not an artificial wait.
        nextAttemptAt: new Date(),
      })),
      // THE GUARANTEE. A status set to DELIVERED twice, a replayed webhook,
      // two requests racing — all collapse onto the row already there.
      skipDuplicates: true,
    });
    return count;
  } catch {
    return 0;
  }
}

/** Deliveries that are due now, oldest first. */
export async function dueConversions(limit = 50) {
  return db.conversionDelivery.findMany({
    where: { status: 'PENDING', nextAttemptAt: { lte: new Date() } },
    orderBy: { createdAt: 'asc' },
    take: limit,
    select: { id: true },
  });
}

/**
 * The moment the conversion describes, which is NOT the moment we send it.
 *
 * A delivery that happened on Tuesday and is sent on Wednesday must carry
 * Tuesday. Sending `now` would push every conversion to the day the worker
 * ran, which quietly destroys the day-by-day reporting a seller uses to
 * decide what to switch off.
 */
export function eventTimeFor(
  trigger: ConversionTrigger,
  order: { createdAt: Date; confirmedAt: Date | null; deliveredAt: Date | null }
): Date {
  if (trigger === 'order.delivered') return order.deliveredAt ?? order.createdAt;
  if (trigger === 'order.confirmed') return order.confirmedAt ?? order.createdAt;
  return order.createdAt;
}


/**
 * What this conversion was worth, or null for an event with no value.
 *
 * The COLLECTED_AMOUNT case reads wrong and is right: `collectedAmount` is
 * recorded ONLY on a PARTIAL delivery — it is null on a whole one, which is
 * precisely what lets settlement tell the two apart. So null here does not
 * mean "nothing was collected", it means "everything was", and the order
 * total is the true figure. Reading it as zero would report every complete
 * sale as worthless; `agent-custody` and `analytics` already read it this
 * way, and a third reading would be a third answer to one question.
 */
export function conversionValue(
  valueSource: string,
  order: { totalAmount: number | null; collectedAmount: unknown }
): number | null {
  if (valueSource === 'NONE') return null;
  const raw =
    valueSource === 'COLLECTED_AMOUNT'
      ? Number(order.collectedAmount ?? order.totalAmount ?? 0)
      : Number(order.totalAmount ?? 0);
  if (!Number.isFinite(raw) || raw < 0) return 0;
  /*
   * TWO DECIMALS HERE IS DELIBERATE, and it is NOT the `roundMinor` defect
   * found in seven other places on 2026-10-02.
   *
   * Those wrote money into THIS system's own records — an order's cost, a
   * settlement, a partial delivery — where a dropped digit is a real
   * discrepancy somebody has to reconcile, and JOD has three of them.
   *
   * This number leaves for an ad platform. It is a signal for optimisation,
   * not a figure anybody settles on, Meta takes a plain float, and the
   * rounding is to nearest so it carries no bias. Pinned by a test at
   * `conversions.test.ts` («10.005 → 10.01»), and written down here because
   * the next sweep for `* 100 / 100` will find this line and should stop.
   */
  return Math.round(raw * 100) / 100;
}

/**
 * Send one queued conversion.
 *
 * Returns true only when Meta acknowledged it. Everything else writes down
 * what went wrong and when to try again — a conversion that fails silently
 * is a seller optimising on numbers that stopped arriving a month ago.
 */
export async function deliverConversion(deliveryId: string): Promise<boolean> {
  const delivery = await db.conversionDelivery.findUnique({
    where: { id: deliveryId },
    select: {
      id: true, eventId: true, attempts: true,
      conversion: {
        select: {
          eventName: true, trigger: true, valueSource: true,
          pixel: { select: { pixelId: true, capiDatasetId: true, capiToken: true, capiTestCode: true, platform: true } },
        },
      },
      order: {
        select: {
          id: true, orderNumber: true, totalAmount: true, collectedAmount: true,
          currency: true, createdAt: true, confirmedAt: true, deliveredAt: true,
          productId: true, landingPageId: true, landingPage: { select: { slug: true } },
          // The ORDER's country decides the phone's dial code and the country Meta is told. `Customer.country` is
          // «EG» on every row (the column default, never set by any door), so it is not read.
          country: { select: { code: true } },
          customer: { select: { id: true, fullName: true, phone: true, rawPhone: true, city: true } },
        },
      },
    },
  });
  if (!delivery) return false;

  const attempt = delivery.attempts + 1;
  const { conversion, order } = delivery;
  const pixel = conversion.pixel;

  // Only Meta speaks this API. TikTok and Snapchat have their own Events
  // APIs with different shapes; a row for one of those is parked rather
  // than retried, so it is visible the day they are added.
  if (pixel.platform !== 'META') {
    return fail(delivery.id, attempt, `منصة غير مدعومة بعد: ${pixel.platform}`, false);
  }
  if (!pixel.capiToken) {
    return fail(delivery.id, attempt, 'لا رمز محفوظ لهذا البكسل', false);
  }

  let token: string;
  try {
    token = decryptSecret(pixel.capiToken);
  } catch {
    // An unreadable token cannot be fixed by waiting. Say so once.
    return fail(delivery.id, attempt, 'تعذر فكّ تشفير الرمز — أعد حفظه', false);
  }

  const eventTime = eventTimeFor(conversion.trigger as ConversionTrigger, order);

  // Meta refuses anything older than seven days. Without this the row would
  // retry five times over six hours and die with a message about a
  // timestamp, for every late order, for ever.
  if (isTooOldForMeta(eventTime)) {
    await db.conversionDelivery.update({
      where: { id: delivery.id },
      data: {
        status: 'SKIPPED',
        attempts: attempt,
        nextAttemptAt: null,
        lastError: `الحدث أقدم من ${META_EVENT_MAX_AGE_DAYS} أيام — ميتا لا تقبله. تأخّر الطلب خارج نافذة الإسناد.`,
      },
    });
    return false;
  }

  const c = order.customer;
  const userData = buildUserData({
    // rawPhone is how the customer wrote it; phone is already digits. Either
    // normalises to the same fingerprint, and preferring the stored digits
    // avoids a display format ever reaching the hash. The dial code and the
    // country come from the ORDER's country — see `customerPhoneFacts`.
    ...customerPhoneFacts(c.phone || c.rawPhone, order.country?.code),
    fullName: c.fullName,
    city: c.city,
    externalId: c.id,
  });

  const custom: Record<string, unknown> = {
    order_id: order.orderNumber,
    content_ids: [order.productId],
    content_type: 'product',
  };

  const value = conversionValue(conversion.valueSource, order);
  if (value !== null) {
    custom.value = value;
    custom.currency = (order.currency || 'JOD').toUpperCase();
  }

  const event: CapiEvent = {
    event_name: conversion.eventName,
    // SECONDS. Milliseconds are accepted and silently useless.
    event_time: Math.floor(eventTime.getTime() / 1000),
    event_id: delivery.eventId,
    // The journey began on the website even when the confirmation was a
    // phone call and the payment was at a door — that is where the advert
    // was clicked, and it is what Meta matches against.
    action_source: 'website',
    user_data: userData,
    custom_data: custom,
  };
  // The page the order came from. Public pages resolve by SLUG — this used
  // to send the page's id, a URL that answers 404, on every event.
  if (order.landingPage?.slug) {
    const base = process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL;
    if (base) event.event_source_url = `${base.replace(/\/+$/, '')}/lp/${encodeURIComponent(order.landingPage.slug)}`;
  }

  try {
    // The dataset, when the seller named one; otherwise the pixel, which for a
    // web pixel is the same number.
    await sendEvents(pixel.capiDatasetId || pixel.pixelId, token, [event], pixel.capiTestCode);
    await db.conversionDelivery.update({
      where: { id: delivery.id },
      data: {
        status: 'SENT',
        attempts: attempt,
        sentAt: new Date(),
        nextAttemptAt: null,
        lastError: null,
        // Written down because this is the one failure nobody sees: events
        // arriving, Meta reporting success, and matching no human being.
        matchQuality: matchQuality(userData),
      },
    });
    return true;
  } catch (e) {
    const retryable = e instanceof CapiError ? e.retryable : true;
    return fail(delivery.id, attempt, explainCapiError(e), retryable);
  }
}

/**
 * Write down the failure and decide whether to try again.
 *
 * A rejected token will be just as rejected in six hours, so it is failed
 * at once rather than retried into a wall — five pointless attempts only
 * delay the moment somebody reads the message.
 */
async function fail(id: string, attempt: number, error: string, retryable: boolean): Promise<boolean> {
  const exhausted = !retryable || attempt >= MAX_ATTEMPTS;
  await db.conversionDelivery.update({
    where: { id },
    data: {
      status: exhausted ? 'FAILED' : 'PENDING',
      attempts: attempt,
      lastError: error.slice(0, 500),
      nextAttemptAt: exhausted ? null : new Date(Date.now() + BACKOFF[attempt - 1] * 1000),
    },
  });
  return false;
}
