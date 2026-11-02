/**
 * PATCH  /api/telegram/sources/[id] — enable/disable / edit (tenant-checked).
 * DELETE /api/telegram/sources/[id] — remove a mapping (tenant-checked).
 * Both on telegram.connect: unbinding or switching off a group stops its orders arriving (T-09).
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireCompanyTenant } from '@/lib/auth';
import { requirePermission } from '@/lib/authorization';
import { logAudit } from '@/lib/audit';
import { apiErrorResponse } from '@/lib/api-error';

const patchSchema = z
  .object({
    isActive: z.boolean().optional(),
    chatTitle: z.string().trim().max(120).optional().nullable(),
    topicName: z.string().trim().max(120).optional().nullable(),
  })
  .strict();

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId } = await requireCompanyTenant();
    await requirePermission('telegram.connect');

    const source = await db.telegramSource.findUnique({ where: { id } });
    if (!source || source.companyId !== companyId) {
      return NextResponse.json({ error: 'غير موجود' }, { status: 404 });
    }

    const parsed = patchSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'بيانات غير صالحة' }, { status: 400 });
    }

    const updated = await db.telegramSource.update({
      where: { id },
      data: {
        ...(parsed.data.isActive !== undefined ? { isActive: parsed.data.isActive } : {}),
        ...(parsed.data.chatTitle !== undefined ? { chatTitle: parsed.data.chatTitle } : {}),
        ...(parsed.data.topicName !== undefined ? { topicName: parsed.data.topicName } : {}),
      },
    });

    await logAudit({
      companyId,
      userId: user.id,
      action: parsed.data.isActive !== undefined && !parsed.data.isActive ? 'TELEGRAM_SOURCE_DISABLED' : 'TELEGRAM_SOURCE_UPDATED',
      entity: 'TelegramSource',
      entityId: id,
      newData: parsed.data,
    });

    return NextResponse.json({ success: true, source: updated });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId } = await requireCompanyTenant();
    await requirePermission('telegram.connect');

    const source = await db.telegramSource.findUnique({ where: { id } });
    if (!source || source.companyId !== companyId) {
      return NextResponse.json({ error: 'غير موجود' }, { status: 404 });
    }

    await db.telegramSource.delete({ where: { id } });
    await logAudit({
      companyId,
      userId: user.id,
      action: 'TELEGRAM_SOURCE_DELETED',
      entity: 'TelegramSource',
      entityId: id,
      previousData: { chatId: source.chatId, topicId: source.topicId },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
