import { z } from 'zod';
import { Prisma } from '@prisma/client';
import type { db as prismaDb } from './db';
import type { SessionUser } from '@/types/auth';
import { reachesStore, seesAllCountries } from './geo-context';
import { foldForMatch } from './order-parser';

type Client = Prisma.TransactionClient | typeof prismaDb;

/**
 * THE SAME ARTICLE IN TWO STORES (the warehouse plan, request W7a).
 *
 * Two `Product` rows of two stores of ONE company that a person said are the same goods. A transfer between stores
 * (W7b) takes units out of product A and must know which product of the other store they land in; nothing links the
 * two today (`Product.sku` is unique per store, not per company). This module holds the link and nothing else: no
 * stock, no batch, no ledger line and no money is read or written here. 20/11 (W7b): the transfer across stores reads the
 * table through `product-twins.ts`, and through nothing else.
 *
 *   propose  the products of the store the caller stands in against those of ONE other store she reaches, by hints
 *            that are equalities, never a fuzzy score: the same sku first, then the same name, then the same English
 *            name — each folded the way every product matcher of this system folds (`order-parser.foldForMatch`:
 *            hamza and taa-marbuta forms, diacritics, tatweel, Arabic-Indic digits, letter case) and with the spaces
 *            collapsed. A product already paired with that store is not proposed again, on either side. A proposal
 *            with more than one candidate, or whose candidate is also proposed for another product, says so
 *            (`sure: false`): the person chooses; the system never does.
 *   save     one product of the caller's store + one product of another store she reaches, same company. Written in
 *            ONE direction (`canonical`): side A is the store whose id sorts first, so the database holds one pair per
 *            couple and one twin per product per other store by plain unique keys (see the migration). Saving the
 *            very pair again is a replay, not an error. The hint is the server's own reading, never the client's.
 *   remove   a pair of the caller's store whose other store she reaches. Nothing else points at it yet.
 *
 * Tenancy: every read and write carries the company; one side is always the store the session stands in, the other
 * a store the person reaches by the system's one store-entry rule (`geo-context.reachesStore`). A product of a store
 * she does not reach answers exactly like a product that does not exist.
 */

export const PAIR_HINTS = ['SKU', 'NAME', 'NAME_EN'] as const;
export type PairHint = (typeof PAIR_HINTS)[number];

/** What each hint is called on the screen. */
export const PAIR_HINT_AR: Record<PairHint, string> = {
  SKU: 'نفس الرمز',
  NAME: 'نفس الاسم',
  NAME_EN: 'نفس الاسم اللاتيني',
};

export type ProductPairRefusalCode =
  | 'INVALID'
  | 'PRODUCT_NOT_FOUND'
  | 'OTHER_NOT_FOUND'
  | 'SAME_STORE'
  | 'MINE_ALREADY_PAIRED'
  | 'OTHER_ALREADY_PAIRED'
  | 'PAIR_NOT_FOUND';

const AR: Record<ProductPairRefusalCode, string> = {
  INVALID: 'البيانات ناقصة أو مش صحيحة. حدّث الصفحة وجرّب كمان مرة.',
  PRODUCT_NOT_FOUND: 'المنتج مش موجود بهالمتجر. حدّث الصفحة.',
  OTHER_NOT_FOUND: 'منتج المتجر التاني مش موجود، أو ما إلك وصول لمتجره.',
  SAME_STORE: 'المنتجين بنفس المتجر. الربط بيكون بين منتج من متجر ومنتج من متجر تاني.',
  MINE_ALREADY_PAIRED: 'هالمنتج مربوط من قبل بمنتج تاني بنفس المتجر التاني. شيل الربط القديم أول.',
  OTHER_ALREADY_PAIRED: 'منتج المتجر التاني مربوط من قبل بمنتج تاني من متجرك. شيل الربط القديم أول.',
  PAIR_NOT_FOUND: 'الربط مش موجود، أو ما إلك وصول لمتجره التاني. حدّث الصفحة.',
};

