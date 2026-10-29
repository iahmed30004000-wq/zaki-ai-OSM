import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { zodMessage } from '@/lib/zod-message';
import { logAudit } from '@/lib/audit';
import { paySalary, previewPayslip, PayrollRefused } from '@/lib/payroll';
import { MIN_CONVERT_RATE } from '@/lib/currencies';
import { readTypedFigure } from '@/lib/numeric-input';
import { currentSpan } from '@/lib/commission-period';
import { owedTo } from '@/lib/commission-payout';

/**
 * GET/POST /api/payroll/payslip — what this month pays, and paying it.
 *
 * The preview is a GET on purpose: somebody about to hand over money is
 * entitled to see the salary, the deductions coming out of it and what is
 * actually left BEFORE they commit to anything. A screen that only shows
 * the number after the payment is a screen that gets a month wrong once.
 *
 * Both need `payroll.pay`. Reading somebody's pay is `payroll.view`, and
 * this is not reading — it is the page you pay from.
 */

/** The month being paid: the last closed one by default, not the running one. */
function periodOf(param: string | null): { start: Date; end: Date } {
  if (param && /^\d{4}-\d{2}$/.test(param)) {
    const [y, m] = param.split('-').map(Number);
    return { start: new Date(Date.UTC(y, m - 1, 1)), end: new Date(Date.UTC(y, m, 0)) };
  }
  // A month still being worked has days nobody has been paid for and days
  // nobody has been late on yet. The default is the month that closed.
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  return { start, end };
}

/**
 * A MONTH THAT HAS NOT BEGUN HAS NOTHING TO PAY FOR.
 *
 * `period` was any `YYYY-MM`: `2031-01` was accepted, the payslip was written for it, and the one-payslip-per-month
 * rule then refused the real January in 2031 — «already paid» — for a salary that was handed over five years early.
 * The running month is still allowed (the default is the last closed one; paying the running month is a choice the
 * payer is allowed to make); only a month AFTER it is refused. UTC, like `periodOf`.
 */
function notBegunYet(start: Date, now: Date = new Date()): boolean {
  return start.getTime() > Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
}

const FUTURE_PERIOD = { error: 'هذا الشهر ما بدأ بعد — ما بينصرف راتبه', code: 'FUTURE_PERIOD' } as const;

/**
 * The conversion of deductions in ANOTHER currency, as the payer typed it: the currency, and the salary's currency
 * for one unit of it. Both or neither — a rate with no currency (or the reverse) is refused, not guessed.
 */
const convertSchema = z.object({
  currencyCode: z.string().trim().toUpperCase().length(3),
  // Not below what the rate column holds (six decimals): a smaller rate turns a deduction into nothing.
  rate: z.number().min(MIN_CONVERT_RATE, 'السعر صغير جداً — الخصم بيطلع صفر').max(1_000_000),
});

export async function GET(req: Request) {
  try {
    const { companyId, storeId } = await requireContext();
    await requirePermission('payroll.pay');

    const q = new URL(req.url).searchParams;
    const userId = q.get('userId');
    if (!userId) return NextResponse.json({ error: 'حدّد الموظف' }, { status: 400 });

    const period = periodOf(q.get('period'));
    if (notBegunYet(period.start)) return NextResponse.json(FUTURE_PERIOD, { status: 400 });

    // `convertCurrency` + `convertRate`: draw the slip as it would be with the deductions of that currency converted.
    const wantsConvert = q.get('convertCurrency') !== null || q.get('convertRate') !== null;
    const convert = wantsConvert
      ? convertSchema.safeParse({ currencyCode: q.get('convertCurrency'), rate: readTypedFigure(q.get('convertRate')) })
      : null;
    if (convert && !convert.success) return NextResponse.json({ error: 'اكتب العملة وسعر تحويلها' }, { status: 400 });

    const already = await db.payslip.findFirst({
      where: { companyId, userId, periodStart: period.start },
      select: { id: true, netAmount: true, createdAt: true },
    });

    try {
      const preview = await previewPayslip(db, { companyId, storeId, userId, convert: convert?.success ? convert.data : null });
      // What they are owed in commission is SHOWN beside the wage, and paid
      // by its own button: a commission not yet payable must not hold up a
      // salary that is due today.
      const [commission, wallets] = await Promise.all([
        owedTo(db, { companyId, userId }).catch(() => []),
        // Listed here rather than fetched separately: the wallet a salary
        // leaves from is part of this question, and two requests is two
        // chances for the halves to disagree about what exists.
        db.wallet.findMany({
          // The same wallets the payment itself accepts (`checkWallet`): this store's and the unplaced ones.
          where: { companyId, isActive: true, ...(storeId ? { OR: [{ storeId }, { storeId: null }] } : {}) },
          // The minor unit travels WITH the code — see the payout route.
          select: { id: true, name: true, currencyCode: true, country: { select: { minorUnit: true } } },
          orderBy: { name: 'asc' },
        }),
      ]);
      return NextResponse.json({
        period: { start: period.start, end: period.end, paid: already },
        preview,
        commission,
        wallets,
      });
    } catch (e) {
      if (e instanceof PayrollRefused) {
        return NextResponse.json({ error: e.message, code: e.reason }, { status: 409 });
      }
      throw e;
    }
  } catch (error) {
    return apiErrorResponse(error);
  }
}

const schema = z.object({
  userId: z.string().uuid(),
  walletId: z.string().uuid(),
  exchangeRate: z.number().positive().max(1_000_000),
  /** Deductions in another currency than the salary's, and the rate the payer wrote for them. */
  convert: convertSchema.optional(),
  period: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  note: z.string().trim().max(300).optional(),
});

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('payroll.pay');

    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }
    const period = periodOf(parsed.data.period ?? null);
    // Before the transaction: a month that has not begun writes no payslip and moves no money.
    if (notBegunYet(period.start)) return NextResponse.json(FUTURE_PERIOD, { status: 400 });

    try {
      // The payslip, the deductions it settles and the money leaving the
      // wallet, all in one transaction. Any two without the third is a
      // person paid twice or a deduction taken twice.
      const result = await db.$transaction((tx) =>
        paySalary(tx, {
          companyId,
          storeId,
          userId: parsed.data.userId,
          walletId: parsed.data.walletId,
          periodStart: period.start,
          periodEnd: period.end,
          exchangeRate: parsed.data.exchangeRate,
          convert: parsed.data.convert ?? null,
          note: parsed.data.note ?? null,
          createdById: user.id,
        })
      );

      await logAudit({
        companyId,
        userId: user.id,
        action: 'SALARY_PAID',
        entity: 'Payslip',
        entityId: result.payslipId,
        newData: {
          employeeId: parsed.data.userId,
          salary: result.salary,
          penalties: result.penaltyTotal,
          net: result.net,
          carriedOver: result.carriedOver,
          currency: result.currencyCode,
          paid: result.paidAmount,
          paidCurrency: result.paidCurrency,
          rate: parsed.data.exchangeRate,
          // The «فرق تحصيل» nobody had decided, applied by this payment in the payer's name.
          appliedUndecided: result.appliedUndecided ?? 0,
          ...(parsed.data.convert ? { convertedFrom: parsed.data.convert.currencyCode, convertRate: parsed.data.convert.rate } : {}),
        },
      });

      return NextResponse.json({ result });
    } catch (e) {
      if (e instanceof PayrollRefused) {
        return NextResponse.json({ error: e.message, code: e.reason }, { status: 409 });
      }
      throw e;
    }
  } catch (error) {
    return apiErrorResponse(error);
  }
}
