import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoFile, stripComments } from './guard-source';
import { earnedBy } from './commission-rules';

/**
 * تشطيب ١ — STAGE 1: THE COMMITMENTS LEDGER, the commission section.
 *
 * Eight lines in the contract, and this is the best-covered area in the
 * system: seven test files already hold most of them. So this ledger does
 * NOT restate them. It records WHERE each commitment's evidence lives, and
 * tests only the three things nothing was testing — the sample floor, the
 * retired duplicate column, and how the four «exclusions» are actually
 * served.
 *
 * WHERE THE EXISTING EVIDENCE IS:
 *   1 accrue on DELIVERED, payable only after settlement → commission.test
 *     («accrues on delivery, in the delivery month») and commission-payout
 *     («an entry that a settlement has not made payable yet» is refused).
 *   2 rules as data with effective_from → commission.test («picks the rule
 *     in force on that day, not today»).
 *   4 cross-sell by added_by / added_stage → commission-metrics.
 *   6 one reference currency, rate stored → commission-payout («stores the
 *     rate as written — a paid month must read the same next year»).
 *   8 ONE commission source → commission-one-source, in full.
 */

describe('3 · the delivery-rate sample floor', () => {
  it('a rate is measured against the SAMPLE, never against itself', () => {
    // «100% out of two orders» must not clear a 30-order floor.
    const perfect = earnedBy({
      type: 'PER_ORDER', value: 5, tiers: null,
      count: 100, sample: 2, minOrders: 30, minorUnit: 3,
    });
    expect(perfect.amount).toBe(0);
    expect(perfect.reason).toBe('BELOW_MINIMUM');
  });

  it('and pays once the sample is big enough', () => {
    const real = earnedBy({
      type: 'PER_ORDER', value: 5, tiers: null,
      count: 100, sample: 30, minOrders: 30, minorUnit: 3,
    });
    expect(real.amount).toBeGreaterThan(0);
    expect(real.reason).toBeNull();
  });

  it('and the sample defaults to the count, which is right for every other metric', () => {
    // A count of confirmed orders is not a ratio: the figure IS the sample.
    const counted = earnedBy({ type: 'PER_ORDER', value: 5, tiers: null, count: 10, minOrders: 30, minorUnit: 3 });
    expect(counted.reason).toBe('BELOW_MINIMUM');
  });

  it('and the ACCRUAL actually passes a sample, or the floor meets the rate', () => {
    /*
     * `earnedBy` separates `sample` from `count` correctly — and that is
     * worth nothing if the caller leaves `sample` undefined, because it then
     * falls back to `count`, which for a rate IS the rate. A 100% rate would
     * clear a floor of 30 as «100 >= 30». Deleting the caller's `sample:`
     * line passed every other test in this file, so it is guarded here.
     */
    const period = stripComments(repoFile('src/lib/commission-period.ts'));
    expect(period).toMatch(
      /sample: rule\.minOrders != null \? await sampleSize\(tx, rule\.metric, scope\) : undefined,/
    );
    // And the sample is asked of the METRIC's own population, not of orders
    // in general — the two must measure the same people.
    expect(stripComments(repoFile('src/lib/commission-metrics.ts'))).toMatch(
      /export async function sampleSize\(tx: Tx, metric: string, scope: MetricScope\)/
    );
  });

  it('and a rate rule saved with the box empty gets the contract’s 30', () => {
    /*
     * «Delivery-rate tiers with a minimum sample of 30 orders.» Both rules in
     * the database had `minOrders: null` — no floor at all — because the box
     * is optional and the column that carried the 30 was never read.
     */
    const door = stripComments(repoFile('src/app/api/settings/commission/route.ts'));
    expect(door).toMatch(/minOrders: input\.minOrders \?\? \(input\.metric === 'DELIVERY_RATE' \? 30 : null\)/);
  });

  it('and the number is shown in the screen before it is agreed to', () => {
    // Applied behind somebody's back is how a floor becomes a surprise on
    // the next reload.
    const screen = stripComments(repoFile('src/components/screens/CommissionSettingsScreen.tsx'));
    expect(screen).toMatch(/if \(next === 'DELIVERY_RATE' && minOrders === ''\) setMinOrders\('30'\);/);
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────
 * THE RETIRED DUPLICATE — `CommissionRule.minSampleOrders`.
 *
 * Two columns for one idea, and the live one was the one WITHOUT the number:
 * `minSampleOrders` carried `@default(30)`, was written by the save door,
 * appeared in the screen's row type — and was read by nothing. `minOrders`,
 * the field `earnedBy` actually checks the sample against, was optional and
 * null on every rule in the database.
 *
 * Retired the way `Order.moderatorCommission` was: out of the code, kept in
 * the schema because financial history is not deleted.
 * ─────────────────────────────────────────────────────────────────────────
 */
describe('the retired column', () => {
  const SRC = join(__dirname, '..');
  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) sourceFiles(p, out);
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
    }
    return out;
  }

  it('is not written, read or selected anywhere in src/', () => {
    // A FILE-LEVEL guard: a unit test cannot catch a ninth screen selecting
    // it. Comments may name it — that is how the next reader learns why.
    const offenders = sourceFiles(SRC)
      .map((p) => ({ f: p.slice(SRC.length + 1), text: stripComments(readFileSync(p, 'utf8')) }))
      .filter(({ text }) => /minSampleOrders/.test(text))
      .map(({ f }) => f);
    expect(offenders, `عمود متقاعد ما زال مستعملاً:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('is still in the schema, because financial history is not deleted', () => {
    const schema = repoFile('prisma/schema.prisma');
    expect(schema).toMatch(/minSampleOrders Int\s+@default\(30\)/);
    expect(schema).toMatch(/RETIRED 2026-10-02 — nothing writes, reads or selects it/);
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────
 * 5 · «Exclusions: duplicate-cancelled, moderator data error, stuck at
 * courier over a week, administratively voided.»
 *
 * There is no exclusion LIST, and there should not be: three of the four are
 * excluded by construction and the fourth by reversal. Written down because
 * «exclusions» reads like a filter somebody will go looking for.
 *
 *   · duplicate-cancelled — a cancelled order is never DELIVERED, and
 *     accrual happens only on delivery.
 *   · stuck at courier over a week — likewise never delivered.
 *   · administratively voided — VOID is refused for anything that ever
 *     shipped (state invariant 9), so a delivered order cannot be voided.
 *   · moderator data error — the only one that can reach a DELIVERED order,
 *     and it is answered by a REVERSING ENTRY with a reason, not a filter.
 * ─────────────────────────────────────────────────────────────────────────
 */
describe('5 and 7 · what is excluded, and how a closed month is corrected', () => {
  const src = stripComments(repoFile('src/lib/commission.ts'));

  it('accrual happens on delivery and nowhere else', () => {
    const door = stripComments(repoFile('src/app/api/settings/commission/route.ts'));
    expect(door).toMatch(/basis: 'ORDER_DELIVERED'/);
    const jobs = stripComments(repoFile('src/lib/jobs/definitions/shared.ts'));
    expect(jobs).toMatch(/NOT_DELIVERED:/);
    expect(jobs).toMatch(/RETURNED:/);
  });

  it('and a correction is a reversing ENTRY, never an edit of the old one', () => {
    expect(src).toMatch(/status: 'REVERSED'/);
    expect(src).toMatch(/reversalOfId: entry\.id/);
    expect(src).toMatch(/reversalReason: params\.reason/);
    // No path rewrites an accrued amount in place.
    expect(src).not.toMatch(/commissionEntry\.update\(\{[^}]*amount:/);
  });

  it('and the reversal lands in the CURRENT period, because an approved month is closed', () => {
    expect(repoFile('src/lib/commission.ts')).toMatch(/an approved month is closed/);
  });

  it('and one entry can be reversed only once', () => {
    // The guard AND the constraint: a second reversal would pay the money
    // back twice.
    expect(src).toMatch(/tx\.commissionEntry\.findUnique\(\{ where: \{ reversalOfId: entry\.id \} \}\)/);
    const schema = repoFile('prisma/schema.prisma');
    const m = schema.slice(schema.indexOf('model CommissionEntry {'));
    expect(m.slice(0, m.indexOf('\n}'))).toMatch(/reversalOfId\s+String\?\s+@unique/);
  });

  it('and the returns door is what reverses, when the goods come back', () => {
    expect(stripComments(repoFile('src/app/api/ops/returns/route.ts'))).toMatch(/reverseForOrder\(tx, \{/);
  });

  it('and an entry only becomes PAYABLE, never PAID, outside a payout', () => {
    expect(src).toMatch(/data: \{ status: 'PAYABLE' \}/);
    expect(src).not.toMatch(/data: \{ status: 'PAID' \}/);
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────
 * NOT BUILT, AND A NAME THAT COLLIDES.
 *
 * `model CommissionPeriod` — a monthly statement with OPEN | APPROVED | PAID
 * and `approvedById` — has ZERO rows and is touched by NO code. The
 * contract's «monthly statement locked after approval» is served instead at
 * the ENTRY level: ACCRUED → PAYABLE → PAID, with reversals landing in the
 * current period. That is a real answer, but it is not a month-level lock.
 *
 * And the name is used twice for different things: the dead MODEL, and a
 * very live TYPE in `commission-rules.ts` meaning a rule's span (DAILY,
 * WEEKLY, MONTHLY) which the settings screen uses. Anyone reading
 * `CommissionPeriod` has to know which — and the hazard is somebody wiring
 * the unused model to the live type because the names match.
 * ─────────────────────────────────────────────────────────────────────────
 */
describe('the monthly statement is not built, and its name is taken', () => {
  it('no code touches the model', () => {
    const SRC = join(__dirname, '..');
    function files(dir: string, out: string[] = []): string[] {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) files(p, out);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
      }
      return out;
    }
    const offenders = files(SRC)
      .map((p) => ({ f: p.slice(SRC.length + 1), text: stripComments(readFileSync(p, 'utf8')) }))
      .filter(({ text }) => /\b(db|tx)\.commissionPeriod\b/.test(text))
      .map(({ f }) => f);
    expect(offenders, `الموديل الميت صار مستعملاً — أعد كتابة هذا البند:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('and the live TYPE of that name is a rule’s span, not a statement', () => {
    const rules = stripComments(repoFile('src/lib/commission-rules.ts'));
    expect(rules).toMatch(/export type CommissionPeriod = \(typeof COMMISSION_PERIODS\)\[number\];/);
    const screen = stripComments(repoFile('src/components/screens/CommissionSettingsScreen.tsx'));
    expect(screen).toMatch(/useState<CommissionPeriod>\('DAILY'\)/);
  });

  it('and the schema still declares the unused model, with its approval fields', () => {
    const schema = repoFile('prisma/schema.prisma');
    const m = schema.slice(schema.indexOf('model CommissionPeriod {'));
    const body = m.slice(0, m.indexOf('\n}'));
    expect(body).toMatch(/status\s+String\s+@default\("OPEN"\)/);
    expect(body).toMatch(/approvedById String\?/);
  });
});
