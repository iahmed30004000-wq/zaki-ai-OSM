import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { inStore } from '@/lib/store-filter';
import { zodMessage } from '@/lib/zod-message';

/**
 * POST /api/growth/campaigns/order — the order the seller dragged the campaigns into. «الدراج اند دروب وترتيب
 * الحملات عندي».
 *
 * The whole list in its new order, in one request, written in one transaction: position i becomes sortOrder i.
 * Only this store's campaigns are touched — an id from elsewhere is not a campaign this caller can name, and the
 * request is refused rather than half-applied.
 */

const schema = z.object({ ids: z.array(z.string().uuid()).min(1).max(1000) });

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('reports.view');
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    const ids = [...new Set(parsed.data.ids)];

    const found = await db.campaign.findMany({ where: { id: { in: ids }, ...inStore(companyId, storeId) }, select: { id: true } });
    if (found.length !== ids.length) {
      return NextResponse.json({ error: 'حملة من القائمة ليست من هذا المتجر' }, { status: 404 });
    }

    await db.$transaction(ids.map((id, i) => db.campaign.update({ where: { id }, data: { sortOrder: i } })));
    await logAudit({ companyId, userId: user.id, action: 'CAMPAIGNS_REORDERED', entity: 'Store', entityId: storeId ?? companyId, newData: { count: ids.length } });
    return NextResponse.json({ success: true, count: ids.length });
  } catch (e) {
    return apiErrorResponse(e);
  }
}
