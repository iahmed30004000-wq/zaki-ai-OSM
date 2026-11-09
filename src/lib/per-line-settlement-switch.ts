import type { Prisma } from '@prisma/client';
import { updateCompanySettings } from './company-settings';
import type { db } from './db';

type Client = Prisma.TransactionClient | typeof db;

/**
 * ═══════════════════════════════════════════════════════════════════════
 * WHERE THE «تسوية السطور النظيفة عند الاعتماد» SWITCH LIVES: `Company.settings.perLineSettlement`.
 *
 * «طلبات بتاخد أسبوع تفسير» (the owner, 9/11). Today a statement's orders are settled only when its matching CLOSES, and the
 * matching closes only when no line is a question — so one line that needs a week of explanation holds every order of the
 * statement, although the money (one wallet IN per receipt) arrived at the approval and never waits on a line. With this switch ON,
 * the approval also settles every CLEAN line at once (`settleCleanLines` in `statement-close.ts`) and a line still a question holds
 * only its own order. The money does not change by a fils — only WHEN the clean orders are settled.
 *
 * It is the twin of `no-answer-returns-switch.ts`, line for line: no column and no migration for the switch, stored as
 * `{ enabled, enabledAt }` under a row lock (`updateCompanySettings`), cached for a few seconds per company in this process, and a
 * save replaces the cache at once.
 *
 * ── OFF UNLESS IT IS PLAINLY ON ──
 *
 * A missing key, a broken document, a stored value that is not a real `true` with a real date, and a read that FAILS are all OFF.
 * An experiment on the settlement of orders must never turn itself on by an error — and OFF is every rule exactly as it is today.
 *
 * ── THE SWITCH DECIDES ONLY WHETHER THE EARLY STEP RUNS ──
 *
 * What a row carries once it is settled early (`SettlementMatch.appliedAt`) is data, not a setting: the close skips it and every
 * door leaves it alone whatever this switch says now. Turning the switch off later never strands an early-settled order.
 * ═══════════════════════════════════════════════════════════════════════
 */

export const PER_LINE_SETTINGS_KEY = 'perLineSettlement';
/** The same few seconds the other switches keep their answer — written here too, so this file reads nothing from those. */
export const PER_LINE_SWITCH_CACHE_MS = 10_000;

export interface PerLineSwitch {
  enabled: boolean;
  /** When it went on (the SERVER's clock); null while it is off. */
  enabledAt: Date | null;
}

export const PER_LINE_OFF: PerLineSwitch = { enabled: false, enabledAt: null };

interface Stored {
  enabled: boolean;
  enabledAt: string | null;
}

const cache = new Map<string, { value: PerLineSwitch; at: number }>();

/** A stored value as this build understands it — anything but a plain «on, since a valid date» is off. */
export function parsePerLineSwitch(raw: unknown): PerLineSwitch {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (o.enabled !== true || typeof o.enabledAt !== 'string') return PER_LINE_OFF;
  const when = new Date(o.enabledAt);
  return Number.isNaN(when.getTime()) ? PER_LINE_OFF : { enabled: true, enabledAt: when };
}

/** The switch for this company — cached, and OFF on any failure. */
export async function perLineSettlementSwitch(client: Client, companyId: string, nowMs: number = Date.now()): Promise<PerLineSwitch> {
  const hit = cache.get(companyId);
  if (hit && nowMs - hit.at < PER_LINE_SWITCH_CACHE_MS) return hit.value;
  let value: PerLineSwitch = PER_LINE_OFF;
  try {
    const company = await client.company.findUnique({ where: { id: companyId }, select: { settings: true } });
    value = parsePerLineSwitch((company?.settings ? JSON.parse(company.settings) : {})[PER_LINE_SETTINGS_KEY]);
  } catch {
    value = PER_LINE_OFF;
  }
  cache.set(companyId, { value, at: nowMs });
  return value;
}

/** Is the early step on for this company? The one question the doors ask. */
export async function perLineSettlementOn(client: Client, companyId: string): Promise<boolean> {
  return (await perLineSettlementSwitch(client, companyId)).enabled;
}

/** Forget what was read — a save does it, and so may a test. */
export function forgetPerLineSwitch(companyId?: string): void {
  if (companyId) cache.delete(companyId);
  else cache.clear();
}

/**
 * Turn it on or off. On stores the moment («enabledAt»); turning it on while it is already on keeps the first moment, so a
 * second press does not restart the clock. Off clears it: the next time it goes on is a new start.
 */
export async function savePerLineSwitch(companyId: string, enabled: boolean, now: Date = new Date()): Promise<PerLineSwitch> {
  const stored = await updateCompanySettings<Stored>(companyId, PER_LINE_SETTINGS_KEY, (current) => {
    const was = parsePerLineSwitch(current);
    if (!enabled) return { enabled: false, enabledAt: null };
    return { enabled: true, enabledAt: (was.enabled && was.enabledAt ? was.enabledAt : now).toISOString() };
  });
  const value = parsePerLineSwitch(stored);
  cache.set(companyId, { value, at: Date.now() });
  return value;
}
