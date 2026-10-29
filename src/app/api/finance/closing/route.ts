import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { blockingClosing, walletBalance } from '@/lib/wallets';
import { roundMinor } from '@/lib/money';
import { zodMessage } from '@/lib/zod-message';

/**
 * Daily closing, per wallet.
 *
 *   GET   /api/finance/closing?date=YYYY-MM-DD   book balance + today's row
 *   POST  /api/finance/closing                   record the counted balance
 *   PATCH /api/finance/closing                   approve one closing
 *
 * Three rules from the contract, all enforced here:
 *   - a non-zero difference needs a written explanation;
 *   - an unexplained difference BLOCKS the next day;
 *   - the person who records movements cannot approve that day's closing.
 */

const recordSchema = z.object({
  walletId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  actualBalance: z.number().min(-1_000_000_000).max(1_000_000_000),
  explanation: z.string().trim().max(500).optional(),
});

const approveSchema = z.object({
  closingId: z.string().uuid(),
  explanation: z.string().trim().max(500).optional(),
});

function dayOf(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

export async function GET(req: Request) {
  try {
    const { companyId, storeId } = await requireContext();
    await requirePermission('finance.cashbox_view');

    const dateParam = new URL(req.url).searchParams.get('date') ?? new Date().toISOString().slice(0, 10);
    const date = dayOf(dateParam);

    const wallets = await db.wallet.findMany({
      // This store's wallets only. A closing that counted another store's
      // cash would be wrong for both of them, and neither screen would say so.
      where: { companyId, storeId, isActive: true },
      include: { country: { select: { minorUnit: true } } },
      orderBy: { name: 'asc' },
    });

    const rows = await Promise.all(
      wallets.map(async (w) => {
        const balance = await walletBalance(db, w.id, w.country.minorUnit);
        const [closing, blocker] = await Promise.all([
          db.dailyClosing.findUnique({ where: { walletId_date: { walletId: w.id, date } } }),
          blockingClosing(db, w.id, date),
        ]);
        return {
          walletId: w.id,
          walletName: w.name,
          currencyCode: w.currencyCode,
          // Sent so the screen prints this wallet's own decimals. It was
          // rounding every difference to three, which is right for JOD
          // and wrong for the USD wallet the launch store uses.
          minorUnit: w.country.minorUnit,
          bookBalance: balance.balance,
          closing: closing
            ? {
                ...closing,
                bookBalance: Number(closing.bookBalance),
                actualBalance: Number(closing.actualBalance),
                difference: Number(closing.difference),
              }
            : null,
          // An earlier day with an unexplained difference blocks this one.
          blockedBy: blocker ? { id: blocker.id, date: blocker.date, difference: Number(blocker.difference) } : null,
        };
      })
    );

    return NextResponse.json({ date: dateParam, rows });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('finance.cashbox');

    const parsed = recordSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }
    const { walletId, actualBalance } = parsed.data;
    const date = dayOf(parsed.data.date);

    const wallet = await db.wallet.findFirst({
      // Closing a wallet is closing a store's till — not one next door's.
      where: { id: walletId, companyId, storeId, isActive: true },
      include: { country: { select: { minorUnit: true } } },
    });
    if (!wallet) return NextResponse.json({ error: 'المحفظة غير موجودة' }, { status: 404 });

    const blocker = await blockingClosing(db, walletId, date);
    if (blocker) {
      return NextResponse.json(
        {
          error: `إغلاق ${new Date(blocker.date).toISOString().slice(0, 10)} فيه فرق ${Number(blocker.difference)} بلا تفسير — فسّره أولاً`,
          code: 'PREVIOUS_CLOSING_UNEXPLAINED',
        },
        { status: 409 }
      );
    }

    const existing = await db.dailyClosing.findUnique({ where: { walletId_date: { walletId, date } } });
    if (existing?.status === 'APPROVED') {
      return NextResponse.json({ error: 'إغلاق هذا اليوم معتمد', code: 'ALREADY_APPROVED' }, { status: 409 });
    }

    const balance = await walletBalance(db, walletId, wallet.country.minorUnit);
    const difference = roundMinor(actualBalance - balance.balance, wallet.country.minorUnit);
    if (difference !== 0 && !parsed.data.explanation) {
      return NextResponse.json(
        { error: `الفرق ${difference} يحتاج تفسيراً مكتوباً`, code: 'EXPLANATION_REQUIRED', difference },
        { status: 400 }
      );
    }

    const closing = await db.dailyClosing.upsert({
      where: { walletId_date: { walletId, date } },
      create: {
        companyId, walletId, date,
        bookBalance: balance.balance,
        actualBalance,
        difference,
        explanation: parsed.data.explanation ?? null,
        recordedById: user.id,
      },
      update: {
        bookBalance: balance.balance,
        actualBalance,
        difference,
        explanation: parsed.data.explanation ?? null,
        recordedById: user.id,
      },
    });

    await logAudit({
      companyId, userId: user.id, action: 'DAILY_CLOSING_RECORDED',
      entity: 'DailyClosing', entityId: closing.id,
      newData: { wallet: wallet.name, date: parsed.data.date, book: balance.balance, actual: actualBalance, difference },
    });

    return NextResponse.json({ closing: { ...closing, difference }, bookBalance: balance.balance }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PATCH(req: Request) {
  try {
    const { user, companyId, storeId } = await requireContext();
    // Approving a closing is its own key (PR-9). The separation of duties below (whoever recorded the day's movements
    // or the count may not approve) is untouched.
    await requirePermission('finance.closing_approve');

    const parsed = approveSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }

    const closing = await db.dailyClosing.findFirst({
      // Approving is the same boundary as creating: a closing belongs to
      // the store whose wallet it counts.
      where: { id: parsed.data.closingId, companyId, wallet: { storeId } },
      include: { wallet: { select: { id: true, name: true, country: { select: { minorUnit: true } } } } },
    });
    if (!closing) return NextResponse.json({ error: 'الإغلاق غير موجود' }, { status: 404 });
    if (closing.status === 'APPROVED') {
      return NextResponse.json({ error: 'معتمد مسبقاً', code: 'ALREADY_APPROVED' }, { status: 409 });
    }

    // Separation of duties: whoever recorded the movements of this wallet on
    // this day may not approve its closing.
    const start = new Date(closing.date);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    const ownMovement = await db.walletMovement.findFirst({
      where: { walletId: closing.walletId, createdById: user.id, createdAt: { gte: start, lt: end } },
      select: { id: true },
    });
    if (ownMovement || closing.recordedById === user.id) {
      return NextResponse.json(
        {
          error: 'من يسجّل الحركات أو الجرد لا يعتمد الإغلاق — يعتمده شخص آخر',
          code: 'SEGREGATION_OF_DUTIES',
        },
        { status: 403 }
      );
    }

    /*
     * THE DIFFERENCE IS RECHECKED, NOT TRUSTED.
     *
     * It was worked out when the cash was counted. Every movement posted
     * between then and now has moved the book balance under it, so the
     * number on the row can say «zero» while the till is short. Approving
     * that signs off a discrepancy nobody ever saw.
     *
     * Refused rather than silently corrected: if the book has moved, the
     * count itself may no longer be the right count either, and only a
     * person standing at the till can say. The recorder re-records, and
     * the approver approves what is true now.
     */
    const minorUnit = closing.wallet.country?.minorUnit ?? 3;
    const now = await walletBalance(db, closing.walletId, minorUnit);
    const nowDifference = roundMinor(Number(closing.actualBalance) - now.balance, minorUnit);
    if (nowDifference !== Number(closing.difference)) {
      return NextResponse.json(
        {
          error: `تحرّك رصيدُ الدفتر بعد الجرد: الفرقُ المسجَّل ${Number(closing.difference)} والفرقُ الآن ${nowDifference} — أعِد تسجيل الجرد قبل الاعتماد`,
          code: 'CLOSING_OUT_OF_DATE',
          recordedDifference: Number(closing.difference),
          currentDifference: nowDifference,
        },
        { status: 409 }
      );
    }

    const explanation = parsed.data.explanation ?? closing.explanation;
    if (Number(closing.difference) !== 0 && !explanation) {
      return NextResponse.json(
        { error: 'لا يمكن اعتماد فرق بلا تفسير', code: 'EXPLANATION_REQUIRED' },
        { status: 409 }
      );
    }

    /*
     * ONE APPROVAL, decided by the row and not by the read above it.
     *
     * Two approvers pressing at once both passed that check and both
     * wrote, and the second one's name and timestamp replaced the first's
     * — a signature quietly overwritten on the record of a money count.
     */
    const claimed = await db.dailyClosing.updateMany({
      where: { id: closing.id, status: { not: 'APPROVED' } },
      data: { status: 'APPROVED', approvedById: user.id, approvedAt: new Date(), explanation: explanation ?? null },
    });
    if (claimed.count === 0) {
      return NextResponse.json({ error: 'معتمد مسبقاً', code: 'ALREADY_APPROVED' }, { status: 409 });
    }
    const approved = await db.dailyClosing.findUnique({ where: { id: closing.id } });

    await logAudit({
      companyId, userId: user.id, action: 'DAILY_CLOSING_APPROVED',
      entity: 'DailyClosing', entityId: closing.id,
      newData: { wallet: closing.wallet.name, difference: Number(closing.difference), explanation: explanation ?? null },
    });

    return NextResponse.json({ closing: approved });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
