/**
 * POST /api/whatsapp/conversations/[id]/reactions — `{ messageId, emoji }`: one emoji on a message of this conversation
 * (an empty emoji takes ours away). The message is named by OUR id; Meta's id never comes from the browser.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { sendOutboundReaction } from '@/lib/whatsapp/send';
import { viewOf } from '@/lib/whatsapp/message-view';
import { apiErrorResponse } from '@/lib/api-error';

const bodySchema = z.object({ messageId: z.string().min(1).max(64), emoji: z.string().max(16) }).strict();

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'تفاعل غير صالح' }, { status: 400 });
    }
    const result = await sendOutboundReaction(id, parsed.data.messageId, parsed.data.emoji);
    if (!result.ok) {
      return NextResponse.json({ error: result.error, ...(result.code ? { code: result.code } : {}) }, { status: result.status });
    }
    return NextResponse.json({ message: viewOf(result.message) }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
