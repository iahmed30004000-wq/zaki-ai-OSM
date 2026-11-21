import type { Prisma } from '@prisma/client';
import type { db } from './db';
import type { ConfirmationRuleNumbers, RuleNow } from './confirmation-rule-settings';
import { ruleFor, type ConfirmationRuleRow, type RuleOrder, type RuleSource, type Sourced } from './confirmation-rules';
import { NOBODY_NAMED, confirmationRulesOnce, type RulesNow } from './employee-numbers';

type Client = Prisma.TransactionClient | typeof db;

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «أرقام الطلب» ACT — AN ORDER'S ATTEMPTS AND THEIR STEPS, ITS PROOF SECONDS AND ITS POSTPONE LIMIT FROM THE OWNER'S RULES (request Q4d of the rules plan, 21/11).
 *
 * `confirmation-rules.ts` resolves the numbers (`ruleFor`, pure); `employee-numbers.ts` reads the rows (one cached read). This file asks them for ONE ORDER — by its
 * store, the products of its current lines and its channel's kind — and hands the doors the base rule with the order's numbers in place, so every pure rule below them
 * (the plan, the proof, the postpone cap, the words) is unchanged and simply reads another rule.
 *
 * ── WHERE THEY ACT ──
 * Exactly where the base rule's same numbers act, and nowhere else: the contact door (the plan's steps and days, the proof, the limit in its answer), the confirmation
 * door (the postpone cap, the proof of a «لا يرد» date, the «system only» sentence), «طلباتي» (each card's plan, words, limit and proof wait) and the order's timeline.
 * The switches they ride on are the base rule's: the steps and the proof act only with «إثبات المكالمات وجدول المحاولات» on, the postpone cap with it or «أولوية
 * الطابور» on. The pull reads none of them: its warm path is unchanged.
 *
 * ── WHICH LINES (an order of two products) ──
 * EVERY current line counts — the order is «of» each product it carries now. A line removed by an edit takes its product's rule with it; a line added brings its own. When
 * two rules of the same level match one order (two product rules, one for each of its lines), the resolver's own order decides, as it does everywhere: the rule naming
 * more conditions, then the later start, then the later written, then the smaller id — never the order of the lines (a line edit rewrites them all at one instant, so
 * «the first line» would be a coin toss). An order with no line rows (an old one) is of its header product.
 *
 * ── NOTHING WRITTEN = TODAY ──
 * No active ORDER_NUMBERS row of the company: the base rule itself is answered (the same object), the order is not read, and not one statement is added. A row that
 * names another store, product or channel leaves the order's numbers the base's, number for number.
 *
 * ── A RULE CHANGED UNDER AN ORDER ──
 * An order's numbers can change mid-cycle (a rule starts or stops, its product is changed). Nothing stored is rewritten: a due a line stored stays, the next press is
 * judged by the numbers in force, and an order whose counted presses already reach a lower limit closes at its next counted press — the guarantees of
 * `no-answer-cadence.ts` (`mustBeANewDay`, `completesTheDays`), which hold for ANY valid rule. `order-numbers-never-strand-an-order.test.ts` holds it.
 *
 * NOTHING HERE WRITES, TOUCHES MONEY, ORDER CREATION OR A CONTRACT.
 * ═══════════════════════════════════════════════════════════════════════
 */

const BASE: RuleSource = Object.freeze({ from: 'BASE' }) as RuleSource;

/** The rows that can change an order number — the only ones this file resolves. */
export const orderNumberRows = (rows: readonly ConfirmationRuleRow[], companyId: string) =>
  rows.filter((r) => r.kind === 'ORDER_NUMBERS' && r.companyId === companyId);

/** What an order is, for the rules: the fields read of it. */
export interface OrderFactsRow {
  storeId: string | null;
  productId: string | null;
  channel?: { kind: string | null } | null;
  items?: readonly { productId: string }[] | null;
}

/** The order as the resolver asks it: its store, the products of its current lines (the header product when it has no line rows), its channel's kind. */
export function ruleOrderOf(o: OrderFactsRow): RuleOrder {
  const lines = [...new Set((o.items ?? []).map((i) => i.productId).filter((p): p is string => typeof p === 'string' && p.length > 0))];
  return {
    storeId: o.storeId ?? null,
    productIds: lines.length ? lines : o.productId ? [o.productId] : [],
    channelKind: o.channel?.kind ?? null,
    // ORDER_NUMBERS never name a phase (the validator refuses it): an order's numbers do not change between its first call and its retries.
    phase: null,
  };
}

/** An order's three numbers, each with the rule it came from, and the base rule with them in place. */
export interface OrderNumbers {
  numbers: ConfirmationRuleNumbers;
  schedule: Sourced<{ steps: ConfirmationRuleNumbers['steps']; minDays: number }>;
  proofSeconds: Sourced<number>;
  postponeMax: Sourced<number>;
}

const baseOf = (base: ConfirmationRuleNumbers): OrderNumbers => ({
  numbers: base,
  schedule: { value: { steps: base.steps, minDays: base.minDays }, source: BASE },
  proofSeconds: { value: base.proofSeconds, source: BASE },
  postponeMax: { value: base.postponeMax, source: BASE },
});

/**
 * PURE: `order`'s numbers over `base`. No ORDER_NUMBERS row (or no order) → the base itself, without asking the resolver. Otherwise the base rule with the three
 * numbers the resolver answers — and when they are the base's own, the base object itself (so a door that compares by identity sees «nothing changed»).
 * An order rule has no hours (the validator refuses them), so no clock is read.
 */
export function orderNumbersOf(order: RuleOrder | null, ctx: { companyId: string; base: ConfirmationRuleNumbers; rules: readonly ConfirmationRuleRow[] }, now: Date): OrderNumbers {
  const rows = orderNumberRows(ctx.rules, ctx.companyId);
  if (!order || rows.length === 0) return baseOf(ctx.base);
  const eff = ruleFor({ person: { id: NOBODY_NAMED, storeId: order.storeId }, order, now }, { companyId: ctx.companyId, base: ctx.base, timezone: 'UTC', rules: rows });
  const changed = eff.schedule.source.from === 'RULE' || eff.proofSeconds.source.from === 'RULE' || eff.postponeMax.source.from === 'RULE';
  if (!changed) return baseOf(ctx.base);
  return {
    numbers: {
      ...ctx.base,
      steps: eff.schedule.value.steps,
      minDays: eff.schedule.value.minDays,
      proofSeconds: eff.proofSeconds.value,
      postponeMax: eff.postponeMax.value,
    },
    schedule: eff.schedule,
    proofSeconds: eff.proofSeconds,
    postponeMax: eff.postponeMax,
  };
}

const FACTS_SELECT = { id: true, storeId: true, productId: true, channel: { select: { kind: true } }, items: { select: { productId: true } } } as const;
/** More orders than one desk holds (`CLAIM_CAPS.total`); a read is bounded all the same. */
const MAX_ORDERS = 1000;

/** The orders as the resolver asks them — ONE read for any number of orders. A read that fails answers nothing (those orders keep the base numbers). */
export async function readRuleOrders(client: Client, companyId: string, orderIds: readonly string[]): Promise<Map<string, RuleOrder>> {
  const out = new Map<string, RuleOrder>();
  const ids = [...new Set(orderIds)].slice(0, MAX_ORDERS);
  if (ids.length === 0) return out;
  try {
    const rows = await client.order.findMany({ where: { id: { in: ids }, companyId }, select: FACTS_SELECT });
    for (const r of rows) out.set(r.id, ruleOrderOf(r));
  } catch {
    // nothing: the base numbers
  }
  return out;
}

/**
 * THE NUMBERS OF MANY ORDERS (the desk): null when the company has no ORDER_NUMBERS row — every order is the base's and nothing was read — else a map from each
 * order whose numbers differ from the base to its numbers (an order absent from the map is the base's).
 */
export async function orderRulesFor(
  client: Client,
  companyId: string,
  orderIds: readonly string[],
  base: ConfirmationRuleNumbers,
  rules: RulesNow,
  nowMs: number = Date.now()
): Promise<Map<string, ConfirmationRuleNumbers> | null> {
  const rows = orderNumberRows(await rules(), companyId);
  if (rows.length === 0) return null;
  const facts = await readRuleOrders(client, companyId, orderIds);
  const now = new Date(nowMs);
  const out = new Map<string, ConfirmationRuleNumbers>();
  for (const [id, order] of facts) {
    const n = orderNumbersOf(order, { companyId, base, rules: rows }, now).numbers;
    if (n !== base) out.set(id, n);
  }
  return out;
}

/**
 * THE RULE IN FORCE FOR ONE ORDER, asked lazily and at most ONCE (the shape of `confirmationRuleOnce`): the base through `base`, then — only when the company has an
 * ORDER_NUMBERS row — the order's store, lines and channel (one read) and its numbers in place. With no such row it IS `base()`, and nothing more is read.
 */
export function orderRuleOnce(client: Client, companyId: string, orderId: string, base: RuleNow, rules?: RulesNow, nowMs: number = Date.now()): RuleNow {
  let read: Promise<ConfirmationRuleNumbers> | null = null;
  const rulesNow = rules ?? confirmationRulesOnce(client, companyId, nowMs);
  return () =>
    (read ??= (async () => {
      const b = await base();
      const rows = orderNumberRows(await rulesNow(), companyId);
      if (rows.length === 0) return b;
      const order = (await readRuleOrders(client, companyId, [orderId])).get(orderId) ?? null;
      return orderNumbersOf(order, { companyId, base: b, rules: rows }, new Date(nowMs)).numbers;
    })());
}
