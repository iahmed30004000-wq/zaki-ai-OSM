import { describe, expect, it, vi } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE FIFTEEN JOBS, PINNED BY NAME, INTERVAL, CLOCK TIME AND ORDER.
 *
 * `definitions.ts` was one file of 991 lines and is now one file per job. A
 * split that quietly dropped a job from the list, or retimed one, would run
 * green everywhere else: the run log is keyed by name (a renamed job looks
 * like a job that never ran), and the interval is what the watchdog judges
 * lateness by. So the whole table is written out here, in the order the
 * worker has always walked it, and a change to any cell fails by name.
 *
 * Changing one on purpose means changing this table in the same commit.
 */

const { db } = vi.hoisted(() => ({ db: { jobRun: { findFirst: vi.fn(), findMany: vi.fn() } } }));
vi.mock('../db', () => ({ db, default: db }));

import { JOBS, jobByName } from './definitions';

/** name · everySeconds · at — the order IS the order of `JOBS`. */
const PINNED: Array<[string, number, string | undefined]> = [
  ['watchdog', 300, undefined],
  ['daily-backup', 86_400, '03:00'],
  ['sync-courier-status', 120, undefined],
  ['release-stale-claims', 300, undefined],
  ['surface-postponed', 86_400, '08:00'],
  ['stale-returns', 86_400, '09:00'],
  ['closing-reminder', 86_400, '16:45'],
  ['accrue-commission', 86_400, '23:00'],
  ['accrue-period-commission', 3_600, undefined],
  ['deliver-app-events', 60, undefined],
  ['deliver-conversions', 60, undefined],
  ['propose-penalties', 86_400, '07:00'],
  ['escalate-change-requests', 60, undefined],
  ['pull-ad-spend', 86_400, '06:00'],
  ['reserve-returning-customers', 120, undefined],
];

describe('the jobs table', () => {
  it('has exactly these jobs, in this order, with these intervals and clock times', () => {
    expect(JOBS.map((j) => [j.name, j.everySeconds, j.at])).toEqual(PINNED);
  });

  it('finds each one by its name, and finds nothing for a name that is not one', () => {
    for (const [name] of PINNED) expect(jobByName(name)?.name).toBe(name);
    expect(jobByName('no-such-job')).toBeUndefined();
  });

  it('gives every job a description and a run', () => {
    for (const job of JOBS) {
      expect(job.description, job.name).toMatch(/\S/);
      expect(typeof job.run, job.name).toBe('function');
    }
  });
});

describe('one file per job', () => {
  const folder = join(process.cwd(), 'src/lib/jobs/definitions');
  const files = readdirSync(folder)
    .filter((f) => f.endsWith('.ts') && !f.includes('.test.'))
    .map((f) => f.replace(/\.ts$/, ''))
    .sort();

  it('has a file named after each job, plus the gathering file and the shared helpers', () => {
    expect(files).toEqual([...PINNED.map(([name]) => name), 'index', 'shared'].sort());
  });
});
