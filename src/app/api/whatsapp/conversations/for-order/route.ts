/**
 * POST /api/whatsapp/conversations/for-order { orderId } — «واتساب OMS» on an order's WhatsApp button (the owner, 27/11): «لما تضغط
 * على واتساب الـOMS يحولها للواتساب اللي داخل النظام».
 *
 * Finds — or opens — the inbox conversation with this order's customer on the company's connected number, and answers its id, so
 * the screen opens the inbox on it (`/growth/whatsapp/inbox?c=<id>`). The thread is keyed the way an inbound message keys it
 * (the number in full international digits, `waNumber`), so the customer's earlier messages and this one are ONE conversation.
 *
 * Nothing is sent here. Writing happens in the inbox under its own rules: inside the 24-hour window a free message, outside it
 * the company's approved template (`/api/whatsapp/conversations/[id]/template`).
 *
 * Who: whoever may open the inbox (`whatsapp.view`) AND may see this order (`assertOrderAccess`, the orders' own scope).
 */
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { ORDER_ACCESS_STATUS, assertOrderAccess } from '@/lib/rbac';
import { ORDER_NOT_FOUND } from '@/lib/order-refusals';
import { ruleFor } from '@/lib/phone-rules';
import { waNumber } from '@/lib/message-templates';
import { effectiveStatus, getActiveConnection } from '@/lib/whatsapp/connection';

const refuse = (status: number, error: string, code: string) => NextResponse.json({ error, errorAr: error, code }, { status });

export async function POST(req: Request) {
  try {
    await requirePermission('whatsapp.view');
    const { user, companyId, storeId, country } = await requireContext();

    const body = (await req.json().catch(() => null)) as { orderId?: unknown } | null;
    const orderId = body && typeof body.orderId === 'string' ? body.orderId : '';
    if (!orderId || Object.keys(body ?? {}).some((k) => k !== 'orderId')) return refuse(400, 'أرسل رقم الطلب فقط.', 'INVALID_BODY');

    const access = await assertOrderAccess(orderId, user, { companyId, storeId });
    if (!access.allowed) return NextResponse.json({ error: ORDER_NOT_FOUND, errorAr: ORDER_NOT_FOUND }, { status: ORDER_ACCESS_STATUS[access.reason] });
    const order = access.order as { id: string; customerId: string; countryId: string | null };

    const conn = await getActiveConnection(companyId);
    if (!conn || (await effectiveStatus(conn)) !== 'CONNECTED') {
      return refuse(409, 'واتساب الـOMS مش موصول لهلأ — استعملي واتسابك الخارجي.', 'NOT_CONNECTED');
    }

    const customer = await db.customer.findFirst({ where: { id: order.customerId, companyId }, select: { id: true, fullName: true, rawPhone: true } });
    if (!customer || !/[0-9٠-٩۰-۹]/.test(customer.rawPhone ?? '')) return refuse(400, 'ما في رقم للزبون على هالطلب.', 'NO_PHONE');

    // The order's own country decides the calling code; an order with none is the store's.
    const orderCountry = order.countryId ? await db.country.findFirst({ where: { id: order.countryId, companyId }, select: { code: true } }) : null;
    const to = waNumber(customer.rawPhone, ruleFor(orderCountry?.code ?? country.code)?.dialCode ?? null);
    if (!to) return refuse(400, 'رقم الزبون ناقصه رمز الدولة — استعملي واتسابك الخارجي.', 'NO_COUNTRY_CODE');

    const conv = await db.whatsAppConversation.upsert({
      where: { companyId_connectionId_customerPhone: { companyId, connectionId: conn.id, customerPhone: to } },
      create: { companyId, connectionId: conn.id, customerId: customer.id, customerPhone: to, customerName: customer.fullName, status: 'OPEN' },
      // A conversation closed earlier opens again: she is about to write in it.
      update: { status: 'OPEN' },
      select: { id: true },
    });
    return NextResponse.json({ id: conv.id });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
