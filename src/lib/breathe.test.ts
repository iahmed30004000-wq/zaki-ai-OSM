import { describe, expect, it } from 'vitest';
import { breatheEvery } from './breathe';

describe('breatheEvery', () => {
  it('makes a promise on every n-th call and nothing at all on the others', () => {
    const pause = breatheEvery(3);
    const out = [pause(), pause(), pause(), pause(), pause(), pause(), pause()];
    expect(out.map((p) => p !== undefined)).toEqual([false, false, true, false, false, true, false]);
  });

  it('waits two thousand rows when it is not told otherwise', () => {
    const pause = breatheEvery();
    let first = 0;
    for (let i = 1; i <= 2001; i++) {
      if (pause() !== undefined && first === 0) first = i;
    }
    expect(first).toBe(2000);
  });

  it('keeps its own count: two loops do not share a turn', () => {
    const a = breatheEvery(2);
    const b = breatheEvery(2);
    expect([a(), b(), a(), b()].map((p) => p !== undefined)).toEqual([false, false, true, true]);
  });

  it('gives the thread to the work that was already waiting, then carries on', async () => {
    const order: string[] = [];
    const pause = breatheEvery(1);
    setImmediate(() => order.push('somebody else'));
    const turn = pause();
    if (turn) await turn;
    order.push('the loop');
    expect(order).toEqual(['somebody else', 'the loop']);
  });

  it('lets other work run through a long loop, a turn in every thousand rows', async () => {
    let others = 0;
    let going = true;
    const spin = () => {
      if (!going) return;
      others++;
      setImmediate(spin);
    };
    setImmediate(spin);
    const pause = breatheEvery(1000);
    let sum = 0;
    for (let i = 0; i < 10_000; i++) {
      const turn = pause();
      if (turn) await turn;
      sum += i;
    }
    going = false;
    expect(sum).toBe(49_995_000);
    expect(others).toBeGreaterThanOrEqual(9);
  });
});
