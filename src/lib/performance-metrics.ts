import type { Prisma } from '@prisma/client';
import { db } from './db';
import { measure, sampleSize } from './commission-metrics';
import { moderatorPerformance } from './attribution-performance';
import { teamPerformance, type EmployeeRow } from './team-performance';
import type { BusinessCalendar } from './business-calendar';
import { bandsForRole, scoreOf, type ScoreInput, type ScoreResult } from './performance-score';
import { REPORT_TTL_MS, heavyOnce } from './heavy-lane';

type Tx = Prisma.TransactionClient | typeof db;

/**
 * THE NUMBERS THE SCORE IS BUILT FROM — read from where they already live.
 *
 * Not one figure here is computed twice. The delivery rate comes from the
 * same `measure()` a commission rule is paid on, the response time from the
 * same `teamPerformance()` the team screen draws, the moderator's delivery
 * rate from the same `moderatorPerformance()` the attribution tables use. A
 * score that disagreed with the screen beside it would be worse than no
 * score: two numbers for one week, and an argument nobody can settle.
 *
 * Two readings did not exist anywhere and are written here: how often a
 * person's entries come back as an entry problem, and how heavily they
 * discount compared with the shop's own habit.
 *
 * This is deliberately a per-person loop over `measure()` rather than one
 * clever query. A report screen loaded a few times a day can afford the
 * round trips; a second set of definitions drifting from the first cannot
 * be afforded at all.
 */

export interface TeamScope {
  companyId: string;
  storeId: string;
  start: Date;
  /** Exclusive: the first moment AFTER the window. */
  end: Date;
  calendar: BusinessCalendar;
}

/**
 * THE QUESTION A TEAM SCOPE ASKS, AS ONE STRING — everything the answer depends on, so that two askers with the same string
 * may share one computation (`heavyOnce`, `lib/heavy-lane.ts`). The window's end is optional: it is «now», and a kept answer
 * is the moment of whoever asked first (`scoreRole` below).
 */
function teamQuestion(scope: TeamScope, withEnd: boolean): string {
  const cal = scope.calendar;
  return [
    scope.companyId,
    scope.storeId,
    scope.start.toISOString(),
    withEnd ? scope.end.toISOString() : '',
    `${cal.timezone}|${cal.workHoursStart}|${cal.workHoursEnd}|${[...(cal.weekendDays ?? [])].sort().join('.')}`,
  ].join('|');
}

/**
 * Who granted a discount.
 *
 * Whoever confirmed the order is who granted it; the moderator is the
 * fallback for an order that never reached a confirmation agent. Named once
 * here because the discount alerts screen answers the same question, and
 * two answers to it would put a habit on two different people's records.
 */
export function discountGrantedBy(order: {
  confirmedById: string | null;
  moderatorId: string | null;
}): string | null {
  return order.confirmedById ?? order.moderatorId;
}

export interface DiscountUse {
  /** Given away, over what the orders would have been without it. */
  share: number;
  discount: number;
  gross: number;
}

/**
 * How heavily each person discounts, and how heavily the shop does.
 *
 * Read over the orders they are accountable for in the window, not over the
 * discounted ones alone: an agent who discounted twice out of two hundred
 * orders and one who discounted twice out of four are not the same person,
 * and a denominator of "orders carrying a discount" makes them identical.
 *
 * The team figure is POOLED — all the money given away over all the money —
 * rather than an average of the individual shares, so one agent with four
 * orders cannot move the shop's own habit.
 */
