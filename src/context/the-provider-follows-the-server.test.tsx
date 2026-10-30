// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import React, { useEffect } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionUser } from '@/types/auth';
import { userCan } from '@/lib/can';
import { stripComments } from '@/lib/guard-source';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { AppProvider, useApp } from './AppContext';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE BROWSER'S COPY OF «WHO AM I» FOLLOWS THE SERVER.
 *
 * The owner: «بعض الأزرار ما بتظهر غير لما أعمل تحديث بكذا مكان».
 *
 * `useState(initialUser)` reads its argument once. Signing in is
 * `router.push('/')` + `router.refresh()` inside the SAME layout, so the
 * provider is never re-mounted: the server sent the new user and React threw
 * it away. `currentUser` stayed `null`, `userCan(null, …)` is false even for
 * the owner, and every button behind it was missing until F5.
 *
 * Display only — the server judges every request. But a button that is not
 * drawn cannot be pressed, and the PREVIOUS account's role drawn for the next
 * person on the tab is a leak of what the screen offers.
 * ═══════════════════════════════════════════════════════════════════════
 */

const person = (over: Partial<SessionUser> = {}): SessionUser => ({
  id: 'u1',
  email: 'a@b.c',
  name: 'سلمى',
  role: 'MANAGER',
  status: 'ACTIVE',
  companyId: 'c1',
  permissions: ['orders.view', 'orders.request_change'],
  ...over,
});

/** What a screen does with the user: draws a button only for whoever may press it. */
let latest: ReturnType<typeof useApp> | null = null;
function Probe() {
  const app = useApp();
  // Kept for the assertions — written after the render, not during it.
  useEffect(() => {
    latest = app;
  });
  return (
    <div>
      <span data-testid="who">{app.currentUser ? `${app.currentUser.id}:${app.currentUser.role}` : 'nobody'}</span>
      {userCan(app.currentUser, 'orders.request_change') && <button type="button">طلب تعديل</button>}
    </div>
  );
}

/** The router's refresh — what the provider asks the SERVER to decide with after a believed 401. */
const refresh = vi.fn();
const tree = (user: SessionUser | null) => (
  <AppRouterContext.Provider value={{ refresh } as never}>
    <AppProvider initialUser={user}>
      <Probe />
    </AppProvider>
  </AppRouterContext.Provider>
);
const mount = (user: SessionUser | null) => render(tree(user));
const again = (view: ReturnType<typeof mount>, user: SessionUser | null) => view.rerender(tree(user));

