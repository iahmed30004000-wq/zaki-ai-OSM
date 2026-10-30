import { describe, expect, it } from 'vitest';
import { FAMILIES, MIN_SAMPLE } from './intelligence';
import { repoFile, stripComments } from './guard-source';

/**
 * FOUR QUESTIONS, AND THE ONE THAT MUST NOT BE GATED.
 *
 * The analysis used to be a single list of rates, and a single gate above
 * it: under `MIN_SAMPLE` orders the whole screen said «not enough data».
 * That was right when every finding was a rate over a sample.
 *
 * It stopped being right when queues were added. «Three orders nobody has
 * pulled, the oldest since the day before yesterday» is a COUNT: it is
 * exactly as true on a store's first day as on its thousandth, and it is
 * the reading somebody most needs on that first day. Hiding it behind a
 * sentence about sample sizes is the analysis failing precisely when it
 * would have been most useful.
 *
 * So: rates stay gated, counts never are, and this file keeps the two
 * apart — because the gate is one line and it is very easy to put back
 * above everything.
 */

const RATE_FAMILIES = ['leak', 'team'];
const COUNT_FAMILIES = ['queue', 'risk'];

describe('the four families', () => {
  it('are the four the screen draws, in the order it draws them', () => {
    expect(FAMILIES.map((f) => f.key)).toEqual(['queue', 'risk', 'leak', 'team']);
  });

  it('and every one has a line saying what it measures', () => {
    for (const f of FAMILIES) {
      expect(f.label.length, `${f.key}: بلا اسم`).toBeGreaterThan(1);
      expect(f.blurb.length, `${f.key}: بلا شرح`).toBeGreaterThan(10);
    }
  });

  it('lead with queues, because that is the tab with something to do today', () => {
    const src = stripComments(repoFile('src/components/screens/IntelligenceScreen.tsx'));
    expect(src).toMatch(/useState<Finding\['family'\]>\(\s*\n?\s*TABS\.some/);
    expect(src, 'التبويب الافتراضي ليس الطوابير').toContain("'queue'");
  });
});

describe('the sample gate', () => {
  it('is per tab, never above the whole screen', () => {
    const src = stripComments(repoFile('src/components/screens/IntelligenceScreen.tsx'));
    /**
     * The shape that must not come back:
     *
     *   data.totalOrders < data.minSample ? (<whole screen is a message>)
     *
     * A per-tab gate reads `needsHistory` first, so the count tabs are
     * never inside the branch.
     */
    const blanket = /\)\s*:\s*data\.totalOrders\s*<\s*data\.minSample\s*\?/.test(src);
    expect(blanket, 'العيّنة تحجب الشاشة كلّها من جديد').toBe(false);
    expect(src, 'لا بوّابة لكلّ تبويب').toContain('needsHistory');
  });

  it('and the tabs declare which of them are rates', () => {
    const src = stripComments(repoFile('src/components/screens/IntelligenceScreen.tsx'));
    for (const key of RATE_FAMILIES) {
      expect(
        new RegExp(`key: '${key}'[^}]*needsHistory: true`).test(src),
        `${key}: نسبة بلا بوّابة عيّنة`
      ).toBe(true);
    }
    for (const key of COUNT_FAMILIES) {
      expect(
        new RegExp(`key: '${key}'[^}]*needsHistory: false`).test(src),
        `${key}: عدد وقد وُضع خلف بوّابة العيّنة`
      ).toBe(true);
    }
  });

  it('and a rate still refuses to speak under the sample', () => {
    // The threshold itself is unchanged: this file is about WHERE it
    // applies, not about lowering it.
    expect(MIN_SAMPLE).toBeGreaterThanOrEqual(8);
  });
});

/**
 * AND THE COUNTS REACH THE DASHBOARD.
 *
 * The analysis existed for a while and almost nobody opened it, because
 * it was three menu levels away and nothing said there was anything in
 * it. The strip is the fix, so it is guarded: the API must return the
 * per-family counts, and the dashboard must render them above its own
 * KPI tiles rather than below them.
 */
describe('the dashboard strip', () => {
  it('gets per-family counts from the API', () => {
    const src = stripComments(repoFile('src/app/api/growth/intelligence/route.ts'));
    expect(src).toContain('byFamily');
    expect(src).toContain('FAMILIES');
  });

  it('sits above the KPI tiles, not under them', () => {
    const src = stripComments(repoFile('src/components/screens/DashboardScreen.tsx'));
    const strip = src.indexOf('<IntelligenceStrip');
    const kpis = src.indexOf('<KpiCard');
    expect(strip, 'الشريط غائب عن اللوحة').toBeGreaterThan(-1);
    expect(strip, 'الشريط تحت المؤشّرات — يُقرأ مرّة في الشهر').toBeLessThan(kpis);
  });

  it('and links each cell to its own tab', () => {
    const src = stripComments(repoFile('src/components/growth/IntelligenceStrip.tsx'));
    expect(src).toContain('/growth/intelligence?tab=');
    // Silence when there is nothing: a row of zeroes every morning is a
    // row people stop seeing.
    expect(src, 'الشريط يظهر ولو بلا شيء').toMatch(/live\.length === 0/);
  });
});
