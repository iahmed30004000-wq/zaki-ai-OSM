import type { Prisma } from '@prisma/client';
import { CONFIRMATION_RULE_DEFAULT } from './confirmation-rule-settings';
import { ruleFor, type ConfirmationRuleRow, type OrderPhase } from './confirmation-rules';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «هالطلبات أول» ACTS — THE OWNER'S PRIORITY RULES INSIDE THE PULL'S TIERS (request Q5a of the rules plan, 21/11).
 *
 * A PRIORITY rule (`confirmation-rules.ts`, kind `PRIORITY`, payload `{ first: true }`) names some orders — by store, product, channel, phase (new / retry) and
 * hours — and says «these first». This file turns the rules IN FORCE at one moment, for one store, into filters on orders (`priorityBoostOf`). The pull's
 * v2 pick (`pickByPriority` in `confirmation-queue.ts`) asks each of its tiers first with that filter added, then as before.
 *
 * ── WHERE IT ACTS, AND WHERE IT DOES NOT ──
 *   · ONLY inside the tiers of the v2 pick (the «أولوية الطابور» key on, ordinary hours): a fresh new order · an aged retry · the backlog's turn (a retry, then a
 *     postponed order due) · the oldest new order. A boosted order goes first INSIDE its tier and never jumps a tier: a boosted retry never passes a fresh new
 *     order, and the owner's «الجديد أول» (7/11) still holds across tiers.
 *   · NEVER above what is held for her (asked before the v2 pick) nor above the customer's promise: the promise tier is not boosted — its order is the customer's
 *     date, not ours to reorder.
 *   · NOT in the two time-of-day modes (their plain base order is left as it is), and not in the old order (the key off) — there is no tier to rank inside.
 *
 * ── THE PHASE ──
 * An order nobody has rung yet is NEW; one rung at least once is a RETRY — the very line `laneOfOrder` draws (an attempt on the order = the backlog's lane).
 *
 * ── THE SAME ANSWER AS THE RESOLVER ──
 * Whether a rule is valid, in force (dates, `isActive`, hours in the store's clock) and about this store is asked of `ruleFor` itself, with the rule alone and an
 * order made of the rule's own conditions — so the filter cannot disagree with the resolver. `priority-rules.test.ts` holds it: for random rules and
 * orders, «matches the filter» ≡ `ruleFor(...).first.value`.
 *
 * ── ZERO RULES = TODAY ──
 * No PRIORITY rule in force for the store (or one whose filter is «every order of the phase», which reorders nothing) answers null: the plan carries no `boost`
 * and the pick is main's, statement for statement. The rules are the pull's one cached read (`confirmationRulesOnce`): on a warm cache, no statement.
 *
 * A clock that cannot be read (an unknown timezone) leaves out the rules WITH hours, never the pull — as `employee-numbers.ts` does.
 *
 * NOTHING HERE READS THE DATABASE, WRITES, TOUCHES MONEY, ORDER CREATION OR A CONTRACT. The desk («طلباتي») never imports it.
 * ═══════════════════════════════════════════════════════════════════════
 */

type Where = Prisma.OrderWhereInput;

/**
 * The boosted orders of each tier's kind: a filter, or absent when it would reorder nothing (no rule names a part of it, or the rules name all of it).
 *   NEW    — the fresh tier and the oldest-new tier (never-rung orders only);
 *   RETRY  — the aged-retry tier and the backlog's retry (rung orders only);
 *   ANY    — the postponed tier, which holds orders of both phases.
 */
export interface PriorityBoost {
  NEW?: Where;
  RETRY?: Where;
  ANY?: Where;
}

/** The phase of an order as a filter: nobody has rung it yet, or somebody has. */
export const PHASE_WHERE: Record<OrderPhase, Where> = {
  NEW: { contactAttempts: { none: {} } },
  RETRY: { contactAttempts: { some: {} } },
};

const PHASES: readonly OrderPhase[] = ['NEW', 'RETRY'];

/** The orders a rule names inside its store and phase: its product and its channel (both, when it names both). null = every order of the phase. */
function conditionOf(row: ConfirmationRuleRow): Where | null {
  const parts: Where[] = [];
  if (row.productId !== null) parts.push({ items: { some: { productId: row.productId } } });
  if (row.channelKind !== null) parts.push({ channel: { is: { kind: row.channelKind } } });
  if (parts.length === 0) return null;
  return parts.length === 1 ? parts[0] : { AND: parts };
}

/** Is `row` a valid PRIORITY rule, in force at `now`, about `storeId`, for `phase`? Asked of the resolver itself (see the header). */
function acts(row: ConfirmationRuleRow, ctx: { companyId: string; storeId: string; now: Date; timezone: string }, phase: OrderPhase): boolean {
  const order = { storeId: row.storeId ?? ctx.storeId, productIds: row.productId ? [row.productId] : [], channelKind: row.channelKind, phase };
  if (order.storeId !== ctx.storeId) return false;
  // `ruleFor` needs a person only for EMPLOYEE rules; none is asked here.
  return ruleFor({ person: { id: '', storeId: ctx.storeId }, order, now: ctx.now }, { companyId: ctx.companyId, base: CONFIRMATION_RULE_DEFAULT, timezone: ctx.timezone, rules: [row] }).first.value;
}

/** What the rules in force say of one phase: nothing, all of it, or some of it. */
type PhaseBoost = 'NONE' | 'ALL' | Where;

/**
 * THE BOOST of one store at `now`: for each kind of tier, the filter of the orders the rules in force put first — or null when nothing would be reordered (no rule
 * acts, or every rule that acts names every order). Pure.
 */
export function priorityBoostOf(
  rules: readonly ConfirmationRuleRow[],
  ctx: { companyId: string; storeId: string; now: Date; timezone: string | null | undefined }
): PriorityBoost | null {
  const rows = rules.filter((r) => r.kind === 'PRIORITY' && r.companyId === ctx.companyId && (r.storeId === null || r.storeId === ctx.storeId));
  if (rows.length === 0) return null;
  const of = {} as Record<OrderPhase, PhaseBoost>;
  for (const phase of PHASES) {
    const parts: Where[] = [];
    let whole = false;
    for (const row of rows) {
      if (row.phase !== null && row.phase !== phase) continue;
      let on: boolean;
      try {
        if (!ctx.timezone) throw new RangeError('no timezone');
        on = acts(row, { companyId: ctx.companyId, storeId: ctx.storeId, now: ctx.now, timezone: ctx.timezone }, phase);
      } catch {
        // A clock that cannot be read: a rule with hours cannot say whether it is in force, so it does not act; one without hours is asked in any zone.
        on = row.hoursFrom === null && row.hoursTo === null && acts(row, { companyId: ctx.companyId, storeId: ctx.storeId, now: ctx.now, timezone: 'UTC' }, phase);
      }
      if (!on) continue;
      const cond = conditionOf(row);
      if (cond === null) whole = true;
      else parts.push(cond);
    }
    of[phase] = whole ? 'ALL' : parts.length === 0 ? 'NONE' : parts.length === 1 ? parts[0] : { OR: parts };
  }
  const boost: PriorityBoost = {};
  for (const phase of PHASES) {
    const b = of[phase];
    if (b !== 'NONE' && b !== 'ALL') boost[phase] = b;
  }
  // The postponed tier: each phase's boosted orders under their phase. All of both, or none of either, reorders nothing.
  if (!(of.NEW === 'ALL' && of.RETRY === 'ALL')) {
    const any = PHASES.flatMap((phase): Where[] => {
      const b = of[phase];
      return b === 'NONE' ? [] : b === 'ALL' ? [PHASE_WHERE[phase]] : [{ AND: [PHASE_WHERE[phase], b] }];
    });
    if (any.length > 0) boost.ANY = any.length === 1 ? any[0] : { OR: any };
  }
  return boost.NEW || boost.RETRY || boost.ANY ? boost : null;
}
