import type { Prisma } from '@prisma/client';
import { db } from './db';
import { roundMinor } from './money';
import { MIN_CONVERT_RATE, minorUnitFor } from './currencies';
import { checkWallet, recordSpend } from './pay-from-wallet';
import { SHORTFALL_KIND, UNDECIDED_AT_PAYDAY_AR } from './shortfall';

type Tx = Prisma.TransactionClient | typeof db;

/**
 * PAYING A SALARY, AND TAKING THE DEDUCTIONS OUT OF IT.
 *
 * The deductions were recorded, decided, and then reached nothing: a row
 * saying somebody owed the business forty pounds and no moment at which
 * those forty pounds were ever taken. This is that moment, and it is the
 * only one — a deduction becomes money here or nowhere.
 *
 * Two rules hold the whole thing up:
 *
 *   A PAYMENT IS NEVER NEGATIVE. Deductions larger than the salary do not
 *   turn payday into a bill. What fits is settled, what does not stays owed
 *   and is offered against the next payslip. Somebody who was ill for three
 *   weeks gets a small wage, not an invoice.
 *
 *   THE SALARY IS A SNAPSHOT. Read from the employee later, last March
 *   would be rewritten every time somebody gets a rise — and a payslip that
 *   changes is not a record of anything.
 *
 * AND A «فرق تحصيل» THAT NOBODY DECIDED IS APPLIED HERE. A collection
 * shortfall is proposed at the approval of a statement and waits for the
 * owner or the accountant. If payday arrives first, the deduction is the
 * default: the payslip lists it as «لم يُعتمد تفسيره — سيُخصم» and paying
 * applies it in the PAYER's name (never in the name of the person it is taken
 * from). Only that kind — a late minute or an absence is still a person's
 * decision and waits for one.
 *
 * ROUNDING IS THE SALARY CURRENCY'S, NOT TWO PLACES. A dinar has three: 0.125
 * taken from a salary of 300 leaves 299.875, and rounding it to two places
 * paid 299.88: a fils that nobody can find. A currency of two places rounds
 * exactly as it always did.
 */

export type PayrollRefusal =
  | 'NO_SALARY'
  | 'ALREADY_PAID'
  | 'WALLET_NOT_FOUND'
  | 'BAD_RATE'
  | 'NOTHING_OWED'
  | 'CURRENCY_MISMATCH'
  | 'SELF_DECISION'
  | 'DEDUCTIONS_CHANGED'
  | 'RATE_TOO_SMALL';

const REFUSAL_AR: Record<PayrollRefusal, string> = {
  NO_SALARY: 'لا راتب مسجّل لهذا الموظف',
  ALREADY_PAID: 'صُرف راتب هذه الفترة من قبل',
  WALLET_NOT_FOUND: 'المحفظة غير موجودة أو موقوفة',
  BAD_RATE: 'سعر الصرف يجب أن يكون أكبر من صفر',
  NOTHING_OWED: 'لا شيء يُصرف',
  CURRENCY_MISMATCH: 'خصمٌ بعملة غير عملة الراتب — لا يُطرح منه',
  SELF_DECISION: 'فرق تحصيل عليك لم يُقرَّر بعد — لا تصرف راتبك وتطبّقه على نفسك، يصرفه غيرك',
  DEDUCTIONS_CHANGED: 'تغيّرت الخصومات أثناء الصرف (أُلغي خصم أو أُرجع) — أعد فتح الصرف وراجع الأرقام',
  RATE_TOO_SMALL: 'السعر صغير جداً — الخصم بيطلع صفر',
};

export class PayrollRefused extends Error {
  constructor(public reason: PayrollRefusal) {
    super(REFUSAL_AR[reason]);
  }
}

/** Deductions in ANOTHER currency, turned into the salary's at a rate the payer typed. */
export interface PayslipConvert {
  currencyCode: string;
  /** The salary's currency for ONE unit of `currencyCode`. */
  rate: number;
}

