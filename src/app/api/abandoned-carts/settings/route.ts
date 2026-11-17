import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireContext } from '@/lib/geo-context';
import { apiErrorResponse } from '@/lib/api-error';
import { can } from '@/lib/authorization';
import { logAudit } from '@/lib/audit';
import { updateCompanySettings } from '@/lib/company-settings';
import { MAX_RETENTION_DAYS, MIN_RETENTION_DAYS } from '@/lib/abandoned-cart-rules';
import { cartAutoConvert, cartRetentionDays, cartVisibilityWhere } from '@/lib/abandoned-carts';

/**
 * /api/abandoned-carts/settings — HOW LONG A FINISHED CART IS KEPT, AND WHETHER A CART BECOMES AN ORDER BY ITSELF.
 *
 * The brief: «احذف السلات NOT_INTERESTED وINVALID وRECOVERED بعد 60 يوم، وخليها قابلة للتعديل كإعداد». The number lives
 * in the company's settings document under `abandonedCarts.retentionDays` (`updateCompanySettings`, which changes that
 * one key under a row lock), and the daily job `prune-abandoned-carts` reads it.
 *
 * The owner, 17/11: «حوّل السلات اللي فيها اسم ورقم لطلبات تلقائيًا» — `abandonedCarts.autoConvert`, ON unless turned off.
 * The landing door's cart upsert and the job `convert-waiting-carts` read it (`abandoned-cart-orders.ts`).
 *
 *   GET  for whoever sees the carts — the screen says how long they stay and whether they become orders.
 *   PUT  `{ retentionDays }` and/or `{ autoConvert }` for whoever may edit the system's settings (`settings.edit`), with
 *        an audit row for each one changed.
 */
export async function GET() {
  try {
    const { user, companyId } = await requireContext();
    if (!cartVisibilityWhere(user)) return NextResponse.json({ error: 'لا تملك صلاحية عرض الطلبات.' }, { status: 403 });
    return NextResponse.json({
      retentionDays: await cartRetentionDays(companyId),
      autoConvert: await cartAutoConvert(companyId),
      min: MIN_RETENTION_DAYS,
      max: MAX_RETENTION_DAYS,
      mayEdit: can(user, 'settings.edit'),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

const putSchema = z
  .object({
    retentionDays: z.number().int().min(MIN_RETENTION_DAYS).max(MAX_RETENTION_DAYS).optional(),
    autoConvert: z.boolean().optional(),
  })
  .refine((v) => v.retentionDays !== undefined || v.autoConvert !== undefined);

export async function PUT(req: Request) {
  try {
    const { user, companyId } = await requireContext();
    if (!can(user, 'settings.edit')) return NextResponse.json({ error: 'لا تملك صلاحية تعديل إعدادات النظام.' }, { status: 403 });
    const parsed = putSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: `المدة بالأيام، من ${MIN_RETENTION_DAYS} إلى ${MAX_RETENTION_DAYS}؛ والتحويل التلقائي شغّال أو موقوف.` },
        { status: 400 }
      );
    }
    const { retentionDays, autoConvert } = parsed.data;
    const before = { retentionDays: await cartRetentionDays(companyId), autoConvert: await cartAutoConvert(companyId) };
    await updateCompanySettings<{ retentionDays?: number; autoConvert?: boolean }>(companyId, 'abandonedCarts', (current) => ({
      ...(current ?? {}),
      ...(retentionDays !== undefined ? { retentionDays } : {}),
      ...(autoConvert !== undefined ? { autoConvert } : {}),
    }));
    if (retentionDays !== undefined) {
      await logAudit({
        companyId,
        userId: user.id,
        action: 'ABANDONED_CART_RETENTION',
        entity: 'Company',
        entityId: companyId,
        previousData: { retentionDays: before.retentionDays },
        newData: { retentionDays },
      });
    }
    if (autoConvert !== undefined) {
      await logAudit({
        companyId,
        userId: user.id,
        action: 'ABANDONED_CART_AUTO_CONVERT',
        entity: 'Company',
        entityId: companyId,
        previousData: { autoConvert: before.autoConvert },
        newData: { autoConvert },
      });
    }
    return NextResponse.json({
      retentionDays: retentionDays ?? before.retentionDays,
      autoConvert: autoConvert ?? before.autoConvert,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
