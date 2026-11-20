/**
 * WHY GOODS LEAVE A WAREHOUSE FOR GOOD — the reasons of a stock exit, their Arabic words, and the ledger line each one
 * writes (the warehouse plan, request W6a; the document itself is `stock-exits.ts`).
 *
 * One reason per exit, from a closed list. «أخرى» needs a sentence. The ledger type of the reason is what the movement
 * line says when the exit is approved: the damaged units are `DAMAGE` (the type the refused-return losses already
 * write); the other six are new types, one per reason, all starting `EXIT_` so a reader of `inventory_movements` can tell
 * an exit from a delivery, a return or a transfer by the type alone.
 *
 * Pure: no database, no session, no money. Imported by `stock-transfers.ts` (the free stock subtracts PENDING exits) and
 * by `warehouses.ts` (a pending exit keeps a warehouse running), so neither has to load the exit door's machinery.
 */

export const EXIT_REASONS = ['DAMAGED', 'EXPIRED', 'SAMPLES', 'SUPPLIER_RETURN', 'OFF_SYSTEM_SALE', 'PARTNER_DRAW', 'OTHER'] as const;
export type ExitReason = (typeof EXIT_REASONS)[number];

export const EXIT_REASON_AR: Record<ExitReason, string> = {
  DAMAGED: 'تالف',
  EXPIRED: 'منتهي',
  SAMPLES: 'عيّنات وهدايا',
  SUPPLIER_RETURN: 'مرتجع للمورّد',
  OFF_SYSTEM_SALE: 'بيع برّا النظام',
  PARTNER_DRAW: 'سحب شريك',
  OTHER: 'أخرى',
};

/** The `inventory_movements.type` each reason writes when its exit is approved. */
export const EXIT_MOVEMENT_TYPE: Record<ExitReason, string> = {
  DAMAGED: 'DAMAGE',
  EXPIRED: 'EXIT_EXPIRED',
  SAMPLES: 'EXIT_SAMPLES',
  SUPPLIER_RETURN: 'EXIT_SUPPLIER_RETURN',
  OFF_SYSTEM_SALE: 'EXIT_OFF_SYSTEM_SALE',
  PARTNER_DRAW: 'EXIT_PARTNER_DRAW',
  OTHER: 'EXIT_OTHER',
};

export type StockExitStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

/** An exit waiting for its second hand: its units are held — out of the free stock, and the warehouse may not stop. */
export const PENDING_EXIT = 'PENDING' as const satisfies StockExitStatus;

export const EXIT_STATUS_AR: Record<StockExitStatus, string> = {
  PENDING: 'مستني اعتماد',
  APPROVED: 'طلع',
  REJECTED: 'مرفوض',
};
