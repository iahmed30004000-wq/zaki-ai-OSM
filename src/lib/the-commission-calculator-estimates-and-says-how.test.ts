import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { estimateCommission, matureDeliveryRate } from './agent-commission-calc';
import { AGENT_COMMISSION_DEFAULTS, parseAgentCommission, validateAgentCommission, type AgentCommissionConfig } from './agent-commission-settings';

/**
 * ═════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — THE COMMISSION CALCULATOR ESTIMATES, AND SAYS HOW (step G2)
 *
 *  1. The defaults are the planner's figures: 100 → 25,000 · 120 → 35,000 · 140 → 50,000 · 160 → 60,000 · 200 → 100,000; 2,000 orders → 500 each; the gate off at 80%.
 *  2. The tier is the highest whose start the count has reached (99 → nothing, 100 → the first, 199 → the fourth, 200 → the last); from 2,000 the bonus REPLACES the tier.
 *  3. The quality gate (when on): a delivery rate under the bar is ONE tier down (the first tier down is nothing); at the bar it stays; with no mature delivery to judge by it is not
 *     applied and the estimate says so; the gate never touches the bonus; off, the rate changes nothing.
 *  4. Every estimate carries its steps in Arabic with Western digits — the «قاعدة الاحتساب».
 *  5. The settings are validated WHOLE: ascending whole tiers, whole money, a gate between 1 and 100, no unknown field; anything else is refused with a sentence, and a stored
 *     document that is not valid is the defaults — never a wild estimate.
 *  6. The calculator is not the ledger: neither file writes money, and neither touches the commission modules' arithmetic.
 * ═════════════════════════════════════════════════════════════════
 */

const C = AGENT_COMMISSION_DEFAULTS;
const est = (confirmed: number, deliveryRate: number | null = null, config: AgentCommissionConfig = C) => estimateCommission(config, { confirmed, deliveryRate });
const gated = (minDeliveryRate = 80): AgentCommissionConfig => ({ ...C, qualityGate: { enabled: true, minDeliveryRate } });

describe('the defaults are the planner\'s figures', () => {
  it('five tiers, the per-order bonus, the gate off', () => {
    expect(C.tiers).toEqual([{ from: 100, value: 25_000 }, { from: 120, value: 35_000 }, { from: 140, value: 50_000 }, { from: 160, value: 60_000 }, { from: 200, value: 100_000 }]);
    expect(C.bonus).toEqual({ minOrders: 2_000, perOrder: 500 });
    expect(C.qualityGate).toEqual({ enabled: false, minDeliveryRate: 80 });
  });
});

describe('the tier', () => {
  it.each([
    [0, 0, 'NONE'], [99, 0, 'NONE'], [100, 25_000, 'TIER'], [119, 25_000, 'TIER'], [120, 35_000, 'TIER'], [139, 35_000, 'TIER'], [140, 50_000, 'TIER'],
    [159, 50_000, 'TIER'], [160, 60_000, 'TIER'], [199, 60_000, 'TIER'], [200, 100_000, 'TIER'], [1_999, 100_000, 'TIER'],
  ])('%i confirmed → %i (%s)', (count, amount, kind) => {
    expect(est(count)).toMatchObject({ amount, kind });
  });

  it('from 2,000 the bonus replaces the tier: 2,000 × 500 = 1,000,000; 2,500 × 500 = 1,250,000', () => {
    expect(est(2_000)).toMatchObject({ amount: 1_000_000, kind: 'BONUS', tier: 0 });
    expect(est(2_500).amount).toBe(1_250_000);
  });

  it('the tier number is 1-based', () => {
    expect(est(100).tier).toBe(1);
    expect(est(200).tier).toBe(5);
    expect(est(50).tier).toBe(0);
  });
});

describe('the quality gate', () => {
  it('off: the delivery rate changes nothing', () => {
    expect(est(165, 10).amount).toBe(60_000);
    expect(est(165, 10).gate).toMatchObject({ enabled: false, applied: false });
  });

  it('on and under the bar: one tier down — 165 confirmed (tier 4, 60,000) at 79% pays tier 3 (50,000)', () => {
    const e = est(165, 79, gated());
    expect(e).toMatchObject({ amount: 50_000, tier: 3 });
    expect(e.gate).toMatchObject({ enabled: true, applied: true, deliveryRate: 79 });
  });

  it('exactly at the bar the tier stays; one point under moves it', () => {
    expect(est(165, 80, gated()).amount).toBe(60_000);
    expect(est(165, 79, gated()).amount).toBe(50_000);
  });

  it('the first tier down is nothing', () => {
    expect(est(105, 50, gated())).toMatchObject({ amount: 0, kind: 'NONE', tier: 0 });
  });

  it('with no mature delivery to judge by, the gate is not applied and the estimate says so', () => {
    const e = est(165, null, gated());
    expect(e.amount).toBe(60_000);
    expect(e.gate.applied).toBe(false);
    expect(e.steps.join(' ')).toContain('ما انطبقت');
  });

  it('never touches the bonus', () => {
    const e = est(2_100, 10, gated());
    expect(e).toMatchObject({ amount: 1_050_000, kind: 'BONUS' });
    expect(e.steps.join(' ')).toContain('ما بتنطبق على البونص');
  });

  it('the bar is the owner\'s: at 90 a rate of 85 is under', () => {
    expect(est(165, 85, gated(90)).amount).toBe(50_000);
  });
});

