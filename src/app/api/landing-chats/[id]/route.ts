/**
 * GET /api/landing-chats/[id]?after=<seq> — one landing chat thread and its lines (all, or those after `after` for the
 * open thread's poll). `whatsapp.view`. 404 when it is not this company's.
 */
import { NextResponse } from 'next/server';
import { requirePermission, tenantOf } from '@/lib/auth';
import { apiErrorResponse } from '@/lib/api-error';
import { readLandingThread } from '@/lib/inbox/landing-threads';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requirePermission('whatsapp.view');
    const { companyId } = await tenantOf(user);
    const { id } = await params;
    const after = new URL(req.url).searchParams.get('after') || undefined;
    const found = await readLandingThread(companyId, id, after);
    if (!found) return NextResponse.json({ error: 'المحادثة غير موجودة' }, { status: 404 });
    return NextResponse.json(found, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
