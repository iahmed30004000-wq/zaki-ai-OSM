import { NextResponse } from 'next/server';
import { requireContext } from '@/lib/geo-context';
import { can, requirePermission } from '@/lib/authorization';
import { apiError } from '@/lib/api-error';
import { afterOrderOfPage } from '@/lib/post-order-offer';

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/landing-pages/[id]/after-order — what THIS page's thank-you screen will offer, and why not when it is off.
 *
 * «العرض بعد الطلب مش شغال الي بصفحة المنتج» · «بقلي انو الخدمة غير مفعلة لما اجي اعملها من صفحة الهبوط». The
 * editor's «بعد الطلب» panel reads this and nothing else for its upsell line, so what it says is what the order door
 * will do — see `afterOrderOfPage`.
 *
 * Two permissions, both asked: the page is the landing pages' (`landing_pages.view`, as the page itself is read),
 * and the bundle and its price are the offers' (`offers.view`, as `GET /api/offers` asks). `canManage` tells the
 * panel whether to draw its buttons; the doors those buttons reach — `POST /api/offers` and `PATCH /api/offers/[id]`
 * — ask for `offers.manage` themselves, so it is never the permission.
 */
export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('landing_pages.view');
    await requirePermission('offers.view');
    const { id } = await ctx.params;

    const answer = await afterOrderOfPage({ id, companyId, storeId });
    if (!answer) return NextResponse.json({ error: 'صفحة الهبوط غير موجودة' }, { status: 404 });

    return NextResponse.json({ ...answer, canManage: can(user, 'offers.manage') });
  } catch (error) {
    const { body, status } = apiError(error);
    return NextResponse.json(body, { status });
  }
}