const STATUS_OF: Record<ProductPairRefusalCode, number> = {
  INVALID: 400,
  PRODUCT_NOT_FOUND: 404,
  OTHER_NOT_FOUND: 404,
  SAME_STORE: 409,
  MINE_ALREADY_PAIRED: 409,
  OTHER_ALREADY_PAIRED: 409,
  PAIR_NOT_FOUND: 404,
};

export class ProductPairRefused extends Error {
  readonly status: number;
  readonly errorAr: string;
  constructor(
    readonly code: ProductPairRefusalCode,
    readonly extra: Record<string, unknown> = {}
  ) {
    super(AR[code]);
    this.name = 'ProductPairRefused';
    this.errorAr = AR[code];
    this.status = STATUS_OF[code];
  }
}

/** The JSON a door answers a refusal with: an Arabic sentence, a stable code, and what the refusal carries. */
export function pairRefusalBody(e: ProductPairRefused) {
  return { error: e.errorAr, errorAr: e.errorAr, code: e.code, ...e.extra };
}

export const saveSchema = z.object({
  productId: z.string().min(1, AR.INVALID).max(64, AR.INVALID),
  otherProductId: z.string().min(1, AR.INVALID).max(64, AR.INVALID),
});

// ─── the pure part ───

/** The form two skus or two names are compared in; null when there is nothing to compare. */
export function pairKey(text: string | null | undefined): string | null {
  if (!text) return null;
  const k = foldForMatch(text).replace(/\s+/g, ' ').trim();
  return k.length > 0 ? k : null;
}

export interface PairSide {
  productId: string;
  storeId: string;
}

/** The one direction a pair is written in: side A is the store whose id sorts first (byte order, as COLLATE "C"). */
export function canonical(x: PairSide, y: PairSide) {
  if (x.storeId === y.storeId) throw new ProductPairRefused('SAME_STORE');
  const [a, b] = x.storeId < y.storeId ? [x, y] : [y, x];
  return { productAId: a.productId, storeAId: a.storeId, productBId: b.productId, storeBId: b.storeId };
}

export interface PairableProduct {
  id: string;
  name: string;
  nameEn: string | null;
  sku: string;
}

const KEY_OF: Record<PairHint, (p: PairableProduct) => string | null> = {
  SKU: (p) => pairKey(p.sku),
  NAME: (p) => pairKey(p.name),
  NAME_EN: (p) => pairKey(p.nameEn),
};

/** The strongest hint under which these two products are the same, or null when none holds. */
export function hintOf(x: PairableProduct, y: PairableProduct): PairHint | null {
  for (const h of PAIR_HINTS) {
    const k = KEY_OF[h](x);
    if (k !== null && k === KEY_OF[h](y)) return h;
  }
  return null;
}

export interface PairProposal {
  productId: string;
  hint: PairHint;
  candidateIds: string[];
  /** One candidate, and that candidate proposed for nobody else under the same hint. */
  sure: boolean;
}

/**
 * Proposals for the products of one store (`mine`) against those of another (`theirs`). Products already paired with
 * the other side are left out on both sides (`pairedMine`, `pairedTheirs`). Each product of mine is proposed once,
 * under its strongest hint; the order is every SKU proposal, then NAME, then NAME_EN, each in the order `mine` came in.
 */
export function proposePairs(
  mine: readonly PairableProduct[],
  theirs: readonly PairableProduct[],
  pairedMine: ReadonlySet<string>,
  pairedTheirs: ReadonlySet<string>
): PairProposal[] {
  const free = theirs.filter((p) => !pairedTheirs.has(p.id));
  const left = mine.filter((p) => !pairedMine.has(p.id));
  const proposed = new Set<string>();
  const out: PairProposal[] = [];
  for (const hint of PAIR_HINTS) {
    const index = new Map<string, string[]>();
    for (const p of free) {
      const k = KEY_OF[hint](p);
      if (k !== null) index.set(k, [...(index.get(k) ?? []), p.id]);
    }
    const level: PairProposal[] = [];
    for (const p of left) {
      if (proposed.has(p.id)) continue;
      const k = KEY_OF[hint](p);
      const candidateIds = k === null ? [] : index.get(k) ?? [];
      if (candidateIds.length === 0) continue;
      proposed.add(p.id);
      level.push({ productId: p.id, hint, candidateIds, sure: candidateIds.length === 1 });
    }
    // A candidate offered to two products of mine under one hint is not sure for either of them.
    const offered = new Map<string, number>();
    for (const l of level) for (const c of l.candidateIds) offered.set(c, (offered.get(c) ?? 0) + 1);
    for (const l of level) if (l.candidateIds.some((c) => (offered.get(c) ?? 0) > 1)) l.sure = false;
    out.push(...level);
  }
  return out;
}

