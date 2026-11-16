import type { Prisma } from '@prisma/client';
import { updateCompanySettings } from './company-settings';
import type { db } from './db';

type Client = Prisma.TransactionClient | typeof db;

/**
 * ═══════════════════════════════════════════════════════════════════════
 * WHERE THE «الاسترجاع اليومي» SWITCH LIVES: `Company.settings.winbackV2` (Confirmation Center v2, step F).
 *
 * Its OWN key — not the call-proof one (`callProofAndCadence`), not the intake filter's and not the queue's: it adds a daily list of lost orders to call 24–72 hours after the outcome,
 * with an assignee and a tracked result, to the «ملغاة سابقاً» tab. The existing winback (its rule, its list, its offer) is untouched and works the same with this off.
 *
 * The twin of `intake-filter-switch.ts`, line for line: no column and no migration, stored as `{ enabled, enabledAt }` under a row lock (`updateCompanySettings`), cached
 * a few seconds per company in this process, a save replaces the cache at once.
 *
 * ── OFF UNLESS IT IS PLAINLY ON ──
 *
 * A missing key, a broken document, a value that is not a real `true` with a real date, and a read that FAILS are all OFF — and OFF is the follow-up screen exactly as it is today.
 * ═══════════════════════════════════════════════════════════════════════
 */

export const WINBACK_V2_SETTINGS_KEY = 'winbackV2';
/** The same few seconds the other switches keep their answer. */
export const WINBACK_V2_SWITCH_CACHE_MS = 10_000;

export interface WinbackV2Switch {
  enabled: boolean;
  /** When it went on (the SERVER's clock); null while it is off. */
  enabledAt: Date | null;
}

export const WINBACK_V2_OFF: WinbackV2Switch = { enabled: false, enabledAt: null };

interface Stored {
  enabled: boolean;
  enabledAt: string | null;
}

const cache = new Map<string, { value: WinbackV2Switch; at: number }>();

/** A stored value as this build understands it — anything but a plain «on, since a valid date» is off. */
export function parseWinbackV2Switch(raw: unknown): WinbackV2Switch {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (o.enabled !== true || typeof o.enabledAt !== 'string') return WINBACK_V2_OFF;
  const when = new Date(o.enabledAt);
  return Number.isNaN(when.getTime()) ? WINBACK_V2_OFF : { enabled: true, enabledAt: when };
}

/** The switch for this company — cached, and OFF on any failure. */
export async function winbackV2Switch(client: Client, companyId: string, nowMs: number = Date.now()): Promise<WinbackV2Switch> {
  const hit = cache.get(companyId);
  if (hit && nowMs - hit.at < WINBACK_V2_SWITCH_CACHE_MS) return hit.value;
  let value: WinbackV2Switch = WINBACK_V2_OFF;
  try {
    const company = await client.company.findUnique({ where: { id: companyId }, select: { settings: true } });
    value = parseWinbackV2Switch((company?.settings ? JSON.parse(company.settings) : {})[WINBACK_V2_SETTINGS_KEY]);
  } catch {
    value = WINBACK_V2_OFF;
  }
  cache.set(companyId, { value, at: nowMs });
  return value;
}

/** Forget what was read — a save does it, and so may a test. */
export function forgetWinbackV2Switch(companyId?: string): void {
  if (companyId) cache.delete(companyId);
  else cache.clear();
}

/**
 * Turn it on or off. On stores the moment («enabledAt»); turning it on while it is already on keeps the first moment, so a second press does not restart the
 * clock. Off clears it: the next time it goes on is a new start.
 */
export async function saveWinbackV2Switch(companyId: string, enabled: boolean, now: Date = new Date()): Promise<WinbackV2Switch> {
  const stored = await updateCompanySettings<Stored>(companyId, WINBACK_V2_SETTINGS_KEY, (current) => {
    const was = parseWinbackV2Switch(current);
    if (!enabled) return { enabled: false, enabledAt: null };
    return { enabled: true, enabledAt: (was.enabled && was.enabledAt ? was.enabledAt : now).toISOString() };
  });
  const value = parseWinbackV2Switch(stored);
  cache.set(companyId, { value, at: Date.now() });
  return value;
}
