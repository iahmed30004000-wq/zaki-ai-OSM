import { describe, expect, it } from 'vitest';
import {
  BENCH_STATE_AR,
  DEFAULT_BENCH_RULES,
  benchFigures,
  benchVerdict,
  judgeBenchProduct,
  parseBenchRules,
  storedBenchRules,
  type BenchRules,
  type BenchState,
  type BenchVerdictInput,
} from './bench-verdict';

/**
 * THE BENCH'S VERDICT, RULE BY RULE AND BOUNDARY BY BOUNDARY (18/11).
 *
 * The owner's defaults: spend 20 a day · day 1 not judged · day 2 under 4 a
 * order → continue · day 3 under 4 → success · cap 60 · 10 orders and a
 * confirmed order above 1.3 × the target → fail.
 */

const R: BenchRules = { ...DEFAULT_BENCH_RULES };
const v = (i: Partial<BenchVerdictInput>, rules: BenchRules = R) =>
  benchVerdict({ dayIndex: 3, spend: 30, orders: 10, confirmed: 10, minorUnit: 2, ...i }, rules);

describe('the defaults are the owner’s', () => {
  it('pins every number', () => {
    expect(DEFAULT_BENCH_RULES).toEqual({
      dailySpend: 20,
      targetCpo: 4,
      continueDay: 2,
      successDay: 3,
      capSpend: 60,
      failMinOrders: 10,
      failMultiplier: 1.3,
      startDay: null,
    });
    expect(Object.isFrozen(DEFAULT_BENCH_RULES)).toBe(true);
  });

  it('every state has an Arabic word for its chip', () => {
    for (const s of ['NOT_JUDGED', 'CONTINUE', 'SUCCESS', 'FAIL', 'CAPPED'] as BenchState[]) {
      expect(BENCH_STATE_AR[s]).toMatch(/[؀-ۿ]/);
    }
  });
});

describe('each rule and its boundary', () => {
  const cases: [string, Partial<BenchVerdictInput>, BenchState][] = [
    // ── day index ──
    ['day 1, cheap orders → not judged', { dayIndex: 1, spend: 10, orders: 5, confirmed: 5 }, 'NOT_JUDGED'],
    ['day 2, under target → continue', { dayIndex: 2, spend: 30, orders: 9, confirmed: 9 }, 'CONTINUE'],
    ['day 3, under target → success', { dayIndex: 3, spend: 30, orders: 9, confirmed: 9 }, 'SUCCESS'],
    ['day 4, under target → success still', { dayIndex: 4, spend: 50, orders: 13, confirmed: 13 }, 'SUCCESS'],
    ['day 0 (start day not come) → not judged', { dayIndex: 0, spend: 10, orders: 5 }, 'NOT_JUDGED'],
    // ── cost exactly at the target is NOT under it ──
    ['day 2, cost exactly 4 → not judged', { dayIndex: 2, spend: 36, orders: 9, confirmed: 9 }, 'NOT_JUDGED'],
    ['day 3, cost exactly 4 → not success', { dayIndex: 3, spend: 36, orders: 9, confirmed: 9 }, 'NOT_JUDGED'],
    ['day 3, cost one cent under 4 → success', { dayIndex: 3, spend: 35.99, orders: 9, confirmed: 9 }, 'SUCCESS'],
    // ── fail: exactly 1.3 × target is NOT above it ──
    ['10 orders, confirmed cost exactly 5.2 → not fail', { dayIndex: 2, spend: 52, orders: 14, confirmed: 10 }, 'CONTINUE'],
    ['10 orders, confirmed cost a cent over 5.2 → fail', { dayIndex: 2, spend: 52.01, orders: 14, confirmed: 10 }, 'FAIL'],
    ['9 orders, terrible confirmation → not fail (below 10)', { dayIndex: 2, spend: 30, orders: 9, confirmed: 1 }, 'CONTINUE'],
    ['10 orders, terrible confirmation → fail', { dayIndex: 2, spend: 30, orders: 10, confirmed: 1 }, 'FAIL'],
    ['10 orders, none confirmed → fail', { dayIndex: 3, spend: 20, orders: 10, confirmed: 0 }, 'FAIL'],
    ['fail is not judged on day 1', { dayIndex: 1, spend: 30, orders: 10, confirmed: 0 }, 'NOT_JUDGED'],
    // ── zero orders / zero spend / missing spend ──
    ['zero orders with spend → not judged', { dayIndex: 3, spend: 40, orders: 0, confirmed: 0 }, 'NOT_JUDGED'],
    ['zero spend → not judged (not «cheap»)', { dayIndex: 3, spend: 0, orders: 5, confirmed: 5 }, 'NOT_JUDGED'],
    ['missing spend (none written) → not judged', { dayIndex: null, spend: null, orders: 5 }, 'NOT_JUDGED'],
    ['a day with orders and no spend → not judged', { dayIndex: 3, spend: 10, orders: 9, missingSpendDays: ['2026-11-17'] }, 'NOT_JUDGED'],
    // ── cap ──
    ['cap exactly 60, above target → capped', { dayIndex: 3, spend: 60, orders: 12, confirmed: 12 }, 'CAPPED'],
    ['a cent under the cap, above target → not judged', { dayIndex: 3, spend: 59.99, orders: 12, confirmed: 12 }, 'NOT_JUDGED'],
    ['cap reached on day 1 → capped (a budget stop)', { dayIndex: 1, spend: 60, orders: 1, confirmed: 1 }, 'CAPPED'],
  ];
  it.each(cases)('%s', (_name, input, state) => {
    expect(v(input).state).toBe(state);
  });
});

