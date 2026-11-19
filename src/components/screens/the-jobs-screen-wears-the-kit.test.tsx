// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@/lib/guard-source';

/**
 * «المهام المجدولة» ON THE KIT (R15j, plan 17/11 — written 18/11).
 *
 * The screen moved onto `PageShell`, `Button` and `Card`. What must NOT have moved with it:
 *   - every press sends the request it sent: «شغّلها الآن» `{ job }`, «شغّلها كلَّها» `{ job: '*' }` with its JSON header,
 *     «أعد تفعيلها» `{ job, action: 'unpark' }` — byte for byte, once;
 *   - a job whose press is in the air cannot be pressed again (the screen's own `running` flag still disables it), and only that job;
 *   - the three presses are drawn only for who holds `settings.jobs`, and «أعد تفعيلها» only on a job that stopped trying;
 *   - the sentences: the done line, the failure line, the overdue count, the empty log.
 * Every claim has a negative twin.
 *
 * jsdom has no layout: «no sideways scroll at 375px» is checked as the classes that make it (the frame's `min-w-0`, no fixed pixel
 * width wider than a phone, the job row wraps), and the pull request says so.
 */

const { apiJson, keys } = vi.hoisted(() => ({
  apiJson: vi.fn(),
  keys: { held: new Set<string>(['settings.jobs']) },
}));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a) }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/admin/jobs',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('@/hooks/useCan', () => ({ useCan: (k: string) => keys.held.has(k) }));
vi.mock('@/hooks/useLiveRefresh', () => ({
  // Loads once on mount — never on an interval.
  useLiveRefresh: (load: () => unknown) => {
    const latest = React.useRef(load);
    latest.current = load;
    React.useEffect(() => {
      void latest.current();
    }, []);
  },
}));

import { JobsScreen } from './JobsScreen';
import { routeLabel } from '@/lib/route-registry';

vi.setConfig({ testTimeout: 15000 });

const job = (over: Record<string, unknown>) => ({
  name: 'orders-sync', description: 'يزامن الطلبات', everySeconds: 60, schedule: 'كل دقيقة', last: null, lastSuccessAt: null,
  overdue: false, consecutiveFailures: 0, alerting: false, parked: false, ...over,
});
const SYNC = job({});
const PARKED = job({ name: 'penalties-propose', description: 'يقترح الخصومات', parked: true, overdue: true });

let sent: { url: string; init: unknown }[] = [];
let jobs: unknown[] = [];
let recent: unknown[] = [];
let hold: Promise<unknown> | null = null;
let answer: unknown = { processed: 3 };
let refuse: Error | null = null;

