import { describe, expect, it } from 'vitest';
import { repoFile, stripComments } from './guard-source';
import {
  HEALTH_AR,
  HEALTH_TONES,
  METRICS,
  health,
  healthOf,
  metric,
  withBars,
  worst,
} from './health';

/**
 * «جيّد» AND «ضعيف», MEANING THE SAME THING ON EVERY SCREEN.
 *
 * A screen full of percentages asks every reader to carry the bar in their
 * head: is 62% confirmation good? Is a 14% margin? The owner knows; the
 * agent who opened the screen this morning does not, and neither does the
 * owner at the end of a long day.
 *
 * The employee half of this already existed — `performance-score.ts`, with
 * fixed weights and owner-settable bars, and the rule that a bar «colours
 * the line» and never enters the arithmetic. This is that same rule applied
 * to the business's own figures, in one engine rather than one per screen:
 * if «جيّد» on the dashboard and «جيّد» on the couriers screen come from two
 * pieces of arithmetic, they stop meaning the same thing the first time
 * either is touched.
 */

describe('the verdict', () => {
  const rate = metric('deliveryRate')!;

  it('is good at the bar, not only past it', () => {
    expect(health(rate, 80).tone, 'الحدّ نفسه ليس جيّداً').toBe('good');
    expect(health(rate, 79.9).tone).toBe('ok');
  });

  it('is acceptable between the two lines, and weak below', () => {
    expect(health(rate, 70).tone).toBe('ok');
    expect(health(rate, 60).tone).toBe('ok');
    expect(health(rate, 59).tone).toBe('bad');
  });

  /** Days late, rejection, discount: the same engine, read the other way. */
  it('and reads the other way for a metric where less is better', () => {
    const rej = metric('rejectionRate')!;
    expect(rej.lowerIsBetter).toBe(true);
    expect(health(rej, 10).tone).toBe('good');
    expect(health(rej, 25).tone).toBe('ok');
    expect(health(rej, 40).tone).toBe('bad');
  });

  /**
   * A DELIVERY RATE OVER THREE PARCELS IS NOT A DELIVERY RATE.
   *
   * And «لا يكفي» is said out loud rather than dressed up as a grey
   * «متوسط» — a reader who cannot tell «we are average» from «we do not
   * know» will act on the first.
   */
  it('refuses to judge a sample too small, and says so', () => {
    const v = health(rate, 100, 3);
    expect(v.tone).toBe('unknown');
    expect(v.label).toBe(HEALTH_AR.unknown);
    expect(v.why, 'لا يقول كم العيّنة ولا حدَّها').toContain('3');
    expect(v.why).toContain('10');
  });

  it('and judges a figure that has no sample at all', () => {
    const margin = metric('profitMargin')!;
    expect(margin.minSample).toBeUndefined();
    expect(health(margin, 30).tone).toBe('good');
  });

  it('says nothing rather than guessing when there is no number', () => {
    expect(health(rate, null).tone).toBe('unknown');
    expect(health(rate, undefined).tone).toBe('unknown');
    expect(health(rate, NaN).tone).toBe('unknown');
  });

  /** «ضعيف» tells you nothing. «ضعيف — 41% وحدّ المقبول 50%» tells you what to change. */
  it('and every verdict carries the number and the bar it was judged against', () => {
    for (const value of [95, 70, 40]) {
      const v = health(rate, value, 100);
      expect(v.why, `${value} بلا رقمه`).toContain(String(value));
      expect(v.why.length, 'سببٌ فارغ').toBeGreaterThan(10);
    }
  });

  it('and every tone has an Arabic word', () => {
    for (const t of HEALTH_TONES) expect(HEALTH_AR[t], `${t} بلا ترجمة`).toBeTruthy();
  });
});

