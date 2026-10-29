import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { inStore } from '@/lib/store-filter';
import { zodMessage } from '@/lib/zod-message';
import { duplicatesOf } from '@/lib/campaign-insights';

/**
 * POST /api/growth/campaigns/duplicates — «زر حذف المكرر».
 *
 * A hand-typed campaign whose twin the platform sent (same name, the twin carries the platform id) is the same
 * campaign twice: the old copy holds the orders, the new one the spend, and the report shows one as profit with no
 * advert and the other as pure loss. Merging: the orders move to the twin, the twin takes the product or landing
 * page if it has neither, and the old copy — empty now — is deleted. One transaction per pair, so a pair is merged
 * whole or not at all. The pairs are worked out HERE, from this store's campaigns — never taken from the request.
 *
 * `ids` narrows it to the hand-typed campaigns the seller ticked; absent, every duplicate is merged.
 */

const schema = z.object({ ids: z.array(z.string().uuid()).max(1000).optional() });

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('reports.view');
    const parsed = schema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });

    const all = await db.campaign.findMany({
      where: inStore(companyId, storeId),
      select: { id: true, name: true, externalId: true, productId: true, landingPageId: true },
    });
    const pairs = duplicatesOf(all);
    const wanted = parsed.data.ids ? new Set(parsed.data.ids) : null;
    const byId = new Map(all.map((c) => [c.id, c]));

    let merged = 0;
    let ordersMoved = 0;
    for (const [oldId, twinId] of pairs) {
      if (wanted && !wanted.has(oldId)) continue;
      const old = byId.get(oldId)!;
      const twin = byId.get(twinId)!;
      const moved = await db.$transaction(async (tx) => {
        const r = await tx.order.updateMany({ where: { companyId, campaignId: oldId }, data: { campaignId: twinId } });
        if (!twin.productId && !twin.landingPageId && (old.productId || old.landingPageId)) {
          await tx.campaign.update({ where: { id: twinId }, data: { productId: old.productId, landingPageId: old.landingPageId } });
        }
        await tx.campaign.delete({ where: { id: oldId } });
        return r.count;
      });
      merged++;
      ordersMoved += moved;
    }

    await logAudit({
      companyId, userId: user.id, action: 'CAMPAIGNS_DUPLICATES_MERGED', entity: 'Store', entityId: storeId ?? companyId,
      newData: { merged, ordersMoved },
    });
    return NextResponse.json({ success: true, merged, ordersMoved });
  } catch (e) {
    return apiErrorResponse(e);
  }
}