beforeEach(() => {
  latest = null;
  refresh.mockReset();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('signing in without a page reload', () => {
  it('the server sends the person after the provider is already mounted: the button appears, with no F5', () => {
    const view = mount(null);
    expect(screen.getByTestId('who').textContent).toBe('nobody');
    expect(screen.queryByText('طلب تعديل')).toBeNull();
    // router.refresh(): the layout answers again, this time with the signed-in person
    again(view, person());
    expect(screen.getByTestId('who').textContent).toBe('u1:MANAGER');
    expect(screen.getByText('طلب تعديل')).toBeTruthy();
  });

  it('NEGATIVE (the test of the test): a person without the key still gets no button', () => {
    const view = mount(null);
    again(view, person({ permissions: ['orders.view'] }));
    expect(screen.getByTestId('who').textContent).toBe('u1:MANAGER');
    expect(screen.queryByText('طلب تعديل')).toBeNull();
  });

  it('the owner, who holds everything by role, sees it too', () => {
    const view = mount(null);
    again(view, person({ role: 'SUPER_ADMIN', permissions: [] }));
    expect(screen.getByText('طلب تعديل')).toBeTruthy();
  });
});

describe('another account on the same tab', () => {
  it('the next person never sees the previous one’s role or buttons', () => {
    const view = mount(person({ id: 'boss', role: 'SUPER_ADMIN', permissions: [] }));
    expect(screen.getByText('طلب تعديل')).toBeTruthy();
    again(view, person({ id: 'clerk', role: 'MODERATOR', permissions: ['orders.view'] }));
    expect(screen.getByTestId('who').textContent).toBe('clerk:MODERATOR');
    expect(screen.queryByText('طلب تعديل')).toBeNull();
  });

  it('two accounts with the same role and the same keys are still two people', () => {
    const view = mount(person({ id: 'first' }));
    expect(screen.getByTestId('who').textContent).toBe('first:MANAGER');
    again(view, person({ id: 'second' }));
    expect(screen.getByTestId('who').textContent).toBe('second:MANAGER');
  });

  it('a role changed with the very same keys is still a change', () => {
    const view = mount(person());
    again(view, person({ role: 'ACCOUNTANT' }));
    expect(screen.getByTestId('who').textContent).toBe('u1:ACCOUNTANT');
  });

  it('a changed role or a withdrawn permission reaches the screen when the server says so', () => {
    const view = mount(person());
    expect(screen.getByText('طلب تعديل')).toBeTruthy();
    // one key swapped for another — the same NUMBER of grants, a different set
    again(view, person({ permissions: ['orders.view', 'orders.other'] }));
    expect(screen.queryByText('طلب تعديل')).toBeNull();
    again(view, person({ role: 'ACCOUNTANT', permissions: ['orders.view'] }));
    expect(screen.getByTestId('who').textContent).toBe('u1:ACCOUNTANT');
  });

  it('the same permissions in another order are not a change', () => {
    const first = person({ permissions: ['a.b', 'orders.request_change'] });
    const view = mount(first);
    const before = latest?.currentUser;
    again(view, person({ permissions: ['orders.request_change', 'a.b'] }));
    expect(latest?.currentUser).toBe(before);
  });
});

describe('what the server sends again, unchanged, does not overwrite what a screen set', () => {
  it('router.refresh() brings a NEW object with the SAME content: the local copy stands', () => {
    const view = mount(person());
    act(() => latest?.setCurrentUser(person({ tourDoneAt: '2026-10-30T10:00:00.000Z' })));
    expect(latest?.currentUser?.tourDoneAt).toBe('2026-10-30T10:00:00.000Z');
    again(view, person());
    expect(latest?.currentUser?.tourDoneAt).toBe('2026-10-30T10:00:00.000Z');
  });

  it('signing out: the server sends nobody, and the buttons go', () => {
    const view = mount(person());
    again(view, null);
    expect(screen.getByTestId('who').textContent).toBe('nobody');
    expect(screen.queryByText('طلب تعديل')).toBeNull();
  });
});

describe('coming back to the tab re-reads the permissions', () => {
  const answer = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fetchMock = vi.fn();
  let clock = 1_000_000;
  const comeBack = (afterMs: number) => {
    clock += afterMs;
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
  };

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    clock = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
  });

  it('a permission granted while the tab was open shows the button on coming back', async () => {
    fetchMock.mockResolvedValue(answer(200, { user: person() }));
    mount(person({ permissions: ['orders.view'] }));
    expect(screen.queryByText('طلب تعديل')).toBeNull();
    comeBack(61_000);
    await waitFor(() => expect(screen.getByText('طلب تعديل')).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/auth/me');
  });

  it('a permission withdrawn takes the button away', async () => {
    fetchMock.mockResolvedValue(answer(200, { user: person({ permissions: ['orders.view'] }) }));
    mount(person());
    expect(screen.getByText('طلب تعديل')).toBeTruthy();
    comeBack(61_000);
    await waitFor(() => expect(screen.queryByText('طلب تعديل')).toBeNull());
  });

  it('not more than once a minute — however often the window is raised', async () => {
    fetchMock.mockResolvedValue(answer(200, { user: person() }));
    mount(person());
    comeBack(10_000);
    comeBack(10_000);
    comeBack(10_000);
    expect(fetchMock).not.toHaveBeenCalled();
    comeBack(40_000);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    comeBack(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('an unchanged answer costs no new object — nothing re-renders for nothing', async () => {
    fetchMock.mockResolvedValue(answer(200, { user: person() }));
    mount(person());
    const before = latest?.currentUser;
    comeBack(61_000);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await act(async () => undefined);
    expect(latest?.currentUser).toBe(before);
  });

  it('a different account answering (another tab signed in as somebody else) is adopted: the screen never keeps the old role', async () => {
    fetchMock.mockResolvedValue(
      answer(200, { user: person({ id: 'clerk', role: 'MODERATOR', permissions: ['orders.view'] }) })
    );
    mount(person({ id: 'boss', role: 'SUPER_ADMIN', permissions: [] }));
    expect(screen.getByText('طلب تعديل')).toBeTruthy();
    comeBack(61_000);
    await waitFor(() => expect(screen.getByTestId('who').textContent).toBe('clerk:MODERATOR'));
    expect(screen.queryByText('طلب تعديل')).toBeNull();
  });

  /** The two seconds a 401 waits before it is believed — real time, the retry is a plain timer. */
  const slow = { timeout: 6000 };

  it('a 401 that is only a hiccup (the second ask answers) does not take the buttons away', async () => {
    fetchMock.mockResolvedValueOnce(answer(401, { user: null })).mockResolvedValueOnce(answer(200, { user: person() }));
    mount(person());
    comeBack(61_000);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2), slow);
    await act(async () => undefined);
    expect(screen.getByText('طلب تعديل')).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('a 401 asked twice (signed out elsewhere) empties the screen — and asks the server to decide', async () => {
    fetchMock.mockResolvedValue(answer(401, { user: null }));
    mount(person());
    comeBack(61_000);
    await waitFor(() => expect(screen.getByTestId('who').textContent).toBe('nobody'), slow);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('طلب تعديل')).toBeNull();
  });

  it('401 and then the SAME account signs in again (same signature): the person comes back, with no remount', async () => {
    fetchMock.mockResolvedValue(answer(401, { user: null }));
    const view = mount(person());
    comeBack(61_000);
    await waitFor(() => expect(screen.getByTestId('who').textContent).toBe('nobody'), slow);
    // router.refresh(): the layout answers again — a fresh object with the very same content
    again(view, person());
    expect(screen.getByTestId('who').textContent).toBe('u1:MANAGER');
    expect(screen.getByText('طلب تعديل')).toBeTruthy();
  });

  it('and a screen emptied by a wrong 401 is not stuck until F5: the next return reads the user back', async () => {
    fetchMock.mockResolvedValueOnce(answer(401, { user: null })).mockResolvedValueOnce(answer(401, { user: null }));
    mount(person());
    comeBack(61_000);
    await waitFor(() => expect(screen.getByTestId('who').textContent).toBe('nobody'), slow);
    fetchMock.mockResolvedValue(answer(200, { user: person() }));
    comeBack(61_000);
    await waitFor(() => expect(screen.getByTestId('who').textContent).toBe('u1:MANAGER'));
    expect(screen.getByText('طلب تعديل')).toBeTruthy();
  });

  it('an old answer for account A, arriving after account B was adopted, is dropped', async () => {
    let late!: (r: Response) => void;
    fetchMock.mockReturnValue(
      new Promise<Response>((resolve) => {
        late = resolve;
      })
    );
    const view = mount(person({ id: 'a', role: 'MANAGER' }));
    comeBack(61_000);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // meanwhile the tab signs in as somebody else
    again(view, person({ id: 'b', role: 'ACCOUNTANT', permissions: ['orders.view'] }));
    expect(screen.getByTestId('who').textContent).toBe('b:ACCOUNTANT');
    await act(async () => late(answer(200, { user: person({ id: 'a', role: 'MANAGER' }) })));
    expect(screen.getByTestId('who').textContent).toBe('b:ACCOUNTANT');
    expect(screen.queryByText('طلب تعديل')).toBeNull();
  });

  it('a 500, or a dropped connection, is not «signed out»: the buttons stay', async () => {
    fetchMock.mockResolvedValue(answer(500, { error: 'x' }));
    mount(person());
    comeBack(61_000);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await act(async () => undefined);
    expect(screen.getByText('طلب تعديل')).toBeTruthy();
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    comeBack(61_000);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await act(async () => undefined);
    expect(screen.getByText('طلب تعديل')).toBeTruthy();
  });

  it('nobody is signed in (the sign-in pages): nothing is asked at all', () => {
    mount(null);
    comeBack(61_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the source never goes back to reading the user once', () => {
  const source = stripComments(readFileSync(join(process.cwd(), 'src', 'context', 'AppContext.tsx'), 'utf8'));

  it('the state follows the prop: the server’s user is compared and adopted, not just read at mount', () => {
    expect(source).toMatch(/useState<SessionUser \| null>\(initialUser/);
    // the adoption: a remembered signature and a set during render when it differs
    expect(source).toMatch(/signatureOf\(initialUser\) !== signatureOf\(seenProp\)/);
    expect(source).toMatch(/if \(initialUser !== seenProp\)/);
    expect(source).toMatch(/setCurrentUser\(initialUser \|\| null\)/);
  });

  it('and the return listener is the shared hook, not a second copy of the events', () => {
    expect(source).toContain('useLiveRefresh(');
    expect(source).not.toMatch(/addEventListener\(['"](?:visibilitychange|focus|online)/);
  });
});
