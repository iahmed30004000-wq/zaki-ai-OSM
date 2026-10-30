import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { courierScope } from '@/lib/couriers/scope';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { encryptJson, decryptJson, encryptionAvailable, secretHint } from '@/lib/secrets';
import { logesTechsFromCredentials, type LogesTechsCredentials } from '@/lib/couriers/logestechs';
import { zodMessage } from '@/lib/zod-message';
import { count } from '@/lib/numeric-input';

/**
 * A courier's account on its shipping platform.
 *
 * The password is WRITE-ONLY. It goes in encrypted and never comes back out:
 * GET reports that an account exists, when it was saved and by whom, and the
 * last three characters of the login so you can tell which account it is.
 * An endpoint that can return a password is an endpoint that will, one day,
 * return it to the wrong person.
 *
 * Saving is refused outright when no encryption key is configured, rather
 * than falling back to plaintext. A visible failure beats an invisible one.
 */

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * THESE IDS ARE ADDRESSES AT SOMEBODY ELSE'S SYSTEM — READ THEM STRICTLY.
 *
 * They were `z.coerce.number()`, which IS `Number()`: measured on this
 * build, `'0x10'` → 16, `'0b11'` → 3, `'0o17'` → 15, `['5']` → 5,
 * `true` → 1. The judgement on the audit was «fails at the courier, not in
 * our books». That is NOT what these two do, and the adapter says so:
 *
 *   `originCityId` is sent as `originAddress.cityId` on every shipment
 *   (`couriers/logestechs.ts`, `createShipment`). A valid-but-wrong city id
 *   does not fail at the courier at all — the parcel is CREATED, with a
 *   barcode, for collection from a city we are not in. It then fails as a
 *   pickup that never happened, days later, against the courier's name.
 *
 *   `companyId` is a path segment on two of their endpoints —
 *   `POST /guests/{companyId}/packages/pdf` and
 *   `PUT  /guests/{companyId}/packages/cancel?barcode=` — and the cancel is
 *   a WRITE. It is ALSO the key of our own outbound rate-limit bucket
 *   (`paced('logestechs:' + companyId)`), whose comment says crossing their
 *   limit suspends the account for a working day. So a mis-read id is
 *   already wrong on this side of the wire, before their server has an
 *   opinion. What their server does with another merchant's id is NOT
 *   established here — it would take a call to their API to find out, and
 *   this fix does not depend on the answer.
 *
 * BOUNDS, AND WHERE THEY COME FROM. None of these is a column: they live
 * inside the encrypted `apiCredentials` blob, so `schema.prisma` declares
 * nothing. The only other declarations anywhere are
 * `logesTechsConfigFromEnv` and `logesTechsFromCredentials`, and both ask
 * for no more than `Number.isFinite` — no ceiling at all. So:
 *
 *   min 1  on companyId / originCityId — kept exactly as it was; an account
 *          or city numbered zero is not an account or a city.
 *   min 0  on the three type ids — they had NO minimum, so negatives passed.
 *          Zero is kept reachable rather than tightened to 1 because nothing
 *          in the adapter or their documented request body says whether 0 is
 *          a valid type id, and refusing it would break a working account to
 *          close a hole that negatives already cover.
 *   max 2_147_483_647 on all five — they had none, so `'1e15'` stored. This
 *          is the widest a conventional platform's integer id can be, so it
 *          refuses nothing a real courier id could ever be while refusing
 *          the junk. A ceiling also matters HERE specifically because
 *          `companyId` is interpolated into a URL and used as a bucket key.
 */
const credentialsSchema = z.object({
  email: z.string().min(3).max(200),
  password: z.string().min(1).max(200),
  companyId: count(2_147_483_647, 1),
  originCityId: count(2_147_483_647, 1),
  senderName: z.string().min(1).max(120),
  senderPhone: z.string().min(5).max(40),
  senderBusiness: z.string().max(120).optional(),
  originAddress: z.string().max(200).optional(),
  originAddress2: z.string().max(200).optional(),
  // «اتركه فارغاً للافتراضي»: an empty box is stored as nothing, so the adapter uses the official address; a typed
  // one must be an absolute http(s) address — a bare path or a typo would send every parcel nowhere.
  baseUrl: z
    .string()
    .trim()
    .max(300)
    .optional()
    .transform((v) => (v ? v : undefined))
    .refine((v) => v === undefined || /^https?:\/\/[^\s/]+\.[^\s]+$/i.test(v), {
      message: 'رابط الـAPI لازم يبلّش بـ https:// — أو اتركه فاضي للعنوان الرسمي',
    }),
  serviceTypeId: count(2_147_483_647).optional(),
  vehicleTypeId: count(2_147_483_647).optional(),
  parcelTypeId: count(2_147_483_647).optional(),
});

