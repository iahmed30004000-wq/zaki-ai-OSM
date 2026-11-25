import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireCompanyTenant } from '@/lib/auth';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { updateCompanySettings } from '@/lib/company-settings';
import {
  LOCKED_REASON, WAYBILL_ELEMENTS, WAYBILL_PRINT_DEFAULT, WAYBILL_PRINT_SETTINGS_KEY, isOwnWaybillLogo, readDocument,
  readWaybillPrint, storeEntry, validateWaybillPrint, type WaybillPrintDocument,
} from '@/lib/waybill-print-settings';

/**
 * «البوليصة المطبوعة» of ONE store (25/11, F15) — see `src/lib/waybill-print-settings.ts`.
 *
 *   GET  → { settings: { hide, logo }, ownLogo, storeLogo, elements, lockedReason }   key `geo.view`
 *   PUT  { hide, logo } → the saved choice                                            key `geo.manage`
 *
 * The same keys as the store's identity beside it (the logo door asks `geo.manage`). The store must be this
 * company's; the choice is written under that store's id only, so one store's waybill never changes another's.
 */

interface Ctx {
  params: Promise<{ id: string }>;
}

const refuse = (status: number, code: string, errorAr: string) => NextResponse.json({ error: errorAr, errorAr, code }, { status });

async function ownStore(id: string, companyId: string) {
  return db.store.findFirst({ where: { id, companyId }, select: { id: true, logo: true } });
}

export async function GET(_req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const { companyId } = await requireCompanyTenant();
    await requirePermission('geo.view');
    const store = await ownStore(id, companyId);
    if (!store) return refuse(404, 'STORE_NOT_FOUND', 'المتجر غير موجود');

    const entry = storeEntry(await readWaybillPrint(db, companyId), store.id);
    const ownLogo = isOwnWaybillLogo(entry?.ownLogo, companyId, store.id) ? entry!.ownLogo! : null;
    return NextResponse.json({
      settings: { hide: entry?.hide ?? WAYBILL_PRINT_DEFAULT.hide, logo: entry?.logo ?? WAYBILL_PRINT_DEFAULT.logo },
      ownLogo,
      storeLogo: store.logo ?? null,
      elements: WAYBILL_ELEMENTS,
      lockedReason: LOCKED_REASON,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const { user, companyId } = await requireCompanyTenant();
    await requirePermission('geo.manage');
    const store = await ownStore(id, companyId);
    if (!store) return refuse(404, 'STORE_NOT_FOUND', 'المتجر غير موجود');

    const body = await req.json().catch(() => null);
    const before = storeEntry(await readWaybillPrint(db, companyId), store.id);
    const ownLogo = isOwnWaybillLogo(before?.ownLogo, companyId, store.id) ? before!.ownLogo! : undefined;
    const check = validateWaybillPrint(body, { ownLogo: Boolean(ownLogo) });
    if (!check.ok) return refuse(400, check.code, check.errorAr);

    await updateCompanySettings<WaybillPrintDocument>(companyId, WAYBILL_PRINT_SETTINGS_KEY, (current) => {
      const doc = readDocument(current) ?? { v: 1, stores: {} };
      // Re-read inside the lock: the own logo is the upload door's, and a save never drops one it wrote meanwhile.
      const kept = storeEntry(doc, store.id)?.ownLogo;
      return {
        v: 1,
        stores: { ...doc.stores, [store.id]: { ...check.value, ...(kept ? { ownLogo: kept } : {}) } },
      };
    });
    await logAudit({
      companyId,
      userId: user.id,
      action: 'WAYBILL_PRINT_SAVED',
      entity: 'Store',
      entityId: store.id,
      previousData: { hide: before?.hide ?? [], logo: before?.logo ?? 'store' },
      newData: check.value,
    });
    return NextResponse.json({ settings: check.value });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
