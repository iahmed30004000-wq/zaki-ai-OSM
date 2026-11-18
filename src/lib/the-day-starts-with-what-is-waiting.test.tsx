// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «شغلك اليوم» — THE DASHBOARD SAYS WHAT TO DO FIRST.
 *
 * The owner, 21/10: «حاسو معجوق وصعب … كل خطوة تودّي للثانية». The dashboard
 * opened on the month, and a person who had just sat down was told nothing
 * about what to do first. The header holds the same counts as chips; a chip
 * has room for «14 مرتجع» and not for what that is FOR.
 *
 * The claims are mostly about what this section must NOT say:
 *
 *   • «لا شيء ينتظرك الآن» only when the person HAS kinds of work and every
 *     one is empty — never for somebody with none, and never because the
 *     request failed (nobody knows that);
 *   • never a zero; never a link to a screen the person may not open;
 *   • never work that is not one of the known kinds, and never a sentence that
 *     is not that kind's own.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));
vi.mock('@/hooks/useLiveRefresh', () => ({
  useLiveRefresh: (load: () => Promise<void>) => {
    React.useEffect(() => {
      void load();
    }, [load]);
  },
}));
const may = { yes: (_path: string) => true };
vi.mock('@/hooks/useMayOpen', () => ({
  useMayOpen: () => (target: string | { path: string }) => may.yes(typeof target === 'string' ? target : target.path),
}));

import { WorkToday } from '@/components/dashboard/WorkToday';
import { WORK_KINDS, type WorkItem, type WorkKey } from './my-work';
import { repoFile, stripComments } from './guard-source';

const item = (key: WorkKey, count: number): WorkItem => {
  const k = WORK_KINDS.find((x) => x.key === key)!;
  return { key, ar: k.ar, count, href: k.href, icon: k.icon, tone: k.tone };
};
const answer = (items: WorkItem[] | null) =>
  apiFetch.mockResolvedValue({ ok: items !== null, json: async () => ({ items: items ?? [] }) });

