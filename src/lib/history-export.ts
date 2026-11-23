import type { Prisma } from '@prisma/client';
import { db } from './db';
import { inStore } from './store-filter';
import { byRealDateDesc, realDateOf, registeredOnAnotherDay } from './real-date';
import { readTransferReversals } from './transfer-reversal';
import { TRANSFER_KIND_LABEL } from './transfer-kind';
import { DIRECTION_AR, HISTORY_ROW_CAP, TOO_MANY_ROWS, movementSheet, movementsWhere, transferSheet, transfersWhere, withdrawalSheet, drawsWhere, type HistoryFilters, type HistoryRefusal, type HistorySheet } from './history-export-core';
import { MOVEMENT_CATEGORY_AR } from './movement-category-words';

/**
 * «سحب السجل» — THE THREE LISTS, READ ONCE FOR THE SCREEN AND FOR THE FILE (22/11, F5).
 *
 * `movementListRows` and `transferListRows` ARE the bodies the two list doors had: the doors call them with their own clause and
 * their own count, and answer exactly what they answered before. The history file calls the same functions with the filters'
 * clause (lib/history-export-core) and the row cap. The withdrawals dashboard's rows are `drawListLines` below (F7),
 * which its book calls too. So a row on the screen and the same row in the file are made by one piece of code.
 */

export const MOVEMENT_LIST_INCLUDE = {
  reversalOf: { select: { id: true, note: true } },
  reversedBy: { select: { id: true, reversalReason: true, createdAt: true } },
} as const;

/** The movements list: the newest `take` by registration, shown by their real date (lib/real-date `byRealDateDesc`). */
export async function movementListRows(where: Prisma.WalletMovementWhereInput, take: number, timeZone: string) {
  const registered = await db.walletMovement.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take,
    include: MOVEMENT_LIST_INCLUDE,
  });
  const movements = [...registered].sort(byRealDateDesc);

  const actorIds = [...new Set(movements.map((m) => m.createdById))];
  const actors = actorIds.length
    ? await db.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } })
    : [];
  const nameOf = new Map(actors.map((a) => [a.id, a.name]));

  return movements.map((m) => ({
    ...m,
    amount: Number(m.amount),
    // A partner draw's worth in the store's currency: a number, like the amount beside it (a Decimal is a string on the wire).
    ...(m.valueInStoreCurrency != null ? { valueInStoreCurrency: Number(m.valueInStoreCurrency) } : {}),
    createdByName: nameOf.get(m.createdById) ?? null,
    isReversal: !!m.reversalOfId,
    wasReversed: !!m.reversedBy,
    // The real date (the registration when none was typed), and whether the registration fell on another day of the store.
    realDate: realDateOf(m).toISOString(),
    registeredOnAnotherDay: registeredOnAnotherDay(m, timeZone),
  }));
}

/** The transfers list: the newest `take` registered, shown by their real date, with what has been reversed of each. */
export async function transferListRows(companyId: string, where: Prisma.WalletTransferWhereInput, take: number, timeZone: string) {
  const registered = await db.walletTransfer.findMany({
    // The company written at the read itself as well as in the builder's clause: the table has no store column, and the bench sweep
    // (a-bench-is-not-the-business) sees this company-wide money read where it is made.
    where: { ...where, companyId },
    orderBy: { createdAt: 'desc' },
    take,
  });
  const transfers = [...registered].sort(byRealDateDesc);
  const walletIds = [...new Set(transfers.flatMap((t) => [t.fromWalletId, t.toWalletId]))];
  const wallets = walletIds.length
    ? await db.wallet.findMany({
        where: { id: { in: walletIds } },
        // The look beside the name, so a row of the history is recognised the way its chip was (lib/wallet-look).
        select: {
          id: true, name: true, currencyCode: true, store: { select: { name: true } },
          imageKey: true, iconKey: true, colorKey: true,
        },
      })
    : [];
  const walletOf = new Map(wallets.map((w) => [w.id, w]));

  /*
   * WHAT HAS BEEN REVERSED OF EACH ROW — read from the legs, not from a flag (lib/transfer-reversal).
   *
   * The reversing entry used to be heard only by the wallet it was written in; this list kept saying «ساري» over a transfer
   * whose money had been taken back. One read of the movements that carry these transfers' ids, on the index of
   * `(referenceType, referenceId)`.
   */
  const legRows = transfers.length
    ? await db.walletMovement.findMany({
        where: { companyId, referenceType: 'TRANSFER', referenceId: { in: transfers.map((t) => t.id) } },
        select: { id: true, referenceId: true, walletId: true, reversalOfId: true, reversalReason: true, createdAt: true, createdById: true },
      })
    : [];
  const reversals = readTransferReversals(legRows);
  // The reversals' writers, and each transfer's own registrar (the details panel says who registered it).
  const writerIds = [...new Set([...[...reversals.values()].flatMap((r) => (r.byId ? [r.byId] : [])), ...transfers.map((t) => t.createdById)])];
  const writers = writerIds.length
    ? await db.user.findMany({ where: { id: { in: writerIds } }, select: { id: true, name: true } })
    : [];
  const nameOf = new Map(writers.map((u) => [u.id, u.name]));

  return transfers.map((t) => {
    const reading = reversals.get(t.id);
    return {
      ...t,
      amountOut: Number(t.amountOut),
      amountIn: Number(t.amountIn),
      exchangeRate: Number(t.exchangeRate),
      // The kind as it was RECORDED, not re-read now: a wallet moved to
      // another store since must not change what this transfer was.
      kindLabel: TRANSFER_KIND_LABEL[t.kind as keyof typeof TRANSFER_KIND_LABEL] ?? t.kind,
      from: walletOf.get(t.fromWalletId) ?? null,
      to: walletOf.get(t.toWalletId) ?? null,
      createdByName: nameOf.get(t.createdById) ?? null,
      realDate: realDateOf(t).toISOString(),
      registeredOnAnotherDay: registeredOnAnotherDay(t, timeZone),
      state: reading?.state ?? 'ACTIVE',
      reversedWalletIds: reading?.reversedWalletIds ?? [],
      reversal:
        reading && reading.state !== 'ACTIVE'
          ? { reason: reading.reason, at: reading.at, byName: reading.byId ? (nameOf.get(reading.byId) ?? null) : null }
          : null,
    };
  });
}

