import { getPermissionScope } from '@/lib/authorization';
import { seesAllCountries } from '@/lib/geo-context';
import type { SessionUser } from '@/types/auth';
import type { V1Scope } from './system-token';

/**
 * WHOEVER MINTS A KEY MUST HOLD WHAT IT OPENS.
 *
 * A system token is a ninety-day key another program uses on this company's
 * behalf. «تثبيت وتسجيل التطبيقات» alone minted one with any scope — reading
 * every customer by phone, every order, the cost of goods — whether or not
 * the person minting it could read any of that themselves. That is the
 * granter-must-hold rule the roles and the exceptions already keep, missing
 * from the one door that hands powers to a machine.
 *
 * Each scope names the keys it stands for, at full scope: a token reads the
 * whole company, so a person who sees only their own orders cannot mint one
 * that sees everybody's.
 */
const NEEDS: Record<V1Scope, readonly string[]> = {
  'products.read': ['products.view'],
  'customers.lookup': ['customers.view'],
  'orders.create': ['orders.create'],
  'orders.read': ['orders.view'],
  'orders.note': ['orders.view'],
  'orders.attribution.read': ['orders.view'],
  // The cost of goods is money: the product key, the finance key and the cost key (PR-10: whoever mints it must see it).
  'products.costs.read': ['products.view', 'finance.view', 'costs.view'],
};

/** The first scope this person may not mint, with the key it lacks — or null. */
export function scopeBeyondMinter(actor: SessionUser, scopes: readonly V1Scope[]): { scope: V1Scope; key: string } | null {
  for (const scope of scopes) {
    for (const key of NEEDS[scope] ?? []) {
      if (getPermissionScope(actor, key)?.scope !== 'ALL_COMPANY') return { scope, key };
    }
  }
  return null;
}

/** The first key a scope needs that this person does not hold at full scope — or null. */
export function keyScopeLacks(actor: SessionUser, scope: V1Scope): string | null {
  for (const key of NEEDS[scope] ?? []) {
    if (getPermissionScope(actor, key)?.scope !== 'ALL_COMPANY') return key;
  }
  return null;
}

/**
 * AND A KEY READS THE WHOLE COMPANY, SO ITS MINTER MUST SEE THE WHOLE COMPANY.
 *
 * No v1 door is narrowed to a store: a key with «سؤال عن رقم زبون» answers
 * for every store and every country. A manager confined to one store, who
 * holds the matching keys inside it, could mint a key that reads all the
 * others. So minting needs every country (seesAllCountries) — the owner, or
 * whoever he gave «إدارة الدول والمتاجر».
 */
export function mayMintForCompany(actor: SessionUser): boolean {
  return seesAllCountries(actor);
}
