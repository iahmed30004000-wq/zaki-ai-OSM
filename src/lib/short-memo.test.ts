import { describe, expect, it, vi } from 'vitest';
import { shortMemo } from './short-memo';

describe('a minute of memory for an expensive read', () => {
  it('the same key inside the minute is read once — and the late askers get the same answer', async () => {
    const memo = shortMemo<number>(60_000, 10);
    const load = vi.fn(async () => 7);
    const [a, b, c] = await Promise.all([memo.get('k', load, 0), memo.get('k', load, 10), memo.get('k', load, 59_999)]);
    expect([a, b, c]).toEqual([7, 7, 7]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('asks that arrive while the read is still on its way wait for it instead of starting their own', async () => {
    const memo = shortMemo<string>(60_000, 10);
    let release!: (v: string) => void;
    const load = vi.fn(() => new Promise<string>((r) => (release = r)));
    const first = memo.get('k', load, 0);
    const second = memo.get('k', load, 5);
    release('done');
    expect(await Promise.all([first, second])).toEqual(['done', 'done']);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('after the minute it reads again', async () => {
    const memo = shortMemo<number>(60_000, 10);
    const load = vi.fn(async () => 1);
    await memo.get('k', load, 0);
    await memo.get('k', load, 60_000);
    expect(load, 'جواب عمره أكتر من دقيقة انعاد').toHaveBeenCalledTimes(2);
  });

  it('NEGATIVE: two scopes never share an answer', async () => {
    const memo = shortMemo<string>(60_000, 10);
    expect(await memo.get('company-a:store-1', async () => 'A', 0)).toBe('A');
    expect(await memo.get('company-b:store-1', async () => 'B', 1), 'جواب متجر انعطى لمتجر ثاني').toBe('B');
  });

  it('NEGATIVE: a read that fails is not remembered — the next ask tries again', async () => {
    const memo = shortMemo<number>(60_000, 10);
    await expect(memo.get('k', async () => Promise.reject(new Error('down')), 0)).rejects.toThrow('down');
    await Promise.resolve();
    expect(memo.size()).toBe(0);
    expect(await memo.get('k', async () => 5, 1)).toBe(5);
  });

  it('is bounded: past the cap the oldest key goes', async () => {
    const memo = shortMemo<number>(60_000, 3);
    for (let i = 0; i < 10; i++) await memo.get(`k${i}`, async () => i, i);
    expect(memo.size()).toBeLessThanOrEqual(3);
    const load = vi.fn(async () => 99);
    await memo.get('k9', load, 20); // the newest is still there
    expect(load).not.toHaveBeenCalled();
    await memo.get('k0', load, 21); // the oldest went
    expect(load).toHaveBeenCalledTimes(1);
  });
});
