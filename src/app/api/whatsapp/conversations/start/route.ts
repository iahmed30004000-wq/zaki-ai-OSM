/**
 * POST /api/whatsapp/conversations/start { phone, name? } — «محادثة جديدة» in the OMS WhatsApp inbox, and «واتساب OMS» on a
 * customer's number (the owner, 27/11): «اقدر ادخل اي رقم يدوي واتواصل معه كجهة اتصال».
 *
 * Finds — or opens — the inbox conversation with that number on the company's connected number and answers its id; the inbox
 * opens on it. The number is read the way a person types it: with + or 00 it is international; a local number takes the
 * store's calling code (`waNumber`, the rule every WhatsApp button here uses). The thread is keyed exactly as an inbound
 * message keys it (full international digits), so a number that already wrote to us is the SAME conversation. A customer of
 * this company with that number is linked to it, so the inbox shows his orders.
 *
 * Nothing is sent. A first message to a number that has not written in the last 24 hours must be the company's approved
 * template — the inbox says so and offers it (`/api/whatsapp/conversations/[id]/template`).
 *
 * Who: whoever may send from the company number (`whatsapp.send`).
 */
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { canonicalPhone, phoneKeys, ruleFor } from '@/lib/phone-rules';
import { chatNumber } from '@/lib/whatsapp/chat-number';
import { effectiveStatus, getActiveConnection } from '@/lib/whatsapp/connection';

const refuse = (status: number, error: string, code: string) => NextResponse.json({ error, errorAr: error, code }, { status });

export async function POST(req: Request) {
  try {
    await requirePermission('whatsapp.send');
    const { companyId, country } = await requireContext();

    const body = (await req.json().catch(() => null)) as { phone?: unknown; name?: unknown } | null;
    const phone = body && typeof body.phone === 'string' ? body.phone.trim().slice(0, 30) : '';
    const name = body && typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
    if (!phone || Object.keys(body ?? {}).some((k) => k !== 'phone' && k !== 'name')) return refuse(400, 'اكتب الرقم.', 'INVALID_BODY');

    const to = chatNumber(phone, ruleFor(country.code)?.dialCode ?? null);
    if (!to) return refuse(400, 'الرقم مش صالح — اكتبه مع رمز البلد، مثل +963 9xx xxx xxx.', 'INVALID_PHONE');

    const conn = await getActiveConnection(companyId);
    if (!conn || (await effectiveStatus(conn)) !== 'CONNECTED') return refuse(409, 'واتساب الـOMS مش موصول لهلأ.', 'NOT_CONNECTED');

    // A customer of this company with this number, in any of the forms it may be stored in.
    const keys = [...new Set([...phoneKeys(canonicalPhone(`+${to}`)), to])];
    const customer = await db.customer.findFirst({
      where: { companyId, phone: { in: keys } },
      orderBy: { lastOrderDate: 'desc' },
      select: { id: true, fullName: true },
    });

    const conv = await db.whatsAppConversation.upsert({
      where: { companyId_connectionId_customerPhone: { companyId, connectionId: conn.id, customerPhone: to } },
      create: {
        companyId,
        connectionId: conn.id,
        customerId: customer?.id ?? null,
        customerPhone: to,
        customerName: name || customer?.fullName || null,
        status: 'OPEN',
      },
      // An existing thread opens again; a name typed now names it.
      update: { status: 'OPEN', ...(name ? { customerName: name } : {}) },
      select: { id: true },
    });
    return NextResponse.json({ id: conv.id });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
