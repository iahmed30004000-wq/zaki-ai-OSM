// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * «الطلبات الجديدة» ON THE KIT (18/11, request R8e).
 *
 * The supervisor's view of the pool moved onto the shared parts: the frame (`PageShell`, narrow), the table's surface (`Card` with
 * its own header) and the board's five figures (`StatTile`). Nothing it does was meant to move with it: the same pull panel, the
 * same press of «اسحب» landing on «طلباتي», the same five columns, the same empty state, the same board — and the board still
 * draws nothing when the owner's switch is off or the answer is odd. Behind the login nothing can be opened in a browser, so the
 * screen is proven here, in jsdom.
 */

const { api, push } = vi.hoisted(() => ({ api: vi.fn(), push: vi.fn() }));

const SUPERVISOR = {
  id: 'sup', name: 'مشرفة', role: 'CONFIRMATION_SUPERVISOR', status: 'ACTIVE',
  permissions: ['confirmation.supervise', 'confirmation.issues'],
};

vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push, replace: vi.fn() }), usePathname: () => '/confirmation/queue' }));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ locale: 'ar', t: {}, currentUser: SUPERVISOR }) }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => true }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), done: vi.fn(), warn: vi.fn() }) }));
vi.mock('@/components/orders/OrderRef', () => ({ OrderRef: ({ number }: { number: string }) => <span>{number}</span> }));
vi.mock('@/hooks/useLiveRefresh', () => ({
  useLiveRefresh: (load: () => Promise<unknown>) => {
    const latest = React.useRef(load);
    latest.current = load;
    React.useEffect(() => {
      void latest.current();
    }, []);
  },
}));

import { ConfirmationQueueScreen } from './ConfirmationQueueScreen';
import { routeLabel } from '@/lib/route-registry';

const row = (id: string, status: string, held: { id: string; name: string } | null, postponed: number) => ({
  id, orderNumber: `ORD-${id}`, confirmationStatus: status, postponeCount: postponed, reservedFor: held,
  customer: { fullName: `عميل ${id}`, city: 'مدينة' },
});

const QUEUE = (over: Record<string, unknown> = {}) => ({
  waiting: 2, owned: { total: 0, withoutAttempt: 0 }, caps: { withoutAttempt: 10, total: 300 }, leadDays: 2,
  canPull: true, refusal: null, autoReleased: 0,
  orders: [row('11', 'NEW', null, 0), row('12', 'IN_PROGRESS', { id: 'a', name: 'موظفة' }, 3)],
  ...over,
});

const HEALTH = {
  backlog: 7, dueNow: 4, oldestDueHours: 50, enteredToday: 6, closedToday: 5, newWaiting: 2, oldestNewMinutes: null,
};
const HEALTHY = { enabled: true, health: HEALTH, alerts: [{ kind: 'x', title: 'تنبيه', message: 'الطابور بيكبر' }], rule: 'قاعدة الطابور', weekly: 'كلام الأسبوع' };

let queueAnswer: unknown;
let healthAnswer: unknown;
let pullFails = false;

beforeEach(() => {
  vi.clearAllMocks();
  queueAnswer = QUEUE();
  healthAnswer = HEALTHY;
  pullFails = false;
  api.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/confirmation/queue') return queueAnswer;
    if (url === '/api/confirmation/health') {
      if (healthAnswer instanceof Error) throw healthAnswer;
      return healthAnswer;
    }
    if (url === '/api/confirmation/pull' && init?.method === 'POST') {
      if (pullFails) throw new Error('ما في طلب');
      return { ok: true };
    }
    throw new Error(`unexpected ${url}`);
  });
});
afterEach(cleanup);

const draw = async () => {
  const view = render(<ConfirmationQueueScreen />);
  await screen.findAllByText('ORD-11');
  return view;
};

const sent = () => api.mock.calls.map(([u, init]) => `${(init as RequestInit | undefined)?.method ?? 'GET'} ${String(u)}`);

