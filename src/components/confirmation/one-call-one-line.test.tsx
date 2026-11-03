// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useOutbox, type SendAnswer } from './useCallOutcome';
import { OUTBOX_KEY, readOutbox, writeOutbox, type Outgoing } from '@/lib/call-outcome';

/**
 * ONE CALL, ONE LINE IN THE LOG — the outbox of the «شو صار؟» sheet, held where a second line could slip in:
 *   · «تراجع» refused once the send has left (it is in flight, or waiting for the line);
 *   · a second answer for the same call refused once the first can no longer be taken back;
 *   · two desk tabs on one phone: only one of them sends (a lease without `navigator.locks`, the lock with it);
 *   · the mark written BEFORE the send, so a tab that dies mid-send leaves a mark the next one reads as «ask first».
 */

const clock = { now: 1_800_000_000_000 };
const item = (over: Partial<Outgoing> = {}): Omit<Outgoing, 'sendAt'> => ({
  key: 'o-1:1800000000000',
  userId: 'u1',
  orderId: 'o-1',
  orderNumber: 'SY-1',
  door: 'attempt',
  body: '{"contactMethod":"PHONE","result":"NO_ANSWER"}',
  result: 'NO_ANSWER',
  label: 'ما رد',
  startedAt: clock.now,
  ...over,
});
const tick = async (ms = 1_100) => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
};

beforeEach(() => {
  clock.now = 1_800_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => clock.now);
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => true });
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (window.navigator as { locks?: unknown }).locks;
});

describe('«تراجع» and a second answer, once the send has left', () => {
  it('in flight: «تراجع» takes nothing back, and a second answer for the same call is refused', async () => {
    let release!: (a: SendAnswer) => void;
    const send = vi.fn(() => new Promise<SendAnswer>((r) => (release = r)));
    const { result } = renderHook(() => useOutbox('u1', send));
    act(() => {
      expect(result.current.add(item())).toBe(true);
    });
    clock.now += 6_000;
    await tick();
    expect(send).toHaveBeenCalledTimes(1);
    // the line is slow: the POST is still open
    expect(JSON.parse(window.localStorage.getItem(OUTBOX_KEY)!)[0].inFlight).toBe(true);
    act(() => {
      expect(result.current.undo(item().key)).toBe(false);
      expect(result.current.add(item({ body: '{"contactMethod":"PHONE","result":"BUSY"}', result: 'BUSY', label: 'مشغول' }))).toBe(false);
    });
    await act(async () => {
      release('sent');
      await Promise.resolve();
    });
    await tick(50);
    expect(send).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(OUTBOX_KEY)).toBeNull();
    // and after it left, the same call takes no second answer either
    act(() => {
      expect(result.current.add(item({ result: 'BUSY' }))).toBe(false);
    });
  });

  it('waiting for the line: no «تراجع» either', async () => {
    const send = vi.fn(async (): Promise<SendAnswer> => 'network');
    const { result } = renderHook(() => useOutbox('u1', send));
    act(() => {
      result.current.add(item());
    });
    clock.now += 6_000;
    await tick();
    expect(readOutbox('u1')[0].uncertain).toBe(true);
    act(() => {
      expect(result.current.undo(item().key)).toBe(false);
    });
  });

  it('inside the five seconds «تراجع» still works, and a changed answer replaces the first', async () => {
    const send = vi.fn(async (): Promise<SendAnswer> => 'sent');
    const { result } = renderHook(() => useOutbox('u1', send));
    act(() => {
      result.current.add(item());
      expect(result.current.add(item({ result: 'BUSY', label: 'مشغول' }))).toBe(true);
    });
    expect(readOutbox('u1').map((o) => o.result)).toEqual(['BUSY']);
    act(() => {
      expect(result.current.undo(item().key)).toBe(true);
    });
    clock.now += 6_000;
    await tick();
    expect(send).not.toHaveBeenCalled();
  });
});

describe('a tab that died mid-send', () => {
  it('leaves its mark in storage, and the next tab asks the log before sending', async () => {
    // What a killed tab leaves: the item marked as on its way.
    writeOutbox('u1', [{ ...item(), sendAt: clock.now - 1_000, inFlight: true }]);
    const send = vi.fn(async (o: Outgoing): Promise<SendAnswer> => {
      expect(o.uncertain, 'sent without asking the log first').toBe(true);
      return 'sent';
    });
    renderHook(() => useOutbox('u1', send));
    await tick();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].uncertain).toBe(true);
  });
});

describe('two desk tabs on one phone', () => {
  const twoTabs = async () => {
    let release!: (a: SendAnswer) => void;
    const sends: string[] = [];
    const send = (tab: string) =>
      vi.fn((o: Outgoing) => {
        sends.push(`${tab}:${o.key}`);
        return new Promise<SendAnswer>((r) => (release = r));
      });
    writeOutbox('u1', [{ ...item(), sendAt: clock.now - 1_000 }]);
    renderHook(() => useOutbox('u1', send('a')));
    renderHook(() => useOutbox('u1', send('b')));
    await tick();
    await tick();
    expect(sends).toHaveLength(1);
    await act(async () => {
      release('sent');
      await Promise.resolve();
    });
    await tick();
    await tick();
    return sends;
  };

  it('without `navigator.locks`: the lease lets one of them send, once', async () => {
    expect((window.navigator as { locks?: unknown }).locks).toBeUndefined();
    expect(await twoTabs()).toHaveLength(1);
    expect(window.localStorage.getItem(OUTBOX_KEY)).toBeNull();
  });

  it('with `navigator.locks`: the lock lets one of them send, once', async () => {
    let held = false;
    const request = vi.fn(async (_name: string, _o: { ifAvailable: boolean }, cb: (lock: unknown) => Promise<unknown>) => {
      if (held) return cb(null);
      held = true;
      try {
        return await cb({});
      } finally {
        held = false;
      }
    });
    Object.defineProperty(window.navigator, 'locks', { configurable: true, value: { request } });
    expect(await twoTabs()).toHaveLength(1);
    expect(request).toHaveBeenCalled();
  });
});
