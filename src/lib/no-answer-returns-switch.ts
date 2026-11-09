import type { Prisma } from '@prisma/client';
import { updateCompanySettings } from './company-settings';
import type { db } from './db';
import { RETURNS_OFF, type ReturnsSwitch } from './no-answer-returns';

type Client = Prisma.TransactionClient | typeof db;

/**
 * ═══════════════════════════════════════════════════════════════════════
 * WHERE THE «الطلب يرجع للطابور فوراً» SWITCH LIVES: `Company.settings.noAnswerReturns`.
 *
 * The twin of «نظام الجولات»' switch (`no-answer-rounds-switch.ts`), line for line: no column and no migration, stored as
 * `{ enabled, enabledAt }` under a row lock (`updateCompanySettings`), cached for a few seconds per company in this process, and a
 * save replaces the cache at once.
 *
 * ── OFF UNLESS IT IS PLAINLY ON ──
 *
 * A missing key, a broken document, a stored value that is not a real `true` with a real date, and a read that FAILS are all OFF.
 * An experiment must never turn itself on by an error.
 *
 * ── AND IT NEEDS «نظام الجولات» (`returnsModeOn` in `confirmation-queue.ts`) ──
 *
 * The close is the rounds' counting, so this switch alone does nothing: the mode is on when BOTH are plainly on. What is stored here
 * is only the owner's wish; the two doors that ask «is the mode on?» ask both.
 * ═══════════════════════════════════════════════════════════════════════
 */

export const RETURNS_SETTINGS_KEY = 'noAnswerReturns';
/** The same few seconds the rounds' switch keeps its answer — written here too, so this file reads nothing from that one. */
export const RETURNS_SWITCH_CACHE_MS = 10_000;

interface Stored {
  enabled: boolean;
  enabledAt: string | null;
}

const cache = new Map<string, { value: ReturnsSwitch; at: number }>();

/** A stored value as this build understands it — anything but a plain «on, since a valid date» is off. */
export function parseReturnsSwitch(raw: unknown): ReturnsSwitch {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (o.enabled !== true || typeof o.enabledAt !== 'string') return RETURNS_OFF;
  const when = new Date(o.enabledAt);
  return Number.isNaN(when.getTime()) ? RETURNS_OFF : { enabled: true, enabledAt: when };
}

/** The switch for this company — cached, and OFF on any failure. */
export async function returnsSwitch(client: Client, companyId: string, nowMs: number = Date.now()): Promise<ReturnsSwitch> {
  const hit = cache.get(companyId);
  if (hit && nowMs - hit.at < RETURNS_SWITCH_CACHE_MS) return hit.value;
  let value: ReturnsSwitch = RETURNS_OFF;
  try {
    const company = await client.company.findUnique({ where: { id: companyId }, select: { settings: true } });
    value = parseReturnsSwitch((company?.settings ? JSON.parse(company.settings) : {})[RETURNS_SETTINGS_KEY]);
  } catch {
    value = RETURNS_OFF;
  }
  cache.set(companyId, { value, at: nowMs });
  return value;
}

/** Forget what was read — a save does it, and so may a test. */
export function forgetReturnsSwitch(companyId?: string): void {
  if (companyId) cache.delete(companyId);
  else cache.clear();
}

/**
 * Turn it on or off. On stores the moment («enabledAt»); turning it on while it is already on keeps the first moment, so a
 * second press does not restart the clock. Off clears it: the next time it goes on is a new start.
 */
export async function saveReturnsSwitch(companyId: string, enabled: boolean, now: Date = new Date()): Promise<ReturnsSwitch> {
  const stored = await updateCompanySettings<Stored>(companyId, RETURNS_SETTINGS_KEY, (current) => {
    const was = parseReturnsSwitch(current);
    if (!enabled) return { enabled: false, enabledAt: null };
    return { enabled: true, enabledAt: (was.enabled && was.enabledAt ? was.enabledAt : now).toISOString() };
  });
  const value = parseReturnsSwitch(stored);
  cache.set(companyId, { value, at: Date.now() });
  return value;
}
