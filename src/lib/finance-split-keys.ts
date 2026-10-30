/**
 * THE CASH BOX AND THE SETTLEMENT APPROVAL GOT KEYS OF THEIR OWN (perm-plan PR-9), AND THE KEY EACH DOOR ASKED BEFORE.
 *
 * Four keys. Until now their doors asked for a key that meant something wider:
 *
 *   finance.cashbox_view     ← finance.cashbox    (seeing the wallets, the movements, the transfers and the closings)
 *   finance.wallets_manage   ← finance.cashbox    (creating, renaming, stopping and deleting a wallet)
 *   finance.closing_approve  ← finance.cashbox    (approving a daily closing)
 *   settlement.approve       ← settlement.review  (approving a courier's statement — the press that moves the money)
 *
 * `finance.cashbox` itself stays — it now means only the cash ACTIONS: recording a movement, a transfer, a closing's
 * count, the opening count, and «استلمت منه». `settlement.review` stays too: it matches the lines and writes the
 * explanation of a gap. Only the approval left it.
 *
 * `from` is OR: whoever held ANY of them yesterday passed the door, so whoever held any of them holds the new key today.
 * No key here carries a scope: the old doors never evaluated one.
 *
 * The migration 20261030150000_finance_split_keys writes it into the database from the same list (a test reads the SQL and
 * this table side by side), and the in-code fallback in permissions-core applies it to a person with no stored role.
 */
export interface FinanceSplitKey {
  readonly key: string;
  readonly from: readonly string[];
}

export const FINANCE_SPLIT_KEYS_FROM: readonly FinanceSplitKey[] = [
  { key: 'finance.cashbox_view', from: ['finance.cashbox'] },
  { key: 'finance.wallets_manage', from: ['finance.cashbox'] },
  { key: 'finance.closing_approve', from: ['finance.cashbox'] },
  { key: 'settlement.approve', from: ['settlement.review'] },
];
