/**
 * POST /api/whatsapp/conversations/[id]/bot — «رجّع البوت» / «أوقف البوت» in one conversation.
 *
 * Whoever may answer the conversation (`whatsapp.send`, inside the conversations their `whatsapp.view` reaches) may hand it
 * back to the order bot or stop it there. Giving it back also clears the «needs staff» flag. Audited either way
 * (`WHATSAPP_BOT_RESUMED` / `WHATSAPP_BOT_PAUSED`). The same state twice writes nothing.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requirePermission, tenantOf } from '@/lib/auth';
import { apiErrorResponse } from '@/lib/api-error';
import { inboxScopeWhere } from '@/lib/whatsapp/inbox-scope';
import { PAUSE_REASON, conversationBotView, pauseBot, resumeBot } from '@/lib/whatsapp/bot/state';

const bodySchema = z.object({ action: z.enum(['pause', 'resume']) });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requirePermission('whatsapp.send');
    const { companyId } = await tenantOf(user);
    const { id } = await params;
    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'طلب غير صالح' }, { status: 400 });

    const mine = inboxScopeWhere(user);
    const conv = await db.whatsAppConversation.findFirst({ where: { id, companyId, ...(mine ? { AND: [mine] } : {}) }, select: { id: true } });
    if (!conv) return NextResponse.json({ error: 'المحادثة غير موجودة' }, { status: 404 });

    if (parsed.data.action === 'resume') await resumeBot(conv.id, user.id);
    else await pauseBot(conv.id, PAUSE_REASON.STAFF_PAUSED, { userId: user.id });

    const after = await db.whatsAppConversation.findUnique({
      where: { id: conv.id },
      select: { botPaused: true, botPausedReason: true, botHandoff: true, botBusyUntil: true },
    });
    return NextResponse.json({ ok: true, bot: conversationBotView(after ?? {}) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
