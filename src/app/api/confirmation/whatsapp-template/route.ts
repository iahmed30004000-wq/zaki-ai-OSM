import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { apiErrorResponse } from '@/lib/api-error';
import { can } from '@/lib/authorization';
import { logAudit } from '@/lib/audit';
import { peekRateLimit, rateLimit } from '@/lib/rate-limit';
import { ORDER_ACCESS_STATUS, assertOrderAccess } from '@/lib/rbac';
import { ORDER_WORK_DOOR } from '@/lib/order-work-door';
import { ORDER_NOT_FOUND } from '@/lib/order-refusals';
import { mustHoldToWork, NOT_HELD_MESSAGE } from '@/lib/confirmation-queue';
import { ruleFor } from '@/lib/phone-rules';
import { waNumber } from '@/lib/message-templates';
import { getAccessToken, getPhoneNumberId } from '@/lib/whatsapp/config';
import { effectiveStatus, getActiveConnection } from '@/lib/whatsapp/connection';
import { sendTemplateMessage } from '@/lib/whatsapp/cloud-api';
import { afterNoAnswer, routeFor, templateBodyValues } from '@/lib/whatsapp/after-no-answer';

/**
 * POST /api/confirmation/whatsapp-template — «ابعت من رقم الشركة» on the call sheet, after a call nobody answered.
 *
 * Body `{ orderId }` and nothing else: the number, the template, the words in it and the company's credentials are all the
 * server's. The token never leaves this process.
 *
 * ── EVERY REFUSAL SAYS «USE YOUR OWN WHATSAPP» ──
 *
 * A refusal answers `{ fallback: true, error }`: the country is on the agent's WhatsApp, the number is not connected, no
 * template is named, the customer's number has no country, Meta said no. The sheet then shows the reason in one line and the
 * agent's own WhatsApp button under it, so a press never ends in nothing.
 *
 * ── WHAT IT TOUCHES ──
 *
 * A message on the WhatsApp conversation for that number (found or opened on the active connection, keyed the way inbound
 * keys it), and one line in the order's contact log: WHATSAPP · MESSAGE_SENT — the line the agent's own WhatsApp button
 * writes. It is not an outcome: it is not a no-answer, the 1/2/3 close does not read it, and the order's state, owner and
 * dates are not written here at all.
 */

const refuse = (status: number, error: string, code: string) =>
  NextResponse.json({ fallback: true, error, errorAr: error, code }, { status });

