// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useLiveRefresh } from './useLiveRefresh';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE HOOK ITSELF, DRIVEN — NOT READ.
 *
 * `a-screen-left-open-goes-stale.test.ts` holds the RULE: every screen
 * that fetches says how it stays true. This holds the BEHAVIOUR: that
 * coming back to the screen actually asks the server again, and that
 * doing so three ways in one second does not ask three times.
 *
 * It matters that this is driven rather than read. The three screens
 * that wrote this by hand all passed a source-reading check — and all
 * three missed `focus`, so alt-tabbing back to the window refreshed
 * nothing anywhere, for months. A guard that reads the source would have
 * agreed with them.
 * ═══════════════════════════════════════════════════════════════════════
 */

/** Make the document look hidden or visible to the handlers. */
function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { value: hidden, configurable: true });
  Object.defineProperty(document, 'visibilityState', {
    value: hidden ? 'hidden' : 'visible',
    configurable: true,
  });
}

const comeBack = (event: 'visibilitychange' | 'focus' | 'online') => {
  act(() => {
    if (event === 'visibilitychange') document.dispatchEvent(new Event('visibilitychange'));
    else window.dispatchEvent(new Event(event));
  });
};

describe('coming back to a screen asks the server again', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setHidden(false);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Past the throttle, so the next trigger is not swallowed by it. */
  const wait = (ms = 5_000) => act(() => void vi.advanceTimersByTime(ms));

  it('loads once on mount, before anything has happened', () => {
    const load = vi.fn();
    renderHook(() => useLiveRefresh(load));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('and again when the TAB is returned to', () => {
    const load = vi.fn();
    renderHook(() => useLiveRefresh(load));
    wait();
    comeBack('visibilitychange');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('and again when the WINDOW is returned to — the one all three copies missed', () => {
    /*
     * Alt-tab to another application and back fires `focus` and NOT
     * `visibilitychange`. That is most of a working day on a desk, and
     * the dashboard, the orders list and the inbox all listened for the
     * other one only.
     */
    const load = vi.fn();
    renderHook(() => useLiveRefresh(load));
    wait();
    comeBack('focus');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('and when the connection comes back', () => {
    const load = vi.fn();
    renderHook(() => useLiveRefresh(load));
    wait();
    comeBack('online');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('but NOT when the tab is being left', () => {
    // `visibilitychange` fires on the way out too. Refreshing then is a
    // request for a screen nobody is looking at.
    const load = vi.fn();
    renderHook(() => useLiveRefresh(load));
    wait();
    setHidden(true);
    comeBack('visibilitychange');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('and three triggers in one second ask ONCE', () => {
    /*
     * Raising a tab fires `visibilitychange` and `focus` together, and a
     * person moving between windows fires them repeatedly. Without the
     * floor, every open screen would ask the server several times a
     * second.
     */
    const load = vi.fn();
    renderHook(() => useLiveRefresh(load));
    wait();
    comeBack('focus');
    comeBack('visibilitychange');
    comeBack('online');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('and the throttle lets go again after the gap', () => {
    const load = vi.fn();
    renderHook(() => useLiveRefresh(load));
    wait();
    comeBack('focus');
    wait();
    comeBack('focus');
    expect(load).toHaveBeenCalledTimes(3);
  });
});

describe('the timer, and who it costs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setHidden(false);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ticks while somebody is looking', () => {
    const load = vi.fn();
    renderHook(() => useLiveRefresh(load, { everyMs: 10_000 }));
    act(() => void vi.advanceTimersByTime(35_000));
    expect(load).toHaveBeenCalledTimes(4); // mount + three ticks
  });

  it('and stops while nobody is', () => {
    // A background tab that keeps asking is a phone's battery and a
    // server's load for a screen nobody is reading.
    const load = vi.fn();
    renderHook(() => useLiveRefresh(load, { everyMs: 10_000 }));
    setHidden(true);
    act(() => void vi.advanceTimersByTime(60_000));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('and there is no timer unless one was asked for', () => {
    const load = vi.fn();
    renderHook(() => useLiveRefresh(load));
    act(() => void vi.advanceTimersByTime(10 * 60_000));
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe('what the screen controls', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setHidden(false);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a changed key reloads — that is how a filter still works', () => {
    /*
     * The loader is deliberately not a dependency, so a screen whose
     * `useCallback` closes over a filter has to say which filter. Without
     * this, typing in a search box would stop asking the server — the
     * regression this option exists to prevent.
     */
    const load = vi.fn();
    const { rerender } = renderHook(({ k }: { k: string }) => useLiveRefresh(load, { key: k }), {
      initialProps: { k: 'a' },
    });
    expect(load).toHaveBeenCalledTimes(1);
    rerender({ k: 'b' });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('and the same key does not', () => {
    const load = vi.fn();
    const { rerender } = renderHook(({ k }: { k: string }) => useLiveRefresh(load, { key: k }), {
      initialProps: { k: 'a' },
    });
    rerender({ k: 'a' });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('and `enabled: false` runs nothing at all', () => {
    const load = vi.fn();
    renderHook(() => useLiveRefresh(load, { enabled: false, everyMs: 1_000 }));
    act(() => void vi.advanceTimersByTime(60_000));
    comeBack('focus');
    expect(load).not.toHaveBeenCalled();
  });

  it('and the LATEST loader is the one called, not the one from mount', () => {
    /*
     * The listeners are attached once, so a loader read through the
     * closure would be the first one forever — and a screen whose filter
     * changed would refresh the old query.
     */
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ fn }: { fn: () => void }) => useLiveRefresh(fn), {
      initialProps: { fn: first },
    });
    rerender({ fn: second });
    wait2();
    comeBack('focus');
    expect(second).toHaveBeenCalled();
    expect(first).toHaveBeenCalledTimes(1); // the mount load only
  });
});

/** Local helper for the block above, which has no `wait` in scope. */
function wait2(ms = 5_000) {
  act(() => void vi.advanceTimersByTime(ms));
}

describe('a screen that loads itself', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setHidden(false);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is not loaded a second time on mount', () => {
    /*
     * A screen with a debounced search box loads itself 250ms after a
     * keystroke. The hook firing as well is two requests for the same
     * rows — and the second answer lands after the clerk has ticked
     * them, replacing the rows and emptying the selection. Measured:
     * «إنشاء شحنة (3)» became «(0)».
     */
    const load = vi.fn();
    renderHook(() => useLiveRefresh(load, { initial: false }));
    expect(load).not.toHaveBeenCalled();
  });

  it('but still refreshes when the person comes back', () => {
    // Skipping the first load must not switch the hook off — that is the
    // whole reason the screen has it.
    const load = vi.fn();
    renderHook(() => useLiveRefresh(load, { initial: false }));
    wait2();
    comeBack('focus');
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe('a screen that wants to know it was returned to', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setHidden(false);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is told on every way back — tab, window, connection — even when the throttle swallows the refresh', () => {
    const load = vi.fn();
    const back = vi.fn();
    renderHook(() => useLiveRefresh(load, { onReturn: back }));
    // inside the throttle window of the mount load: the refresh is swallowed, the notice is not
    comeBack('focus');
    comeBack('visibilitychange');
    comeBack('online');
    expect(back).toHaveBeenCalledTimes(3);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('NEGATIVE: not told while the tab is hidden', () => {
    const back = vi.fn();
    renderHook(() => useLiveRefresh(vi.fn(), { onReturn: back }));
    setHidden(true);
    comeBack('focus');
    expect(back).not.toHaveBeenCalled();
  });

  it('and the LATEST callback is the one called, not the one from mount', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ cb }) => useLiveRefresh(vi.fn(), { onReturn: cb }), { initialProps: { cb: first } });
    rerender({ cb: second });
    comeBack('focus');
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