/**
 * THE PARTNERS' WITHDRAWALS — PARTNER_DRAW wallet movements — as the «المسحوبات» dashboard and its file list them (23/11, F7).
 * The movements list's own rows (`movementListRows`: the real date, who wrote it, its reversal), plus the names a person reads
 * (partner, wallet, store) and the decimals of the wallet's currency and of the store's. Nothing is worked out: every figure is the
 * movement's own.
 */
export async function drawListLines(scope: { companyId: string; storeId: string; timeZone: string }, where: Prisma.WalletMovementWhereInput, take: number) {
  const { companyId, storeId, timeZone } = scope;
  const rows = await movementListRows(where, take, timeZone);
  const walletIds = [...new Set(rows.map((m) => m.walletId))];
  const [wallets, partners, store] = await Promise.all([
    walletIds.length
      ? db.wallet.findMany({ where: { companyId, id: { in: walletIds } }, select: { id: true, name: true, country: { select: { minorUnit: true } } } })
      : Promise.resolve([]),
    db.partner.findMany({ where: { companyId }, select: { id: true, name: true } }),
    db.store.findFirst({ where: { id: storeId, companyId }, select: { name: true, country: { select: { currencyCode: true, minorUnit: true } } } }),
  ]);
  const walletOf = new Map(wallets.map((w) => [w.id, w]));
  const partnerOf = new Map(partners.map((p) => [p.id, p.name]));
  return rows.map((m) => ({
    ...m,
    valueInStoreCurrency: typeof m.valueInStoreCurrency === 'number' ? m.valueInStoreCurrency : null,
    // F8: the rate the server filled the equivalent at (frozen at write time), or nulls when it was typed or never filled.
    equivalentRate: m.equivalentRate == null ? null : Number(m.equivalentRate),
    equivalentRateKind: (m.equivalentRateKind ?? null) as 'AUTO' | 'MANUAL' | null,
    equivalentRateSource: m.equivalentRateSource ?? null,
    equivalentRateAt: m.equivalentRateAt ? new Date(m.equivalentRateAt).toISOString() : null,
    partnerName: (m.partnerId ? partnerOf.get(m.partnerId) : undefined) ?? m.party,
    walletName: walletOf.get(m.walletId)?.name ?? '—',
    minorUnit: walletOf.get(m.walletId)?.country.minorUnit ?? 3,
    storeName: store?.name ?? '—',
    storeCurrency: store?.country.currencyCode ?? '',
    storeMinor: store?.country.minorUnit ?? 3,
  }));
}

export type DrawListLine = Awaited<ReturnType<typeof drawListLines>>[number];

// ───────────────────────────── the files ─────────────────────────────

export type HistoryAnswer = { ok: true; sheet: HistorySheet; filtersAr: string[] } | { ok: false; refusal: HistoryRefusal };

interface Scope {
  companyId: string;
  storeId: string;
  timeZone: string;
}

/** The span and the basis, said in words for the print page's header. */
function spanWords(f: HistoryFilters): string[] {
  if (!f.from || !f.to) return ['الفترة: كل السجل'];
  const basis = f.basis === 'registered' ? 'حسب تاريخ التسجيل' : 'حسب تاريخ الحركة';
  return [`الفترة: من ${f.from} إلى ${f.to} (${basis})`];
}

/** A wallet's decimals: its country's. */
const WALLET_FACE = { id: true, name: true, currencyCode: true, country: { select: { minorUnit: true } } } as const;

/**
 * THE MOVEMENTS FILE — the store's wallets (the list's own scope: `inStore`), or the one the screen has open. One row over the cap
 * is read so that «too many» is known without counting.
 */
