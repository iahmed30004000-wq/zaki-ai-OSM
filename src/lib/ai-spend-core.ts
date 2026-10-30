
/**
 * A DAILY AND A MONTHLY CEILING ON WHAT THE ASSISTANTS MAY USE.
 *
 * `ai-rate.ts` stops a loop — ten calls a minute. It does not stop a slow
 * leak: a company pressing «ابنيلي صفحة الهبوط» all day, with a picture each
 * time, never meets a per-minute limit and still empties the provider's
 * account by the end of the month. The unit a provider bills in is the
 * TOKEN, so that is what is counted and what the owner caps.
 *
 * ── WHERE THE NUMBERS LIVE (no migration) ──
 *
 *   the ceiling   Company.settings.ai.spendCap      — beside the rest of the
 *                 assistants' settings, saved by the same locked write.
 *   the usage     SystemSetting «ai-usage:<company>» — one small document:
 *                 today's total and this month's total. NOT the question, NOT
 *                 the answer, NOT a name: a number is all that is kept.
 *
 * ── THE DEFAULTS CHANGE NOBODY'S BEHAVIOUR ──
 *
 * No ceiling stored means no ceiling: the check does not even read the usage.
 * A local model (the owner's own machine) costs nothing, so it is neither
 * counted nor stopped.
 *
 * ── THE LIMITS, SAID PLAINLY ──
 *
 * The check is made before the call and the count is added after it, so two
 * calls in flight at the same moment can both pass and the day can end a
 * little over the line — by the size of the calls in flight, never by a
 * loop. A ceiling is a cost control, not a security boundary, so a meter
 * that cannot be read lets the call through (and says so in the log) rather
 * than switching the assistants off because a table was missing.
 *
 * The day and the month are counted in UTC: one clock for every installation,
 * and a rule the owner can check against the provider's own invoice.
 */

export interface SpendCap {
  /** Tokens per day, or null for «no ceiling». */
  dailyTokens: number | null;
  /** Tokens per month, or null for «no ceiling». */
  monthlyTokens: number | null;
}

export const NO_CAP: SpendCap = { dailyTokens: null, monthlyTokens: null };

/** A ceiling above this is a typo, not a decision. */
export const MAX_CAP_TOKENS = 1_000_000_000;

export interface UsageDoc {
  /** `YYYY-MM-DD` (UTC) the day total belongs to. */
  day: string;
  dayTokens: number;
  /** `YYYY-MM` (UTC) the month total belongs to. */
  month: string;
  monthTokens: number;
}

function wholeNumber(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/** One side of a ceiling as stored: a positive whole number, or «none». */
function oneSide(v: unknown): number | null {
  const n = wholeNumber(v);
  return n > 0 ? Math.min(n, MAX_CAP_TOKENS) : null;
}

/** Whatever was stored, read as a ceiling. Anything unreadable is «no ceiling». */
export function sanitizeCap(raw: unknown): SpendCap {
  if (!raw || typeof raw !== 'object') return { ...NO_CAP };
  const r = raw as Record<string, unknown>;
  return { dailyTokens: oneSide(r.dailyTokens), monthlyTokens: oneSide(r.monthlyTokens) };
}

export function hasCap(cap: SpendCap | undefined): cap is SpendCap {
  return !!cap && (cap.dailyTokens != null || cap.monthlyTokens != null);
}

export const dayKey = (now: Date): string => now.toISOString().slice(0, 10);
export const monthKey = (now: Date): string => now.toISOString().slice(0, 7);

/** What was used «now»: a total from yesterday is today's zero. */
export function usageAt(doc: Partial<UsageDoc> | undefined, now: Date): UsageDoc {
  const day = dayKey(now);
  const month = monthKey(now);
  return {
    day,
    month,
    dayTokens: doc?.day === day ? wholeNumber(doc.dayTokens) : 0,
    monthTokens: doc?.month === month ? wholeNumber(doc.monthTokens) : 0,
  };
}

export function addUsage(doc: Partial<UsageDoc> | undefined, tokens: number, now: Date): UsageDoc {
  const base = usageAt(doc, now);
  const add = wholeNumber(tokens);
  return { ...base, dayTokens: base.dayTokens + add, monthTokens: base.monthTokens + add };
}

export type CapPeriod = 'DAY' | 'MONTH';

/**
 * Which ceiling has been reached, if any. The month is named first: when
 * both are reached it is the one that lasts longest, and «يعود غداً» would
 * be a lie.
 */
export function capReached(cap: SpendCap | undefined, usage: UsageDoc): CapPeriod | null {
  if (!cap) return null;
  if (cap.monthlyTokens != null && usage.monthTokens >= cap.monthlyTokens) return 'MONTH';
  if (cap.dailyTokens != null && usage.dayTokens >= cap.dailyTokens) return 'DAY';
  return null;
}

export const CAP_MESSAGE_AR: Record<CapPeriod, string> = {
  DAY: 'وصل المساعد إلى السقف اليومي للاستعمال. يعود غداً، أو يرفع المسؤول السقف من إعدادات الذكاء.',
  MONTH: 'وصل المساعد إلى السقف الشهري للاستعمال. يعود مع بداية الشهر، أو يرفع المسؤول السقف من إعدادات الذكاء.',
};


// ── counting ────────────────────────────────────────────────────────────

/** Arabic runs shorter per token than English; three characters is the safe side. */
const CHARS_PER_TOKEN = 3;
/** What a picture costs when the vendor does not say. */
const IMAGE_TOKENS = 1600;

export function estimateTokens(chars: number, images = 0): number {
  const text = Math.ceil(Math.max(0, chars) / CHARS_PER_TOKEN);
  return text + Math.max(0, images) * IMAGE_TOKENS;
}

function reportedCount(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
}

/**
 * WHAT THE CALL USED: the vendor's own count when the reply carries one,
 * otherwise an estimate from the length of what went in and what came out.
 * Only lengths are passed — the words themselves never reach this file.
 */
export function tokensUsed(
  reply: unknown,
  shape: 'anthropic' | 'openai',
  lengths: { inChars: number; images: number; outChars: number }
): number {
  const usage = (reply as { usage?: Record<string, unknown> } | null | undefined)?.usage;
  const input = reportedCount(shape === 'anthropic' ? usage?.input_tokens : usage?.prompt_tokens);
  const output = reportedCount(shape === 'anthropic' ? usage?.output_tokens : usage?.completion_tokens);
  const total = reportedCount(usage?.total_tokens);
  if (input != null && output != null && input + output > 0) return input + output;
  if (shape === 'openai' && total != null && total > 0) return total;
  return estimateTokens(lengths.inChars, lengths.images) + estimateTokens(lengths.outChars);
}
