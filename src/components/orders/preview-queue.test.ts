import { describe, expect, it } from 'vitest';
import { PARALLEL_CHECKS } from '@/lib/change-request-review';
import { throttled } from './preview-queue';

/**
 * A LONG QUEUE ASKS THREE AT A TIME — the page never opens forty connections on one second.
 * Tasks here are held open by the test, so what is running at any moment is a fact it can read.
 */

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('the page-wide queue of checks', () => {
  it('runs no more than three at once, however many are asked for, and lets every one finish', async () => {
    let running = 0;
    let peak = 0;
    const open: Array<() => void> = [];
    const task = () =>
      new Promise<void>((resolve) => {
        running += 1;
        peak = Math.max(peak, running);
        open.push(() => {
          running -= 1;
          resolve();
        });
      });

    const all = Array.from({ length: 10 }, () => throttled(task));
    await flush();
    expect(PARALLEL_CHECKS).toBe(3);
    expect(open).toHaveLength(3);

    for (let i = 0; i < 10; i += 1) {
      await flush();
      open.shift()?.();
    }
    await Promise.all(all);
    expect(peak).toBe(3);
    expect(running).toBe(0);
  });

  it('a check that fails frees its place — the ones behind it are not stuck', async () => {
    const results: string[] = [];
    const fail = () => Promise.reject(new Error('فشل'));
    const ok = (name: string) => () => {
      results.push(name);
      return Promise.resolve(name);
    };

    await Promise.allSettled([throttled(fail), throttled(fail), throttled(fail), throttled(fail), throttled(ok('أ')), throttled(ok('ب'))]);
    expect(results).toEqual(['أ', 'ب']);
    // And the queue is empty again: a fresh task starts at once.
    let started = false;
    await throttled(async () => {
      started = true;
    });
    expect(started).toBe(true);
  });

  it('hands back what the task returned', async () => {
    await expect(throttled(async () => 42)).resolves.toBe(42);
  });
});
