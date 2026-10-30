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
 * POST /api/growth/campaigns/bulk — «تحديد… زر حذف الكل». Delete the chosen campaigns, by the rule the single
 * delete already keeps: a campaign that brought orders is ENDED instead, so every order still knows where it came
 * from; one that brought none is deleted. Nothing about an order changes here.
 */

const schema = z.object({ action: z.literal('delete'), ids: z.array(z.string().uuid()).min(1).max(1000) });

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('campaigns.manage');
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });

    const found = await db.campaign.findMany({
      where: { id: { in: [...new Set(parsed.data.ids)] }, ...inStore(companyId, storeId) },
      select: { id: true, name: true, _count: { select: { orders: true } } },
    });
    const withOrders = found.filter((c) => c._count.orders > 0).map((c) => c.id);
    const empty = found.filter((c) => c._count.orders === 0).map((c) => c.id);

    await db.$transaction([
      db.campaign.updateMany({ where: { id: { in: withOrders } }, data: { status: 'ENDED' } }),
      db.campaign.deleteMany({ where: { id: { in: empty } } }),
    ]);
    await logAudit({
      companyId, userId: user.id, action: 'CAMPAIGNS_BULK_DELETED', entity: 'Store', entityId: storeId ?? companyId,
      newData: { deleted: empty.length, ended: withOrders.length, names: found.slice(0, 50).map((c) => c.name) },
    });
    return NextResponse.json({ success: true, deleted: empty.length, ended: withOrders.length });
  } catch (e) {
    return apiErrorResponse(e);
  }
}
