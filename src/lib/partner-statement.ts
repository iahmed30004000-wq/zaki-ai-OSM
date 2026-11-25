import { db } from './db';
import { trustOf } from './cod-vitals';
import { toMinorUnits } from './money';
import { partnerLines, type PartnerStatement, type StatementPartner } from './partner-statement-core';
import { profitToDate } from './profit-to-date';
import { drawBeforeProfit } from './draw-epoch';

/**
 * THE PARTNERS' STATEMENT FOR ONE STORE — the single source for the profit screen's «الشركاء», the wallet dialog's live hint and
 * the tests (13/11).
 *
 * «الربح لازم يتم توزيعه وفق هاي النسب — الربح الصافي انا بحكي … اذا حد تجاوز نسبة سحبة نسبة الربح بينعد مكسور عليه» (the owner).
 *
 * WHERE EACH FIGURE COMES FROM, SO NOTHING IS MADE TWICE:
 *   · the NET PROFIT is `profitToDate(...).summary.netProfit` — the function `GET /api/finance` fills the screen's «صافي الربح»
 *     from, called, not copied: whatever the owner reads under that label is the number the shares are cut from;
 *   · the SPLIT, the balance and «مكسور عليه» are `partnerLines` (`partner-statement-core.ts`), pure arithmetic in whole minor units;
 *   · the DRAWS are the store's wallet movements of category PARTNER_DRAW — the ledger, never a second table. A draw that was
 *     reversed is the original plus its reversing entry and counts as nothing; only a draw with no reversal stands.
 *
 * THERE IS NO PERIOD. The profit screen shows the net profit since the beginning and has no period filter, so the entitlement, the
 * draws and the balance are all «since the beginning» — which is what makes an over-draw carry forward by construction. The shares
 * are TODAY'S shares for all history: nothing remembers what they were.
 *
 * THE START OF THE PROFIT (25/11, A1). «Since the beginning» of the PROFIT is now the store's profit epoch — the day of its first
 * courier statement (`profitEpoch`) — read inside `profitToDate`, the same start the profit screen names; a store with no statement
 * keeps the beginning.
 *
 * THE DRAWS START THERE TOO (25/11, F13 — the owner's choice «ب»). A draw whose REAL date (the typed moment, else its registration:
 * the date the ledger shows) falls before the profit epoch is not counted against a share: not in the draws, the balance or «مكسور
 * عليه», and not in «uncounted». It is still LISTED, marked `beforeProfit` (`draw-epoch.ts`). A reversal follows its original:
 * only originals are dated, the pair is nothing either way. A store with no statement has no epoch: its statement is byte for byte
 * what it was — no field is added (`beforeProfitCount` and the row mark exist only beside `since`).
 */

/** How many draws the list carries. The sums read them all. */
const LIST_LIMIT = 200;

export async function partnerStatement(scope: {
  companyId: string;
  storeId: string;
  currency: string;
  minorUnit: number;
}): Promise<PartnerStatement> {
  const { companyId, storeId, currency, minorUnit } = scope;

  const [partnerRows, profit, movements] = await Promise.all([
    db.partner.findMany({ where: { companyId }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }),
    profitToDate({ companyId, storeId }),
    db.walletMovement.findMany({
      where: { companyId, category: 'PARTNER_DRAW', wallet: { storeId } },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, walletId: true, direction: true, amount: true, currencyCode: true, valueInStoreCurrency: true,
        partnerId: true, party: true, note: true, reversalOfId: true, createdAt: true, occurredAt: true, createdById: true,
        wallet: { select: { name: true } },
      },
    }),
  ]);

  const partners: StatementPartner[] = partnerRows.map((p) => ({
    id: p.id,
    name: p.name,
    sharePercent: Number(p.sharePercent),
    isActive: p.isActive,
  }));

  // A draw is the original OUT row; its reversal is a second row that points back at it. The pair counts as nothing.
  const reversed = new Set(movements.flatMap((m) => (m.reversalOfId ? [m.reversalOfId] : [])));
  const originals = movements.filter((m) => !m.reversalOfId && m.direction === 'OUT');

  // F13: the draws from before the profit epoch (their real date) stand against nothing. No epoch → none is.
  const epochAt = profit.since?.at ?? null;
  const before = new Set(originals.filter((m) => drawBeforeProfit(m, epochAt)).map((m) => m.id));

  const drawsUnits: Record<string, number> = {};
  let uncounted = 0;
  for (const m of originals) {
    if (reversed.has(m.id)) continue;
    if (before.has(m.id)) continue;
    if (!m.partnerId || m.valueInStoreCurrency === null || m.valueInStoreCurrency === undefined) {
      uncounted += 1;
      continue;
    }
    drawsUnits[m.partnerId] = (drawsUnits[m.partnerId] ?? 0) + toMinorUnits(Number(m.valueInStoreCurrency), minorUnit);
  }

  const netProfit = profit.summary.netProfit;
  const costed = profit.deliveredOrders.filter((o) => o.estimatedCostOfGoods > 0).length;
  const split = partnerLines({ netProfit, partners, drawsUnits, minorUnit });

  const listed = originals.slice(0, LIST_LIMIT);
  const actorIds = [...new Set(listed.map((m) => m.createdById))];
  const actors = actorIds.length ? await db.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } }) : [];
  const nameOfActor = new Map(actors.map((a) => [a.id, a.name]));
  const nameOfPartner = new Map(partners.map((p) => [p.id, p.name]));

  return {
    ...split,
    currency,
    minorUnit,
    netProfit,
    // The same start the profit screen names (A1); left out entirely when the store has no statement, so that statement is what it was.
    ...(profit.since ? { since: profit.since.at.toISOString(), sinceDay: profit.since.day } : {}),
    // F13: how many standing draws are before that start (listed, marked, counted nowhere) — only beside `since`.
    ...(profit.since ? { beforeProfitCount: originals.filter((m) => before.has(m.id) && !reversed.has(m.id)).length } : {}),
    trust: trustOf({ present: costed, population: profit.deliveredOrders.length, subject: 'كلفة البضاعة' }),
    uncounted,
    draws: listed.map((m) => ({
      id: m.id,
      walletId: m.walletId,
      walletName: m.wallet.name,
      partnerId: m.partnerId,
      partnerName: (m.partnerId ? nameOfPartner.get(m.partnerId) : undefined) ?? m.party,
      amount: Number(m.amount),
      currencyCode: m.currencyCode,
      valueInStoreCurrency: m.valueInStoreCurrency === null || m.valueInStoreCurrency === undefined ? null : Number(m.valueInStoreCurrency),
      note: m.note,
      createdAt: m.createdAt.toISOString(),
      createdByName: nameOfActor.get(m.createdById) ?? null,
      reversed: reversed.has(m.id),
      ...(before.has(m.id) ? { beforeProfit: true as const } : {}),
    })),
  };
}
