import { db } from './db';
import { can, getPermissionScope } from './authorization';
import { resolveAudience } from './notification-audience';
import type { SessionUser } from '@/types/auth';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «شاشة موظفة» — THE OWNER READS AN AGENT'S DESK, AND TOUCHES NOTHING ON IT.
 *
 * The owner, 2/11: «مركز التأكيد ضروري اشوف انا ك مالك شاشات البنات… أو خلي
 * الحساب يدخلو أكثر من شخص». Decided: no shared account and no change to the
 * session (one person, one cookie — a «tokenVersion» bump still signs out every
 * device, by design). Instead the desk door (`GET /api/confirmation/mine`) reads
 * `?agent=<id>` for a viewer this file allows, and answers that agent's desk —
 * the same three groups, the same counts — for reading only.
 *
 * WHO MAY WATCH: `team.monitor` («متابعة أداء الفريق»), AND every order in sight.
 *
 *   · `team.monitor` and NOT `confirmation.supervise`. Measured: the live
 *     CONFIRMATION_AGENT role carries `confirmation.supervise` (22 keys, read
 *     on the live site on 1/11 — see the-live-agent-is-refused-by-the-real-engine
 *     .test.ts). A door opened by `supervise` would have let every agent read
 *     every colleague's desk. `team.monitor` is held by the templates of
 *     COMPANY_ADMIN and MANAGER (migration 20261030170000) and by anybody holding
 *     `users.view`; SUPER_ADMIN holds every key. The live agent holds neither.
 *   · AND `orders.view` at «كل الشركة»: a desk is a list of orders with names and
 *     phones, so whoever reads it must already be able to read any order. A
 *     visibility key rides beside the key of the door, never instead of it.
 *
 * WHOSE DESK: an ACTIVE person of the viewer's company who can enter the store
 * the viewer is in — the same rule the notification fan-out and the store picker
 * use (`resolveAudience` → `usersReachingStore`). Anybody else is «not found»,
 * so an id from another company says nothing about whether it exists.
 *
 * AND NO WRITE DOOR READS IT. Nothing here hands out an identity: the desk door
 * only swaps WHOSE `claimedById` it reads. Every door that changes an order
 * keeps asking the session user, so a press made «as» the agent is a press made
 * by the viewer under his own keys — and the screen draws no such press.
 * ═══════════════════════════════════════════════════════════════════════
 */

/** The key that opens «شاشة موظفة». */
export const DESK_WATCH_KEY = 'team.monitor';

/** May this person read another person's desk? Both halves — see above. */
export function mayWatchDesks(user: SessionUser): boolean {
  return can(user, DESK_WATCH_KEY) && getPermissionScope(user, 'orders.view')?.scope === 'ALL_COMPANY';
}

export const DESK_WATCH_REFUSAL = 'شاشات الموظفات لمن يملك «متابعة أداء الفريق» ويرى كل الطلبات.';
export const DESK_NOT_FOUND = 'ما في موظفة بهذا الرقم في هذا المتجر.';

/** An id, or nothing: it goes into a query, so only the shape an id has. */
const ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The agent asked for, if the viewer may see her desk: `{ id, name }`, or null
 * when she is not an ACTIVE person of this company who reaches this store.
 */
export async function watchedAgent(
  companyId: string,
  storeId: string,
  agentId: string
): Promise<{ id: string; name: string } | null> {
  if (!ID_SHAPE.test(agentId)) return null;
  const found = await resolveAudience({ companyId, storeId, audience: { userIds: [agentId] } });
  const agent = found.find((u) => u.id === agentId);
  return agent ? { id: agent.id, name: agent.name } : null;
}

/** The statuses an order sits on her desk in — «للشغل», «لا يرد», and the postponed ones. */
const ON_A_DESK = ['NEW', 'IN_PROGRESS', 'NO_ANSWER', 'FOLLOW_UP_REQUIRED', 'POSTPONED'];

/**
 * The picker's list: whoever works confirmation (`confirmation.work`, as the
 * engine decides it) in this store, without the viewer, with what each holds
 * open right now.
 */
export async function watchableAgents(
  viewer: SessionUser,
  companyId: string,
  storeId: string
): Promise<{ id: string; name: string; holding: number }[]> {
  const people = await resolveAudience({
    companyId,
    storeId,
    audience: { permission: 'confirmation.work' },
    actorId: viewer.id,
  });
  if (people.length === 0) return [];
  const counts = await db.order.groupBy({
    by: ['claimedById'],
    where: { companyId, storeId, claimedById: { in: people.map((p) => p.id) }, confirmationStatus: { in: ON_A_DESK } },
    _count: { _all: true },
  });
  const holding = new Map(counts.map((c) => [c.claimedById as string, c._count._all]));
  return people
    .map((p) => ({ id: p.id, name: p.name, holding: holding.get(p.id) ?? 0 }))
    .sort((a, b) => b.holding - a.holding || a.name.localeCompare(b.name, 'ar'));
}
