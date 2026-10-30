/**
 * POST /api/whatsapp/conversations/[id]/read — mark the conversation as read
 * (resets unreadCount) and best-effort mark the latest inbound message as
 * read on Meta. whatsapp.view permission (read marking is part of viewing).
 */
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireCompanyTenant, requirePermission } from '@/lib/auth';
import { getAccessToken, getPhoneNumberId } from '@/lib/whatsapp/config';
import { markMessageRead } from '@/lib/whatsapp/cloud-api';
import { apiErrorResponse } from '@/lib/api-error';
import { inboxScopeWhere } from '@/lib/whatsapp/inbox-scope';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const viewer = await requirePermission('whatsapp.view');
    const { companyId } = await requireCompanyTenant();
    const { id } = await params;

    const mine = inboxScopeWhere(viewer);
    const conv = await db.whatsAppConversation.findFirst({ where: { id, companyId, ...(mine ? { AND: [mine] } : {}) } });
    if (!conv) return NextResponse.json({ error: 'المحادثة غير موجودة' }, { status: 404 });

    await db.whatsAppConversation.update({ where: { id }, data: { unreadCount: 0 } });

    // Best-effort Meta read receipt (never fails the request)
    try {
      const token = getAccessToken();
      const phoneNumberId = getPhoneNumberId();
      const lastInbound = await db.whatsAppMessage.findFirst({
        where: { conversationId: id, direction: 'INBOUND' },
        orderBy: { createdAt: 'desc' },
      });
      if (token && phoneNumberId && lastInbound && conv.lastMessageAt) {
        await markMessageRead({ phoneNumberId, token, messageId: lastInbound.externalMessageId });
      }
    } catch {
      /* ignore */
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
