/**
 * GET /api/telegram/messages — the «طلبات تلجرام» list, a page at a time.
 * Query: tab (review | orders | ignored — anything else is all), q, page, limit.
 *
 * Answers `{ messages, pagination, facts }`:
 *
 *   · `facts` is the count of each tab, grouped under the SAME store scope and the same search as the list — so a tab
 *     that says 5 shows 5. The old tiles counted the whole company, and «تم الإنشاء» read a key nothing wrote;
 *   · `pagination.total` is the chosen tab's count from that same grouping, so the two cannot disagree;
 *   · each message carries `reading`: the columns of the screen, read from the stored text by the same pure readers the
 *     door uses (`readMessageColumns`) — no column in the database, and nothing the raw text did not already say;
 *   · a message held as DUPLICATE_REF carries `twin`, the order the same reference already made.
 */
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { can, requirePermission } from '@/lib/authorization';
import { telegramStoreWhere } from '@/lib/telegram/store-scope';
import { readLineRoleOrder, readMessageColumns } from '@/lib/telegram/parser';
import { findTwinOrder } from '@/lib/telegram/twin';
import { toLatinDigits } from '@/lib/latin-digits';
import { apiErrorResponse } from '@/lib/api-error';
import { readLimit, readPage } from '@/lib/numeric-input';

/** Which statuses each tab holds. «للمراجعة» is everything a person still has to look at. */
const TABS: Record<string, string[]> = {
  review: ['NEEDS_REVIEW', 'FAILED', 'PENDING'],
  orders: ['PROCESSED'],
  ignored: ['IGNORED'],
};

/** The search: the raw text (in either digit script) and the order made from it. */
function searchWhere(q: string) {
  const latin = toLatinDigits(q);
  const keypad = latin.replace(/[0-9]/g, (d) => String.fromCharCode(0x0660 + Number(d)));
  return {
    OR: [
      ...[...new Set([q, latin, keypad])].map((form) => ({ text: { contains: form, mode: 'insensitive' as const } })),
      { order: { orderNumber: { contains: latin, mode: 'insensitive' as const } } },
    ],
  };
}

export async function GET(req: Request) {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('telegram.view');

    const params = new URL(req.url).searchParams;
    const tab = params.get('tab')?.trim() ?? '';
    const statuses = TABS[tab] ?? null;
    const q = params.get('q')?.trim().slice(0, 100) ?? '';
    /*
     * This spelling caught `NaN` and nothing else: there was no lower clamp,
     * so `?limit=0` was `take: 0` — an empty inbox for a door that had
     * messages — and `?limit=-5` was `take: -5`, which Prisma accepts as
     * «the last five», i.e. the OLDEST five in reverse.
     */
    const limit = readLimit(params, 50, 100);

    // This store's sources only — each source feeds ONE store, and the raw text carries the customer's name, phone and
    // address. The tab is the only thing the counts and the list do not share.
    const where = {
      companyId,
      AND: [telegramStoreWhere(storeId, can(user, 'telegram.manage')), ...(q ? [searchWhere(q)] : [])],
    };

    const grouped = await db.telegramMessage.groupBy({ by: ['processingStatus'], where, _count: { _all: true } });
    const countOf = (list: string[]) =>
      grouped.filter((g) => list.includes(g.processingStatus)).reduce((sum, g) => sum + g._count._all, 0);
    const facts = {
      review: countOf(TABS.review),
      orders: countOf(TABS.orders),
      ignored: countOf(TABS.ignored),
      all: grouped.reduce((sum, g) => sum + g._count._all, 0),
    };

    const total = statuses ? countOf(statuses) : facts.all;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const page = Math.min(readPage(params), totalPages);

    const rows = await db.telegramMessage.findMany({
      where: { ...where, ...(statuses ? { processingStatus: { in: statuses } } : {}) },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        chatId: true,
        threadId: true,
        threadName: true,
        senderName: true,
        text: true,
        processingStatus: true,
        reviewReason: true,
        pageName: true,
        createdAt: true,
        source: { select: { chatTitle: true, topicName: true, storeId: true } },
        order: { select: { id: true, orderNumber: true } },
      },
    });

    const messages = await Promise.all(
      rows.map(async ({ source, ...m }) => {
        const reading = readMessageColumns(m.text ?? '');
        let twin: { id: string; orderNumber: string } | null = null;
        if (m.processingStatus === 'NEEDS_REVIEW' && m.reviewReason === 'DUPLICATE_REF' && source?.storeId) {
          const lines = readLineRoleOrder(m.text ?? '');
          if (lines.claimed && lines.lines.ref && lines.lines.orderedAt) {
            twin = await findTwinOrder({
              companyId,
              storeId: source.storeId,
              messageRowId: m.id,
              receivedAt: m.createdAt,
              ref: lines.lines.ref,
              orderedAt: lines.lines.orderedAt,
            });
          }
        }
        return { ...m, source: source ? { chatTitle: source.chatTitle, topicName: source.topicName } : null, reading, twin };
      })
    );

    return NextResponse.json({ messages, pagination: { total, page, limit, totalPages }, facts });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
