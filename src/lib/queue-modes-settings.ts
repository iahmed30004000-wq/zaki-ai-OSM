import type { Prisma } from '@prisma/client';
import { updateCompanySettings } from './company-settings';
import type { db } from './db';
import { QUEUE_MODES } from './queue-priority';

type Client = Prisma.TransactionClient | typeof db;

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE TWO TIME-OF-DAY MODES' HOURS (Confirmation Center v2, step D2): `Company.settings.queueModes` — editable by the owner, defaults = the study's (09–11 night orders first, 21–24 new first).
 *
 * Whole hours of the store's local day, `to` exclusive (24 = midnight). A document is valid only if both ranges are non-empty and do not overlap. It only matters while «أولوية الطابور»
 * is on: with the key off the pull never asks for it. No switch and no migration; anything that is not exactly a valid document is the defaults, and a SAVE refuses an invalid one.
 * ═══════════════════════════════════════════════════════════════════════
 */

export const QUEUE_MODES_SETTINGS_KEY = 'queueModes';

export interface QueueModesConfig {
  nightFrom: number;
  nightTo: number;
  peakFrom: number;
  peakTo: number;
}

export const QUEUE_MODES_DEFAULTS: QueueModesConfig = Object.freeze({
  nightFrom: QUEUE_MODES.nightFirst.from / 60,
  nightTo: QUEUE_MODES.nightFirst.to / 60,
  peakFrom: QUEUE_MODES.peakNewFirst.from / 60,
  peakTo: QUEUE_MODES.peakNewFirst.to / 60,
}) as QueueModesConfig;

const FIELDS = ['nightFrom', 'nightTo', 'peakFrom', 'peakTo'] as const;
const hour = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 24;

export type Validation = { ok: true; config: QueueModesConfig } | { ok: false; error: string };

export function validateQueueModes(input: unknown): Validation {
  const o = (input && typeof input === 'object' ? input : null) as Record<string, unknown> | null;
  if (!o || Object.keys(o).some((k) => !(FIELDS as readonly string[]).includes(k)) || !FIELDS.every((k) => hour(o[k]))) {
    return { ok: false, error: 'الساعات لازم تكون أرقام صحيحة من 0 لـ24: بداية ونهاية وضع الصبح، وبداية ونهاية وضع الذروة.' };
  }
  const c = o as unknown as QueueModesConfig;
  if (c.nightFrom >= c.nightTo || c.peakFrom >= c.peakTo) return { ok: false, error: 'بداية كل وضع لازم تكون قبل نهايتو.' };
  if (c.nightFrom < c.peakTo && c.peakFrom < c.nightTo) return { ok: false, error: 'وضع الصبح ووضع الذروة ما بيتداخلوا.' };
  return { ok: true, config: { nightFrom: c.nightFrom, nightTo: c.nightTo, peakFrom: c.peakFrom, peakTo: c.peakTo } };
}

export function parseQueueModes(raw: unknown): QueueModesConfig {
  const checked = validateQueueModes(raw);
  return checked.ok ? checked.config : QUEUE_MODES_DEFAULTS;
}

/** The ranges `queueModeAt` takes, in local minutes. */
export function modesInMinutes(c: QueueModesConfig): { nightFirst: { from: number; to: number }; peakNewFirst: { from: number; to: number } } {
  return { nightFirst: { from: c.nightFrom * 60, to: c.nightTo * 60 }, peakNewFirst: { from: c.peakFrom * 60, to: c.peakTo * 60 } };
}

const CACHE_MS = 30_000;
const cache = new Map<string, { value: QueueModesConfig; at: number }>();

/** The settings of this company — cached half a minute (a pull asks every time), the defaults on any failure. */
export async function readQueueModes(client: Client, companyId: string, nowMs: number = Date.now()): Promise<QueueModesConfig> {
  const hit = cache.get(companyId);
  if (hit && nowMs - hit.at < CACHE_MS) return hit.value;
  let value = QUEUE_MODES_DEFAULTS;
  try {
    const company = await client.company.findUnique({ where: { id: companyId }, select: { settings: true } });
    value = parseQueueModes((company?.settings ? JSON.parse(company.settings) : {})[QUEUE_MODES_SETTINGS_KEY]);
  } catch {
    value = QUEUE_MODES_DEFAULTS;
  }
  cache.set(companyId, { value, at: nowMs });
  return value;
}

/** Store a VALID document (the caller validated it) under its own key, under the row lock; the next pull sees it at once. */
export async function saveQueueModes(companyId: string, config: QueueModesConfig): Promise<QueueModesConfig> {
  const stored = await updateCompanySettings<QueueModesConfig>(companyId, QUEUE_MODES_SETTINGS_KEY, () => config);
  const value = parseQueueModes(stored);
  cache.set(companyId, { value, at: Date.now() });
  return value;
}
