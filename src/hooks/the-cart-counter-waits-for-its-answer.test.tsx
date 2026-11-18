// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

/**
 * THE CART COUNTER IN THE MENU DOES NOT ASK ON TOP OF ITS OWN QUESTION (H2, 18/11 — cause 10 of the hang; the rule of
 * `the-header-polls-wait-for-their-answer.test.tsx`). It asks once a minute; on a server that takes longer than a minute to answer, every
 * open tab asked again at every tick and the server finished them all. Now a tick does nothing while the read before it is still out,
 * and the next tick after the answer asks as before. The interval is unchanged.
 */

const waiting: Array<() => void> = [];
const apiFetch = vi.fn(
  () =>
    new Promise((resolve) => {
      waiting.push(() => resolve({ ok: true, json: async () => ({ new: 4 }) }));
    })
);
vi.mock('@/lib/api-client', () => ({ apiFetch: () => apiFetch() }));

import { useNewCartsCount } from './useNewCartsCount';

const pass = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const answerAll = () => act(async () => void waiting.splice(0).forEach((answer) => answer()));

beforeEach(() => {
  vi.useFakeTimers();
  waiting.length = 0;
  apiFetch.mockClear();
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the cart counter', () => {
  it('asks once when it opens', () => {
    renderHook(() => useNewCartsCount(true));
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('two ticks while the first answer is still out: still ONE request in flight', async () => {
    renderHook(() => useNewCartsCount(true));
    await pass(60_000);
    await pass(60_000);
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('once the answer is in, the next tick asks again — and the number is shown', async () => {
    const { result } = renderHook(() => useNewCartsCount(true));
    await answerAll();
    expect(result.current).toBe(4);
    await pass(60_000);
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it('a failed read lets the next tick ask', async () => {
    apiFetch.mockImplementationOnce(() => Promise.reject(new Error('down')));
    renderHook(() => useNewCartsCount(true));
    await pass(0);
    await pass(60_000);
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it('closed (no key): never asks', async () => {
    renderHook(() => useNewCartsCount(false));
    await pass(120_000);
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