/** One person's sends in a minute — the inbox's own budget (`send.ts`), shared with it. */
const PERSON_LIMIT = 30;
/** A second press on the same order within this is a double press, not a second message. */
const ORDER_WINDOW_MS = 60 * 1000;

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId, country } = await requireContext();

    if (!can(user, 'whatsapp.send')) {
      return refuse(403, 'ما عندك صلاحية «إرسال رسائل واتساب» من رقم الشركة.', 'WHATSAPP_SEND_NOT_ALLOWED');
    }

    const body = (await req.json().catch(() => null)) as { orderId?: unknown } | null;
    const orderId = body && typeof body.orderId === 'string' ? body.orderId : '';
    if (!orderId || Object.keys(body ?? {}).some((k) => k !== 'orderId')) {
      return NextResponse.json({ error: 'أرسل رقم الطلب فقط.', errorAr: 'أرسل رقم الطلب فقط.', code: 'INVALID_BODY' }, { status: 400 });
    }

    // The order she holds — the door the call sheet's other presses use (contact-attempts, confirmation).
    const access = await assertOrderAccess(orderId, user, { companyId, storeId }, ORDER_WORK_DOOR);
    if (!access.allowed) {
      return NextResponse.json({ error: ORDER_NOT_FOUND, errorAr: ORDER_NOT_FOUND }, { status: ORDER_ACCESS_STATUS[access.reason] });
    }
    const order = access.order;
    if (mustHoldToWork((permission) => can(user, permission)) && order.claimedById !== user.id) {
      return NextResponse.json({ error: NOT_HELD_MESSAGE, errorAr: NOT_HELD_MESSAGE, code: 'NOT_HELD' }, { status: 403 });
    }

    // The order's own country; its calling code is what the owner chose by. An order with none is the store's country.
    const orderCountry = order.countryId
      ? await db.country.findFirst({ where: { id: order.countryId, companyId }, select: { code: true } })
      : null;
    const dialCode = ruleFor(orderCountry?.code ?? country.code)?.dialCode ?? null;

    const setting = await afterNoAnswer(db, companyId);
    if (routeFor(setting, dialCode) !== 'COMPANY') {
      return refuse(409, 'هالدولة مضبوطة على واتساب الموظفة — ابعتي من واتسابك.', 'ROUTE_IS_AGENT');
    }
    if (!setting.templateName) {
      return refuse(409, 'ما في قالب مسمّى بالإعدادات — ابعتي من واتسابك.', 'NO_TEMPLATE');
    }

    const conn = await getActiveConnection(companyId);
    const token = getAccessToken();
    const phoneNumberId = getPhoneNumberId();
    if (!conn || effectiveStatus(conn) !== 'CONNECTED' || !token || !phoneNumberId) {
      return refuse(409, 'رقم الشركة مش موصول لهلأ — ابعتي من واتسابك.', 'NOT_CONNECTED');
    }

    const customer = await db.customer.findFirst({
      where: { id: order.customerId, companyId },
      select: { id: true, fullName: true, rawPhone: true },
    });
    // No digit at all (empty, «—»): there is no number, which is not the same as a number missing its country.
    if (!customer || !/[0-9٠-٩۰-۹]/.test(customer.rawPhone ?? '')) {
      return refuse(400, 'ما في رقم للزبون على هالطلب.', 'NO_PHONE');
    }
    const to = waNumber(customer.rawPhone, dialCode);
    if (!to) {
      return refuse(400, 'رقم الزبون ناقصه رمز الدولة — ابعتي من واتسابك.', 'NO_COUNTRY_CODE');
    }

    const rl = rateLimit(`wa-send:${companyId}:${user.id}`, PERSON_LIMIT, 60 * 1000);
    if (!rl.allowed) {
      return refuse(429, `محاولات إرسال كثيرة. أعيدي المحاولة بعد ${rl.retryAfterSec} ثانية.`, 'RATE_LIMIT');
    }
    // The order's one slot is ASKED here and TAKEN only once Meta said yes: a refused send leaves her free to try again.
    const onceKey = `wa-template:${companyId}:${order.id}`;
    if (peekRateLimit(onceKey, 1).blocked) {
      return refuse(429, 'انبعتت رسالة من رقم الشركة لهالطلب قبل شوي.', 'ALREADY_SENT');
    }

    const res = await sendTemplateMessage({
      phoneNumberId,
      token,
      to,
      templateName: setting.templateName,
      templateLang: setting.templateLang,
      bodyValues: templateBodyValues(setting.templateParams, { customerName: customer.fullName, orderNumber: order.orderNumber }),
    });
    if (!res.ok || !res.wamid) {
      const safe = res.error || 'تعذر إرسال الرسالة';
      await db.whatsAppConnection.update({ where: { id: conn.id }, data: { lastError: safe } }).catch(() => {});
      return refuse(res.code === 'RATE_LIMIT' ? 429 : 502, `${safe} — ابعتي من واتسابك.`, 'META_REFUSED');
    }

    rateLimit(onceKey, 1, ORDER_WINDOW_MS);

    /*
     * THE MESSAGE HAS LEFT. What follows is the record of it, and a failure here must not read as «not sent»: the agent would
     * send it again from her own WhatsApp and the customer would get two. So it is answered `ok`, and says what was not kept.
     */
    const text = `قالب «${setting.templateName}»`;
    let messageId: string | null = null;
    try {
      const conv = await db.whatsAppConversation.upsert({
        where: { companyId_connectionId_customerPhone: { companyId, connectionId: conn.id, customerPhone: to } },
        create: {
          companyId,
          connectionId: conn.id,
          customerId: customer.id,
          customerPhone: to,
          customerName: customer.fullName,
          status: 'OPEN',
        },
        update: {},
      });
      const message = await db.whatsAppMessage.create({
        data: {
          companyId,
          conversationId: conv.id,
          connectionId: conn.id,
          externalMessageId: res.wamid,
          direction: 'OUTBOUND',
          messageType: 'TEMPLATE',
          text,
          status: 'SENT',
          senderPhone: null,
          recipientPhone: to,
        },
      });
      messageId = message.id;
      const now = new Date();
      await db.whatsAppConversation.update({ where: { id: conv.id }, data: { lastMessageAt: now, lastMessagePreview: text.slice(0, 120) } });
      await db.whatsAppConnection.update({ where: { id: conn.id }, data: { lastMessageAt: now, lastError: null } });
    } catch (e) {
      console.error('[whatsapp] template sent but not stored:', (e as Error)?.message ?? '');
    }

    const logged = await noteContact({ companyId, orderId: order.id, user, templateName: setting.templateName });

    logAudit({
      companyId,
      userId: user.id,
      action: 'whatsapp.template.send',
      entity: 'Order',
      entityId: order.id,
      newData: { templateName: setting.templateName, dialCode, messageId },
    }).catch(() => {});

    return NextResponse.json({ ok: true, logged });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/**
 * ONE LINE IN THE ORDER'S CONTACT LOG — WHATSAPP · MESSAGE_SENT, the line `ContactButtons` asks the contact-attempts door
 * for when the agent sends from her own WhatsApp, under that door's permission (`orders.contact_log`, and the edit or the
 * claim key). Not an outcome: nothing here counts a no-answer or closes anything. A role without the key sends and is told
 * the line is missing (`logged: false`), as the button tells her.
 */
async function noteContact(args: {
  companyId: string;
  orderId: string;
  user: Parameters<typeof can>[0];
  templateName: string;
}): Promise<boolean> {
  const { user } = args;
  if (!can(user, 'orders.contact_log') || (!can(user, 'orders.edit') && !can(user, 'orders.claim'))) return false;
  for (let tries = 0; tries < 2; tries++) {
    try {
      const last = await db.orderContactAttempt.findFirst({
        where: { orderId: args.orderId },
        orderBy: { attemptNumber: 'desc' },
        select: { attemptNumber: true },
      });
      await db.orderContactAttempt.create({
        data: {
          companyId: args.companyId,
          orderId: args.orderId,
          employeeId: user.id,
          employeeRole: user.role,
          attemptNumber: (last?.attemptNumber ?? 0) + 1,
          contactMethod: 'WHATSAPP',
          result: 'MESSAGE_SENT',
          note: `من رقم الشركة — قالب «${args.templateName}»`,
        },
      });
      return true;
    } catch (e) {
      // unique(orderId, attemptNumber): a colleague's line landed in the same instant — read the number again, once.
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) return false;
    }
  }
  return false;
}
