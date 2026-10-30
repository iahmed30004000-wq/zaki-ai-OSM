import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireCompanyTenant } from '@/lib/auth';
import { requireContext } from '@/lib/geo-context';
import { courierScope } from '@/lib/couriers/scope';
import { logAudit } from '@/lib/audit';
import { requirePermission } from '@/lib/authorization';
import { zodMessage } from '@/lib/zod-message';
import { ruleFor } from '@/lib/phone-rules';

const providerSchema = z.object({
  name: z.string().trim().min(2).max(80),
  code: z.string().trim().min(2).max(30).regex(/^[A-Z0-9_-]+$/i, 'Code: letters/numbers only'),
  // A مندوب delivers immediately and is settled by hand; a company has its
  // own pipeline and sends statements. The difference decides whether a
  // parcel may be moved away without raising a replacement order.
  kind: z.enum(['COMPANY', 'AGENT']).default('COMPANY'),
  phone: z.string().trim().max(25).optional(),
  email: z.string().trim().email().optional(),
  address: z.string().trim().max(200).optional(),
  notes: z.string().trim().max(500).optional(),
  /**
   * Which platform this courier runs on. A courier is not a platform:
   * "Basha Delivery" is who ships, "LOGESTECHS" is what they ship on, and
   * two different couriers can run on the same one under separate accounts.
   */
  adapterCode: z.enum(['LOGESTECHS', 'MANUAL']).nullish(),
});

/** GET /api/delivery-providers — company-scoped list.
 *  Tenant-only on purpose (no permission gate): reference data needed by the
 *  shipping UI for any employee who handles delivery. */
export async function GET() {
  try {
    const { companyId, storeId } = await requireContext();
    const providers = await db.deliveryProvider.findMany({
      // This store's couriers only. Each store is its own business with its
      // own account at the courier; a row shown in two stores is one login
      // two sets of books would both draw on.
      where: { OR: [courierScope(companyId, storeId), { companyId, storeId: null }] },
      orderBy: { createdAt: 'desc' },
      // apiBaseUrl is internal config — not exposed broadly
      select: {
        id: true, name: true, code: true, kind: true, phone: true, email: true,
        address: true, isActive: true, createdAt: true, storeId: true,
        // Which platform it ships on, and whose store it is: the two things
        // the list could not answer, which is why the screen could not either.
        adapterCode: true, apiEnabled: true,
        store: { select: { name: true } },
      },
    });

    /**
     * HOW MANY REGIONS THIS COURIER IS PRICED FOR — and how many exist.
     *
     * A courier with no fee rows cannot ship, and until now the only way
     * to discover that was to try to create a shipment and be refused, or
     * to go and read a different screen. The list said a courier was
     * «نشط» while it was unusable.
     *
     * Counted for the CURRENT country, because a fee is per region and
     * regions belong to a country: «٨ من ١٢» is an answer, «٨» is not.
     */
    const { country } = await requireContext();
    const [priced, regions] = await Promise.all([
      db.deliveryFee.groupBy({
        by: ['deliveryProviderId'],
        where: { companyId, countryId: country.id, isActive: true },
        _count: { _all: true },
      }),
      db.region.count({ where: { countryId: country.id } }),
    ]);
    const pricedBy = new Map(priced.map((r) => [r.deliveryProviderId, r._count._all]));

    return NextResponse.json({
      providers: providers.map((p) => ({ ...p, pricedRegions: pricedBy.get(p.id) ?? 0 })),
      totalRegions: regions,
      // The country's calling code: a courier's number is typed local, and WhatsApp needs it in full.
      dialCode: ruleFor(country.code)?.dialCode ?? null,
    });
  } catch (error: any) {
    return NextResponse.json({ error: 'حدث خطأ داخلي' }, { status: 400 });
  }
}

/** POST /api/delivery-providers — create (settings.edit or SUPER_ADMIN/COMPANY_ADMIN) */
export async function POST(req: Request) {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('settings.edit');
    const parsed = providerSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }
    const { name, code, kind, phone, email, address, notes, adapterCode } = parsed.data;

    // The store comes from the session, never from the request body: a body
    // that names its own store is a body that can name someone else's.
    if (!storeId) {
      return NextResponse.json({ error: 'اختر المتجر أولاً', code: 'STORE_REQUIRED' }, { status: 400 });
    }

    const clash = await db.deliveryProvider.findFirst({ where: { companyId, code: code.toUpperCase() } });
    if (clash) return NextResponse.json({ error: 'الرمز مستعمل لشركة أخرى', code: 'CODE_TAKEN' }, { status: 409 });

    const provider = await db.deliveryProvider.create({
      data: {
        companyId, name, code: code.toUpperCase(), kind, phone, email, address, notes,
        storeId,
        // MANUAL is "no platform", which is the absence of an adapter rather
        // than an adapter named MANUAL — storing the word would make
        // adapterFor look for one that does not exist.
        adapterCode: adapterCode && adapterCode !== 'MANUAL' ? adapterCode : null,
        apiEnabled: Boolean(adapterCode && adapterCode !== 'MANUAL'),
      },
      // Same reason as the PATCH: this row can hold an encrypted account,
      // and returning it whole is how ciphertext reaches a browser.
      select: {
        id: true, name: true, code: true, kind: true, phone: true,
        email: true, address: true, notes: true, isActive: true, createdAt: true, storeId: true,
        adapterCode: true, apiEnabled: true,
      },
    });

    await logAudit({
      companyId, userId: user.id, action: 'DELIVERY_PROVIDER_CREATED',
      entity: 'DeliveryProvider', entityId: provider.id, newData: { name, code, kind },
    });

    return NextResponse.json({ success: true, provider });
  } catch (error: any) {
    return NextResponse.json({ error: 'حدث خطأ داخلي' }, { status: 400 });
  }
}
