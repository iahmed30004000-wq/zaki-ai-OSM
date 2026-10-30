import { NextResponse } from 'next/server';
import { readLimit, readPage } from '@/lib/numeric-input';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';

import { logAudit } from '@/lib/audit';
import { can } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { courierCityGaps } from '@/lib/couriers/city-gaps';

/**
 * GET  /api/shipping-batches — company-scoped list (with order counts)
 * POST /api/shipping-batches — create batch (orders.change_status holders)
 *
 * Batch numbering is server-generated: SB-<year>-<####> per company.
 */
export async function GET(req: Request) {
  try {
    const { user, companyId, storeId } = await requireContext();
    // The key of the screen that reads it (route-registry: /ops/batches): `ops.batches` (PR-8). It asked the packing key OR
    // the tracking key before, and nothing at all before that — any signed-in member of the store read every batch, its
    // courier and who made it. The migration gave the box to everybody who held either, so nobody lost the page.
    if (!can(user, 'ops.batches')) {
      return NextResponse.json({ error: 'دفعات الشحن ليست من صلاحيّاتك.', errorAr: 'دفعات الشحن ليست من صلاحيّاتك.' }, { status: 403 });
    }
    const { searchParams } = new URL(req.url);
    const page = readPage(searchParams);
    const limit = readLimit(searchParams, 50, 100);

    const [total, batches] = await Promise.all([
      db.shippingBatch.count({ where: { companyId, storeId } }),
      db.shippingBatch.findMany({
        where: { companyId, storeId },
        include: {
          // `apiEnabled` decides whether "رحّل إلى الشركة" means anything
          // for this batch: a manual courier has no server to send to.
          provider: { select: { id: true, name: true, code: true, kind: true, apiEnabled: true, adapterCode: true } },
          creator: { select: { id: true, name: true } },
          _count: { select: { orders: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    // A WARNING BEFORE THE PRESS (RV166): the parcels of an open trolley that the courier has no city id for.
    const gaps = await courierCityGaps({
      companyId,
      storeId,
      batches: batches.map((b) => ({ id: b.id, status: b.status, deliveryProviderId: b.deliveryProviderId })),
    });

    return NextResponse.json({
      batches: batches.map((b) => ({ ...b, courierCityGap: gaps.get(b.id) ?? null })),
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    // A refusal is a refusal, not «خطأ داخلي» with a 400.
    return apiErrorResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId } = await requireContext();
    if (!can(user, 'orders.change_status')) {
      return NextResponse.json({ error: 'Forbidden: cannot manage shipping batches', errorAr: 'إدارة دفعات الشحن ليست من صلاحيّاتك.' }, { status: 403 });
    }

    const body = await req.json();
    const { deliveryProviderId, notes } = body as { deliveryProviderId?: string; notes?: string };

    let providerId: string | null = null;
    if (deliveryProviderId) {
      const provider = await db.deliveryProvider.findFirst({ where: { id: deliveryProviderId, companyId } });
      if (!provider) return NextResponse.json({ error: 'Provider not found in your company', errorAr: 'شركة الشحن هذه ليست من شركات شركتك.' }, { status: 404 });
      providerId = provider.id;
    }

    // One open trolley per courier: everything going to them rides on the
    // same batch until it is handed over. A second open batch splits one
    // pickup into two lists nobody can tell apart afterwards.
    if (providerId) {
      const open = await db.shippingBatch.findFirst({
        where: { companyId, storeId, deliveryProviderId: providerId, status: 'READY' },
        orderBy: { createdAt: 'desc' },
      });
      if (open) {
        return NextResponse.json({ batch: open, reused: true });
      }
    }

    // Server-generated batch number (company-scoped sequence with retry)
    const count = await db.shippingBatch.count({ where: { companyId } });
    const batchNumber = `SB-${new Date().getFullYear()}-${String(count + 1).padStart(5, '0')}`;

    const batch = await db.shippingBatch.create({
      data: {
        companyId,            // session-derived
        storeId,              // selected store
        batchNumber,          // server-generated
        deliveryProviderId: providerId,
        createdById: user.id, // server-derived actor
        notes: notes?.trim() || null,
      },
      include: { provider: { select: { id: true, name: true, code: true, kind: true, apiEnabled: true, adapterCode: true } } },
    });

    await logAudit({
      companyId, userId: user.id, action: 'SHIPPING_BATCH_CREATED',
      entity: 'ShippingBatch', entityId: batch.id,
      newData: { batchNumber, providerId, by: user.name },
    });

    return NextResponse.json({ success: true, batch });
  } catch (error: any) {
    // P2002 duplicate batch number under race → generic conflict
    return NextResponse.json({ error: 'حدث خطأ داخلي' }, { status: 400 });
  }
}
