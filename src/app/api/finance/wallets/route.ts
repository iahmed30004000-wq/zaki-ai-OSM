import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { can, requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { walletBalance } from '@/lib/wallets';
import { zodMessage } from '@/lib/zod-message';

/**
 * Wallets.
 *
 *   GET  /api/finance/wallets    every wallet of the company with its balance
 *   POST /api/finance/wallets    create one
 *
 * A wallet belongs to a COUNTRY and carries its own currency, which may
 * differ from the country's. There is no delete: a wallet is deactivated,
 * because its movements are permanent records.
 */

const createSchema = z.object({
  countryId: z.string().uuid(),
  name: z.string().trim().min(2).max(60),
  currencyCode: z.string().trim().toUpperCase().regex(/^[A-Z]{3,4}$/, 'رمز العملة ثلاثة أو أربعة أحرف (USD، USDT)'),
  openingBalance: z.number().min(-1_000_000_000).max(1_000_000_000).default(0),
});

export async function GET(req: Request) {
  try {
    const { user, companyId, country, storeId } = await requireContext();
    // Settlement records WHICH wallet a courier payment landed in, so it needs
    // the list of wallets — but not the cashbox figures. Only the cash box's
    // view key (finance.cashbox_view) sees balances.
    const cashbox = can(user, 'finance.cashbox_view');
    if (!cashbox) await requirePermission('settlement.upload');

    /**
     * Managing wallets is store work; MOVING money between them is not.
     *
     * A transfer between two stores, or two countries, needs to see both
     * ends — so the transfer screen asks for every wallet in the company
     * and groups them by country and store. Everywhere else sees only this
     * store's, because a store here is a separate business with its own
     * cash, its own bank account and its own daily closing.
     */
    const forTransfer = new URL(req.url).searchParams.get('scope') === 'transfer';

    const wallets = await db.wallet.findMany({
      // This store's money, and anything not yet placed so it can be fixed
      // rather than quietly disappear.
      where: {
        companyId,
        ...(forTransfer || !storeId ? {} : { OR: [{ storeId }, { storeId: null }] }),
      },
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      include: {
        country: { select: { id: true, name: true, code: true, minorUnit: true } },
        store: { select: { id: true, name: true } },
        // The signed physical count behind the opening balance, if one was
        // taken. The screen needs it to say who counted rather than to offer
        // counting again — and `walletBalance` already reports `movements`,
        // which is the other half of «can this still be counted».
        openingCount: {
          select: { countedAmount: true, countedByName: true, countedAt: true, note: true },
        },
      },
    });

    if (!cashbox) {
      return NextResponse.json({
        wallets: wallets.map((w) => ({
          id: w.id,
          name: w.name,
          currencyCode: w.currencyCode,
          isActive: w.isActive,
          country: w.country,
        })),
      });
    }

    const balances = await Promise.all(
      wallets.map((w) => walletBalance(db, w.id, w.country.minorUnit ?? country.minorUnit))
    );

    return NextResponse.json({
      wallets: wallets.map((w, i) => ({
        ...balances[i],
        id: w.id,
        name: w.name,
        // The wallet's own currency wins over the balance echo of it.
        currencyCode: w.currencyCode,
        isActive: w.isActive,
        country: w.country,
        // Which books this wallet's money belongs to — what makes a transfer
        // readable as internal, between stores, or between countries.
        countryId: w.countryId,
        storeId: w.storeId,
        store: w.store,
        openingCount: w.openingCount,
      })),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId } = await requireContext();
    // Creating a wallet is the wallets' own key (PR-9), no longer the day's cash work.
    await requirePermission('finance.wallets_manage');

    const parsed = createSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }

    const country = await db.country.findFirst({
      where: { id: parsed.data.countryId, companyId },
      select: { id: true, name: true },
    });
    if (!country) return NextResponse.json({ error: 'البلد غير موجود' }, { status: 404 });

    // The store comes from the session, never the body: a body that names
    // its own store is a body that can name someone else's.
    if (!storeId) {
      return NextResponse.json({ error: 'اختر المتجر أولاً', code: 'STORE_REQUIRED' }, { status: 400 });
    }

    // The name is the store's to reuse — every store has a «الصندوق النقدي».
    const clash = await db.wallet.findFirst({
      where: { companyId, storeId, name: parsed.data.name },
      select: { id: true },
    });
    if (clash) return NextResponse.json({ error: 'يوجد محفظة بنفس الاسم في هذا المتجر' }, { status: 409 });

    const wallet = await db.wallet.create({
      data: {
        companyId,
        countryId: country.id,
        storeId,
        name: parsed.data.name,
        currencyCode: parsed.data.currencyCode,
        openingBalance: parsed.data.openingBalance,
      },
    });

    await logAudit({
      companyId, userId: user.id, action: 'WALLET_CREATED',
      entity: 'Wallet', entityId: wallet.id,
      newData: { name: wallet.name, currency: wallet.currencyCode, country: country.name, opening: parsed.data.openingBalance },
    });

    return NextResponse.json({ wallet }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
