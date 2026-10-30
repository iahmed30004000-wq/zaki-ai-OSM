import { readSystemSetting, updateSystemSetting } from './system-settings';
import {
  addUsage,
  CAP_MESSAGE_AR,
  capReached,
  hasCap,
  usageAt,
  type CapPeriod,
  type SpendCap,
  type UsageDoc,
} from './ai-spend-core';

/*
 * THE PART OF THE CEILING THAT TOUCHES THE DATABASE AND THE RESPONSE.
 * The arithmetic, the sentences and the limits live in `ai-spend-core.ts`,
 * which a screen may import without pulling the server in with it. This
 * file re-exports them so a server caller needs only one name.
 */
export * from './ai-spend-core';

/**
 * THE CEILING WAS REACHED — thrown BEFORE any request leaves, so a company
 * that is over its line spends nothing more. It carries the sentence, so
 * every door can say the same thing.
 */
export class AiCapReached extends Error {
  readonly messageAr: string;
  constructor(readonly period: CapPeriod) {
    super('AI_CAP_REACHED');
    this.messageAr = CAP_MESSAGE_AR[period];
  }
}

/** The answer a door gives when the ceiling stopped it: 429, in Arabic, never a 500. */
export function capReachedResponse(e: unknown): Response | null {
  if (!(e instanceof AiCapReached)) return null;
  return Response.json(
    { error: e.messageAr, errorAr: e.messageAr, code: 'AI_CAP_REACHED', period: e.period },
    { status: 429 }
  );
}

// ── the meter ───────────────────────────────────────────────────────────

const usageKey = (companyId: string) => `ai-usage:${companyId}`;

/** Today's and this month's totals, for the settings screen. */
export async function readUsage(companyId: string, now = new Date()): Promise<UsageDoc> {
  try {
    return usageAt(await readSystemSetting<UsageDoc>(usageKey(companyId)), now);
  } catch {
    return usageAt(undefined, now);
  }
}

/**
 * Refuse the call when the company is over its ceiling.
 *
 * Reads nothing at all when no ceiling is set. A meter that cannot be read
 * lets the call through: see the note at the top of the file.
 */
export async function assertUnderCap(companyId: string, cap: SpendCap | undefined, now = new Date()): Promise<void> {
  if (!hasCap(cap)) return;
  let usage: UsageDoc;
  try {
    usage = usageAt(await readSystemSetting<UsageDoc>(usageKey(companyId)), now);
  } catch (e) {
    console.warn('AI usage meter unreadable, call allowed:', e instanceof Error ? e.name : 'unknown');
    return;
  }
  const period = capReached(cap, usage);
  if (period) throw new AiCapReached(period);
}

/**
 * Add what a call used. Never throws: a meter that fails must not take down
 * the answer that was already paid for.
 */
export async function recordUsage(companyId: string, tokens: number, now = new Date()): Promise<void> {
  if (!(tokens >= 1)) return;
  try {
    await updateSystemSetting<UsageDoc>(usageKey(companyId), (current) => addUsage(current, tokens, now));
  } catch (e) {
    console.warn('AI usage not recorded:', e instanceof Error ? e.name : 'unknown');
  }
}
