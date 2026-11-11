import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { storedFileExists } from '@/lib/storage';
import { zodMessage } from '@/lib/zod-message';
import { WALLET_COLOR_KEYS, WALLET_ICON_KEYS, WALLET_IMAGE_NOT_OURS, isOwnWalletImageKey } from '@/lib/wallet-look';

/**
 * PATCH  — rename a wallet, stop and restart it, or change how it looks (a picture, an icon, a colour).
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
  /**
   * THE WALLET'S LOOK (lib/wallet-look) — each one absent to leave it, `null` to clear it back to the default.
   *
   * The icon and the colour are checked against the lists the screen draws its choices from, so a client cannot save a
   * look the screen cannot show. The picture is a storage KEY, never a URL: it is checked below, against the company and
   * the wallet, because a string that merely looks like a path is not a file this company's door wrote.
   */
  imageKey: z.string().max(200).nullable().optional(),
  iconKey: z.enum(WALLET_ICON_KEYS, { error: 'الأيقونة مش من القائمة الجاهزة' }).nullable().optional(),
  colorKey: z.enum(WALLET_COLOR_KEYS, { error: 'اللون مش من الألوان الجاهزة' }).nullable().optional(),
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
      select: { id: true, name: true, isActive: true, storeId: true, imageKey: true, iconKey: true, colorKey: true },
    });
    if (!wallet) return NextResponse.json({ error: 'المحفظة غير موجودة' }, { status: 404 });

    const parsed = patchSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }
    const { name, isActive, imageKey, iconKey, colorKey } = parsed.data;

    /**
     * A PICTURE IS SAVED ONLY IF THIS COMPANY'S DOOR WROTE IT FOR THIS WALLET.
     *
     * Three questions, one sentence for every «no» so the answer says nothing about which one failed or whether
     * anybody else's file exists: is it the shape the door writes (`companies/{company}/products/{wallet}/{uuid}`),
     * is the company this one and the folder this wallet's, and does the volume really hold it. A URL, a path with
     * dots, another company's key, another wallet's key, and a key nobody uploaded all stop at the first or second.
     */
    if (typeof imageKey === 'string') {
      const ours = isOwnWalletImageKey(imageKey, { companyId, walletId: id }) && (await storedFileExists(imageKey));
      if (!ours) return NextResponse.json({ error: WALLET_IMAGE_NOT_OURS, code: 'IMAGE_NOT_OURS' }, { status: 400 });
    }

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
      data: {
        ...(name ? { name } : {}),
        ...(typeof isActive === 'boolean' ? { isActive } : {}),
        // `undefined` leaves a part of the look alone; `null` clears it back to the default.
        ...(imageKey !== undefined ? { imageKey } : {}),
        ...(iconKey !== undefined ? { iconKey } : {}),
        ...(colorKey !== undefined ? { colorKey } : {}),
      },
      select: { id: true, name: true, isActive: true, imageKey: true, iconKey: true, colorKey: true },
    });

    await logAudit({
      companyId, userId: user.id, action: 'WALLET_UPDATED',
      entity: 'Wallet', entityId: id,
      previousData: {
        name: wallet.name, isActive: wallet.isActive,
        imageKey: wallet.imageKey, iconKey: wallet.iconKey, colorKey: wallet.colorKey,
      },
      newData: {
        name: updated.name, isActive: updated.isActive,
        imageKey: updated.imageKey, iconKey: updated.iconKey, colorKey: updated.colorKey,
        by: user.name,
      },
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
