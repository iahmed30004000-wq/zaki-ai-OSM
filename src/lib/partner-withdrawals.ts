import { db } from './db';
import { geoReach } from './geo-context';
import { inStore } from './store-filter';
import { NO_FILTERS, drawsWhere, withdrawalsWhere, type HistoryFilters } from './history-export-core';
import { drawListLines } from './history-export';
import type { SessionUser } from '@/types/auth';
import {
  amountOrRefusal,
  currencyOrRefusal,
  drawTotals,
  isRefusal,
  knownCurrencies,
  type KnownCurrency,
  type Refusal,
  type StandingRow,
  totalsByPartner,
  withdrawalTotals,
} from './partner-withdrawals-core';

/**
 * «المسحوبات» — A DASHBOARD OVER THE PARTNERS' WITHDRAWALS, WHICH ARE WALLET MOVEMENTS (23/11, F7).
 *
 * «والحركات تكون من المحافظ، وآخر شي تكون زي داشبورد للشركاء والسحوبات… ما بدي الحركات المالية بكل مكان، خلص مكان واحد» (the owner).
 *
 * A WITHDRAWAL IS ONE THING: an OUT wallet movement of category PARTNER_DRAW, written by `POST /api/finance/partners/draws` through
 * `recordMovement` — the wallet's own rules, keys and reversal. This file READS those movements (the same clause the partners'
 * statement uses) and writes nothing but the standing amounts, which are a SHORTCUT: the figure a partner usually takes per currency,
 * and what it is worth in the store's currency, typed once — they fill the boxes, the person may change them, and nothing adds them.
 *
 * THE OLD RECORD. From 22/11 to 23/11 the tab wrote its own rows (`partner_withdrawals`) that moved no wallet. They are shown, read-only,
 * in a block of their own («قديمة — غير مربوطة بمحفظة»), and counted in NO total. Nothing writes that table any more: its doors are
 * retired with a sentence pointing at the wallet (`WITHDRAWALS_MOVED`). No row of it is changed or deleted.
 */

/** How many rows each list carries. The totals read them all. */
const LIST_LIMIT = 200;

export type Answer<T> = { ok: true; value: T } | { ok: false; refusal: Refusal };
const no = (status: number, code: string, errorAr: string): { ok: false; refusal: Refusal } => ({
  ok: false,
  refusal: { status, code, errorAr },
});

/** The answer of the two retired doors (POST, PATCH of /api/finance/partners/withdrawals): nothing is written, and where to go. */
export const WITHDRAWALS_MOVED: Refusal = {
  status: 410,
  code: 'WITHDRAWALS_MOVED_TO_WALLET',
  errorAr: 'المسحوب صار حركة محفظة: سجّله من «سجّل مسحوب» هون أو من المحفظة («حركة جديدة» ← «سحب شريك»)، وإلغاؤه بقيد عكسي من المحفظة.',
};

/** The currencies the company's stores use: its countries' and its wallets'. */
export async function companyCurrencies(companyId: string): Promise<KnownCurrency[]> {
  const [countries, wallets] = await Promise.all([
    db.country.findMany({ where: { companyId }, select: { currencyCode: true, minorUnit: true } }),
    db.wallet.findMany({
      where: { companyId },
      distinct: ['currencyCode'],
      select: { currencyCode: true, country: { select: { minorUnit: true } } },
    }),
  ]);
  return knownCurrencies(
    countries,
    wallets.map((w) => ({ currencyCode: w.currencyCode, minorUnit: w.country.minorUnit }))
  );
}

const minorOfList = (known: readonly KnownCurrency[]) => (code: string) => known.find((c) => c.code === code)?.minorUnit ?? 3;

/** The stores of the company this person reaches — the same rule as the pickers — with each one's currency. */
async function reachedStores(user: SessionUser, companyId: string) {
  const reach = await geoReach(user, companyId);
  return db.store.findMany({
    where: {
      companyId,
      ...(reach ? { countryId: { in: reach.countryIds }, ...(reach.storeIds ? { id: { in: reach.storeIds } } : {}) } : {}),
    },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, country: { select: { currencyCode: true, minorUnit: true } } },
  });
}

