/**
 * GET  /api/telegram/sources — list sources for the caller's company.
 * POST /api/telegram/sources — create a mapping (companyId from session only). telegram.connect:
 *   which group feeds which store is the connection, not the day's message work (T-09).
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireCompanyTenant } from '@/lib/auth';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { logAudit } from '@/lib/audit';
import { apiErrorResponse } from '@/lib/api-error';
import { zodMessage } from '@/lib/zod-message';

export async function GET() {
  try {
    const { companyId } = await requireCompanyTenant();
    await requirePermission('telegram.view');

    const sources = await db.telegramSource.findMany({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { messages: { where: { processingStatus: 'PROCESSED' } } } },
        // Each chat feeds ONE store; the list spans the company, so it says which.
        store: { select: { name: true } },
      },
    });

    const lastMessages = await db.telegramMessage.findMany({
      where: { companyId, sourceId: { in: sources.map((s) => s.id) } },
      orderBy: { createdAt: 'desc' },
      select: { sourceId: true, createdAt: true },
    });
    const lastBySource = new Map<string, Date>();
    for (const m of lastMessages) {
      if (m.sourceId && !lastBySource.has(m.sourceId)) lastBySource.set(m.sourceId, m.createdAt);
    }

    return NextResponse.json({
      sources: sources.map((s) => ({
        id: s.id,
        chatId: s.chatId,
        chatType: s.chatType,
        chatTitle: s.chatTitle,
        topicId: s.topicId,
        topicName: s.topicName,
        isActive: s.isActive,
        ordersCount: s._count.messages,
        lastMessageAt: lastBySource.get(s.id) ?? s.lastMessageAt,
        storeName: s.store?.name ?? null,
        createdAt: s.createdAt,
      })),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

const createSchema = z.object({
  chatId: z
    .string()
    .trim()
    .regex(/^-?\d{5,25}$/, 'Chat ID غير صالح (يجب أن يكون رقمًا مثل ‎-1001234567890)'),
  chatType: z.enum(['group', 'supergroup', 'channel']).default('supergroup'),
  chatTitle: z.string().trim().max(120).optional().nullable(),
  topicId: z.number().int().min(1).max(2147483647).optional().nullable(),
  topicName: z.string().trim().max(120).optional().nullable(),
  isActive: z.boolean().default(true),
});

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('telegram.connect');

    const body = await req.json().catch(() => null);
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: zodMessage(parsed.error) },
        { status: 400 }
      );
    }
    const { chatId, chatType, chatTitle, topicId, topicName, isActive } = parsed.data;

    // Defensive: the same chat must never be bound to more than one company
    // at the same mapping level (partial unique indexes also enforce in DB).
    const clash = await db.telegramSource.findFirst({
      where: { chatId, topicId: topicId ?? null, NOT: { companyId } },
    });
    if (clash) {
      return NextResponse.json({ error: 'هذه المجموعة مرتبطة بشركة أخرى' }, { status: 409 });
    }

    try {
      const source = await db.telegramSource.create({
        data: {
          companyId, // server-side tenant — never client input
          storeId, // orders from this chat land in the selected store
          chatId,
          chatType,
          chatTitle: chatTitle ?? null,
          topicId: topicId ?? null,
          topicName: topicName ?? null,
          isActive,
        },
      });
      await logAudit({
        companyId,
        userId: user.id,
        action: 'TELEGRAM_SOURCE_CREATED',
        entity: 'TelegramSource',
        entityId: source.id,
        newData: { chatId, topicId: topicId ?? null, isActive },
      });
      return NextResponse.json({ success: true, source }, { status: 201 });
    } catch (e: any) {
      if (e?.code === 'P2002') {
        return NextResponse.json({ error: 'هذه المجموعة/Topic مرتبطة مسبقًا' }, { status: 409 });
      }
      throw e;
    }
  } catch (error) {
    return apiErrorResponse(error);
  }
}