describe('precedence — pinned', () => {
  it('missing spend beats every rule, even a fail', () => {
    const r = v({ dayIndex: 3, spend: 100, orders: 20, confirmed: 0, missingSpendDays: ['2026-11-16'] });
    expect(r.state).toBe('NOT_JUDGED');
    expect(r.flag).toBe('MISSING_SPEND');
    expect(r.reason).toContain('الصرف ناقص');
    expect(r.reason).toContain('2026-11-16');
  });

  it('fail beats success: cheap orders nobody confirms', () => {
    // cost per order 2 (success), confirmed cost 40/1 = 40 > 5.2 (fail).
    expect(v({ dayIndex: 3, spend: 40, orders: 20, confirmed: 1 }).state).toBe('FAIL');
  });

  it('success beats the cap', () => {
    expect(v({ dayIndex: 3, spend: 60, orders: 20, confirmed: 20 }).state).toBe('SUCCESS');
  });

  it('fail beats the cap', () => {
    expect(v({ dayIndex: 3, spend: 80, orders: 10, confirmed: 2 }).state).toBe('FAIL');
  });

  it('the cap beats «day 1 is not judged»', () => {
    expect(v({ dayIndex: 1, spend: 70, orders: 0, confirmed: 0 }).state).toBe('CAPPED');
  });

  it('zero spend beats the cap and every judgement', () => {
    expect(v({ dayIndex: 5, spend: 0, orders: 30, confirmed: 0 }).state).toBe('NOT_JUDGED');
  });
});

describe('the sentence names its numbers', () => {
  it('success says the day, the cost and the target', () => {
    const r = v({ dayIndex: 3, spend: 30, orders: 10, confirmed: 10 });
    expect(r.reason).toContain('اليوم 3');
    expect(r.reason).toContain('3');
    expect(r.reason).toContain('الهدف 4');
  });

  it('fail says the order count, the multiplier and the limit', () => {
    const r = v({ dayIndex: 2, spend: 60, orders: 10, confirmed: 5 });
    expect(r.state).toBe('FAIL');
    expect(r.reason).toContain('10 طلب');
    expect(r.reason).toContain('1.3');
    expect(r.reason).toContain('5.2');
    expect(r.reason).toContain('12'); // 60 / 5
  });

  it('capped names the spend and the cap', () => {
    const r = v({ dayIndex: 3, spend: 61, orders: 12, confirmed: 12 });
    expect(r.state).toBe('CAPPED');
    expect(r.reason).toContain('61');
    expect(r.reason).toContain('60');
  });

  it('day 1 says when the first verdict comes', () => {
    expect(v({ dayIndex: 1, spend: 10, orders: 3 }).reason).toContain('اليوم 2');
  });

  it('every reason is Arabic and has no English word', () => {
    const inputs: Partial<BenchVerdictInput>[] = [
      { dayIndex: 1 }, { dayIndex: 2, spend: 30, orders: 9 }, { dayIndex: 3, spend: 30, orders: 9 },
      { spend: 0 }, { spend: null }, { spend: 70, orders: 10, confirmed: 10 }, { orders: 10, confirmed: 0 },
      { orders: 0 }, { missingSpendDays: ['2026-11-01', '2026-11-02'] },
    ];
    for (const i of inputs) {
      const r = v(i);
      expect(r.reason).toMatch(/[؀-ۿ]/);
      expect(r.reason).not.toMatch(/[A-Za-z]{2,}/);
    }
  });
});

