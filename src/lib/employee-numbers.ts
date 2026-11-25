import type { Prisma } from '@prisma/client';
import type { db } from './db';
import type { ConfirmationRuleNumbers } from './confirmation-rule-settings';
import { PULL_PACE, ruleFor, type ConfirmationRuleRow, type RulePerson, type RuleSource, type Sourced } from './confirmation-rules';

type Client = Prisma.TransactionClient | typeof db;

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «أرقام الموظفة» ACT — HER HAND LIMIT, HER IDLE MINUTES AND HER PULL PACE FROM THE OWNER'S RULES (request Q4b of the rules plan, 21/11).
 *
 * `confirmation-rules.ts` says, for one person at one moment, which number is in force and which rule it came from (`ruleFor`, pure). This file is its reader: the
 * active rows of a company, read through a thirty-second cache (the pull is hot — on a warm cache no statement at all), and the three EMPLOYEE numbers of one person.
 *
 * ── WHERE THEY ACT, AND WHERE THEY DO NOT ──
 * A rule changes a number of the BASE rule for some people, so it acts exactly where that base number acts, and nowhere else:
 *   · the hand and the idle minutes — where `returnsLimits` reads the base rule's (the plan «جدول المحاولات» on, or «أولوية الطابور»). With both off the hand is the
 *     cap of 500 and the idle release is `RETURNS_MODE`'s, as on main, whatever a rule says;
 *   · the pace — everywhere the pull asks it (`pullPaceRefusal`), always on, as on main.
 *
 * ── ZERO ROWS = TODAY ──
 * No active row (or a read that fails, or a store with no rule that names her) answers the base numbers with the source «base», and `ruleFor` is not even asked.
 * `employee-numbers-act.test.ts` holds it against `git show osm/main` and the goldens.
 *
 * ── A CLOCK THAT CANNOT BE READ ──
 * A rule with hours is placed in the store's timezone. A timezone the runtime cannot read (`ruleFor` throws `RangeError`), or none known, skips the rules WITH hours —
 * never the request: a rule that cannot say whether it is in force does not act.
 *
 * NOTHING HERE WRITES, TOUCHES MONEY, ORDER CREATION OR A CONTRACT.
 * ═══════════════════════════════════════════════════════════════════════
 */

const CACHE_MS = 30_000;
/** More rows than any company writes by hand; a read is bounded all the same. */
const MAX_ROWS = 500;
const cache = new Map<string, { rows: readonly ConfirmationRuleRow[]; at: number }>();
/** The last rows this process read whole, per company — what a failed read answers instead. */
const lastGood = new Map<string, readonly ConfirmationRuleRow[]>();
const NONE: readonly ConfirmationRuleRow[] = Object.freeze([]);

/** The company's ACTIVE rules (every kind), cached thirty seconds. A read that throws answers the last good rows, else none. */
export async function readConfirmationRules(client: Client, companyId: string, nowMs: number = Date.now()): Promise<readonly ConfirmationRuleRow[]> {
  const hit = cache.get(companyId);
  if (hit && nowMs - hit.at >= 0 && nowMs - hit.at < CACHE_MS) return hit.rows;
  let rows: readonly ConfirmationRuleRow[];
  try {
    const read = await client.confirmationRule.findMany({
      where: { companyId, isActive: true },
      orderBy: { createdAt: 'asc' },
      take: MAX_ROWS,
      select: {
        id: true, companyId: true, storeId: true, name: true, kind: true, userIds: true, productId: true, channelKind: true, phase: true,
        hoursFrom: true, hoursTo: true, effectiveFrom: true, effectiveTo: true, isActive: true, payload: true, createdAt: true,
      },
    });
    rows = read.length ? Object.freeze(read as ConfirmationRuleRow[]) : NONE;
    lastGood.set(companyId, rows);
  } catch {
    rows = lastGood.get(companyId) ?? NONE;
  }
  cache.set(companyId, { rows, at: nowMs });
  return rows;
}

/**
 * THE SAVE DOOR FORGETS THE CACHE (request Q4c, 21/11): a rule created, stopped, renamed or re-dated on the rules page acts in THIS process at the next read, not
 * thirty seconds later. Another instance of the server still answers from its own cache for up to thirty seconds — the window is stated on the screen's door.
 */
export function forgetConfirmationRules(companyId: string): void {
  cache.delete(companyId);
}

/** The rules, asked lazily and at most ONCE for one request or one pass of a job — the same shape as `confirmationRuleOnce`. */
export type RulesNow = () => Promise<readonly ConfirmationRuleRow[]>;

export function confirmationRulesOnce(client: Client, companyId: string, nowMs: number = Date.now()): RulesNow {
  let read: Promise<readonly ConfirmationRuleRow[]> | null = null;
  return () => (read ??= readConfirmationRules(client, companyId, nowMs));
}

/** One person's three numbers, each with the rule it came from. */
export interface EmployeeNumbers {
  hand: Sourced<number>;
  idleMinutes: Sourced<number>;
  pullPerHour: Sourced<number>;
}

const BASE: RuleSource = Object.freeze({ from: 'BASE' }) as RuleSource;