// ─── reach ───

export interface ReachedStore {
  id: string;
  name: string;
  countryId: string;
}

/**
 * Every store of the company this person may enter — the one store-entry rule (`geo-context.reachesStore`), its facts
 * loaded once for all the stores.
 */
export async function storesReachedBy(client: Client, user: SessionUser, companyId: string): Promise<ReachedStore[]> {
  const seesAll = seesAllCountries(user);
  const [stores, assigned, granted] = await Promise.all([
    client.store.findMany({
      where: { companyId },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, countryId: true, country: { select: { isActive: true, companyId: true } } },
    }),
    seesAll
      ? Promise.resolve([] as { countryId: string }[])
      : client.userCountryAccess.findMany({ where: { userId: user.id }, select: { countryId: true } }),
    seesAll
      ? Promise.resolve([] as { storeId: string; store: { countryId: string } }[])
      : client.userStoreAccess.findMany({ where: { userId: user.id }, select: { storeId: true, store: { select: { countryId: true } } } }),
  ]);
  const assignedIds = new Set(assigned.map((a) => a.countryId));
  return stores
    .filter((s) =>
      reachesStore(
        {
          seesAll,
          countryOpen: !!s.country?.isActive && s.country.companyId === companyId,
          countryAssigned: assignedIds.has(s.countryId),
          storesInCountry: granted.filter((g) => g.store.countryId === s.countryId).map((g) => g.storeId),
          hasStoreGrants: granted.length > 0,
        },
        s.id
      )
    )
    .map(({ id, name, countryId }) => ({ id, name, countryId }));
}

// ─── reads ───

export interface PairRow {
  id: string;
  productAId: string;
  storeAId: string;
  productBId: string;
  storeBId: string;
  hint: string | null;
  createdById: string;
  createdAt: Date;
}

const PAIR_SELECT = {
  id: true,
  productAId: true,
  storeAId: true,
  productBId: true,
  storeBId: true,
  hint: true,
  createdById: true,
  createdAt: true,
} as const;

/** A pair as the store `storeId` sees it: its own product, and the twin in the other store. */
export function seenFrom(pair: PairRow, storeId: string) {
  const mineIsA = pair.storeAId === storeId;
  return {
    id: pair.id,
    productId: mineIsA ? pair.productAId : pair.productBId,
    otherProductId: mineIsA ? pair.productBId : pair.productAId,
    otherStoreId: mineIsA ? pair.storeBId : pair.storeAId,
    hint: pair.hint,
    createdById: pair.createdById,
    createdAt: pair.createdAt,
  };
}

/** The pairs of this store with the stores in `reached` (a pair with a store she does not reach is not hers to see). */
export async function pairsOfStore(client: Client, companyId: string, storeId: string, reached: readonly string[]) {
  const rows = await client.productPair.findMany({
    where: {
      companyId,
      OR: [
        { storeAId: storeId, storeBId: { in: [...reached] } },
        { storeBId: storeId, storeAId: { in: [...reached] } },
      ],
    },
    orderBy: { createdAt: 'desc' },
    select: PAIR_SELECT,
  });
  return rows.map((r) => seenFrom(r, storeId));
}

const PRODUCT_SELECT = { id: true, name: true, nameEn: true, sku: true } as const;

