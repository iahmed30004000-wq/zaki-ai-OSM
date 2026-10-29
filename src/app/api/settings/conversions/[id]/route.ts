import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireCompanyTenant } from '@/lib/auth';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { VALUE_SOURCES } from '@/lib/conversions/types';

/**
 * Change or remove one conversion.
 *
 * The event name and the moment are IMMUTABLE. Meta builds a custom
 * conversion on top of an event name, and reporting history is attached to
 * it — renaming one here would leave that conversion pointing at a name
 * nothing sends any more, and the seller's reports would go quietly to
 * zero with no error anywhere. Changing the moment is worse: the same name
 * would mean a form submission before the change and a delivery after it,
 * and no report could ever be read again.
 *
 * So a different name or a different moment is a different conversion. What
 * can change is what the seller calls it, what it is worth, and whether it
 * is switched on.
 */

const patchSchema = z.object({
  name: z.string().trim().min(2).max(60).optional(),
  valueSource: z.enum(VALUE_SOURCES).optional(),
  enabled: z.boolean().optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId } = await requireCompanyTenant();
    await requirePermission('settings.tracking');

    const existing = await db.customConversion.findFirst({
      where: { id, companyId },
      select: { id: true, name: true, eventName: true, valueSource: true, enabled: true },
    });
    if (!existing) return NextResponse.json({ error: 'التحويل غير موجود' }, { status: 404 });

    const parsed = patchSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'البيانات غير صالحة' }, { status: 400 });

    const { name, valueSource, enabled } = parsed.data;
    if (name === undefined && valueSource === undefined && enabled === undefined) {
      return NextResponse.json({ error: 'لا شيء لتغييره' }, { status: 400 });
    }

    const updated = await db.customConversion.update({
      where: { id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(valueSource !== undefined ? { valueSource } : {}),
        ...(enabled !== undefined ? { enabled } : {}),
      },
      select: { id: true, name: true, eventName: true, trigger: true, valueSource: true, enabled: true },
    });

    await logAudit({
      companyId,
      userId: user.id,
      action: enabled !== undefined && enabled !== existing.enabled
        ? enabled ? 'CUSTOM_CONVERSION_ENABLED' : 'CUSTOM_CONVERSION_DISABLED'
        : 'CUSTOM_CONVERSION_UPDATED',
      entity: 'CustomConversion',
      entityId: id,
      previousData: { name: existing.name, valueSource: existing.valueSource, enabled: existing.enabled },
      newData: { ...updated, by: user.name },
    });

    return NextResponse.json({ success: true, conversion: updated });
  } catch (e) {
    return apiErrorResponse(e);
  }
}

/**
 * Delete.
 *
 * The record of what was already sent goes with it. That is the honest
 * shape: those events live in Meta's account now and deleting our row does
 * not recall them — but keeping an orphaned history under a conversion
 * nobody can see would be a drawer nobody ever opens.
 *
 * Switching it off instead is offered in the message, because that is what
 * most people mean.
 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId } = await requireCompanyTenant();
    await requirePermission('settings.tracking');

    const existing = await db.customConversion.findFirst({
      where: { id, companyId },
      select: { id: true, name: true, eventName: true, trigger: true, _count: { select: { deliveries: true } } },
    });
    if (!existing) return NextResponse.json({ error: 'التحويل غير موجود' }, { status: 404 });

    await db.customConversion.delete({ where: { id } });

    await logAudit({
      companyId,
      userId: user.id,
      action: 'CUSTOM_CONVERSION_DELETED',
      entity: 'CustomConversion',
      entityId: id,
      previousData: {
        name: existing.name,
        eventName: existing.eventName,
        trigger: existing.trigger,
        sentCount: existing._count.deliveries,
        by: user.name,
      },
    });

    return NextResponse.json({
      success: true,
      message: existing._count.deliveries
        ? `حُذف التحويل وسجلّ ${existing._count.deliveries} إرسالاً معه. الأحداث التي وصلت ميتا تبقى عندهم.`
        : 'حُذف التحويل.',
    });
  } catch (e) {
    return apiErrorResponse(e);
  }
}
