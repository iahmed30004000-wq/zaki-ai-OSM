import { Prisma } from '@prisma/client';
import { db } from './db';
import { geoReach } from './geo-context';
import { localDayKey } from './local-day';
import type { SessionUser } from '@/types/auth';
import {
  amountOrRefusal,
  currencyOrRefusal,
  dayOrRefusal,
  isRefusal,
  knownCurrencies,
  totalsByPartner,
  withdrawalTotals,
  type KnownCurrency,
  type Refusal,
} from './partner-withdrawals-core';

/**
 * «المسحوبات» — THE RECORD OF WHAT EACH PARTNER TOOK, PER STORE AND CURRENCY (22/11).
 *
 * «الأرباح: حط شاشة مسحوبات وحط العملات» (the owner). He used to type each partner's figure in dollars per store every time; the
 * figure a partner usually takes is now typed ONCE per currency (`PartnerStandingAmount`) and one press records it.
 *
 * RECORD ONLY. Nothing here moves a wallet, writes an expense, or is read by the profit or the partners' statement: those read the
 * PARTNER_DRAW wallet movements of the wallet dialog (`partner-statement.ts`) and their figures are byte for byte what they were.
 * Linking a withdrawal to the cash that left (a wallet movement, behind its approval path) is a follow-up, not this file.
 *
 * NEVER EDITED, NEVER DELETED. A cancel is a second row pointing at the original, with the written reason; the database holds
 * «once» (`reversalOfId` UNIQUE) and the original's row is locked while it is checked.
 */

/** A twin inside this window — same person, partner, store, currency, amount and day, not cancelled — is the same press twice. */
const DUPLICATE_WINDOW_MS = 30_000;
/** How many rows the list carries. The totals read them all. */
const LIST_LIMIT = 200;

export type Answer<T> = { ok: true; value: T } | { ok: false; refusal: Refusal };
const no = (status: number, code: string, errorAr: string): { ok: false; refusal: Refusal } => ({
  ok: false,
  refusal: { status, code, errorAr },
});

/** A refusal found inside a transaction: it unwinds the lock and carries what the door answers. */
class Refused extends Error {
  constructor(public readonly refusal: Refusal) {
    super(refusal.errorAr);
    this.name = 'Refused';
  }
}

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

/** The stores of the company this person reaches — the same rule as the pickers. */
async function reachedStores(user: SessionUser, companyId: string) {
  const reach = await geoReach(user, companyId);
  return db.store.findMany({
    where: {
      companyId,
      ...(reach ? { countryId: { in: reach.countryIds }, ...(reach.storeIds ? { id: { in: reach.storeIds } } : {}) } : {}),
    },
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
  });
}

/** Everything the «المسحوبات» tab draws, for the store the person stands in, and the totals of every store he reaches. */
export async function withdrawalsBook(scope: { user: SessionUser; companyId: string; storeId: string }) {
  const { user, companyId, storeId } = scope;
  const [partners, currencies, standing, stores] = await Promise.all([
    db.partner.findMany({
      where: { companyId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, name: true, isActive: true },
    }),
    companyCurrencies(companyId),
    db.partnerStandingAmount.findMany({ where: { companyId }, select: { partnerId: true, currencyCode: true, amount: true } }),
    reachedStores(user, companyId),
  ]);
  const storeIds = [...new Set([storeId, ...stores.map((s) => s.id)])];
  const all = await db.partnerWithdrawal.findMany({
    where: { companyId, storeId: { in: storeIds } },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, storeId: true, partnerId: true, currencyCode: true, amount: true, withdrawnOn: true, fromStanding: true,
      note: true, reversalOfId: true, reversalReason: true, createdById: true, createdAt: true,
    },
  });
  const minorOf = minorOfList(currencies);
  const ledger = all.map((r) => ({ ...r, amount: Number(r.amount) }));
  const byStore = withdrawalTotals(ledger, minorOf);

  const here = ledger.filter((r) => r.storeId === storeId);
  const reversalOf = new Map(here.flatMap((r) => (r.reversalOfId ? [[r.reversalOfId, r] as const] : [])));
  const originals = here.filter((r) => !r.reversalOfId).slice(0, LIST_LIMIT);
  const actorIds = [...new Set([...originals.map((r) => r.createdById), ...[...reversalOf.values()].map((r) => r.createdById)])];
  const actors = actorIds.length ? await db.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } }) : [];
  const nameOf = new Map(actors.map((a) => [a.id, a.name]));
  const partnerName = new Map(partners.map((p) => [p.id, p.name]));
  const storeName = new Map(stores.map((s) => [s.id, s.name]));

  return {
    storeId,
    partners,
    currencies,
    standing: standing.map((s) => ({ partnerId: s.partnerId, currencyCode: s.currencyCode, amount: Number(s.amount) })),
    rows: originals.map((r) => {
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
    }),
    // This store, per partner and currency.
    totals: totalsByPartner(byStore.filter((t) => t.storeId === storeId), minorOf).map((t) => ({
      ...t,
      partnerName: partnerName.get(t.partnerId) ?? '—',
      minorUnit: minorOf(t.currencyCode),
    })),
    // Every store he reaches, per store, partner and currency.
    byStore: byStore.map((t) => ({
      ...t,
      storeName: storeName.get(t.storeId) ?? '—',
      partnerName: partnerName.get(t.partnerId) ?? '—',
      minorUnit: minorOf(t.currencyCode),
    })),
  };
}