const SRC = readFileSync(join(process.cwd(), 'src/components/screens/ConfirmationQueueScreen.tsx'), 'utf8');
const BOARD_SRC = readFileSync(join(process.cwd(), 'src/components/screens/QueueHealthBoard.tsx'), 'utf8');

describe('the frame', () => {
  it('one h1, the registry name, drawn by PageShell at the narrow width', async () => {
    const { container } = await draw();
    const h1s = screen.getAllByRole('heading', { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0].textContent).toContain(routeLabel('/confirmation/queue'));
    expect((container.firstElementChild as HTMLElement).className.split(/\s+/)).toContain('max-w-3xl');
    expect(SRC).toContain(`<PageShell title={routeLabel('/confirmation/queue')} width="narrow">`);
  });

  it('the hand-drawn section and header are gone from the source', () => {
    expect(SRC).not.toMatch(/<section\b/);
    expect(SRC).not.toMatch(/<header\b/);
    expect(SRC).not.toContain('import { PageHeader }');
  });

  it('while the first answer is in the air: the loading line, no frame', () => {
    api.mockImplementation(() => new Promise(() => {}));
    render(<ConfirmationQueueScreen />);
    expect(screen.getByText('جارٍ التحميل…')).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
  });
});

describe('the supervisor table', () => {
  it('the same words in the card header, with the count', async () => {
    await draw();
    expect(screen.getByRole('heading', { level: 3, name: 'عرض المشرف — نفس الطلبات المنتظرة (2)' })).toBeTruthy();
  });

  it('the same five columns, in the same order, and the row values', async () => {
    await draw();
    for (const label of ['الطلب', 'العميل', 'الحالة', 'تابع لـ', 'التأجيلات']) expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    expect(SRC.indexOf("key: 'order'")).toBeLessThan(SRC.indexOf("key: 'customer'"));
    expect(SRC.indexOf("key: 'customer'")).toBeLessThan(SRC.indexOf("key: 'state'"));
    expect(SRC.indexOf("key: 'state'")).toBeLessThan(SRC.indexOf("key: 'heldFor'"));
    expect(SRC.indexOf("key: 'heldFor'")).toBeLessThan(SRC.indexOf("key: 'postponed'"));
    expect(screen.getAllByText('عميل 11 · مدينة').length).toBeGreaterThan(0);
    expect(screen.getAllByText('موظفة').length).toBeGreaterThan(0);
    expect(screen.getAllByText('3').length).toBeGreaterThan(0);
  });

  it('no order waits: the same empty state, and the count says 0', async () => {
    queueAnswer = QUEUE({ orders: [], waiting: 0 });
    render(<ConfirmationQueueScreen />);
    expect(await screen.findByText('لا طلبات تنتظر التأكيد')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3, name: 'عرض المشرف — نفس الطلبات المنتظرة (0)' })).toBeTruthy();
  });

  it('an answer without the rows (not a supervisor): no table, no board', async () => {
    queueAnswer = QUEUE({ orders: undefined });
    render(<ConfirmationQueueScreen />);
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByText(/عرض المشرف/)).toBeNull();
    expect(screen.queryByText('صحة الطابور')).toBeNull();
    expect(sent()).not.toContain('GET /api/confirmation/health');
  });
});

