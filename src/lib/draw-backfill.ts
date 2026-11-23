import { db } from './db';
import { fromMinorUnits, toMinorUnits } from './money';
import { readRateTable } from './exchange-rates';
import { BACKFILL_SOURCE, equivalentOf, missingRateSentence } from './exchange-rates-core';

/**
 * «عبّي السعر للقديم بسعر اليوم» (23/11, F8 — the owner's EXCEPTION to «no backfill»).
 *
 * A partner's draw written before F8 from a wallet in another currency may carry NO equivalent in the store's currency (F7 made it
 * optional), and so counts in no share. The owner may price those old draws at TODAY's effective rate (his typed rate, else the
 * automatic one), knowingly: this CHANGES the partners' figure for those rows. It is the ONE place a written movement is edited, and
 * it edits nothing but the equivalent and its rate, under these rules:
 *
 *   · only PARTNER_DRAW movements going OUT, not reversals, not reversed, of THIS store, whose equivalent is still empty;
 *   · a preview lists the rows and their total first; the write needs one confirm carrying that total, and is refused if the rows or
 *     the total changed in between (`STALE_PREVIEW`) — so what was previewed is what is written;
 *   · everything in ONE transaction, each row re-checked inside it (`valueInStoreCurrency: null` in the update's own WHERE), so a
 *     second run, or a race, never overwrites an equivalent — it finds nothing to do;
 *   · a currency with no rate (the pound before the owner types it) is skipped and named;
 *   · each filled row carries the rate, its kind, its date and the source `BACKFILL_SOURCE`, so it is told apart from a draw filled
 *     at the moment it was written, and it can be edited or cleared one by one (`editBackfilled`) — reversible per row.
 *
 * Never the amount, the wallet, the partner or anything else of the row: wallets' balances, closings and matching stay as they are.
 */

// The source written on a row this exception filled (kept in the pure core so a screen can read it without the database).
export { BACKFILL_SOURCE };

type Client = Pick<typeof db, 'walletMovement'>;

export interface BackfillRow {
  id: string;
  walletId: string;
  partnerId: string | null;
  amount: number;
  currencyCode: string;
  createdAt: string;
  value: number;
  rate: number;
  kind: 'AUTO' | 'MANUAL';
  asOf: string | null;
}
export interface BackfillPlan {
  storeCurrency: string;
  rows: BackfillRow[];
  /** Σ of `value`, in the store's currency — the figure the confirm must carry. */
  total: number;
  /** Per wallet currency with no rate: how many draws, and the sentence. Nothing of them is written. */
  skipped: { currencyCode: string; count: number; sentence: string }[];
}

/** The old draws of this store with no equivalent, priced at today's rate. Read-only. */
export async function planBackfill(
  client: Client,
  scope: { companyId: string; storeId: string; storeCode: string; storeMinor: number; now?: Date }
): Promise<BackfillPlan> {
  const { companyId, storeId, storeCode, storeMinor } = scope;
  const now = scope.now ?? new Date();
  const [candidates, table] = await Promise.all([
    client.walletMovement.findMany({
      where: {
        companyId,
        category: 'PARTNER_DRAW',
        direction: 'OUT',
        reversalOfId: null,
        reversedBy: null,
        valueInStoreCurrency: null,
        wallet: { storeId },
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true, walletId: true, partnerId: true, amount: true, currencyCode: true, createdAt: true },
    }),
    readRateTable(companyId),
  ]);
  const rows: BackfillRow[] = [];
  const skipped = new Map<string, number>();
  let units = 0;
  for (const m of candidates) {
    const amount = Number(m.amount);
    const eq = equivalentOf(amount, m.currencyCode, storeCode, storeMinor, table.auto, table.manual, now);
    if (!eq.ok || !(eq.value > 0)) {
      skipped.set(m.currencyCode, (skipped.get(m.currencyCode) ?? 0) + 1);
      continue;
    }
    units += toMinorUnits(eq.value, storeMinor);
    rows.push({
      id: m.id,
      walletId: m.walletId,
      partnerId: m.partnerId,
      amount,
      currencyCode: m.currencyCode,
      createdAt: m.createdAt.toISOString(),
      value: eq.value,
      rate: eq.rate,
      kind: eq.kind,
      asOf: eq.asOf,
    });
  }
  return {
    storeCurrency: storeCode,
    rows,
    total: fromMinorUnits(units, storeMinor),
    skipped: [...skipped.entries()].map(([currencyCode, count]) => ({ currencyCode, count, sentence: missingRateSentence([currencyCode]) })),
  };
}