describe('the owner’s own numbers move the verdict', () => {
  it('a higher target turns «not judged» into success', () => {
    const rules = { ...R, targetCpo: 5 };
    expect(v({ dayIndex: 3, spend: 45, orders: 10, confirmed: 10 }).state).toBe('NOT_JUDGED');
    expect(v({ dayIndex: 3, spend: 45, orders: 10, confirmed: 10 }, rules).state).toBe('SUCCESS');
  });

  it('a fail floor of 5 orders fails earlier', () => {
    expect(v({ dayIndex: 2, spend: 30, orders: 5, confirmed: 0 }, { ...R, failMinOrders: 5 }).state).toBe('FAIL');
  });

  it('a later success day keeps day 3 at continue', () => {
    expect(v({ dayIndex: 3, spend: 30, orders: 9, confirmed: 9 }, { ...R, successDay: 4 }).state).toBe('CONTINUE');
  });

  it('a multiplier of 2 forgives what 1.3 fails', () => {
    const i = { dayIndex: 2, spend: 38, orders: 10, confirmed: 5 }; // 7.6 per confirmed, 3.8 per order
    expect(v(i).state).toBe('FAIL');
    expect(v(i, { ...R, failMultiplier: 2 }).state).toBe('CONTINUE');
  });

  it('three decimals (JOD): the boundary holds in thousandths', () => {
    expect(v({ dayIndex: 3, spend: 35.999, orders: 9, confirmed: 9, minorUnit: 3 }).state).toBe('SUCCESS');
    expect(v({ dayIndex: 3, spend: 36, orders: 9, confirmed: 9, minorUnit: 3 }).state).toBe('NOT_JUDGED');
  });
});

describe('the figures of one test period', () => {
  const o = (day: string, confirmed = false) => ({ day, confirmed });

  it('counts from the first spend day to today, with day 1 = the first spend day', () => {
    const f = benchFigures({
      today: '2026-11-18',
      minorUnit: 2,
      rulesStartDay: null,
      orders: [o('2026-11-16', true), o('2026-11-17'), o('2026-11-18', true)],
      spend: [{ day: '2026-11-16', amount: 20 }, { day: '2026-11-17', amount: 20 }, { day: '2026-11-18', amount: 10.5 }],
    });
    expect(f.startDay).toBe('2026-11-16');
    expect(f.dayIndex).toBe(3);
    expect(f.spend).toBe(50.5);
    expect(f.orders).toBe(3);
    expect(f.confirmed).toBe(2);
    expect(f.confirmationRate).toBe(67);
    expect(f.costPerOrder).toBe(16.83);
    expect(f.costPerConfirmed).toBe(25.25);
    expect(f.missingSpendDays).toEqual([]);
  });

  it('orders before the first spend are shown apart, not counted', () => {
    const f = benchFigures({
      today: '2026-11-18', minorUnit: 2, rulesStartDay: null,
      orders: [o('2026-11-10'), o('2026-11-17')],
      spend: [{ day: '2026-11-17', amount: 20 }],
    });
    expect(f.orders).toBe(1);
    expect(f.ordersBeforeStart).toBe(1);
  });

  it('a day with orders and no spend is named', () => {
    const f = benchFigures({
      today: '2026-11-18', minorUnit: 2, rulesStartDay: null,
      orders: [o('2026-11-16'), o('2026-11-17'), o('2026-11-17')],
      spend: [{ day: '2026-11-16', amount: 20 }],
    });
    expect(f.missingSpendDays).toEqual(['2026-11-17']);
  });

  it('a day written as zero is written (the ads were off)', () => {
    const f = benchFigures({
      today: '2026-11-18', minorUnit: 2, rulesStartDay: null,
      orders: [o('2026-11-17')],
      spend: [{ day: '2026-11-16', amount: 20 }, { day: '2026-11-17', amount: 0 }],
    });
    expect(f.missingSpendDays).toEqual([]);
  });

  it('a second period: the start day leaves the first one out', () => {
    const f = benchFigures({
      today: '2026-11-18', minorUnit: 2, rulesStartDay: '2026-11-17',
      orders: [o('2026-10-01', true), o('2026-10-02'), o('2026-11-17', true)],
      spend: [{ day: '2026-10-01', amount: 20 }, { day: '2026-10-02', amount: 20 }, { day: '2026-11-17', amount: 15 }],
    });
    expect(f.dayIndex).toBe(2);
    expect(f.spend).toBe(15);
    expect(f.orders).toBe(1);
    expect(f.ordersBeforeStart).toBe(2);
    expect(f.spendBeforeStart).toBe(40);
  });

  it('no spend at all: no start, no day, spend null — every order «before the start»', () => {
    const f = benchFigures({ today: '2026-11-18', minorUnit: 2, rulesStartDay: null, orders: [o('2026-11-17')], spend: [] });
    expect(f.startDay).toBeNull();
    expect(f.dayIndex).toBeNull();
    expect(f.spend).toBeNull();
    expect(f.orders).toBe(0);
    expect(f.ordersBeforeStart).toBe(1);
    expect(f.confirmationRate).toBeNull();
    expect(f.costPerOrder).toBeNull();
  });

  it('spend dated after today is not counted', () => {
    const f = benchFigures({
      today: '2026-11-18', minorUnit: 2, rulesStartDay: null, orders: [],
      spend: [{ day: '2026-11-18', amount: 20 }, { day: '2026-11-19', amount: 20 }],
    });
    expect(f.spend).toBe(20);
  });

  it('a start day in the future gives day 0', () => {
    const f = benchFigures({ today: '2026-11-18', minorUnit: 2, rulesStartDay: '2026-11-20', orders: [], spend: [] });
    expect(f.dayIndex).toBe(0);
  });

  it('adds money in whole units: 0.1 + 0.2 is 0.3', () => {
    const f = benchFigures({
      today: '2026-11-18', minorUnit: 2, rulesStartDay: null, orders: [],
      spend: [{ day: '2026-11-17', amount: 0.1 }, { day: '2026-11-18', amount: 0.2 }],
    });
    expect(f.spend).toBe(0.3);
  });

  it('the day count is calendar days across a month end', () => {
    const f = benchFigures({ today: '2026-12-01', minorUnit: 2, rulesStartDay: '2026-11-29', orders: [], spend: [] });
    expect(f.dayIndex).toBe(3);
  });
});

