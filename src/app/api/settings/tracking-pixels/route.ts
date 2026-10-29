import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireCompanyTenant } from '@/lib/auth';
import { logAudit } from '@/lib/audit';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { PIXEL_PUBLIC_SELECT } from '@/lib/tracking/tracking-config';
import { maskPixelId, TRACKING_PLATFORMS, TRACKING_SCOPES } from '@/lib/tracking/tracking-types';
import { pixelIdHint, validateTrackingPixelId } from '@/lib/tracking/tracking-validation';
import { zodMessage } from '@/lib/zod-message';
import { resolvePixelScope } from '@/lib/tracking/pixel-scope';

/**
 * Global tracking pixels — settings-scoped resource.
 *   GET  /api/settings/tracking-pixels   (settings.view)
 *   POST /api/settings/tracking-pixels   (settings.tracking)
 *
 * Security: companyId is ALWAYS derived from the session (never from the
 * body); platform/scope are allowlisted enums; the Pixel ID is validated
 * per platform server-side and fails closed. The stored value is a bare
 * ID — no script/HTML/tokens can ever be stored here.
 */

const createSchema = z.object({
  platform: z.enum(TRACKING_PLATFORMS),
  name: z.string().trim().min(2).max(80),
  pixelId: z.string().trim().min(4).max(64),
  scope: z.enum(TRACKING_SCOPES).default('GLOBAL'),
  enabled: z.boolean().default(true),
  /**
   * WHOSE VISITORS — «فصل البيكسل لكل متجر وبلد». At most one of the two;
   * neither means the company's own, everywhere it sells.
   *
   * Nullable as well as optional because a `<select>` sends `''` for its
   * first option and a form that is CHANGING a pixel back to company-wide
   * has to be able to say so. `resolvePixelScope` normalises both.
   */
  storeId: z.string().uuid().nullish(),
  countryId: z.string().uuid().nullish(),
});

export async function GET() {
  try {
    const { companyId } = await requireCompanyTenant();
    await requirePermission('settings.view');

    /*
     * THE PIXELS AND WHAT THEY MAY BE SCOPED TO, IN ONE ANSWER.
     *
     * The screen needs the shops and the countries to offer a choice, and
     * `/api/geo/stores` would have done — behind `geo.view`, a permission
     * this screen has no other reason to hold. A settings screen that
     * demands a second permission to draw a dropdown is a screen that goes
     * blank for somebody who may legitimately edit pixels.
     *
     * Names only. Nothing here is a secret and nothing here is a figure.
     */
    const [pixels, stores, countries] = await Promise.all([
      db.trackingPixel.findMany({
        where: { companyId },
        orderBy: [{ platform: 'asc' }, { createdAt: 'asc' }],
        select: PIXEL_PUBLIC_SELECT,
      }),
      db.store.findMany({
        where: { companyId },
        orderBy: { name: 'asc' },
        select: { id: true, name: true, countryId: true },
      }),
      db.country.findMany({
        where: { companyId },
        orderBy: { name: 'asc' },
        select: { id: true, name: true },
      }),
    ]);
    return NextResponse.json({ pixels, stores, countries });
  } catch (error: any) {
    return apiErrorResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    const { user, companyId } = await requireCompanyTenant();
    await requirePermission('settings.tracking');

    const parsed = createSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: zodMessage(parsed.error) },
        { status: 400 }
      );
    }
    const { platform, name, scope, enabled } = parsed.data;

    // Server-side Pixel ID validation — fail closed (no storage, no injection).
    const pixelId = validateTrackingPixelId(platform, parsed.data.pixelId);
    if (!pixelId) {
      return NextResponse.json({ error: pixelIdHint(platform) }, { status: 400 });
    }

    /*
     * ONE ROW PER PIXEL ID, AND THE ROW SAYS WHERE IT FIRES.
     *
     * The unique index is unchanged by the scope columns on purpose. The
     * same Meta pixel scoped two ways would be two rows claiming one ad
     * account's data, and nothing could then say which one a visit belongs
     * to. A seller who wants one pixel across several shops picks the
     * country scope, or the company-wide one.
     */
    const clash = await db.trackingPixel.findFirst({ where: { companyId, platform, pixelId } });
    if (clash) {
      return NextResponse.json({ error: 'هذا البكسل مسجل مسبقًا لنفس المنصة' }, { status: 409 });
    }

    // A store or country id from a BROWSER. Looked up with the company
    // before it goes near the column, or a real store belonging to somebody
    // else would pass the foreign key and the pixel would report their
    // sales into this company's ad account.
    const where = await resolvePixelScope(companyId, parsed.data);
    if (!where.ok) return NextResponse.json({ error: where.error }, { status: 400 });

    const pixel = await db.trackingPixel.create({
      data: {
        companyId, platform, name, pixelId, scope, enabled,
        storeId: where.storeId, countryId: where.countryId,
      },
      select: PIXEL_PUBLIC_SELECT,
    });

    await logAudit({
      companyId,
      userId: user.id,
      action: 'TRACKING_PIXEL_CREATED',
      entity: 'TrackingPixel',
      entityId: pixel.id,
      // Masked ID in audit — the platform/name/action stay readable.
      newData: { platform, name, scope, enabled, pixelId: maskPixelId(pixelId), by: user.name },
    });

    return NextResponse.json({ success: true, pixel });
  } catch (error: any) {
    return apiErrorResponse(error);
  }
}
