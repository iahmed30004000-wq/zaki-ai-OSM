import type { Prisma } from '@prisma/client';
import { callProofSwitch } from './call-proof-switch';
import type { db } from './db';

type Client = Prisma.TransactionClient | typeof db;

/**
 * ═══════════════════════════════════════════════════════════════════════
 * STEP B's READER of the one switch step A already owns (`call-proof-switch.ts`, `Company.settings.callProofAndCadence`).
 *
 * It answers «since when is the five-attempt cadence on?» — the moment the owner turned the switch on (`enabledAt`), or `null`. That moment is the FLOOR of every count
 * (`no-answer-cadence.ts`): a «لا يرد» line logged at or before it never counts and never holds an order, so turning the switch on moves nothing retroactively.
 *
 * ── OFF UNLESS IT IS PLAINLY ON, AND ON EVERY FAILURE ──
 *
 * The access to `callProofSwitch` is INSIDE the try on purpose:
 *   · a route test that mocks `@/lib/call-proof-switch` with only `callProofOn` (three step-A tests do) has no `callProofSwitch` export, and vitest throws on the access of a
 *     missing mock export — the catch turns that into «off», so those tests stay what they were (`the-cadence-switch-reads-a-mock-without-the-export.test.ts` pins that);
 *   · a database client with no `company` falls through `callProofSwitch`'s own catch to «off».
 *
 * It asks `callProofSwitch`, not `callProofOn`, so it never moves the proof's read counters, and it keeps no cache of its own: `callProofSwitch` already caches ten seconds
 * per company, so asking both in one request is ONE read.
 *
 * ⚠️ A read that FAILS is cached as «off» for those ten seconds (BACKLOG RV2387) — the owner's rule is «off on any failure», shared by the rounds and returns switches.
 * ═══════════════════════════════════════════════════════════════════════
 */
export async function cadenceSince(client: Client, companyId: string): Promise<Date | null> {
  try {
    const sw = await callProofSwitch(client, companyId);
    return sw.enabled && sw.enabledAt instanceof Date && !Number.isNaN(sw.enabledAt.getTime()) ? sw.enabledAt : null;
  } catch {
    return null;
  }
}
