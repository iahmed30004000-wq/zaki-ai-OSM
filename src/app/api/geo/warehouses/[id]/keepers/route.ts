import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireCompanyTenant } from '@/lib/auth';
import { requirePermission } from '@/lib/authorization';
import { logAudit } from '@/lib/audit';
import { apiErrorResponse } from '@/lib/api-error';
import { canActOnUser } from '@/lib/user-permissions';
import { firstIssue, warehouseKeepersSchema } from '@/lib/geo-schemas';
import { WAREHOUSE_NOT_FOUND_AR, reachesCountryOf, sessionPeople } from '@/lib/warehouses';

/**
 *   GET /api/geo/warehouses/:id/keepers  (geo.manage) — who keeps it, and whether each still reaches its country;
 *                                                      plus `candidates`: the active people who may be named (the picker's list)
 *   PUT /api/geo/warehouses/:id/keepers  (geo.manage) — { userIds }: the whole list, replacing the old one
 *
 * A keeper row CONFINES a person: whoever keeps any warehouse reaches only the
 * warehouses she keeps (`src/lib/warehouses.ts`). So only somebody who reaches
 * the warehouse's country may be named — judged by her effective keys as a
 * session computes them — and naming or un-naming someone is power over her
 * work: refused on an account whose keys go beyond the caller's
 * (`canActOnUser`), the same as the geo-access door.
 *
 * A keeper who later loses her country stays listed with `reachesCountry:
 * false`: the row narrows, it never grants, so she reaches nothing there.
 */

const refuse = (status: number, code: string, ar: string, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ error: ar, errorAr: ar, code, ...extra }, { status });

async function warehouseOf(companyId: string, id: string) {
  return db.warehouse.findFirst({
    where: { id, companyId },
    select: { id: true, companyId: true, countryId: true, name: true, keepers: { select: { userId: true } } },
  });
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { companyId } = await requireCompanyTenant();
    await requirePermission('geo.manage');
    const warehouse = await warehouseOf(companyId, id);
    if (!warehouse) return refuse(404, 'NOT_FOUND', WAREHOUSE_NOT_FOUND_AR);

    const people = await sessionPeople(companyId, warehouse.keepers.map((k) => k.userId));
    const keepers = await Promise.all(
      people.map(async (p) => ({ id: p.id, name: p.name, reachesCountry: await reachesCountryOf(p.user, companyId, warehouse.countryId) }))
    );

    // THE PICKER'S LIST (W0b): every ACTIVE person of this company who reaches
    // the warehouse's country — judged by the same rule the PUT below judges a
    // name by, on keys computed as a session computes them. Asked only when the
    // picker opens; a staff list is tens of people, not thousands.
    const active = await db.user.findMany({ where: { companyId, status: 'ACTIVE' }, select: { id: true } });
    const pool = await sessionPeople(companyId, active.map((u) => u.id));
    const candidates: { id: string; name: string }[] = [];
    for (const p of pool) {
      if (await reachesCountryOf(p.user, companyId, warehouse.countryId)) candidates.push({ id: p.id, name: p.name });
    }
    candidates.sort((a, b) => a.name.localeCompare(b.name, 'ar'));
    return NextResponse.json({ keepers, candidates });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId } = await requireCompanyTenant();
    await requirePermission('geo.manage');

    const parsed = warehouseKeepersSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return refuse(400, 'INVALID', firstIssue(parsed.error));
    const userIds = [...new Set(parsed.data.userIds)];

    const warehouse = await warehouseOf(companyId, id);
    if (!warehouse) return refuse(404, 'NOT_FOUND', WAREHOUSE_NOT_FOUND_AR);

    // Only this company's people; anyone else is not found, by design (no hint that the id exists elsewhere).
    const people = await sessionPeople(companyId, userIds);
    if (people.length !== userIds.length) return refuse(400, 'USER_NOT_FOUND', 'في موظف مش موجود بالشركة. حدّث الصفحة.');

    const outside: string[] = [];
    for (const p of people) {
      if (!(await reachesCountryOf(p.user, companyId, warehouse.countryId))) outside.push(p.name);
    }
    if (outside.length > 0) {
      return refuse(
        400,
        'KEEPER_OUTSIDE_COUNTRY',
        `ما بيوصلوا لبلد هالمخزن: ${outside.join('، ')}. أعطيهم البلد من صفحة الموظف أول.`,
        { names: outside }
      );
    }

    const before = warehouse.keepers.map((k) => k.userId);
    const removed = before.filter((u) => !userIds.includes(u));
    const added = userIds.filter((u) => !before.includes(u));
    const touched = await db.user.findMany({
      where: { id: { in: [...added, ...removed] }, companyId },
      select: { id: true, role: true, roleId: true },
    });
    for (const target of touched) {
      const acting = await canActOnUser(user, target);
      if (!acting.ok) return refuse(acting.status, 'BEYOND_YOUR_KEYS', acting.error);
    }

    await db.$transaction(async (tx) => {
      await tx.userWarehouseAccess.deleteMany({ where: { warehouseId: id, userId: { notIn: userIds } } });
      if (added.length > 0) {
        await tx.userWarehouseAccess.createMany({
          data: added.map((userId) => ({ userId, warehouseId: id })),
          skipDuplicates: true,
        });
      }
    });

    await logAudit({
      companyId,
      userId: user.id,
      action: 'WAREHOUSE_KEEPERS_SET',
      entity: 'Warehouse',
      entityId: id,
      previousData: { userIds: before },
      newData: { userIds },
    });
    return NextResponse.json({ keepers: people.map((p) => ({ id: p.id, name: p.name, reachesCountry: true })) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
