/**
 * SALESFLOW — Centralized Server-Side RBAC Engine
 *
 * Every protected API must authorize through this module.
 * Frontend permission checks are UX only — never security.
 *
 * Enforcement chain for sensitive operations:
 *   authenticate → company tenant → role → permission
 *   → order scope (assignment) → lock ownership → version
 */

import { db } from './db';
import type { Permission, SessionUser, UserRole } from '@/types/auth';
import { ROLE_PERMISSIONS } from '@/types/auth';

/**
 * Permission checks live in './authorization' (single source of truth).
 * Re-exported here for backward compatibility — do not re-implement.
 */
import { can as _can, requirePermission as _requirePermission, getPermissionScope } from './authorization';
import { ORDER_WORK_DOOR, mayEnterOrderWorkDoor, type OrderWorkDoor } from './order-work-door';
import { isHeldRow, reservedWhere } from './order-reservation';
export const can: (user: SessionUser, permission: Permission) => boolean = _can;
export const requirePermission: (permission: Permission) => Promise<SessionUser> = _requirePermission;

// ─────────────────────────────────────────────────────
// Permission checks (pure, no DB) — implemented in './authorization'
// ─────────────────────────────────────────────────────

/**
 * Order visibility — driven by the Permission Engine scope of `orders.view`:
 *   ALL_COMPANY → all company orders (SHARED COMPANY VISIBILITY default)
 *   ASSIGNED    → assigned/claimed/owned + claimable queue (agents)
 *   OWN         → orders the user entered (moderatorId)
 *   none        → no orders
 * `companyId` remains the tenant boundary (applied by the caller).
 */
export function orderVisibilityWhere(user: SessionUser): Record<string, unknown> {
  const scope = getPermissionScope(user, 'orders.view');
  if (!scope) return { id: '__no_access__' };

  if (scope.scope === 'ALL_COMPANY') return {};

  if (scope.scope === 'ASSIGNED') {
    return {
      OR: [
        // 1. Assigned specifically to me
        { assignedToId: user.id },
        { claimedById: user.id },
        { currentOwnerId: user.id },
        /*
         * AND WHAT SHE TYPED, EVEN ONCE SOMEBODY ELSE HOLDS IT.
         *
         * The list envelope has listed `createdById` since the column
         * existed; this one did not, so an order she entered that was
         * later released, auto-released and pulled, transferred, or
         * pushed to the queue by a full cap stayed in her list and
         * opened as «غير موجود». A row a list shows is a row that opens.
         */
        { createdById: user.id },
        // Orders I entered as a moderator (legacy compat)
        { moderatorId: user.id },
        // ─── Claimable queue: unclaimed orders in the workflow intake stage ───
        {
          claimedById: null,
          signatureStatus: 'UNSIGNED',
          confirmationStatus: 'NEW',
          // lock-free only
          OR: [{ lockedById: null }, { lockExpiresAt: null }, { lockExpiresAt: { lte: new Date() } }],
        },
      ],
    };
  }

  if (scope.scope === 'OWN') {
    /*
     * ENTERED BY HIM — BY EITHER RECORD OF IT.
     *
     * `moderatorId` is the old one and only ever held a MODERATOR;
     * `createdById` is written on every staff creation path from now on.
     * Both, because orders from before the column exists have only the
     * first, and nothing was backfilled: «visible by claim, as today».
     */
    return { OR: [{ createdById: user.id }, { moderatorId: user.id }] };
  }

  // CATEGORY / SPECIFIC are not meaningful for orders
  return { id: '__no_access__' };
}

