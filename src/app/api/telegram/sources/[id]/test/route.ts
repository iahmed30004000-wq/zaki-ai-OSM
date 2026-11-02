/**
 * POST /api/telegram/sources/[id]/test — verifies the mapping is reachable
 * and reports the latest stored message for this source (no external call).
 * telegram.connect: a diagnostic of the binding, drawn only on the connection card (T-09).
 */
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireCompanyTenant } from '@/lib/auth';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { companyId } = await requireCompanyTenant();
    await requirePermission('telegram.connect');

    const source = await db.telegramSource.findUnique({ where: { id } });
    if (!source || source.companyId !== companyId) {
      return NextResponse.json({ error: 'غير موجود' }, { status: 404 });
    }

    const lastMessage = await db.telegramMessage.findFirst({
      where: { companyId, chatId: source.chatId, ...(source.topicId ? { threadId: source.topicId } : {}) },
      orderBy: { createdAt: 'desc' },
      select: { id: true, createdAt: true, processingStatus: true },
    });

    return NextResponse.json({
      ok: true,
      isActive: source.isActive,
      lastMessage,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