/** The standing amounts of the company, as the boxes read them. */
export async function standingFor(companyId: string): Promise<StandingRow[]> {
  const rows = await db.partnerStandingAmount.findMany({
    where: { companyId },
    select: { partnerId: true, currencyCode: true, amount: true, storeValue: true, storeCurrencyCode: true },
  });
  return rows.map((s) => ({
    partnerId: s.partnerId,
    currencyCode: s.currencyCode,
    amount: Number(s.amount),
    storeValue: s.storeValue === null || s.storeValue === undefined ? null : Number(s.storeValue),
    storeCurrencyCode: s.storeCurrencyCode ?? null,
  }));
}

/**
 * EVERYTHING THE «المسحوبات» DASHBOARD DRAWS, for the store the person stands in, and the totals of every store he reaches.
 * `filters` = the span on the real date (lib/real-date), as the dashboard's date box asks; `NO_FILTERS` = since the beginning, which
 * is what the partners' statement counts.
 */
export async function withdrawalsBook(scope: {
  user: SessionUser;
  companyId: string;
  storeId: string;
  country: { currencyCode: string; minorUnit: number; timezone?: string | null };
  filters: HistoryFilters;
}) {
  const { user, companyId, storeId, country, filters } = scope;
  const timeZone = country.timezone ?? 'Asia/Damascus';
  const [partners, currencies, standing, stores, wallets] = await Promise.all([
    db.partner.findMany({
      where: { companyId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, name: true, isActive: true },
    }),
    companyCurrencies(companyId),
    standingFor(companyId),
    reachedStores(user, companyId),
    // The wallets the one press may take the cash out of: this store's, switched on — the draws door's own rule (`inStore`).
    db.wallet.findMany({
      where: { ...inStore(companyId, storeId), isActive: true },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, currencyCode: true, country: { select: { minorUnit: true } } },
    }),
  ]);
  const storeIds = [...new Set([storeId, ...stores.map((s) => s.id)])];
  const minorOf = minorOfList(currencies);
  const storeOf = new Map(stores.map((s) => [s.id, s]));
  const storeMinorOf = (id: string) => (id === storeId ? country.minorUnit : storeOf.get(id)?.country.minorUnit ?? 3);

  // THE TOTALS: every draw of the span, of every store he reaches — a reversed one is read with its reversal and left out.
  const ledger = await db.walletMovement.findMany({
    where: drawsWhere(companyId, storeIds, filters, timeZone),
    orderBy: { createdAt: 'desc' },
    select: {
      walletId: true, partnerId: true, amount: true, currencyCode: true, valueInStoreCurrency: true,
      reversedBy: { select: { id: true } }, wallet: { select: { storeId: true } },
    },
  });
  const byStore = drawTotals(
    ledger.flatMap((m) =>
      m.partnerId && m.wallet.storeId
        ? [{
            storeId: m.wallet.storeId,
            partnerId: m.partnerId,
            currencyCode: m.currencyCode,
            amount: Number(m.amount),
            valueInStoreCurrency: m.valueInStoreCurrency === null ? null : Number(m.valueInStoreCurrency),
            reversed: !!m.reversedBy,
          }]
        : []
    ),
    minorOf,
    storeMinorOf
  );

  // The wallet the one press offers first for a (partner, currency): the one his newest draw here came out of.
  const lastWallet: Record<string, string> = {};
  for (const m of ledger) {
    if (m.wallet.storeId !== storeId || !m.partnerId) continue;
    const key = `${m.partnerId}|${m.currencyCode}`;
    if (!lastWallet[key]) lastWallet[key] = m.walletId;
  }

  const partnerName = new Map(partners.map((p) => [p.id, p.name]));
  const storeName = new Map(stores.map((s) => [s.id, s.name]));

  // THE OLD RECORD of this store (22/11–23/11): read-only, counted nowhere.
  const legacy = await db.partnerWithdrawal.findMany({
    where: withdrawalsWhere(companyId, [storeId], NO_FILTERS, ''),
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, storeId: true, partnerId: true, currencyCode: true, amount: true, withdrawnOn: true, fromStanding: true,
      note: true, reversalOfId: true, reversalReason: true, createdById: true, createdAt: true,
    },
  });

  return {
    storeId,
    storeCurrency: { code: country.currencyCode, minorUnit: country.minorUnit },
    partners,
    currencies,
    standing,
    wallets: wallets.map((w) => ({ id: w.id, name: w.name, currencyCode: w.currencyCode, minorUnit: w.country.minorUnit })),
    lastWallet,
    rows: await drawListLines({ companyId, storeId, timeZone }, drawsWhere(companyId, [storeId], filters, timeZone), LIST_LIMIT),
    // This store, per partner and wallet currency, with what it is worth in the store's currency.
    totals: byStore
      .filter((t) => t.storeId === storeId)
      .map((t) => ({ ...t, partnerName: partnerName.get(t.partnerId) ?? '—', minorUnit: minorOf(t.currencyCode) })),
    // Every store he reaches, per store, partner and wallet currency.
    byStore: byStore.map((t) => ({
      ...t,
      storeName: storeName.get(t.storeId) ?? '—',
      partnerName: partnerName.get(t.partnerId) ?? '—',
      minorUnit: minorOf(t.currencyCode),
      storeCurrency: t.storeId === storeId ? country.currencyCode : storeOf.get(t.storeId)?.country.currencyCode ?? '',
      storeMinor: storeMinorOf(t.storeId),
    })),
    // The old record's own sums, per partner and currency (a cancelled row is nothing) — shown in its block, added to no other total.
    legacyTotals: totalsByPartner(
      withdrawalTotals(legacy.map((r) => ({ ...r, amount: Number(r.amount) })), minorOf),
      minorOf
    ).map((t) => ({ ...t, partnerName: partnerName.get(t.partnerId) ?? '—', minorUnit: minorOf(t.currencyCode) })),
    legacy: await describeWithdrawals(
      legacy.map((r) => ({ ...r, amount: Number(r.amount) })),
      partnerName,
      minorOf,
      LIST_LIMIT
    ),
  };
}

