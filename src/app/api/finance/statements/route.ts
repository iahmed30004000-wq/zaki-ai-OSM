import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { fileHash, parseStatement, receiptGap } from '@/lib/settlement';
import { isManualDraftHash, isManualHash } from '@/lib/manual-statement-rules';
import { openLineWhere } from '@/lib/statement-open-lines';
import { roundMinor } from '@/lib/money';
import { zodMessage } from '@/lib/zod-message';

/**
 * Courier statements — step 1 of settlement.
 *
 *   GET  /api/finance/statements
 *   POST /api/finance/statements   { deliveryProviderId, fileName, content, ... }
 *
 * The file's SHA-256 is stored and unique per company: importing the same
 * statement twice is impossible, which is the whole point of the hash.
 */

const importSchema = z.object({
  deliveryProviderId: z.string().uuid(),
  reference: z.string().trim().min(2).max(80),
  fileName: z.string().trim().min(1).max(200),
  /**
   * The courier's file. Either its text (CSV) or base64 for a spreadsheet —
   * couriers send .xlsx far more often than CSV, so both are accepted and
   * the parser decides by looking at the bytes.
   */
  content: z.string().min(2).max(20_000_000),
  encoding: z.enum(['text', 'base64']).default('text'),
  periodFrom: z.string().datetime().optional().nullable(),
  periodTo: z.string().datetime().optional().nullable(),
});

