import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { courierScope } from '@/lib/couriers/scope';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { zodMessage } from '@/lib/zod-message';

/**
 * Delivery fee table: one row per courier per country per region.
 *
 *   GET  /api/settings/delivery-fees?courier=
 *   PUT  /api/settings/delivery-fees   upsert one row
 *
 * The table is the source for new shipments only. Orders keep the fee they
 * were shipped with — changing a row never rewrites a live order, and every
 * change is written to the audit log.
 */

const upsertSchema = z.object({
  deliveryProviderId: z.string().uuid(),
  regionId: z.string().uuid(),
  fee: z.number().min(0).max(1_000_000),
  /**
   * ABSENT IS A THIRD ANSWER, AND NEITHER FIELD CARRIES A `.default()`.
   *
   * The form used to post `Number(box) || 0`, so an empty box and a typed
   * zero arrived here as the same number and this endpoint could not tell
   * them apart. An empty box now OMITS the field, and `undefined` means
   * «not stated» — `stated` below is the one place that decides what that
   * writes.
   *
   * A `.default(3)` here would be a SECOND copy of a number
   * `prisma/schema.prisma` already holds (`lateThresholdDays Int
   * @default(3)`, `returnFee Decimal @default(0)`), and two copies of one
   * fact is what `2aa703a` and `600407e` spent a day deleting. So the
   * defaults are not written down here at all: an omitted field is omitted
   * from the `create` too, and the column applies the one default there is.
   */
  lateThresholdDays: z.number().int().min(0).max(90).optional(),
  returnFee: z.number().min(0).max(1_000_000).optional(),
  /**
   * THE COURIER'S OWN ID FOR THIS REGION — «انا ليش ما بقدر ادخل الرموز؟».
   *
   * It was read-only, filled only by a script on the server, so a seller holding the courier's own list could not type
   * it in. Typed here now, from that list: absent keeps what is stored, a number writes it, `null` clears it. A
   * positive whole number — their API refuses anything else.
   */
  courierCityId: z.number().int().positive().max(2_147_483_647).nullable().optional(),
  isActive: z.boolean().default(true),
  /** Required when an existing fee changes — written to the audit log. */
  reason: z.string().trim().max(300).optional(),
});

export async function GET(req: Request) {
  try {
    const { companyId, countryId, storeId } = await requireContext();
    await requirePermission('settings.view');

    const courier = new URL(req.url).searchParams.get('courier');

    const [providers, regions, fees] = await Promise.all([
      db.deliveryProvider.findMany({
        // Fees belong to the store's own contract with the courier.
        where: { ...courierScope(companyId, storeId), isActive: true },
        select: { id: true, name: true, code: true },
      }),
      db.region.findMany({ where: { countryId, isActive: true }, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
      db.deliveryFee.findMany({
        where: { companyId, countryId, ...(courier ? { deliveryProviderId: courier } : {}) },
        select: { id: true, deliveryProviderId: true, regionId: true, fee: true, lateThresholdDays: true, returnFee: true, isActive: true, courierCityId: true },
      }),
    ]);

    return NextResponse.json({
      providers,
      regions,
      fees: fees.map((f) => ({ ...f, fee: Number(f.fee), returnFee: Number(f.returnFee) })),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(req: Request) {
  try {
    const { user, companyId, countryId } = await requireContext();
    await requirePermission('settings.delivery_fees');

    const parsed = upsertSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }
    const input = parsed.data;

    const [provider, region] = await Promise.all([
      db.deliveryProvider.findFirst({ where: { id: input.deliveryProviderId, companyId }, select: { id: true, name: true } }),
      db.region.findFirst({ where: { id: input.regionId, countryId }, select: { id: true, name: true } }),
    ]);
    if (!provider) return NextResponse.json({ error: 'شركة الشحن غير موجودة' }, { status: 404 });
    if (!region) return NextResponse.json({ error: 'المحافظة غير موجودة في هذا البلد' }, { status: 404 });

    const existing = await db.deliveryFee.findFirst({
      where: { deliveryProviderId: input.deliveryProviderId, regionId: input.regionId },
    });

    // Changing an existing fee is an override: it needs a stated reason.
    if (existing && Number(existing.fee) !== input.fee && !input.reason) {
      return NextResponse.json(
        { error: 'تغيير أجرة قائمة يتطلب ذكر السبب', code: 'REASON_REQUIRED' },
        { status: 400 }
      );
    }

    /**
     * WHAT «NOT STATED» WRITES — and the two writes answer it differently.
     *
     * On an UPDATE the field is left out of `data`, so Prisma does not
     * touch the column and the stored value survives. That is the real
     * damage this fixes: an empty late-threshold box used to post 0 and
     * overwrite a courier’s real 3 with «never late», silently.
     *
     * On a CREATE it is left out of `data` as well, so the column default
     * in `prisma/schema.prisma` decides. That is the ONE copy of each
     * number, and it is why no literal 3 and no literal 0 appear in this
     * file or in the browser any more.
     *
     * A STATED ZERO IS STILL WRITTEN, because `0` is not `undefined`: a
     * courier whose late threshold is genuinely zero («never call these
     * late») and one whose return fee is genuinely zero («they charge us
     * nothing for a return») each record what they mean, and the tracking
     * screen now says so rather than showing a blank.
     */
    const stated = {
      ...(input.lateThresholdDays === undefined ? {} : { lateThresholdDays: input.lateThresholdDays }),
      ...(input.returnFee === undefined ? {} : { returnFee: input.returnFee }),
      ...(input.courierCityId === undefined ? {} : { courierCityId: input.courierCityId }),
    };

    const saved = existing
      ? await db.deliveryFee.update({
          where: { id: existing.id },
          data: {
            fee: input.fee,
            ...stated,
            isActive: input.isActive,
          },
        })
      : await db.deliveryFee.create({
          data: {
            companyId,
            countryId,
            deliveryProviderId: input.deliveryProviderId,
            regionId: input.regionId,
            fee: input.fee,
            ...stated,
            isActive: input.isActive,
          },
        });

    await logAudit({
      companyId,
      userId: user.id,
      action: existing ? 'DELIVERY_FEE_UPDATED' : 'DELIVERY_FEE_CREATED',
      entity: 'DeliveryFee',
      entityId: saved.id,
      previousData: existing
        ? { fee: Number(existing.fee), lateThresholdDays: existing.lateThresholdDays, returnFee: Number(existing.returnFee), courierCityId: existing.courierCityId }
        : undefined,
      // READ OFF THE SAVED ROW, NOT OFF THE REQUEST. A field the request
      // left out is decided by the column (on a create) or kept as it was
      // (on an update), so logging `input.lateThresholdDays` would write
      // `null` into the audit trail for a row that holds 3.
      newData: {
        courier: provider.name, region: region.name,
        fee: Number(saved.fee), lateThresholdDays: saved.lateThresholdDays, returnFee: Number(saved.returnFee),
        courierCityId: saved.courierCityId,
        reason: input.reason ?? null,
      },
    });

    return NextResponse.json({ fee: { ...saved, fee: Number(saved.fee), returnFee: Number(saved.returnFee) } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
