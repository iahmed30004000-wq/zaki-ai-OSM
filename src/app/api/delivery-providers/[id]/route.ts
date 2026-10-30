import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { logAudit } from '@/lib/audit';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { describeUsage, isCourierInUse, type CourierUsage } from '@/lib/couriers/scope';

/**
 * PATCH  /api/delivery-providers/[id] — edit, or activate/deactivate.
 * DELETE /api/delivery-providers/[id] — retire it without touching history.
 */

/** Everything that would be orphaned or cascaded away by a real delete. */
async function usageOf(id: string): Promise<CourierUsage> {
  const [orders, batches, statements, fees, attempts] = await Promise.all([
    db.order.count({ where: { deliveryProviderId: id } }),
    db.shippingBatch.count({ where: { deliveryProviderId: id } }),
    db.courierStatement.count({ where: { deliveryProviderId: id } }),
    db.deliveryFee.count({ where: { deliveryProviderId: id } }),
    db.deliveryAttempt.count({ where: { deliveryProviderId: id } }),
  ]);
  return { orders, batches, statements, fees, attempts };
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId, storeId: currentStore } = await requireContext();
    await requirePermission('settings.edit');

    // This store's courier, or one not placed yet (this door is how one gets
    // placed) — never another store's, which an id alone used to reach.
    const provider = await db.deliveryProvider.findFirst({ where: { id, companyId, OR: [{ storeId: currentStore }, { storeId: null }] } });
    if (!provider) return NextResponse.json({ error: 'شركة الشحن غير موجودة' }, { status: 404 });

    const body = (await req.json().catch(() => ({}))) as {
      name?: string; phone?: string; email?: string; address?: string;
      notes?: string; isActive?: boolean; storeId?: string | null; code?: string;
      adapterCode?: 'LOGESTECHS' | 'MANUAL' | null;
      /** Place a courier left over from before stores had their own. */
      assignToCurrentStore?: boolean;
    };
    const { name, phone, email, address, notes, isActive, code, adapterCode, assignToCurrentStore } = body;

    // The store is taken from the session, never from the body: a body that
    // names its own store is a body that can name someone else's.
    const storeId = assignToCurrentStore ? currentStore : undefined;
    if (assignToCurrentStore && !currentStore) {
      return NextResponse.json({ error: 'اختر المتجر أولاً', code: 'STORE_REQUIRED' }, { status: 400 });
    }

    if (name !== undefined && !name.trim()) {
      return NextResponse.json({ error: 'الاسم مطلوب' }, { status: 400 });
    }

    // The code identifies the courier inside this company, so it must stay
    // distinct here — a second "BASHA" makes two rows nobody can tell apart
    // on a batch list.
    if (code !== undefined && code.trim() && code.trim().toUpperCase() !== provider.code) {
      const taken = await db.deliveryProvider.findFirst({
        where: { companyId, code: code.trim().toUpperCase(), NOT: { id } },
        select: { id: true },
      });
      if (taken) {
        return NextResponse.json({ error: 'الرمز مستعمل لشركة أخرى', code: 'CODE_TAKEN' }, { status: 409 });
      }
    }

    const updated = await db.deliveryProvider.update({
      where: { id },
      // An explicit select, not the whole row: the row carries the encrypted
      // account, and `provider: updated` would have handed the ciphertext to
      // every caller of this endpoint.
      select: {
        id: true, name: true, code: true, kind: true, phone: true,
        email: true, address: true, notes: true, isActive: true,
        apiEnabled: true, adapterCode: true, storeId: true, updatedAt: true,
      },
      data: {
        ...(name ? { name: name.trim() } : {}),
        ...(code !== undefined && code.trim() ? { code: code.trim().toUpperCase() } : {}),
        ...(phone !== undefined ? { phone: phone?.trim() || null } : {}),
        ...(email !== undefined ? { email: email?.trim() || null } : {}),
        ...(address !== undefined ? { address: address?.trim() || null } : {}),
        ...(notes !== undefined ? { notes: notes?.trim() || null } : {}),
        ...(typeof isActive === 'boolean' ? { isActive } : {}),
        // Placing a courier does NOT move its history. Orders, batches and
        // statements keep pointing at this same row; the store only decides
        // who may pick it from here on.
        ...(storeId !== undefined ? { storeId } : {}),
        // Unwiring a courier does NOT erase the stored account — the owner
        // may be switching it off for a week, and re-entering a password
        // they no longer have written down is not a small ask.
        ...(adapterCode !== undefined
          ? {
              adapterCode: adapterCode && adapterCode !== 'MANUAL' ? adapterCode : null,
              apiEnabled: Boolean(adapterCode && adapterCode !== 'MANUAL'),
            }
          : {}),
      },
    });

    await logAudit({
      companyId, userId: user.id, action: 'DELIVERY_PROVIDER_UPDATED',
      entity: 'DeliveryProvider', entityId: id,
      previousData: { name: provider.name, code: provider.code, isActive: provider.isActive, storeId: provider.storeId },
      newData: { name: updated.name, code: updated.code, isActive: updated.isActive, storeId: updated.storeId, by: user.name },
    });

    return NextResponse.json({ success: true, provider: updated });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/**
 * DELETE — retires the courier. It does NOT rewrite the past.
 *
 * A real delete would set `deliveryProviderId` to null on every order,
 * batch and delivery attempt that named this courier, and CASCADE its
 * delivery-fee rows out of existence. An order that no longer knows who
 * shipped it cannot be settled, matched against a statement or explained
 * to the customer, and there is nothing to re-enter — it is history.
 *
 * So anything in use is deactivated instead: it disappears from the pickers
 * and stays on every record that already names it. Only a row that nothing
 * anywhere references is genuinely removed, which is the case this is
 * actually for — a courier added by mistake five minutes ago.
 *
 * The previous version counted ORDERS only, so a courier with no orders but
 * fourteen delivery-fee rows was hard-deleted and took the fees with it.
 */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId, storeId: currentStore } = await requireContext();
    await requirePermission('settings.edit');

    // The same reach as editing it: this store's courier or an unplaced one.
    const provider = await db.deliveryProvider.findFirst({
      where: { id, companyId, OR: [{ storeId: currentStore }, { storeId: null }] },
      select: { id: true, name: true, isActive: true },
    });
    if (!provider) return NextResponse.json({ error: 'شركة الشحن غير موجودة' }, { status: 404 });

    const usage = await usageOf(id);

    if (isCourierInUse(usage)) {
      await db.deliveryProvider.update({ where: { id }, data: { isActive: false } });
      await logAudit({
        companyId, userId: user.id, action: 'DELIVERY_PROVIDER_DEACTIVATED',
        entity: 'DeliveryProvider', entityId: id,
        newData: { name: provider.name, usage, by: user.name },
      });
      return NextResponse.json({
        success: true,
        deactivated: true,
        usage,
        message: `عُطِّلت «${provider.name}» ولم تُحذف — مرتبطة بـ${describeUsage(usage)}. السجلّات القديمة كما هي.`,
      });
    }

    await db.deliveryProvider.delete({ where: { id } });
    await logAudit({
      companyId, userId: user.id, action: 'DELIVERY_PROVIDER_DELETED',
      entity: 'DeliveryProvider', entityId: id,
      previousData: { name: provider.name },
      newData: { by: user.name },
    });
    return NextResponse.json({
      success: true,
      deleted: true,
      message: `حُذِفت «${provider.name}» — لم تكن مرتبطة بأي سجلّ.`,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