/**
 * ═══════════════════════════════════════════════════════════════════════
 * WHAT A LIST MAY SHOW — WHICH IS NOT WHAT A PERSON MAY READ.
 *
 * `orderVisibilityWhere` answers both questions today, and the two are not
 * the same question. Its ASSIGNED branch carries the CLAIMABLE QUEUE —
 * unclaimed, unsigned, NEW orders — and that branch is not there to give an
 * agent a list of the pool. It is there so an agent can OPEN an order she is
 * about to pull: `assertOrderReadable` puts this very object into its query,
 * and before it did, the claim route carried a hand-written patch saying
 * «Without this the agent sees the order in their queue but gets 403 when
 * actually claiming it» (`a-queue-row-opens.test.ts`).
 *
 * So «the agent's «الطلبات» never shows the unclaimed pool» cannot be done
 * by narrowing that function. Narrowing it would 404 every order she tries
 * to pull.
 *
 * Two envelopes, then:
 *
 *   `orderVisibilityWhere` — MAY I READ THIS ONE ORDER. Keeps the pool.
 *   Used by the detail, the timeline, the notes, the call log, the claim.
 *
 *   `orderListWhere` — WHAT BELONGS IN A LIST OF ORDERS. Drops the pool.
 *   Used by anything that returns MORE THAN ONE order: `GET /api/orders`
 *   with its search and its scan, and the report export.
 *
 * The owner's rule in one line: an agent's list is the work she has taken
 * and the work she typed — not the shelf she may take from.
 * ═══════════════════════════════════════════════════════════════════════
 */
export function orderListWhere(user: SessionUser): Record<string, unknown> {
  const scope = getPermissionScope(user, 'orders.view');
  if (!scope) return { id: '__no_access__' };

  if (scope.scope === 'ALL_COMPANY') return {};

  if (scope.scope === 'ASSIGNED') {
    return {
      OR: [
        { assignedToId: user.id },
        { claimedById: user.id },
        { currentOwnerId: user.id },
        // Orders she entered herself — by either record of it.
        { createdById: user.id },
        { moderatorId: user.id },
        /*
         * AND THE ORDERS HELD FOR A COLLEAGUE, so she can SEE them and cannot take them.
         *
         * The owner, 31/10: «باقي الموظفات يشوفوه ومايقدرو يسحبوه». A returning customer's new order is held for the agent who
         * worked him last (order-reservation.ts); it is in the queue and in every agent's «الطلبات» with her name on it. The
         * ones held for HER are already above (`assignedToId`); this adds the ones held for anybody — read-only here, because
         * the claim door and the pull skip them for everyone but her.
         */
        reservedWhere(new Date()),
      ],
    };
  }

  // OWN and the rest read exactly as they do for a single order: a list of
  // what he entered is the same set as the orders he may open.
  return orderVisibilityWhere(user);
}

/**
 * Explicit queue filters (Step 3). Backend-enforced — the frontend may only
 * REQUEST a queue; the server decides which queues the role may see.
 */
export type OrderQueue = 'available' | 'assigned_to_me' | 'my_orders' | 'processing' | 'all_company';

export function applyQueueFilter(
  user: SessionUser,
  where: Record<string, any>,
  queue: string | null
): Record<string, any> {
  switch (queue) {
    case 'available': {
      // Unclaimed + workflow-intake eligible; scoped by engine visibility
      const claimable = {
        claimedById: null,
        signatureStatus: 'UNSIGNED',
      };
      const scope = getPermissionScope(user, 'orders.view');
      if (scope?.scope === 'ALL_COMPANY') {
        return { ...where, AND: [...(where.AND ?? []), claimable] };
      }
      if (scope?.scope === 'ASSIGNED') {
        return {
          ...where,
          AND: [...(where.AND ?? []), claimable, { confirmationStatus: 'NEW' }],
        };
      }
      return { ...where, id: '__no_access__' };
    }
    case 'assigned_to_me':
      return { ...where, assignedToId: user.id };
    case 'my_orders':
      return { ...where, claimedById: user.id };
    case 'processing':
      return { ...where, currentOwnerId: user.id };
    case 'all_company': {
      // Queue is available to any user with company-wide order visibility
      if (getPermissionScope(user, 'orders.view')?.scope !== 'ALL_COMPANY') {
        return { ...where, id: '__no_access__' };
      }
      return where;
    }
    default: {
      /*
       * No explicit queue → the role's default LIST envelope.
       *
       * `orderListWhere` and not `orderVisibilityWhere`: this is the one
       * place every multi-order read passes through — `GET /api/orders`
       * with its search and its scan, and `/api/reports/export`, both of
       * which call this function — so the pool leaves all of them at once.
       * The single-order doors keep the read envelope, which still carries
       * the pool, so pulling an order still opens it.
       *
       * Merged via AND so an existing search `OR` is never clobbered by
       * the spread of an envelope that also contains an OR.
       */
      const visibility = orderListWhere(user);
      if (Object.keys(visibility).length === 0) return where;
      return { AND: [where, visibility] };
    }
  }
}

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE HOLDER RULE — THE ORDER SHE HOLDS IS AN ORDER SHE MAY WORK.
 *
 * `confirmation.work` is «العمل على طلباتي والمؤجلة», and «طلباتي» is
 * exactly this: `claimedById` = her (`/api/confirmation/mine`). Granted by
 * the key, never by a role name, and with no pool branch — an order nobody
 * holds is reached by pulling it, not by its id.
 *
 * It is NOT part of the three envelopes above, on purpose: a list never
 * widens or narrows because of it. Only the work door asks it — see
 * `order-work-door.ts` and `orderWorkWhere` below.
 * ═══════════════════════════════════════════════════════════════════════
 */