export type WithdrawalsBook = Awaited<ReturnType<typeof withdrawalsBook>>;

async function activePartner(companyId: string, partnerId: unknown, mustBeActive: boolean) {
  if (typeof partnerId !== 'string' || !partnerId) return no(400, 'PARTNER_REQUIRED', 'اختار الشريك.');
  const partner = await db.partner.findFirst({ where: { id: partnerId, companyId }, select: { id: true, name: true, isActive: true } });
  if (!partner) return no(404, 'PARTNER_NOT_FOUND', 'الشريك غير موجود.');
  if (mustBeActive && !partner.isActive) return no(409, 'PARTNER_STOPPED', 'الشريك موقوف — ما بينسجّل عليه مسحوب جديد.');
  return { ok: true as const, value: partner };
}

/**
 * «سجّل مسحوب» — one row. The amount is the one sent (the box the press filled from the standing amount, perhaps changed for this
 * press); with no amount, the partner's standing amount for that currency, and without one either, a refusal.
 */
export async function recordWithdrawal(input: {
  user: SessionUser;
  companyId: string;
  storeId: string;
  body: { partnerId?: unknown; currencyCode?: unknown; amount?: unknown; withdrawnOn?: unknown; note?: unknown };
  now?: Date;
}): Promise<Answer<{ id: string; partnerName: string; currencyCode: string; amount: number; withdrawnOn: string; fromStanding: boolean }>> {
  const { user, companyId, storeId, body } = input;
  const now = input.now ?? new Date();

  const partner = await activePartner(companyId, body.partnerId, true);
  if (!partner.ok) return partner;
  const currency = currencyOrRefusal(body.currencyCode, await companyCurrencies(companyId));
  if (isRefusal(currency)) return { ok: false, refusal: currency };

  const standing = await db.partnerStandingAmount.findUnique({
    where: { partnerId_currencyCode: { partnerId: partner.value.id, currencyCode: currency.code } },
    select: { amount: true },
  });
  const standingAmount = standing ? Number(standing.amount) : null;
  const absent = body.amount === undefined || body.amount === null || body.amount === '';
  if (absent && standingAmount === null) {
    return no(400, 'AMOUNT_REQUIRED', `اكتب المبلغ — ما في مبلغ ثابت محفوظ لـ${partner.value.name} بعملة ${currency.code}.`);
  }
  const amount = amountOrRefusal(absent ? standingAmount : body.amount, currency);
  if (isRefusal(amount)) return { ok: false, refusal: amount };

  const latest = localDayKey(new Date(now.getTime() + 24 * 60 * 60 * 1000));
  const day = dayOrRefusal(body.withdrawnOn ?? localDayKey(now), latest);
  if (isRefusal(day)) return { ok: false, refusal: day };

  const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 300) : null;
  const fromStanding = standingAmount !== null && standingAmount === amount;

  try {
    const row = await db.$transaction(async (tx) => {
      // The partner's row is held until the transaction ends: a second press at the same instant waits here, then sees the first.
      await tx.$queryRaw`SELECT "id" FROM "partners" WHERE "id" = ${partner.value.id} FOR UPDATE`;
      const twin = await tx.partnerWithdrawal.findFirst({
        where: {
          companyId,
          storeId,
          partnerId: partner.value.id,
          currencyCode: currency.code,
          amount,
          withdrawnOn: new Date(`${day}T00:00:00Z`),
          createdById: user.id,
          reversalOfId: null,
          reversedBy: null,
          createdAt: { gte: new Date(now.getTime() - DUPLICATE_WINDOW_MS) },
        },
        select: { id: true },
      });
      if (twin) {
        throw new Refused({
          status: 409,
          code: 'DUPLICATE_WITHDRAWAL',
          errorAr: 'سجّلت نفس المسحوب (نفس الشريك والعملة والمبلغ واليوم) قبل لحظات — ما انسجّل مرتين. إذا بدك واحد تاني بنفس الرقم، استنّى نص دقيقة.',
        });
      }
      return tx.partnerWithdrawal.create({
        data: {
          companyId,
          storeId,
          partnerId: partner.value.id,
          currencyCode: currency.code,
          amount,
          withdrawnOn: new Date(`${day}T00:00:00Z`),
          fromStanding,
          note,
          createdById: user.id,
        },
        select: { id: true },
      });
    });
    return {
      ok: true,
      value: { id: row.id, partnerName: partner.value.name, currencyCode: currency.code, amount, withdrawnOn: day, fromStanding },
    };
  } catch (e) {
    if (e instanceof Refused) return { ok: false, refusal: e.refusal };
    throw e;
  }
}

