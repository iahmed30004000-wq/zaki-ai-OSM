/**
 * POST /api/landing-chats/[id]/bot — `{ paused: false }` is «رجّع للبوت»: the assistant answers this thread again.
 * `{ paused: true }` pauses it without a reply. The same state twice changes nothing. `whatsapp.send`.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requirePermission, tenantOf } from '@/lib/auth';
import { apiErrorResponse } from '@/lib/api-error';
import { setLandingBotPaused } from '@/lib/inbox/landing-threads';

const bodySchema = z.object({ paused: z.boolean() }).strict();

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requirePermission('whatsapp.send');
    const { companyId } = await tenantOf(user);
    const { id } = await params;
    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'الطلب غير صالح' }, { status: 400 });
    const r = await setLandingBotPaused(companyId, user, id, parsed.data.paused);
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
    return NextResponse.json({ botPaused: r.botPaused, changed: r.changed });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
