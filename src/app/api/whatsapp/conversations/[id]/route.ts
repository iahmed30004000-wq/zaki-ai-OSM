/**
 * GET  /api/whatsapp/conversations/[id] — full conversation: messages,
 * linked customer, recent orders. Tenant-scoped (id + companyId).
 * PATCH — open/close the conversation (whatsapp.send can toggle status).
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireCompanyTenant, requirePermission, tenantOf } from '@/lib/auth';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // ONE read of who is asking — this is the open thread's poll (RV182/RV183). The user comes back from
    // `requirePermission`; asking `requireCompanyTenant` as well re-read the user, role and grants a second time.
    const { companyId } = await tenantOf(await requirePermission('whatsapp.view'));
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const after = searchParams.get('after')?.trim() || ''; // incremental fetch

    const conv = await db.whatsAppConversation.findFirst({
      where: { id, companyId },
      include: {
        assignedTo: { select: { id: true, name: true } },
        customer: { select: { id: true, fullName: true, phone: true, rawPhone: true, city: true } },
      },
    });
    if (!conv) {
      return NextResponse.json({ error: 'المحادثة غير موجودة' }, { status: 404 });
    }

    const take = 200;
    const messages = await db.whatsAppMessage.findMany({
      where: {
        conversationId: id,
        companyId,
        ...(after ? { createdAt: { gt: new Date(after) } } : {}),
      },
      orderBy: { createdAt: 'asc' },
      take,
    });

    // Customer panel: recent orders (safe subset) when linked
    let recentOrders: any[] = [];
    if (conv.customerId) {
      recentOrders = await db.order.findMany({
        where: { companyId, customerId: conv.customerId },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: {
          id: true,
          orderNumber: true,
          status: true,
          confirmationStatus: true,
          totalAmount: true,
          currency: true,
          createdAt: true,
        },
      });
    }

    return NextResponse.json({
      conversation: {
        id: conv.id,
        customerPhone: conv.customerPhone,
        customerName: conv.customerName,
        status: conv.status,
        unreadCount: conv.unreadCount,
        lastMessageAt: conv.lastMessageAt,
        assignedUserId: conv.assignedUserId,
        assignedTo: conv.assignedTo,
        customerId: conv.customerId,
      },
      customer: conv.customer,
      messages,
      recentOrders,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

const patchSchema = z.object({ status: z.enum(['OPEN', 'CLOSED']) });

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { user, companyId } = await requireCompanyTenant();
    await requirePermission('whatsapp.send');
    const { id } = await params;
    const body = patchSchema.parse(await req.json());

    const conv = await db.whatsAppConversation.findFirst({ where: { id, companyId } });
    if (!conv) return NextResponse.json({ error: 'المحادثة غير موجودة' }, { status: 404 });

    const updated = await db.whatsAppConversation.update({
      where: { id },
      data: { status: body.status },
    });
    logAudit({
      companyId, userId: user.id, action: 'whatsapp.conversation.status', entity: 'WhatsAppConversation',
      entityId: id, previousData: { status: conv.status }, newData: { status: body.status },
    }).catch(() => {});
    return NextResponse.json({ ok: true, status: updated.status });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
