// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * «اسحب الطلب التالي» IS AT THE TOP OF «طلباتي» — AND PULLING LEAVES HER THERE.
 *
 * The pull lived on `/confirmation/queue`. Pressing it sent the agent to
 * «طلباتي»; the empty desk there sent her back. Queue → mine → queue was the
 * agent's whole day. These render the desk and press the panel:
 *
 *   · somebody who may pull sees the panel; somebody who may not sees none, and
 *     the queue door is never asked for them (it answers 403);
 *   · pressing it pulls and the DESK reloads in place — no navigation;
 *   · what she holds changing (a confirmation) reloads the pool's caps too.
 */

const { api, push, params, user } = vi.hoisted(() => ({
  api: vi.fn(),
  push: vi.fn(),
  params: { current: new URLSearchParams() },
  user: { current: { id: 'u1', name: 'سارة', role: 'CONFIRMATION_AGENT', permissions: ['confirmation.work', 'confirmation.pull'], status: 'ACTIVE' } as Record<string, unknown> },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
  usePathname: () => '/confirmation/mine',
  useSearchParams: () => params.current,
}));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ currentUser: user.current, t: {}, locale: 'ar' }),
}));
// Runs the loader ONCE on mount, like the real hook — the desk hands it a new inline
// function on every render, and an effect keyed on that would reload on every render
// and hide whether the pull reloads anything.
vi.mock('@/hooks/useLiveRefresh', () => ({
  useLiveRefresh: (load: () => Promise<unknown>) => {
    const latest = React.useRef(load);
    latest.current = load;
    React.useEffect(() => {
      void latest.current();
    }, []);
  },
}));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => <h1>طلباتي</h1> }));
vi.mock('@/components/orders/CustomerHistory', () => ({ CustomerHistoryButton: () => null }));
vi.mock('@/components/orders/ContactButtons', () => ({ ContactButtons: () => null }));
vi.mock('@/components/orders/OrderDetailModal', () => ({ OrderDetailModal: () => null }));
vi.mock('./confirmation/ActionDialogs', () => ({
  ChangeRequestDialog: () => null,
  IssueDialog: () => null,
  PostponeDialog: () => null,
  RejectDialog: () => null,
}));
vi.mock('./confirmation/AssistantDialog', () => ({ AssistantDialog: () => null }));
vi.mock('@/components/screens/ConfirmationPostponedScreen', () => ({
  ConfirmationPostponedScreen: ({ embedded }: { embedded?: boolean }) => (
    <div data-testid="postponed-list" data-embedded={String(!!embedded)} />
  ),
}));

import { ConfirmationMineScreen } from './ConfirmationMineScreen';

const EMPTY_DESK = {
  leadDays: 2,
  waitingLater: 0,
  noAnswerLimit: 3,
  serverNow: '2026-10-24T08:00:00.000Z',
  work: [],
  noAnswer: [],
  closedToday: [],
  confirmed: { day: '', q: '', page: 1, pageSize: 25, total: 0, pages: 1, rows: [] },
};
const POOL = {
  waiting: 5,
  owned: { total: 0, withoutAttempt: 0 },
  caps: { withoutAttempt: 3, total: 10 },
  leadDays: 2,
  canPull: true,
  refusal: null,
  autoReleased: 0,
  orders: null,
};

const calls = (prefix: string, method?: string) =>
  api.mock.calls.filter((c) => String(c[0]).startsWith(prefix) && ((c[1] as RequestInit | undefined)?.method ?? 'GET') === (method ?? 'GET'));

beforeEach(() => {
  vi.clearAllMocks();
  params.current = new URLSearchParams();
  user.current = { id: 'u1', name: 'سارة', role: 'CONFIRMATION_AGENT', permissions: ['confirmation.work', 'confirmation.pull'], status: 'ACTIVE' };
  api.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST' && url === '/api/confirmation/pull') return { ok: true };
    if (url.startsWith('/api/confirmation/mine')) return EMPTY_DESK;
    if (url === '/api/confirmation/queue') return POOL;
    throw new Error(`unexpected ${init?.method ?? 'GET'} ${url}`);
  });
});
afterEach(cleanup);

describe('«طلباتي» — the pull panel', () => {
  it('is drawn for somebody who may pull, with the pool beside the empty desk', async () => {
    render(<ConfirmationMineScreen />);
    await screen.findByText('طلب جاهز للسحب الآن');
    expect(screen.getByText('5')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'اسحب الطلب التالي' })).toBeTruthy();
  });

  it('pulling reloads the DESK in place — she is not sent anywhere', async () => {
    render(<ConfirmationMineScreen />);
    await screen.findByText('طلب جاهز للسحب الآن');
    await waitFor(() => expect(calls('/api/confirmation/mine').length).toBeGreaterThan(0));
    // let the mount's own loads finish, so the count below is only what the PULL causes
    await new Promise((r) => setTimeout(r, 60));
    const before = calls('/api/confirmation/mine').length;
    fireEvent.click(screen.getByRole('button', { name: 'اسحب الطلب التالي' }));
    await waitFor(() => expect(calls('/api/confirmation/pull', 'POST')).toHaveLength(1));
    await waitFor(() => expect(calls('/api/confirmation/mine').length).toBeGreaterThan(before));
    expect(push, 'السحب نقلها لشاشة ثانية').not.toHaveBeenCalled();
  });

  it('NEGATIVE: somebody who may not pull gets no panel and the queue door is never asked', async () => {
    user.current = { ...user.current, permissions: ['confirmation.work'] };
    render(<ConfirmationMineScreen />);
    await waitFor(() => expect(calls('/api/confirmation/mine').length).toBeGreaterThan(0));
    expect(screen.queryByText('طلب جاهز للسحب الآن')).toBeNull();
    expect(screen.queryByRole('button', { name: 'اسحب الطلب التالي' })).toBeNull();
    expect(calls('/api/confirmation/queue'), 'سُئل باب الطابور عن موظف ما يسحب').toHaveLength(0);
  });
});

describe('«طلباتي» — the fourth tab, «المؤجلة»', () => {
  it('is the postponed list drawn inside the desk, under the one title of the desk', async () => {
    render(<ConfirmationMineScreen />);
    await screen.findByRole('tab', { name: /المؤجلة/ });
    expect(screen.queryByTestId('postponed-list')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: /المؤجلة/ }));
    // `findBy`: the tab is its own chunk since the owner's ruling 4/11 («طلباتي أخف»), drawn the moment it arrives.
    expect((await screen.findByTestId('postponed-list')).getAttribute('data-embedded')).toBe('true');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('`?tab=postponed` — the old address, a «came due» notice, the redirect of the supervisor page — opens on it', async () => {
    params.current = new URLSearchParams('tab=postponed');
    render(<ConfirmationMineScreen />);
    await screen.findByTestId('postponed-list');
    expect(screen.getByRole('tab', { name: /المؤجلة/ }).getAttribute('aria-selected')).toBe('true');
  });

  it('and another tab brings the desk back — the postponed list is a tab, not a one-way door', async () => {
    params.current = new URLSearchParams('tab=postponed');
    render(<ConfirmationMineScreen />);
    await screen.findByTestId('postponed-list');
    fireEvent.click(screen.getByRole('tab', { name: /اتصلي هلّق/ }));
    expect(screen.queryByTestId('postponed-list')).toBeNull();
  });
});

