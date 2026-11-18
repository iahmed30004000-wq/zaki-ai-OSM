/**
 * POST /api/landing-chats/[id]/read — the thread was read: its unread count back to zero, and the reader's notices of
 * «رسائل اللاندينج» read with it. `whatsapp.view` (reading is part of viewing).
 */
import { NextResponse } from 'next/server';
import { requirePermission, tenantOf } from '@/lib/auth';
import { apiErrorResponse } from '@/lib/api-error';
import { markLandingThreadRead } from '@/lib/inbox/landing-threads';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requirePermission('whatsapp.view');
    const { companyId } = await tenantOf(user);
    const { id } = await params;
    const ok = await markLandingThreadRead(companyId, user.id, id);
    if (!ok) return NextResponse.json({ error: 'المحادثة غير موجودة' }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
