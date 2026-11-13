// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import React from 'react';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — THE PULL CARD SAYS WHAT IS NOT READY TO PULL (the owner, 13/11: «يع ١ كمان يضيف عليهم المؤجل والطلبات الي عليها
 * مشاكل», over a screenshot of the full card: «464 طلب جاهز للسحب الآن» = جديد 117 + راجع 347, then the postponed as a line of small print)
 *
 *  1. Under the two (or three) boxes that add up to the figure, the FULL card draws a second group, under «مش جاهزة للسحب الآن»:
 *     «مؤجَّلة» (the postponed orders whose day has not come) and «عليها إشكال» (the entry issues waiting for a correction). They are NOT
 *     in the big number and the button never gives them; the old line for the postponed gives way to its box.
 *  2. The issues box exists only when the server sent the number (a person who may open that list; an older server sends nothing): then
 *     the postponed box stands alone.
 *  3. Nothing is drawn when both are zero. A pool of nothing but far-off promises still shows its box (it used to be the line).
 *  4. The slim bar of «طلباتي» is untouched: one line, the postponed still a line, no issues.
 *  5. Still ONE pull button; the two boxes are numbers, not buttons; no new CSS class.
 * Blockers: no money, no order creation, no migration.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { api, toast } = vi.hoisted(() => ({
  api: vi.fn(),
  toast: { failed: vi.fn(), done: vi.fn(), warn: vi.fn() },
}));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => toast }));
vi.mock('@/hooks/useLiveRefresh', () => ({
  useLiveRefresh: (load: () => Promise<void>) => {
    React.useEffect(() => {
      void load();
    }, [load]);
  },
}));

import { PullPanel, useQueue, type QueueResponse } from './PullPanel';

/** The owner’s screenshot of 13/11: 117 new + 347 returned = 464 ready; 65 waiting on a date; 1 held for a colleague. */
const POOL: QueueResponse = {
  waiting: 464,
  waitingNew: 117,
  waitingReturned: 347,
  waitingDue: 0,
  waitingOnADate: 65,
  openIssues: 4,
  reservedForColleagues: 1,
  owned: { total: 0, withoutAttempt: 0 },
  caps: { withoutAttempt: 40, total: 5 },
  leadDays: 2,
  canPull: true,
  refusal: null,
  autoReleased: 0,
  orders: null,
};

let pool: QueueResponse;
beforeEach(() => {
  vi.clearAllMocks();
  pool = structuredClone(POOL);
  api.mockImplementation(async (url: string) => {
    if (url === '/api/confirmation/queue') return pool;
    throw new Error(`unexpected ${url}`);
  });
});
afterEach(cleanup);

function Harness({ compact = false }: { compact?: boolean }) {
  const queue = useQueue(true);
  return <PullPanel queue={queue} onPulled={() => {}} compact={compact} />;
}

const READY = 'تفصيل الطلبات الجاهزة للسحب';
const NOT_READY = 'طلبات مش جاهزة للسحب';
const notReady = () => screen.queryByRole('group', { name: NOT_READY });
const ready = () => screen.getByRole('group', { name: READY });

