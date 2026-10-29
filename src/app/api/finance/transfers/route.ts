import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { recordMovement } from '@/lib/wallets';
import { roundMinor } from '@/lib/money';
import { zodMessage } from '@/lib/zod-message';
import { readTransfer, transferRefusal, TRANSFER_KIND_LABEL, type TransferSide } from '@/lib/transfer-kind';

/**
 * Wallet-to-wallet transfers — internal, between stores, or between
 * countries. Which of the three it is comes from the two wallets rather
 * than from a choice, and is recorded so a wallet moved later cannot
 * rewrite what a past transfer meant. See lib/transfer-kind.
 *
 * The exchange rate is ENTERED BY THE USER and stored with the transfer. It
 * is never recalculated later: the money changed hands at one rate, on one
 * day, and the books must keep saying so.
 *
 * A transfer is two movements — OUT of one wallet, IN to the other — written
 * in one transaction, so a wallet can never be left short by half a transfer.
 */
const createSchema = z.object({
  fromWalletId: z.string().uuid(),
  toWalletId: z.string().uuid(),
  amountOut: z.number().positive().max(1_000_000_000),
  /** Required only when the two wallets hold different currencies. */
  exchangeRate: z.number().positive().max(1_000_000).optional(),
  note: z.string().trim().min(3, 'الملاحظة إلزامية').max(300),
  /** What the screen told the person they were doing, checked server-side. */
  expectKind: z.enum(['INTERNAL', 'BETWEEN_STORES', 'BETWEEN_COUNTRIES']).optional(),
});

