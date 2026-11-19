import { db } from './db';
import {
  computeEffectiveGrants,
  dbGrantSource,
  type DbUserLike,
  type GrantSource,
  type RoleGrantRow,
  type UserOverrideRow,
} from './permissions-core';
import { attachGrants, can } from './authorization';
import { usersReachingStore } from './geo-context';
import type { SessionUser, UserRole, UserStatus } from '@/types/auth';

/**
 * WHO SHOULD HEAR ABOUT THIS.
 *
 * Every notification used to be written once with no recipient and shown
 * to the whole company, so a moderator's bell carried every confirmation
 * of every colleague, in every store. An audience here is a question the
 * permission engine already knows how to answer — "who holds
 * confirmation.supervise?" — asked for one store, plus any named people
 * the event is personally about (the moderator whose commission depends
 * on a confirmation, the agent holding a postponed order).
 *
 * Nothing here is a second copy of a rule:
 *   - grants come from computeEffectiveGrants and are checked with can(),
 *     so role templates, per-user ALLOW / DENY and the ACTIVE requirement
 *     all apply exactly as they do on a request;
 *   - store reach comes from geo-context's reachesStore, the same rule
 *     the store picker uses.
 *
 * It needs no session. The scheduled jobs run in the worker process, where
 * there is no request and no cookie; the users are read from the database
 * and given their grants here.
 *
 * Cost is bounded, not per user: one query for the users, one for all of
 * their overrides, one per distinct role, and three for store reach.
 *
 * Platform SUPER_ADMINs have no companyId and are not in any company's
 * audience. They reach a company only through requireCompanyTenant's
 * fallback, and they are not the staff these messages are addressed to.
 */

export interface Audience {
  /** Named people, e.g. the order's moderator. Still must be ACTIVE, in the company, and able to enter the store. */
  userIds?: readonly (string | null | undefined)[];
  /** Everyone who holds this permission (as can() decides it). */
  permission?: string;
  /** Everyone who holds ANY of these (as can() decides it) — e.g. whoever works the confirmation desk by any of its keys. */
  anyPermission?: readonly string[];
  /**
   * Everyone whose role is one of these. Only for rules that are themselves
   * written by role — change-request deciders — so who is told matches who
   * may act.
   */
  roles?: readonly string[];
}

export interface AudienceQuery {
  companyId: string;
  /** The store the news is about. Null = company-wide, no store filter. */
  storeId: string | null;
  audience: Audience;
  /** The person whose action caused this. Never told about their own action. */
  actorId?: string | null;
}

/**
 * A GrantSource that has already loaded every candidate's overrides and
 * remembers role rows per role, so evaluating N users costs a bounded
 * number of queries instead of 2N.
 */
function batchGrantSource(overrides: Map<string, UserOverrideRow[]>): GrantSource {
  const roles = new Map<string, Promise<RoleGrantRow[]>>();
  return {
    roleRows(user: DbUserLike) {
      const key = user.roleId ? `id:${user.roleId}` : `name:${user.role}`;
      let rows = roles.get(key);
      if (!rows) {
        rows = dbGrantSource.roleRows(user);
        roles.set(key, rows);
      }
      return rows;
    },
    overrideRows: async (userId: string) => overrides.get(userId) ?? [],
  };
}

/**
 * The ACTIVE users of the company this audience names, able to enter the
 * store, without the actor and without duplicates. Each carries its grants,
 * so the caller can ask can() about it (e.g. which link it may open).
 */
export async function resolveAudience(q: AudienceQuery): Promise<SessionUser[]> {
  const named = [...new Set((q.audience.userIds ?? []).filter((id): id is string => !!id))];
  const permission = q.audience.permission;
  const anyPermission = q.audience.anyPermission ?? [];
  const roles = q.audience.roles ?? [];
  if (!permission && anyPermission.length === 0 && roles.length === 0 && named.length === 0) return [];

  // With a permission every ACTIVE employee is a candidate — whether they
  // hold it is the engine's question, not a role-name list's.
  const rows = await db.user.findMany({
    where: {
      companyId: q.companyId,
      status: 'ACTIVE',
      ...(permission || anyPermission.length || roles.length ? {} : { id: { in: named } }),
    },
    select: { id: true, name: true, email: true, role: true, roleId: true, status: true, companyId: true },
  });
  const candidates = rows.filter((u) => u.id !== q.actorId);
  if (candidates.length === 0) return [];

  const overrideRows = await db.userPermission.findMany({
    where: { userId: { in: candidates.map((u) => u.id) } },
    select: { userId: true, permission: true, effect: true, scope: true, scopeIds: true },
  });
  const overrides = new Map<string, UserOverrideRow[]>();
  for (const { userId, ...o } of overrideRows) overrides.set(userId, [...(overrides.get(userId) ?? []), o]);
  const source = batchGrantSource(overrides);

  const users = await Promise.all(
    candidates.map(async (u) => {
      const session: SessionUser = {
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role as UserRole,
        status: u.status as UserStatus,
        companyId: u.companyId,
        permissions: [],
      };
      return attachGrants(session, await computeEffectiveGrants({ id: u.id, role: u.role, roleId: u.roleId }, source));
    })
  );

  const namedSet = new Set(named);
  const wanted = users.filter(
    (u) =>
      namedSet.has(u.id) ||
      (!!permission && can(u, permission)) ||
      anyPermission.some((k) => can(u, k)) ||
      roles.includes(u.role)
  );
  if (!q.storeId || wanted.length === 0) return wanted;

  const reach = await usersReachingStore(wanted, q.companyId, q.storeId);
  return wanted.filter((u) => reach.has(u.id));
}
