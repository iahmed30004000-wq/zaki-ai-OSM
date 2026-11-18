import { roundMinor, toMinorUnits, fromMinorUnits } from './money';
import { rateOf } from './order-state';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE BENCH'S VERDICT ON ONE PRODUCT — success, continue, fail — BY THE
 * NUMBERS THE OWNER SETS.
 *
 * On the test bench a product is judged by what its ads cost and how many
 * of its orders get CONFIRMED. Nothing here reads shipping or delivery: a
 * bench order stops at confirmation, so a verdict that waited for a parcel
 * would wait for ever.
 *
 * PURE. No database, no clock: the day index, the spend and the counts all
 * come in, so every rule and every boundary is a line in a table test
 * (bench-verdict.test.ts) rather than a fixture.
 *
 * ALL THE ARITHMETIC IS IN WHOLE MINOR UNITS. «Cost per order under 4» is
 * asked as `spend < 4 × orders`, never as `spend / orders < 4`: a division
 * lands 3.9999… or 4.0000…1 and a boundary the owner typed («exactly 4 is
 * not under 4») would move with the float. The divisions below are for the
 * screen only and never decide anything.
 *
 * ── PRECEDENCE (pinned by a test, in this order) ──
 *   1. no spend written / no start day        → NOT_JUDGED
 *   2. a day with orders and no spend written → NOT_JUDGED «الصرف ناقص»
 *   3. total spend is zero                     → NOT_JUDGED
 *   4. FAIL     — from the judging day, enough orders and the confirmed order
 *                 costs more than the multiplier × the target
 *   5. SUCCESS  — from the success day, the order costs under the target
 *   6. CAPPED   — the test's spend reached its cap (any day, day 1 included:
 *                 a cap is a budget stop, not a verdict on the product)
 *   7. before the judging day                  → NOT_JUDGED (day 1)
 *   8. CONTINUE — on a judging day before the success day, under the target
 *   9. otherwise                               → NOT_JUDGED, and the sentence
 *                                                says which number is short
 * FAIL beats SUCCESS on purpose: cheap orders that nobody confirms are not a
 * product that sells — the owner judges by the CONFIRMED order.
 * ═══════════════════════════════════════════════════════════════════════
 */

export type BenchState = 'NOT_JUDGED' | 'CONTINUE' | 'SUCCESS' | 'FAIL' | 'CAPPED';

export interface BenchRules {
  /** The planned spend per day — shown beside the real one, never judged on. */
  dailySpend: number;
  /** The cost per order the product must come in under. */
  targetCpo: number;
  /** The first day that is judged at all (day 1 is not). */
  continueDay: number;
  /** From this day, under the target is a SUCCESS. */
  successDay: number;
  /** The whole test's spend ceiling. */
  capSpend: number;
  /** The fail rule needs at least this many orders… */
  failMinOrders: number;
  /** …and a confirmed order costing more than this × the target. */
  failMultiplier: number;
  /**
   * The first day of THIS test period, `yyyy-MM-dd` in the store's day.
   * Null = the first day spend was written. Set it to start a second period:
   * what came before it stops counting.
   */
  startDay: string | null;
}

/** The owner's media-buyer rules (plan 17/11 §6). Every one is editable per product. */
export const DEFAULT_BENCH_RULES: Readonly<BenchRules> = Object.freeze({
  dailySpend: 20,
  targetCpo: 4,
  continueDay: 2,
  successDay: 3,
  capSpend: 60,
  failMinOrders: 10,
  failMultiplier: 1.3,
  startDay: null,
});

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar day written `yyyy-MM-dd` — «2026-02-30» is not one. */
export function isDayKey(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const m = DAY_RE.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/** Whole days from `a` to `b` (both `yyyy-MM-dd`); calendar days, so no hour of a timezone shift can move it. */
export function daysBetween(a: string, b: string): number {
  const ms = (k: string) => {
    const m = DAY_RE.exec(k)!;
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  };
  return Math.round((ms(b) - ms(a)) / 86_400_000);
}

const num = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
};

/**
 * A rules block from a form — every field checked, and a sentence per
 * problem. Nothing is clamped: a cap the owner typed wrong and saw silently
 * changed is a test judged by a number nobody chose.
 */