export async function GET() {
  try {
    const { companyId } = await requireContext();
    await requirePermission('finance.cashbox_view');

    const transfers = await db.walletTransfer.findMany({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const walletIds = [...new Set(transfers.flatMap((t) => [t.fromWalletId, t.toWalletId]))];
    const wallets = walletIds.length
      ? await db.wallet.findMany({
          where: { id: { in: walletIds } },
          select: { id: true, name: true, currencyCode: true, store: { select: { name: true } } },
        })
      : [];
    const walletOf = new Map(wallets.map((w) => [w.id, w]));

    return NextResponse.json({
      transfers: transfers.map((t) => ({
        ...t,
        amountOut: Number(t.amountOut),
        amountIn: Number(t.amountIn),
        exchangeRate: Number(t.exchangeRate),
        // The kind as it was RECORDED, not re-read now: a wallet moved to
        // another store since must not change what this transfer was.
        kindLabel: TRANSFER_KIND_LABEL[t.kind as keyof typeof TRANSFER_KIND_LABEL] ?? t.kind,
        from: walletOf.get(t.fromWalletId) ?? null,
        to: walletOf.get(t.toWalletId) ?? null,
      })),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    const { user, companyId } = await requireContext();
    await requirePermission('finance.cashbox');

    const parsed = createSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }
    const input = parsed.data;
    if (input.fromWalletId === input.toWalletId) {
      return NextResponse.json({ error: 'لا يمكن التحويل إلى نفس المحفظة' }, { status: 400 });
    }

    const [from, to] = await Promise.all([
      db.wallet.findFirst({
        where: { id: input.fromWalletId, companyId, isActive: true },
        include: {
          country: { select: { minorUnit: true, name: true } },
          store: { select: { name: true } },
        },
      }),
      db.wallet.findFirst({
        where: { id: input.toWalletId, companyId, isActive: true },
        include: {
          country: { select: { minorUnit: true, name: true } },
          store: { select: { name: true } },
        },
      }),
    ]);
    if (!from || !to) return NextResponse.json({ error: 'إحدى المحفظتين غير موجودة' }, { status: 404 });

    const side = (w: typeof from): TransferSide => ({
      id: w.id, name: w.name, currencyCode: w.currencyCode,
      storeId: w.storeId, countryId: w.countryId,
      storeName: w.store?.name ?? null, countryName: w.country.name,
    });
    const fromSide = side(from);
    const toSide = side(to);

    const refusal = transferRefusal(fromSide, toSide);
    if (refusal) return NextResponse.json({ error: refusal, code: 'TRANSFER_REFUSED' }, { status: 400 });

    const reading = readTransfer(fromSide, toSide);

    // The client says which of the three it believes it is doing. If the
    // server reads it differently, something moved between the screen being
    // drawn and the button being pressed, and nobody should find out from
    // the ledger a month later.
    if (input.expectKind && input.expectKind !== reading.kind) {
      return NextResponse.json(
        { error: `تغيّر نوع التحويل — هذا ${reading.label}. راجعه وأعد المحاولة.`, code: 'KIND_CHANGED', kind: reading.kind },
        { status: 409 }
      );
    }

    const sameCurrency = from.currencyCode === to.currencyCode;
    /*
     * «WAS A RATE GIVEN» IS A QUESTION ABOUT PRESENCE, NOT ABOUT TRUTH.
     *
     * This read `!input.exchangeRate`, and it was correct only by the luck of
     * the line above: the schema says `.positive()`, so by here the value is
     * `undefined` or greater than zero and `!x` happens to coincide with
     * `x === undefined`. Loosen the schema to `.min(0)` one day and a rate of
     * **0** — a number somebody typed — is answered «يتطلب سعر صرف», which
     * sends the reader looking for an empty box they have just filled in. The
     * same conflation `c119e31` removed from the expense door.
     *
     * AND THE `.positive()` IS RIGHT, from the column and the arithmetic:
     * `exchangeRate` is `Decimal(14,6)` and NOT NULL, `amountIn` is
     * `amountOut * rate`, and `recordMovement` refuses an amount of zero —
     * so a rate of 0 can never produce a transfer that is written. There is
     * no legitimate rate of zero: it would mean money left one wallet and
     * none arrived in the other.
     */
    if (!sameCurrency && input.exchangeRate === undefined) {
      return NextResponse.json(
        {
          error: `التحويل من ${from.currencyCode} إلى ${to.currencyCode} يتطلب سعر صرف`,
          code: 'EXCHANGE_RATE_REQUIRED',
        },
        { status: 400 }
      );
    }

    const rate = sameCurrency ? 1 : (input.exchangeRate as number);
    const amountIn = roundMinor(input.amountOut * rate, to.country.minorUnit);
    const amountOut = roundMinor(input.amountOut, from.country.minorUnit);

    /*
     * A RATE SMALL ENOUGH TO ROUND THE ARRIVING AMOUNT TO NOTHING IS REFUSED
     * HERE, WITH A 400 — because `recordMovement`'s own guard
     * (`amount <= 0` → `throw`) fires inside the transaction and comes back
     * as the generic **500 «حدث خطأ داخلي»**, which tells the person to call
     * the administrator about a rate they can fix themselves. Measured:
     * `.positive()` admits `0.000001`, and 100 at that rate into a 3-decimal
     * currency is `roundMinor(0.0001, 3) === 0`. Nothing was ever written
     * wrongly — the transaction rolls back — but the sentence was wrong, and
     * `0aea050`'s rule for a bad money value is a 400 that names it.
     */
    if (amountIn <= 0) {
      return NextResponse.json(
        {
          error: `سعر الصرف ${rate} يجعل المبلغ الواصل إلى ${to.name} صفراً. راجع سعر الصرف.`,
          code: 'EXCHANGE_RATE_TOO_SMALL',
        },
        { status: 400 }
      );
    }

    const transfer = await db.$transaction(async (tx) => {
      const created = await tx.walletTransfer.create({
        data: {
          companyId,
          fromWalletId: from.id,
          toWalletId: to.id,
          amountOut,
          amountIn,
          // Stored as entered; nothing recalculates it later.
          exchangeRate: rate,
          kind: reading.kind,
          note: input.note,
          createdById: user.id,
        },
      });

      await recordMovement(tx, {
        companyId, walletId: from.id, direction: 'OUT', amount: amountOut,
        party: `تحويل إلى ${to.name}`, category: 'TRANSFER_OUT',
        note: input.note, referenceType: 'TRANSFER', referenceId: created.id, createdById: user.id,
      });
      await recordMovement(tx, {
        companyId, walletId: to.id, direction: 'IN', amount: amountIn,
        party: `تحويل من ${from.name}`, category: 'TRANSFER_IN',
        note: `${input.note}${sameCurrency ? '' : ` (سعر الصرف ${rate})`}`,
        referenceType: 'TRANSFER', referenceId: created.id, createdById: user.id,
      });

      return created;
    });

    await logAudit({
      companyId, userId: user.id, action: 'WALLET_TRANSFER',
      entity: 'WalletTransfer', entityId: transfer.id,
      newData: { kind: reading.kind, from: from.name, to: to.name, amountOut, amountIn, rate },
    });

    return NextResponse.json(
      { transfer: { ...transfer, amountOut, amountIn, exchangeRate: rate }, reading },
      { status: 201 }
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