/** The rows that can change an employee number — the only ones this file resolves. */
const employeeRows = (rows: readonly ConfirmationRuleRow[], companyId: string) => rows.filter((r) => r.kind === 'EMPLOYEE_NUMBERS' && r.companyId === companyId);

/**
 * PURE: `person`'s numbers at `now` over `base`. No employee row → the base numbers and «base», without asking the resolver. A timezone that cannot be read (or none)
 * leaves out the rules with hours (see the header).
 */
export function employeeNumbersOf(
  ask: { person: RulePerson; now: Date },
  ctx: { companyId: string; base: ConfirmationRuleNumbers; timezone: string | null | undefined; rules: readonly ConfirmationRuleRow[] }
): EmployeeNumbers {
  const rows = employeeRows(ctx.rules, ctx.companyId);
  if (rows.length === 0) {
    return {
      hand: { value: ctx.base.hand, source: BASE },
      idleMinutes: { value: ctx.base.idleMinutes, source: BASE },
      pullPerHour: { value: PULL_PACE.perHour, source: BASE },
    };
  }
  const resolve = (timezone: string, list: readonly ConfirmationRuleRow[]) => ruleFor(ask, { companyId: ctx.companyId, base: ctx.base, timezone, rules: list });
  let eff;
  try {
    if (!ctx.timezone) throw new RangeError('no timezone');
    eff = resolve(ctx.timezone, rows);
  } catch {
    eff = resolve('UTC', rows.filter((r) => r.hoursFrom === null && r.hoursTo === null));
  }
  return { hand: eff.hand, idleMinutes: eff.idleMinutes, pullPerHour: eff.pullPerHour };
}

/** Whom the owner's rules name in this company (any active employee row) — the idle release asks each of them by her own minutes. */
export function namedByRules(rules: readonly ConfirmationRuleRow[], companyId: string): string[] {
  const named = new Set<string>();
  for (const r of employeeRows(rules, companyId)) {
    if (Array.isArray(r.userIds)) for (const u of r.userIds) if (typeof u === 'string' && u.trim()) named.add(u);
  }
  return [...named].sort();
}

/** Nobody: no rule can name the empty id (`peopleOf` refuses it), so asking for it answers what a person no rule names gets. */
export const NOBODY_NAMED = '';

/** The store's timezone, read only when a rule with hours needs it and the caller did not know it. A failed read is «unknown» (rules with hours do not act). */
async function storeTimezone(client: Client, storeId: string): Promise<string | null> {
  try {
    const store = await client.store.findUnique({ where: { id: storeId }, select: { country: { select: { timezone: true } } } });
    return store?.country?.timezone ?? null;
  } catch {
    return null;
  }
}

/** Who asks for her own numbers: her id, the store she works in, its timezone when the caller knows it, and the rules when the caller already holds their reader. */
export interface HerAsk {
  userId: string;
  storeId: string;
  timezone?: string | null;
  rules?: RulesNow;
}

/**
 * HER NUMBERS over `base` at `nowMs` — reads the rules (cached; once per request through `her.rules`), and the store's timezone only when an employee rule with hours
 * exists and the caller did not hand one in.
 */
export async function employeeNumbers(client: Client, companyId: string, nowMs: number, base: ConfirmationRuleNumbers, her: HerAsk): Promise<EmployeeNumbers> {
  const rules = await (her.rules ?? confirmationRulesOnce(client, companyId, nowMs))();
  const rows = employeeRows(rules, companyId);
  const needsClock = rows.some((r) => r.hoursFrom !== null);
  const timezone = her.timezone ?? (needsClock ? await storeTimezone(client, her.storeId) : null);
  return employeeNumbersOf({ person: { id: her.userId, storeId: her.storeId }, now: new Date(nowMs) }, { companyId, base, timezone, rules });
}

/**
 * Her pace (pulls in any rolling hour): the base `PULL_PACE.perHour` unless a rule names a different one. The pace is not a number of the base rule, so the base rule is
 * not read for it — with no employee row nothing but the (cached) rules is asked.
 */
export async function pullPaceOf(client: Client, companyId: string, nowMs: number, her: HerAsk, base: () => Promise<ConfirmationRuleNumbers>): Promise<Sourced<number>> {
  const rules = await (her.rules ?? confirmationRulesOnce(client, companyId, nowMs))();
  if (employeeRows(rules, companyId).length === 0) return { value: PULL_PACE.perHour, source: BASE };
  return (await employeeNumbers(client, companyId, nowMs, await base(), { ...her, rules: async () => rules })).pullPerHour;
}

/** Where a number came from, as the screens say it. */
export function sourceWords(source: RuleSource): string {
  return source.from === 'BASE' ? 'من القاعدة الأساسية' : `من قاعدة «${source.name}»`;
}

/** The three numbers as the queue door and «افحص موظفة» answer them: each value with its source and the source in Arabic. */
export function numbersAnswer(n: EmployeeNumbers) {
  const one = (s: Sourced<number>) => ({ value: s.value, source: s.source, from: sourceWords(s.source) });
  return { hand: one(n.hand), idleMinutes: one(n.idleMinutes), pullPerHour: one(n.pullPerHour) };
}
