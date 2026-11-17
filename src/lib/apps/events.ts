import crypto from 'crypto';
import { db } from '../db';
import { decryptSecret } from '../secrets';

/**
 * TELLING AN APP WHAT HAPPENED.
 *
 * An external app is told; it is not given the keys. That is the whole of
 * its power for now, and it is deliberate: a webhook can be pointed at a
 * wrong URL and leak a phone number, but it cannot delete an order, move
 * money, or read a customer it was never told about.
 *
 * Every attempt is written down before it is made. A webhook that fails
 * silently is an integration that stops silently — the seller believes the
 * two systems are in step and the developer has no way to find out they are
 * not. A delivery row says what was sent, where, how many times, and what
 * came back.
 *
 * Delivery is never inline with the thing that happened. An order must not
 * fail to save because somebody's server is down, so the row is written and
 * the worker does the sending.
 */

/** What an app may ask to hear about. */
export const APP_EVENTS = [
  'order.created',
  'order.confirmed',
  'order.shipped',
  'order.delivered',
  'order.returned',
  'order.cancelled',
] as const;

export type AppEvent = (typeof APP_EVENTS)[number];

export const APP_EVENT_AR: Record<AppEvent, string> = {
  'order.created': 'طلب جديد',
  'order.confirmed': 'تأكيد طلب',
  'order.shipped': 'شحن طلب',
  'order.delivered': 'تسليم طلب',
  'order.returned': 'إرجاع طلب',
  'order.cancelled': 'إلغاء طلب',
};

export function isAppEvent(v: string): v is AppEvent {
  return (APP_EVENTS as readonly string[]).includes(v);
}

/**
 * THE EVENT THAT IS NOT ONE OF THE SIX — «اوقف» from the owner (the media buyer's doors, PR-B, O5).
 *
 * `APP_EVENTS` is the replies system's contract (`contracts/oms-app-events.v1`: the schema's enum IS this list, held by `events.test.ts`), so it stays exactly six.
 * The owner's stop request is a different kind of thing: it is not something that happened to an order, it is a command the owner typed to the bot, and it is
 * meant for ONE app — the media buyer, registered as an installed app — never for every listener. It travels through the SAME installed-apps machinery
 * (the app's URL and secret, the delivery log, the retries, the page `/apps/installed`) and nothing new: `emitOwnerStop` writes the same `AppDelivery` row
 * `emitAppEvent` does. An app hears it only if it registered for it by name; the replies system did not and never gets it.
 */
export const OWNER_STOP_EVENT = 'owner.stop_requested' as const;

/** Events an external app may register for beyond the six of the replies contract. */
export const EXTRA_APP_EVENTS = [OWNER_STOP_EVENT] as const;
export type ExtraAppEvent = (typeof EXTRA_APP_EVENTS)[number];

export const EXTRA_APP_EVENT_AR: Record<ExtraAppEvent, string> = {
  'owner.stop_requested': 'طلب إيقاف من المالك («اوقف …» للبوت)',
};

/** Is this a name an external app may register for — one of the six, or an extra? */
export function isRegisterableEvent(v: string): v is AppEvent | ExtraAppEvent {
  return isAppEvent(v) || (EXTRA_APP_EVENTS as readonly string[]).includes(v);
}

/**
 * The timestamp header of a delivery, in the unit the RECEIVER reads.
 *
 * The six order events keep the milliseconds their published contract says (`X-Zaki-Timestamp` in ms — the replies system reads it that way). The media buyer's
 * contract (`oms.stop-event`) says «unix seconds, rejected when more than five minutes old», and its verifier (`verifySignature` in its `step-exec.ts`) divides
 * the clock by 1000 before comparing — a millisecond value would be rejected as 50,000 years old. The signature is over the same string either way
 * (`<timestamp>.<body>`), so it is the timestamp that is in the receiver's unit.
 */
export function deliveryTimestamp(event: string, nowMs: number): string {
  return event === OWNER_STOP_EVENT ? String(Math.floor(nowMs / 1000)) : String(nowMs);
}

/** The company whose installed app listens to the stop request — only when it is exactly one (the owner's chat does not name a company). */
export async function companyListeningToStop(): Promise<string | null> {
  const installs = await db.appInstall.findMany({
    where: { enabled: true, app: { status: 'ACTIVE', webhookUrl: { not: null } } },
    select: { companyId: true, app: { select: { events: true } } },
  });
  const companies = new Set<string>();
  for (const i of installs) {
    try {
      const events = JSON.parse(i.app?.events ?? '[]');
      if (Array.isArray(events) && events.includes(OWNER_STOP_EVENT)) companies.add(i.companyId);
    } catch {
      // an unreadable list listens to nothing
    }
  }
  return companies.size === 1 ? [...companies][0] : null;
}

/**
 * Queue the owner's stop request for every installed app of this company that registered for it. Never throws; returns how many apps will be told.
 *
 * The same text typed twice within two minutes is one request: Telegram re-sends an update it did not hear an answer to, and a stop must not be queued twice for it.
 */
