import type { Prisma } from '@prisma/client';
import type { BusinessCalendar } from './business-calendar';
import { CONFIRMATION_RULE_DEFAULT } from './confirmation-rule-settings';
import {
  ROUTING_FALLBACK,
  better,
  ruleFor,
  validateConfirmationRuleRow,
  type ConfirmationRuleRow,
  type OrderPhase,
  type ValidRule,
} from './confirmation-rules';
import type { RulesNow } from './employee-numbers';
import { workClock } from './no-answer-rounds';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «هالطلبات بس لهالموظفات» ACTS — WHO MAY PULL AN ORDER, FROM THE OWNER'S ROUTING RULES (request Q5b of the rules plan, 21/11).
 *
 * A ROUTING rule (`confirmation-rules.ts`, kind `ROUTING`, payload `{ toUserIds, fallbackMinutes? }`) names some orders — by store, product, channel, phase (new /
 * retry) and hours — and says «only these people take them». This file turns the rules IN FORCE at one moment, for one store, into ONE filter on orders for ONE
 * puller (`routingWhereFor`). The pull (`pullNextOrder`) reads it before its transaction and `pickNextCandidate` ANDs it into every query of the pick.
 *
 * ── WHICH RULE GOVERNS AN ORDER ──
 * The resolver's own: of the rules in force that match the order, the most specific wins (`better`, exported by `confirmation-rules.ts` — never a second copy).
 * So an order is pullable by her iff no rule matches it, or the FIRST matching rule (in that rank) lets her: she is named, or — when none of its people can pull —
 * the order is `fallbackMinutes` working minutes old. Written as «no rule matches, or rule i matches and no rule above it matches and rule i lets her».
 * The product is matched both ways, exactly as `order-numbers.ts` reads an order (`ruleOrderOf`): any current line of the product, or the header product of an order
 * with no line rows. Every negation is written out positively (no `NOT` over a nullable column or a to-one relation, which drops the null rows).
 *
 * ── NO ORDER NOBODY MAY TAKE ──
 * «Can pull» = ACTIVE, reaches the store, and the pull tool of `deskReadiness` answered by the real engine (`computeEffectiveGrants` → `can`) — `routing-staff.ts`,
 * cached thirty seconds. A rule none of whose people can pull (all stopped, deactivated, moved, a key taken away) holds its orders for `fallbackMinutes` WORKING minutes
 * from their creation (the store's calendar; a calendar with no working time counts wall-clock minutes, so the wait still ends), then everyone may take them. A roster
 * that cannot be read counts as «nobody can pull»: the wait, then everyone. `routing-rules-never-strand-an-order.test.ts` holds it over random rules and rosters.
 * The supervisor's board counts these orders under «طلبات بلا موظفة» (`routing-health.ts`).
 *
 * ── WHERE IT ACTS, AND WHERE IT DOES NOT ──
 *   · the pull's pick, every tier and both orders (v2 and the old one), the customer's promise included — a promise of an order given to others is theirs;
 *   · NOT what is held for her (`pickHeldForHer`): a returning customer's twins follow the agent he spoke to («one customer, one agent» comes first);
 *   · NOT the claim by number: an agent bound by «اسحبي الطلب أول» is sent to the pull there anyway, and the holders of the exempting keys (supervisors) take any
 *     order by its number, as today;
 *   · NOT «الزبون على الخط» (`callback-take`): the customer is on the line — today's rule, the hand limit only;
 *   · NOT the counters: the queue door's numbers stay the whole pool's (a pull that finds nothing for her says so in its sentence).
 *
 * ── ZERO RULES = TODAY ──
 * No ROUTING rule in force for the store, or every one in force names her: null — no filter, the pick's statements are main's, and no roster is read. The rules are the
 * pull's one cached read (`confirmationRulesOnce`): on a warm cache, no statement; the roster too is cached.
 *
 * A clock that cannot be read (an unknown timezone) leaves out the rules WITH hours, never the pull — as `priority-rules.ts` does. Anything else that fails answers
 * null: the pull of today, which strands nobody.
 *
 * NOTHING HERE WRITES, TOUCHES MONEY, ORDER CREATION OR A CONTRACT. The desk («طلباتي») never imports it.
 * ═══════════════════════════════════════════════════════════════════════
 */

type Where = Prisma.OrderWhereInput;
/** A condition on orders: always, never, or a filter. */
type Cond = true | false | Where;

const and = (...cs: Cond[]): Cond => {
  if (cs.includes(false)) return false;
  const parts = cs.filter((c): c is Where => c !== true);
  return parts.length === 0 ? true : parts.length === 1 ? parts[0] : { AND: parts };
};
const or = (...cs: Cond[]): Cond => {
  if (cs.includes(true)) return true;
  const parts = cs.filter((c): c is Where => c !== false);
  return parts.length === 0 ? false : parts.length === 1 ? parts[0] : { OR: parts };
};

/** A ROUTING rule in force for one store, ranked: its people, its wait, and its orders as a filter and as the filter of the rest. */
export interface RoutingRuleInForce {
  id: string;
  toUserIds: readonly string[];
  fallbackMinutes: number;
  /** The orders it names. */
  match: Cond;
  /** Every order it does not name — written positively. */
  notMatch: Cond;
}

const PHASE: Record<OrderPhase, { is: Where; isNot: Where }> = {
  NEW: { is: { contactAttempts: { none: {} } }, isNot: { contactAttempts: { some: {} } } },
  RETRY: { is: { contactAttempts: { some: {} } }, isNot: { contactAttempts: { none: {} } } },
};

/** The order is «of» the product: a current line of it, or — with no line rows — its header product (`ruleOrderOf`). */
const productIs = (p: string): Where => ({ OR: [{ items: { some: { productId: p } } }, { AND: [{ items: { none: {} } }, { productId: p }] }] });
const productIsNot = (p: string): Where => ({ AND: [{ items: { none: { productId: p } } }, { OR: [{ items: { some: {} } }, { productId: { not: p } }] }] });
/** The channel's kind; an order with no channel is of no kind (`channel?.kind ?? null`). */
const channelIs = (k: string): Where => ({ channel: { is: { kind: k } } });
const channelIsNot = (k: string): Where => ({ OR: [{ channelId: null }, { channel: { is: { kind: { not: k } } } }] });

function conditionsOf(r: ValidRule): { match: Cond; notMatch: Cond } {
  return {
    match: and(r.productId ? productIs(r.productId) : true, r.channelKind ? channelIs(r.channelKind) : true, r.phase ? PHASE[r.phase].is : true),
    notMatch: or(r.productId ? productIsNot(r.productId) : false, r.channelKind ? channelIsNot(r.channelKind) : false, r.phase ? PHASE[r.phase].isNot : false),
  };
}

/** Is `row` in force at `now` for `storeId`? Asked of the resolver itself, with the rule alone and an order made of its own conditions (as `priority-rules.ts`). */
function acts(row: ConfirmationRuleRow, ctx: { companyId: string; storeId: string; now: Date; timezone: string }): boolean {
  const order = { storeId: ctx.storeId, productIds: row.productId ? [row.productId] : [], channelKind: row.channelKind, phase: row.phase as OrderPhase | null };
  const eff = ruleFor({ person: { id: '', storeId: ctx.storeId }, order, now: ctx.now }, { companyId: ctx.companyId, base: CONFIRMATION_RULE_DEFAULT, timezone: ctx.timezone, rules: [row] });
  return eff.onlyFor.source.from === 'RULE';
}

/** THE ROUTING RULES IN FORCE for one store at `now`, most specific first (the resolver's rank). Pure. Empty = routing does not act. */
export function routingRulesInForce(
  rules: readonly ConfirmationRuleRow[],
  ctx: { companyId: string; storeId: string; now: Date; timezone: string | null | undefined }
): RoutingRuleInForce[] {
  const live: ValidRule[] = [];
  for (const row of rules) {
    if (row.kind !== 'ROUTING' || row.companyId !== ctx.companyId || (row.storeId !== null && row.storeId !== ctx.storeId)) continue;
    const checked = validateConfirmationRuleRow(row);
    if (!checked.ok) continue;
    let on: boolean;
    try {
      if (!ctx.timezone) throw new RangeError('no timezone');
      on = acts(row, { companyId: ctx.companyId, storeId: ctx.storeId, now: ctx.now, timezone: ctx.timezone });
    } catch {
      // A clock that cannot be read: a rule with hours cannot say whether it is in force, so it does not act; one without hours is asked in any zone.
      on = row.hoursFrom === null && row.hoursTo === null && acts(row, { companyId: ctx.companyId, storeId: ctx.storeId, now: ctx.now, timezone: 'UTC' });
    }
    if (on) live.push(checked.rule);
  }
  live.sort((a, b) => (a.id === b.id ? 0 : better(a, b) === a ? -1 : 1));
  return live.map((r) => ({
    id: r.id,
    toUserIds: r.payload.toUserIds ?? [],
    fallbackMinutes: r.payload.fallbackMinutes ?? ROUTING_FALLBACK.defaultMinutes,
    ...conditionsOf(r),
  }));
}

/** A rule some of whose people can pull now. `staff` null = the roster could not be read: nobody counts. */
export function isStaffed(rule: Pick<RoutingRuleInForce, 'toUserIds'>, staff: ReadonlySet<string> | null): boolean {
  return !!staff && rule.toUserIds.some((u) => staff.has(u));
}

/**
 * The instant before which an order is `minutes` WORKING minutes old, in the store's calendar. A calendar with no working time at all (the clock answers before 1970)
 * or a clock that cannot be read counts wall-clock minutes: the wait always ends.
 */
export function fallbackCut(now: Date, cal: BusinessCalendar | null | undefined): (minutes: number) => Date {
  let clock: ReturnType<typeof workClock> | null = null;
  try {
    clock = cal ? workClock(cal) : null;
  } catch {
    clock = null;
  }
  const memo = new Map<number, Date>();
  return (minutes) => {
    const hit = memo.get(minutes);
    if (hit) return hit;
    const wall = new Date(now.getTime() - minutes * 60_000);
    let at = wall;
    try {
      const back = clock?.back(now, minutes);
      if (back && Number.isFinite(back.getTime()) && back.getTime() >= 0 && back.getTime() <= now.getTime()) at = back;
    } catch {
      at = wall;
    }
    memo.set(minutes, at);
    return at;
  };
}

/** Never anything: the filter of a puller every rule in force keeps out. */
const NOTHING: Where = { id: { in: [] } };

/**
 * THE PULLER'S FILTER. Pure. null = she may take every order the pick offers (no rule in force, or every one names her) — the pick is main's, byte for byte.
 * `staff` is asked only of rules that do not name her.
 */
export function routingWhereFor(
  inForce: readonly RoutingRuleInForce[],
  ctx: { userId: string; staff: ReadonlySet<string> | null; cutOf: (minutes: number) => Date }
): Where | null {
  // No rule in force, or every one names her: nothing is kept from her (the general form below would say the same, as a longer filter).
  if (inForce.length === 0 || !routingNeedsStaff(inForce, ctx.userId)) return null;
  const lets = (r: RoutingRuleInForce): Cond =>
    r.toUserIds.includes(ctx.userId) ? true : isStaffed(r, ctx.staff) ? false : { createdAt: { lte: ctx.cutOf(r.fallbackMinutes) } };
  const eligible = or(
    and(...inForce.map((r) => r.notMatch)),
    ...inForce.map((r, i) => and(r.match, lets(r), ...inForce.slice(0, i).map((above) => above.notMatch)))
  );
  if (eligible === true) return null;
  if (eligible === false) return NOTHING;
  return eligible;
}

/** Does any rule in force leave her out (so the roster is worth reading)? */
export function routingNeedsStaff(inForce: readonly RoutingRuleInForce[], userId: string): boolean {
  return inForce.some((r) => !r.toUserIds.includes(userId));
}

/**
 * «طلبات بلا موظفة»: the orders whose governing rule has nobody who can pull them (waiting for their fallback, or past it). Pure. null = none can be (no such rule).
 */
export function unstaffedWhere(inForce: readonly RoutingRuleInForce[], staff: ReadonlySet<string> | null): Where | null {
  const c = or(...inForce.map((r, i) => (isStaffed(r, staff) ? false : and(r.match, ...inForce.slice(0, i).map((above) => above.notMatch)))));
  return c === false ? null : c === true ? {} : c;
}

/**
 * THE PULL'S QUESTION: the filter for this puller now, from the pull's one cached read of the rules and (only when a rule in force leaves her out) the cached roster.
 * Any failure answers null — today's pull, which leaves no order unreachable.
 */
export async function routingWhereForPuller(args: {
  scope: { companyId: string; storeId: string };
  userId: string;
  cal: BusinessCalendar;
  now: Date;
  rules: RulesNow;
}): Promise<Where | null> {
  try {
    const { scope, userId, cal, now } = args;
    const inForce = routingRulesInForce(await args.rules(), { companyId: scope.companyId, storeId: scope.storeId, now, timezone: cal.timezone });
    if (inForce.length === 0) return null;
    // Loaded only here: the roster reads people and their grants, which nothing else of the pull needs.
    const staff = routingNeedsStaff(inForce, userId) ? await (await import('./routing-staff')).readRoutingStaff(scope.companyId, scope.storeId, now.getTime()) : null;
    return routingWhereFor(inForce, { userId, staff, cutOf: fallbackCut(now, cal) });
  } catch {
    return null;
  }
}

/** The sentence of an empty pull when a routing rule kept some orders for colleagues (the code stays `QUEUE_EMPTY`). */
export const ROUTED_EMPTY_MESSAGE = 'لا توجد طلبات إلك الآن — في قاعدة توزيع بتخلّي بعض الطلبات لزميلات محدّدات.';
