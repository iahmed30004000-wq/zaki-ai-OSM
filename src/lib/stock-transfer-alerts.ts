import { db } from './db';
import { createNotification } from './notification';
import { resolveAudience } from './notification-audience';
import { reachesWarehouse } from './warehouses';
import { transferSentWords } from './stock-transfer-watch';

/**
 * «بالطريق» WHERE IT MATTERS (the warehouse plan, request W3c) — two things a transfer on the road needs beyond its own
 * screen, both READ-ONLY for stock:
 *
 *   1. THE RECEIVERS ARE TOLD it is coming. When a transfer is sent, the people who may receive it — holders of
 *      `inventory.transfer_receive` (as `can()` decides it over `computeEffectiveGrants`, through `resolveAudience`) who
 *      reach the store AND the destination warehouse (`warehouses.reachesWarehouse`, the rule the receive door asks) —
 *      get one notification. When some of them are named keepers of that warehouse (`user_warehouse_access`), only the
 *      keepers are told: the owner and a company-wide receiver are not paged for every pallet another keeper takes.
 *      The sender is never told about her own transfer.
 *
 *      THE RECEIPT IS BLIND. The notice names the source and the NUMBER OF PRODUCTS — never a unit: the receiver counts
 *      without being told what to expect (`stock-transfers.shownTo` hides the sent figures on the screen for the same
 *      reason). No quantity is even read here.
 *
 *   2. A TRANSFER THAT NEEDS SOMEBODY is counted on «بدّو إياك هلق» (`my-work` TRANSFERS_STUCK): on the road for more
 *      than a day, or received short with the difference not yet approved. «A day» is the store's day — the same
 *      wall-clock time one local day earlier in the store's country timezone, so a DST night does not move the line.
 *
 * Nothing here writes stock, a wallet, an expense or the profit. A failed notice never fails the send (it runs after the
 * answer, and `createNotification` never throws).
 */

/** The key whose holders may receive a transfer — the receive door's own. */
export const RECEIVE_KEY = 'inventory.transfer_receive';

export interface SentTransfer {
  id: string;
  storeId: string;
  /** 20/11 (W7b): the store whose goods arrive, for a transfer across stores — its receivers are told (null = INTERNAL). */
  toStoreId?: string | null;
  fromWarehouseId: string;
  toWarehouseId: string;
  sentById: string;
  lines: readonly unknown[];
}

/**
 * Tell the destination's receivers that a transfer is on its way. Returns how many were told; 0 on any failure.
 */
export async function announceTransferSent(companyId: string, t: SentTransfer): Promise<number> {
  try {
    const ends = await db.warehouse.findMany({
      where: { companyId, id: { in: [t.fromWarehouseId, t.toWarehouseId] } },
      select: { id: true, companyId: true, countryId: true, name: true },
    });
    const to = ends.find((w) => w.id === t.toWarehouseId);
    if (!to) return 0;
    const from = ends.find((w) => w.id === t.fromWarehouseId);

    const arrivesIn = t.toStoreId ?? t.storeId;
    const holders = await resolveAudience({ companyId, storeId: arrivesIn, audience: { permission: RECEIVE_KEY }, actorId: t.sentById });
    if (holders.length === 0) return 0;
    const reach = await Promise.all(holders.map((u) => reachesWarehouse(u, companyId, to)));
    const receivers = holders.filter((_, i) => reach[i]);
    if (receivers.length === 0) return 0;

    const keepers = new Set(
      (
        await db.userWarehouseAccess.findMany({
          where: { warehouseId: to.id, userId: { in: receivers.map((u) => u.id) } },
          select: { userId: true },
        })
      ).map((k) => k.userId)
    );
    const told = keepers.size > 0 ? receivers.filter((u) => keepers.has(u.id)) : receivers;

    const words = transferSentWords(from?.name, t.lines.length);
    return await createNotification({
      companyId,
      storeId: arrivesIn,
      audience: { permission: RECEIVE_KEY },
      recipients: told,
      actorId: t.sentById,
      title: words.title,
      message: words.message,
      type: 'SYSTEM_ALERT',
      link: '/inventory/transfers',
    });
  } catch (error) {
    console.error('Failed to announce a stock transfer (non-fatal):', error);
    return 0;
  }
}