describe('the bars', () => {
  /** A bar is a judgement about this shop; the shape of the verdict is not. */
  it('are the owner’s to move, one metric at a time', () => {
    const m = metric('deliveryRate')!;
    const mine = withBars(m, { deliveryRate: { good: 95, ok: 90 } });
    expect(mine.good).toBe(95);
    expect(health(mine, 92).tone, 'البار الخاصّ لم يُطبَّق').toBe('ok');
    // And the shape is untouched: still a rate, still higher-is-better.
    expect(mine.unit).toBe(m.unit);
    expect(mine.lowerIsBetter).toBe(m.lowerIsBetter);
  });

  it('and an unset one keeps the default rather than becoming zero', () => {
    const m = metric('deliveryRate')!;
    // BOTH LINES. A first version checked only `good`, so an override that
    // set `ok` to undefined — the ordinary case of moving one line and not
    // the other — slid through and every value became «جيّد».
    const cases: (Record<string, { good?: number; ok?: number }> | null)[] = [
      { profitMargin: { good: 1 } },
      null,
      { deliveryRate: { good: NaN } },
      { deliveryRate: { good: 90 } },
    ];
    for (const bars of cases) {
      const out = withBars(m, bars);
      expect(out.ok, `حدّ المقبول ضاع مع ${JSON.stringify(bars)}`).toBe(m.ok);
      expect(Number.isFinite(out.good), 'حدّ جيّد صار غير رقم').toBe(true);
    }
    expect(withBars(m, { deliveryRate: { good: 90 } }).good).toBe(90);
  });

  /** Inventing a bar for a figure nobody has a target for is a verdict dressed as a measurement. */
  it('exist only where a business already has an opinion', () => {
    for (const m of METRICS) {
      expect(m.ar, `${m.key} بلا اسم عربيّ`).toBeTruthy();
      expect(m.good, `${m.key} بلا حدّ جيّد`).toBeTypeOf('number');
      expect(m.ok, `${m.key} بلا حدّ مقبول`).toBeTypeOf('number');
      // The two lines must be ordered the way the metric reads.
      if (m.lowerIsBetter) expect(m.good, `${m.key}: حدّاه مقلوبان`).toBeLessThan(m.ok);
      else expect(m.good, `${m.key}: حدّاه مقلوبان`).toBeGreaterThan(m.ok);
    }
  });

  it('and an unknown key is refused rather than judged', () => {
    expect(healthOf('nonsense', 99).tone).toBe('unknown');
  });
});

describe('and the worst one leads', () => {
  /** A row of six chips is six things to read; what somebody wants is the one that is wrong. */
  it('picks weak over acceptable over unknown over good', () => {
    const items = [
      { ar: 'أ', health: health(metric('deliveryRate')!, 90) },
      { ar: 'ب', health: health(metric('deliveryRate')!, 65) },
      { ar: 'ج', health: health(metric('deliveryRate')!, 30) },
    ];
    expect(worst(items)?.ar).toBe('ج');
    expect(worst([])).toBeNull();
  });
});

describe('one engine, not one per screen', () => {
  const chip = () => stripComments(repoFile('src/components/ui/HealthChip.tsx'));
  const dash = () => stripComments(repoFile('src/components/screens/DashboardScreen.tsx'));
  const card = () => stripComments(repoFile('src/components/ui/Card.tsx'));

  it('the chip is the only thing that paints a verdict', () => {
    const src = chip();
    for (const tone of HEALTH_TONES) expect(src, `${tone} بلا لون`).toContain(`${tone}:`);
    expect(src, 'السبب غير معروض ولا حتى كعنوان').toContain('title={health.why}');
  });

  it('and the KPI card takes a verdict rather than computing one', () => {
    const src = card();
    expect(src).toContain('health?: HealthVerdict');
    expect(src).toContain('<HealthChip health={health} />');
    expect(src, 'البطاقة تحسب الحكم بنفسها').not.toContain('healthOf(');
  });

  /**
   * The arrow answers «did it move». A delivery rate can rise three points
   * and still be under the bar, and a green arrow over it is a comforting
   * lie — so the card now carries both, and they are computed apart.
   */
  it('and the dashboard passes one to the figures that have a bar', () => {
    const src = dash();
    expect(src).toContain("healthOf('confirmationRate'");
    expect(src).toContain("healthOf('deliveryRate'");
    expect(src).toContain("healthOf('profitMargin'");
    expect(src).toMatch(/health=\{verdicts\.confirmationRate\}/);
    expect(src).toMatch(/health=\{verdicts\.deliveryRate\}/);
  });

  /** A rate over four orders is not a rate, and the screen has the count. */
  it('handing the sample with the rate, not the rate alone', () => {
    const src = dash();
    expect(src, 'نسبة التأكيد تُحكَم بلا عيّنة').toMatch(
      /healthOf\('confirmationRate', rates\.confirmationRate, counts\.decided \?\? counts\.total\)/
    );
    expect(src, 'نسبة التسليم تُحكَم بلا عيّنة').toMatch(
      /healthOf\('deliveryRate', rates\.deliveryRate, counts\.confirmed\)/
    );
  });

  /**
   * A count of new orders is neither good nor bad. A chip on it would teach
   * people to ignore the chips that mean something.
   */
  // 18/11 (R9): the seven tiles moved from the dashboard to the performance board (`FromTheDashboard`) and are drawn with the kit's
  // `StatTile`; the chip is its caption. Was: `dash()` and `{s.health && (`.
  it('and only the tile that has a bar carries one', () => {
    const src = stripComments(repoFile('src/components/screens/PerformanceScreen.tsx'));
    expect(src).toMatch(/caption=\{s\.health && <HealthChip health=\{s\.health\} \/>\}/);
    const tiles = src.slice(src.indexOf('const statusTiles = ['), src.indexOf('];', src.indexOf('const statusTiles = [')));
    expect((tiles.match(/health:/g) ?? []).length, 'حكمٌ على عددٍ لا بار له').toBe(1);
    expect(tiles).toContain('health: verdicts.rejectionRate');
  });
});