/**
 * The courier, if it belongs to this store.
 *
 * This one holds an API login. Every other courier route already scopes
 * through courierScope; this did not, so a store could read the shape of
 * another store's integration — and write over it.
 */
async function loadProvider(id: string, companyId: string, storeId: string | null) {
  return db.deliveryProvider.findFirst({
    where: { id, ...courierScope(companyId, storeId) },
    select: {
      id: true,
      name: true,
      adapterCode: true,
      code: true,
      apiEnabled: true,
      apiCredentials: true,
      credentialsUpdatedAt: true,
      credentialsUpdatedById: true,
    },
  });
}

/** What a screen may know: that an account exists, not what it is. */
export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { companyId, storeId } = await requireContext();
    await requirePermission('settings.view');
    const { id } = await ctx.params;

    const provider = await loadProvider(id, companyId, storeId);
    if (!provider) return NextResponse.json({ error: 'شركة الشحن غير موجودة' }, { status: 404 });

    const stored = decryptJson<LogesTechsCredentials>(provider.apiCredentials);
    const savedBy = provider.credentialsUpdatedById
      ? await db.user.findUnique({
          where: { id: provider.credentialsUpdatedById },
          select: { name: true },
        })
      : null;

    return NextResponse.json({
      providerId: provider.id,
      name: provider.name,
      adapterCode: provider.adapterCode || provider.code,
      apiEnabled: provider.apiEnabled,
      encryptionAvailable: encryptionAvailable(),
      hasCredentials: Boolean(provider.apiCredentials),
      // Unreadable credentials are reported, not hidden: the courier is
      // silently manual until someone is told why.
      readable: provider.apiCredentials ? stored !== null : null,
      savedAt: provider.credentialsUpdatedAt,
      savedBy: savedBy?.name ?? null,
      // Never the password. Enough of the login to recognise the account.
      emailHint: stored ? secretHint(stored.email) : null,
      accountCompanyId: stored?.companyId ?? null,
      senderName: stored?.senderName ?? null,
      originCityId: stored?.originCityId ?? null,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(req: Request, ctx: Ctx) {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('settings.manage');
    const { id } = await ctx.params;

    const provider = await loadProvider(id, companyId, storeId);
    if (!provider) return NextResponse.json({ error: 'شركة الشحن غير موجودة' }, { status: 404 });

    if (!encryptionAvailable()) {
      return NextResponse.json(
        {
          error:
            'مفتاح التشفير غير مُهيّأ على الخادم (APP_ENCRYPTION_KEY) — لن تُحفظ كلمة المرور بلا تشفير.',
          code: 'ENCRYPTION_KEY_MISSING',
        },
        { status: 503 }
      );
    }

    const parsed = credentialsSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: zodMessage(parsed.error) },
        { status: 400 }
      );
    }

    // Would these credentials actually produce a working adapter? Saying so
    // now beats discovering it on the first parcel of the day.
    if (!logesTechsFromCredentials(parsed.data as LogesTechsCredentials)) {
      return NextResponse.json({ error: 'الحساب غير مكتمل — راجع الحقول المطلوبة' }, { status: 400 });
    }

    await db.deliveryProvider.update({
      where: { id: provider.id },
      data: {
        apiCredentials: encryptJson(parsed.data),
        credentialsUpdatedAt: new Date(),
        credentialsUpdatedById: user.id,
      },
    });

    // The audit records THAT it changed and who changed it. Never the values:
    // an audit log that holds passwords is a second place to steal them from.
    await logAudit({
      companyId,
      userId: user.id,
      action: 'COURIER_CREDENTIALS_SAVED',
      entity: 'DeliveryProvider',
      entityId: provider.id,
      newData: {
        provider: provider.name,
        accountCompanyId: parsed.data.companyId,
        emailHint: secretHint(parsed.data.email),
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** Forget the account. The courier falls back to manual on the next parcel. */
export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('settings.manage');
    const { id } = await ctx.params;

    const provider = await loadProvider(id, companyId, storeId);
    if (!provider) return NextResponse.json({ error: 'شركة الشحن غير موجودة' }, { status: 404 });

    await db.deliveryProvider.update({
      where: { id: provider.id },
      data: { apiCredentials: null, credentialsUpdatedAt: null, credentialsUpdatedById: null },
    });

    await logAudit({
      companyId,
      userId: user.id,
      action: 'COURIER_CREDENTIALS_CLEARED',
      entity: 'DeliveryProvider',
      entityId: provider.id,
      newData: { provider: provider.name },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