export async function discountUse(
  tx: Tx,
  scope: TeamScope
): Promise<{ byUser: Map<string, DiscountUse>; team: DiscountUse }> {
  const orders = await tx.order.findMany({
    where: { companyId: scope.companyId, storeId: scope.storeId, createdAt: { gte: scope.start, lt: scope.end } },
    select: { discountAmount: true, totalAmount: true, confirmedById: true, moderatorId: true },
  });

  const byUser = new Map<string, DiscountUse>();
  let teamDiscount = 0;
  let teamGross = 0;

  for (const o of orders) {
    const by = discountGrantedBy(o);
    const discount = Number(o.discountAmount);
    // Against what the order would have been before the discount — the same
    // basis the discount alerts screen uses.
    const gross = Number(o.totalAmount) + discount;
    teamDiscount += discount;
    teamGross += gross;
    if (!by) continue;
    const row = byUser.get(by) ?? { share: 0, discount: 0, gross: 0 };
    row.discount += discount;
    row.gross += gross;
    byUser.set(by, row);
  }

  for (const row of byUser.values()) row.share = row.gross > 0 ? row.discount / row.gross : 0;

  return {
    byUser,
    team: { discount: teamDiscount, gross: teamGross, share: teamGross > 0 ? teamDiscount / teamGross : 0 },
  };
}

export interface IssuesUse {
  issues: number;
  orders: number;
  /** Null when they entered nothing — not zero, which would read as perfect. */
  rate: number | null;
}

/**
 * How often a moderator's entries come back as an entry problem.
 *
 * A VOIDED issue is one somebody raised and was wrong about. It is left out
 * entirely: counting it would mean an agent could damage a colleague's
 * record by raising issues that were then thrown out, which is the one way
 * to make an honest measurement into a weapon.
 *
 * The denominator is what they ENTERED in the window, so somebody who
 * entered nothing has no rate rather than a perfect one.
 */
export async function issuesRate(tx: Tx, scope: TeamScope): Promise<Map<string, IssuesUse>> {
  const orders = await tx.order.findMany({
    where: {
      companyId: scope.companyId,
      storeId: scope.storeId,
      createdAt: { gte: scope.start, lt: scope.end },
      moderatorId: { not: null },
    },
    select: { moderatorId: true, issues: { where: { status: { not: 'VOIDED' } }, select: { id: true } } },
  });

  const byUser = new Map<string, IssuesUse>();
  for (const o of orders) {
    const id = o.moderatorId!;
    const row = byUser.get(id) ?? { issues: 0, orders: 0, rate: null };
    row.orders++;
    row.issues += o.issues.length;
    byUser.set(id, row);
  }
  for (const row of byUser.values()) {
    row.rate = row.orders > 0 ? row.issues / row.orders : null;
  }
  return byUser;
}

export interface ScoredPerson {
  id: string;
  name: string;
  role: string;
  score: ScoreResult;
  /** Position within this role and store, best first. 1-based. */
  rank: number;
  /** How many people share the role, so a rank means something. */
  of: number;
}

/** The metric each role's volume and cross-sell bands are read from. */
const VOLUME_METRIC: Record<string, string> = {
  CONFIRMATION_AGENT: 'CONFIRMED_COUNT',
  CONFIRMATION_SUPERVISOR: 'CONFIRMED_COUNT',
  MODERATOR: 'SOURCED_COUNT',
};
const CROSS_SELL_METRIC: Record<string, string> = {
  CONFIRMATION_AGENT: 'CROSS_SELL_UNITS',
  CONFIRMATION_SUPERVISOR: 'CROSS_SELL_UNITS',
  MODERATOR: 'MULTI_UNIT_ORDERS',
};

/**
 * Everybody in one role, scored together — ONCE FOR EVERYBODY WHO ASKS IN THE SAME MINUTE.
 *
 * A person's card, the score board and the users list all score the WHOLE role (a volume means nothing without the role's
 * own numbers), and each used to do it for itself: somebody opening her profile recomputed the team for a month. Now the
 * first to ask computes it — in the reports' lane, on the reports' six connections — and whoever asks within `REPORT_TTL_MS`
 * reads that (`heavyOnce`, `lib/heavy-lane.ts`).
 *
 * The key is everything the answer depends on EXCEPT the window's end, which is «now»: a kept answer is the role's score as
 * of the moment the first of them asked, at most a minute ago. Who may read whose row is decided by each door BEFORE it calls
 * this, exactly as before; nothing here knows who is asking. The rows are shared between requests: READ them, never write
 * to them.
 */
