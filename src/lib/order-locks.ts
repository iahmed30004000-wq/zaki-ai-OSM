/**
 * SALESFLOW — Order Ownership, Claim & Editing-Lock Engine (Phase B)
 *
 * All ownership mutations are atomic, server-side, and DB-verified.
 * The client is never trusted for: claimedById, currentOwnerId,
 * lockedById, signedById, or version.
 */

import { db } from './db';
import { LOCK_CONFIG_DEFAULTS } from './rbac';
import { reservedForOthersWhere } from './order-reservation';

export type ClaimAction = 'CLAIMED' | 'RELEASED' | 'TRANSFERRED' | 'OVERRIDDEN' | 'UNLOCKED';

/** Lock TTL / heartbeat — overridable later from Company.settings (SUPER_ADMIN only) */
export function lockConfig() {
  return {
    lockDurationMs: LOCK_CONFIG_DEFAULTS.lockDurationMs,
    heartbeatIntervalMs: LOCK_CONFIG_DEFAULTS.heartbeatIntervalMs,
  };
}

/** Is a lock active (held by anyone) right now? DB-time based. */
export function isLockActive(order: { lockedById?: string | null; lockExpiresAt?: Date | null } | any): boolean {
  return !!order.lockedById && !!order.lockExpiresAt && new Date(order.lockExpiresAt).getTime() > Date.now();
}

/**
 * Build the data payload that must be written on every ownership change,
 * plus the activity/audit/claim-history entries. Kept in one place so
 * claim / release / transfer / override stay consistent.
 */
export function ownershipSnapshot(order: any) {
  return {
    previousClaimedById: order.claimedById,
    previousOwnerId: order.currentOwnerId,
    previousLockedById: order.lockedById,
    previousSignatureStatus: order.signatureStatus,
  };
}

// ─────────────────────────────────────────────────────
// Atomic claim helpers
// ─────────────────────────────────────────────────────

/**
 * Attempt to claim an order atomically.
 *
 * Uses updateMany with a conditional WHERE — the DB guarantees only one
 * concurrent writer transitions claimedById from NULL → user.
 * Returns rowsUpdated: 1 on success, 0 if someone else claimed first.
 */
export async function atomicClaim(params: {
  orderId: string;
  userId: string;
  now: Date;
  lockExpiresAt: Date | null;
}) {
  const { orderId, userId, now, lockExpiresAt } = params;
  const result = await db.order.updateMany({
    where: {
      id: orderId,
      // Guard clause — the race-condition gate:
      claimedById: null,
      signatureStatus: 'UNSIGNED',
      // An order held for a colleague who worked this customer last is hers alone (order-reservation.ts) — asked in the write,
      // so a hold made a moment ago stops a claim that read the order a moment before.
      NOT: reservedForOthersWhere(userId, now),
      // Cannot claim while someone else holds an ACTIVE editing lock
      OR: [{ lockedById: null }, { lockExpiresAt: null }, { lockExpiresAt: { lte: new Date() } }],
    },
    data: {
      claimedById: userId,
      claimedAt: now,
      currentOwnerId: userId,
      assignedToId: userId,
      assignedAt: now,
      signatureStatus: 'SIGNED',
      signedById: userId,
      signedAt: now,
      // Self-lock on claim so editing can start immediately (was silently dropped)
      lockedById: userId,
      lockedAt: now,
      lockExpiresAt,
      // Optimistic-concurrency: every ownership write bumps the version
      version: { increment: 1 },
    },
  });
  return result.count === 1;
}

/**
 * Atomic lock acquisition. Succeeds only if no active lock exists
 * (or the expired lock is being replaced).
 */
export async function atomicAcquireLock(params: {
  orderId: string;
  userId: string;
  lockedAt: Date;
  lockExpiresAt: Date;
}) {
  const { orderId, userId, lockedAt, lockExpiresAt } = params;
  const result = await db.order.updateMany({
    where: {
      id: orderId,
      // No active lock held by anyone else:
      OR: [
        { lockedById: null },
        { lockExpiresAt: null },
        { lockExpiresAt: { lte: new Date() } }, // expired locks are replaceable
      ],
    },
    data: {
      lockedById: userId,
      lockedAt,
      lockExpiresAt,
    },
  });
  return result.count === 1;
}

/**
 * Heartbeat: extend MY OWN active lock. Cannot extend someone else's.
 */
export async function atomicRenewLock(params: { orderId: string; userId: string; from: Date; lockExpiresAt: Date }) {
  const result = await db.order.updateMany({
    where: { id: params.orderId, lockedById: params.userId },
    data: { lockExpiresAt: params.lockExpiresAt },
  });
  return result.count === 1;
}

/** Release my own lock. */
export async function atomicReleaseLock(params: { orderId: string; userId: string }) {
  const result = await db.order.updateMany({
    where: { id: params.orderId, lockedById: params.userId },
    data: { lockedById: null, lockedAt: null, lockExpiresAt: null },
  });
  return result.count === 1;
}

/**
 * Optimistic-concurrency conditional save:
 * updates only if the version still matches, then increments it.
 */
export async function atomicVersionedUpdate(params: {
  orderId: string;
  expectedVersion: number;
  data: Record<string, unknown>;
}) {
  const result = await db.order.updateMany({
    where: { id: params.orderId, version: params.expectedVersion },
    data: { ...params.data, version: { increment: 1 } },
  });
  return result.count === 1;
}