export type WithdrawalsBook = Awaited<ReturnType<typeof withdrawalsBook>>;

/** One row of the OLD record as `describeWithdrawals` reads it. */
interface LedgerRow {
  id: string;
  partnerId: string;
  currencyCode: string;
  amount: number;
  withdrawnOn: Date;
  fromStanding: boolean;
  note: string | null;
  reversalOfId: string | null;
  reversalReason: string | null;
  createdById: string;
  createdAt: Date;
}

/**
 * THE OLD RECORD'S ROWS (partner_withdrawals, 22/11–23/11), out of one store's rows (originals and cancels, newest registration
 * first): the newest `limit` originals, each with its cancel beside it. Read-only since F7; shown on the dashboard in its own block.
 */
export async function describeWithdrawals(
  here: readonly LedgerRow[],
  partnerName: Map<string, string>,
  minorOf: (code: string) => number,
  limit: number
) {
  const reversalOf = new Map(here.flatMap((r) => (r.reversalOfId ? [[r.reversalOfId, r] as const] : [])));
  const originals = here.filter((r) => !r.reversalOfId).slice(0, limit);
  const actorIds = [...new Set([...originals.map((r) => r.createdById), ...[...reversalOf.values()].map((r) => r.createdById)])];
  const actors = actorIds.length ? await db.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } }) : [];
  const nameOf = new Map(actors.map((a) => [a.id, a.name]));
  return originals.map((r) => {
    const cancel = reversalOf.get(r.id);
    return {
      id: r.id,
      partnerId: r.partnerId,
      partnerName: partnerName.get(r.partnerId) ?? '—',
      currencyCode: r.currencyCode,
      minorUnit: minorOf(r.currencyCode),
      amount: r.amount,
      withdrawnOn: r.withdrawnOn.toISOString().slice(0, 10),
      fromStanding: r.fromStanding,
      note: r.note,
      createdAt: r.createdAt.toISOString(),
      createdByName: nameOf.get(r.createdById) ?? null,
      cancelled: cancel ? { reason: cancel.reversalReason ?? '', at: cancel.createdAt.toISOString(), byName: nameOf.get(cancel.createdById) ?? null } : null,
    };
  });
}

async function partnerOf(companyId: string, partnerId: unknown) {
  if (typeof partnerId !== 'string' || !partnerId) return no(400, 'PARTNER_REQUIRED', 'اختار الشريك.');
  const partner = await db.partner.findFirst({ where: { id: partnerId, companyId }, select: { id: true, name: true, isActive: true } });
  if (!partner) return no(404, 'PARTNER_NOT_FOUND', 'الشريك غير موجود.');
  return { ok: true as const, value: partner };
}