export async function emitOwnerStop(
  companyId: string,
  data: { query: string; source_chat: 'owner' | 'allowed' }
): Promise<number> {
  try {
    const installs = await db.appInstall.findMany({
      where: { companyId, enabled: true, app: { status: 'ACTIVE', webhookUrl: { not: null } } },
      select: { id: true, app: { select: { events: true, webhookUrl: true } } },
    });
    const listening = installs.filter((i) => {
      try {
        const events = JSON.parse(i.app?.events ?? '[]');
        return Array.isArray(events) && events.includes(OWNER_STOP_EVENT);
      } catch {
        return false;
      }
    });
    if (listening.length === 0) return 0;

    const marker = JSON.stringify(data);
    const recent = await db.appDelivery.findMany({
      where: {
        companyId,
        event: OWNER_STOP_EVENT,
        installId: { in: listening.map((i) => i.id) },
        createdAt: { gte: new Date(Date.now() - 2 * 60_000) },
      },
      select: { installId: true, payload: true },
    });
    const fresh = listening.filter((i) => !recent.some((r) => r.installId === i.id && r.payload.includes(`"data":${marker}`)));
    if (fresh.length === 0) return listening.length;

    const body = JSON.stringify({ event: OWNER_STOP_EVENT, at: new Date().toISOString(), data });
    await db.appDelivery.createMany({
      data: fresh.map((i) => ({
        companyId,
        installId: i.id,
        event: OWNER_STOP_EVENT,
        payload: body,
        url: i.app!.webhookUrl!,
        status: 'PENDING',
        nextAttemptAt: new Date(),
      })),
    });
    return listening.length;
  } catch (e) {
    console.error('emitOwnerStop failed (non-fatal):', (e as Error)?.name || 'unknown');
    return 0;
  }
}

/** Retry schedule in seconds: quick, then patient, then give up. */
export const BACKOFF = [30, 120, 600, 3600, 21600];
export const MAX_ATTEMPTS = BACKOFF.length;

/**
 * Queue this event for every installed app that asked for it.
 *
 * Never throws. Announcing what happened must not be able to undo it: an
 * order that saved has saved, whatever any integration thinks about it.
 */
export async function emitAppEvent(
  companyId: string,
  event: AppEvent,
  payload: Record<string, unknown>
): Promise<number> {
  try {
    const installs = await db.appInstall.findMany({
      where: {
        companyId,
        enabled: true,
        app: { status: 'ACTIVE', webhookUrl: { not: null } },
      },
      select: { id: true, app: { select: { events: true, webhookUrl: true } } },
    });

    const listening = installs.filter((i) => {
      try {
        const events = JSON.parse(i.app?.events ?? '[]');
        return Array.isArray(events) && events.includes(event);
      } catch {
        return false;
      }
    });
    if (listening.length === 0) return 0;

    const body = JSON.stringify({ event, at: new Date().toISOString(), data: payload });

    await db.appDelivery.createMany({
      data: listening.map((i) => ({
        companyId,
        installId: i.id,
        event,
        payload: body,
        url: i.app!.webhookUrl!,
        status: 'PENDING',
        nextAttemptAt: new Date(),
      })),
    });
    return listening.length;
  } catch (e) {
    console.error('emitAppEvent failed (non-fatal):', e);
    return 0;
  }
}

/**
 * The signature an app checks.
 *
 * `sha256=<hex>` over `<timestamp>.<body>` with the app's secret. The
 * timestamp is inside the signed string so a captured request cannot be
 * replayed a week later with the same signature still valid.
 */
export function signPayload(secret: string, timestamp: string, body: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

/**
 * Send one pending delivery.
 *
 * Returns whether it landed. A 2xx is success; anything else is a retry
 * until the attempts run out, because a developer's server being down for
 * an hour should not lose them a day of orders.
 */
export async function deliverOne(deliveryId: string): Promise<boolean> {
  const delivery = await db.appDelivery.findUnique({
    where: { id: deliveryId },
    select: {
      id: true, url: true, payload: true, event: true, attempts: true,
      install: { select: { app: { select: { secret: true, code: true } } } },
    },
  });
  if (!delivery) return false;

  const attempt = delivery.attempts + 1;
  const timestamp = deliveryTimestamp(delivery.event, Date.now());

  let secret: string | null = null;
  try {
    secret = delivery.install.app?.secret ? decryptSecret(delivery.install.app.secret) : null;
  } catch {
    // An unreadable secret cannot be signed with, and sending unsigned would
    // teach the receiver to accept unsigned. Fail it loudly instead.
    await db.appDelivery.update({
      where: { id: delivery.id },
      data: { status: 'FAILED', attempts: attempt, error: 'SECRET_UNREADABLE', nextAttemptAt: null },
    });
    return false;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);

    const res = await fetch(delivery.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Zaki-Event': delivery.event,
        'X-Zaki-Delivery': delivery.id,
        'X-Zaki-Timestamp': timestamp,
        ...(secret ? { 'X-Zaki-Signature': signPayload(secret, timestamp, delivery.payload) } : {}),
      },
      body: delivery.payload,
      signal: controller.signal,
      redirect: 'manual', // a webhook that redirects is a webhook pointed somewhere else
    });
    clearTimeout(timer);

    const ok = res.status >= 200 && res.status < 300;
    await db.appDelivery.update({
      where: { id: delivery.id },
      data: ok
        ? { status: 'OK', attempts: attempt, responseCode: res.status, deliveredAt: new Date(), nextAttemptAt: null, error: null }
        : nextTry(attempt, `HTTP ${res.status}`, res.status),
    });
    return ok;
  } catch (e) {
    await db.appDelivery.update({
      where: { id: delivery.id },
      data: nextTry(attempt, e instanceof Error ? e.message.slice(0, 200) : 'network error', null),
    });
    return false;
  }
}

function nextTry(attempt: number, error: string, code: number | null) {
  const exhausted = attempt >= MAX_ATTEMPTS;
  return {
    status: exhausted ? 'FAILED' : 'PENDING',
    attempts: attempt,
    responseCode: code,
    error,
    nextAttemptAt: exhausted ? null : new Date(Date.now() + BACKOFF[attempt - 1] * 1000),
  };
}

/** Deliveries that are due now, oldest first. */
export async function dueDeliveries(limit = 50) {
  return db.appDelivery.findMany({
    where: { status: 'PENDING', nextAttemptAt: { lte: new Date() } },
    orderBy: { createdAt: 'asc' },
    take: limit,
    select: { id: true },
  });
}