export async function GET() {
  try {
    const { companyId, storeId, country } = await requireContext();
    await requirePermission('settlement.view');

    const statements = await db.courierStatement.findMany({
      where: { companyId, storeId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        _count: { select: { lines: true, receipts: true, matches: true } },
        /*
         * THE RECEIPTS THEMSELVES, because a count cannot be checked.
         *
         * `amount` alone was selected here and nothing read it. The screen
         * showed «٣ إيصال» and no way to see which three, so a proof
         * uploaded against one of them had nowhere to be looked at — and a
         * proof nobody can open is not a proof, it is a file.
         *
         * `proofKey` is NOT sent. It is a storage path and the browser has
         * no use for one: the link is built from the receipt's id, and the
         * server reads the key off the row. Sending it would publish the
         * layout of the uploads directory to every screen.
         */
        receipts: {
          orderBy: { receivedAt: 'asc' },
          select: {
            id: true,
            amount: true,
            currencyCode: true,
            receivedAt: true,
            note: true,
            proofName: true,
            proofMime: true,
            proofSize: true,
            wallet: { select: { name: true } },
          },
        },
      },
    });

    /*
     * THE LINES STILL A QUESTION, per statement, by the SAME rule the approval counts (`statement-open-lines`): the
     * counter beside each statement and the gate on its approval button cannot disagree, because they read one
     * function. One grouped read for the page, not one per statement.
     */
    const openRows = statements.length === 0
      ? []
      : await db.settlementMatch.groupBy({
          by: ['statementId'],
          where: { companyId, statementId: { in: statements.map((s) => s.id) }, ...openLineWhere() },
          _count: { _all: true },
        });
    const openOf = new Map(openRows.map((r): [string, number] => [r.statementId, r._count._all]));

    return NextResponse.json({
      statements: await Promise.all(
        statements.map(async (s) => ({
          id: s.id,
          reference: s.reference,
          fileName: s.fileName,
          status: s.status,
          // The stamp of the act, not the place in the flow. The screens gate
          // their match and approve buttons on this, because `status` alone
          // could be written back to MATCHED over an approved statement.
          approvedAt: s.approvedAt,
          // A statement a person gathered by hand, and whether it is still the open draft (orders can be added,
          // there is no reference and no receipt yet). The hash itself is not sent: only what the screen draws.
          manual: isManualHash(s.fileHash),
          draft: isManualDraftHash(s.fileHash),
          currencyCode: s.currencyCode,
          totalAmount: Number(s.totalAmount),
          createdAt: s.createdAt,
          periodFrom: s.periodFrom,
          periodTo: s.periodTo,
          counts: { ...s._count, openLines: openOf.get(s.id) ?? 0 },
          receipts: s.receipts.map((r) => ({
            id: r.id,
            amount: Number(r.amount),
            currencyCode: r.currencyCode,
            receivedAt: r.receivedAt,
            note: r.note,
            wallet: r.wallet.name,
            // `hasProof` rather than the key: what the screen needs to know
            // is whether there is something to open.
            proof: r.proofName ? { name: r.proofName, mime: r.proofMime, size: r.proofSize } : null,
          })),
          gap: await receiptGap(db, s.id, country.minorUnit),
        }))
      ),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId, country } = await requireContext();
    await requirePermission('settlement.upload');

    const parsed = importSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }
    const input = parsed.data;

    const provider = await db.deliveryProvider.findFirst({
      where: { id: input.deliveryProviderId, companyId },
      select: { id: true, name: true },
    });
    if (!provider) return NextResponse.json({ error: 'شركة الشحن غير موجودة' }, { status: 404 });

    // Hash the bytes as received: the same file re-encoded must still be
    // recognised as the same file.
    const fileBytes =
      input.encoding === 'base64' ? Buffer.from(input.content, 'base64') : Buffer.from(input.content, 'utf8');
    const hash = fileHash(fileBytes);
    const duplicate = await db.courierStatement.findFirst({
      where: { companyId, fileHash: hash },
      select: { id: true, reference: true, createdAt: true },
    });
    if (duplicate) {
      return NextResponse.json(
        {
          error: `هذا الكشف مستورد مسبقاً باسم ${duplicate.reference}`,
          code: 'DUPLICATE_STATEMENT',
          statementId: duplicate.id,
        },
        { status: 409 }
      );
    }

    const read = parseStatement(fileBytes);
    if (read.error) return NextResponse.json({ error: read.error, code: 'UNREADABLE_FILE' }, { status: 400 });
    const { rows } = read;
    const blankLines = read.blankLines ?? 0;
    const words = read.words ?? { byOutcome: {}, unknown: [] };
    /*
     * THE TOTAL IS ROUNDED ONCE, HERE, AND EVERYTHING BELOW READS THAT ONE NUMBER.
     *
     * `read.total` is a running float sum of two hundred lines — 292 lines of a real file added up to
     * `2869.040000000001`. The column was already written through `roundMinor`, but the audit row and the
     * answer carried the raw sum, so the screen told the seller «بإجمالي 2869.040000000001» for a statement
     * that holds 2,869.04. The answer also names the currency and its minor unit, so the screen can write the
     * figure the way every other money figure is written instead of printing a bare number.
     */
    const total = roundMinor(read.total, country.minorUnit);

    const statement = await db.$transaction(async (tx) => {
      const created = await tx.courierStatement.create({
        data: {
          companyId,
          storeId,
          deliveryProviderId: provider.id,
          reference: input.reference,
          periodFrom: input.periodFrom ? new Date(input.periodFrom) : null,
          periodTo: input.periodTo ? new Date(input.periodTo) : null,
          totalAmount: total,
          currencyCode: country.currencyCode,
          fileName: input.fileName,
          fileHash: hash,
          uploadedById: user.id,
        },
      });
      await tx.statementLine.createMany({
        data: rows.map((r) => ({
          statementId: created.id,
          merchantRef: r.merchantRef,
          barcode: r.barcode,
          amount: r.amount,
          // Kept so a difference in the net can be traced to its cause: a
          // collection short, or a fee higher than agreed.
          collected: r.collected,
          fee: r.fee,
          status: r.status,
          rawRow: r.rawRow,
        })),
      });
      return created;
    });

    await logAudit({
      companyId, userId: user.id, action: 'STATEMENT_IMPORTED',
      entity: 'CourierStatement', entityId: statement.id,
      newData: {
        reference: input.reference, courier: provider.name, rows: rows.length, total, fileHash: hash,
        // The lines the company named and wrote no money against (kept as 0), and the status words nobody has met.
        blankLines, unknownWords: words.unknown,
      },
    });

    return NextResponse.json(
      {
        statement, rows: rows.length, total, currencyCode: country.currencyCode, minorUnit: country.minorUnit,
        blankLines, unknownWords: words.unknown,
      },
      { status: 201 }
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
