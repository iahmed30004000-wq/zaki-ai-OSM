import { db } from './db';
import { trustOf } from './cod-vitals';
import { toMinorUnits } from './money';
import { partnerLines, type PartnerStatement, type StatementPartner } from './partner-statement-core';
import { profitToDate } from './profit-to-date';

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
        partnerId: true, party: true, note: true, reversalOfId: true, createdAt: true, createdById: true,
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

  const drawsUnits: Record<string, number> = {};
  let uncounted = 0;
  for (const m of originals) {
    if (reversed.has(m.id)) continue;
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
    })),
  };
}
