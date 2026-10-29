/**
 * WHICH EXPENSES A STORE'S PROFIT SUBTRACTS — ONE DEFINITION.
 *
 * Three places read the expenses table for a figure (the profit screen, the
 * analytics profit line, the analytics vitals count). Each wrote its own
 * `where: { companyId }`, which is how every store's profit came to subtract
 * every store's expenses. They all ask this function now.
 *
 *   · an expense that carries a store counts for THAT store only;
 *   · an expense with no store (`storeId` null — recorded before the column
 *     existed) counts exactly as it always did: against every store, until the
 *     owner runs scripts/backfills/20261029-expenses-get-their-store.sql;
 *   · with no store at all (`storeId` null here — a company-wide report such as
 *     the AI daily summary) every expense of the company counts;
 *   · a CANCELLED expense (`voidedAt` set) counts nowhere, unless the caller is
 *     the list that shows it marked as cancelled (`withCancelled`).
 *
 * Money is not computed here — only which rows are in. The arithmetic stays
 * where it was.
 */
export function expensesOf(
  companyId: string,
  storeId: string | null | undefined,
  opts: { withCancelled?: boolean } = {}
) {
  return {
    companyId,
    ...(storeId ? { OR: [{ storeId }, { storeId: null }] } : {}),
    ...(opts.withCancelled ? {} : { voidedAt: null }),
  };
}