beforeEach(() => {
  may.yes = () => true;
  answer([]);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const mount = async () => {
  render(<WorkToday />);
  await act(async () => {});
};
const cards = () => screen.queryAllByRole('listitem');
/** 18/11 (R9): the heading is «بدّو إياك هلق» — the plan's one list of «اليوم». Was «شغلك اليوم». */
const HEADING = 'بدّو إياك هلق';

describe('what it shows', () => {
  it('— a card for each kind that has work, worst first, with its number, its name and what to do', async () => {
    answer([item('CONFIRM_POOL', 40), item('LATE_SHIPMENTS', 3), item('RETURNS_WAITING', 14)]);
    await mount();
    expect(screen.getByRole('heading', { name: HEADING })).toBeTruthy();
    const rows = cards();
    // Late work outranks waiting work (`rank`), whatever order the server sent.
    expect(rows.map((li) => li.textContent)).toEqual([
      expect.stringContaining('شحنة متأخّرة'),
      expect.stringContaining('مرتجع لم يُستلم'),
      expect.stringContaining('بانتظار التأكيد'),
    ]);
    const late = rows[0];
    expect(within(late).getByText('3')).toBeTruthy();
    expect(late.textContent).toContain(WORK_KINDS.find((k) => k.key === 'LATE_SHIPMENTS')!.todo);
  });

  it('and never a zero — a row of «0 مرتجع» teaches people to stop reading it', async () => {
    answer([item('LATE_SHIPMENTS', 0), item('READY_TO_SHIP', 7), item('RETURNS_WAITING', 0)]);
    await mount();
    expect(cards()).toHaveLength(1);
    expect(cards()[0].textContent).toContain('جاهز للشحن');
    expect(screen.queryByText('0')).toBeNull();
  });

  it('and a number past the server’s ceiling reads «999+», not a figure that is not true', async () => {
    answer([item('CONFIRM_POOL', 999)]);
    await mount();
    expect(screen.getByText('999+')).toBeTruthy();
  });

  it('and urgent work is marked, with the border the header chips use', async () => {
    answer([item('LATE_SHIPMENTS', 2), item('READY_TO_SHIP', 5)]);
    await mount();
    const [urgent, normal] = cards();
    expect(urgent.className).toContain('border-[var(--sys-destructive-border)]');
    expect(normal.className).not.toContain('destructive');
  });
});

describe('what it says when there is nothing', () => {
  it('— «لا شيء ينتظرك الآن» when there are kinds of work and every one is empty', async () => {
    answer([item('LATE_SHIPMENTS', 0), item('READY_TO_SHIP', 0)]);
    await mount();
    expect(screen.getByText('لا شيء ينتظرك الآن.')).toBeTruthy();
    expect(cards()).toHaveLength(0);
  });

  it('and NOTHING AT ALL for a person who has no kind of work — it would be a statement about work they were never given', async () => {
    answer([]);
    await mount();
    expect(screen.queryByRole('heading', { name: HEADING })).toBeNull();
    expect(screen.queryByText(/لا شيء ينتظرك/)).toBeNull();
  });

  it('and nothing while the first answer has not come', async () => {
    apiFetch.mockReturnValue(new Promise(() => {}));
    await mount();
    expect(screen.queryByRole('heading', { name: HEADING })).toBeNull();
  });

  it('and nothing, and NOT «لا شيء», when the request fails — nobody knows that nothing is waiting', async () => {
    answer(null);
    await mount();
    expect(screen.queryByRole('heading', { name: HEADING })).toBeNull();
    apiFetch.mockRejectedValue(new Error('offline'));
    cleanup();
    await mount();
    expect(screen.queryByText(/لا شيء ينتظرك/)).toBeNull();
  });
});

describe('the way in', () => {
  it('— a link to the screen the work is done on, named', async () => {
    answer([item('READY_TO_SHIP', 7)]);
    await mount();
    const link = within(cards()[0]).getByRole('link');
    expect(link.getAttribute('href')).toBe('/ops/shipments/new');
    expect(link.textContent).toContain('افتح إنشاء شحنة');
  });

  it('and none for a screen the person may not open — a link that ends in a refusal is worse than none', async () => {
    may.yes = (p) => p !== '/ops/shipments/new';
    answer([item('READY_TO_SHIP', 7)]);
    await mount();
    expect(cards()).toHaveLength(1);
    expect(within(cards()[0]).queryByRole('link')).toBeNull();
  });

  it('and none where the kind has none by design: a moderator’s own unconfirmed orders lead nowhere', async () => {
    answer([item('MY_UNCONFIRMED', 4)]);
    await mount();
    expect(cards()[0].textContent).toContain('طلباتي غير المؤكَّدة');
    expect(within(cards()[0]).queryByRole('link')).toBeNull();
  });

  it('and the arrow is the mirrored one, as everywhere else', async () => {
    answer([item('READY_TO_SHIP', 7)]);
    await mount();
    expect(cards()[0].querySelector('svg.icon-mirror')).toBeTruthy();
  });
});

describe('every kind of work has its sentence', () => {
  it.each(WORK_KINDS.map((k) => [k.key, k.todo] as const))('%s', (_key, todo) => {
    expect(todo.trim(), 'جملة فارغة').not.toBe('');
    expect(/[؀-ۿ]/.test(todo), 'بلا عربي').toBe(true);
    expect(/[A-Za-z]/.test(todo), 'كلمة إنجليزية').toBe(false);
    expect(todo.length, 'جملة طويلة — الكرت صغير').toBeLessThanOrEqual(90);
    expect(todo).toMatch(/[.؟]$/);
  });

  it('and no two kinds are told the same thing', () => {
    expect(new Set(WORK_KINDS.map((k) => k.todo)).size).toBe(WORK_KINDS.length);
  });
});

describe('how it is wired', () => {
  const code = (f: string) => stripComments(repoFile(f));

  // 18/11 (R9): was «the dashboard leads with it, ahead of the intelligence strip and the tiles». «اليوم» is three figures, this ONE
  // list and one chart, in that order (the plan's «واجهة 2»); the strip and the tiles moved to the performance board.
  it('— the dashboard draws it once, after its three figures and before its one chart, and no intelligence strip', () => {
    const src = code('src/components/screens/DashboardScreen.tsx');
    const work = src.indexOf('<WorkToday />');
    expect(work, 'ما انحط').toBeGreaterThan(-1);
    expect(work, 'قبل الأرقام').toBeGreaterThan(src.lastIndexOf('<KpiCard'));
    expect(work, 'بعد الرسم').toBeLessThan(src.indexOf('<DailyChart'));
    expect(src).not.toContain('<IntelligenceStrip');
    expect(src.match(/<WorkToday\s*\/>/g)).toHaveLength(1);
  });

  it('and it reads the one door the header reads, through apiFetch — never a bare fetch', () => {
    const src = code('src/components/dashboard/WorkToday.tsx');
    expect(src).toContain("apiFetch('/api/me/work')");
    expect(src).not.toMatch(/(?<![.\w])fetch\(/);
  });

  it('and it computes nothing: the count it prints is the server’s', () => {
    const src = code('src/components/dashboard/WorkToday.tsx');
    // No arithmetic on a count — the only comparison is against the ceiling.
    expect(src).not.toMatch(/\.count\s*[-+*/]/);
    expect(src).not.toMatch(/reduce\(/);
  });
});
