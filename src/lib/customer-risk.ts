import type { Prisma } from '@prisma/client';
import { db } from './db';
import { notSuperseded } from './superseded';

type Tx = Prisma.TransactionClient | typeof db;

/**
 * CUSTOMER RISK — return rate over the last 6 months OR the last 10 orders,
 * whichever window holds more orders. The customer is company-wide: one
 * phone, one person, one risk history, never scoped per country.
 *
 * Tiers: under 15% safe, 15–40% watch, above 40% high risk. High risk also
 * when two returns land within 60 days.
 *
 * WHAT THE TWO FLAGS ARE, EXACTLY — because this comment used to claim «the
 * API says so, the UI only renders it», and the API does not say so:
 *
 *   · `requiresPrepaymentOrApproval` is ADVICE. It reaches the confirmation
 *     assistant as context and it reaches the screens. NO door refuses a
 *     cash-on-delivery confirmation for a high-risk customer. The contract
 *     asks for that refusal; building it means deciding what counts as
 *     approval and which role may give it, which is the owner's to say.
 *   · `excludedFromAutomatedConfirmation` has nothing to exclude from: no job
 *     confirms orders. The day one is written it must read this flag, and the
 *     guard in `the-customer-invariants.test.ts` says so where it will be
 *     seen.
 *
 * A comment claiming an enforcement that does not exist is worse than
 * silence: it is the reason nobody looks.
 */

export type RiskTier = 'SAFE' | 'WATCH' | 'HIGH';

export interface CustomerRisk {
  tier: RiskTier;
  returnRate: number;
  orders: number;
  returns: number;
  windowDays: number;
  recentReturns60d: number;
  /** High risk: cash on delivery is not offered without approval. */
  requiresPrepaymentOrApproval: boolean;
  /** High risk is never auto-confirmed by a job. */
  excludedFromAutomatedConfirmation: boolean;
}

const RETURNED_STATUSES = ['RETURNED', 'RETURN_REQUESTED', 'FAILED_DELIVERY'];
const SIX_MONTHS_MS = 182 * 24 * 60 * 60 * 1000;
const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;

export function tierFor(returnRate: number, orders: number, recentReturns60d: number): RiskTier {
  if (returnRate > 0.4 && orders >= 3) return 'HIGH';
  if (recentReturns60d >= 2) return 'HIGH';
  if (returnRate >= 0.15) return 'WATCH';
  return 'SAFE';
}

/**
 * THE «SAME PERSON» CLAUSE — by phone, across every store of the company.
 *
 * `Customer` is unique on `[companyId, storeId, phone]`: the stores are
 * separate businesses and each keeps its own record of the same person. So
 * one phone is SEVERAL customer rows with several ids, and asking by id makes
 * every answer per store. A customer who returned six of ten parcels at one
 * shop arrived SAFE at the shop next door, while this file said «one phone,
 * one person, one risk history».
 *
 * The system had already ruled the identical question for the blacklist, in
 * the schema's own words: «a blocked number that can order from the shop next
 * door blocks nothing.» `activeBlock` matches `{ companyId, phone }` with no
 * store. The risk is the same fact about the same person.
 *
 * IT LIVES HERE, AND ONLY HERE, because reading the number is a privacy cost
 * and one place should pay it. The confirmation assistant's route is guarded
 * against selecting a phone at all — rightly: it sends text to a model. So it
 * asks `customerHistory` instead of resolving the person itself.
 *
 * `@@index([companyId, phone])` carries the relation filter. The id is the
 * fallback for a row that cannot be read, so a missing customer narrows the
 * question instead of throwing.
 */
async function samePerson(tx: Tx, companyId: string, customerId: string) {
  const me = await tx.customer.findFirst({
    where: { id: customerId, companyId },
    select: { phone: true },
  });
  return me?.phone ? { customer: { phone: me.phone } } : { customerId };
}

/** One person's recent orders across the company, newest first. */
export async function customerHistory(
  tx: Tx,
  companyId: string,
  customerId: string,
  opts: { exceptOrderId?: string; take?: number } = {}
) {
  const whose = await samePerson(tx, companyId, customerId);
  return tx.order.findMany({
    where: {
      companyId,
      ...whose,
      ...notSuperseded,
      ...(opts.exceptOrderId ? { id: { not: opts.exceptOrderId } } : {}),
    },
    select: {
      orderNumber: true,
      confirmationStatus: true,
      shippingStatus: true,
      createdAt: true,
      totalAmount: true,
    },
    orderBy: { createdAt: 'desc' },
    take: opts.take ?? 10,
  });
}

export async function customerRisk(tx: Tx, companyId: string, customerId: string, now = new Date()): Promise<CustomerRisk> {
  const since = new Date(now.getTime() - SIX_MONTHS_MS);
  const whose = await samePerson(tx, companyId, customerId);

  /*
   * A REPLACED ORDER IS NOT A RETURN BY THE CUSTOMER.
   *
   * When a parcel is taken back from a courier company, or its goods are
   * changed after the waybill printed, the old order ends as a return and a
   * replacement carries the sale on. Counting the old one made a customer
   * whose parcel merely changed hands look like one who had refused it —
   * and the reorder even stamps `CUSTOMER_REQUEST` on it. The sale is the
   * replacement; the old order is left out of both windows, numerator and
   * denominator. A replacement that is then refused counts, as any order.
   * (`notSuperseded` is the one definition — a won-back LOSS is not in it.)
   */
  const [sixMonths, lastTen] = await Promise.all([
    tx.order.findMany({
      where: { companyId, ...whose, ...notSuperseded, createdAt: { gte: since } },
      select: { shippingStatus: true, returnedAt: true, createdAt: true },
    }),
    tx.order.findMany({
      where: { companyId, ...whose, ...notSuperseded },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { shippingStatus: true, returnedAt: true, createdAt: true },
    }),
  ]);

  // Whichever window says more about this customer.
  const window = sixMonths.length >= lastTen.length ? sixMonths : lastTen;
  const windowDays = window === sixMonths ? 182 : 0;

  const returns = window.filter((o) => RETURNED_STATUSES.includes(o.shippingStatus)).length;
  const orders = window.length;
  const returnRate = orders > 0 ? returns / orders : 0;

  const recentReturns60d = window.filter(
    (o) => RETURNED_STATUSES.includes(o.shippingStatus) &&
      new Date(o.returnedAt ?? o.createdAt).getTime() >= now.getTime() - SIXTY_DAYS_MS
  ).length;

  const tier = tierFor(returnRate, orders, recentReturns60d);
  return {
    tier,
    returnRate: Number(returnRate.toFixed(4)),
    orders,
    returns,
    windowDays,
    recentReturns60d,
    requiresPrepaymentOrApproval: tier === 'HIGH',
    excludedFromAutomatedConfirmation: tier === 'HIGH',
  };
}
