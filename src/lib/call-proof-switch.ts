import type { Prisma } from '@prisma/client';
import { updateCompanySettings } from './company-settings';
import type { db } from './db';

type Client = Prisma.TransactionClient | typeof db;

/**
 * ═══════════════════════════════════════════════════════════════════════
 * WHERE THE «إثبات المكالمات وجدول المحاولات» SWITCH LIVES: `Company.settings.callProofAndCadence`.
 *
 * ONE switch for Confirmation Center v2's two halves about a call that reached nobody (the planner's ruling, 15/11/2026): step A, the PROOF — a «didn't answer» is
 * recorded only after a logged «اتصال» press at least thirty seconds old (`call-proof.ts`) — and, later, step B, the 5-attempt close and the two-day cadence. Named
 * for both, and not with the words «rounds» / «returns», which belong to other switches.
 *
 * It is the twin of `per-line-settlement-switch.ts`, line for line: no column and no migration for the switch, stored as `{ enabled, enabledAt }` under a row lock
 * (`updateCompanySettings`), cached for a few seconds per company in this process, and a save replaces the cache at once.
 *
 * ── OFF UNLESS IT IS PLAINLY ON ──
 *
 * A missing key, a broken document, a stored value that is not a real `true` with a real date, and a read that FAILS are all OFF — and OFF is every rule exactly as
 * it is today. An experiment on work an agent is paid on must never turn itself on by an error.
 *
 * ── `enabledAt` ──
 *
 * Kept (the first moment it went on; a second «on» does not restart it) because step B must floor its counts with it. Step A does not compare against it: the
 * proof only blocks a forward click and moves nothing retroactively, and a press made before the switch went on still counts.
 * ═══════════════════════════════════════════════════════════════════════
 */

export const CALL_PROOF_SETTINGS_KEY = 'callProofAndCadence';
/** The same few seconds the other switches keep their answer — written here too, so this file reads nothing from those. */
export const CALL_PROOF_SWITCH_CACHE_MS = 10_000;

export interface CallProofSwitch {
  enabled: boolean;
  /** When it went on (the SERVER's clock); null while it is off. */
  enabledAt: Date | null;
}

export const CALL_PROOF_OFF: CallProofSwitch = { enabled: false, enabledAt: null };

interface Stored {
  enabled: boolean;
  enabledAt: string | null;
}

/** `failed`: the read behind this value threw (request C2) — the value is still OFF, as ever; only `callProofReadFailed` asks the mark. */
const cache = new Map<string, { value: CallProofSwitch; at: number; failed?: true }>();

/** A stored value as this build understands it — anything but a plain «on, since a valid date» is off. */
export function parseCallProofSwitch(raw: unknown): CallProofSwitch {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (o.enabled !== true || typeof o.enabledAt !== 'string') return CALL_PROOF_OFF;
  const when = new Date(o.enabledAt);
  return Number.isNaN(when.getTime()) ? CALL_PROOF_OFF : { enabled: true, enabledAt: when };
}

/** The switch for this company — cached, and OFF on any failure. */
export async function callProofSwitch(client: Client, companyId: string, nowMs: number = Date.now()): Promise<CallProofSwitch> {
  const hit = cache.get(companyId);
  if (hit && nowMs - hit.at < CALL_PROOF_SWITCH_CACHE_MS) return hit.value;
  let value: CallProofSwitch = CALL_PROOF_OFF;
  let failed = false;
  try {
    // Request C2: only the QUERY failing is «unreadable» (`callProofReadFailed`) — a database that did not answer. A client with no company table (a test's fake) and a
    // settings document that does not parse are OFF and not «failed», exactly as before: those are not a moment's hiccup, and refusing every «لا يرد» over them would be worse.
    const company = client.company
      ? await client.company.findUnique({ where: { id: companyId }, select: { settings: true } }).catch((e: unknown) => {
          failed = true;
          throw e;
        })
      : null;
    value = parseCallProofSwitch((company?.settings ? JSON.parse(company.settings) : {})[CALL_PROOF_SETTINGS_KEY]);
  } catch {
    value = CALL_PROOF_OFF;
  }
  cache.set(companyId, failed ? { value, at: nowMs, failed: true } : { value, at: nowMs });
  return value;
}

/**
 * DID THE LAST READ OF THE SWITCH FAIL? (request C2, finding #23 of the rules map). A failed read is OFF for ten seconds — and OFF, at the no-answer door, is the old
 * «three closes» rule, so a database hiccup could close an order the plan would have kept. The door asks this AFTER `callProofOn` and refuses a «لا يرد» with 503 instead
 * of guessing. It reads the cache only (no query) and answers for the entry `callProofSwitch` just wrote; the cache, its ten seconds and the OFF value are unchanged.
 */
export function callProofReadFailed(companyId: string, nowMs: number = Date.now()): boolean {
  const hit = cache.get(companyId);
  return !!hit && hit.failed === true && nowMs - hit.at < CALL_PROOF_SWITCH_CACHE_MS;
}

/** Is the proof on for this company? The one question the doors ask. */
export async function callProofOn(client: Client, companyId: string): Promise<boolean> {
  return (await callProofSwitch(client, companyId)).enabled;
}

/** Forget what was read — a save does it, and so may a test. */
export function forgetCallProofSwitch(companyId?: string): void {
  if (companyId) cache.delete(companyId);
  else cache.clear();
}

/**
 * Turn it on or off. On stores the moment («enabledAt»); turning it on while it is already on keeps the first moment, so a second press does not restart the
 * clock. Off clears it: the next time it goes on is a new start.
 */
export async function saveCallProofSwitch(companyId: string, enabled: boolean, now: Date = new Date()): Promise<CallProofSwitch> {
  const stored = await updateCompanySettings<Stored>(companyId, CALL_PROOF_SETTINGS_KEY, (current) => {
    const was = parseCallProofSwitch(current);
    if (!enabled) return { enabled: false, enabledAt: null };
    return { enabled: true, enabledAt: (was.enabled && was.enabledAt ? was.enabledAt : now).toISOString() };
  });
  const value = parseCallProofSwitch(stored);
  cache.set(companyId, { value, at: Date.now() });
  return value;
}
