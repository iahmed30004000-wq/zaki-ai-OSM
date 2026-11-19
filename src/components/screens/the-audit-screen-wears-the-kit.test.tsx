// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';

/**
 * «سجل التدقيق» ON THE KIT (R16h, 18/11).
 *
 * The log moved onto the one frame (`PageShell`): the span of days is the frame's toolbar row, the search and the two
 * dropdowns its filters row, and every caption reads at 13px. A log screen may look different; what it asks the server,
 * who sees «افتح», and what the owner's team-leader window shows may not. This file holds what a careless restyle breaks:
 *
 *   the title is the registry's, drawn ONCE, by the frame;
 *   the span of days still opens on TODAY and is still asked for (decision 6: D1's `DateRange` and its query);
 *   the date box comes before the search, and both before the list;
 *   «افتح» is drawn per door: orders only, products only, both, neither;
 *   the team leader's window keeps ONE native day field (a field, not a span) and asks exactly what it asked;
 *   its variance line keeps its red mark at 20% or more (that line is not touched: it carries a percent condition);
 *   no caption is drawn at 12px any more.
 *
 * jsdom has no layout: the phone case holds what the 375px layout depends on (no fixed width beyond the viewport, the table
 * scrolls inside its own box, rows become cards through `Rows`). Nothing behind the login can be opened in a browser.
 */

const { api, may } = vi.hoisted(() => ({
  api: vi.fn(),
  may: { yes: (() => true) as (p: string) => boolean },
}));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a) }));
vi.mock('@/hooks/useMayOpen', () => ({
  useMayOpen: () => (target: string | { path: string }) => may.yes(typeof target === 'string' ? target : target.path),
}));
vi.mock('@/hooks/useLiveRefresh', () => ({ useLiveRefresh: () => {} }));
vi.mock('@/components/shell/ScreenGuide', () => ({ GuideButton: () => null }));
vi.mock('@/components/orders/OrderRef', () => ({ OrderRef: ({ id, number }: { id: string; number: string }) => <a href={`/orders/${id}`}>{number}</a> }));

import { AuditScreen } from './AuditScreen';
import { TeamLeaderAudit } from './TeamLeaderAudit';
import { todayRange } from '@/components/ui/DateRange';
import { routeLabel } from '@/lib/route-registry';

// Built from pieces, so the stylesheet scanner does not read a class out of this file.
const SMALL = ['text', 'xs'].join('-');
const NOTE = ['text', 'note'].join('-');

const TODAY = (() => { const t = todayRange(); return `from=${t.from}&to=${t.to}`; })();
const ORDER_ID = '0f8c1b2a-1111-4222-8333-444455556666';
const PRODUCT_ID = '9a8b7c6d-1111-4222-8333-444455556666';
const ROW = (over: Record<string, unknown> = {}) => ({
  id: 'a1',
  action: 'ORDER_STATUS_CHANGED',
  entity: 'Order',
  entityId: ORDER_ID,
  newData: JSON.stringify({ status: 'CONFIRMED' }),
  createdAt: '2026-10-20T10:00:00.000Z',
  user: { id: 'u1', name: 'سامر', role: 'MODERATOR' },
  ...over,
});
const LOG = {
  logs: [ROW(), ROW({ id: 'a2', action: 'PRODUCT_UPDATED', entity: 'Product', entityId: PRODUCT_ID }), ROW({ id: 'a3', action: 'WALLET_STOPPED', entity: 'Wallet', entityId: 'w-0000-1111', user: null, payWithheld: true })],
  pagination: { total: 3, page: 1, limit: 25, totalPages: 1 },
  facts: { users: [{ id: 'u1', name: 'سامر', count: 2 }], entities: [{ entity: 'Order', count: 1 }, { entity: 'Product', count: 1 }] },
};
const v = (submitted: number, system: number) => ({ submitted, system, percent: system === 0 ? null : Math.round(((submitted - system) / system) * 100) });
const LEADER = {
  day: '2026-11-10',
  leaders: [{ id: 'dalia', name: 'داليا' }, { id: 'noor', name: 'نور' }],
  leader: { id: 'dalia', name: 'داليا' },
  report: {
    submittedAt: '2026-11-10T20:00:00Z',
    biggestProblem: 'ازدحام',
    tip: 'ابدأوا بالمتأخر',
    comparison: [{ userId: 'u1', name: 'سارة', metrics: { claims: v(12, 10), confirmed: v(6, 6), rejected: v(2, 2), noAnswer: v(8, 8), winback: v(0, 1), stuck: v(3, 0) } }],
  },
  actions: [{ action: 'ORDER_TRANSFERRED', entity: 'Order', entityId: 'o1', createdAt: '2026-11-10T09:00:00Z' }],
  sample: [{ orderId: 'o1', orderNumber: 'ORD-7', reason: 'FAKE_ORDER', reasonAr: 'طلب وهميّ', agent: 'سارة', phoneValid: false }],
};

