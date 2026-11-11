import { NextResponse } from 'next/server';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { recordMovement } from '@/lib/wallets';
import { moneyText } from '@/lib/money';
import { zodMessage } from '@/lib/zod-message';
import { readTransfer, transferRefusal, TRANSFER_KIND_LABEL, type TransferSide } from '@/lib/transfer-kind';
import { resolveTransferAmounts } from '@/lib/transfer-rate';

/**
 * Wallet-to-wallet transfers — internal, between stores, between countries,
 * or an exchange of one currency for another inside one store of one
 * country. Which of the four it is comes from the two wallets rather than
 * from a choice, and is recorded so a wallet moved later cannot rewrite what
 * a past transfer meant. See lib/transfer-kind.
 *
 * WHEN THE CURRENCY CHANGES, THE PERSON GIVES ONE OF TWO THINGS — never both,
 * never neither:
 *
 *   `exchangeRate`  units of the destination per ONE of the source, as it
 *                   has always been; the arriving amount is worked out here.
 *   `amountIn`      the final amount that arrived, in the destination
 *                   currency («استلمت 1,290,000»); the rate is derived from
 *                   the two amounts and stored beside them.
 *
 * Either way it is stored with the transfer and never recalculated later:
 * the money changed hands at one rate, on one day, and the books must keep
 * saying so. `amountIn` is the authoritative number — the stored rate is six
 * decimals and SYP→USD is 0.0000769…, so nothing may multiply it back into
 * money. All of that arithmetic, and every refusal that comes of it, is
 * `resolveTransferAmounts` in lib/transfer-rate.
 *
 * A transfer is two movements — OUT of one wallet, IN to the other — written
 * in one transaction, so a wallet can never be left short by half a transfer.
 */
