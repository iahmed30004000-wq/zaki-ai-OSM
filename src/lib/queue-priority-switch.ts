import type { Prisma } from '@prisma/client';
import { updateCompanySettings } from './company-settings';
import type { db } from './db';

type Client = Prisma.TransactionClient | typeof db;

/**
 * ═══════════════════════════════════════════════════════════════════════
 * WHERE THE «أولوية الطابور v2» SWITCH LIVES: `Company.settings.queuePriority` (Confirmation Center v2, step D).
 *
 * Its OWN key — not the call-proof one (`callProofAndCadence`) and not the intake filter's: the pull order decides WHICH order a girl is given next, so it is switched on
 * and rolled back on its own.
 *
 * The twin of `intake-filter-switch.ts`, line for line: no column and no migration, stored as `{ enabled, enabledAt }` under a row lock (`updateCompanySettings`), cached
 * a few seconds per company in this process, a save replaces the cache at once.
 *
 * ── OFF UNLESS IT IS PLAINLY ON ──
 *
 * A missing key, a broken document, a value that is not a real `true` with a real date, and a read that FAILS are all OFF — and OFF is the pull exactly as it is today
 * (the order of `pickNextCandidate`, query for query). A rule that picks the order must never turn itself on by an error.
 * ═══════════════════════════════════════════════════════════════════════
 */

export const QUEUE_PRIORITY_SETTINGS_KEY = 'queuePriority';
/** The same few seconds the other switches keep their answer. */
export const QUEUE_PRIORITY_SWITCH_CACHE_MS = 10_000;

export interface QueuePrioritySwitch {
  enabled: boolean;
  /** When it went on (the SERVER's clock); null while it is off. */
  enabledAt: Date | null;
}

export const QUEUE_PRIORITY_OFF: QueuePrioritySwitch = { enabled: false, enabledAt: null };

interface Stored {
  enabled: boolean;
  enabledAt: string | null;
}

const cache = new Map<string, { value: QueuePrioritySwitch; at: number }>();

/** A stored value as this build understands it — anything but a plain «on, since a valid date» is off. */
export function parseQueuePrioritySwitch(raw: unknown): QueuePrioritySwitch {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (o.enabled !== true || typeof o.enabledAt !== 'string') return QUEUE_PRIORITY_OFF;
  const when = new Date(o.enabledAt);
  return Number.isNaN(when.getTime()) ? QUEUE_PRIORITY_OFF : { enabled: true, enabledAt: when };
}

/** The switch for this company — cached, and OFF on any failure. */
export async function queuePrioritySwitch(client: Client, companyId: string, nowMs: number = Date.now()): Promise<QueuePrioritySwitch> {
  const hit = cache.get(companyId);
  if (hit && nowMs - hit.at < QUEUE_PRIORITY_SWITCH_CACHE_MS) return hit.value;
  let value: QueuePrioritySwitch = QUEUE_PRIORITY_OFF;
  try {
    const company = await client.company.findUnique({ where: { id: companyId }, select: { settings: true } });
    value = parseQueuePrioritySwitch((company?.settings ? JSON.parse(company.settings) : {})[QUEUE_PRIORITY_SETTINGS_KEY]);
  } catch {
    value = QUEUE_PRIORITY_OFF;
  }
  cache.set(companyId, { value, at: nowMs });
  return value;
}

/** Forget what was read — a save does it, and so may a test. */
export function forgetQueuePrioritySwitch(companyId?: string): void {
  if (companyId) cache.delete(companyId);
  else cache.clear();
}

/**
 * Turn it on or off. On stores the moment («enabledAt»); turning it on while it is already on keeps the first moment, so a second press does not restart the
 * clock. Off clears it: the next time it goes on is a new start.
 */
export async function saveQueuePrioritySwitch(companyId: string, enabled: boolean, now: Date = new Date()): Promise<QueuePrioritySwitch> {
  const stored = await updateCompanySettings<Stored>(companyId, QUEUE_PRIORITY_SETTINGS_KEY, (current) => {
    const was = parseQueuePrioritySwitch(current);
    if (!enabled) return { enabled: false, enabledAt: null };
    return { enabled: true, enabledAt: (was.enabled && was.enabledAt ? was.enabledAt : now).toISOString() };
  });
  const value = parseQueuePrioritySwitch(stored);
  cache.set(companyId, { value, at: Date.now() });
  return value;
}
