import { NextResponse } from 'next/server';
import { readLimit } from '@/lib/numeric-input';
import { z } from 'zod';
import { db } from '@/lib/db';
import { inStore } from '@/lib/store-filter';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { MOVEMENT_CATEGORIES, recordMovement, reverseMovement, walletBalance } from '@/lib/wallets';
import { zodMessage } from '@/lib/zod-message';
import { handMovementRefusal } from '@/lib/hand-movement-rules';

/**
 * Wallet movements.
 *
 *   GET   /api/finance/wallets/:id/movements
 *   POST  /api/finance/wallets/:id/movements        record one
 *   PATCH /api/finance/wallets/:id/movements        reverse one (with a reason)
 *
 * There is NO DELETE, for any role including the owner: a correction is a
 * reversing entry linked to the original.
 */

const createSchema = z.object({
  direction: z.enum(['IN', 'OUT']),
  amount: z.number().positive().max(1_000_000_000),
  party: z.string().trim().min(2, 'اذكر الطرف').max(120),
  category: z.enum(MOVEMENT_CATEGORIES),
  note: z.string().trim().min(3, 'الملاحظة إلزامية').max(300),
});

const reverseSchema = z.object({
  movementId: z.string().uuid(),
  reason: z.string().trim().min(5, 'سبب القيد العكسي إلزامي').max(300),
});

/**
 * The wallet, if it is this store's.
 *
 * The store is a parameter and not an ambient value: every caller already
 * has one from requireContext, and a helper that quietly read a wider scope
 * would undo the filter at the one place all three handlers go through.
 */
async function walletOf(id: string, companyId: string, storeId: string | null) {
  return db.wallet.findFirst({
    where: { id, ...inStore(companyId, storeId) },
    include: { country: { select: { minorUnit: true } } },
  });
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { companyId, storeId } = await requireContext();
    await requirePermission('finance.cashbox');

    const wallet = await walletOf(id, companyId, storeId);
    if (!wallet) return NextResponse.json({ error: 'المحفظة غير موجودة' }, { status: 404 });

    const take = readLimit(new URL(req.url).searchParams, 100, 300);
    const movements = await db.walletMovement.findMany({
      where: { walletId: id },
      orderBy: { createdAt: 'desc' },
      take,
      include: { reversalOf: { select: { id: true, note: true } }, reversedBy: { select: { id: true } } },
    });

    const actorIds = [...new Set(movements.map((m) => m.createdById))];
    const actors = actorIds.length
      ? await db.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } })
      : [];
    const nameOf = new Map(actors.map((a) => [a.id, a.name]));

    return NextResponse.json({
      balance: await walletBalance(db, id, wallet.country.minorUnit),
      movements: movements.map((m) => ({
        ...m,
        amount: Number(m.amount),
        createdByName: nameOf.get(m.createdById) ?? null,
        isReversal: !!m.reversalOfId,
        wasReversed: !!m.reversedBy,
      })),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('finance.cashbox');

    const wallet = await walletOf(id, companyId, storeId);
    if (!wallet) return NextResponse.json({ error: 'المحفظة غير موجودة' }, { status: 404 });
    if (!wallet.isActive) return NextResponse.json({ error: 'المحفظة موقوفة' }, { status: 409 });

    const parsed = createSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }

    /*
     * WHAT A PERSON MAY TYPE. A courier's collection has two doors of its own (the receipt of an approved
     * statement, «استلمت منه») and a transfer has one; typing them here wrote the same money a second time
     * when the statement was approved. Each remaining category also runs in one direction only where it can.
     * The rule is lib/hand-movement-rules, which the dialog reads to offer only these pairs.
     */
    const refused = handMovementRefusal(parsed.data.category, parsed.data.direction);
    if (refused) return NextResponse.json(refused, { status: 409 });

    const movement = await recordMovement(db, {
      companyId,
      walletId: id,
      direction: parsed.data.direction,
      amount: parsed.data.amount,
      party: parsed.data.party,
      category: parsed.data.category,
      note: parsed.data.note,
      createdById: user.id,
    });

    await logAudit({
      companyId, userId: user.id, action: 'WALLET_MOVEMENT_RECORDED',
      entity: 'WalletMovement', entityId: movement.id,
      newData: { wallet: wallet.name, ...parsed.data },
    });

    return NextResponse.json(
      { movement, balance: await walletBalance(db, id, wallet.country.minorUnit) },
      { status: 201 }
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('finance.cashbox');

    const wallet = await walletOf(id, companyId, storeId);
    if (!wallet) return NextResponse.json({ error: 'المحفظة غير موجودة' }, { status: 404 });

    const parsed = reverseSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }

    try {
      const reversal = await reverseMovement(db, {
        companyId,
        // The wallet the caller was authorised for, not one the body names.
        walletId: id,
        movementId: parsed.data.movementId,
        reason: parsed.data.reason,
        createdById: user.id,
      });
      await logAudit({
        companyId, userId: user.id, action: 'WALLET_MOVEMENT_REVERSED',
        entity: 'WalletMovement', entityId: reversal.id,
        previousData: { original: parsed.data.movementId },
        newData: { reason: parsed.data.reason },
      });
      return NextResponse.json(
        { reversal, balance: await walletBalance(db, id, wallet.country.minorUnit) },
        { status: 201 }
      );
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : 'تعذر القيد العكسي' }, { status: 409 });
    }
  } catch (error) {
    return apiErrorResponse(error);
  }
}
