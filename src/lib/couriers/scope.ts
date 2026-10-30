/**
 * WHICH COURIERS A STORE MAY SEE AND USE.
 *
 * The owner's stores are separate businesses. Each holds its own account
 * with the courier — its own login, its own company id there, its own
 * statements coming back and its own money. So a courier belongs to ONE
 * store, and there is deliberately no "shared" option: a shared row is a
 * single login that two sets of books both draw on, which is the exact
 * thing that must not be possible.
 *
 * `storeId = null` therefore means NOT PLACED YET, not "everybody's". It is
 * unusable, and the settings screen shows it apart so it is fixed rather
 * than quietly ignored.
 *
 * One function, used by every listing and every guard. Six places built
 * their own `where` before; six copies of a rule is six chances for one of
 * them to drift, and the one that drifts here creates a parcel under
 * another store's account, with the money coming back to the wrong books.
 */

/** The `where` fragment for couriers this store may use. */
export function courierScope(companyId: string, storeId: string | null | undefined) {
  // No store in context means no courier is usable. Returning the whole
  // company here is how an unscoped call quietly gets everything, so this
  // matches nothing at all — visibly, rather than by a sentinel value.
  if (!storeId) return { companyId, id: { in: [] as string[] } };
  return { companyId, storeId };
}

/** True when this courier row may be used by this store. */
export function courierBelongsToStore(
  provider: { companyId: string; storeId?: string | null },
  companyId: string,
  storeId: string | null | undefined
): boolean {
  if (provider.companyId !== companyId) return false;
  if (!storeId) return false;
  // Not placed yet is not "allowed everywhere" — it is allowed nowhere.
  if (provider.storeId == null) return false;
  return provider.storeId === storeId;
}

/**
 * Everything that would lose its courier if this row were deleted.
 *
 * A hard delete sets `deliveryProviderId` to null on orders, batches and
 * attempts, and CASCADES the delivery-fee rows out of existence. An order
 * that no longer knows who shipped it cannot be settled, matched to a
 * statement, or explained to the customer — and it is history, so there is
 * nothing to re-enter.
 *
 * Counting orders alone is not enough: a courier can hold fee rows, batches
 * or a statement with no order against it yet.
 */
export interface CourierUsage {
  orders: number;
  batches: number;
  statements: number;
  fees: number;
  attempts: number;
}

export function isCourierInUse(usage: CourierUsage): boolean {
  return Object.values(usage).some((n) => n > 0);
}

/** Arabic for what is holding the courier in place, for the refusal message. */
export function describeUsage(usage: CourierUsage): string {
  const parts: string[] = [];
  if (usage.orders) parts.push(`${usage.orders} طلب`);
  if (usage.batches) parts.push(`${usage.batches} دفعة شحن`);
  if (usage.statements) parts.push(`${usage.statements} كشف`);
  if (usage.fees) parts.push(`${usage.fees} أجرة توصيل`);
  if (usage.attempts) parts.push(`${usage.attempts} محاولة توصيل`);
  return parts.join(' · ');
}