describe('the pull', () => {
  it('«اسحب» sends one POST and lands on «طلباتي»', async () => {
    await draw();
    fireEvent.click(screen.getByRole('button', { name: 'اسحب الطلب التالي' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/confirmation/mine'));
    expect(sent().filter((s) => s === 'POST /api/confirmation/pull')).toHaveLength(1);
  });

  it('a refused pull goes nowhere', async () => {
    pullFails = true;
    await draw();
    fireEvent.click(screen.getByRole('button', { name: 'اسحب الطلب التالي' }));
    await waitFor(() => expect(sent()).toContain('POST /api/confirmation/pull'));
    await new Promise((r) => setTimeout(r, 0));
    expect(push).not.toHaveBeenCalled();
  });

  it('may not pull: the button is shut and nothing is sent', async () => {
    queueAnswer = QUEUE({ canPull: false });
    await draw();
    const b = screen.getByRole('button', { name: 'اسحب الطلب التالي' }) as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    fireEvent.click(b);
    expect(sent()).not.toContain('POST /api/confirmation/pull');
    expect(push).not.toHaveBeenCalled();
  });

  it('on mount the screen asks for the queue and the board — nothing else', async () => {
    await draw();
    await screen.findByText('صحة الطابور');
    expect([...new Set(sent())].sort()).toEqual(['GET /api/confirmation/health', 'GET /api/confirmation/queue']);
  });
});

describe('the board', () => {
  it('five tiles, each a number and its name, the numbers as the server sent them', async () => {
    await draw();
    const board = (await screen.findByText('صحة الطابور')).closest('.zk-card') as HTMLElement;
    const pairs: Array<[string, string]> = [['بالانتظار', '7'], ['حان موعده الآن', '4'], ['أقدم موعد فات', '2 يوم'], ['دخل اليوم', '6'], ['انسكّر اليوم', '5']];
    const terms = within(board).getAllByRole('term');
    expect(terms.map((t) => t.textContent)).toEqual(pairs.map(([l]) => l));
    for (const [label, value] of pairs) {
      const tile = within(board).getByText(label).closest('dl') as HTMLElement;
      expect(within(tile).getByText(value).getAttribute('dir')).toBe('ltr');
    }
    expect(BOARD_SRC).toContain('<StatTile key={label} label={label} value={value} />');
  });

  it('an age under two days (30.5 hours) is said in whole hours, none due is «—»', async () => {
    healthAnswer = { ...HEALTHY, health: { ...HEALTH, oldestDueHours: 30.5 } };
    await draw();
    expect(await screen.findByText('30 ساعة')).toBeTruthy();
    cleanup();
    healthAnswer = { ...HEALTHY, health: { ...HEALTH, oldestDueHours: null } };
    await draw();
    await screen.findByText('صحة الطابور');
    const tile = screen.getByText('أقدم موعد فات').closest('dl') as HTMLElement;
    expect(within(tile).getByText('—')).toBeTruthy();
  });

  it('the alerts, the week and the rule are still said', async () => {
    await draw();
    expect((await screen.findByRole('alert')).textContent).toContain('الطابور بيكبر');
    expect(screen.getByText('كلام الأسبوع')).toBeTruthy();
    expect(screen.getByText('قاعدة الطابور')).toBeTruthy();
  });

  it.each([
    ['the switch off', { enabled: false }],
    ['the switch off, figures sent anyway', { ...HEALTHY, enabled: false }],
    ['no figures', { enabled: true }],
    ['an odd answer', { nope: 1 }],
    ['a failed request', new Error('x')],
  ])('%s: the board draws nothing', async (_name, answer) => {
    healthAnswer = answer;
    await draw();
    await waitFor(() => expect(sent()).toContain('GET /api/confirmation/health'));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText('صحة الطابور')).toBeNull();
    expect(screen.queryByText('بالانتظار')).toBeNull();
  });
});

describe('a phone, 375 px', () => {
  it('no element carries a fixed width wider than the screen', async () => {
    const { container } = await draw();
    await screen.findByText('صحة الطابور');
    const fixed = new RegExp('(?:^|:)(?:min-)?w-' + '\\[(\\d+)px\\]$');
    const scale = new RegExp('(?:^|:)(?:min-)?w-(\\d+)$');
    const tooWide: string[] = [];
    for (const el of Array.from(container.querySelectorAll('*'))) {
      for (const c of (el.getAttribute('class') ?? '').split(/\s+/)) {
        if (c.startsWith('md:') || c.startsWith('lg:') || c.startsWith('xl:')) continue;
        const px = fixed.exec(c)?.[1] ?? (scale.exec(c) ? String(Number(scale.exec(c)![1]) * 4) : null);
        if (px && Number(px) > 375) tooWide.push(c);
      }
    }
    expect(tooWide).toEqual([]);
  });
});
