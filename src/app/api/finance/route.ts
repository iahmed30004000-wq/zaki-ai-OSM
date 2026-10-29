import { NextResponse } from 'next/server';
import type { ProfitSummary } from '@/lib/profit-summary';
import { apiErrorResponse } from '@/lib/api-error';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { logAudit } from '@/lib/audit';
import { requirePermission } from '@/lib/authorization';
import { commissionCostForOrders } from '@/lib/commission';
import { getCompanyAnalytics, getDateRange, previousRange } from '@/lib/analytics';
import { gradeExpenseTypes, ledgerTrust, resolveExpenseCategory, type ExpenseTypeInput } from '@/lib/expense-grade';
import { z } from 'zod';
import { numeric } from '@/lib/numeric-input';
import { zodMessage } from '@/lib/zod-message';

/**
 * ─── HOW MUCH MONEY LEFT: READ BY THE ONE STRICT READER, NOT BY `parseFloat` ───
 *
 * This line was `const value = parseFloat(amount)`, and this file is the one
 * every other numeric fix in this audit was told to copy — so the weakness
 * was being copied with it. `parseFloat` STOPS at the first character it
 * cannot read and returns what it got:
 *
 *     parseFloat('2,500')  →  2       an Arabic-keyboard decimal comma
 *     parseFloat('12abc')  →  12
 *     parseFloat('1e5')    →  100000  (fine, but by accident)
 *
 * So an API client sending `'2,500'` recorded an expense of **2** — and
 * wrote a wallet movement OUT of 2 beside it, in the same transaction, so
 * the books and the ledger agreed on the wrong number. Nobody is told. The
 * old guard below it (`!Number.isFinite(value) || value <= 0`) could not see
 * it either: 2 is finite and positive.
 *
 * `numeric()` is `numeric-input.ts`'s reader, which this repository already
 * uses on every door that moves money or stock. It is stricter than
 * `Number()` as well as `parseFloat`: it refuses `'2,500'`, `'12abc'`, `''`,
 * `'   '`, `null`, `[]`, `{}`, `true` and — the one a hand-rolled `Number()`
 * reader still lets through — `'0x10'`, which `Number` reads as **16**.
 * Reusing it rather than writing a fourth reader is the point: the rule has
 * one home.
 *
 * ─── AND A ZERO IS REFUSED. THE REASON IS THE COLUMN, NOT TASTE. ───
 *
 * `readBasePrice` deliberately ALLOWS a typed 0, so the two doors differ and
 * the difference is argued from the schema:
 *
 *   · `Product.basePrice` is `@default(0.0)`. The column itself says zero is
 *     a value — a sample, a gift, a price not set yet.
 *   · `Expense.amount` is `Float` with **no default**. Nothing in the schema
 *     nominates 0, and the row does not stand alone: this door writes a
 *     paired `WalletMovement` of the same amount in the same transaction,
 *     and the *other* door onto that table
 *     (`finance/wallets/[id]/movements`) declares `z.number().positive()`.
 *     A 0 expense would therefore mint a 0 movement that the only other way
 *     of making a movement refuses by name — one rule, two answers.
 *
 * An expense of nothing is not an expense: no money left the wallet, so
 * there is nothing to subtract from profit and nothing to tie to a drawer.
 * The refusal says so in words rather than through a falsy check.
 */
const EXPENSE_AMOUNT_MAX = 1_000_000_000;

const amountBody = z.object({
  /*
   * Wrapped in an object SO THAT THE PATH NAMES THE FIELD. `zodMessage`
   * reads `issue.path` to print «المبلغ: …»; a bare schema has an empty
   * path and the reader gets «اكتب رقماً بالأرقام» with no field in it.
   */
  amount: numeric()
    .refine((v) => v > 0, { message: 'المبلغ أكبر من صفر — مصروفٌ بصفرٍ ليس مصروفاً' })
    .refine((v) => v <= EXPENSE_AMOUNT_MAX, { message: `المبلغ ${EXPENSE_AMOUNT_MAX} على الأكثر` }),
});

