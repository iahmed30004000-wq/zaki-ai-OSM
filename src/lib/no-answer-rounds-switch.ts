import type { Prisma } from '@prisma/client';
import { updateCompanySettings } from './company-settings';
import type { db } from './db';
import { ROUNDS_OFF, type RoundsSwitch } from './no-answer-rounds';

type Client = Prisma.TransactionClient | typeof db;

/**
 * ═══════════════════════════════════════════════════════════════════════
 * WHERE THE «نظام الجولات» SWITCH LIVES: `Company.settings.noAnswerRounds`.
 *
 * No column and no migration — the settings document already holds one key per feature (the win-back rule, the AI, the
 * performance bars), written under a row lock (`updateCompanySettings`). Stored as `{ enabled, enabledAt }`: the moment it
 * went on is part of the rule, because nothing logged before it may move an order (`no-answer-rounds.ts`).
 *
 * ── OFF UNLESS IT IS PLAINLY ON ──
 *
 * A missing key, a broken document, a stored value that is not a real `true` with a real date, and a read that FAILS are
 * all OFF — the old rotation and rounds (the pull's order and the cap do not depend on it any more, 7/11). An experiment must
 * never turn itself on by an error.
 *
 * ── READ ONCE IN A WHILE, NOT ONCE PER PRESS ──
 *
 * The doors that ask it (the pull, the queue, «طلباتي», the contact line, the five-minute job) are the busiest in the
 * system, so the answer is kept for `SWITCH_CACHE_MS` per company in this process, and a save replaces it at once. A
 * second process (the job runner) hears a change within that time.
 * ═══════════════════════════════════════════════════════════════════════
 */

export const ROUNDS_SETTINGS_KEY = 'noAnswerRounds';
export const SWITCH_CACHE_MS = 10_000;

interface Stored {
  enabled: boolean;
  enabledAt: string | null;
}

const cache = new Map<string, { value: RoundsSwitch; at: number }>();

/** A stored value as this build understands it — anything but a plain «on, since a valid date» is off. */
export function parseRoundsSwitch(raw: unknown): RoundsSwitch {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (o.enabled !== true || typeof o.enabledAt !== 'string') return ROUNDS_OFF;
  const when = new Date(o.enabledAt);
  return Number.isNaN(when.getTime()) ? ROUNDS_OFF : { enabled: true, enabledAt: when };
}

/** The switch for this company — cached, and OFF on any failure. */
export async function roundsSwitch(client: Client, companyId: string, nowMs: number = Date.now()): Promise<RoundsSwitch> {
  const hit = cache.get(companyId);
  if (hit && nowMs - hit.at < SWITCH_CACHE_MS) return hit.value;
  let value: RoundsSwitch = ROUNDS_OFF;
  try {
    const company = await client.company.findUnique({ where: { id: companyId }, select: { settings: true } });
    value = parseRoundsSwitch((company?.settings ? JSON.parse(company.settings) : {})[ROUNDS_SETTINGS_KEY]);
  } catch {
    value = ROUNDS_OFF;
  }
  cache.set(companyId, { value, at: nowMs });
  return value;
}

/** Forget what was read — a save does it, and so may a test. */
export function forgetRoundsSwitch(companyId?: string): void {
  if (companyId) cache.delete(companyId);
  else cache.clear();
}

/**
 * Turn it on or off. On stores the moment («enabledAt»); turning it on while it is already on keeps the first moment, so a
 * second press does not restart the clock. Off clears it: the next time it goes on is a new start.
 */
export async function saveRoundsSwitch(companyId: string, enabled: boolean, now: Date = new Date()): Promise<RoundsSwitch> {
  const stored = await updateCompanySettings<Stored>(companyId, ROUNDS_SETTINGS_KEY, (current) => {
    const was = parseRoundsSwitch(current);
    if (!enabled) return { enabled: false, enabledAt: null };
    return { enabled: true, enabledAt: (was.enabled && was.enabledAt ? was.enabledAt : now).toISOString() };
  });
  const value = parseRoundsSwitch(stored);
  cache.set(companyId, { value, at: Date.now() });
  return value;
}
