import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { zodMessage } from '@/lib/zod-message';
import { addOrdersToDraft, ManualRefused } from '@/lib/manual-statement';
import { MANUAL_DRAFT_PREFIX, MANUAL_PREFIX } from '@/lib/manual-statement-rules';
import { receiptGap } from '@/lib/settlement';
import { currencyTable, handoverStanding } from '@/lib/handover';
import { minorUnitFor } from '@/lib/currencies';

/**
 * GET /api/finance/statements/manual — the OPEN HANDOVERS (F9, 23/11): the manual statements of this store that were
 * gathered and are not approved yet. `?id=` asks for one.
 *
 * «استلمت منه» on the tracking screen is the manual statement now, so a courier who pays over several days has ONE open
 * statement, and the screen draws a card for it: «{المندوب} — باقي X — سجّل دفعة». This read writes nothing. Each one
 * carries the statement's own gap (`receiptGap`, the figure the approval judges), its receipts, and the per-currency
 * table (`currencyTable` — the receipts door's own conversion, asked once per currency).
 *
 * The key is the statement's: `settlement.upload`, the key that adds its orders and takes its receipts.
 */
export async function GET(req: Request) {
  try {
    const { companyId, storeId, country } = await requireContext();
    await requirePermission('settlement.upload');

    const one = new URL(req.url).searchParams.get('id');
    const statements = await db.courierStatement.findMany({
      where: {
        companyId,
        storeId,
        ...(one ? { id: one } : {}),
        approvedAt: null,
        status: { not: 'APPROVED' },
        // Gathered by hand, and no longer the open draft: the draft has no reference and takes no receipt yet.
        AND: [{ fileHash: { startsWith: MANUAL_PREFIX } }, { NOT: { fileHash: { startsWith: MANUAL_DRAFT_PREFIX } } }],
      },
      orderBy: { createdAt: 'asc' },
      take: 50,
      select: {
        id: true, reference: true, currencyCode: true, createdAt: true, deliveryProviderId: true,
        _count: { select: { lines: true } },
        receipts: {
          orderBy: { receivedAt: 'asc' },
          select: {
            id: true, amount: true, currencyCode: true, exchangeRate: true, receivedAt: true, note: true, proofName: true,
            wallet: { select: { name: true } },
          },
        },
      },
    });

    const couriers = await db.deliveryProvider.findMany({
      where: { companyId, id: { in: [...new Set(statements.map((s) => s.deliveryProviderId))] } },
      select: { id: true, name: true },
    });
    const courierName = new Map(couriers.map((c) => [c.id, c.name]));

    const handovers = [];
    for (const s of statements) {
      const gap = await receiptGap(db, s.id, country.minorUnit);
      const receipts = s.receipts.map((r) => ({
        id: r.id,
        amount: Number(r.amount),
        currencyCode: r.currencyCode,
        exchangeRate: r.exchangeRate === null ? null : Number(r.exchangeRate),
        receivedAt: r.receivedAt,
        note: r.note,
        proofName: r.proofName,
        wallet: r.wallet.name,
      }));
      handovers.push({
        id: s.id,
        reference: s.reference,
        courier: courierName.get(s.deliveryProviderId) ?? '',
        currencyCode: s.currencyCode,
        orders: s._count.lines,
        createdAt: s.createdAt,
        gap,
        standing: handoverStanding(gap),
        receipts,
        table: currencyTable(receipts, s.currencyCode, country.minorUnit, (code) => minorUnitFor(code) ?? country.minorUnit),
      });
    }

    return NextResponse.json({ handovers });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/**
 * POST /api/finance/statements/manual — «مطابق يدوي», the first press of the manual statement.
 *
 *   { orders: [{ orderId, amount? }] }
 *
 * The delivered orders of ONE courier join that courier's open draft statement (the draft is made by the first
 * press). A line carries the order's reference and the amount the courier handed over for it — the expected net
 * unless one was typed — so a short handover is recorded order by order.
 *
 * ── IT MOVES NO MONEY ──
 *
 * Nothing is settled, no wallet is touched, no commission becomes payable. The second press («تجميع») gives the
 * draft its reference and period, and the receipt, the matching and the approval that follow are the existing
 * ones — the money moves at the approval and nowhere earlier.
 *
 * The permission is the one that makes a statement (`settlement.upload`), not the cash box: this writes lines of a
 * statement, and the cash box is what «استلمت منه» asks for because THAT door takes cash.
 */
const schema = z.object({
  orders: z
    .array(
      z.object({
        orderId: z.string().uuid(),
        /** What the courier handed over for this order. Omitted = what we expect. */
        amount: z.number().min(-100_000_000).max(100_000_000).optional(),
      })
    )
    .min(1, 'اختر طلباً واحداً على الأقل')
    .max(500),
});

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId, country } = await requireContext();
    await requirePermission('settlement.upload');

    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }

    let result;
    try {
      result = await db.$transaction(
        (tx) =>
          addOrdersToDraft(tx, {
            companyId,
            storeId,
            userId: user.id,
            currencyCode: country.currencyCode,
            minorUnit: country.minorUnit,
            items: parsed.data.orders,
          }),
        { timeout: 30_000 }
      );
    } catch (e) {
      if (e instanceof ManualRefused) return NextResponse.json(e.body, { status: e.status });
      throw e;
    }

    await logAudit({
      companyId, userId: user.id, action: 'STATEMENT_MANUAL_ADDED',
      entity: 'CourierStatement', entityId: result.statementId,
      newData: {
        courier: result.courier, added: result.added, updated: result.updated,
        lines: result.lines, total: result.total, draftCreated: result.created,
      },
    });

    return NextResponse.json(result, { status: result.created ? 201 : 200 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