describe('the steps are the «قاعدة الاحتساب»', () => {
  it('say the count, the tier reached and the money, in Arabic with Western digits', () => {
    const e = est(165, 70, gated());
    const text = e.steps.join(' ');
    expect(text).toContain('165');
    expect(text).toContain('الشريحة 4');
    expect(text).toContain('60,000');
    expect(text).toContain('نزلت شريحة وحدة');
    expect(text).toContain('50,000');
    expect(text).not.toMatch(/[٠-٩]/);
    expect(text).not.toMatch(/[A-Za-z]/);
  });

  it('a count under the first tier says so', () => {
    expect(est(40).steps.join(' ')).toContain('أقل من أول شريحة');
  });
});

describe('the mature delivery rate', () => {
  const now = new Date('2026-11-20T12:00:00Z');
  const row = (daysAgo: number, shippingStatus: string) => ({ shippingStatus, confirmedAt: new Date(now.getTime() - daysAgo * 86_400_000) });

  it('delivered ÷ (delivered + returned) of confirmations at least 7 days old; younger and in-flight are in neither', () => {
    expect(matureDeliveryRate([row(8, 'DELIVERED'), row(9, 'DELIVERED'), row(10, 'DELIVERED'), row(8, 'RETURNED'), row(8, 'OUT_FOR_DELIVERY'), row(2, 'RETURNED')], now)).toBe(75);
  });

  it('nothing to judge by is null, not 0', () => {
    expect(matureDeliveryRate([], now)).toBeNull();
    expect(matureDeliveryRate([row(2, 'DELIVERED'), row(9, 'OUT_FOR_DELIVERY')], now)).toBeNull();
  });
});

describe('the settings are validated whole', () => {
  const ok = (over: Record<string, unknown> = {}) => ({ tiers: [{ from: 10, value: 1000 }, { from: 20, value: 2000 }], bonus: { minOrders: 50, perOrder: 5 }, qualityGate: { enabled: true, minDeliveryRate: 75 }, ...over });

  it('accepts a valid document and returns it as it is', () => {
    const v = validateAgentCommission(ok());
    expect(v).toEqual({ ok: true, config: ok() });
  });

  it.each([
    ['no tiers', ok({ tiers: [] })],
    ['tiers not ascending', ok({ tiers: [{ from: 20, value: 1 }, { from: 10, value: 2 }] })],
    ['a repeated start', ok({ tiers: [{ from: 10, value: 1 }, { from: 10, value: 2 }] })],
    ['a start of zero', ok({ tiers: [{ from: 0, value: 1 }] })],
    ['a fractional start', ok({ tiers: [{ from: 10.5, value: 1 }] })],
    ['a negative amount', ok({ tiers: [{ from: 10, value: -1 }] })],
    ['an amount as text', ok({ tiers: [{ from: 10, value: '1000' }] })],
    ['an unknown tier field', ok({ tiers: [{ from: 10, value: 1, label: 'x' }] })],
    ['an unknown top field', ok({ extra: 1 })],
    ['a bonus without a price', ok({ bonus: { minOrders: 50 } })],
    ['a gate at 0', ok({ qualityGate: { enabled: true, minDeliveryRate: 0 } })],
    ['a gate at 101', ok({ qualityGate: { enabled: true, minDeliveryRate: 101 } })],
    ['a gate flag as text', ok({ qualityGate: { enabled: 'yes', minDeliveryRate: 80 } })],
    ['thirteen tiers', ok({ tiers: Array.from({ length: 13 }, (_, i) => ({ from: i + 1, value: 1 })) })],
    ['null', null],
    ['a string', 'x'],
  ])('refuses %s with an Arabic sentence', (_name, input) => {
    const v = validateAgentCommission(input);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.error).toMatch(/[؀-ۿ]/);
      expect(v.error).not.toMatch(/[٠-٩]/);
    }
  });

  it('a stored document that is not valid is the defaults — a broken row never makes a wild estimate', () => {
    for (const bad of [undefined, null, 'x', {}, { tiers: 'oops' }, ok({ tiers: [{ from: 5, value: -3 }] })]) expect(parseAgentCommission(bad)).toBe(AGENT_COMMISSION_DEFAULTS);
    expect(parseAgentCommission(ok())).toEqual(ok());
  });

  it('a saved document copies the fields: no extra key survives', () => {
    const v = validateAgentCommission(ok());
    expect(Object.keys((v as { config: object }).config).sort()).toEqual(['bonus', 'qualityGate', 'tiers']);
  });
});

describe('it is not the ledger', () => {
  it('neither file writes money or touches the commission modules\' arithmetic', () => {
    for (const f of ['src/lib/agent-commission-calc.ts', 'src/lib/agent-commission-settings.ts']) {
      const src = readFileSync(f, 'utf8').split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
      expect(src, f).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/);
      expect(src, f).not.toMatch(/commissionEntry|commissionPayout|accrueFor|earnedBy|tierFor/);
    }
  });

  it('the calculator reads the commission base through its exported reader, not a copy', () => {
    expect(readFileSync('src/lib/agent-commission-calc.ts', 'utf8')).toContain("measure(client as never, 'CONFIRMED_COUNT'");
  });
});
