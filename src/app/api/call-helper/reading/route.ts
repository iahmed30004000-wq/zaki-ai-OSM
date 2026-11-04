import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { requireCompanyTenant } from '@/lib/auth';
import { can } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { rateLimit } from '@/lib/rate-limit';
import { validateSelection } from '@/lib/geo-context';
import { assertOrderAccess } from '@/lib/rbac';
import { ORDER_WORK_DOOR } from '@/lib/order-work-door';
import { ORDER_NOT_FOUND } from '@/lib/order-refusals';
import { mustHoldToWork } from '@/lib/confirmation-queue';
import { isLinkOrderId, readReading, samePhone } from '@/lib/call-helper/core';
import { requireCallHelperDevice } from '@/lib/call-helper/door';

/**
 * «مساعد الاتصال» — WHAT THE PHONE'S CALL LOG SAID ABOUT ONE CALL.
 *
 * ── POST (the app, Bearer token) ──
 *
 * Body `{ orderId, phone, startedAt, answered, talkSeconds, ringSeconds }` (contract v1) → `{ ok: true }`; 401 when the
 * pairing is dead (revoked, replaced by a newer phone, her account not ACTIVE) — the app then forgets it. Anything else
 * non-2xx the app keeps and sends again later, so a refusal here costs nothing but a retry.
 *
 * It is accepted only for an order she could work from her browser right now: of the device's company, in a store she
 * may stand in, through the same work door and hold rule as the call sheet's other presses (contact-attempts,
 * whatsapp-template) — and only when the number the app dialled is that order's customer (last eight digits). Every
 * refusal says only «not yours»; the reason is not spelled out to a phone.
 *
 * ── A READING IS EVIDENCE, NOTHING ELSE ──
 *
 * It writes one row in `call_helper_readings` and the device's `lastSeenAt` — and NOTHING on the order: no contact
 * attempt, no state, no owner, no no-answer count, no round, no commission. The «شو صار؟» sheet reads it back to put the
 * likely answer first; she still taps, and her tap goes through the doors that count. The number is compared and
 * dropped, never stored. The same reading twice (the app retries a reply it never saw) is the first one, unchanged.
 *
 * ── GET ?orderId= (her browser, session) ──
 *
 * Her own latest reading for that order received in the last fifteen minutes, or `{ reading: null }`.
 */

const REFUSED = 'هالقراءة مش لطلب بين إيديكِ.';
const DEAD = 'الربط انلغى — اربطي التلفون من جديد من «طلباتي».';
/** A phone sends one reading per call; this is far above any day's work and well below a flood. */
const DEVICE_LIMIT_PER_MIN = 60;
/** How far back the sheet looks for the call she has just come back from. */
const FRESH_MS = 15 * 60 * 1000;

const said = (status: number, error: string) => NextResponse.json({ error, errorAr: error }, { status });

export async function POST(req: Request) {
  try {
    const caller = await requireCallHelperDevice(req);
    if (!caller) return said(401, DEAD);
    const { user, companyId, deviceId } = caller;

    if (!rateLimit(`call-helper-reading:${deviceId}`, DEVICE_LIMIT_PER_MIN, 60 * 1000).allowed) {
      return said(429, 'قراءات كتير — رح تنبعت بعدين.');
    }
    const now = Date.now();
    const body = readReading(await req.json().catch(() => null), now);
    if (!body) return said(400, 'القراءة مش مفهومة.');

    // The store she would have to stand in to work this order from her browser — and whether she may.
    const head = await db.order.findFirst({
      where: { id: body.orderId, companyId },
      select: { storeId: true, store: { select: { countryId: true } } },
    });
    if (!head?.storeId || !head.store) return said(404, ORDER_NOT_FOUND);
    const mayStand = await validateSelection(user, companyId, head.store.countryId, head.storeId).then(
      () => true,
      () => false
    );
    if (!mayStand) return said(404, ORDER_NOT_FOUND);

    let access: Awaited<ReturnType<typeof assertOrderAccess>>;
    try {
      access = await assertOrderAccess(body.orderId, user, { companyId, storeId: head.storeId }, ORDER_WORK_DOOR);
    } catch {
      return said(403, REFUSED);
    }
    if (!access.allowed) return said(404, ORDER_NOT_FOUND);
    const order = access.order;
    if (mustHoldToWork((permission) => can(user, permission)) && order.claimedById !== user.id) {
      return said(403, REFUSED);
    }

    const customer = await db.customer.findFirst({
      where: { id: order.customerId, companyId },
      select: { phone: true, rawPhone: true },
    });
    if (!customer || !(samePhone(body.phone, customer.rawPhone) || samePhone(body.phone, customer.phone))) {
      return said(403, REFUSED);
    }

    const startedAt = new Date(body.startedAt);
    try {
      await db.callHelperReading.upsert({
        where: { deviceId_orderId_startedAt: { deviceId, orderId: body.orderId, startedAt } },
        create: {
          companyId,
          userId: user.id,
          deviceId,
          orderId: body.orderId,
          startedAt,
          answered: body.answered,
          talkSeconds: body.talkSeconds,
          ringSeconds: body.ringSeconds,
        },
        // The second copy of a reading is the first one: nothing in it changes.
        update: {},
      });
    } catch (e) {
      // Two copies racing each other: the other one's insert won, and that is the same reading.
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
    }
    await db.callHelperDevice.update({ where: { id: deviceId }, data: { lastSeenAt: new Date(now) } }).catch(() => {});

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[call-helper] reading failed:', (error as Error)?.message ?? '');
    // Never a 401 from here: that would make the app forget a pairing that is alive. A 500 is kept and sent again.
    return said(500, 'صار خطأ بالسيرفر — القراءة رح تنبعت بعدين.');
  }
}

export async function GET(req: Request) {
  try {
    const { user, companyId } = await requireCompanyTenant();
    if (!can(user, 'confirmation.work')) return NextResponse.json({ reading: null });
    const orderId = new URL(req.url).searchParams.get('orderId') ?? '';
    if (!isLinkOrderId(orderId)) return NextResponse.json({ reading: null });
    const row = await db.callHelperReading.findFirst({
      where: { companyId, userId: user.id, orderId, receivedAt: { gte: new Date(Date.now() - FRESH_MS) } },
      orderBy: { startedAt: 'desc' },
      select: { startedAt: true, answered: true, talkSeconds: true, ringSeconds: true },
    });
    return NextResponse.json({
      reading: row
        ? { startedAt: row.startedAt.getTime(), answered: row.answered, talkSeconds: row.talkSeconds, ringSeconds: row.ringSeconds }
        : null,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