/**
 * THE STANDING AMOUNTS OF ONE PARTNER, SAVED AS A WHOLE: one figure per currency; an empty box clears that currency. Each currency
 * at most once, each one the stores', each figure > 0 in its decimals.
 *
 * «ما يعادله بعملة المتجر» (23/11, F7): beside a currency that is NOT the store's, what the figure is worth in the STORE's currency
 * (the store the person stands in), checked like any amount of that currency. It is kept with that store currency's code, and fills
 * the box only where the store's currency is the same. For the store's own currency there is nothing to say, so nothing is kept.
 */
export async function saveStanding(input: {
  user: SessionUser;
  companyId: string;
  storeCurrency: string;
  body: { partnerId?: unknown; amounts?: unknown };
}): Promise<Answer<{ partnerId: string; amounts: { currencyCode: string; amount: number; storeValue: number | null }[] }>> {
  const { user, companyId, body } = input;
  const partner = await partnerOf(companyId, body.partnerId);
  if (!partner.ok) return partner;
  if (!Array.isArray(body.amounts) || body.amounts.length > 50) return no(400, 'INVALID_AMOUNTS', 'قائمة المبالغ مش مفهومة.');

  const known = await companyCurrencies(companyId);
  const storeCurrency = known.find((c) => c.code === input.storeCurrency.trim().toUpperCase()) ?? null;
  const keep: { currencyCode: string; amount: number; storeValue: number | null }[] = [];
  const clear: string[] = [];
  const seen = new Set<string>();
  for (const raw of body.amounts as { currencyCode?: unknown; amount?: unknown; storeValue?: unknown }[]) {
    const currency = currencyOrRefusal(raw?.currencyCode, known);
    if (isRefusal(currency)) return { ok: false, refusal: currency };
    if (seen.has(currency.code)) return no(400, 'CURRENCY_TWICE', `العملة ${currency.code} مكتوبة مرتين.`);
    seen.add(currency.code);
    if (raw.amount === undefined || raw.amount === null || raw.amount === '') {
      clear.push(currency.code);
      continue;
    }
    const amount = amountOrRefusal(raw.amount, currency);
    if (isRefusal(amount)) return { ok: false, refusal: amount };
    let storeValue: number | null = null;
    const typed = raw.storeValue;
    if (storeCurrency && storeCurrency.code !== currency.code && !(typed === undefined || typed === null || typed === '')) {
      const value = amountOrRefusal(typed, storeCurrency);
      if (isRefusal(value)) {
        return no(value.status, value.code.replace('AMOUNT', 'STORE_VALUE'), `«ما يعادله بعملة المتجر (${storeCurrency.code})» لـ${currency.code}: ${value.errorAr}`);
      }
      storeValue = value;
    }
    keep.push({ currencyCode: currency.code, amount, storeValue });
  }

  await db.$transaction(async (tx) => {
    if (clear.length) {
      await tx.partnerStandingAmount.deleteMany({ where: { companyId, partnerId: partner.value.id, currencyCode: { in: clear } } });
    }
    for (const k of keep) {
      const where = { partnerId_currencyCode: { partnerId: partner.value.id, currencyCode: k.currencyCode } };
      const value = { storeValue: k.storeValue, storeCurrencyCode: k.storeValue === null ? null : storeCurrency?.code ?? null };
      // An empty «ما يعادله» clears only THIS store currency's equivalent: one typed in a store of another currency is not this box's.
      const before = k.storeValue === null ? await tx.partnerStandingAmount.findUnique({ where, select: { storeCurrencyCode: true } }) : null;
      const keepOther = !!before?.storeCurrencyCode && before.storeCurrencyCode !== storeCurrency?.code;
      await tx.partnerStandingAmount.upsert({
        where,
        create: { companyId, partnerId: partner.value.id, currencyCode: k.currencyCode, amount: k.amount, ...value, updatedById: user.id },
        update: { amount: k.amount, ...(keepOther ? {} : value), updatedById: user.id },
      });
    }
  });
  return { ok: true, value: { partnerId: partner.value.id, amounts: keep } };
}
