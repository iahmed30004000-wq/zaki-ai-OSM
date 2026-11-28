import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireCompanyTenant } from '@/lib/auth';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { rateLimit } from '@/lib/rate-limit';
import { updateCompanySettings } from '@/lib/company-settings';
import { detectImageType, saveProductImage, validateImageFile } from '@/lib/storage';
import {
  WAYBILL_LOGO_MAX_BYTES, WAYBILL_PRINT_SETTINGS_KEY, readDocument, storeEntry, type WaybillPrintDocument,
} from '@/lib/waybill-print-settings';

/**
 * THE STORE'S OWN WAYBILL LOGO (25/11, F15) — «شعار خاص بالبوليصة».
 *
 *   POST   multipart { file } → { waybillLogo }   sets it, and picks it for the waybill
 *   DELETE                    → { waybillLogo: null }   removes it (a waybill that used it goes back to the store's logo)
 *
 * Key `geo.manage` — the key of the store's own logo door beside it (`lib/store-brand.ts`). Through the SAME storage
 * pipeline as every image (`validateImageFile` → magic-byte sniffing → `saveProductImage`: re-encoded to WebP, capped
 * at 600 px) into the store's own folder on the uploads volume, which survives a deploy. JPG, PNG and WebP only: an SVG
 * (which can carry a script) is refused by its type AND by its bytes. Served by `/api/media` — signed-in, this company
 * only, its real content type, `nosniff` — the same door the print page already accepts (`storeLogoForPrint`). It is not
 * public: only people who print see a waybill.
 */

const RATE = 20;
const WINDOW_MS = 5 * 60 * 1000;

interface Ctx {
  params: Promise<{ id: string }>;
}

const refuse = (status: number, code: string, errorAr: string) => NextResponse.json({ error: errorAr, errorAr, code }, { status });

async function ownStore(id: string, companyId: string) {
  return db.store.findFirst({ where: { id, companyId }, select: { id: true } });
}

export async function POST(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const { user, companyId } = await requireCompanyTenant();
    await requirePermission('geo.manage');
    const store = await ownStore(id, companyId);
    if (!store) return refuse(404, 'STORE_NOT_FOUND', 'المتجر غير موجود');

    const rl = rateLimit(`uploads:${user.id}`, RATE, WINDOW_MS);
    if (!rl.allowed) return refuse(429, 'TOO_MANY_UPLOADS', 'عدد محاولات رفع الصور كبير جداً، يرجى المحاولة لاحقاً');

    if (!(req.headers.get('content-type') ?? '').includes('multipart/form-data')) {
      return refuse(400, 'NOT_MULTIPART', 'ارفع الصورة كملف.');
    }
    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return refuse(400, 'NO_FILE', 'اختر صورة الشعار');
    if (file.size > WAYBILL_LOGO_MAX_BYTES) return refuse(400, 'TOO_BIG', 'الصورة أكبر من 2 ميجابايت — صغّرها وارجع ارفعها.');

    const check = validateImageFile({ mimeType: file.type || 'application/octet-stream', size: file.size });
    if (!check.valid) return refuse(400, 'BAD_TYPE', check.error ?? 'صيغة الملف غير مدعومة. المسموح: JPG, PNG, WEBP');
    const buffer = Buffer.from(await file.arrayBuffer());
    // The browser's type is a claim; the bytes are the file. An SVG or a page renamed «.png» stops here.
    if (!detectImageType(buffer)) return refuse(400, 'BAD_TYPE', 'محتوى الملف ليس صورة صالحة. المسموح: JPG, PNG, WEBP');

    const stored = await saveProductImage({
      companyId,
      productId: store.id, // the store's own folder, as its logo
      buffer,
      mimeType: file.type,
      originalName: file.name,
      maxDimension: 600,
    });

    let previous: string | undefined;
    await updateCompanySettings<WaybillPrintDocument>(companyId, WAYBILL_PRINT_SETTINGS_KEY, (current) => {
      const doc = readDocument(current) ?? { v: 1, stores: {} };
      const entry = storeEntry(doc, store.id);
      previous = entry?.ownLogo;
      return {
        v: 1,
        // The rest of the choice stays as it was — a new logo never changes the design.
        stores: { ...doc.stores, [store.id]: { hide: entry?.hide ?? [], logo: 'own', ownLogo: stored.url, ...(entry?.design ? { design: entry.design } : {}) } },
      };
    });
    await logAudit({
      companyId,
      userId: user.id,
      action: 'WAYBILL_LOGO_UPLOADED',
      entity: 'Store',
      entityId: store.id,
      previousData: { ownLogo: previous ?? null },
      newData: { ownLogo: stored.url },
    });
    return NextResponse.json({ waybillLogo: stored.url });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const { user, companyId } = await requireCompanyTenant();
    await requirePermission('geo.manage');
    const store = await ownStore(id, companyId);
    if (!store) return refuse(404, 'STORE_NOT_FOUND', 'المتجر غير موجود');

    let previous: string | undefined;
    await updateCompanySettings<WaybillPrintDocument>(companyId, WAYBILL_PRINT_SETTINGS_KEY, (current) => {
      const doc = readDocument(current) ?? { v: 1, stores: {} };
      const entry = storeEntry(doc, store.id);
      previous = entry?.ownLogo;
      if (!entry) return current === undefined ? undefined : doc;
      return {
        v: 1,
        stores: { ...doc.stores, [store.id]: { hide: entry.hide, logo: entry.logo === 'own' ? 'store' : entry.logo, ...(entry.design ? { design: entry.design } : {}) } },
      };
    });
    await logAudit({
      companyId,
      userId: user.id,
      action: 'WAYBILL_LOGO_REMOVED',
      entity: 'Store',
      entityId: store.id,
      previousData: { ownLogo: previous ?? null },
    });
    return NextResponse.json({ waybillLogo: null });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
