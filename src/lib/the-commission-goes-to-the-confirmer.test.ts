import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE COMMISSION GOES TO THE ONE WHO CONFIRMS (the owner, 3/11, on RV693: «التأكيد»).
 *
 * An order a confirmation agent typed and a colleague confirmed — «أكّده الآن» unticked, or her cap full — paid the agent rate
 * twice. Now the agent in the moderator seat gets no line when somebody else confirmed; the confirmer's line is the only one.
 * The moderator who brings an order keeps hers. The rule lives in `partiesOf` (commission.ts).
 *
 * The worked example, the same as `who-types-and-confirms-is-paid-once.test.ts`: rules — CONFIRMATION_AGENT 5% per order,
 * MODERATOR 1.000 JOD per order. An order of 45 JOD, delivery included, the courier's fee 3 JOD: the sale is 42.000, so the
 * agent rate pays 2.100.
 *
 *   who typed → who confirmed      before            after
 *   Abeer (agent) → Sara (agent)   2.100 + 2.100     2.100 (Sara)
 *   Mona (moderator) → Abeer       1.000 + 2.100     1.000 + 2.100   (unchanged)
 *   Abeer → Abeer                  2.100             2.100           (unchanged)
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db } = vi.hoisted(() => ({
  db: {
    order: { findFirst: vi.fn() },
    commissionRule: { findMany: vi.fn() },
    commissionEntry: { findFirst: vi.fn(), create: vi.fn() },
  },
}));
vi.mock('./db', () => ({ db }));

import { accrueForOrder, commissionAmount, partiesOf, type RuleLike } from './commission';

const base = { effectiveFrom: new Date('2026-01-01'), effectiveTo: null, isActive: true, appliesToUserId: null } as const;
const AGENT_RULE: RuleLike = { ...base, id: 'r-agent', appliesToRole: 'CONFIRMATION_AGENT', type: 'PERCENT', value: 5 };
const MOD_RULE: RuleLike = { ...base, id: 'r-mod', appliesToRole: 'MODERATOR', type: 'FIXED', value: 1 };
const RULES = [AGENT_RULE, MOD_RULE];

type Person = { id: string; role: string; commissionCurrency: string | null };
const ABEER: Person = { id: 'abeer', role: 'CONFIRMATION_AGENT', commissionCurrency: null };
const SARA: Person = { id: 'sara', role: 'CONFIRMATION_AGENT', commissionCurrency: null };
const MONA: Person = { id: 'mona', role: 'MODERATOR', commissionCurrency: null };

const order = (moderator: Person | null, confirmer: Person | null) => ({
  id: 'o45', storeId: 's1', shippingStatus: 'DELIVERED', deliveredAt: new Date('2026-11-05'), currency: 'JOD',
  totalAmount: 45, deliveryFee: 3, priceIncludesDelivery: true,
  moderatorId: moderator?.id ?? null, claimedById: confirmer?.id ?? null, confirmedById: confirmer?.id ?? null,
  moderator, confirmer,
});

/* A ledger with memory (RV694): the «already has an entry» guard reads what `create` really wrote. */
type Entry = { orderId: string; userId: string; amount: number; ruleId: string; status: string };
let ledger: Entry[] = [];
const entries = () => ledger.map(({ userId, amount, ruleId }) => ({ userId, amount, ruleId }));
const paid = () => Math.round(ledger.reduce((sum, e) => sum + e.amount, 0) * 1000) / 1000;

beforeEach(() => {
  vi.clearAllMocks();
  ledger = [];
  db.commissionRule.findMany.mockResolvedValue(RULES);
  db.commissionEntry.findFirst.mockImplementation(
    async ({ where }: { where: { orderId: string; userId: string; status: { in: string[] } } }) =>
      ledger.find((e) => e.orderId === where.orderId && e.userId === where.userId && where.status.in.includes(e.status)) ?? null
  );
  db.commissionEntry.create.mockImplementation(async ({ data }: { data: Entry }) => {
    ledger.push({ orderId: data.orderId, userId: data.userId, amount: data.amount, ruleId: data.ruleId, status: data.status });
    return { id: `e${ledger.length}`, ...data };
  });
});

const accrue = () => accrueForOrder(db as never, { companyId: 'c1', orderId: 'o45', minorUnit: 3 });

