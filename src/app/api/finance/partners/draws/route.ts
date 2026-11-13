import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { inStore } from '@/lib/store-filter';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { roundMinor, toMinorUnits } from '@/lib/money';
import { numeric } from '@/lib/numeric-input';
import { zodMessage } from '@/lib/zod-message';
import { recordMovement, walletBalance } from '@/lib/wallets';

/**
 * POST /api/finance/partners/draws — A PARTNER'S WITHDRAWAL (13/11).
 *
 * «السحوبات لازم تنضاف بند … اذا حد تجاوز نسبة سحبة نسبة الربح بينعد مكسور عليه» (the owner). A draw is a WALLET MOVEMENT — an OUT of
 * the wallet, category PARTNER_DRAW — written only through `recordMovement` (guard `money-moves-at-two-doors`). It is NOT an expense:
 * no `Expense` row, nothing the profit subtracts; the net profit is the same before and after a draw. What it does is count, in the
 * partners' statement, against its partner's share of that profit — and a draw that passes the share is ALLOWED and shown as
 * «مكسور عليه», never refused.
 *
 * TWO KEYS, ASKED BEFORE THE BODY IS READ: `finance.partners` (the partners' business — the owner's to tick) and `finance.cashbox`
 * (cash leaves a wallet, which is the cash box's act whoever asks). Reversing a draw goes through the wallet's reversal door, which
 * asks `finance.partners` again for this category.
 *
 * THE CURRENCY. The profit is in the STORE's currency and a wallet may hold another one. A draw from a wallet in the store's own
 * currency is worth its amount. From any other it MUST carry «ما يعادله بعملة المتجر», and without it nothing is written: a silent
 * 1:1 between dinars and dollars would put a wrong number in a partner's ledger. Neither figure is rounded behind the person's back:
 * one with more decimals than its currency has is refused.
 *
 * THE SAME PRESS TWICE. Two identical requests (a double tap, a retry after a slow answer) must not draw twice. The wallet row is
 * locked for the length of the transaction, and a draw by the same person, of the same amount, for the same partner out of the same
 * wallet in the last half minute — and not reversed — is refused as `DUPLICATE_DRAW`. The lock is what makes two requests at the same
 * instant queue instead of both passing the check.
 */

const MAX = 1_000_000_000;
/** A twin of a draw inside this window is the same press sent twice. */
const DUPLICATE_WINDOW_MS = 30_000;

const figure = () =>
  numeric()
    .refine((v) => v > 0, { message: 'المبلغ أكبر من صفر' })
    .refine((v) => v <= MAX, { message: `المبلغ ${MAX} على الأكثر` });

const drawSchema = z.object({
  walletId: z.string().uuid(),
  partnerId: z.string().uuid(),
  /** In the WALLET's currency, as typed. */
  amount: figure(),
  /** In the STORE's currency: required when the wallet's currency is another, and nothing else. */
  valueInStoreCurrency: figure().optional(),
  note: z.string().trim().max(300).optional(),
});

/** A refusal found inside the transaction: it unwinds the lock and carries what the door answers. */
class DrawRefused extends Error {
  constructor(
    public readonly status: number,
    public readonly body: { error: string; code: string }
  ) {
    super(body.error);
    this.name = 'DrawRefused';
  }
}