let leaderAnswers: 'owner' | 'refused' = 'owner';
beforeEach(() => {
  vi.clearAllMocks();
  may.yes = () => true;
  leaderAnswers = 'owner';
  api.mockImplementation(async (url: string) => {
    if (String(url).startsWith('/api/audit/team-leader')) {
      if (leaderAnswers === 'refused') throw new Error('403');
      return LEADER;
    }
    return LOG;
  });
});
afterEach(cleanup);

const logUrls = () => api.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith('/api/audit-logs'));
const leaderUrls = () => api.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith('/api/audit/team-leader'));
const opened = () => screen.queryAllByRole('link', { name: 'افتح' }).map((l) => l.getAttribute('href'));

describe('the frame', () => {
  it('draws the registry name once, as the one h1, with the sentence under it', async () => {
    render(<AuditScreen />);
    await screen.findAllByText('تغيير حالة طلب');
    const h1 = document.querySelectorAll('h1');
    expect(h1).toHaveLength(1);
    expect(h1[0].textContent).toBe(routeLabel('/control/audit'));
    expect(document.body.textContent).toContain('سجلٌّ لا يُمحى');
  });

  it('the source draws the frame with the registry title and no hand-typed one', () => {
    const src = readFileSync('src/components/screens/AuditScreen.tsx', 'utf8');
    expect(src).toMatch(/<PageShell\s+title=\{routeLabel\('\/control\/audit'\)\}/);
    expect(src).not.toMatch(/<PageHeader\b/);
  });

  it('the span of days comes first, then the search and its dropdowns, then the list', async () => {
    render(<AuditScreen />);
    await screen.findAllByText('تغيير حالة طلب');
    const span = document.querySelector('button[aria-expanded]')!;
    const search = screen.getByPlaceholderText(/بحث بالإجراء/);
    const who = screen.getByLabelText('مَن');
    const list = screen.getAllByText('تغيير حالة طلب')[0];
    const before = (a: Node, b: Node) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(before(span, search)).toBe(true);
    expect(before(search, who)).toBe(true);
    expect(before(who, list)).toBe(true);
  });

  // The kit's own parts (the dropdowns, the table head, the phone cards) carry their own sizes: this checks the two files this PR owns.
  it('no caption of the two files is 12px — except the variance line, left untouched because it carries the percent condition', () => {
    const lines = (f: string) => readFileSync(`src/components/screens/${f}`, 'utf8').split('\n');
    const small = (f: string) => lines(f).filter((l) => new RegExp(`\\b${SMALL}\\b`).test(l));
    expect(small('AuditScreen.tsx')).toEqual([]);
    const left = small('TeamLeaderAudit.tsx');
    expect(left).toHaveLength(1);
    expect(left[0]).toContain('v.percent');
    expect(lines('AuditScreen.tsx').filter((l) => l.includes(NOTE)).length).toBe(5);
    expect(lines('TeamLeaderAudit.tsx').filter((l) => l.includes(NOTE)).length).toBe(9);
  });

  it('the captions drawn by the two files read at 13px', async () => {
    const { container } = render(<AuditScreen />);
    await screen.findAllByText('تغيير حالة طلب');
    await screen.findByText('تدقيق قائد الفريق');
    expect(screen.getAllByText('MODERATOR')[0].className).toContain(NOTE);
    expect(screen.getAllByText('افتح')[0].className).toContain(NOTE);
    expect(screen.getByText('سجل شغلها بهاليوم').nextElementSibling?.className).toContain(NOTE);
    expect(screen.getByLabelText('اليوم').className).toContain(NOTE);
    expect(container.querySelectorAll(`.${NOTE}`).length).toBeGreaterThan(5);
  });
});