beforeEach(() => {
  sent = [];
  jobs = [SYNC, PARKED];
  recent = [];
  hold = null;
  answer = { processed: 3 };
  refuse = null;
  keys.held = new Set(['settings.jobs']);
  apiJson.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (url === '/api/admin/jobs' && !init?.method) return { jobs, recent };
    sent.push({ url, init });
    if (hold) await hold;
    if (refuse) throw refuse;
    return answer;
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const ready = async () => {
  const view = render(<JobsScreen />);
  await screen.findByText('يزامن الطلبات');
  return view;
};
const press = async (el: HTMLElement) => {
  await act(async () => {
    fireEvent.click(el);
  });
};
/** «شغّلها الآن» of the n-th job (0 = orders-sync, 1 = the parked one). */
const runNow = (n: number) => screen.getAllByRole('button', { name: /شغّلها الآن/ })[n] as HTMLButtonElement;
const SRC = () => stripComments(readFileSync(join(process.cwd(), 'src/components/screens/JobsScreen.tsx'), 'utf8'));

describe('the jobs screen on the kit', () => {
  it('— one header, its name read from the menu, inside the frame', async () => {
    await ready();
    const h1 = screen.getAllByRole('heading', { level: 1 });
    expect(h1).toHaveLength(1);
    expect(h1[0].textContent).toContain(routeLabel('/admin/jobs'));
  });

  it('— the source draws the frame and the kit, and no raw button, no form, no old look name', () => {
    const src = SRC();
    expect(src).toMatch(/<PageShell title=\{routeLabel\('\/admin\/jobs'\)\}/);
    expect(src).not.toMatch(/<PageHeader[\s>]/);
    expect(src).not.toMatch(/<button[\s>]/);
    // no form, so no kit button can submit one by accident (the kit sets no default `type`)
    expect(src).not.toMatch(/<form[\s>]/);
    expect(src).not.toMatch(/variant="(outline|ghost|success)"/);
  });

  it('— «شغّلها الآن» sends exactly { job } once, says what came back, and reloads', async () => {
    await ready();
    expect(sent).toEqual([]);
    await press(runNow(0));
    await screen.findByText('orders-sync: 3');
    expect(sent).toEqual([{ url: '/api/admin/jobs', init: { method: 'POST', body: JSON.stringify({ job: 'orders-sync' }) } }]);
    // the first load + the reload after the press
    expect(apiJson.mock.calls.filter((c) => c[0] === '/api/admin/jobs' && !c[1])).toHaveLength(2);
  });

  it('— while a job’s press is in the air its button is disabled and a second press sends nothing', async () => {
    let release!: () => void;
    hold = new Promise<void>((r) => { release = r; });
    await ready();
    await press(runNow(0));
    expect(runNow(0).disabled).toBe(true);
    await press(runNow(0));
    expect(sent).toHaveLength(1);
    // NEGATIVE: the other job is not locked by it
    expect(runNow(1).disabled).toBe(false);
    await act(async () => { release(); });
    await waitFor(() => expect(runNow(0).disabled).toBe(false));
  });

  it('— a refused run says why, and no done line', async () => {
    refuse = new Error('المهمة رفضت');
    await ready();
    await press(runNow(0));
    await screen.findByText('المهمة رفضت');
    expect(screen.queryByText(/^orders-sync:/)).toBeNull();
  });

  it('— «شغّلها كلَّها بالترتيب» sends { job: "*" } with its JSON header, once, and counts the result', async () => {
    answer = { ran: [{ job: 'a', ok: true }, { job: 'b', ok: true }] };
    await ready();
    await press(screen.getByRole('button', { name: /شغّلها كلَّها بالترتيب/ }));
    await screen.findByText('شُغّلت 2 مهمة بالترتيب، كلُّها نجحت.');
    expect(sent).toEqual([{
      url: '/api/admin/jobs',
      init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ job: '*' }) },
    }]);
  });

  it('— and NEGATIVE: when one of them failed it does not say they all succeeded', async () => {
    answer = { ran: [{ job: 'a', ok: true }, { job: 'b', ok: false }] };
    await ready();
    await press(screen.getByRole('button', { name: /شغّلها كلَّها بالترتيب/ }));
    await screen.findByText('شُغّلت 2 مهمة — 1 منها لم تنجح. راجع «آخر التشغيلات».');
    expect(screen.queryByText(/كلُّها نجحت/)).toBeNull();
  });

  it('— «أعد تفعيلها» is on the parked job only, and sends exactly { job, action: "unpark" }', async () => {
    await ready();
    const unpark = screen.getAllByRole('button', { name: /أعد تفعيلها/ });
    expect(unpark).toHaveLength(1);
    await press(unpark[0]);
    await screen.findByText('penalties-propose: أُعيد تفعيلها');
    expect(sent).toEqual([{ url: '/api/admin/jobs', init: { method: 'POST', body: JSON.stringify({ job: 'penalties-propose', action: 'unpark' }) } }]);
  });

  it('— NEGATIVE: without «settings.jobs» not one of the three presses is drawn, and the jobs still are', async () => {
    keys.held = new Set(['settings.view']);
    await ready();
    expect(screen.queryByRole('button', { name: /شغّلها/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /أعد تفعيلها/ })).toBeNull();
    expect(screen.getByText('يقترح الخصومات')).toBeTruthy();
    // and the parked sentence is still said to who cannot press
    expect(screen.getByText(/توقّفت عن المحاولة بعد فشل متكرّر/)).toBeTruthy();
  });

  it('— the overdue count is said, and NEGATIVE: not when nothing is overdue', async () => {
    await ready();
    expect(screen.getByText(/1 مهمة تجاوزت موعدها/)).toBeTruthy();
    cleanup();
    jobs = [SYNC];
    await ready();
    expect(screen.queryByText(/تجاوزت موعدها/)).toBeNull();
  });

  it('— the log: its empty sentence, and a run’s status in its own word', async () => {
    await ready();
    expect(screen.getByText('لم تعمل أي مهمة بعد.')).toBeTruthy();
    cleanup();
    recent = [
      { id: 'r1', jobName: 'orders-sync', status: 'SUCCEEDED', startedAt: '2026-11-18T10:00:00Z', finishedAt: null, processed: 1, detail: null, error: null },
      { id: 'r2', jobName: 'orders-sync', status: 'FAILED', startedAt: '2026-11-18T10:01:00Z', finishedAt: null, processed: 0, detail: null, error: 'انقطع' },
      { id: 'r3', jobName: 'orders-sync', status: 'RUNNING', startedAt: '2026-11-18T10:02:00Z', finishedAt: null, processed: 0, detail: null, error: null },
    ];
    await ready();
    expect(screen.queryByText('لم تعمل أي مهمة بعد.')).toBeNull();
    for (const word of ['نجحت', 'فشلت', 'تعمل']) expect(screen.getAllByText(word).length).toBeGreaterThan(0);
  });

  it('— a phone (375px): the frame shrinks, the rows wrap, and no fixed width is wider than the phone', async () => {
    const { container } = await ready();
    const frame = container.firstElementChild as HTMLElement;
    expect(frame.className.split(/\s+/)).toContain(['min', 'w', '0'].join('-'));
    const widths = [...SRC().matchAll(/\b(?:min-)?w-\[(\d+)px\]/g)].map((m) => Number(m[1]));
    expect(widths.length).toBeGreaterThan(0);
    for (const w of widths) expect(w).toBeLessThanOrEqual(375);
    // every job row lays out its parts so they fall under each other on a narrow screen
    const row = screen.getByText('يزامن الطلبات').closest('div')!.parentElement as HTMLElement;
    expect(row.className.split(/\s+/)).toContain(['flex', 'wrap'].join('-'));
  });
});