export function parseBenchRules(raw: unknown): { rules: BenchRules; errors: string[] } {
  const o = (raw ?? {}) as Record<string, unknown>;
  const errors: string[] = [];
  const pick = (key: keyof BenchRules) => (o[key] === undefined || o[key] === null || o[key] === '' ? DEFAULT_BENCH_RULES[key] : o[key]);

  const money = (key: 'dailySpend' | 'targetCpo' | 'capSpend', name: string): number => {
    const n = num(pick(key));
    if (n === null || n <= 0 || n > 1_000_000) {
      errors.push(`${name}: اكتب رقم أكبر من صفر.`);
      return DEFAULT_BENCH_RULES[key];
    }
    return n;
  };
  const whole = (key: 'continueDay' | 'successDay' | 'failMinOrders', name: string, lo: number, hi: number): number => {
    const n = num(pick(key));
    if (n === null || !Number.isInteger(n) || n < lo || n > hi) {
      errors.push(`${name}: اكتب رقم صحيح من ${lo} لـ${hi}.`);
      return DEFAULT_BENCH_RULES[key];
    }
    return n;
  };

  const dailySpend = money('dailySpend', 'صرف اليوم');
  const targetCpo = money('targetCpo', 'هدف تكلفة الطلب');
  const capSpend = money('capSpend', 'سقف التيست');
  const continueDay = whole('continueDay', 'أول يوم بينحكم فيه', 1, 60);
  const successDay = whole('successDay', 'يوم النجاح', 1, 60);
  const failMinOrders = whole('failMinOrders', 'طلبات قاعدة الفشل', 1, 100_000);
  if (successDay < continueDay) errors.push('يوم النجاح لازم يكون بعد أول يوم بينحكم فيه أو نفسه.');

  let failMultiplier = DEFAULT_BENCH_RULES.failMultiplier;
  const m = num(pick('failMultiplier'));
  if (m === null || m < 1 || m > 10 || Math.abs(m * 100 - Math.round(m * 100)) > 1e-9) {
    errors.push('مضاعف الفشل: اكتب رقم من 1 لـ10، بخانتين عشريتين بالأكتر.');
  } else failMultiplier = m;

  let startDay: string | null = null;
  if (o.startDay !== undefined && o.startDay !== null && o.startDay !== '') {
    if (isDayKey(o.startDay)) startDay = o.startDay;
    else errors.push('بداية التيست: اختار يوم صحيح.');
  }

  return {
    rules: { dailySpend, targetCpo, continueDay, successDay, capSpend, failMinOrders, failMultiplier, startDay },
    errors,
  };
}

/**
 * A stored block as this build reads it. `parseBenchRules` already puts the
 * default in place of each broken field, so a bad row keeps its good fields
 * and cannot take the bench down; the two days that only make sense together
 * go back to the defaults together.
 */
export function storedBenchRules(raw: unknown): BenchRules {
  const { rules } = parseBenchRules(raw);
  return rules.successDay < rules.continueDay
    ? { ...rules, continueDay: DEFAULT_BENCH_RULES.continueDay, successDay: DEFAULT_BENCH_RULES.successDay }
    : rules;
}

// ─── the figures ────────────────────────────────────────────────────────

export interface BenchOrderDay {
  /** The store's day the order was created on. */
  day: string;
  confirmed: boolean;
}

export interface BenchSpendDay {
  day: string;
  amount: number;
}

export interface BenchFigures {
  /** The first day counted, or null before any spend is written. */
  startDay: string | null;
  /** Day 1 = the start day. Null with no start. */
  dayIndex: number | null;
  /** Spend counted (start → today), in the store's money. Null = none written. */
  spend: number | null;
  orders: number;
  confirmed: number;
  /** `rateOf(confirmed, orders)` — null before the first order. */
  confirmationRate: number | null;
  /** For the screen only — the verdict never divides. */
  costPerOrder: number | null;
  costPerConfirmed: number | null;
  /** Days with orders and no spend written. */
  missingSpendDays: string[];
  /** Orders before the start day (an earlier period, or before the first spend) — shown, not counted. */
  ordersBeforeStart: number;
  /** Spend written before the start day — shown, not counted. */
  spendBeforeStart: number;
}

/**
 * The counts and the spend of ONE test period, from its start day to today.
 *
 * `spend` is only the LIVE entries (a voided entry never reaches here); a day
 * written as zero counts as written — the ads were off that day, and saying so
 * is not the same as forgetting to.
 */