describe('what it asks the server — unchanged', () => {
  it('opens on today, page 1 of 25, nothing else in the address', async () => {
    render(<AuditScreen />);
    await screen.findAllByText('تغيير حالة طلب');
    expect(logUrls()[0]).toBe(`/api/audit-logs?${TODAY}&page=1&limit=25`);
  });

  it('a person and a kind are each asked for (keys in the order the list sorts them), and «إعادة تعيين» asks today again', async () => {
    render(<AuditScreen />);
    await screen.findAllByText('تغيير حالة طلب');
    fireEvent.change(screen.getByLabelText('مَن'), { target: { value: 'u1' } });
    await waitFor(() => expect(logUrls().at(-1)).toBe(`/api/audit-logs?${TODAY}&user=u1&page=1&limit=25`));
    fireEvent.change(screen.getByLabelText('على ماذا'), { target: { value: 'Order' } });
    await waitFor(() => expect(logUrls().at(-1)).toBe(`/api/audit-logs?entity=Order&${TODAY}&user=u1&page=1&limit=25`));
    await act(async () => {
      screen.getByRole('button', { name: /إعادة تعيين/ }).click();
    });
    await waitFor(() => expect(logUrls().at(-1)).toBe(`/api/audit-logs?${TODAY}&page=1&limit=25`));
  });

  it('the search is asked for trimmed, and a search of only spaces asks nothing', async () => {
    render(<AuditScreen />);
    await screen.findAllByText('تغيير حالة طلب');
    const box = screen.getByPlaceholderText(/بحث بالإجراء/);
    fireEvent.change(box, { target: { value: '   ' } });
    await new Promise((r) => setTimeout(r, 600));
    expect(logUrls().every((u) => !u.includes('q='))).toBe(true);
    fireEvent.change(box, { target: { value: '  حذف  ' } });
    await waitFor(() => expect(logUrls().some((u) => u.includes(`q=${encodeURIComponent('حذف')}&`))).toBe(true), { timeout: 3000 });
    expect(logUrls().some((u) => /q=(%20|\+)/.test(u) || u.includes(`${encodeURIComponent('حذف')}%20`) || u.includes(`${encodeURIComponent('حذف')}+`))).toBe(false);
  });
});

describe('«افتح» is drawn per door (the screen has no `can(` of its own: the route is the key, the link is the door)', () => {
  it('both doors: an order and a product open, a wallet does not', async () => {
    render(<AuditScreen />);
    await screen.findAllByText('تغيير حالة طلب');
    expect(new Set(opened())).toEqual(new Set([`/orders/${ORDER_ID}`, `/products/${PRODUCT_ID}`]));
  });

  it('NEGATIVE: only the orders door — no product link', async () => {
    may.yes = (p) => p === '/orders';
    render(<AuditScreen />);
    await screen.findAllByText('تغيير حالة طلب');
    expect(new Set(opened())).toEqual(new Set([`/orders/${ORDER_ID}`]));
  });

  it('NEGATIVE: only the products door — no order link', async () => {
    may.yes = (p) => p === '/products';
    render(<AuditScreen />);
    await screen.findAllByText('تغيير حالة طلب');
    expect(new Set(opened())).toEqual(new Set([`/products/${PRODUCT_ID}`]));
  });

  it('NEGATIVE: neither door — ids as text, no link, and the withheld-pay note still said', async () => {
    may.yes = () => false;
    render(<AuditScreen />);
    await screen.findAllByText('تغيير حالة طلب');
    expect(opened()).toEqual([]);
    expect(screen.getAllByText(ORDER_ID.slice(0, 8)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/لا تظهر إلا لمن معه صلاحية «عرض الرواتب»/).length).toBeGreaterThan(0);
  });
});