export async function GET(req: Request) {
  try {
    const { companyId, storeId, country } = await requireContext();
    await requirePermission('finance.view');

    const expenses = await db.expense.findMany({
      where: { companyId },
      orderBy: { expenseDate: 'desc' },
    });

    const deliveredOrders = await db.order.findMany({
      where: { companyId, storeId, status: 'DELIVERED' },
      select: {
        id: true,
        orderNumber: true,
        totalAmount: true,
        shippingCost: true,
        estimatedCostOfGoods: true,
        deliveredAt: true,
      },
      orderBy: { deliveredAt: 'desc' },
    });

    const totalRevenue = deliveredOrders.reduce((s, o) => s + o.totalAmount, 0);
    const totalCOGS = deliveredOrders.reduce((s, o) => s + o.estimatedCostOfGoods, 0);
    const totalShipping = deliveredOrders.reduce((s, o) => s + o.shippingCost, 0);
    // From the LEDGER — the one commission source. Summing
    // Order.moderatorCommission here gave this screen a different total
    // from the commission screen for the same orders.
    // NOTE: the delivered-order query above still selects on the legacy
    // `status` column, so revenue and commission here are computed over
    // slightly different sets of orders. That mismatch predates this change
    // and is reported, not silently repaired — correcting it moves the
    // revenue figure on this screen.
    const totalCommissions = await commissionCostForOrders({ companyId, storeId, shippingStatus: 'DELIVERED' });
    const totalOperationalExpenses = expenses.reduce((s, e) => s + e.amount, 0);

    const netProfit =
      totalRevenue -
      totalCOGS -
      totalShipping -
      totalCommissions -
      totalOperationalExpenses;

    // Typed against the one shape the screen also uses: a field added
    // here without adding it there is a crash on the screen, so the two
    // lists are the same list.
    const summary: ProfitSummary = {
      totalRevenue: Number(totalRevenue.toFixed(2)),
      totalCOGS: Number(totalCOGS.toFixed(2)),
      totalShipping: Number(totalShipping.toFixed(2)),
      totalCommissions: Number(totalCommissions.toFixed(2)),
      // The two are shown together on the profit screen, so they are
      // added HERE. Added in the browser they disagreed with the books
      // the moment either rule changed on this side.
      shippingAndCommissions: Number((totalShipping + totalCommissions).toFixed(2)),
      totalOperationalExpenses: Number(totalOperationalExpenses.toFixed(2)),
      netProfit: Number(netProfit.toFixed(2)),
      profitMargin: totalRevenue > 0 ? Number(((netProfit / totalRevenue) * 100).toFixed(1)) : 0,
    };

    /**
     * ─── WHERE THE MONEY GOES, BY KIND OF SPENDING ───
     *
     * The ledger below lists rows and nothing adds them up per type, so the
     * one question an owner has about spending — «على أيّ بند يذهب مالي،
     * وأيّ بندٍ يكبر من تحتي» — had no answer on any screen in this product.
     *
     * ON ITS OWN WINDOW, DELIBERATELY. Everything else this route returns is
     * «since the beginning»: a lifetime total is the right shape for a
     * profit summary and the wrong shape entirely for a spending habit,
     * because a habit is only visible as a change. So the types are read
     * over THIS MONTH against LAST MONTH, equally long, which is also the
     * period people already think about salaries and rent in. The screen
     * says which window it is showing.
     *
     * THE TWO ANALYTICS CALLS ARE SKIPPED WHEN THERE IS NOTHING TO GRADE.
     * Revenue is the burden's denominator and it must come from the one
     * profit engine — computing it here would be a second definition of
     * «delivered revenue», which is the most expensive kind of duplication
     * in this system. But it is only needed if an expense exists at all, and
     * on this database none does, so the common case pays nothing.
     */
    const spendFilter = { period: 'month' as const };
    const thisMonth = getDateRange(spendFilter);
    const lastMonth = previousRange(spendFilter);

    const [monthRows, priorRows] = await Promise.all([
      db.expense.groupBy({
        by: ['category'],
        where: {
          companyId,
          ...(thisMonth.start && thisMonth.end ? { expenseDate: { gte: thisMonth.start, lte: thisMonth.end } } : {}),
        },
        _count: { _all: true },
        _sum: { amount: true },
      }),
      lastMonth
        ? db.expense.groupBy({
            by: ['category'],
            where: { companyId, expenseDate: { gte: lastMonth.start, lte: lastMonth.end } },
            _count: { _all: true },
            _sum: { amount: true },
          })
        : Promise.resolve([]),
    ]);

    const monthSpend = monthRows.reduce((t, g) => t + Number(g._sum.amount ?? 0), 0);
    const monthCount = monthRows.reduce((t, g) => t + g._count._all, 0);

    let spendByType: ReturnType<typeof gradeExpenseTypes> = [];
    let spendWindow: { deliveredRevenue: number; priorDeliveredRevenue: number | null; totalSpend: number } = {
      deliveredRevenue: 0,
      priorDeliveredRevenue: null,
      totalSpend: 0,
    };

    if (monthCount > 0) {
      const [now, before] = await Promise.all([
        getCompanyAnalytics({ companyId, storeId }, spendFilter),
        lastMonth
          ? getCompanyAnalytics({ companyId, storeId }, spendFilter, lastMonth)
          : Promise.resolve(null),
      ]);
      spendWindow = {
        totalSpend: Number(monthSpend.toFixed(2)),
        deliveredRevenue: now.financials.deliveredRevenue,
        priorDeliveredRevenue: before ? before.financials.deliveredRevenue : null,
      };

      const priorOf = new Map(priorRows.map((g) => [g.category, g]));
      const inputs: ExpenseTypeInput[] = monthRows.map((g) => {
        const was = priorOf.get(g.category);
        return {
          category: g.category,
          rows: g._count._all,
          amount: Number(g._sum.amount ?? 0),
          // Zero, not null, when last month HAS expenses but none of this
          // kind: «nothing was spent on packaging» and «there was no last
          // month» are different facts, and only the first makes a type NEW.
          priorAmount: was ? Number(was._sum.amount ?? 0) : lastMonth && priorRows.length > 0 ? 0 : null,
          priorRows: was?._count._all ?? 0,
        };
      });
      spendByType = gradeExpenseTypes(inputs, spendWindow);
    }

    // Does the ledger tie to money that actually left a wallet? Asked over
    // the whole ledger, because it is a question about bookkeeping habit
    // rather than about any one month.
    const withWallet = expenses.filter((e) => !!e.walletId).length;

    return NextResponse.json({
      // The country's own currency. The screen printed "$" beside every
      // figure in a system that runs Syrian pounds, dinars and Egyptian
      // pounds side by side.
      currency: country.currencyCode,
      summary,
      expenses,
      recentDeliveredOrders: deliveredOrders.slice(0, 20),
      spend: {
        byType: spendByType,
        rows: monthCount,
        totalSpend: spendWindow.totalSpend,
        deliveredRevenue: spendWindow.deliveredRevenue,
        priorDeliveredRevenue: spendWindow.priorDeliveredRevenue,
        hasPrevious: !!lastMonth,
        ledger: ledgerTrust(withWallet, expenses.length),
        window: {
          from: thisMonth.start?.toISOString() ?? null,
          to: thisMonth.end?.toISOString() ?? null,
        },
      },
    });
  } catch (error: any) {
    return apiErrorResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId } = await requireContext();
    // Phase S: writing expenses requires finance.create (not just view)
    await requirePermission('finance.create');

    const body = await req.json();
    const { title, category, amount, expenseDate, notes, walletId } = body;

    /*
     * `!amount` IS GONE FROM THIS LINE, AND THAT IS A FIX, NOT A LOOSENING.
     *
     * It read `!title || !category || !amount`: a falsy check on a NUMBER,
     * the family this audit has been clearing. It did shield the column — a
     * cleared box arriving as `0` got a 400 rather than a silent zero row —
     * but it shielded it by accident and with the wrong sentence: an amount
     * that ARRIVED as a deliberate 0 was told «المبلغ مطلوب», which sends
     * the reader looking for an empty box they had just filled in.
     *
     * The amount is now read below, by name, with «لم يُكتَب» and «كُتِب
     * خطأً» as two different sentences — the distinction `zod-message.ts`
     * carries. Zero is still refused; it is refused for its own reason.
     */
    if (!title || !category) {
      return NextResponse.json({ error: 'العنوان والفئة مطلوبان' }, { status: 400 });
    }
    /*
     * THE TYPE IS ONE OF THE EIGHT, AND IS STORED AS ITS KEY.
     *
     * This stored whatever string arrived — `'rent'`, `'Marketing'` — and the spend-by-type card then printed it
     * as written beside the real eight and grouped it apart. A title that is not a string would also have thrown
     * on `.trim()` below as a 500. Both are 400s with a sentence now, and nothing is written.
     */
    const categoryKey = resolveExpenseCategory(category);
    if (!categoryKey) {
      return NextResponse.json(
        { error: 'نوع المصروف غير معروف — اختر نوعاً من القائمة.', code: 'UNKNOWN_CATEGORY' },
        { status: 400 }
      );
    }
    if (typeof title !== 'string' || !title.trim()) {
      return NextResponse.json({ error: 'العنوان والفئة مطلوبان' }, { status: 400 });
    }

    const amountRead = amountBody.safeParse({ amount });
    if (!amountRead.success) {
      return NextResponse.json({ error: zodMessage(amountRead.error) }, { status: 400 });
    }
    const value = amountRead.data.amount;

    /**
     * WHICH WALLET THE MONEY LEFT.
     *
     * Required. An expense recorded with no wallet was money that had left
     * the company and existed nowhere in the wallet ledger — so the daily
     * closing, which compares the drawer against the book balance, showed a
     * shortfall nobody could explain, and somebody wrote an explanation for
     * an expense that was already recorded on another screen.
     */
    if (!walletId) {
      return NextResponse.json({ error: 'اختر المحفظة التي خرج منها المال' }, { status: 400 });
    }
    // This store's wallet or one not placed yet — what the wallets screen
    // offers the expense form (finance/wallets GET). A wallet id of another
    // store of the company used to be enough to spend from it.
    const wallet = await db.wallet.findFirst({
      where: { id: walletId, companyId, isActive: true, ...(storeId ? { OR: [{ storeId }, { storeId: null }] } : {}) },
      select: { id: true, name: true, currencyCode: true },
    });
    if (!wallet) {
      return NextResponse.json({ error: 'المحفظة غير موجودة أو موقوفة' }, { status: 404 });
    }

    // Both in one transaction: an expense without its movement is the fault
    // coming back, and a movement without its expense is money leaving with
    // no reason written beside it.
    const expense = await db.$transaction(async (tx) => {
      const row = await tx.expense.create({
        data: {
          companyId,
          title: title.trim(),
          category: categoryKey, // checked above: one of the eight keys in expense-grade
          amount: value,
          expenseDate: expenseDate ? new Date(expenseDate) : new Date(),
          notes: notes?.trim() || null,
          walletId: wallet.id,
          createdById: user.id,
        },
      });

      const movement = await tx.walletMovement.create({
        data: {
          companyId,
          walletId: wallet.id,
          direction: 'OUT',
          amount: value,
          currencyCode: wallet.currencyCode,
          party: title.trim(),
          category: 'EXPENSE',
          // The movement's note is required (`wallet_movements.note` is NOT NULL) and the expense's is optional:
          // an expense recorded with no notes wrote `null` here and the whole expense failed. The movement says
          // why the money left; with no notes, that is the expense itself.
          note: notes?.trim() || `مصروف: ${title.trim()}`,
          referenceType: 'EXPENSE',
          referenceId: row.id,
          createdById: user.id,
        },
      });

      return tx.expense.update({ where: { id: row.id }, data: { movementId: movement.id } });
    });

    await logAudit({
      companyId,
      userId: user.id,
      action: 'EXPENSE_RECORDED',
      entity: 'Expense',
      entityId: expense.id,
      newData: expense,
    });

    return NextResponse.json({ success: true, expense });
  } catch (error: any) {
    return apiErrorResponse(error);
  }
}