describe('judgeBenchProduct joins the two', () => {
  it('missing spend reaches the verdict', () => {
    const { verdict } = judgeBenchProduct({
      today: '2026-11-18', minorUnit: 2, rules: R,
      orders: [{ day: '2026-11-18', confirmed: true }],
      spend: [{ day: '2026-11-16', amount: 20 }],
    });
    expect(verdict.flag).toBe('MISSING_SPEND');
  });

  it('a mid-test rules edit is recomputed from the stored numbers', () => {
    const input = {
      today: '2026-11-18', minorUnit: 2,
      orders: Array.from({ length: 10 }, () => ({ day: '2026-11-17', confirmed: true })),
      spend: [{ day: '2026-11-16', amount: 20 }, { day: '2026-11-17', amount: 20 }, { day: '2026-11-18', amount: 5 }],
    };
    expect(judgeBenchProduct({ ...input, rules: R }).verdict.state).toBe('NOT_JUDGED'); // 4.5 a order
    expect(judgeBenchProduct({ ...input, rules: { ...R, targetCpo: 5 } }).verdict.state).toBe('SUCCESS');
  });

  it('the rules’ start day moves the day index', () => {
    const { figures } = judgeBenchProduct({
      today: '2026-11-18', minorUnit: 2, rules: { ...R, startDay: '2026-11-18' }, orders: [],
      spend: [{ day: '2026-11-16', amount: 20 }, { day: '2026-11-18', amount: 20 }],
    });
    expect(figures.dayIndex).toBe(1);
    expect(figures.spend).toBe(20);
  });
});

describe('the rules form is checked, never clamped', () => {
  it('empty means the defaults', () => {
    expect(parseBenchRules({})).toEqual({ rules: { ...DEFAULT_BENCH_RULES }, errors: [] });
  });

  it('strings from a form are read as numbers', () => {
    expect(parseBenchRules({ targetCpo: '5', capSpend: '80' }).rules).toMatchObject({ targetCpo: 5, capSpend: 80 });
  });

  const bad: [string, Record<string, unknown>][] = [
    ['zero target', { targetCpo: 0 }],
    ['negative cap', { capSpend: -1 }],
    ['text spend', { dailySpend: 'abc' }],
    ['fractional day', { continueDay: 1.5 }],
    ['day 0', { continueDay: 0 }],
    ['success before continue', { continueDay: 3, successDay: 2 }],
    ['zero fail orders', { failMinOrders: 0 }],
    ['multiplier under 1', { failMultiplier: 0.9 }],
    ['multiplier with three decimals', { failMultiplier: 1.333 }],
    ['a start day that is not a day', { startDay: '2026-02-30' }],
  ];
  it.each(bad)('refuses %s with an Arabic sentence', (_n, raw) => {
    const { errors } = parseBenchRules(raw);
    expect(errors.length).toBeGreaterThan(0);
    for (const e of errors) expect(e).toMatch(/[؀-ۿ]/);
  });

  it('a stored block keeps its good fields and drops the broken ones', () => {
    expect(storedBenchRules({ targetCpo: 6, capSpend: 'x' })).toMatchObject({ targetCpo: 6, capSpend: 60 });
    expect(storedBenchRules({ continueDay: 5, successDay: 2 })).toMatchObject({ continueDay: 2, successDay: 3 });
    expect(storedBenchRules(null)).toEqual({ ...DEFAULT_BENCH_RULES });
  });
});