export function benchFigures(p: {
  today: string;
  minorUnit: number;
  rulesStartDay: string | null;
  orders: readonly BenchOrderDay[];
  spend: readonly BenchSpendDay[];
}): BenchFigures {
  const spendDays = p.spend.filter((s) => s.day <= p.today);
  const firstSpend = spendDays.reduce<string | null>((min, s) => (min === null || s.day < min ? s.day : min), null);
  const startDay = p.rulesStartDay ?? firstSpend;

  const inWindow = (day: string) => startDay !== null && day >= startDay && day <= p.today;
  const counted = startDay === null ? [] : p.orders.filter((o) => inWindow(o.day));
  const before = startDay === null ? p.orders.length : p.orders.filter((o) => o.day < startDay).length;

  let spendUnits = 0;
  let beforeUnits = 0;
  let any = false;
  const written = new Set<string>();
  for (const s of spendDays) {
    if (startDay !== null && s.day >= startDay) {
      spendUnits += toMinorUnits(s.amount, p.minorUnit);
      written.add(s.day);
      any = true;
    } else beforeUnits += toMinorUnits(s.amount, p.minorUnit);
  }

  const orders = counted.length;
  const confirmed = counted.filter((o) => o.confirmed).length;
  const missing = [...new Set(counted.map((o) => o.day))].filter((d) => !written.has(d)).sort();
  const spend = any ? fromMinorUnits(spendUnits, p.minorUnit) : null;
  const per = (n: number) => (spend === null || n === 0 ? null : roundMinor(spendUnits / n / 10 ** p.minorUnit, p.minorUnit));

  return {
    startDay,
    dayIndex: startDay === null ? null : p.today < startDay ? 0 : daysBetween(startDay, p.today) + 1,
    spend,
    orders,
    confirmed,
    confirmationRate: rateOf(confirmed, orders),
    costPerOrder: per(orders),
    costPerConfirmed: per(confirmed),
    missingSpendDays: missing,
    ordersBeforeStart: before,
    spendBeforeStart: fromMinorUnits(beforeUnits, p.minorUnit),
  };
}

// ─── the verdict ────────────────────────────────────────────────────────

export interface BenchVerdictInput {
  /** Day 1 = the start day; 0 = the start day has not come yet; null = no start. */
  dayIndex: number | null;
  /** Null = no spend written at all. */
  spend: number | null;
  orders: number;
  confirmed: number;
  missingSpendDays?: readonly string[];
  /** The currency's decimals (2 for USD, 3 for JOD) — the arithmetic is in its whole units. */
  minorUnit?: number;
}

export interface BenchVerdict {
  state: BenchState;
  /** One plain sentence naming the numbers it used. */
  reason: string;
  /** Set when the verdict was withheld for a missing spend day. */
  flag: 'MISSING_SPEND' | null;
}

/** The word on the chip — the colour is never the only signal. */
export const BENCH_STATE_AR: Record<BenchState, string> = {
  NOT_JUDGED: 'ما في حكم',
  CONTINUE: 'كمّل',
  SUCCESS: 'ناجح',
  FAIL: 'فاشل',
  CAPPED: 'وصل السقف',
};

/** A figure inside a sentence: rounded to the currency's decimals, no trailing zeros. */
const fmt = (n: number, minorUnit: number) => String(roundMinor(n, minorUnit));

