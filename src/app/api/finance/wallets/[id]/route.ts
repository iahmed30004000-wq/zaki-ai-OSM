import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { zodMessage } from '@/lib/zod-message';

/**
 * PATCH  — rename a wallet, or stop and restart it.
 * DELETE — retire it. It does NOT erase what the money did.
 *
 * A wallet's movements are the ledger. Deleting a wallet that has any
 * would leave movements, closings and transfers pointing at nothing, and
 * there is nothing to re-enter — it is history, and the balance it carried
 * was real. So anything touched is STOPPED: it leaves the pickers and stays
 * on every record that names it.
 *
 * A real delete is only for the case it is actually for: a wallet created
 * by mistake five minutes ago, that no money has ever passed through.
 */

const patchSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  isActive: z.boolean().optional(),
});

/**
 * EVERY TABLE THAT POINTS AT A WALLET, NOT THE FOUR THAT CAME TO MIND.
 *
 * The first version counted movements, closings, receipts and transfers.
 * The schema has eight: expenses, payslips, commission payouts and the
 * opening count also carry a `walletId`. Measured against the real
 * database — a wallet with one expense against it and nothing else:
 *
 *   usageOf says {movements:0, closings:0, receipts:0, transfers:0}
 *   → touched = false → db.wallet.delete → P2003 on expenses_wallet_id_fkey
 *
 * The money survived, because every one of those relations is
 * `onDelete: Restrict` and the database refused. But the person asking
 * got «حدث خطأ» where the route had a real answer to give them: this
 * wallet paid for things, so it is stopped, not deleted.
 *
 * `one-wallet-usage.test.ts` reads the schema and fails if a ninth
 * relation is ever added without being counted here.
 */
const USAGE_LABEL_AR = {
  movements: 'حركة',
  transfers: 'تحويل',
  closings: 'إغلاق يومي',
  receipts: 'إيصال',
  expenses: 'مصروف',
  payslips: 'كشف راتب',
  commissionPayouts: 'صرف عمولة',
  openingCount: 'جرد افتتاحي',
} as const;

type WalletUsage = Record<keyof typeof USAGE_LABEL_AR, number>;

async function usageOf(id: string): Promise<WalletUsage> {
  const [movements, closings, receipts, transfers, expenses, payslips, commissionPayouts, openingCount] =
    await Promise.all([
      db.walletMovement.count({ where: { walletId: id } }),
      db.dailyClosing.count({ where: { walletId: id } }),
      db.statementReceipt.count({ where: { walletId: id } }),
      db.walletTransfer.count({ where: { OR: [{ fromWalletId: id }, { toWalletId: id }] } }),
      db.expense.count({ where: { walletId: id } }),
      db.payslip.count({ where: { walletId: id } }),
      db.commissionPayout.count({ where: { walletId: id } }),
      db.walletOpeningCount.count({ where: { walletId: id } }),
    ]);
  return { movements, closings, receipts, transfers, expenses, payslips, commissionPayouts, openingCount };
}

function describe(u: WalletUsage): string {
  return (Object.keys(USAGE_LABEL_AR) as (keyof WalletUsage)[])
    .filter((k) => u[k] > 0)
    .map((k) => `${u[k]} ${USAGE_LABEL_AR[k]}`)
    .join(' · ');
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId } = await requireContext();
    await requirePermission('finance.wallets_manage');

    const wallet = await db.wallet.findFirst({
      where: { id, companyId },
      select: { id: true, name: true, isActive: true, storeId: true },
    });
    if (!wallet) return NextResponse.json({ error: 'المحفظة غير موجودة' }, { status: 404 });

    const parsed = patchSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }
    const { name, isActive } = parsed.data;

    // The name is the store's to reuse — every store has a «الصندوق النقدي».
    if (name && name !== wallet.name) {
      const clash = await db.wallet.findFirst({
        where: { companyId, storeId: wallet.storeId, name, NOT: { id } },
        select: { id: true },
      });
      if (clash) {
        return NextResponse.json({ error: 'يوجد محفظة بنفس الاسم في هذا المتجر', code: 'NAME_TAKEN' }, { status: 409 });
      }
    }

    const updated = await db.wallet.update({
      where: { id },
      data: { ...(name ? { name } : {}), ...(typeof isActive === 'boolean' ? { isActive } : {}) },
      select: { id: true, name: true, isActive: true },
    });

    await logAudit({
      companyId, userId: user.id, action: 'WALLET_UPDATED',
      entity: 'Wallet', entityId: id,
      previousData: { name: wallet.name, isActive: wallet.isActive },
      newData: { name: updated.name, isActive: updated.isActive, by: user.name },
    });

    return NextResponse.json({ wallet: updated });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId } = await requireContext();
    await requirePermission('finance.wallets_manage');

    const wallet = await db.wallet.findFirst({
      where: { id, companyId },
      select: { id: true, name: true, openingBalance: true },
    });
    if (!wallet) return NextResponse.json({ error: 'المحفظة غير موجودة' }, { status: 404 });

    const usage = await usageOf(id);
    const touched = Object.values(usage).some((n) => n > 0);

    if (touched) {
      await db.wallet.update({ where: { id }, data: { isActive: false } });
      await logAudit({
        companyId, userId: user.id, action: 'WALLET_STOPPED',
        entity: 'Wallet', entityId: id,
        newData: { name: wallet.name, usage, by: user.name },
      });
      return NextResponse.json({
        stopped: true,
        usage,
        message: `أُوقِفت «${wallet.name}» ولم تُحذف — مرتبطة بـ${describe(usage)}. السجلّات كما هي.`,
      });
    }

    // An opening balance with no movement against it is still a number
    // somebody typed as real money. Deleting it silently would make a
    // balance vanish from the books with nothing to point at.
    if (Number(wallet.openingBalance) !== 0) {
      await db.wallet.update({ where: { id }, data: { isActive: false } });
      await logAudit({
        companyId, userId: user.id, action: 'WALLET_STOPPED',
        entity: 'Wallet', entityId: id,
        newData: { name: wallet.name, openingBalance: Number(wallet.openingBalance), by: user.name },
      });
      return NextResponse.json({
        stopped: true,
        usage,
        message: `أُوقِفت «${wallet.name}» ولم تُحذف — لها رصيد افتتاحي ${Number(wallet.openingBalance)}.`,
      });
    }

    await db.wallet.delete({ where: { id } });
    await logAudit({
      companyId, userId: user.id, action: 'WALLET_DELETED',
      entity: 'Wallet', entityId: id,
      previousData: { name: wallet.name },
      newData: { by: user.name },
    });
    return NextResponse.json({
      deleted: true,
      message: `حُذِفت «${wallet.name}» — لم يمرّ بها أي مبلغ.`,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
