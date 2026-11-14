/**
 * WHAT HAS BEEN REVERSED OF A TRANSFER — read from its movements, never stored twice (14/11).
 *
 * A transfer is a `WalletTransfer` row and two movements (one OUT of a wallet, one IN to the other) that carry
 * `referenceType: 'TRANSFER'` and the transfer's id. A reversing entry is one more movement, linked to the leg it undoes
 * and carrying the same reference. So «is this transfer reversed» is a question about the legs, and answering it here from
 * the movements — instead of a flag on the transfer that a hand-made reversal of one leg would have to keep in step —
 * means the list can never disagree with the ledger.
 *
 * Pure: the route hands it the rows, the screen's labels live beside it. No client-side arithmetic of money.
 */

export type TransferState = 'ACTIVE' | 'PARTLY_REVERSED' | 'REVERSED';

/** The word on the row. «ساري» = standing: the transfer as it was made. */
export const TRANSFER_STATE_AR: Record<TransferState, string> = {
  ACTIVE: 'ساري',
  PARTLY_REVERSED: 'معكوس جزئياً',
  REVERSED: 'معكوس',
};

/** A movement of a transfer, original or reversing, as the list reads it. */
export interface TransferLeg {
  id: string;
  referenceId: string | null;
  walletId: string;
  /** Set on a reversing entry: the leg it undoes. Null on a leg. */
  reversalOfId: string | null;
  reversalReason: string | null;
  createdAt: Date;
  createdById: string;
}

export interface TransferReversalReading {
  state: TransferState;
  /** The latest reversing entry's reason, its time and its writer; null while nothing is reversed. */
  reason: string | null;
  at: Date | null;
  byId: string | null;
  /** The wallets whose leg is reversed — so the screen can say which half is still standing. */
  reversedWalletIds: string[];
}

/**
 * One reading per transfer that has legs. A transfer the map does not hold has no movement to speak of and is read as
 * `ACTIVE` by the caller.
 */
export function readTransferReversals(rows: TransferLeg[]): Map<string, TransferReversalReading> {
  const legsOf = new Map<string, TransferLeg[]>();
  const reversalOf = new Map<string, TransferLeg>();

  for (const row of rows) {
    if (!row.referenceId) continue;
    if (row.reversalOfId) {
      reversalOf.set(row.reversalOfId, row);
      continue;
    }
    const list = legsOf.get(row.referenceId);
    if (list) list.push(row);
    else legsOf.set(row.referenceId, [row]);
  }

  const out = new Map<string, TransferReversalReading>();
  for (const [transferId, legs] of legsOf) {
    const reversed = legs.filter((leg) => reversalOf.has(leg.id));
    const state: TransferState =
      reversed.length === 0 ? 'ACTIVE' : reversed.length === legs.length ? 'REVERSED' : 'PARTLY_REVERSED';
    const latest =
      reversed
        .map((leg) => reversalOf.get(leg.id) as TransferLeg)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;
    out.set(transferId, {
      state,
      reason: latest?.reversalReason ?? null,
      at: latest?.createdAt ?? null,
      byId: latest?.createdById ?? null,
      reversedWalletIds: reversed.map((leg) => leg.walletId),
    });
  }
  return out;
}
