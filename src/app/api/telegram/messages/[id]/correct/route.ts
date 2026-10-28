/**
 * POST /api/telegram/messages/[id]/correct — «تعديل وترحيل»: a person fixes a held message by hand and pushes it on.
 *
 * The owner, 29/10: «اريد يكون في خيار تعديل على الطلبات اللي بخانة المراجعة … تعديل يدوي وترحيل لخانة صارت طلبات».
 *
 * The eight fields come from a form; they are written back as a message in his nine-label format (`labeledText`) and
 * that message is read by the SAME door as one that arrived (`processStoredMessage`): the offer is matched, the price is
 * checked against it, the duplicate and the blacklist are asked, the order is made by the one calculator. A correction
 * is therefore not a way around any rule — it is a way to change the text a rule is applied to. If the corrected message
 * still fails a rule, it stays in «للمراجعة» with the NEW reason, and the form says it.
 *
 *   · the same store scope and the same permission as «إعادة المعالجة» (telegram.manage);
 *   · only a message with NO order and not already PROCESSED — the write itself says so, so a message that became an
 *     order a moment ago is not touched;
 *   · every field needs a value: a blank one is refused here, naming the field, before anything is written;
 *   · the old and the new values are in the audit trail (the address redacted, as for every customer snapshot).
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { telegramStoreWhere } from '@/lib/telegram/store-scope';
import { LABEL_OF, LABELED_FIELDS, labeledText, readMessageColumns, type LabeledFields } from '@/lib/telegram/labeled-order';
import { processStoredMessage } from '@/lib/telegram/inbound';
import { logAudit, redactCustomerForAudit } from '@/lib/audit';
import { apiErrorResponse } from '@/lib/api-error';

const CORRECTABLE = ['NEEDS_REVIEW', 'FAILED', 'PENDING', 'IGNORED'];

/** A value as it will be stored: one line, single spaces. */
const oneLine = (value: string) => value.replace(/\s+/g, ' ').trim();

const Body = z.object(Object.fromEntries(LABELED_FIELDS.map((f) => [f, z.string().max(1000)])) as Record<(typeof LABELED_FIELDS)[number], z.ZodString>);

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('telegram.manage');

    const message = await db.telegramMessage.findFirst({
      where: { id, companyId, ...telegramStoreWhere(storeId, true) },
      select: { id: true, text: true, processingStatus: true, orderId: true },
    });
    if (!message) return NextResponse.json({ error: 'الرسالة مش موجودة' }, { status: 404 });
    if (message.orderId || !CORRECTABLE.includes(message.processingStatus)) {
      return NextResponse.json({ error: 'صار منها طلب — ما بتنعدّل' }, { status: 409 });
    }

    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'البيانات ناقصة أو مش مفهومة' }, { status: 400 });
    const fields = Object.fromEntries(LABELED_FIELDS.map((f) => [f, oneLine(parsed.data[f])])) as LabeledFields;
    const blank = LABELED_FIELDS.find((f) => !fields[f]);
    if (blank) return NextResponse.json({ error: `ناقص: ${LABEL_OF[blank]}`, field: blank }, { status: 400 });

    const text = labeledText(fields);
    const written = await db.telegramMessage.updateMany({
      where: { id: message.id, companyId, orderId: null, processingStatus: { in: CORRECTABLE } },
      data: { text },
    });
    if (written.count !== 1) {
      return NextResponse.json({ error: 'الرسالة تغيّرت هلّق — حدّث الصفحة' }, { status: 409 });
    }

    await logAudit({
      companyId,
      userId: user.id,
      action: 'TELEGRAM_MESSAGE_CORRECTED',
      entity: 'TelegramMessage',
      entityId: message.id,
      previousData: redactCustomerForAudit({ ...readMessageColumns(message.text ?? '') }),
      newData: redactCustomerForAudit({ ...fields }),
    });

    // The door that reads every message reads this one: the order, or the reason it still waits.
    const result = await processStoredMessage(message.id);
    return NextResponse.json({ success: result.status === 'PROCESSED', ...result });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
