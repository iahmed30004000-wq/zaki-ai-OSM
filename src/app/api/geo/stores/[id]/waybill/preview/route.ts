import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireCompanyTenant } from '@/lib/auth';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { renderLabelSheet, tierFor, type LabelView } from '@/lib/label-sheet';
import { DESIGN_SAMPLES } from '@/lib/waybill-design-samples';
import { qrSvg } from '@/lib/waybill';
import {
  isOwnWaybillLogo, readWaybillPrint, resolveWaybillPrint, storeEntry, validateWaybillPrint,
} from '@/lib/waybill-print-settings';

/**
 * POST /api/geo/stores/[id]/waybill/preview — the LIVE PREVIEW of «البوليصة المطبوعة» (25/11, F15).
 *
 * Body: `{ hide, logo, design?, width, height, sheetWidth?, sheetHeight? }` — the choice being edited, not yet saved,
 * and the paper this device prints on. A new design is previewed on two made-up orders: one product, and several. Answers the page the print door would print, drawn by the SAME renderer
 * (`renderLabelSheet`), so what is previewed is what prints. One made-up order: no customer of the store is read, and
 * the page is in «PDF» mode, so it can commit nothing. The screen shows it in a frame that runs no script.
 * Key `geo.view` — the key that opens the card.
 */

interface Ctx {
  params: Promise<{ id: string }>;
}

const paper = z.object({
  width: z.number().int().min(40).max(300).default(100),
  height: z.number().int().min(40).max(300).default(150),
  sheetWidth: z.number().int().min(40).max(500).optional(),
  sheetHeight: z.number().int().min(40).max(500).optional(),
});

const refuse = (status: number, code: string, errorAr: string) => NextResponse.json({ error: errorAr, errorAr, code }, { status });

/** A made-up order, the same on every preview. Two items and a note, so every part has something to show. */
const SAMPLE: Omit<LabelView, 'qrSvg'> = {
  orderId: 'preview',
  courier: 'شركة الشحن',
  ref: 'SY-10001',
  courierCode: 'SY-10001',
  name: 'اسم الزبون',
  phones: ['0900000000'],
  place: 'المحافظة — المنطقة، الشارع',
  items: [{ name: 'المنتج الأول', qty: 2 }, { name: 'المنتج الثاني', qty: 1, addOn: true }],
  note: 'ملاحظة الزبون على الطلب',
  cod: '0.00',
};

/** The print page's own toolbar and setup line are for the person printing; a preview shows the paper only. */
const PAPER_ONLY = '<style>.bar, .setup { display: none; }</style></head>';

export async function POST(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const { companyId } = await requireCompanyTenant();
    await requirePermission('geo.view');
    const store = await db.store.findFirst({ where: { id, companyId }, select: { id: true, name: true, logo: true, supportPhone: true } });
    if (!store) return refuse(404, 'STORE_NOT_FOUND', 'المتجر غير موجود');

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const size = paper.safeParse({ width: body?.width, height: body?.height, sheetWidth: body?.sheetWidth, sheetHeight: body?.sheetHeight });
    if (!size.success) return refuse(400, 'BAD_SIZE', 'مقاس الورق لازم يكون بالمليمتر، من 40 لـ300.');

    const stored = storeEntry(await readWaybillPrint(db, companyId), store.id);
    const ownLogo = isOwnWaybillLogo(stored?.ownLogo, companyId, store.id) ? stored!.ownLogo : undefined;
    const check = validateWaybillPrint(
      { hide: body?.hide, logo: body?.logo, ...(body?.design !== undefined ? { design: body.design } : {}) },
      { ownLogo: Boolean(ownLogo) }
    );
    if (!check.ok) return refuse(400, check.code, check.errorAr);

    const choice = resolveWaybillPrint(
      { v: 1, stores: { [store.id]: { ...check.value, ...(ownLogo ? { ownLogo } : {}) } } },
      { companyId, storeId: store.id },
      store.logo
    );
    // As the print door: a sticker too small for the ready designs shows, and prints, the current waybill.
    const design = tierFor(size.data) === 'tiny' ? undefined : choice.design;
    const samples = design ? DESIGN_SAMPLES : [SAMPLE];
    const labels: LabelView[] = await Promise.all(samples.map(async (s) => ({ ...s, qrSvg: await qrSvg(s.ref) })));
    const html = renderLabelSheet(labels, size.data, {
      store: { name: store.name, logoUrl: choice.logoUrl, supportPhone: store.supportPhone ?? null },
      ...(choice.show ? { show: choice.show } : {}),
      ...(design ? { design } : {}),
      mode: 'pdf',
      token: '-', // a preview commits nothing: no batch, no token
      stampUrl: '',
      title: 'معاينة البوليصة',
    });
    return new NextResponse(html.replace('</head>', PAPER_ONLY), {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
