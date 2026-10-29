import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { receiptGap } from '@/lib/settlement';
import { zodMessage } from '@/lib/zod-message';
import { receiptEditRefusal } from '@/lib/settlement-gates';
import { isManualDraftHash, MANUAL_DRAFT_SENTENCE } from '@/lib/manual-statement-rules';
import {
  MAX_PROOF_BYTES,
  describeProof,
  proofStorageKey,
  writeProofFile,
} from '@/lib/settlement-proof';

/**
 * POST /api/finance/statements/:id/receipts — step 2 of settlement.
 *
 * MANY receipts per statement, each with its own wallet, currency and
 * amount: a courier pays part in cash and part by transfer, and that has to
 * be recordable as it happened. No money moves yet — the wallet movement is
 * written when the statement is APPROVED.
 *
 * ── WHY A REPEAT IS THE DANGEROUS CASE, AND WHY IT CANNOT BE GUESSED ──
 *
 * Because many receipts per statement are legitimate, two identical ones —
 * same wallet, same amount, seconds apart — are indistinguishable from a
 * courier paying 50 twice. Nothing on the server can tell a genuine second
 * payment from a double-click or a retried request, so the CALLER says
 * which it is: it generates one id per attempt and reuses it on every
 * retry of that attempt. A replay lands on the row that is already there.
 *
 * The id is the receipt's own primary key, so the uniqueness is the one the
 * database already enforces — no second key to keep in step with it.
 */
const createSchema = z.object({
  /**
   * The caller's id for THIS attempt. Optional so an existing client keeps
   * working, and every retry that sends one is safe.
   */
  receiptId: z.string().uuid().optional(),
  walletId: z.string().uuid(),
  amount: z.number().positive().max(100_000_000),
  receivedAt: z.string().datetime().optional(),
  /** Required when the wallet currency differs from the statement currency. */
  /**
   * Stored with six decimals, so the smallest rate that survives the column is 0.000001. A smaller one would be
   * written as zero, which is no rate at all — the receipt would then be counted apart as «بلا سعر صرف» for a
   * rate the person did type.
   */
  exchangeRate: z.number().min(0.000001, 'سعر الصرف لا يقل عن 0.000001').max(1_000_000).optional(),
  note: z.string().trim().max(300).optional(),
  /**
   * THE PAPER BEHIND THE COLLECTION — «حط رفع ملف صورة او ملف عشان اتحقق
   * من التحصيل».
   *
   * It travels in THIS body, base64, rather than in a multipart request or
   * a second call — the same way the courier's statement file arrives on
   * the route next door. The reason is atomicity: the receipt and its paper
   * are written in one transaction, so a receipt saved with a proof that
   * then failed to upload is not a state this feature can reach.
   *
   * Base64 costs a third, so a 4 MB photo is about 5.6 MB of body. The
   * ceiling is checked on the DECODED bytes, below, because that is the
   * figure a person can act on.
   *
   * OPTIONAL, AND THAT IS THE DECISION: a cash handover in a doorway has no
   * paper, and a required field would stand between somebody and recording
   * money that has already arrived.
   */
  proof: z
    .object({
      /**
       * What the OWNER calls it. Optional — with nothing typed the file
       * keeps its own name, which a phone spells `IMG_20261010_143052.jpg`.
       */
      name: z.string().trim().max(120).optional(),
      /** The file's own name, for the fallback and for nothing else. */
      fileName: z.string().trim().max(255),
      /**
       * Bounded here as CHARACTERS so an enormous body is refused before it
       * is decoded. Four thirds of the byte ceiling, plus padding.
       */
      content: z
        .string()
        .min(1)
        .max(Math.ceil((MAX_PROOF_BYTES * 4) / 3) + 1024),
    })
    .optional(),
});

