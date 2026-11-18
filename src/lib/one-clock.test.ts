import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from './guard-source';

/**
 * ONE CLOCK.
 *
 * Two endpoints used to time the same thing differently: the confirmation
 * performance route counted wall-clock hours, and the team screen and the
 * performance score counted WORKING minutes. One agent, one week, two
 * numbers — and nothing in the system could say which was right.
 *
 * Wall clock is the wrong one, and not by a little. An order pulled at
 * five on a Thursday evening and confirmed at ten on Saturday morning is
 * forty-one hours of somebody being slow by that reading. It is one
 * working hour. The difference is a weekend the company chose.
 *
 * So this is a structural test: no reader of a claim-to-action duration may
 * divide milliseconds into hours by hand. If a third screen ever needs one,
 * it calls the same function as the other two.
 */

/*
 * COMMENTS OUT FIRST. This read the raw file, so a route that MENTIONED
 * `claimedAt` while explaining why it no longer reads it was pulled into
 * the rule and failed it. A guard that reads prose is the defect
 * `ui-inventory` already names: «a census that counts prose is worse than
 * one that counts nothing».
 */
const read = (p: string) => stripComments(readFileSync(join(process.cwd(), p), 'utf8'));

/** Every place that times how long a person took over an order. */
const CLOCK_READERS = [
  'src/app/api/orders/confirmation/performance/route.ts',
  'src/lib/team-performance.ts',
  'src/lib/performance-metrics.ts',
];

describe('how long somebody took', () => {
  it('is counted in working minutes, by the one function that knows the calendar', () => {
    for (const file of CLOCK_READERS) {
      const src = read(file);
      if (!/claimedAt|firstAction|ResponseMinutes|medianFirstActionMinutes/.test(src)) continue;
      expect(
        src.includes('businessMinutesBetween') || src.includes('medianFirstActionMinutes'),
        `${file} times work without the company calendar`
      ).toBe(true);
    }
  });

  it('and nobody divides into hours by hand again', () => {
    for (const file of CLOCK_READERS) {
      // 60 * 60 * 1000 — the wall-clock hour that started the disagreement.
      expect(read(file), `${file} still converts milliseconds to hours itself`).not.toContain('(60 * 60 * 1000)');
    }
  });

  it('the confirmation route reports minutes, and says which minutes they are', () => {
    /*
     * THE SENTENCE MOVED, AND SO DID THE TIMING.
     *
     * This asked for the English words «not wall clock», which lived in a
     * comment beside the route's own `businessMinutesBetween` call. The
     * route no longer times anything: it reads `medianConfirmMinutes` off
     * `teamPerformance()`, the same function the team screen reads, so the
     * two cannot disagree about one person's week any more.
     *
     * What is held now is what a READER is told. Both routes ship the same
     * Arabic definition of the figure, and that is the thing that must not
     * quietly become «hours» again.
     */
    const src = read('src/app/api/orders/confirmation/performance/route.ts');
    expect(src).toContain('medianConfirmMinutes');
    // The old field name promised hours while holding something else.
    expect(src).not.toContain('avgConfirmationHours');

    const SAYS_WHICH_MINUTES = 'خارج الدوام لا يُحتسب';
    expect(src, 'الرقم يُعرَض بلا قولِ أيِّ دقائق هو').toContain(SAYS_WHICH_MINUTES);
    // And the team screen says it in the same words, from the same figure.
    expect(read('src/app/api/orders/confirmation/team/route.ts')).toContain(SAYS_WHICH_MINUTES);
  });

  it('and the two routes read that figure from ONE calculator', () => {
    /*
     * The performance route used to compute `claimed`, `confirmed`,
     * `rejected`, `noAnswer`, the decided count, the rate and the median
     * with eight queries of its own, while `teamPerformance()` computed
     * the same seven for the team. They disagreed by construction: the
     * shared one counts a pull of work from `orderClaimHistory` — «an
     * order released and re-claimed was two pulls of work» — and this one
     * counted `order.claimedById`, the current holder, so a transferred
     * order left the first agent's record entirely.
     */
    // The team table now reaches the calculator through `confirmationTeamAnswer` (lib/confirmation-team-answer.ts — the block moved whole, 18/11, so the drawer of one person reads the same answer); the calculator is still called by name, in ONE place.
    for (const route of [
      'src/app/api/orders/confirmation/performance/route.ts',
      'src/lib/confirmation-team-answer.ts',
    ]) {
      expect(read(route), `${route}: لا يقرأ من الحاسبة المشتركة`).toContain('teamPerformance(');
    }
    for (const route of [
      'src/app/api/orders/confirmation/team/route.ts',
      'src/app/api/orders/confirmation/team/[userId]/route.ts',
    ]) {
      expect(read(route), `${route}: لا يقرأ الجواب المشترك`).toContain('confirmationTeamAnswer(');
    }
    // And the second implementation is pinned ABSENT, not merely unused.
    const perf = read('src/app/api/orders/confirmation/performance/route.ts');
    expect(perf, 'عاد يعدّ السحب من صاحب الطلب الحالي').not.toContain('claimedById: employeeId');
  });
});
