// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE BELL AND THE WORK CHIPS DO NOT ASK ON TOP OF THEIR OWN QUESTION (13/11 — the site's slow-down, plan PR-5).
 *
 * Both poll every minute and on every return to the tab, and both had no floor and no check that the last call had come back.
 * On a server that takes thirty seconds to answer, every open tab of the company asked again at every minute and at every
 * return, and the server finished them all. Now a tick or a return does nothing while the call before it is still out, and two
 * returns to the tab within fifteen seconds are one. A call the person asks for with a press (the bell's «قرأتها») is never held
 * back: she asked.
 *
 * Both are hand-written on purpose and stay so: `MyWork` uses a plain `fetch` (its own comment says why), and neither listens to
 * `focus`, which `useLiveRefresh` does.
 * ═══════════════════════════════════════════════════════════════════════
 */

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

import { NotificationsProvider, useNotifications } from './NotificationsProvider';
import { MyWork } from './MyWork';

/** Make the document look hidden or visible to the handlers (both spellings the two components read). */
function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { value: hidden, configurable: true });
  Object.defineProperty(document, 'visibilityState', { value: hidden ? 'hidden' : 'visible', configurable: true });
}

const comeBack = () => act(() => void document.dispatchEvent(new Event('visibilitychange')));
const pass = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

/** Every request waits until the test answers it. */
const waiting: Array<() => void> = [];
const fetchMock = vi.fn(
  (url: string) =>
    new Promise((resolve) => {
      waiting.push(() => resolve({ ok: true, json: async () => (url.includes('notifications') ? { notifications: [], unreadCount: 0, byRoute: {} } : { items: [] }) }));
    })
);
const answerAll = () => act(async () => void waiting.splice(0).forEach((answer) => answer()));

/** Hands the bell's own `refresh` — the press path — to the test. */
const press: { refresh: () => Promise<void> } = { refresh: async () => undefined };
function Probe() {
  const { refresh } = useNotifications();
  React.useEffect(() => {
    press.refresh = refresh;
  }, [refresh]);
  return null;
}

const SUBJECTS: Array<[string, () => React.ReactElement]> = [
  ['the bell (NotificationsProvider)', () => <NotificationsProvider><Probe /></NotificationsProvider>],
  ['the work chips (MyWork)', () => <MyWork />],
];

beforeEach(() => {
  vi.useFakeTimers();
  setHidden(false);
  waiting.length = 0;
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe.each(SUBJECTS)('%s', (_name, ui) => {
  it('asks once when it opens', () => {
    render(ui());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a TICK while the previous request is unanswered is skipped', async () => {
    render(ui());
    await pass(60_000);
    expect(fetchMock, 'الدقّة بتنتظر الطلب اللي طالع').toHaveBeenCalledTimes(1);
  });

  it('…but not forever: a request that never answers stops blocking after ninety seconds, so it cannot silence the poll', async () => {
    render(ui());
    await pass(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await pass(60_000); // the tick at two minutes: the first request has been out for 120 s
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('and the tick after it answered runs', async () => {
    render(ui());
    await answerAll();
    await pass(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a RETURN to the tab while the previous request is unanswered is skipped', async () => {
    render(ui());
    await pass(20_000);
    comeBack();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('three returns to the tab in a second are ONE request, even though each answered at once — the fifteen-second floor', async () => {
    render(ui());
    await answerAll();
    await pass(20_000);
    comeBack();
    await answerAll();
    comeBack();
    await answerAll();
    comeBack();
    expect(fetchMock).toHaveBeenCalledTimes(2); // the mount, and the first return
  });

  it('and the floor lets go at fifteen seconds, to the millisecond', async () => {
    render(ui());
    await answerAll();
    await pass(20_000);
    comeBack(); // t = 20 s: runs
    await answerAll();
    await pass(14_999);
    comeBack();
    expect(fetchMock, 'قبل الخمسطعش ثانية').toHaveBeenCalledTimes(2);
    await pass(1);
    comeBack();
    expect(fetchMock, 'عند الخمسطعش ثانية').toHaveBeenCalledTimes(3);
  });

  it('nothing is asked while nobody is looking, as before', async () => {
    render(ui());
    await answerAll();
    setHidden(true);
    await pass(120_000);
    comeBack();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('a call the person asked for is never held back', () => {
  it('the bell\'s refresh (what «قرأتها» ends with) asks even while a poll is out', async () => {
    render(<NotificationsProvider><Probe /></NotificationsProvider>);
    expect(fetchMock).toHaveBeenCalledTimes(1); // the poll that opened it, unanswered
    await act(async () => void press.refresh());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('and a poll that finds ITS call out waits for it', async () => {
    render(<NotificationsProvider><Probe /></NotificationsProvider>);
    await answerAll();
    await act(async () => void press.refresh()); // out, from the press
    await pass(60_000); // the tick finds it out
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