export function heldOrderWhere(user: SessionUser): { claimedById: string } | null {
  // The engine's own `can` (string keys): the confirmation keys are newer
  // than the `Permission` union the re-export above is typed with.
  return _can(user, 'confirmation.work') ? { claimedById: user.id } : null;
}

/**
 * WHAT OPENS THROUGH THE WORK DOOR: today's envelope, OR the order she holds.
 *
 *   «كل الشركة»                   → {} — the tenant and the store alone, as today
 *   «المسندة إليه» / «طلباتي المنشأة» → that envelope, unchanged, OR the held order
 *   no orders.view, or a scope orders do not have (CATEGORY, SPECIFIC, or one
 *   added after this was written) → the held order alone
 *   neither                        → nothing
 *
 * The scopes are named one by one rather than «anything but ALL_COMPANY», so
 * a scope nobody thought about here opens nothing through it.
 */
export function orderWorkWhere(user: SessionUser): Record<string, unknown> {
  const view = getPermissionScope(user, 'orders.view');
  if (view?.scope === 'ALL_COMPANY') return {};

  const branches: Record<string, unknown>[] = [];
  if (view?.scope === 'ASSIGNED' || view?.scope === 'OWN') branches.push(orderVisibilityWhere(user));
  const held = heldOrderWhere(user);
  if (held) branches.push(held);

  if (branches.length === 0) return { id: '__no_access__' };
  return branches.length === 1 ? branches[0] : { OR: branches };
}

/** The door's entry check, thrown the way the old door throws its own. */
function enterOrderWorkDoor(user: SessionUser): void {
  if (!mayEnterOrderWorkDoor(user)) {
    throw new Error('Forbidden: missing required permission orders.view');
  }
}

/**
 * Today's write rule for the orders.view scope — and NOTHING for a scope it
 * does not name. `assertOrderAccess` below falls through to «allowed» for
 * CATEGORY and SPECIFIC; this door does not copy that.
 */
type Ownership = {
  assignedToId?: string | null;
  claimedById?: string | null;
  currentOwnerId?: string | null;
  moderatorId?: string | null;
  confirmationStatus?: string | null;
};

function viewScopeReaches(user: SessionUser, order: Ownership): boolean {
  const view = getPermissionScope(user, 'orders.view');
  switch (view?.scope) {
    case 'ALL_COMPANY':
      return true;
    case 'ASSIGNED':
      return (
        // Named for her and nobody holds it: hers to take through the claim door, not to work (order-reservation.ts).
        (order.assignedToId === user.id && !isHeldRow(order)) ||
        order.claimedById === user.id ||
        order.currentOwnerId === user.id ||
        order.moderatorId === user.id
      );
    case 'OWN':
      return order.moderatorId === user.id;
    default:
      return false;
  }
}

/** Does this user see all orders company-wide (vs. only their own)? */
// ─────────────────────────────────────────────────────
// Order-scoped authorization (DB-verified)
// ─────────────────────────────────────────────────────