describe('the owner’s team-leader window (decision 6: one native day field)', () => {
  it('keeps ONE native date field, not a span, and asks for the day typed', async () => {
    const { container } = render(<TeamLeaderAudit />);
    await screen.findAllByText('سارة');
    const days = container.querySelectorAll('input[type="date"]');
    expect(days).toHaveLength(1);
    expect(screen.getByLabelText('اليوم')).toBe(days[0]);
    fireEvent.change(days[0], { target: { value: '2026-11-09' } });
    await waitFor(() => expect(leaderUrls().at(-1)).toBe('/api/audit/team-leader?day=2026-11-09'));
  });

  it('NEGATIVE: an emptied day field asks nothing new', async () => {
    const { container } = render(<TeamLeaderAudit />);
    await screen.findAllByText('سارة');
    const n = leaderUrls().length;
    fireEvent.change(container.querySelector('input[type="date"]')!, { target: { value: '' } });
    await new Promise((r) => setTimeout(r, 20));
    expect(leaderUrls()).toHaveLength(n);
  });

  it('the leader chosen is asked for by id', async () => {
    render(<TeamLeaderAudit />);
    await screen.findAllByText('سارة');
    fireEvent.change(screen.getByLabelText('قائد الفريق'), { target: { value: 'noor' } });
    await waitFor(() => expect(leaderUrls().at(-1)).toMatch(/^\/api\/audit\/team-leader\?day=\d{4}-\d{2}-\d{2}&leaderId=noor$/));
  });

  it('the variance keeps its red mark at 20% or more, and only there', async () => {
    const { container } = render(<TeamLeaderAudit />);
    await screen.findAllByText('سارة');
    const marks = [...container.querySelectorAll('span')].filter((s) => /^[+-]?\d+%$/.test(s.textContent ?? ''));
    const red = marks.filter((s) => s.className.includes('font-bold')).map((s) => s.textContent);
    expect([...new Set(red)].sort()).toEqual(['+20%', '-100%'].sort());
    expect(marks.find((s) => s.textContent === '0%')?.className).not.toContain('font-bold');
  });

  it('NEGATIVE: when its door refuses, the log screen draws nothing of it — not even the title', async () => {
    leaderAnswers = 'refused';
    render(<AuditScreen />);
    await screen.findAllByText('تغيير حالة طلب');
    await waitFor(() => expect(leaderUrls().length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('تدقيق قائد الفريق')).toBeNull();
    expect(document.querySelector('input[type="date"]')).toBeNull();
  });
});

describe('a phone, 375px', () => {
  it('no fixed width beyond the viewport, and the table scrolls inside its own box', async () => {
    const { container } = render(<AuditScreen />);
    await screen.findAllByText('تغيير حالة طلب');
    await screen.findByText('تدقيق قائد الفريق');
    const widths = [...container.querySelectorAll('[class]')].flatMap((el) =>
      [...el.classList].filter((c) => /^(min-)?w-\[(\d+)px\]$/.test(c) && Number(c.match(/(\d+)px/)![1]) > 375),
    );
    expect(widths).toEqual([]);
    // the frame never fixes a width: it caps (max-w) or leaves the page full
    expect(container.firstElementChild?.className).toContain('min-w-0');
    expect(container.querySelector('.overflow-x-auto')).not.toBeNull();
  });
});