export interface PayslipPreview {
  salary: number;
  currencyCode: string;
  /** Deductions that fit inside the salary and will be settled. */
  penaltyTotal: number;
  /** What is handed over. Never below zero. */
  net: number;
  /** Deductions that did NOT fit and stay owed for next time. */
  carriedOver: number;
  /** The deductions being settled, oldest first. */
  penaltyIds: string[];
  /**
   * Of those, the «فرق تحصيل» nobody decided yet. They are listed on the payslip as «لم يُعتمد تفسيره — سيُخصم»
   * and paying applies them in the payer's name.
   */
  undecided: { id: string; amount: number; currencyCode: string }[];
  /** Applied deductions in another currency, which are not netted unless the payer typed a rate for that currency. */
  otherCurrency: { currencyCode: string; amount: number }[];
  /** What was converted and at what rate; null when nothing was. */
  converted: { currencyCode: string; rate: number; amount: number; inSalaryCurrency: number } | null;
}

/** The decimals of a currency's smallest unit: the table's own, two where the table does not know the code. */
const minorOf = (code: string): number => minorUnitFor(code) ?? 2;

/**
 * What this month would pay, before anybody commits to it.
 *
 * Deductions are settled OLDEST FIRST. A newer one left behind is a newer
 * one the person can still remember and still question; leaving the oldest
 * would mean the one charge nobody can reconstruct is the one that survives.
 */
export async function previewPayslip(
  tx: Tx,
  params: { companyId: string; storeId: string; userId: string; convert?: PayslipConvert | null }
): Promise<PayslipPreview> {
  const person = await tx.user.findFirst({
    where: { id: params.userId, companyId: params.companyId },
    select: { salaryAmount: true, salaryCurrency: true, commissionCurrency: true },
  });
  if (!person?.salaryAmount || Number(person.salaryAmount) <= 0) throw new PayrollRefused('NO_SALARY');

  // The salary's own currency; falling back to the one their commission is
  // counted in, which is the currency somebody already decided they think
  // in. Never the store's by default — that is how an Egyptian employee
  // ends up with a figure in Syrian pounds.
  const currencyCode = person.salaryCurrency ?? person.commissionCurrency ?? null;
  if (!currencyCode) throw new PayrollRefused('NO_SALARY');

  // The decimals of THIS currency: a dinar has three, a dollar two.
  const minor = minorOf(currencyCode);
  const salary = roundMinor(Number(person.salaryAmount), minor);

  // A typed rate that is not a rate is refused, not ignored: a conversion that silently did not happen would pay
  // a person the full wage on top of a deduction they were told was taken.
  // The rate is cut to the six decimals its column holds BEFORE it is used, so what is computed with is exactly what
  // is stored — a rate of 0.0000001 used as itself and stored as 0.000000 would explain nothing a month later.
  const typedRate = params.convert ? roundMinor(params.convert.rate, 6) : 0;
  if (params.convert && !(typedRate >= MIN_CONVERT_RATE)) throw new PayrollRefused('BAD_RATE');
  const convert =
    params.convert && params.convert.currencyCode !== currencyCode
      ? { currencyCode: params.convert.currencyCode, rate: typedRate }
      : null;

  const penalties = await tx.penalty.findMany({
    where: {
      companyId: params.companyId,
      userId: params.userId,
      payslipId: null,
      // Decided deductions, and the one kind that payday decides when nobody did.
      OR: [{ status: 'APPLIED' }, { status: 'PROPOSED', kind: SHORTFALL_KIND }],
    },
    orderBy: { occurredOn: 'asc' },
    select: { id: true, amount: true, currencyCode: true, status: true },
  });

  const counted: { id: string; own: number; inSalary: number; foreign: boolean; undecided: boolean; currencyCode: string }[] = [];
  const others = new Map<string, number>();
  for (const p of penalties) {
    const own = Number(p.amount);
    const undecided = p.status === 'PROPOSED';
    if (p.currencyCode === currencyCode) {
      counted.push({ id: p.id, own, inSalary: own, foreign: false, undecided, currencyCode: p.currencyCode });
    } else if (convert && p.currencyCode === convert.currencyCode) {
      // Each row on its own, rounded by the SALARY's decimals: a row is settled whole or waits whole, so what
      // is settled must be a figure of the salary's own unit.
      const inSalary = roundMinor(own * convert.rate, minor);
      // A deduction the rate turns into nothing would be stamped as taken and take nothing.
      if (own > 0 && inSalary <= 0) throw new PayrollRefused('RATE_TOO_SMALL');
      counted.push({ id: p.id, own, inSalary, foreign: true, undecided, currencyCode: p.currencyCode });
    } else {
      others.set(p.currencyCode, (others.get(p.currencyCode) ?? 0) + own);
    }
  }

  // Oldest first, until the salary runs out.
  let taken = 0;
  const settled: typeof counted = [];
  let carriedOver = 0;
  for (const p of counted) {
    if (taken + p.inSalary <= salary) {
      taken = roundMinor(taken + p.inSalary, minor);
      settled.push(p);
    } else {
      // Not split across two payslips: half a deduction settled is a row
      // nobody can explain. It waits whole.
      carriedOver = roundMinor(carriedOver + p.inSalary, minor);
    }
  }

  const foreignSettled = settled.filter((p) => p.foreign);

  return {
    salary,
    currencyCode,
    penaltyTotal: taken,
    net: roundMinor(salary - taken, minor),
    carriedOver,
    penaltyIds: settled.map((p) => p.id),
    undecided: settled.filter((p) => p.undecided).map((p) => ({ id: p.id, amount: p.own, currencyCode: p.currencyCode })),
    otherCurrency: [...others.entries()].map(([code, amount]) => ({ currencyCode: code, amount })),
    converted:
      convert && foreignSettled.length > 0
        ? {
            currencyCode: convert.currencyCode,
            rate: convert.rate,
            // A column of three decimals: the sum is cut to what the column holds, not to float dust.
            amount: roundMinor(foreignSettled.reduce((sum, p) => sum + p.own, 0), 3),
            inSalaryCurrency: roundMinor(foreignSettled.reduce((sum, p) => sum + p.inSalary, 0), minor),
          }
        : null,
  };
}