export function scoreRole(
  scope: TeamScope,
  role: string,
  people: { id: string; name: string }[],
  minSample: number
): Promise<ScoredPerson[]> {
  const key = ['score-role', role, String(minSample), teamQuestion(scope, false), people.map((p) => p.id).sort().join(',')].join('|');
  return heavyOnce(key, REPORT_TTL_MS, () => scoreRoleFresh(scope, role, people, minSample));
}

/**
 * Everybody in one role, scored together.
 *
 * Together because a volume has no meaning on its own: twenty confirmed
 * orders is excellent in a slow week and poor in a busy one, and the only
 * honest reference is what the same role managed over the same days in the
 * same store. Which also means the rank comes out of the same pass, instead
 * of a second query that could disagree with the first.
 */
async function scoreRoleFresh(
  scope: TeamScope,
  role: string,
  people: { id: string; name: string }[],
  minSample: number
): Promise<ScoredPerson[]> {
  const bands = new Set(bandsForRole(role));
  if (people.length === 0 || bands.size === 0) return [];

  const [discounts, issues, moderators, team] = await Promise.all([
    discountUse(db, scope),
    bands.has('issues_rate') ? issuesRate(db, scope) : Promise.resolve(new Map<string, IssuesUse>()),
    role === 'MODERATOR'
      ? moderatorPerformance({ companyId: scope.companyId, storeId: scope.storeId, start: scope.start, end: scope.end })
      : Promise.resolve([]),
    // The two agent roles both carry this band and ask for the SAME table in the same request: the second joins the first (a
    // zero lifetime — shared only while it is being worked out, never kept), and it runs in the reports' lane.
    bands.has('response_time')
      ? heavyOnce(['team-perf', teamQuestion(scope, true)].join('|'), 0, () =>
          teamPerformance({ companyId: scope.companyId, storeId: scope.storeId, calendar: scope.calendar, start: scope.start, end: scope.end })
        )
      : Promise.resolve({ employees: [] as EmployeeRow[], totals: {} as never }),
  ]);

  const byModerator = new Map(moderators.map((m) => [m.id, m]));
  const byEmployee = new Map(team.employees.map((e) => [e.id, e]));

  // Raw numbers first, references second: the volume bands need the whole
  // role's numbers before any one person's can be turned into points.
  const raw = await Promise.all(
    people.map(async (p) => {
      const metricScope = { companyId: scope.companyId, storeId: scope.storeId, userId: p.id, start: scope.start, end: scope.end };
      const volume = await measure(db, VOLUME_METRIC[role] ?? 'CONFIRMED_COUNT', metricScope);
      const crossSell = bands.has('cross_sell')
        ? await measure(db, CROSS_SELL_METRIC[role] ?? 'CROSS_SELL_UNITS', metricScope)
        : { count: 0, amount: 0, orderIds: [] };

      // A moderator's delivery rate is delivered out of what they BROUGHT,
      // which the attribution tables already compute for the whole role.
      // An agent's is delivered out of what they CONFIRMED, which is what a
      // commission rule is paid on.
      //
      // BOTH BRANCHES ARE A FRACTION, AND A REAL 0 IS A REAL RATE.
      //
      // The band's arithmetic is `clamp(value, 0, 1) × weight` and the
      // owner's bar is stored 0..1, so a fraction is the only unit either
      // one can read. `measure()` hands the rate back as a WHOLE NUMBER —
      // `rateOf` multiplies by 100 — so this branch divides by 100 exactly
      // as the moderator branch beside it already did. Passing 50 for a 50%
      // agent clamped to 1: full marks for the heaviest band, «٥٠٠٠٪» on the
      // card, and never below a bar of 0.6 whatever they delivered.
      //
      // And «delivered none» is not «nobody measured them». `|| null` could
      // not tell those apart, so an agent who confirmed orders and had every
      // one of them come back read «لا يُقاس» — the band dropped out of the
      // total AND out of `possible`, which is the flattering direction: the
      // worst delivery rate in the building was scored out of 50 instead of
      // out of the 85 an agent's five bands come to.
      // The two are told apart by the DENOMINATOR instead, and `sampleSize`
      // is the same `everConfirmedBy` population the rate itself divides by.
      // Called rather than read off `volume` above: that one counts
      // `confirmationStatus: 'CONFIRMED'` only, which is a different set.
      const mod = byModerator.get(p.id);
      const everConfirmed = role === 'MODERATOR' ? 0 : await sampleSize(db, 'DELIVERY_RATE', metricScope);
      const deliveryRate =
        role === 'MODERATOR'
          ? mod?.deliveryRate == null ? null : mod.deliveryRate / 100
          : everConfirmed === 0
            ? null
            : (await measure(db, 'DELIVERY_RATE', metricScope)).count / 100;

      return {
        person: p,
        volume: volume.count,
        crossSell: crossSell.count,
        deliveryRate,
        // The sample is the denominator of the heaviest band: orders
        // CONFIRMED, for either role. It is the number the delivery rate
        // rests on, and a delivery rate is thirty-five of the hundred —
        // gating on anything looser would let the biggest band be noise.
        sample: role === 'MODERATOR' ? mod?.confirmed ?? 0 : volume.count,
        // A MISSING ROW IS NOT A SHARE OF ZERO.
        //
        // `byUser` holds a row for every order attributed to somebody,
        // discounted or not — so a row with `share: 0` is the true statement
        // "they had orders and gave nothing away", and that earns the band.
        // ABSENCE means no order in this window was attributed to them at
        // all, and `?? 0` turned that into a perfect discount record.
        //
        // Reachable for a person who IS scored, because the two windows are
        // not the same window: `discountUse` filters on `createdAt` and the
        // volume filters on `confirmedAt`, so an agent whose orders all
        // arrived before the window and were confirmed inside it passes the
        // sample gate with no discount row. The same rule `issuesRate`
        // already states one interface up: null when they entered nothing,
        // «not zero, which would read as perfect».
        discount: discounts.byUser.get(p.id)?.share ?? null,
        issues: issues.get(p.id)?.rate ?? null,
        responseMinutes: byEmployee.get(p.id)?.medianFirstActionMinutes ?? null,
      };
    })
  );

  const topVolume = Math.max(0, ...raw.map((r) => r.volume));
  const topCrossSell = Math.max(0, ...raw.map((r) => r.crossSell));

  const scored = raw.map((r) => {
    const input: ScoreInput = {
      delivery_rate: { value: r.deliveryRate },
      confirmed_volume: { value: r.volume, reference: topVolume },
      issues_rate: { value: r.issues },
      discount_use: { value: r.discount, reference: discounts.team.share },
      response_time: { value: r.responseMinutes },
      cross_sell: { value: r.crossSell, reference: topCrossSell },
    };
    return {
      id: r.person.id,
      name: r.person.name,
      role,
      score: scoreOf(role, input, { sample: r.sample, minSample }),
    };
  });

  // Best first. Somebody with no score at all sits at the end rather than at
  // the bottom: they were not measured, which is not the same as last.
  const ordered = [...scored].sort((a, b) => {
    if (a.score.total === null) return b.score.total === null ? 0 : 1;
    if (b.score.total === null) return -1;
    return b.score.total - a.score.total;
  });

  return ordered.map((s, i) => ({ ...s, rank: i + 1, of: ordered.length }));
}

/*
 * `asPercent(rate)` lived here — `rateOf(rate ?? 0, 1)`, "the whole-number
 * percentage a rate reads as on a card" — with NO caller anywhere in the
 * repository, while every card that needs one does `Math.round(value * 100)`
 * inline.
 *
 * Deleted rather than kept: its `?? 0` prints «٠٪» for a rate that is NULL,
 * which is the defect this file was just corrected for, sitting one export
 * away from the correction. The same judgement `financial.ts` records about
 * the cost calculator it removed — an exported helper that is merely
 * wrong-when-used is a loaded gun, and pinning it with a test would write
 * the wrong number into the suite instead of out of the code.
 */
