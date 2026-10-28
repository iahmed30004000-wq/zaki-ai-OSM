import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { receiptGap } from '@/lib/settlement';
import { receiptEditRefusal } from '@/lib/settlement-gates';
import { zodMessage } from '@/lib/zod-message';
import { readStoredFile } from '@/lib/storage';
import {
  ALLOWED_PROOF_MIMES,
  MAX_PROOF_BYTES,
  describeProof,
  proofDispositionHeader,
  revisedProofKey,
  writeProofFile,
  type ProofMime,
} from '@/lib/settlement-proof';

/**
 * GET /api/finance/statements/:id/receipts/:receiptId/proof
 *
 * The paper behind a collection, handed back to whoever is checking it.
 *
 * ── THE CALLER NEVER CHOOSES A PATH ──
 *
 * This takes two ids and no filename. The storage key comes from the ROW,
 * which was built from the receipt's own id when the file was accepted. So
 * there is no traversal to defend against here: the only reachable files
 * are the ones a row already points at, and a request naming somebody
 * else's receipt finds no row because the lookup is scoped to the company,
 * the store's statement and the receipt together.
 *
 * `/api/media/[...key]` could not serve this and that is not a fork: it
 * hard-requires `companies/{id}/products/{id}/{file}` in the path and gates
 * on company membership alone. A receipt's proof is a financial record, so
 * it is gated on `settlement.view` as well — a warehouse keeper in the same
 * company has no business reading what a courier handed over.
 *
 * ── AND THE CONTENT TYPE COMES FROM THE ROW, NOT FROM THE FILE'S NAME ──
 *
 * `readStoredFile` guesses a type from the extension and knows nothing of
 * PDFs. The row recorded what the first bytes actually were, so that is
 * what is declared — and it is re-checked against the allowlist, because a
 * column is still a column and this value becomes a `Content-Type`.
 *
 * A PDF is sent as an attachment rather than inline: it may carry
 * JavaScript, and served inline from this product's own origin the viewer
 * runs it here. `proofDispositionHeader` decides that from the type, and
 * `nosniff` stops a browser from deciding otherwise.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; receiptId: string }> }
) {
  try {
    const { id, receiptId } = await params;
    const { companyId, storeId } = await requireContext();
    await requirePermission('settlement.view');

    /*
     * ONE QUERY, THREE SCOPES. The receipt must be this company's, and its
     * statement must be this store's — otherwise an id leaked from another
     * store's screen would serve its paper. `findFirst` on a composite
     * where, not a `findUnique` on the id with checks afterwards: the
     * second shape is the one that eventually gets an early `return` added
     * above the check.
     */
    const receipt = await db.statementReceipt.findFirst({
      where: {
        id: receiptId,
        companyId,
        statementId: id,
        statement: { companyId, storeId },
      },
      select: { proofKey: true, proofName: true, proofMime: true, proofSize: true },
    });

    // The same answer for «no such receipt» and «that receipt has no
    // paper»: the difference would tell somebody which receipt ids exist.
    if (!receipt?.proofKey || !receipt.proofMime) {
      return NextResponse.json({ error: 'لا يوجد إثبات لهذا الإيصال' }, { status: 404 });
    }

    if (!(ALLOWED_PROOF_MIMES as readonly string[]).includes(receipt.proofMime)) {
      // A type outside the allowlist in a column that decides a
      // `Content-Type` header. Nothing writes one, so this is not reachable
      // today — and a header built from an unchecked column is how it would
      // become reachable tomorrow.
      return NextResponse.json({ error: 'نوع الملف غير مدعوم' }, { status: 415 });
    }
    const mime = receipt.proofMime as ProofMime;

    const file = await readStoredFile(receipt.proofKey);
    if (!file) {
      /*
       * The row points at a file that is not on disk. Said plainly rather
       * than as a 404 on the receipt, because the two mean different things
       * to whoever is looking: «no proof was uploaded» is a process gap,
       * «the proof is missing» is a restore to go and do.
       */
      return NextResponse.json(
        { error: 'الإثبات مسجَّل ولا يُعثر على ملفه — راجع النسخ الاحتياطية', code: 'PROOF_FILE_MISSING' },
        { status: 410 }
      );
    }

    const body = new ReadableStream({
      start(controller) {
        file.stream.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
        file.stream.on('end', () => controller.close());
        file.stream.on('error', (err) => controller.error(err));
      },
    });

    return new NextResponse(body, {
      headers: {
        'Content-Type': mime,
        'Content-Length': String(file.size),
        'Content-Disposition': proofDispositionHeader(mime, receipt.proofName ?? 'إثبات-التحصيل'),
        // A financial record: never in a shared cache, and never guessed at.
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/**
 * PUT /api/finance/statements/:id/receipts/:receiptId/proof — change the paper until «اعتماد».
 *
 * «الاثبات اقدر اغيرو لغاية قبل ما اضغط زر اعتماد». A saved receipt and its proof used to be fixed — the only
 * way out was to undo the whole statement. This replaces the proof (or adds one to a receipt that had none)
 * while the statement is still unapproved, and refuses once it is: the same sentence as a new receipt.
 *
 * The body is the POST's `proof` object and it is judged by the same `describeProof`, so a bad file is refused
 * in the same words. The file goes under a NEW key and the old one is left on disk — the audit row names it —
 * and the five proof columns move together (`statement_receipts_proof_all_or_none`).
 *
 * NO WALLET MOVEMENT, EVER: a proof is paper, and the money is written at approval. The conditional write on
 * the statement is the same `approvedAt: null` claim the approval and the receipt use, taken inside the
 * transaction, so a change racing an approval is refused rather than half-applied.
 */
const replaceSchema = z.object({
  name: z.string().trim().max(120).optional(),
  fileName: z.string().trim().max(255),
  content: z
    .string()
    .min(1)
    .max(Math.ceil((MAX_PROOF_BYTES * 4) / 3) + 1024),
});

class StatementClosed extends Error {}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string; receiptId: string }> }
) {
  try {
    const { id, receiptId } = await params;
    const { user, companyId, storeId, country } = await requireContext();
    await requirePermission('settlement.upload');

    const receipt = await db.statementReceipt.findFirst({
      where: { id: receiptId, companyId, statementId: id, statement: { companyId, storeId } },
      select: {
        id: true, proofKey: true, proofName: true, proofMime: true, proofHash: true,
        statement: { select: { status: true, approvedAt: true } },
      },
    });
    if (!receipt) return NextResponse.json({ error: 'الإيصال غير موجود' }, { status: 404 });
    const closed = receiptEditRefusal(receipt.statement);
    if (closed) return NextResponse.json(closed, { status: 409 });

    const parsed = replaceSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }

    // Judged before anything is written, exactly as the receipt route judges it.
    let bytes: Buffer;
    try {
      bytes = Buffer.from(parsed.data.content, 'base64');
    } catch {
      return NextResponse.json({ error: 'تعذّر قراءة الملف', code: 'BAD_PROOF' }, { status: 400 });
    }
    let facts: ReturnType<typeof describeProof>;
    try {
      facts = describeProof(bytes, parsed.data.fileName, parsed.data.name);
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : 'تعذّر قبول الملف', code: 'BAD_PROOF' },
        { status: 400 }
      );
    }
    const newKey = revisedProofKey(companyId, id, receiptId, facts.mime, randomUUID());

    try {
      await db.$transaction(async (tx) => {
        const open = await tx.courierStatement.updateMany({
          where: { id, companyId, storeId, approvedAt: null, status: { not: 'APPROVED' } },
          data: { updatedAt: new Date() },
        });
        if (open.count !== 1) throw new StatementClosed();

        const written = await tx.statementReceipt.updateMany({
          where: { id: receiptId, companyId, statementId: id },
          data: {
            proofKey: newKey,
            proofName: facts.name,
            proofMime: facts.mime,
            proofSize: facts.sizeBytes,
            proofHash: facts.hash,
          },
        });
        if (written.count !== 1) throw new StatementClosed();
        // The row first, the file second: a failed write rolls the row back, so no receipt points at a missing file.
        await writeProofFile(newKey, bytes);
      });
    } catch (e) {
      if (e instanceof StatementClosed) {
        return NextResponse.json(receiptEditRefusal({ status: 'APPROVED' }), { status: 409 });
      }
      throw e;
    }

    await logAudit({
      companyId, userId: user.id, action: 'STATEMENT_RECEIPT_PROOF_CHANGED',
      entity: 'CourierStatement', entityId: id,
      previousData: {
        receiptId,
        proof: receipt.proofKey
          ? { key: receipt.proofKey, name: receipt.proofName, mime: receipt.proofMime, hash: receipt.proofHash }
          : null,
      },
      newData: { receiptId, proof: { key: newKey, name: facts.name, mime: facts.mime, hash: facts.hash } },
    });

    return NextResponse.json({
      receipt: { id: receiptId, proof: { name: facts.name, mime: facts.mime, size: facts.sizeBytes } },
      gap: await receiptGap(db, id, country.minorUnit),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
