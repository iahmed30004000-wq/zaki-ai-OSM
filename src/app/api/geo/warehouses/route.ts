import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { requireCompanyTenant } from '@/lib/auth';
import { can, requirePermission } from '@/lib/authorization';
import { logAudit } from '@/lib/audit';
import { apiErrorResponse } from '@/lib/api-error';
import { firstIssue, warehouseCreateSchema } from '@/lib/geo-schemas';
import { WAREHOUSE_NAME_TAKEN_AR, warehousesReachedBy } from '@/lib/warehouses';

/**
 *   GET  /api/geo/warehouses?countryId=  (geo.view)   — the warehouses this person reaches
 *   POST /api/geo/warehouses             (geo.manage) — { countryId, name }
 *
 * A warehouse is a place of ONE country (`src/lib/warehouses.ts`). Defining
 * one changes nothing else: no stock door reads it until a store is placed.
 * The keepers are listed only to `geo.manage` holders — they are names of
 * staff, and the people who may change them are the people who see them.
 */

const refuse = (status: number, code: string, ar: string) => NextResponse.json({ error: ar, errorAr: ar, code }, { status });

export async function GET(req: Request) {
  try {
    const { companyId } = await requireCompanyTenant();
    const viewer = await requirePermission('geo.view');
    const countryId = new URL(req.url).searchParams.get('countryId');
    const manages = can(viewer, 'geo.manage');

    const rows = await db.warehouse.findMany({
      where: { companyId, ...(countryId ? { countryId } : {}) },
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      select: {
        id: true,
        companyId: true,
        countryId: true,
        name: true,
        isActive: true,
        createdAt: true,
        keepers: { select: { user: { select: { id: true, name: true } } } },
      },
    });
    const reached = await warehousesReachedBy(viewer, companyId, rows);
    // Staff names leave this door only for the people who may change them.
    const warehouses = reached.map(({ keepers, ...w }) => {
      const row = { id: w.id, countryId: w.countryId, name: w.name, isActive: w.isActive, createdAt: w.createdAt };
      return manages ? { ...row, keepers: keepers.map((k) => k.user) } : row;
    });
    return NextResponse.json({ warehouses });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    const { user, companyId } = await requireCompanyTenant();
    await requirePermission('geo.manage');

    const parsed = warehouseCreateSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return refuse(400, 'INVALID', firstIssue(parsed.error));
    const { countryId, name } = parsed.data;

    const country = await db.country.findFirst({ where: { id: countryId, companyId }, select: { id: true } });
    if (!country) return refuse(404, 'COUNTRY_NOT_FOUND', 'البلد مش موجود. حدّث الصفحة.');

    const clash = await db.warehouse.findFirst({ where: { companyId, countryId, name }, select: { id: true } });
    if (clash) return refuse(409, 'NAME_TAKEN', WAREHOUSE_NAME_TAKEN_AR);

    let warehouse;
    try {
      warehouse = await db.warehouse.create({ data: { companyId, countryId, name } });
    } catch (e) {
      // Two presses at once: the database's unique rule answers the second.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return refuse(409, 'NAME_TAKEN', WAREHOUSE_NAME_TAKEN_AR);
      }
      throw e;
    }
    await logAudit({ companyId, userId: user.id, action: 'WAREHOUSE_CREATED', entity: 'Warehouse', entityId: warehouse.id, newData: warehouse });
    return NextResponse.json({ warehouse }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
