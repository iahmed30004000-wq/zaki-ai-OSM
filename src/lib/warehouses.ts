import { db } from './db';
import { computeEffectiveGrants } from './permissions-core';
import { attachGrants } from './authorization';
import { seesAllCountries } from './geo-context';
import type { SessionUser } from '@/types/auth';

/**
 * WAREHOUSES — a place of one country where goods are kept.
 *
 * A warehouse belongs to a COUNTRY (the owner's decision 2 of the warehouse
 * plan, default allowed): it may hold the goods of any store of that country.
 * A batch keeps `storeId` (whose goods) and gains `warehouseId` (where).
 *
 * THIS FILE IS INERT FOR STOCK. Nothing here is read by a stock door yet:
 * `storeIsPlaced` answers «no» for every store until the opening placement
 * exists, and a store that is not placed works exactly as before. The doors
 * that use this file are the warehouses' own (`/api/geo/warehouses/**`).
 * 19/11 (W2a): the receiving and production doors ask `reachesWarehouse` for
 * the warehouse a placed store's units land in (`warehouse-intake.ts`).
 *
 * WHO REACHES A WAREHOUSE — one rule, with the facts loaded by the caller:
 *   1. its country must be reachable by the same rule as the geo screens
 *      (`geoReach` / `reachesStore`): the owner and `geo.manage` holders reach every
 *      open country; anyone else needs the country assigned, and somebody
 *      confined to named stores reaches only the countries of those stores;
 *   2. the owner and `geo.manage` holders then reach every warehouse of it;
 *   3. anyone else with rows in `user_warehouse_access` — in ANY country — is
 *      confined to the warehouses named there (the lesson of the store rule:
 *      «no rows here» must not mean «everything here» for somebody who was
 *      given named places elsewhere);
 *   4. with no rows at all, every warehouse of a reachable country.
 * A keeper who loses her country loses the warehouse with it, even while her
 * keeper row stays — the row narrows reach, it never grants it.
 */

export interface WarehouseReachFacts {
  /** SUPER_ADMIN or geo.manage — see seesAllCountries(). */
  seesAll: boolean;
  /** The warehouse's country is active and of the warehouse's company. */
  countryOpen: boolean;
  /** The person has a UserCountryAccess row for that country. */
  countryAssigned: boolean;
  /** The person was named stores anywhere (UserStoreAccess rows exist). */
  hasStoreGrants: boolean;
  /** Of those named stores, how many sit in this warehouse's country. */
  storesInCountry: number;
  /** Every warehouse id the person keeps, in any country. */
  keeperOf: readonly string[];
}

/** THE rule — pure, so a screen and a worker answer alike. */
export function reachesWarehouseByFacts(facts: WarehouseReachFacts, warehouseId: string): boolean {
  // The country first, as the store rule and `geoReach` read it: open,
  // then everyone for the owner, then assigned — and somebody confined to
  // named stores reaches only a country one of those stores is in.
  if (!facts.countryOpen) return false;
  if (facts.seesAll) return true;
  if (!facts.countryAssigned) return false;
  if (facts.hasStoreGrants && facts.storesInCountry === 0) return false;
  if (facts.keeperOf.length > 0) return facts.keeperOf.includes(warehouseId);
  return true;
}

type WarehouseRef = { id: string; companyId: string; countryId: string };

/** Loads the facts for ONE person and many warehouses of their company — three reads whatever the count. */
async function factsFor(user: SessionUser, companyId: string, countryIds: readonly string[]) {
  const seesAll = seesAllCountries(user);
  const [countries, assigned, storeGrants, keeps] = await Promise.all([
    db.country.findMany({
      where: { id: { in: [...new Set(countryIds)] }, companyId },
      select: { id: true, isActive: true },
    }),
    seesAll
      ? Promise.resolve([] as { countryId: string }[])
      : db.userCountryAccess.findMany({ where: { userId: user.id }, select: { countryId: true } }),
    seesAll
      ? Promise.resolve([] as { store: { countryId: string } }[])
      : db.userStoreAccess.findMany({ where: { userId: user.id }, select: { store: { select: { countryId: true } } } }),
    seesAll
      ? Promise.resolve([] as { warehouseId: string }[])
      : db.userWarehouseAccess.findMany({ where: { userId: user.id }, select: { warehouseId: true } }),
  ]);
  const open = new Set(countries.filter((c) => c.isActive).map((c) => c.id));
  const assignedIds = new Set(assigned.map((a) => a.countryId));
  const keeperOf = keeps.map((k) => k.warehouseId);
  return (countryId: string): WarehouseReachFacts => ({
    seesAll,
    countryOpen: open.has(countryId),
    countryAssigned: assignedIds.has(countryId),
    hasStoreGrants: storeGrants.length > 0,
    storesInCountry: storeGrants.filter((g) => g.store.countryId === countryId).length,
    keeperOf,
  });
}

