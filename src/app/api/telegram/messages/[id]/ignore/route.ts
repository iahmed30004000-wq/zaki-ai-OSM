/**
 * POST /api/telegram/messages/[id]/ignore — «تجاهل»: a person says this message is not an order.
 *
 * Nothing wrote IGNORED by hand before: a greeting the reader did not recognise, or a message posted by mistake, sat in
 * «للمراجعة» for ever, between the messages somebody actually has to fix.
 *
 *   · the same store scope and the same permission as «إعادة المعالجة» (telegram.manage);
 *   · only a message with NO order, and only from NEEDS_REVIEW, FAILED or PENDING — the write itself says so, so a
 *     message that became an order a moment ago is not touched;
 *   · it writes the status and the time and nothing else: never an order, never a customer;
 *   · and it can be undone — «إعادة المعالجة» accepts an IGNORED message and reads it again.
 */
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { telegramStoreWhere } from '@/lib/telegram/store-scope';
import { logAudit } from '@/lib/audit';
import { apiErrorResponse } from '@/lib/api-error';

const IGNORABLE = ['NEEDS_REVIEW', 'FAILED', 'PENDING'];

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('telegram.manage');

    // A message of this store's sources (or of no store — the manager's to place), as the retry door reads it.
    const message = await db.telegramMessage.findFirst({
      where: { id, companyId, ...telegramStoreWhere(storeId, true) },
      select: { id: true, processingStatus: true, orderId: true },
    });
    if (!message) {
      return NextResponse.json({ error: 'الرسالة مش موجودة' }, { status: 404 });
    }
    if (message.processingStatus === 'IGNORED') {
      return NextResponse.json({ success: true, status: 'IGNORED' });
    }
    if (message.orderId || !IGNORABLE.includes(message.processingStatus)) {
      return NextResponse.json({ error: 'صار منها طلب — ما بتنتجاهل' }, { status: 409 });
    }

    const written = await db.telegramMessage.updateMany({
      where: { id: message.id, companyId, orderId: null, processingStatus: { in: IGNORABLE } },
      data: { processingStatus: 'IGNORED', processedAt: new Date() },
    });
    if (written.count !== 1) {
      return NextResponse.json({ error: 'الرسالة تغيّرت هلّق — حدّث الصفحة' }, { status: 409 });
    }

    await logAudit({
      companyId,
      userId: user.id,
      action: 'TELEGRAM_MESSAGE_IGNORED',
      entity: 'TelegramMessage',
      entityId: message.id,
      previousData: { processingStatus: message.processingStatus },
      newData: { processingStatus: 'IGNORED' },
    });

    return NextResponse.json({ success: true, status: 'IGNORED' });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
