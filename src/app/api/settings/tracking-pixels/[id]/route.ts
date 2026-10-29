import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireCompanyTenant } from '@/lib/auth';
import { logAudit } from '@/lib/audit';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { maskPixelId, ORDER_EVENTS, TRACKING_PLATFORMS, TRACKING_SCOPES } from '@/lib/tracking/tracking-types';
import { pixelIdHint, validateTrackingPixelId } from '@/lib/tracking/tracking-validation';
import { zodMessage } from '@/lib/zod-message';
import { resolvePixelScope } from '@/lib/tracking/pixel-scope';
import { PIXEL_PUBLIC_SELECT } from '@/lib/tracking/tracking-config';

/**
 * PATCH  /api/settings/tracking-pixels/[id] — update / enable / disable
 * DELETE /api/settings/tracking-pixels/[id] — delete
 *
 * Company-scoped (findFirst { id, companyId }) → cross-tenant access is a
 * 404. companyId / platform changes from the body are rejected outright;
 * platform is immutable to prevent enum spoofing after creation.
 */

const updateSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  pixelId: z.string().trim().min(4).max(64).optional(),
  scope: z.enum(TRACKING_SCOPES).optional(),
  enabled: z.boolean().optional(),
  platform: z.enum(TRACKING_PLATFORMS).optional(), // accepted but must match (immutable)
  /**
   * WHOSE VISITORS — and the two move TOGETHER or not at all.
   *
   * `nullish`, not `optional`: moving a pixel back to company-wide means
   * sending `null`, and a schema that only accepted a string could express
   * «this store» and «that country» but never «all of them again».
   */
  storeId: z.string().uuid().nullish(),
  countryId: z.string().uuid().nullish(),
  /** What an order is reported as on this pixel, and the two events a seller may switch off. */
  orderEvent: z.enum(ORDER_EVENTS).optional(),
  sendViewContent: z.boolean().optional(),
  sendInitiateCheckout: z.boolean().optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId } = await requireCompanyTenant();
    await requirePermission('settings.tracking');

    const pixel = await db.trackingPixel.findFirst({ where: { id, companyId } });
    if (!pixel) return NextResponse.json({ error: 'Pixel not found', errorAr: 'البكسل غير موجود. أعد تحميل الصفحة.' }, { status: 404 });

    /*
     * THE BODY IS KEPT, not only its parsed form.
     *
     * The scope is TWO columns that must agree, and the question «did the
     * caller mention the scope at all?» cannot be answered from the parsed
     * object: an absent key and an explicit `null` both land as nothing
     * there, and they mean opposite things — «leave the scope alone» and
     * «make it company-wide». A partial PATCH that guessed would either
     * refuse to widen a scope or silently clear one. This repository has
     * paid for that shape four times (`dad59c9`, `323e95a`).
     */
    const raw: unknown = await req.json().catch(() => null);
    const mentioned = (key: string) =>
      typeof raw === 'object' && raw !== null && Object.prototype.hasOwnProperty.call(raw, key);
    const scopeMentioned = mentioned('storeId') || mentioned('countryId');

    const parsed = updateSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: zodMessage(parsed.error) },
        { status: 400 }
      );
    }
    const { name, pixelId: rawPixelId, scope, enabled, platform, orderEvent, sendViewContent, sendInitiateCheckout } = parsed.data;

    // platform spoofing guard: the platform of an existing pixel is immutable
    if (platform !== undefined && platform !== pixel.platform) {
      return NextResponse.json({ error: 'لا يمكن تغيير منصة البكسل — احذفه وأضف بكسل جديد' }, { status: 400 });
    }
    // companyId spoofing guard: never accepted from the body (schema has no such field)

    let nextPixelId: string | undefined;
    if (rawPixelId !== undefined && rawPixelId !== pixel.pixelId) {
      const validated = validateTrackingPixelId(pixel.platform, rawPixelId);
      if (!validated) {
        return NextResponse.json({ error: pixelIdHint(pixel.platform) }, { status: 400 });
      }
      const clash = await db.trackingPixel.findFirst({
        where: { companyId, platform: pixel.platform, pixelId: validated, id: { not: id } },
      });
      if (clash) {
        return NextResponse.json({ error: 'هذا البكسل مسجل مسبقًا لنفس المنصة' }, { status: 409 });
      }
      nextPixelId = validated;
    }

    /*
     * BOTH COLUMNS OR NEITHER. A PATCH naming only `storeId` must not leave
     * the old `countryId` behind it — that row would say «this store, and
     * also that whole country», which is the state the database CHECK
     * refuses. So when the scope is mentioned at all, it is resolved whole
     * and written whole.
     */
    let nextScope: { storeId: string | null; countryId: string | null } | null = null;
    if (scopeMentioned) {
      const where = await resolvePixelScope(companyId, parsed.data);
      if (!where.ok) return NextResponse.json({ error: where.error }, { status: 400 });
      nextScope = { storeId: where.storeId, countryId: where.countryId };
    }

    const updated = await db.trackingPixel.update({
      where: { id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(nextPixelId !== undefined ? { pixelId: nextPixelId } : {}),
        ...(scope !== undefined ? { scope } : {}),
        ...(enabled !== undefined ? { enabled } : {}),
        ...(nextScope ?? {}),
        ...(orderEvent !== undefined ? { orderEvent } : {}),
        ...(sendViewContent !== undefined ? { sendViewContent } : {}),
        ...(sendInitiateCheckout !== undefined ? { sendInitiateCheckout } : {}),
      },
      // Never the whole row: it carries the encrypted Conversions API token.
      select: PIXEL_PUBLIC_SELECT,
    });

    const toggled = enabled !== undefined && enabled !== pixel.enabled;
    await logAudit({
      companyId,
      userId: user.id,
      action: toggled
        ? enabled ? 'TRACKING_PIXEL_ENABLED' : 'TRACKING_PIXEL_DISABLED'
        : 'TRACKING_PIXEL_UPDATED',
      entity: 'TrackingPixel',
      entityId: id,
      previousData: {
        name: pixel.name, scope: pixel.scope, enabled: pixel.enabled,
        // Where it USED to fire. Moving a pixel from one shop to another is
        // the change somebody will later need to date.
        storeId: pixel.storeId, countryId: pixel.countryId,
        orderEvent: pixel.orderEvent, sendViewContent: pixel.sendViewContent, sendInitiateCheckout: pixel.sendInitiateCheckout,
      },
      newData: {
        name: updated.name,
        scope: updated.scope,
        enabled: updated.enabled,
        storeId: updated.storeId,
        countryId: updated.countryId,
        orderEvent: updated.orderEvent, sendViewContent: updated.sendViewContent, sendInitiateCheckout: updated.sendInitiateCheckout,
        pixelId: maskPixelId(updated.pixelId),
        by: user.name,
      },
    });

    return NextResponse.json({ success: true, pixel: updated });
  } catch (error: any) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId } = await requireCompanyTenant();
    await requirePermission('settings.tracking');

    const pixel = await db.trackingPixel.findFirst({ where: { id, companyId } });
    if (!pixel) return NextResponse.json({ error: 'Pixel not found', errorAr: 'البكسل غير موجود. أعد تحميل الصفحة.' }, { status: 404 });

    await db.trackingPixel.delete({ where: { id } });

    await logAudit({
      companyId,
      userId: user.id,
      action: 'TRACKING_PIXEL_DELETED',
      entity: 'TrackingPixel',
      entityId: id,
      newData: { platform: pixel.platform, name: pixel.name, pixelId: maskPixelId(pixel.pixelId), by: user.name },
    });

    return NextResponse.json({ success: true, deleted: true });
  } catch (error: any) {
    return apiErrorResponse(error);
  }
}