/** Does this person reach this warehouse? A warehouse of another company: never. */
export async function reachesWarehouse(user: SessionUser, companyId: string, warehouse: WarehouseRef): Promise<boolean> {
  if (warehouse.companyId !== companyId) return false;
  const facts = await factsFor(user, companyId, [warehouse.countryId]);
  return reachesWarehouseByFacts(facts(warehouse.countryId), warehouse.id);
}

/** The subset of these warehouses (all of one company) this person reaches. */
export async function warehousesReachedBy<W extends WarehouseRef>(
  user: SessionUser,
  companyId: string,
  warehouses: readonly W[]
): Promise<W[]> {
  const mine = warehouses.filter((w) => w.companyId === companyId);
  if (mine.length === 0) return [];
  const facts = await factsFor(user, companyId, mine.map((w) => w.countryId));
  return mine.filter((w) => reachesWarehouseByFacts(facts(w.countryId), w.id));
}

/**
 * Does this person reach the COUNTRY — the condition to be made a keeper of
 * one of its warehouses. The keeper rows themselves are ignored here: being
 * a keeper elsewhere does not stop somebody from becoming one here.
 */
export async function reachesCountryOf(user: SessionUser, companyId: string, countryId: string): Promise<boolean> {
  const facts = (await factsFor(user, companyId, [countryId]))(countryId);
  return reachesWarehouseByFacts({ ...facts, keeperOf: [] }, '');
}

/**
 * The people of this company who may keep a warehouse of this country, as a
 * session would see them: their effective keys are computed the way a login
 * computes them (role rows + personal overrides + a legacy role), because
 * «sees every country» is a question about `geo.manage`.
 */
export async function sessionPeople(
  companyId: string,
  userIds: readonly string[]
): Promise<{ id: string; name: string; user: SessionUser }[]> {
  if (userIds.length === 0) return [];
  const rows = await db.user.findMany({
    where: { id: { in: [...new Set(userIds)] }, companyId },
    select: { id: true, name: true, email: true, role: true, roleId: true, status: true, companyId: true },
  });
  return Promise.all(
    rows.map(async (r) => {
      const base = { ...r, permissions: [] } as unknown as SessionUser;
      const grants = await computeEffectiveGrants({ id: r.id, role: r.role, roleId: r.roleId ?? null });
      return { id: r.id, name: r.name, user: attachGrants(base, grants) };
    })
  );
}

/**
 * Is this store's stock placed in warehouses? — `warehouse-intake.storeIsPlaced`, re-exported.
 *
 * 19/11 (W2a): it moved next to the intake rule, because `receiving.ts` asks it inside every receipt and this module
 * imports the session machinery (`geo-context`, `authorization`) that the stock libraries must not load. One function,
 * one home; the name here stays for the doors that already import it from this file.
 */
export { storeIsPlaced } from './warehouse-intake';

/** The warehouses that may hold this store's goods: the active ones of its country. */
export async function warehousesOfStore(companyId: string, storeId: string) {
  const store = await db.store.findFirst({ where: { id: storeId, companyId }, select: { countryId: true } });
  if (!store) return [];
  return db.warehouse.findMany({
    where: { companyId, countryId: store.countryId, isActive: true },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, countryId: true },
  });
}

/**
 * WHY A WAREHOUSE MAY NOT BE STOPPED YET — one list, one place.
 *
 * Stopping it would leave units with no place anybody may still send to.
 * Today one thing can name a warehouse: a batch with units in it (a negative
 * row counts too — the shelf owes units there). The transfers, the counts and
 * the exits of the later requests add their own line HERE — an open transfer
 * to or from it, an open count sheet, a pending exit — so the stop door keeps
 * one question.
 */
export interface StopBlocker {
  code: 'HOLDS_UNITS';
  count: number;
  ar: string;
}

type Reader = Pick<typeof db, 'productionBatch'>;

export async function warehouseStopBlockers(client: Reader, companyId: string, warehouseId: string): Promise<StopBlocker[]> {
  const blockers: StopBlocker[] = [];
  const batches = await client.productionBatch.count({
    where: { companyId, warehouseId, quantityRemaining: { not: 0 } },
  });
  if (batches > 0) {
    blockers.push({ code: 'HOLDS_UNITS', count: batches, ar: `فيه بضاعة (${batches} دفعة)` });
  }
  return blockers;
}

export const WAREHOUSE_NOT_FOUND_AR = 'المخزن مش موجود. حدّث الصفحة.';
export const WAREHOUSE_NAME_TAKEN_AR = 'في مخزن بنفس الاسم بهالبلد. اختار اسم تاني.';

export function stopRefusalAr(blockers: readonly StopBlocker[]): string {
  return `ما بينوقف هالمخزن: ${blockers.map((b) => b.ar).join(' · ')}. فرّغه أول، وبعدين وقّفه.`;
}