export type OrderAccessResult =
  | { allowed: true; order: Record<string, any> }
  | { allowed: false; reason: 'NOT_FOUND' | 'WRONG_COMPANY' | 'NOT_ASSIGNED' };

/**
 * Verify the authenticated user may access this order:
 * 1. Order exists
 * 2. Belongs to the user's company (multi-tenant isolation)
 * 3. Belongs to the selected store (geo context) — otherwise NOT_FOUND
 * 4. Role-specific assignment (agents only see their own)
 *
 * `ORDER_WORK_DOOR` in place of the permission is the other door: the same
 * three checks, then the order she holds (`heldOrderWhere`) OR today's scope
 * rule — see `workableOrder`. Everything below it is unchanged.
 */
export async function assertOrderAccess(
  orderId: string,
  user: SessionUser,
  scope: { companyId: string; storeId: string },
  permission?: Permission | OrderWorkDoor
): Promise<OrderAccessResult> {
  if (permission === ORDER_WORK_DOOR) return workableOrder(orderId, user, scope);
  if (permission && !can(user, permission)) {
    throw new Error(`Forbidden: missing required permission ${permission}`);
  }

  const order = await db.order.findUnique({ where: { id: orderId } });
  if (!order) return { allowed: false, reason: 'NOT_FOUND' };
  if (order.companyId !== scope.companyId) return { allowed: false, reason: 'WRONG_COMPANY' };
  if (order.storeId !== scope.storeId) return { allowed: false, reason: 'NOT_FOUND' };

  // Scope-driven detail access (Permission Engine):
  //   ALL_COMPANY → tenant check alone; ASSIGNED → ownership check;
  //   OWN → creator check; denied scope → NOT_ASSIGNED.
  const viewScope = getPermissionScope(user, 'orders.view');
  if (viewScope?.scope === 'ASSIGNED') {
    const mine =
      order.assignedToId === user.id ||
      order.claimedById === user.id ||
      order.currentOwnerId === user.id ||
      order.moderatorId === user.id;
    if (!mine) return { allowed: false, reason: 'NOT_ASSIGNED' };
  } else if (viewScope?.scope === 'OWN') {
    if (order.moderatorId !== user.id) return { allowed: false, reason: 'NOT_ASSIGNED' };
  } else if (!viewScope) {
    return { allowed: false, reason: 'NOT_ASSIGNED' };
  }

  return { allowed: true, order };
}

/**
 * THE WORK DOOR, BEFORE A WRITE.
 *
 * Tenant and store first, exactly as above — an order she holds in another
 * store opens only once she stands in that store. Then the holder rule,
 * then today's scope rule with every scope it does not name refused.
 */
async function workableOrder(
  orderId: string,
  user: SessionUser,
  scope: { companyId: string; storeId: string }
): Promise<OrderAccessResult> {
  enterOrderWorkDoor(user);

  const order = await db.order.findUnique({ where: { id: orderId } });
  if (!order) return { allowed: false, reason: 'NOT_FOUND' };
  if (order.companyId !== scope.companyId) return { allowed: false, reason: 'WRONG_COMPANY' };
  if (order.storeId !== scope.storeId) return { allowed: false, reason: 'NOT_FOUND' };

  if (heldOrderWhere(user) && order.claimedById === user.id) return { allowed: true, order };
  if (viewScopeReaches(user, order)) return { allowed: true, order };
  return { allowed: false, reason: 'NOT_ASSIGNED' };
}

/**
 * THE STATUS FOR AN ORDER THIS ACCOUNT MAY NOT HAVE.
 *
 * This map was written out by hand at eighteen call sites, and every copy
 * of it said `NOT_ASSIGNED: 403` under a body reading «Order not found».
 * The two halves of that response contradict each other, and the status is
 * the half that talks: a 404 says «no such order for you», a 403 says «it
 * exists, it is somebody else's» — which is a fact about a colleague's work
 * handed to whoever holds an id from a link, an export or a feed.
 *
 * All three answers are 404 on purpose. One place, so the next reason
 * added to `OrderAccessResult` is one decision, not nineteen.
 */
export const ORDER_ACCESS_STATUS = {
  NOT_FOUND: 404,
  WRONG_COMPANY: 404,
  NOT_ASSIGNED: 404,
} as const;