/** The proposals between the caller's store and ONE other store she reaches (the door checks the reach). */
export async function proposalsBetween(client: Client, companyId: string, storeId: string, otherStoreId: string) {
  if (otherStoreId === storeId) throw new ProductPairRefused('SAME_STORE');
  const [mine, theirs, pairs] = await Promise.all([
    client.product.findMany({ where: { companyId, storeId }, orderBy: { name: 'asc' }, select: PRODUCT_SELECT }),
    client.product.findMany({ where: { companyId, storeId: otherStoreId }, orderBy: { name: 'asc' }, select: PRODUCT_SELECT }),
    client.productPair.findMany({
      where: {
        companyId,
        OR: [
          { storeAId: storeId, storeBId: otherStoreId },
          { storeAId: otherStoreId, storeBId: storeId },
        ],
      },
      select: PAIR_SELECT,
    }),
  ]);
  const seen = pairs.map((p) => seenFrom(p, storeId));
  const proposals = proposePairs(mine, theirs, new Set(seen.map((p) => p.productId)), new Set(seen.map((p) => p.otherProductId)));
  return { proposals, mine, theirs };
}

// ─── writes ───

/**
 * Save the pair (`productId` of the caller's store, `otherProductId` of another store she reaches). Inside the
 * caller's transaction. Returns the pair as her store sees it, and whether it was already there (a replay).
 */
export async function savePair(
  tx: Client,
  p: {
    companyId: string;
    storeId: string;
    userId: string;
    productId: string;
    otherProductId: string;
    /** The store-entry rule for this person (`storesReachedBy`). */
    reaches: (storeId: string) => Promise<boolean>;
  }
) {
  const mine = await tx.product.findFirst({ where: { id: p.productId, companyId: p.companyId, storeId: p.storeId }, select: { ...PRODUCT_SELECT, storeId: true } });
  if (!mine) throw new ProductPairRefused('PRODUCT_NOT_FOUND');
  const other = await tx.product.findFirst({ where: { id: p.otherProductId, companyId: p.companyId }, select: { ...PRODUCT_SELECT, storeId: true } });
  // A product with no store, or of a store she does not reach, answers like one that does not exist.
  if (!other || !other.storeId) throw new ProductPairRefused('OTHER_NOT_FOUND');
  if (other.storeId === p.storeId) throw new ProductPairRefused('SAME_STORE');
  if (!(await p.reaches(other.storeId))) throw new ProductPairRefused('OTHER_NOT_FOUND');

  const c = canonical({ productId: mine.id, storeId: p.storeId }, { productId: other.id, storeId: other.storeId });
  const clash = await tx.productPair.findMany({
    where: {
      companyId: p.companyId,
      OR: [
        { productAId: c.productAId, storeBId: c.storeBId },
        { productBId: c.productBId, storeAId: c.storeAId },
      ],
    },
    select: PAIR_SELECT,
  });
  const same = clash.find((r) => r.productAId === c.productAId && r.productBId === c.productBId);
  if (same) return { pair: seenFrom(same, p.storeId), replay: true };
  for (const r of clash) {
    const seen = seenFrom(r, p.storeId);
    if (seen.productId === mine.id) throw new ProductPairRefused('MINE_ALREADY_PAIRED', { pairId: r.id, otherProductId: seen.otherProductId });
    throw new ProductPairRefused('OTHER_ALREADY_PAIRED', { pairId: r.id, productId: seen.productId });
  }

  const row = await tx.productPair.create({
    data: { companyId: p.companyId, ...c, hint: hintOf(mine, other), createdById: p.userId },
    select: PAIR_SELECT,
  });
  return { pair: seenFrom(row, p.storeId), replay: false };
}

/** Remove a pair of the caller's store whose other store she reaches. Returns what was removed (for the audit line). */
export async function removePair(
  tx: Client,
  p: { companyId: string; storeId: string; pairId: string; reaches: (storeId: string) => Promise<boolean> }
) {
  const row = await tx.productPair.findFirst({
    where: { id: p.pairId, companyId: p.companyId, OR: [{ storeAId: p.storeId }, { storeBId: p.storeId }] },
    select: PAIR_SELECT,
  });
  if (!row) throw new ProductPairRefused('PAIR_NOT_FOUND');
  const seen = seenFrom(row, p.storeId);
  if (!(await p.reaches(seen.otherStoreId))) throw new ProductPairRefused('PAIR_NOT_FOUND');
  await tx.productPair.delete({ where: { id: row.id } });
  return seen;
}

/** A save that lost a race to the same pair — or a clashing one — at the database's unique keys. */
export function isUniqueClash(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}