describe('the 45 JOD order — an agent types it, a colleague confirms it', () => {
  it('the agent rate on this sale is 2.100, so the old two lines were 4.200', () => {
    const one = commissionAmount(AGENT_RULE, 42, 3);
    expect(one).toBe(2.1);
    expect(Math.round(one * 2 * 1000) / 1000).toBe(4.2);
  });

  it('AFTER: one line, 2.100, to Sara who confirmed — Abeer who typed gets none', async () => {
    db.order.findFirst.mockResolvedValue(order(ABEER, SARA));
    const r = await accrue();
    expect(r).toMatchObject({ created: 1, amount: 2.1, skipped: null });
    expect(entries()).toEqual([{ userId: 'sara', amount: 2.1, ruleId: 'r-agent' }]);
    expect(paid()).toBe(2.1);
  });

  it('a second run of the job adds nothing, and still nothing for Abeer', async () => {
    db.order.findFirst.mockResolvedValue(order(ABEER, SARA));
    await accrue();
    const again = await accrue();
    expect(again.created).toBe(0);
    expect(entries()).toEqual([{ userId: 'sara', amount: 2.1, ruleId: 'r-agent' }]);
  });

  it('an entry Abeer already has (written before this rule) is left exactly as it is — no rewrite, no reversal', async () => {
    ledger.push({ orderId: 'o45', userId: 'abeer', amount: 2.1, ruleId: 'r-agent', status: 'ACCRUED' });
    db.order.findFirst.mockResolvedValue(order(ABEER, SARA));
    await accrue();
    expect(entries()).toEqual([
      { userId: 'abeer', amount: 2.1, ruleId: 'r-agent' },
      { userId: 'sara', amount: 2.1, ruleId: 'r-agent' },
    ]);
  });
});

describe('what does NOT change', () => {
  it('a MODERATOR typed it, an agent confirmed: both lines, 1.000 + 2.100 = 3.100', async () => {
    db.order.findFirst.mockResolvedValue(order(MONA, ABEER));
    const r = await accrue();
    expect(r).toMatchObject({ created: 2, amount: 3.1 });
    expect(entries()).toEqual([
      { userId: 'mona', amount: 1, ruleId: 'r-mod' },
      { userId: 'abeer', amount: 2.1, ruleId: 'r-agent' },
    ]);
  });

  it('the agent typed it and confirmed it herself: one line, 2.100', async () => {
    db.order.findFirst.mockResolvedValue(order(ABEER, ABEER));
    const r = await accrue();
    expect(r).toMatchObject({ created: 1, amount: 2.1 });
    expect(entries()).toEqual([{ userId: 'abeer', amount: 2.1, ruleId: 'r-agent' }]);
  });

  it('no recorded creator (an unowned order): the confirmer alone, 2.100', async () => {
    db.order.findFirst.mockResolvedValue(order(null, SARA));
    const r = await accrue();
    expect(r).toMatchObject({ created: 1, amount: 2.1 });
    expect(entries()).toEqual([{ userId: 'sara', amount: 2.1, ruleId: 'r-agent' }]);
  });

  it('the agent typed it and NOBODY is recorded as confirming: she keeps her line — the rule needs a different confirmer', async () => {
    db.order.findFirst.mockResolvedValue(order(ABEER, null));
    const r = await accrue();
    expect(r).toMatchObject({ created: 1, amount: 2.1 });
    expect(entries()).toEqual([{ userId: 'abeer', amount: 2.1, ruleId: 'r-agent' }]);
  });
});

describe('partiesOf — the seats alone', () => {
  it('agent typed, colleague confirmed → the confirmer only', () => {
    expect(partiesOf({ moderator: ABEER, confirmer: SARA }).map((p) => p.userId)).toEqual(['sara']);
  });

  it('moderator typed, agent confirmed → both, moderator first', () => {
    expect(partiesOf({ moderator: MONA, confirmer: ABEER }).map((p) => p.userId)).toEqual(['mona', 'abeer']);
  });

  it('same person in both seats → one', () => {
    expect(partiesOf({ moderator: ABEER, confirmer: ABEER }).map((p) => p.userId)).toEqual(['abeer']);
  });

  it('no creator → the confirmer; no confirmer → the creator; neither → nobody', () => {
    expect(partiesOf({ moderator: null, confirmer: SARA }).map((p) => p.userId)).toEqual(['sara']);
    expect(partiesOf({ moderator: ABEER, confirmer: null }).map((p) => p.userId)).toEqual(['abeer']);
    expect(partiesOf({ moderator: null, confirmer: null })).toEqual([]);
  });

  it('only the CONFIRMATION_AGENT seat is affected: a supervisor or a manager in the moderator seat keeps the line', () => {
    const supervisor = { id: 'sup', role: 'CONFIRMATION_SUPERVISOR', commissionCurrency: null };
    const manager = { id: 'mgr', role: 'MANAGER', commissionCurrency: null };
    expect(partiesOf({ moderator: supervisor, confirmer: SARA }).map((p) => p.userId)).toEqual(['sup', 'sara']);
    expect(partiesOf({ moderator: manager, confirmer: SARA }).map((p) => p.userId)).toEqual(['mgr', 'sara']);
  });

  it('each party carries its own role and currency — the role the rule is matched on, the currency it is counted in', () => {
    const egp = { ...SARA, commissionCurrency: 'EGP' };
    expect(partiesOf({ moderator: MONA, confirmer: egp })).toEqual([
      { userId: 'mona', role: 'MODERATOR', currency: null },
      { userId: 'sara', role: 'CONFIRMATION_AGENT', currency: 'EGP' },
    ]);
  });
});
