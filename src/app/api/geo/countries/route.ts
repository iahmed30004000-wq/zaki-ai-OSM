import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireCompanyTenant } from '@/lib/auth';
import { requirePermission } from '@/lib/authorization';
import { geoReach } from '@/lib/geo-context';
import { logAudit } from '@/lib/audit';
import { apiErrorResponse } from '@/lib/api-error';
import { countryCreateSchema, firstIssue } from '@/lib/geo-schemas';
import { workHoursError } from '@/lib/work-hours';

/**
 *   GET  /api/geo/countries  (geo.view)   every country of the company, with stores
 *   POST /api/geo/countries  (geo.manage) create a country
 *
 * There is no DELETE: a country is deactivated with isActive=false.
 * Default-wallet provisioning on create arrives with the wallets stage.
 */

export async function GET() {
  try {
    const { companyId } = await requireCompanyTenant();
    const viewer = await requirePermission('geo.view');
    // Only what this person reaches, unless they see every country (geoReach).
    const reach = await geoReach(viewer, companyId);

    const countries = await db.country.findMany({
      where: { companyId, ...(reach ? { id: { in: reach.countryIds } } : {}) },
      orderBy: { name: 'asc' },
      include: {
        stores: {
          ...(reach?.storeIds ? { where: { id: { in: reach.storeIds } } } : {}),
          orderBy: { name: 'asc' },
          select: {
            id: true, name: true, slug: true, logo: true, favicon: true, status: true, type: true, priceIncludesDelivery: true,
            // The storefront's own settings, so the panel edits what is
            // stored rather than a copy it fetched separately.
            storefrontEnabled: true, theme: true, tagline: true, landingPageId: true,
            about: true, supportPhone: true, domain: true,
          },
        },
        // Orders decide whether the currency may still change (see PATCH).
        _count: { select: { regions: true, orders: true } },
      },
    });
    return NextResponse.json({ countries });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    const { user, companyId } = await requireCompanyTenant();
    await requirePermission('geo.manage');

    const parsed = countryCreateSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });

    // No night shift: the day starts before it ends (the defaults, 09:00-17:00, pass).
    const hoursError = workHoursError(parsed.data.workHoursStart, parsed.data.workHoursEnd);
    if (hoursError) return NextResponse.json({ error: hoursError }, { status: 400 });

    const clash = await db.country.findFirst({ where: { companyId, code: parsed.data.code }, select: { id: true } });
    if (clash) return NextResponse.json({ error: 'هذا البلد مضاف مسبقًا' }, { status: 409 });

    const country = await db.country.create({ data: { companyId, ...parsed.data } });

    await logAudit({
      companyId,
      userId: user.id,
      action: 'COUNTRY_CREATED',
      entity: 'Country',
      entityId: country.id,
      newData: country,
    });
    return NextResponse.json({ country }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