const createSchema = z.object({
  /**
   * The caller's id for THIS attempt, reused on every retry of it — the same arrangement as a receipt's `receiptId`.
   * A transfer is not something the server can tell from a double-click: two identical ones, seconds apart, are also
   * a person moving the same sum twice. Optional so an existing caller keeps working; and a caller that sends one is
   * safe against the 15-second timeout, where the answer is lost and the button is pressed again.
   *
   * A retry is answered only when it is the deal that was recorded (the wallets and both amounts): the same id with
   * another deal is a 409, so a deal changed after the answer was lost is never swallowed by the old row.
   */
  transferId: z.string().uuid().optional(),
  fromWalletId: z.string().uuid(),
  toWalletId: z.string().uuid(),
  amountOut: z.number().positive().max(1_000_000_000),
  /** Units of the destination per one of the source. Exclusive with `amountIn`; one of them when the currencies differ. */
  exchangeRate: z.number().positive().max(1_000_000).optional(),
  /**
   * The final amount that arrived, in the destination currency. Bounds are the resolver's, not the schema's: a
   * zero, a figure with too many decimals or one the column cannot hold each get their own Arabic sentence there.
   */
  amountIn: z.number().optional(),
  note: z.string().trim().min(3, 'الملاحظة إلزامية').max(300),
  /** What the screen told the person they were doing, checked server-side. */
  expectKind: z.enum(['INTERNAL', 'BETWEEN_STORES', 'BETWEEN_COUNTRIES', 'EXCHANGE']).optional(),
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
          // The look beside the name, so a row of the history is recognised the way its chip was (lib/wallet-look).
          select: {
            id: true, name: true, currencyCode: true, store: { select: { name: true } },
            imageKey: true, iconKey: true, colorKey: true,
          },
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

/** The transfer row as the screen reads it: Prisma hands back `Decimal`s, and JSON would print them as strings. */
const asNumbers = <T extends { amountOut: unknown; amountIn: unknown; exchangeRate: unknown }>(t: T) => ({
  ...t,
  amountOut: Number(t.amountOut),
  amountIn: Number(t.amountIn),
  exchangeRate: Number(t.exchangeRate),
});

/**
 * THE MONEY OF A TRANSFER: the four things that say WHICH deal it was.
 *
 * A replay is a success to repeat only for the deal it recorded. The same id carrying ANOTHER deal (the person
 * changed the amount, or the wallet, after the answer was lost) is not a retry: it is a new request that would be
 * answered with the old row, the new deal lost and the screen saying «تم». So the stored row is compared with the
 * request on these four, and anything else is a conflict.
 *
 * The note is not among them, on purpose: it is words, and a retry that mends a typo in it is still the same money,
 * which must not be moved twice.
 */
interface Deal {
  fromWalletId: string;
  toWalletId: string;
  amountOut: number;
  amountIn: number;
}

const sameDeal = (row: { fromWalletId: string; toWalletId: string; amountOut: unknown; amountIn: unknown }, deal: Deal) =>
  row.fromWalletId === deal.fromWalletId &&
  row.toWalletId === deal.toWalletId &&
  Number(row.amountOut) === deal.amountOut &&
  Number(row.amountIn) === deal.amountIn;

/**
 * The id is taken: by a different deal of this company, or by another company's row. Nothing is written, and
 * nothing of the row that holds the id is said: not its amounts, not its wallets, not whose it is.
 */
const taken = () =>
  NextResponse.json(
    { error: 'هالتحويل انسجّل من قبل بصفقة تانية — حدّث الصفحة وراجع قبل ما تعيد', code: 'TRANSFER_EXISTS' },
    { status: 409 }
  );

/**
 * WHAT A REQUEST WOULD RECORD, in the fields a stored transfer keeps, or `null` when that cannot be said.
 *
 * An arriving amount that was typed is the deal as it stands. A rate, or one currency, is worked out from the two
 * wallets by the very function the write uses: the wallets as they are, stopped ones included, because the transfer
 * being repeated may be the reason they were stopped.
 */
async function askedDeal(companyId: string, input: z.infer<typeof createSchema>): Promise<Deal | null> {
  const ends = { fromWalletId: input.fromWalletId, toWalletId: input.toWalletId };
  if (input.amountIn !== undefined) return { ...ends, amountOut: input.amountOut, amountIn: input.amountIn };

  const pick = (id: string) =>
    db.wallet.findFirst({ where: { id, companyId }, include: { country: { select: { minorUnit: true } } } });
  const [from, to] = await Promise.all([pick(input.fromWalletId), pick(input.toWalletId)]);
  if (!from || !to) return null;
  const money = resolveTransferAmounts({
    fromCode: from.currencyCode,
    toCode: to.currencyCode,
    fromName: from.name,
    toName: to.name,
    amountOut: input.amountOut,
    exchangeRate: input.exchangeRate,
    fromMinor: from.country.minorUnit,
    toMinor: to.country.minorUnit,
  });
  return money.ok ? { ...ends, amountOut: money.amountOut, amountIn: money.amountIn } : null;
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

    /*
     * A REPLAY FINDS ITS OWN ROW AND WRITES NOTHING, BUT ONLY FOR THE DEAL IT RECORDED.
     *
     * Asked FIRST, before the wallets are read and judged: the first attempt may have succeeded and the wallet been
     * stopped since, and a retry of a transfer that happened is a success to repeat, not a «المحفظة غير موجودة».
     * Scoped to the company, so another tenant's id is not even looked at.
     *
     * The row is then compared with the request (`sameDeal`). The same id with another deal is answered 409 and
     * nothing is written: never the old row under a new request, which is how a changed amount was lost behind a
     * «تم». (The wallets are compared first: another pair needs no arithmetic to be another deal.)
     */
    if (input.transferId) {
      const already = await db.walletTransfer.findFirst({ where: { id: input.transferId, companyId } });
      if (already) {
        const asked =
          already.fromWalletId === input.fromWalletId && already.toWalletId === input.toWalletId
            ? await askedDeal(companyId, input)
            : null;
        return asked && sameDeal(already, asked)
          ? NextResponse.json({ transfer: asNumbers(already), replay: true }, { status: 200 })
          : taken();
      }
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

    // The client says which of the four it believes it is doing. If the
    // server reads it differently, something moved between the screen being
    // drawn and the button being pressed, and nobody should find out from
    // the ledger a month later.
    if (input.expectKind && input.expectKind !== reading.kind) {
      return NextResponse.json(
        { error: `تغيّر نوع التحويل — هذا ${reading.label}. راجعه وأعد المحاولة.`, code: 'KIND_CHANGED', kind: reading.kind },
        { status: 409 }
      );
    }

    /*
     * THE MONEY: what leaves, what arrives, and the rate that is stored beside them.
     *
     * «WAS A RATE GIVEN» IS A QUESTION ABOUT PRESENCE, NOT ABOUT TRUTH — the resolver asks `=== undefined`, never
     * `!rate` (c119e31 took the same conflation out of the expense door). And `.positive()` on the rate is right
     * from the column and the arithmetic: `exchangeRate` is `Decimal(14,6)` and NOT NULL, and `recordMovement`
     * refuses an amount of zero, so a rate of 0 could never produce a transfer that is written.
     */
    const money = resolveTransferAmounts({
      fromCode: from.currencyCode,
      toCode: to.currencyCode,
      fromName: from.name,
      toName: to.name,
      amountOut: input.amountOut,
      exchangeRate: input.exchangeRate,
      amountIn: input.amountIn,
      fromMinor: from.country.minorUnit,
      toMinor: to.country.minorUnit,
    });
    if (!money.ok) return NextResponse.json({ error: money.error, code: money.code }, { status: 400 });
    const { amountOut, amountIn, rate, entered } = money;

    // What the arriving movement says about the exchange. A typed RATE keeps the line it has always had; a typed
    // AMOUNT says what was exchanged for what, because the derived rate is six decimals (SYP→USD reads 0.000077).
    const exchangeNote =
      entered === 'RATE'
        ? ` (سعر الصرف ${rate})`
        : entered === 'AMOUNT_IN'
          ? ` (صُرِف ${moneyText(amountOut, from.currencyCode, from.country.minorUnit)} إلى ${moneyText(amountIn, to.currencyCode, to.country.minorUnit)})`
          : '';

    let transfer;
    try {
      transfer = await db.$transaction(async (tx) => {
        const created = await tx.walletTransfer.create({
          data: {
            ...(input.transferId ? { id: input.transferId } : {}),
            companyId,
            fromWalletId: from.id,
            toWalletId: to.id,
            amountOut,
            amountIn,
            // Stored as entered for a rate, derived from the two amounts for an amount; nothing recalculates it later.
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
          note: `${input.note}${exchangeNote}`,
          referenceType: 'TRANSFER', referenceId: created.id, createdById: user.id,
        });

        return created;
      });
    } catch (e) {
      /*
       * Two requests carrying the same id at the same moment: the check above saw nothing, the database saw the second
       * one, and its transaction rolled back whole (the transfer row is the first write). P2002 here can only be that
       * id. If the row is this company's AND it is this very deal, it is the twin's: a success to repeat. A different
       * deal under the id, or another company's row, is a conflict that says nothing about the row.
       */
      if (input.transferId && e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const twin = await db.walletTransfer.findFirst({ where: { id: input.transferId, companyId } });
        return twin && sameDeal(twin, { fromWalletId: from.id, toWalletId: to.id, amountOut, amountIn })
          ? NextResponse.json({ transfer: asNumbers(twin), replay: true }, { status: 200 })
          : taken();
      }
      throw e;
    }

    await logAudit({
      companyId, userId: user.id, action: 'WALLET_TRANSFER',
      entity: 'WalletTransfer', entityId: transfer.id,
      // `entered` is how the person gave the exchange: a rate, the amount that arrived, or nothing (one currency).
      newData: { kind: reading.kind, from: from.name, to: to.name, amountOut, amountIn, rate, entered },
    });

    return NextResponse.json(
      { transfer: { ...transfer, amountOut, amountIn, exchangeRate: rate }, reading },
      { status: 201 }
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
