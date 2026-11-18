/**
 * POST /api/landing-chats/[id]/messages — a staff reply in a landing chat thread. The first one pauses the bot for the
 * thread until «رجّع للبوت». Zaki pages picks it up within seconds and shows it in the customer's chat window under
 * «فريق الدعم». `whatsapp.send`, the conversations' own permission to answer. The text is never logged.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requirePermission, tenantOf } from '@/lib/auth';
import { apiErrorResponse } from '@/lib/api-error';
import { replyAsStaff } from '@/lib/inbox/landing-threads';

const bodySchema = z.object({ text: z.string().trim().min(1).max(2000) }).strict();

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requirePermission('whatsapp.send');
    const { companyId } = await tenantOf(user);
    const { id } = await params;
    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'الرسالة غير صالحة' }, { status: 400 });
    const r = await replyAsStaff(companyId, user, id, parsed.data.text);
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
    return NextResponse.json({ message: r.message, botPaused: r.botPaused }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
