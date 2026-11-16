import type { Prisma } from '@prisma/client';
import { updateCompanySettings } from '../company-settings';
import type { db } from '../db';

type Client = Prisma.TransactionClient | typeof db;

/**
 * ═══════════════════════════════════════════════════════════════════════
 * WHERE THE «ليدز الصفحات» SWITCH LIVES: `Company.settings.leadsV2` (Confirmation Center v2, step E).
 *
 * Its OWN key — not the call-proof one, not the intake filter's, not the queue's, not the winback's: it decides whether the signed webhook from the pages system (`pages.zakiai.io`) KEEPS the
 * leads it is sent. Off, the webhook answers «received» and keeps nothing — the pages system does not retry, and nothing is stored about a person who has not ordered.
 *
 * The twin of `intake-filter-switch.ts`, line for line: no column and no migration, stored as `{ enabled, enabledAt }` under a row lock (`updateCompanySettings`), cached
 * a few seconds per company in this process, a save replaces the cache at once.
 *
 * ── OFF UNLESS IT IS PLAINLY ON ──
 *
 * A missing key, a broken document, a value that is not a real `true` with a real date, and a read that FAILS are all OFF.
 * ═══════════════════════════════════════════════════════════════════════
 */

export const LEADS_V2_SETTINGS_KEY = 'leadsV2';
/** The same few seconds the other switches keep their answer. */
export const LEADS_V2_SWITCH_CACHE_MS = 10_000;

export interface LeadsV2Switch {
  enabled: boolean;
  /** When it went on (the SERVER's clock); null while it is off. */
  enabledAt: Date | null;
}

export const LEADS_V2_OFF: LeadsV2Switch = { enabled: false, enabledAt: null };

interface Stored {
  enabled: boolean;
  enabledAt: string | null;
}

const cache = new Map<string, { value: LeadsV2Switch; at: number }>();

/** A stored value as this build understands it — anything but a plain «on, since a valid date» is off. */
export function parseLeadsV2Switch(raw: unknown): LeadsV2Switch {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (o.enabled !== true || typeof o.enabledAt !== 'string') return LEADS_V2_OFF;
  const when = new Date(o.enabledAt);
  return Number.isNaN(when.getTime()) ? LEADS_V2_OFF : { enabled: true, enabledAt: when };
}

/** The switch for this company — cached, and OFF on any failure. */
export async function leadsV2Switch(client: Client, companyId: string, nowMs: number = Date.now()): Promise<LeadsV2Switch> {
  const hit = cache.get(companyId);
  if (hit && nowMs - hit.at < LEADS_V2_SWITCH_CACHE_MS) return hit.value;
  let value: LeadsV2Switch = LEADS_V2_OFF;
  try {
    const company = await client.company.findUnique({ where: { id: companyId }, select: { settings: true } });
    value = parseLeadsV2Switch((company?.settings ? JSON.parse(company.settings) : {})[LEADS_V2_SETTINGS_KEY]);
  } catch {
    value = LEADS_V2_OFF;
  }
  cache.set(companyId, { value, at: nowMs });
  return value;
}

/** Forget what was read — a save does it, and so may a test. */
export function forgetLeadsV2Switch(companyId?: string): void {
  if (companyId) cache.delete(companyId);
  else cache.clear();
}

/**
 * Turn it on or off. On stores the moment («enabledAt»); turning it on while it is already on keeps the first moment, so a second press does not restart the
 * clock. Off clears it: the next time it goes on is a new start.
 */
export async function saveLeadsV2Switch(companyId: string, enabled: boolean, now: Date = new Date()): Promise<LeadsV2Switch> {
  const stored = await updateCompanySettings<Stored>(companyId, LEADS_V2_SETTINGS_KEY, (current) => {
    const was = parseLeadsV2Switch(current);
    if (!enabled) return { enabled: false, enabledAt: null };
    return { enabled: true, enabledAt: (was.enabled && was.enabledAt ? was.enabledAt : now).toISOString() };
  });
  const value = parseLeadsV2Switch(stored);
  cache.set(companyId, { value, at: Date.now() });
  return value;
}