export type BackfillOutcome =
  | { ok: true; written: number; total: number; ids: string[]; skipped: BackfillPlan['skipped'] }
  | { ok: false; code: 'STALE_PREVIEW' | 'NOTHING_TO_FILL'; errorAr: string };

/** Write the plan in ONE transaction, after checking it is the plan that was previewed (same rows, same total). */
export async function applyBackfill(scope: {
  companyId: string;
  storeId: string;
  storeCode: string;
  storeMinor: number;
  expectedIds: string[];
  expectedTotal: number;
  now?: Date;
}): Promise<BackfillOutcome> {
  return db.$transaction(async (tx) => {
    const plan = await planBackfill(tx, scope);
    if (plan.rows.length === 0) return { ok: false, code: 'NOTHING_TO_FILL', errorAr: 'ما في سحوبات قديمة بلا سعر بتنعبّى — يمكن انعبّت قبل.' };
    const same =
      plan.rows.length === scope.expectedIds.length &&
      plan.rows.every((r) => scope.expectedIds.includes(r.id)) &&
      toMinorUnits(plan.total, scope.storeMinor) === toMinorUnits(scope.expectedTotal, scope.storeMinor);
    if (!same) return { ok: false, code: 'STALE_PREVIEW', errorAr: 'الأرقام تغيّرت من وقت المعاينة — اعرض المعاينة من جديد وأكّد.' };

    const ids: string[] = [];
    for (const r of plan.rows) {
      // RE-CHECKED HERE: only a row whose equivalent is STILL empty is written. A second run, or a race, writes nothing.
      const done = await tx.walletMovement.updateMany({
        where: { id: r.id, companyId: scope.companyId, valueInStoreCurrency: null },
        data: {
          valueInStoreCurrency: r.value,
          equivalentRate: r.rate,
          equivalentRateKind: r.kind,
          equivalentRateSource: BACKFILL_SOURCE,
          equivalentRateAt: r.asOf ? new Date(r.asOf) : scope.now ?? new Date(),
        },
      });
      if (done.count === 1) ids.push(r.id);
    }
    if (ids.length !== plan.rows.length) throw new Error('A row changed inside the transaction');
    return { ok: true, written: ids.length, total: plan.total, ids, skipped: plan.skipped };
  });
}

export type EditOutcome =
  | { ok: true; before: number | null; after: number | null }
  | { ok: false; status: number; code: string; errorAr: string };

/**
 * One row THIS exception filled: the owner types another figure (kept as MANUAL, still marked as the exception) or clears it (back
 * to no equivalent, as before the fill). A row filled any other way is not this door's.
 */
export async function editBackfilled(scope: {
  companyId: string;
  storeId: string;
  storeMinor: number;
  movementId: string;
  value: number | null;
  now?: Date;
}): Promise<EditOutcome> {
  const m = await db.walletMovement.findFirst({
    where: { id: scope.movementId, companyId: scope.companyId, category: 'PARTNER_DRAW', wallet: { storeId: scope.storeId } },
    select: { id: true, amount: true, valueInStoreCurrency: true, equivalentRateSource: true },
  });
  if (!m) return { ok: false, status: 404, code: 'MOVEMENT_NOT_FOUND', errorAr: 'السحب غير موجود بهالمتجر.' };
  if (m.equivalentRateSource !== BACKFILL_SOURCE) {
    return { ok: false, status: 409, code: 'NOT_BACKFILLED', errorAr: 'هالسحب ما انعبّى بـ«استثناء بسعر اليوم» — ما بيتعدّل من هون.' };
  }
  const before = m.valueInStoreCurrency === null ? null : Number(m.valueInStoreCurrency);
  const value = scope.value;
  const data =
    value === null
      ? { valueInStoreCurrency: null, equivalentRate: null, equivalentRateKind: null, equivalentRateSource: null, equivalentRateAt: null }
      : {
          valueInStoreCurrency: value,
          equivalentRate: value / Number(m.amount),
          equivalentRateKind: 'MANUAL',
          equivalentRateSource: BACKFILL_SOURCE,
          equivalentRateAt: scope.now ?? new Date(),
        };
  const done = await db.walletMovement.updateMany({ where: { id: m.id, equivalentRateSource: BACKFILL_SOURCE }, data });
  if (done.count !== 1) return { ok: false, status: 409, code: 'CHANGED', errorAr: 'السحب تغيّر هلق — حدّث الصفحة.' };
  return { ok: true, before, after: value };
}
