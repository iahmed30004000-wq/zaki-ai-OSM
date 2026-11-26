import type { Prisma } from '@prisma/client';
import type { db as Db } from './db';
import { LOST_STATUSES, NEVER_WINBACK_REASONS } from './winback';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * A CUSTOMER WHO SAID NO TWICE IS NOT RUNG AGAIN — UNLESS HE CAME BACK BY HIMSELF AND TOOK A PARCEL.
 *
 * The rule of the owner's amendment, asked of the CUSTOMER and not of one order (the verdict in `winback.ts` already refuses an order
 * that was itself a second chance; this is wider — two separate orders cancelled):
 *
 *   · one cancellation — the customer may be offered again;
 *   · two or more — he is out, for good;
 *   · unless, AFTER the last of them, he placed an order himself and it was DELIVERED: then he is in again.
 *
 * WHAT COUNTS AS «HE CANCELLED». An order closed as REJECTED or CANCELLED (`LOST_STATUSES`) with a reason that is the customer's. Not
 * counted: the four reasons that are a fact about the ORDER, not an answer of the customer's (`NEVER_WINBACK_REASONS` — a duplicate, a
 * wrong number, a fake/test order, an entry error), and an order closed with no reason recorded at all. A parcel that shipped and came
 * back is not a cancellation here (it is never closed as one).
 *
 * WHAT COUNTS AS «PLACED HIMSELF». An order that is not a second chance of another (`replacesOrderId` empty): a delivered win-back
 * order was our call, not his. Delivered = DELIVERED or PARTIALLY_DELIVERED (he took goods). «After» = the order was MADE after the
 * moment of the last cancellation.
 *
 * The moment of a cancellation is its LAST loss row in the status log — the same date the list cools from — or, when the log holds none,
 * the order's own creation.
 *
 * Read in ONE query for any number of customers (`customerWinbackVerdicts`), so the bulk run asks it once for a page of candidates.
 * ═══════════════════════════════════════════════════════════════════════
 */

export const DELIVERED_STATUSES: readonly string[] = ['DELIVERED', 'PARTIALLY_DELIVERED'];

/** The cancellation reasons that are NOT «the customer cancelled». A null reason is not counted either. */
export const NOT_THE_CUSTOMERS_NO: readonly string[] = [...NEVER_WINBACK_REASONS];

export interface CustomerOrderFact {
  confirmationStatus: string;
  rejectionReason: string | null;
  shippingStatus: string;
  replacesOrderId: string | null;
  createdAt: Date;
  /** The last loss row's date, if any. */
  lostAt: Date | null;
}

export type CustomerVerdict = { eligible: true } | { eligible: false; code: 'CUSTOMER_CANCELLED_TWICE'; reason: string };

export const CANCELLED_TWICE_AR = 'الزبون لغى مرتين أو أكتر وما استلم طلب طلبه بنفسه بعدها';

export const countsAsHisNo = (o: Pick<CustomerOrderFact, 'confirmationStatus' | 'rejectionReason'>): boolean =>
  LOST_STATUSES.includes(o.confirmationStatus) && !!o.rejectionReason && !NOT_THE_CUSTOMERS_NO.includes(o.rejectionReason);

export function customerVerdict(facts: readonly CustomerOrderFact[]): CustomerVerdict {
  const nos = facts.filter(countsAsHisNo);
  if (nos.length < 2) return { eligible: true };
  const last = Math.max(...nos.map((o) => (o.lostAt ?? o.createdAt).getTime()));
  const cameBack = facts.some((o) => DELIVERED_STATUSES.includes(o.shippingStatus) && !o.replacesOrderId && o.createdAt.getTime() > last);
  return cameBack ? { eligible: true } : { eligible: false, code: 'CUSTOMER_CANCELLED_TWICE', reason: CANCELLED_TWICE_AR };
}

type Client = Pick<typeof Db, 'order'> | Pick<Prisma.TransactionClient, 'order'>;

/** The verdict of each of these customers, in this company (and store, when one is named). One query; a customer with nothing is eligible. */
export async function customerWinbackVerdicts(
  client: Client,
  scope: { companyId: string; storeId?: string | null },
  customerIds: readonly string[]
): Promise<Map<string, CustomerVerdict>> {
  const ids = [...new Set(customerIds.filter(Boolean))];
  const out = new Map<string, CustomerVerdict>();
  if (ids.length === 0) return out;
  const rows = (await (client.order as typeof Db.order).findMany({
    where: {
      companyId: scope.companyId,
      ...(scope.storeId ? { storeId: scope.storeId } : {}),
      customerId: { in: ids },
      OR: [{ confirmationStatus: { in: [...LOST_STATUSES] } }, { shippingStatus: { in: [...DELIVERED_STATUSES] } }],
    },
    select: {
      customerId: true,
      confirmationStatus: true,
      rejectionReason: true,
      shippingStatus: true,
      replacesOrderId: true,
      createdAt: true,
      statusLogs: {
        where: { statusType: 'CONFIRMATION', newValue: { in: [...LOST_STATUSES] } },
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { createdAt: true },
      },
    },
  })) as Array<Omit<CustomerOrderFact, 'lostAt'> & { customerId: string; statusLogs?: { createdAt: Date }[] }>;
  const byCustomer = new Map<string, CustomerOrderFact[]>();
  for (const r of rows ?? []) {
    const fact: CustomerOrderFact = {
      confirmationStatus: r.confirmationStatus,
      rejectionReason: r.rejectionReason,
      shippingStatus: r.shippingStatus,
      replacesOrderId: r.replacesOrderId,
      createdAt: new Date(r.createdAt),
      lostAt: r.statusLogs?.[0]?.createdAt ? new Date(r.statusLogs[0].createdAt) : null,
    };
    byCustomer.set(r.customerId, [...(byCustomer.get(r.customerId) ?? []), fact]);
  }
  for (const id of ids) out.set(id, customerVerdict(byCustomer.get(id) ?? []));
  return out;
}