/**
 * MAY THIS ACCOUNT *READ* THIS ORDER — BY THE LIST'S OWN RULE.
 *
 * `assertOrderAccess` asks whether the order is ASSIGNED to the caller,
 * and that is the right question before a write. It is the wrong question
 * before a read, and the two answers disagreed about the same order:
 *
 *   orderVisibilityWhere(agent)  → includes the CLAIMABLE QUEUE
 *   assertOrderAccess(agent, …)  → NOT_ASSIGNED for anything unclaimed
 *
 * So an agent's queue listed an order and opening it answered 403. The
 * claim route already carries a hand-written patch for exactly this, and
 * its comment says why: «Without this the agent sees the order in their
 * queue but gets 403 when actually claiming it». Reading was never fixed.
 *
 * This does not re-state the envelope; it USES it, in one query, so the
 * list and the detail cannot drift again. Writes keep asking about
 * assignment — reading a parcel you may pick up is not owning it.
 *
 * With `ORDER_WORK_DOOR` the envelope is `orderWorkWhere` — this one, OR
 * the order she holds — in the same single query.
 */
export async function assertOrderReadable(
  orderId: string,
  user: SessionUser,
  scope: { companyId: string; storeId: string },
  permission?: Permission | OrderWorkDoor
): Promise<OrderAccessResult> {
  if (permission === ORDER_WORK_DOOR) return readableToWork(orderId, user, scope);
  if (permission && !can(user, permission)) {
    throw new Error(`Forbidden: missing required permission ${permission}`);
  }

  const order = await db.order.findFirst({
    where: {
      AND: [{ id: orderId, companyId: scope.companyId, storeId: scope.storeId }, orderVisibilityWhere(user)],
    },
  });
  // Absent, another company's, another store's, or another person's work:
  // all one answer, because telling them apart is the leak.
  if (!order) return { allowed: false, reason: 'NOT_FOUND' };
  return { allowed: true, order };
}

/** The work door, before a read: the same one query, with the door's envelope. */
async function readableToWork(
  orderId: string,
  user: SessionUser,
  scope: { companyId: string; storeId: string }
): Promise<OrderAccessResult> {
  enterOrderWorkDoor(user);

  const order = await db.order.findFirst({
    where: {
      AND: [{ id: orderId, companyId: scope.companyId, storeId: scope.storeId }, orderWorkWhere(user)],
    },
  });
  if (!order) return { allowed: false, reason: 'NOT_FOUND' };
  return { allowed: true, order };
}

// ─────────────────────────────────────────────────────
// Role helpers
// ─────────────────────────────────────────────────────

/** Permissions granted to a role (used by /roles matrix + user management) */
/*
 * THREE THINGS NOTHING READ.
 *
 *   `permissionsForRole(role)` — one line over `ROLE_PERMISSIONS[role]`,
 *   which is itself only a fallback for a session that arrives without
 *   attached grants. A named wrapper made the legacy table look like an
 *   answer somebody should ask for.
 *
 *   `DEFAULT_REGISTRATION_ROLE` — registration writes 'PENDING_USER'
 *   where it creates the row; this constant was never the thing it wrote.
 *
 *   `FINANCE_HOLDING_ROLES` — «roles with financial authority, for
 *   separation-of-duties checks». No check ever read it. Separation of
 *   duties here is done by permissions — settlement.upload and
 *   settlement.review are held by different people — and a constant that
 *   merely DECLARES a policy nothing enforces reads like a control that
 *   exists. It does not.
 */

/**
 * System-wide configurable lock settings (Decision 2).
 * Values are defaults; later loaded/overridden from Company.settings
 * by SUPER_ADMIN only via the settings API.
 */
export const LOCK_CONFIG_DEFAULTS = {
  /** Edit-lock TTL in ms */
  lockDurationMs: 5 * 60 * 1000,
  /** Heartbeat renewal interval in ms (client sends; server caps renewals to lockDuration) */
  heartbeatIntervalMs: 45 * 1000,
} as const;

export type LockConfig = typeof LOCK_CONFIG_DEFAULTS;