describe('the full card', () => {
  it('draws, under the two boxes of the figure, a second group: «مؤجَّلة» 65 and «عليها إشكال» 4 — under their own line', async () => {
    render(<Harness />);
    await screen.findByText('464');
    expect(screen.getByText('مش جاهزة للسحب الآن')).toBeTruthy();
    const box = notReady()!;
    expect(box).toBeTruthy();
    expect(within(box).getByText('مؤجَّلة')).toBeTruthy();
    expect(within(box).getByText('65')).toBeTruthy();
    expect(within(box).getByText('عليها إشكال')).toBeTruthy();
    expect(within(box).getByText('4')).toBeTruthy();
    expect(within(box).getByText('لسا ما حان موعدها')).toBeTruthy();
    expect(within(box).getByText('بتستنى تصحيح')).toBeTruthy();
  });

  it('the figure and its own boxes are exactly what they were: 464 = 117 + 347, and the new boxes are NOT inside that group', async () => {
    render(<Harness />);
    await screen.findByText('464');
    const own = ready();
    expect(within(own).getByText('117')).toBeTruthy();
    expect(within(own).getByText('347')).toBeTruthy();
    expect(within(own).queryByText('مؤجَّلة')).toBeNull();
    expect(within(own).queryByText('عليها إشكال')).toBeNull();
    // the two groups are two groups, in this order: what the button hands out, then what it does not
    const groups = screen.getAllByRole('group').map((g) => g.getAttribute('aria-label'));
    expect(groups.indexOf(READY)).toBeLessThan(groups.indexOf(NOT_READY));
  });

  it('the old line of small print for the postponed is gone from the full card — its box replaced it — and the colleagues’ line stays', async () => {
    render(<Harness />);
    await screen.findByText('464');
    expect(screen.queryByText(/و65 مؤجَّلة حتى موعدها/)).toBeNull();
    expect(screen.getByText(/و1 تابعة لزميلاتك/)).toBeTruthy();
  });

  it('there is still ONE pull button, and the two boxes are numbers, not buttons or links', async () => {
    render(<Harness />);
    await screen.findByText('464');
    expect(screen.getAllByRole('button', { name: /اسحب/ })).toHaveLength(1);
    const box = notReady()!;
    expect(within(box).queryAllByRole('button')).toHaveLength(0);
    expect(within(box).queryAllByRole('link')).toHaveLength(0);
  });

  it('NEGATIVE: with no `openIssues` in the answer (a person who may not open the list, or an older server) there is the postponed box ALONE — no issues box, no zero', async () => {
    delete pool.openIssues;
    render(<Harness />);
    await screen.findByText('464');
    const box = notReady()!;
    expect(within(box).getByText('مؤجَّلة')).toBeTruthy();
    expect(within(box).queryByText('عليها إشكال')).toBeNull();
    expect(within(box).queryByText('بتستنى تصحيح')).toBeNull();
  });

  it('zero issues with a postponed order: both boxes, the issues one reading 0 (a statement, for whoever may open the list)', async () => {
    pool.openIssues = 0;
    render(<Harness />);
    await screen.findByText('464');
    const box = notReady()!;
    expect(within(box).getByText('عليها إشكال')).toBeTruthy();
    expect(within(box).getByText('0')).toBeTruthy();
    expect(within(box).getByText('65')).toBeTruthy();
  });

  it('issues but nothing on a date: both boxes (the postponed one reads 0)', async () => {
    pool.waitingOnADate = 0;
    pool.openIssues = 4;
    render(<Harness />);
    await screen.findByText('464');
    const box = notReady()!;
    expect(within(box).getByText('مؤجَّلة')).toBeTruthy();
    expect(within(box).getByText('0')).toBeTruthy();
    expect(within(box).getByText('4')).toBeTruthy();
  });

  it('NEGATIVE: nothing postponed and no issues — no group and no caption at all (two zeroes say nothing)', async () => {
    pool.waitingOnADate = 0;
    pool.openIssues = 0;
    render(<Harness />);
    await screen.findByText('464');
    expect(notReady()).toBeNull();
    expect(screen.queryByText('مش جاهزة للسحب الآن')).toBeNull();
  });

  it('a pool of nothing but far-off promises still shows its box (it used to be only the line) — and the boxes of the figure are not drawn', async () => {
    pool = { ...structuredClone(POOL), waiting: 0, waitingNew: 0, waitingReturned: 0, waitingDue: 0, waitingOnADate: 65, openIssues: 0, reservedForColleagues: 0 };
    render(<Harness />);
    await screen.findByText('0', { selector: 'p.text-4xl' });
    expect(within(notReady()!).getByText('65')).toBeTruthy();
    expect(screen.queryByRole('group', { name: READY })).toBeNull();
  });
});

describe('the slim bar of «طلباتي» is untouched', () => {
  it('one line for the figure, the postponed still a LINE, and no boxes, no issues', async () => {
    render(<Harness compact />);
    await screen.findByText('464');
    expect(screen.getByText(/و65 مؤجَّلة حتى موعدها/)).toBeTruthy();
    expect(notReady()).toBeNull();
    expect(screen.queryByText('عليها إشكال')).toBeNull();
    expect(screen.queryByText('مش جاهزة للسحب الآن')).toBeNull();
  });
});

describe('NO NEW CSS — every class the card draws is one the product already ships', () => {
  const root = join(process.cwd(), 'src');
  const files: string[] = [];
  (function walk(dir: string) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(tsx|ts)$/.test(name) && !/\.test\./.test(name)) files.push(p);
    }
  })(root);
  const classesOf = (src: string) => [...src.matchAll(/className=(?:"([^"]+)"|\{`([^`]+)`\})/g)].flatMap((m) => (m[1] ?? m[2] ?? '').replace(/\$\{[^}]*\}/g, ' ').split(/\s+/).filter(Boolean));

  it('`PullPanel`’s classes all appear in another source file', () => {
    const own = join(root, 'components/confirmation/PullPanel.tsx');
    const used = new Set(classesOf(readFileSync(own, 'utf8')));
    expect(used.size).toBeGreaterThan(20);
    const elsewhere = new Set(files.filter((f) => f !== own).flatMap((f) => classesOf(readFileSync(f, 'utf8'))));
    const brandNew = [...used].filter((c) => !elsewhere.has(c));
    expect(brandNew, `classes nobody else ships: ${brandNew.join(' ')}`).toEqual([]);
  });
});
