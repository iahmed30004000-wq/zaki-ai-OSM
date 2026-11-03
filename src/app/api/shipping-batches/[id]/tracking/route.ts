import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { can } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import {
  MAX_PASTED_LINES, MAX_PASTED_TEXT, countOutcomes, parsePastedBarcodes, pastedBarcodes, planBarcodes, type LineResult,
} from '@/lib/batch-barcodes';

/**
 * POST /api/shipping-batches/:id/tracking — «لصق الباركودات» (RV165, the owner 3/11).
 *
 * The courier's barcodes of a batch, pasted as lines «رقم الطلب, الباركود» (our number or our reference; comma, tab or
 * spaces between). For a batch in ANY state that has parcels — above all one already handed over, which the dispatch
 * refuses for good (`BATCH_NOT_READY`) and whose orders the order's own door no longer takes a barcode for.
 *
 * Body: `{ text: string, dryRun?: boolean, overwrite?: boolean }`.
 *   · `dryRun` («تحقّق») answers what each line WOULD do and writes nothing.
 *   · `overwrite` lets a line replace a DIFFERENT barcode already on the order; without it that line is refused
 *     («عليه باركود تاني»).
 * Answer: `{ dryRun, batchNumber, counts: { written, unchanged, refused }, lines: LineResult[] }` — one result per pasted line.
 *
 * The key is the dispatch's own, `ops.ship`: this is the dispatch's job (putting the courier's barcode on the parcel), done
 * by hand. The batch is read inside the session's company and store, and only ITS parcels can be named. The write is one
 * transaction: every barcode is written on the condition that the order still holds what was read (a dispatch or a
 * colleague that wrote a moment ago stops the whole paste), with an activity row and an audit row per order changed.
 * Only `trackingNumber` (and the order's version) is written — no money, no status, no stock.
 */

const NO_KEY = 'لصق باركودات الشركة ليس من صلاحيّاتك — تحتاج «إنشاء الشحنات». اطلبها من مدير النظام إن كانت من عملك.';
const NO_SUCH_BATCH = 'الدفعة غير موجودة. أعد تحميل القائمة.';
const EMPTY = 'الدفعة فاضية — ما في طرد ينكتب عليه باركود.';
const BAD_BODY = 'الصق سطر واحد على الأقل: رقم الطلب وبعده الباركود.';
const TOO_MANY = `اللصقة أطول من ${MAX_PASTED_LINES} سطر — قسّمها.`;
const MOVED = 'تغيّر باركود طلب من الدفعة أثناء الحفظ — ما انكتب شي. اضغط «تحقّق» من جديد.';

const schema = z.object({
  text: z.string().max(MAX_PASTED_TEXT),
  dryRun: z.boolean().optional(),
  overwrite: z.boolean().optional(),
});

/** A barcode of the batch changed between the plan and the write: nothing of the paste is kept. */
class BarcodeMoved extends Error {}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId, storeId } = await requireContext();
    if (!can(user, 'ops.ship')) return NextResponse.json({ error: NO_KEY, errorAr: NO_KEY }, { status: 403 });

    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: BAD_BODY, errorAr: BAD_BODY, code: 'BAD_BODY' }, { status: 400 });
    const lines = parsePastedBarcodes(parsed.data.text);
    if (lines.length === 0) return NextResponse.json({ error: BAD_BODY, errorAr: BAD_BODY, code: 'NOTHING_PASTED' }, { status: 400 });
    if (lines.length > MAX_PASTED_LINES) return NextResponse.json({ error: TOO_MANY, errorAr: TOO_MANY, code: 'TOO_MANY_LINES' }, { status: 400 });
    const dryRun = parsed.data.dryRun === true;
    const overwrite = parsed.data.overwrite === true;

    const batch = await db.shippingBatch.findFirst({
      where: { id, companyId, storeId },
      select: { id: true, batchNumber: true },
    });
    if (!batch) return NextResponse.json({ error: NO_SUCH_BATCH, errorAr: NO_SUCH_BATCH }, { status: 404 });

    const barcodes = pastedBarcodes(lines);
    /** The plan, read with whichever client is given: the database for «تحقّق», the transaction for the write. */
    const plan = async (reader: Pick<typeof db, 'order'>) => {
      const members = await reader.order.findMany({
        where: { shippingBatchId: batch.id, companyId, storeId },
        select: { id: true, orderNumber: true, merchantRef: true, trackingNumber: true },
      });
      const holders = barcodes.length
        ? await reader.order.findMany({
            where: { companyId, trackingNumber: { in: barcodes } },
            select: { id: true, orderNumber: true, trackingNumber: true, storeId: true },
          })
        : [];
      return { members, results: planBarcodes({ lines, members, holders, storeId, overwrite }) };
    };

    let results: LineResult[];
    if (dryRun) {
      const { members, results: planned } = await plan(db);
      if (members.length === 0) return NextResponse.json({ error: EMPTY, errorAr: EMPTY, code: 'EMPTY_BATCH' }, { status: 409 });
      results = planned;
    } else {
      let empty = false;
      try {
        results = await db.$transaction(async (tx) => {
          const { members, results: planned } = await plan(tx);
          if (members.length === 0) {
            empty = true;
            return planned;
          }
          const toWrite = planned.filter((r) => r.outcome === 'written');
          for (const r of toWrite) {
            // On the condition that the order still holds what was read, and is still in this batch.
            const won = await tx.order.updateMany({
              where: { id: r.orderId!, companyId, storeId, shippingBatchId: batch.id, trackingNumber: r.previous ?? null },
              data: { trackingNumber: r.barcode, version: { increment: 1 } },
            });
            if (won.count !== 1) throw new BarcodeMoved();
          }
          if (toWrite.length > 0) {
            await tx.orderActivity.createMany({
              data: toWrite.map((r) => ({
                companyId, orderId: r.orderId!, userId: user.id, action: 'TRACKING_PASTED',
                metadata: JSON.stringify({
                  updatedBy: user.name, inBatch: batch.batchNumber, barcodeAfter: r.barcode,
                  ...(r.previous ? { barcodeBefore: r.previous } : {}),
                }),
              })),
            });
            await tx.auditLog.createMany({
              data: toWrite.map((r) => ({
                companyId, userId: user.id, action: 'ORDER_TRACKING_PASTED', entity: 'Order', entityId: r.orderId!,
                previousData: JSON.stringify({ trackingNumber: r.previous ?? null }),
                newData: JSON.stringify({
                  trackingNumber: r.barcode, batchId: batch.id, batchNumber: batch.batchNumber, overwrite, by: user.name,
                }),
              })),
            });
          }
          return planned;
        });
      } catch (e) {
        if (e instanceof BarcodeMoved) {
          return NextResponse.json({ error: MOVED, errorAr: MOVED, code: 'BARCODE_MOVED' }, { status: 409 });
        }
        throw e;
      }
      if (empty) return NextResponse.json({ error: EMPTY, errorAr: EMPTY, code: 'EMPTY_BATCH' }, { status: 409 });
    }

    return NextResponse.json({ dryRun, batchNumber: batch.batchNumber, counts: countOutcomes(results), lines: results });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