/** The statement was approved between the check and the write: the transaction rolls back and says so. */
class StatementClosed extends Error {}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId, storeId, country } = await requireContext();
    await requirePermission('settlement.upload');

    const statement = await db.courierStatement.findFirst({
      where: { id, companyId, storeId },
      select: { id: true, status: true, approvedAt: true, currencyCode: true, reference: true, fileHash: true },
    });
    if (!statement) return NextResponse.json({ error: 'الكشف غير موجود' }, { status: 404 });
    const closed = receiptEditRefusal(statement);
    if (closed) return NextResponse.json(closed, { status: 409 });
    /*
     * A MANUAL DRAFT TAKES NO RECEIPT.
     *
     * While orders can still be added the statement has no reference and its total is still moving, so a receipt
     * against it would be measured against a figure that is about to change. A draft only ever stops being a
     * draft (the second press gathers it), never the other way, so this read cannot go stale in the dangerous
     * direction.
     */
    if (isManualDraftHash(statement.fileHash)) {
      return NextResponse.json({ code: 'MANUAL_DRAFT', error: MANUAL_DRAFT_SENTENCE }, { status: 409 });
    }

    const parsed = createSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }

    // This store's wallet or one not placed yet: the statement is this store's (`storeId` above), and the cash
    // of a store goes into that store's drawer, not into another store's of the same company.
    const wallet = await db.wallet.findFirst({
      where: { id: parsed.data.walletId, companyId, isActive: true, OR: [{ storeId }, { storeId: null }] },
      select: { id: true, name: true, currencyCode: true },
    });
    if (!wallet) return NextResponse.json({ error: 'المحفظة غير موجودة' }, { status: 404 });

    // A different currency needs the rate the money actually changed at.
    if (wallet.currencyCode !== statement.currencyCode && !parsed.data.exchangeRate) {
      return NextResponse.json(
        {
          error: `عملة المحفظة (${wallet.currencyCode}) تختلف عن عملة الكشف (${statement.currencyCode}) — أدخل سعر الصرف`,
          code: 'EXCHANGE_RATE_REQUIRED',
        },
        { status: 400 }
      );
    }

    /*
     * THE FILE IS READ AND JUDGED BEFORE ANYTHING IS WRITTEN.
     *
     * `describeProof` sniffs the first bytes, refuses anything that is not
     * one of four types, caps the size and hashes what is left — and it
     * throws in Arabic, because the sentence goes to the person who chose
     * the file. Doing it here rather than inside the transaction means a
     * bad file costs nothing: no row, no statement status change, and no
     * transaction held open while a 4 MB buffer is examined.
     */
    let proof: { facts: ReturnType<typeof describeProof>; bytes: Buffer } | null = null;
    if (parsed.data.proof) {
      let bytes: Buffer;
      try {
        bytes = Buffer.from(parsed.data.proof.content, 'base64');
      } catch {
        return NextResponse.json({ error: 'تعذّر قراءة الملف', code: 'BAD_PROOF' }, { status: 400 });
      }
      try {
        proof = {
          facts: describeProof(bytes, parsed.data.proof.fileName, parsed.data.proof.name),
          bytes,
        };
      } catch (e) {
        return NextResponse.json(
          { error: e instanceof Error ? e.message : 'تعذّر قبول الملف', code: 'BAD_PROOF' },
          { status: 400 }
        );
      }
    }

    /*
     * A REPLAY FINDS ITS OWN ROW AND CHANGES NOTHING.
     *
     * Checked before the write rather than only catching the conflict,
     * because the answer differs: this caller's earlier attempt is a
     * success to repeat, while somebody else's id is a refusal. Scoped to
     * the company and the statement so an id from another tenant is not
     * even looked at.
     */
    if (parsed.data.receiptId) {
      const already = await db.statementReceipt.findFirst({
        where: { id: parsed.data.receiptId, companyId, statementId: id },
      });
      if (already) {
        const gap = await receiptGap(db, id, country.minorUnit);
        return NextResponse.json({ receipt: already, gap, replay: true }, { status: 200 });
      }
    }

    /*
     * ONE TRANSACTION: the receipt and the status it puts the statement
     * into are one fact. Written apart, a failure between them leaves money
     * recorded against a statement that still says nobody has paid — and
     * the screen offers «record a receipt» again for a receipt that exists.
     */
    /*
     * THE ID IS DECIDED BEFORE THE WRITE, because the storage key is built
     * from it. A key named after the receipt — never after the uploaded
     * filename — is what makes path traversal moot rather than defended
     * against, and it means one receipt has exactly one proof: a second
     * upload for the same receipt replaces a bad photo rather than leaving
     * two files and a row pointing at one of them.
     */
    const receiptId = parsed.data.receiptId ?? randomUUID();

    let receipt;
    try {
      receipt = await db.$transaction(async (tx) => {
        /*
         * A RECEIPT NEVER LANDS ON A STATEMENT THAT IS BEING APPROVED.
         *
         * The check above is read outside this transaction, so an approval that lands between it and the
         * write would find this receipt missing from its money — or, written after it, an orphan nobody's
         * wallet ever saw. The statement is claimed here first, conditionally: only a statement that is
         * still unapproved takes the status, and the approval's own claim waits on the same row, so the
         * receipt either lands before the approval reads its receipts or is refused with nothing written.
         */
        const open = await tx.courierStatement.updateMany({
          where: { id, companyId, approvedAt: null, status: { not: 'APPROVED' } },
          data: { status: 'RECEIPTED' },
        });
        if (open.count !== 1) throw new StatementClosed();

        const created = await tx.statementReceipt.create({
          data: {
            id: receiptId,
            companyId,
            statementId: id,
            walletId: wallet.id,
            amount: parsed.data.amount,
            currencyCode: wallet.currencyCode,
            exchangeRate: parsed.data.exchangeRate ?? null,
            receivedAt: parsed.data.receivedAt ? new Date(parsed.data.receivedAt) : new Date(),
            note: parsed.data.note ?? null,
            createdById: user.id,
            /*
             * ALL FIVE OR NONE — the database holds that invariant too
             * (`statement_receipts_proof_all_or_none`), because a proof
             * with a key and no hash looks present and cannot be checked.
             */
            ...(proof
              ? {
                  proofKey: proofStorageKey(companyId, id, receiptId, proof.facts.mime),
                  proofName: proof.facts.name,
                  proofMime: proof.facts.mime,
                  proofSize: proof.facts.sizeBytes,
                  proofHash: proof.facts.hash,
                }
              : {}),
          },
        });

        /*
         * THE BYTES GO TO DISK INSIDE THE TRANSACTION, and the order is
         * deliberate: the row first, the file second. If the write fails,
         * the transaction rolls the row back and there is no receipt
         * pointing at a file that is not there. The other order would leave
         * an orphaned file on every failure — harmless but accumulating,
         * and with nothing in the database to find it by.
         *
         * A file left behind by a LATER failure is still possible (the
         * statement update below), and that is the direction to fail in: a
         * file nobody references costs disk, a reference to a missing file
         * costs a person their proof.
         */
        if (proof) {
          await writeProofFile(created.proofKey!, proof.bytes);
        }

        return created;
      });
    } catch (e) {
      if (e instanceof StatementClosed) return NextResponse.json(receiptEditRefusal({ status: 'APPROVED' }), { status: 409 });
      /*
       * Two requests carrying the same id at the same moment: the check
       * above saw nothing, the database saw the second one. P2002 here can
       * only be that id, and the honest answer is that it is taken.
       */
      if (parsed.data.receiptId && e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return NextResponse.json({ error: 'هذا الإيصال مسجَّلٌ سلفاً', code: 'RECEIPT_EXISTS' }, { status: 409 });
      }
      throw e;
    }

    await logAudit({
      companyId, userId: user.id, action: 'STATEMENT_RECEIPT_ADDED',
      entity: 'CourierStatement', entityId: id,
      newData: {
        receiptId: receipt.id,
        wallet: wallet.name,
        amount: parsed.data.amount,
        // Whether a collection was evidenced is exactly the question this
        // feature exists to answer, so the audit row answers it too.
        proof: proof ? { name: proof.facts.name, mime: proof.facts.mime, hash: proof.facts.hash } : null,
      },
    });

    const gap = await receiptGap(db, id, country.minorUnit);
    return NextResponse.json({ receipt, gap }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