/** «إلغاء» — a reversing row with the written reason. Never a delete, never an edit, and once. */
export async function cancelWithdrawal(input: {
  user: SessionUser;
  companyId: string;
  storeId: string;
  body: { withdrawalId?: unknown; reason?: unknown };
}): Promise<Answer<{ id: string; originalId: string; partnerId: string; currencyCode: string; amount: number; reason: string }>> {
  const { user, companyId, storeId, body } = input;
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (reason.length < 3) return no(400, 'REASON_REQUIRED', 'اكتب سبب الإلغاء.');
  if (typeof body.withdrawalId !== 'string' || !body.withdrawalId) return no(400, 'WITHDRAWAL_REQUIRED', 'اختار المسحوب.');
  const id = body.withdrawalId;

  try {
    return await db.$transaction(async (tx) => {
      // The original's row is held: two cancels at the same instant queue here, and the second sees the first.
      await tx.$queryRaw`SELECT "id" FROM "partner_withdrawals" WHERE "id" = ${id} FOR UPDATE`;
      const original = await tx.partnerWithdrawal.findFirst({
        where: { id, companyId, storeId },
        select: { id: true, partnerId: true, currencyCode: true, amount: true, withdrawnOn: true, reversalOfId: true, reversedBy: { select: { id: true } } },
      });
      if (!original) throw new Refused({ status: 404, code: 'WITHDRAWAL_NOT_FOUND', errorAr: 'المسحوب غير موجود بهالمتجر.' });
      if (original.reversalOfId) throw new Refused({ status: 409, code: 'IS_A_CANCEL', errorAr: 'هاد سطر إلغاء — ما بينلغى.' });
      if (original.reversedBy) throw new Refused({ status: 409, code: 'ALREADY_CANCELLED', errorAr: 'هالمسحوب ملغى من قبل.' });
      const row = await tx.partnerWithdrawal.create({
        data: {
          companyId,
          storeId,
          partnerId: original.partnerId,
          currencyCode: original.currencyCode,
          amount: original.amount,
          withdrawnOn: original.withdrawnOn,
          reversalOfId: original.id,
          reversalReason: reason.slice(0, 300),
          createdById: user.id,
        },
        select: { id: true },
      });
      return {
        ok: true as const,
        value: { id: row.id, originalId: original.id, partnerId: original.partnerId, currencyCode: original.currencyCode, amount: Number(original.amount), reason },
      };
    });
  } catch (e) {
    if (e instanceof Refused) return { ok: false, refusal: e.refusal };
    // The database's own «once»: a second cancel that slipped past the check meets the unique key.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return no(409, 'ALREADY_CANCELLED', 'هالمسحوب ملغى من قبل.');
    }
    throw e;
  }
}

/**
 * THE STANDING AMOUNTS OF ONE PARTNER, SAVED AS A WHOLE: one figure per currency; an empty box clears that currency. Each currency
 * at most once, each one the stores', each figure > 0 in its decimals.
 */
export async function saveStanding(input: {
  user: SessionUser;
  companyId: string;
  body: { partnerId?: unknown; amounts?: unknown };
}): Promise<Answer<{ partnerId: string; amounts: { currencyCode: string; amount: number }[] }>> {
  const { user, companyId, body } = input;
  const partner = await activePartner(companyId, body.partnerId, false);
  if (!partner.ok) return partner;
  if (!Array.isArray(body.amounts) || body.amounts.length > 50) return no(400, 'INVALID_AMOUNTS', 'قائمة المبالغ مش مفهومة.');

  const known = await companyCurrencies(companyId);
  const keep: { currencyCode: string; amount: number }[] = [];
  const clear: string[] = [];
  const seen = new Set<string>();
  for (const raw of body.amounts as { currencyCode?: unknown; amount?: unknown }[]) {
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
    keep.push({ currencyCode: currency.code, amount });
  }

  await db.$transaction(async (tx) => {
    if (clear.length) {
      await tx.partnerStandingAmount.deleteMany({ where: { companyId, partnerId: partner.value.id, currencyCode: { in: clear } } });
    }
    for (const k of keep) {
      await tx.partnerStandingAmount.upsert({
        where: { partnerId_currencyCode: { partnerId: partner.value.id, currencyCode: k.currencyCode } },
        create: { companyId, partnerId: partner.value.id, currencyCode: k.currencyCode, amount: k.amount, updatedById: user.id },
        update: { amount: k.amount, updatedById: user.id },
      });
    }
  });
  return { ok: true, value: { partnerId: partner.value.id, amounts: keep } };
}
