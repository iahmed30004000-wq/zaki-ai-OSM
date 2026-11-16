import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireCompanyTenant } from '@/lib/auth';
import { requirePermission } from '@/lib/authorization';
import { logAudit } from '@/lib/audit';
import { apiErrorResponse } from '@/lib/api-error';
import { countryUpdateSchema, firstIssue } from '@/lib/geo-schemas';
import { effectiveWorkHours, workHoursError } from '@/lib/work-hours';

/** PATCH /api/geo/countries/:id (geo.manage). No DELETE — deactivate instead. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId } = await requireCompanyTenant();
    await requirePermission('geo.manage');

    const parsed = countryUpdateSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });

    const before = await db.country.findFirst({ where: { id, companyId } });
    if (!before) return NextResponse.json({ error: 'البلد غير موجود' }, { status: 404 });

    // No night shift. Judged only when the request touches the hours, and then
    // against the stored value for the half it did not send — so a save of the
    // name or the weekend never trips on an old night-shift row.
    const hours = effectiveWorkHours(parsed.data, before);
    if (hours.touches) {
      const hoursError = workHoursError(hours.start, hours.end);
      if (hoursError) return NextResponse.json({ error: hoursError }, { status: 400 });
    }

    // The currency and its decimals may be corrected until the country has
    // taken an order. After that every order, fee and statement is written
    // in them, and changing the unit would relabel money that was already
    // counted — a mistake at creation is fixable, history is not rewritable.
    const moneyChanges =
      (parsed.data.currencyCode !== undefined && parsed.data.currencyCode !== before.currencyCode) ||
      (parsed.data.minorUnit !== undefined && parsed.data.minorUnit !== before.minorUnit);
    if (moneyChanges) {
      const orders = await db.order.count({ where: { companyId, countryId: id } });
      if (orders > 0) {
        return NextResponse.json(
          { error: `لا يمكن تغيير العملة أو عدد الكسور — على هذا البلد ${orders} طلباً مسجّلاً بها` },
          { status: 409 }
        );
      }
    }

    if (parsed.data.code && parsed.data.code !== before.code) {
      const clash = await db.country.findFirst({ where: { companyId, code: parsed.data.code }, select: { id: true } });
      if (clash) return NextResponse.json({ error: 'هذا البلد مضاف مسبقًا' }, { status: 409 });
    }

    const country = await db.country.update({ where: { id }, data: parsed.data });
    await logAudit({
      companyId,
      userId: user.id,
      action: 'COUNTRY_UPDATED',
      entity: 'Country',
      entityId: id,
      previousData: before,
      newData: country,
    });
    return NextResponse.json({ country });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