export async function movementHistory(scope: Scope, f: HistoryFilters): Promise<HistoryAnswer> {
  const wallets = await db.wallet.findMany({
    where: { ...inStore(scope.companyId, scope.storeId), ...(f.walletId ? { id: f.walletId } : {}) },
    select: WALLET_FACE,
  });
  const faceOf = new Map(wallets.map((w) => [w.id, w]));
  const rows = await movementListRows(
    movementsWhere({ walletId: { in: wallets.map((w) => w.id) } }, f, scope.timeZone),
    HISTORY_ROW_CAP + 1,
    scope.timeZone
  );
  if (rows.length > HISTORY_ROW_CAP) return { ok: false, refusal: TOO_MANY_ROWS };

  const lines = rows.map((m) => {
    const face = faceOf.get(m.walletId);
    return { ...m, walletName: face?.name ?? '—', minorUnit: face?.country.minorUnit ?? 3 };
  });
  const filtersAr = [
    ...spanWords(f),
    ...(f.walletId ? [`المحفظة: ${faceOf.get(f.walletId)?.name ?? '—'}`] : ['المحفظة: كل محافظ المتجر']),
    ...(f.currency ? [`العملة: ${f.currency}`] : []),
    ...(f.direction ? [`الاتجاه: ${DIRECTION_AR[f.direction]}`] : []),
    ...(f.category ? [`البند: ${MOVEMENT_CATEGORY_AR[f.category]}`] : []),
  ];
  return { ok: true, sheet: movementSheet(lines, scope.timeZone), filtersAr };
}

/** THE TRANSFERS FILE — the company's transfers, as the list shows them (`{ companyId }`), with the filters added. */
export async function transferHistory(scope: Scope, f: HistoryFilters): Promise<HistoryAnswer> {
  const picked =
    f.walletId || f.currency
      ? await db.wallet.findMany({
          where: { companyId: scope.companyId, ...(f.walletId ? { id: f.walletId } : {}), ...(f.currency ? { currencyCode: f.currency } : {}) },
          select: WALLET_FACE,
        })
      : null;
  const rows = await transferListRows(
    scope.companyId,
    transfersWhere(scope.companyId, f, scope.timeZone, picked ? picked.map((w) => w.id) : null),
    HISTORY_ROW_CAP + 1,
    scope.timeZone
  );
  if (rows.length > HISTORY_ROW_CAP) return { ok: false, refusal: TOO_MANY_ROWS };

  const ids = [...new Set(rows.flatMap((t) => [t.fromWalletId, t.toWalletId]))];
  const minors = ids.length
    ? await db.wallet.findMany({ where: { id: { in: ids } }, select: { id: true, country: { select: { minorUnit: true } } } })
    : [];
  const minorOf = new Map(minors.map((w) => [w.id, w.country.minorUnit]));
  const lines = rows.map((t) => ({ ...t, fromMinor: minorOf.get(t.fromWalletId) ?? 3, toMinor: minorOf.get(t.toWalletId) ?? 3 }));
  const filtersAr = [
    ...spanWords(f),
    ...(f.walletId ? [`المحفظة: ${picked?.find((w) => w.id === f.walletId)?.name ?? '—'}`] : []),
    ...(f.currency ? [`العملة: ${f.currency}`] : []),
  ];
  return { ok: true, sheet: transferSheet(lines, scope.timeZone), filtersAr };
}

/**
 * THE WITHDRAWALS FILE — the store the person stands in, as the «المسحوبات» dashboard lists it (23/11, F7): the PARTNER_DRAW wallet
 * movements the filters pick (`drawsWhere`), through the dashboard's own `drawListLines` — one description for the screen and the
 * file. A reversed draw is listed and marked «معكوس», and left out of the totals. The old record (partner_withdrawals, before F7)
 * is not in the file: it is shown read-only on the dashboard, in a block of its own.
 */
export async function withdrawalHistory(scope: Scope, f: HistoryFilters): Promise<HistoryAnswer> {
  const { companyId, storeId } = scope;
  const lines = await drawListLines(scope, drawsWhere(companyId, [storeId], f, scope.timeZone), HISTORY_ROW_CAP + 1);
  if (lines.length > HISTORY_ROW_CAP) return { ok: false, refusal: TOO_MANY_ROWS };
  const storeName = lines[0]?.storeName ?? (await db.store.findFirst({ where: { id: storeId, companyId }, select: { name: true } }))?.name ?? '—';
  const partner = f.partnerId ? await db.partner.findFirst({ where: { id: f.partnerId, companyId }, select: { name: true } }) : null;
  const filtersAr = [
    ...spanWords(f),
    `المتجر: ${storeName}`,
    ...(f.partnerId ? [`الشريك: ${partner?.name ?? '—'}`] : []),
    ...(f.currency ? [`العملة: ${f.currency}`] : []),
  ];
  return { ok: true, sheet: withdrawalSheet(lines, scope.timeZone), filtersAr };
}
