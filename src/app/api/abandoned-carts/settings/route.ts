import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireContext } from '@/lib/geo-context';
import { apiErrorResponse } from '@/lib/api-error';
import { can } from '@/lib/authorization';
import { logAudit } from '@/lib/audit';
import { updateCompanySettings } from '@/lib/company-settings';
import { MAX_RETENTION_DAYS, MIN_RETENTION_DAYS } from '@/lib/abandoned-cart-rules';
import { cartRetentionDays, cartVisibilityWhere } from '@/lib/abandoned-carts';

/**
 * /api/abandoned-carts/settings — HOW LONG A FINISHED CART IS KEPT.
 *
 * The brief: «احذف السلات NOT_INTERESTED وINVALID وRECOVERED بعد 60 يوم، وخليها قابلة للتعديل كإعداد». The number lives
 * in the company's settings document under `abandonedCarts.retentionDays` (`updateCompanySettings`, which changes that
 * one key under a row lock), and the daily job `prune-abandoned-carts` reads it.
 *
 *   GET  for whoever sees the carts — the screen says how long they stay.
 *   PUT  `{ retentionDays }` for whoever may edit the system's settings (`settings.edit`), with an audit row.
 */
export async function GET() {
  try {
    const { user, companyId } = await requireContext();
    if (!cartVisibilityWhere(user)) return NextResponse.json({ error: 'لا تملك صلاحية عرض الطلبات.' }, { status: 403 });
    return NextResponse.json({
      retentionDays: await cartRetentionDays(companyId),
      min: MIN_RETENTION_DAYS,
      max: MAX_RETENTION_DAYS,
      mayEdit: can(user, 'settings.edit'),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(req: Request) {
  try {
    const { user, companyId } = await requireContext();
    if (!can(user, 'settings.edit')) return NextResponse.json({ error: 'لا تملك صلاحية تعديل إعدادات النظام.' }, { status: 403 });
    const parsed = z
      .object({ retentionDays: z.number().int().min(MIN_RETENTION_DAYS).max(MAX_RETENTION_DAYS) })
      .safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: `المدة بالأيام، من ${MIN_RETENTION_DAYS} إلى ${MAX_RETENTION_DAYS}.` }, { status: 400 });
    }
    const before = await cartRetentionDays(companyId);
    await updateCompanySettings<{ retentionDays: number }>(companyId, 'abandonedCarts', (current) => ({
      ...(current ?? {}),
      retentionDays: parsed.data.retentionDays,
    }));
    await logAudit({
      companyId,
      userId: user.id,
      action: 'ABANDONED_CART_RETENTION',
      entity: 'Company',
      entityId: companyId,
      previousData: { retentionDays: before },
      newData: { retentionDays: parsed.data.retentionDays },
    });
    return NextResponse.json({ retentionDays: parsed.data.retentionDays });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
