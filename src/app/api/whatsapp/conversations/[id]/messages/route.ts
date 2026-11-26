/**
 * POST /api/whatsapp/conversations/[id]/messages — send a text message via
 * the official Meta Cloud API. All credentials and Meta calls are server-side;
 * the client can only supply the text. Rate limited + RBAC + tenant scoped.
 * Outside Meta's 24-hour window the answer is 409 `WINDOW_CLOSED` (a template is needed).
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { sendOutboundMessage } from '@/lib/whatsapp/send';
import { viewOf } from '@/lib/whatsapp/message-view';
import { apiErrorResponse } from '@/lib/api-error';

const bodySchema = z.object({ text: z.string().trim().min(1).max(4096) }).strict();

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const parsed = bodySchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: 'الرسالة غير صالحة' }, { status: 400 });
    }
    const result = await sendOutboundMessage(id, parsed.data.text);
    if (!result.ok) {
      return NextResponse.json({ error: result.error, ...(result.code ? { code: result.code } : {}) }, { status: result.status });
    }
    return NextResponse.json({ message: viewOf(result.message) }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
