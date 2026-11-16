import type { Prisma } from '@prisma/client';
import { updateCompanySettings } from './company-settings';
import type { db } from './db';

type Client = Prisma.TransactionClient | typeof db;

/**
 * ═══════════════════════════════════════════════════════════════════════
 * WHERE THE «فلتر الاستقبال» SWITCH LIVES: `Company.settings.intakeFilter` (Confirmation Center v2, step C).
 *
 * Its OWN key, not the one of «إثبات المكالمات وجدول المحاولات» (`callProofAndCadence`): that switch's card says «ما في واتساب تلقائي», counts «what was recorded
 * before it went on» from its own moment, and turning it off re-arms the old three-line close — tying the intake filter to it would tie one's rollback to the other's.
 *
 * The twin of `call-proof-switch.ts`, line for line: no column and no migration, stored as `{ enabled, enabledAt }` under a row lock (`updateCompanySettings`), cached
 * a few seconds per company in this process, a save replaces the cache at once.
 *
 * ── OFF UNLESS IT IS PLAINLY ON ──
 *
 * A missing key, a broken document, a value that is not a real `true` with a real date, and a read that FAILS are all OFF — and OFF is every rule exactly as it is
 * today. A filter that touches what an agent is shown must never turn itself on by an error.
 *
 * `enabledAt` floors what the filter looks at: an order that arrived before the owner turned it on is never flagged retroactively.
 * ═══════════════════════════════════════════════════════════════════════
 */

export const INTAKE_FILTER_SETTINGS_KEY = 'intakeFilter';
/** The same few seconds the other switches keep their answer. */
export const INTAKE_FILTER_SWITCH_CACHE_MS = 10_000;

export interface IntakeFilterSwitch {
  enabled: boolean;
  /** When it went on (the SERVER's clock); null while it is off. */
  enabledAt: Date | null;
}

export const INTAKE_FILTER_OFF: IntakeFilterSwitch = { enabled: false, enabledAt: null };

interface Stored {
  enabled: boolean;
  enabledAt: string | null;
}

const cache = new Map<string, { value: IntakeFilterSwitch; at: number }>();

/** A stored value as this build understands it — anything but a plain «on, since a valid date» is off. */
export function parseIntakeFilterSwitch(raw: unknown): IntakeFilterSwitch {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (o.enabled !== true || typeof o.enabledAt !== 'string') return INTAKE_FILTER_OFF;
  const when = new Date(o.enabledAt);
  return Number.isNaN(when.getTime()) ? INTAKE_FILTER_OFF : { enabled: true, enabledAt: when };
}

/** The switch for this company — cached, and OFF on any failure. */
export async function intakeFilterSwitch(client: Client, companyId: string, nowMs: number = Date.now()): Promise<IntakeFilterSwitch> {
  const hit = cache.get(companyId);
  if (hit && nowMs - hit.at < INTAKE_FILTER_SWITCH_CACHE_MS) return hit.value;
  let value: IntakeFilterSwitch = INTAKE_FILTER_OFF;
  try {
    const company = await client.company.findUnique({ where: { id: companyId }, select: { settings: true } });
    value = parseIntakeFilterSwitch((company?.settings ? JSON.parse(company.settings) : {})[INTAKE_FILTER_SETTINGS_KEY]);
  } catch {
    value = INTAKE_FILTER_OFF;
  }
  cache.set(companyId, { value, at: nowMs });
  return value;
}

/** Forget what was read — a save does it, and so may a test. */
export function forgetIntakeFilterSwitch(companyId?: string): void {
  if (companyId) cache.delete(companyId);
  else cache.clear();
}

/**
 * Turn it on or off. On stores the moment («enabledAt»); turning it on while it is already on keeps the first moment, so a second press does not restart the
 * clock. Off clears it: the next time it goes on is a new start.
 */
export async function saveIntakeFilterSwitch(companyId: string, enabled: boolean, now: Date = new Date()): Promise<IntakeFilterSwitch> {
  const stored = await updateCompanySettings<Stored>(companyId, INTAKE_FILTER_SETTINGS_KEY, (current) => {
    const was = parseIntakeFilterSwitch(current);
    if (!enabled) return { enabled: false, enabledAt: null };
    return { enabled: true, enabledAt: (was.enabled && was.enabledAt ? was.enabledAt : now).toISOString() };
  });
  const value = parseIntakeFilterSwitch(stored);
  cache.set(companyId, { value, at: Date.now() });
  return value;
}
