import { describe, expect, it } from 'vitest';
import { pullAdSpend } from './definitions/pull-ad-spend';
import { pullAdSpendNight } from './definitions/pull-ad-spend-night';
import { JOBS } from './definitions';
import { isDue } from './schedule';

/**
 * «سحب الإنفاق بعد منتصف الليل» (the owner, 17/11): the media buyer's night round (00:35, Asia/Amman) judges the last three COMPLETE days,
 * so yesterday's spend must already be whole by then. The 06:00 pull is six hours too late for that; it stays, and a second one runs at 00:10.
 */

describe('the night pull of ad spend', () => {
  it('is the same pull as the morning one, at 00:10 on Amman’s clock, a job of its own', () => {
    expect(pullAdSpendNight).toMatchObject({ name: 'pull-ad-spend-night', everySeconds: 86_400, at: '00:10', timezone: 'Asia/Amman' });
    expect(pullAdSpendNight.run).toBe(pullAdSpend.run);
    expect(JOBS).toContain(pullAdSpendNight);
    expect(JOBS.filter((j) => j.name === 'pull-ad-spend-night')).toHaveLength(1);
  });

  it('and the 06:00 pull stays exactly as it was', () => {
    expect(pullAdSpend).toMatchObject({ name: 'pull-ad-spend', everySeconds: 86_400, at: '06:00' });
    expect(JOBS).toContain(pullAdSpend);
  });

  it('is due from 00:10 in Amman (21:10 UTC) and not a minute before', () => {
    expect(isDue(pullAdSpendNight, null, new Date('2026-11-17T21:09:00Z'))).toBe(false);
    expect(isDue(pullAdSpendNight, null, new Date('2026-11-17T21:10:00Z'))).toBe(true);
  });

  it('runs once a night: after its run at 00:11 it is not due again until the next midnight', () => {
    const ranAt = new Date('2026-11-17T21:11:00Z'); // 00:11 on the 18th in Amman
    expect(isDue(pullAdSpendNight, ranAt, new Date('2026-11-18T03:00:00Z'))).toBe(false); // 06:00 in Amman
    expect(isDue(pullAdSpendNight, ranAt, new Date('2026-11-18T20:00:00Z'))).toBe(false); // 23:00 the same day
    expect(isDue(pullAdSpendNight, ranAt, new Date('2026-11-18T21:10:00Z'))).toBe(true); // the next 00:10
  });

  it('and one run does not cancel the other: the morning pull is still due after the night one ran', () => {
    const nightRan = new Date('2026-11-17T21:11:00Z'); // 00:11 Amman on the 18th
    // 06:00 Amman on the 18th: the morning job (in the scheduler's own zone, Damascus — the same +03:00 in November) has not run today.
    expect(isDue(pullAdSpend, null, new Date('2026-11-18T03:00:00Z'))).toBe(true);
    expect(isDue(pullAdSpend, new Date('2026-11-17T03:00:30Z'), new Date('2026-11-18T03:00:00Z'))).toBe(true);
    expect(nightRan.getTime()).toBeLessThan(new Date('2026-11-18T03:00:00Z').getTime());
  });
});