export function benchVerdict(input: BenchVerdictInput, rules: BenchRules): BenchVerdict {
  const mu = input.minorUnit ?? 2;
  const f = (n: number) => fmt(n, mu);
  const out = (state: BenchState, reason: string, flag: BenchVerdict['flag'] = null): BenchVerdict => ({ state, reason, flag });

  // 1. Nothing to judge on.
  if (input.spend === null || input.dayIndex === null) {
    return out('NOT_JUDGED', 'ما في صرف مكتوب لهالمنتج — اكتب صرف أول يوم ليبلش العدّ.');
  }
  if (input.dayIndex < 1) {
    return out('NOT_JUDGED', 'يوم بداية التيست لسا ما إجا.');
  }

  // 2. A day with orders and no spend: the cost per order would be a lie.
  const missing = input.missingSpendDays ?? [];
  if (missing.length > 0) {
    return out(
      'NOT_JUDGED',
      `الصرف ناقص: في طلبات ${missing.length === 1 ? `يوم ${missing[0]}` : `${missing.length} أيام (أولها ${missing[0]})`} وما في صرف مكتوب. اكتبه وبيطلع الحكم.`,
      'MISSING_SPEND'
    );
  }

  const spendU = toMinorUnits(input.spend, mu);
  const targetU = toMinorUnits(rules.targetCpo, mu);
  const capU = toMinorUnits(rules.capSpend, mu);
  const day = input.dayIndex;

  // 3. Zero spend: «cost per order 0» is not a cheap product, it is no ads.
  if (spendU <= 0) {
    return out('NOT_JUDGED', `الصرف صفر لحد اليوم ${day} — ما في إعلان لينحكم عليه.`);
  }

  const underTarget = input.orders > 0 && spendU < targetU * input.orders;
  const cpo = input.orders > 0 ? f(input.spend / input.orders) : null;

  // 4. FAIL — the confirmed order costs more than multiplier × target. In
  //    hundredths of the multiplier so 1.3 is the integer 130, exactly.
  if (day >= rules.continueDay && input.orders >= rules.failMinOrders) {
    const mult = Math.round(rules.failMultiplier * 100);
    if (spendU * 100 > mult * targetU * input.confirmed) {
      const limit = f(rules.failMultiplier * rules.targetCpo);
      const cpc = input.confirmed > 0 ? `تكلفة الطلب المؤكَّد ${f(input.spend / input.confirmed)}` : 'ولا طلب مؤكَّد';
      return out(
        'FAIL',
        `${input.orders} طلب (الحد ${rules.failMinOrders}) و${cpc} — فوق ${rules.failMultiplier} × الهدف ${f(rules.targetCpo)} = ${limit}.`
      );
    }
  }

  // 5. SUCCESS — from the success day, under the target.
  if (day >= rules.successDay && underTarget) {
    return out('SUCCESS', `اليوم ${day}: تكلفة الطلب ${cpo} تحت الهدف ${f(rules.targetCpo)} (${input.orders} طلب بصرف ${f(input.spend)}).`);
  }

  // 6. CAPPED — the test's money is spent.
  if (spendU >= capU) {
    return out('CAPPED', `الصرف ${f(input.spend)} وصل سقف التيست ${f(rules.capSpend)} بدون نجاح — وقّف الصرف أو ارفع السقف.`);
  }

  // 7. Before the judging day.
  if (day < rules.continueDay) {
    return out('NOT_JUDGED', `اليوم ${day}: ما بينحكم عليه — أول حكم باليوم ${rules.continueDay}.`);
  }

  // 8. CONTINUE — a judging day before the success day, under the target.
  if (day < rules.successDay && underTarget) {
    return out('CONTINUE', `اليوم ${day}: تكلفة الطلب ${cpo} تحت الهدف ${f(rules.targetCpo)} — كمّل للنجاح باليوم ${rules.successDay}.`);
  }

  // 9. Judged and short of every rule: say which number.
  if (input.orders === 0) {
    return out('NOT_JUDGED', `اليوم ${day}: صرفت ${f(input.spend)} وما في ولا طلب لسا.`);
  }
  return out(
    'NOT_JUDGED',
    `اليوم ${day}: تكلفة الطلب ${cpo} مش تحت الهدف ${f(rules.targetCpo)} — ما في حكم لحد ما تنزل، أو يوصل الصرف السقف ${f(rules.capSpend)}، أو تنطبق قاعدة الفشل.`
  );
}

/** One product, start to verdict: the figures of its test period and what the rules say about them. */
export function judgeBenchProduct(p: {
  today: string;
  minorUnit: number;
  rules: BenchRules;
  orders: readonly BenchOrderDay[];
  spend: readonly BenchSpendDay[];
}): { figures: BenchFigures; verdict: BenchVerdict } {
  const figures = benchFigures({ today: p.today, minorUnit: p.minorUnit, rulesStartDay: p.rules.startDay, orders: p.orders, spend: p.spend });
  const verdict = benchVerdict(
    {
      dayIndex: figures.dayIndex,
      spend: figures.spend,
      orders: figures.orders,
      confirmed: figures.confirmed,
      missingSpendDays: figures.missingSpendDays,
      minorUnit: p.minorUnit,
    },
    p.rules
  );
  return { figures, verdict };
}
