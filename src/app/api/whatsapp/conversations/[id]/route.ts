/**
 * GET  /api/whatsapp/conversations/[id] — full conversation: messages,
 * linked customer, recent orders. Tenant-scoped (id + companyId), and scoped to the
 * conversations the viewer's `whatsapp.view` reaches (ASSIGNED = hers and unassigned).
 * The customer's card needs the customer tier and the recent orders are only the ones the
 * viewer may list (PR-13, WA-2): a chat is not a way round the customers and orders keys.
 * PATCH — open/close the conversation (whatsapp.send can toggle status).
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requirePermission, tenantOf } from '@/lib/auth';
import { can } from '@/lib/authorization';
import { orderListWhere } from '@/lib/rbac';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { inboxScopeWhere } from '@/lib/whatsapp/inbox-scope';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // ONE read of who is asking — this is the open thread's poll (RV182/RV183). The user comes back from
    // `requirePermission`; asking for the tenant as well must not re-read the user, role and grants a second time.
    const viewer = await requirePermission('whatsapp.view');
    const { companyId } = await tenantOf(viewer);
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const after = searchParams.get('after')?.trim() || ''; // incremental fetch

    const mine = inboxScopeWhere(viewer);
    const conv = await db.whatsAppConversation.findFirst({
      where: { id, companyId, ...(mine ? { AND: [mine] } : {}) },
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

    // Customer panel: recent orders (safe subset) when linked — the viewer's own envelope of orders, and the customer tier for the card.
    const mayCustomer = can(viewer, 'customers.view_basic') || can(viewer, 'customers.view');
    let recentOrders: any[] = [];
    if (conv.customerId) {
      recentOrders = await db.order.findMany({
        // AND, not a spread: the envelope may carry its own OR, and a spread beside another key drops one of them.
        where: { companyId, customerId: conv.customerId, AND: [orderListWhere(viewer)] },
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
      customer: mayCustomer ? conv.customer : null,
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

    const mine = inboxScopeWhere(user);
    const conv = await db.whatsAppConversation.findFirst({ where: { id, companyId, ...(mine ? { AND: [mine] } : {}) } });
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
