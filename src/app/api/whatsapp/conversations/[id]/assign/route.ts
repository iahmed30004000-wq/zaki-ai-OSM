/**
 * POST /api/whatsapp/conversations/[id]/assign — assign/reassign/unassign a
 * conversation. whatsapp.assign permission. Target users must belong to the
 * SAME company (tenant-scoped) — cross-company assignment is rejected.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireCompanyTenant, requirePermission } from '@/lib/auth';
import { logAudit } from '@/lib/audit';
import { apiErrorResponse } from '@/lib/api-error';
import { inboxScopeWhere } from '@/lib/whatsapp/inbox-scope';

const bodySchema = z.object({
  userId: z.string().min(1).max(64).nullable(),
}).strict();

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { user, companyId } = await requireCompanyTenant();
    await requirePermission('whatsapp.assign');
    const { id } = await params;
    const body = bodySchema.parse(await req.json());

    const mine = inboxScopeWhere(user);
    const conv = await db.whatsAppConversation.findFirst({ where: { id, companyId, ...(mine ? { AND: [mine] } : {}) } });
    if (!conv) return NextResponse.json({ error: 'المحادثة غير موجودة' }, { status: 404 });

    if (body.userId) {
      const target = await db.user.findFirst({ where: { id: body.userId, companyId } });
      if (!target) {
        // Cross-tenant or unknown user — never leaks existence
        return NextResponse.json({ error: 'الموظف غير موجود' }, { status: 400 });
      }
    }

    const updated = await db.whatsAppConversation.update({
      where: { id },
      data: { assignedUserId: body.userId },
      include: { assignedTo: { select: { id: true, name: true } } },
    });
    logAudit({
      companyId, userId: user.id, action: 'whatsapp.conversation.assign', entity: 'WhatsAppConversation',
      entityId: id, previousData: { assignedUserId: conv.assignedUserId }, newData: { assignedUserId: body.userId },
    }).catch(() => {});
    return NextResponse.json({
      ok: true,
      assignedUserId: updated.assignedUserId,
      assignedTo: updated.assignedTo,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