const refuse = (status: number, code: string, error: string) => NextResponse.json({ error, code }, { status });

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId, country } = await requireContext();
    // THE KEYS FIRST, before a byte of the body is read.
    await requirePermission('finance.partners');
    await requirePermission('finance.cashbox');

    const parsed = drawSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: zodMessage(parsed.error), code: 'INVALID_DRAW' }, { status: 400 });
    const { walletId, partnerId, amount } = parsed.data;

    // This store's wallet — the same rule the movements door applies.
    const wallet = await db.wallet.findFirst({
      where: { id: walletId, ...inStore(companyId, storeId) },
      include: { country: { select: { minorUnit: true } } },
    });
    if (!wallet) return refuse(404, 'WALLET_NOT_FOUND', 'المحفظة غير موجودة');
    if (!wallet.isActive) return refuse(409, 'WALLET_STOPPED', 'المحفظة موقوفة');

    const partner = await db.partner.findFirst({ where: { id: partnerId, companyId } });
    if (!partner) return refuse(404, 'PARTNER_NOT_FOUND', 'الشريك غير موجود');
    if (!partner.isActive) return refuse(409, 'PARTNER_STOPPED', 'الشريك موقوف — ما بينسجّل عليه سحب جديد.');

    const walletMinor = wallet.country.minorUnit;
    if (roundMinor(amount, walletMinor) !== amount) {
      return refuse(
        400,
        'AMOUNT_DECIMALS',
        walletMinor === 0
          ? `عملة هالمحفظة (${wallet.currencyCode}) بلا كسور — اكتب المبلغ رقماً صحيحاً.`
          : `المبلغ بأكثر من ${walletMinor} خانات عشرية — عملة هالمحفظة (${wallet.currencyCode}) بخانات ${walletMinor} بس.`
      );
    }

    // WHAT THE DRAW IS WORTH IN THE STORE'S CURRENCY.
    const storeCode = country.currencyCode;
    const storeMinor = country.minorUnit;
    const typed = parsed.data.valueInStoreCurrency;
    let value: number;
    if (wallet.currencyCode === storeCode) {
      if (typed !== undefined && toMinorUnits(typed, storeMinor) !== toMinorUnits(amount, storeMinor)) {
        return refuse(
          400,
          'VALUE_NOT_ALLOWED',
          `عملة المحفظة هي عملة المتجر (${storeCode}) — ما في «ما يعادله»: قيمة السحب هي المبلغ نفسه.`
        );
      }
      value = amount;
    } else {
      if (typed === undefined) {
        return refuse(
          400,
          'STORE_VALUE_REQUIRED',
          `اكتب «ما يعادله بعملة المتجر (${storeCode})» — عملة هالمحفظة (${wallet.currencyCode}) غير عملة المتجر، ورقم بلا تحويل بيغلّط حساب الشريك.`
        );
      }
      if (roundMinor(typed, storeMinor) !== typed) {
        return refuse(400, 'VALUE_DECIMALS', `«ما يعادله» بأكثر من ${storeMinor} خانات عشرية — عملة المتجر (${storeCode}) بخانات ${storeMinor} بس.`);
      }
      value = typed;
    }

    const done = await db
      .$transaction(async (tx) => {
        // The wallet row is held until the transaction ends: a second press at the same instant waits here, then sees the first.
        await tx.$queryRaw`SELECT "id" FROM "wallets" WHERE "id" = ${wallet.id} FOR UPDATE`;
        const twin = await tx.walletMovement.findFirst({
          where: {
            companyId,
            walletId: wallet.id,
            category: 'PARTNER_DRAW',
            direction: 'OUT',
            partnerId: partner.id,
            amount,
            createdById: user.id,
            createdAt: { gte: new Date(Date.now() - DUPLICATE_WINDOW_MS) },
            reversedBy: null,
          },
          select: { id: true },
        });
        if (twin) {
          throw new DrawRefused(409, {
            code: 'DUPLICATE_DRAW',
            error: 'سجّلت نفس السحب (نفس الشريك والمحفظة والمبلغ) قبل لحظات — ما انسجّل مرتين. إذا بدك سحباً تانياً بنفس الرقم، استنّى نص دقيقة.',
          });
        }
        return recordMovement(tx, {
          companyId,
          walletId: wallet.id,
          direction: 'OUT',
          amount,
          party: partner.name,
          category: 'PARTNER_DRAW',
          note: parsed.data.note?.trim() || `سحب ${partner.name}`,
          referenceType: 'PARTNER_DRAW',
          referenceId: partner.id,
          partnerId: partner.id,
          valueInStoreCurrency: value,
          createdById: user.id,
        });
      })
      .catch((e: unknown) => {
        if (e instanceof DrawRefused) return e;
        throw e;
      });
    if (done instanceof DrawRefused) return NextResponse.json(done.body, { status: done.status });
    const movement = done;

    await logAudit({
      companyId,
      userId: user.id,
      action: 'PARTNER_DRAW_RECORDED',
      entity: 'WalletMovement',
      entityId: movement.id,
      newData: {
        wallet: wallet.name,
        partner: partner.name,
        amount,
        currencyCode: wallet.currencyCode,
        valueInStoreCurrency: value,
        storeCurrency: storeCode,
        note: movement.note,
      },
    });

    return NextResponse.json({ movement, balance: await walletBalance(db, wallet.id, walletMinor) }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