export interface PayInput {
  companyId: string;
  storeId: string;
  userId: string;
  walletId: string;
  periodStart: Date;
  periodEnd: Date;
  exchangeRate: number;
  /** Deductions in another currency than the salary's, and the rate the payer wrote for them. */
  convert?: PayslipConvert | null;
  note?: string | null;
  createdById: string;
}

export interface PayslipResult {
  payslipId: string;
  salary: number;
  penaltyTotal: number;
  net: number;
  carriedOver: number;
  currencyCode: string;
  paidAmount: number;
  paidCurrency: string;
  /** How many «فرق تحصيل» nobody had decided were applied by this payment. */
  appliedUndecided: number;
}

/** Written on a deduction the payment applied because nobody had decided it. */
export const APPLIED_AT_PAYDAY_NOTE = `${UNDECIDED_AT_PAYDAY_AR} — طُبّق عند صرف الراتب`;

/**
 * Pay one period's salary, net of what fits.
 *
 * All of it in one transaction: the payslip, the deductions stamped with
 * its id, and the money leaving the wallet. Any two of those without the
 * third is a person paid twice or a deduction taken twice, and both are
 * discovered a month later by the person they happened to.
 */
export async function paySalary(tx: Tx, input: PayInput): Promise<PayslipResult> {
  const preview = await previewPayslip(tx, input);

  // The payer decides the «فرق تحصيل» nobody decided. Nobody decides one taken from themselves.
  if (preview.undecided.length > 0 && input.createdById === input.userId) throw new PayrollRefused('SELF_DECISION');

  // One payslip per person per period start. The database says so too;
  // this says it in Arabic before the constraint says it in Latin.
  const existing = await tx.payslip.findFirst({
    where: { companyId: input.companyId, userId: input.userId, periodStart: input.periodStart },
    select: { id: true },
  });
  if (existing) throw new PayrollRefused('ALREADY_PAID');

  // A salary entirely eaten by deductions pays nothing — and must not
  // create a movement of zero, which would read as a payment that happened.
  if (preview.net <= 0) throw new PayrollRefused('NOTHING_OWED');

  const wallet = await checkWallet(tx, {
    companyId: input.companyId,
    walletId: input.walletId,
    amount: preview.net,
    exchangeRate: input.exchangeRate,
  });
  if (typeof wallet === 'string') throw new PayrollRefused(wallet);

  const payslip = await tx.payslip.create({
    data: {
      companyId: input.companyId,
      storeId: input.storeId,
      userId: input.userId,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      salaryAmount: preview.salary,
      currencyCode: preview.currencyCode,
      penaltyTotal: preview.penaltyTotal,
      netAmount: preview.net,
      carriedOver: preview.carriedOver,
      walletId: wallet.walletId,
      paidAmount: wallet.paidAmount,
      paidCurrency: wallet.currencyCode,
      exchangeRate: input.exchangeRate,
      // The conversion the payer typed, stored with the payslip and never recalculated.
      settledAmount: preview.converted?.amount ?? null,
      settledCurrency: preview.converted?.currencyCode ?? null,
      settledRate: preview.converted?.rate ?? null,
      note: input.note ?? null,
      createdById: input.createdById,
    },
  });

  if (preview.penaltyIds.length > 0) {
    const undecidedIds = preview.undecided.map((u) => u.id);
    const decidedIds = preview.penaltyIds.filter((id) => !undecidedIds.includes(id));

    if (undecidedIds.length > 0) {
      // Applied in the PAYER's name, in the same write that stamps the payslip on them. A row waived (or
      // moved to someone else) since the preview was drawn is no longer PROPOSED, the count falls short and the
      // payment stops before any money has left.
      const applied = await tx.penalty.updateMany({
        where: { id: { in: undecidedIds }, status: 'PROPOSED', payslipId: null },
        data: {
          status: 'APPLIED',
          decidedById: input.createdById,
          decidedAt: new Date(),
          decisionNote: APPLIED_AT_PAYDAY_NOTE,
          payslipId: payslip.id,
        },
      });
      if (applied.count !== undecidedIds.length) throw new PayrollRefused('DEDUCTIONS_CHANGED');
    }

    if (decidedIds.length > 0) {
      // Stamped, not deleted: the deduction stays in the record and now says
      // which payslip took it. Only a deduction still APPLIED and still free: one reversed since the preview
      // must not be taken, and the count says so.
      const stamped = await tx.penalty.updateMany({
        where: { id: { in: decidedIds }, status: 'APPLIED', payslipId: null },
        data: { payslipId: payslip.id },
      });
      if (stamped.count !== decidedIds.length) throw new PayrollRefused('DEDUCTIONS_CHANGED');
    }
  }

  const person = await tx.user.findFirst({ where: { id: input.userId }, select: { name: true } });

  await recordSpend(
    tx,
    {
      companyId: input.companyId,
      walletId: wallet.walletId,
      amount: preview.net,
      currencyCode: preview.currencyCode,
      exchangeRate: input.exchangeRate,
      personName: person?.name ?? 'موظف',
      // A salary is an expense of the business like any other, and belongs
      // in the same ledger the rest of the money lives in.
      category: 'EXPENSE',
      referenceType: 'PAYSLIP',
      referenceId: payslip.id,
      note:
        preview.penaltyTotal > 0
          ? `راتب — ${preview.salary} ناقص خصومات ${preview.penaltyTotal}`
          : `راتب ${preview.salary} ${preview.currencyCode}`,
      createdById: input.createdById,
    },
    wallet
  );

  return {
    payslipId: payslip.id,
    salary: preview.salary,
    penaltyTotal: preview.penaltyTotal,
    net: preview.net,
    carriedOver: preview.carriedOver,
    currencyCode: preview.currencyCode,
    paidAmount: wallet.paidAmount,
    paidCurrency: wallet.currencyCode,
    appliedUndecided: preview.undecided.length,
  };
}
