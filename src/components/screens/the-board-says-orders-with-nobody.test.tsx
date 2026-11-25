// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE (request Q5c, 21/11) — «طلبات بلا موظفة» on the queue's health board.
 *
 *  1. The door answers the line in the server's words only while a routing rule is in force (`health.unstaffed` present) — with 0 too; without one, no key.
 *  2. The board says the server's line under the tiles; without it the board is as it was. Nothing is counted in the browser.
 * ═══════════════════════════════════════════════════════════════════════
 */

const h = vi.hoisted(() => ({ unstaffed: undefined as number | undefined, answer: null as unknown }));

vi.mock('@/lib/geo-context', () => ({
  requireContext: async () => ({
    companyId: 'c1', storeId: 's1',
    country: { timezone: 'Asia/Damascus', workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5] },
  }),
}));
vi.mock('@/lib/authorization', () => ({ requirePermission: async () => ({ id: 'sup' }) }));
vi.mock('@/lib/db', () => ({ db: {} }));
vi.mock('@/lib/queue-priority-switch', () => ({ queuePrioritySwitch: async () => ({ enabled: true }) }));
vi.mock('@/lib/heavy-lane', () => ({ REPORT_TTL_MS: 60_000, heavyOnce: async (_k: string, _t: number, fn: () => unknown) => fn() }));
vi.mock('@/lib/queue-recalibration', () => ({ readRecalibration: async () => null }));
vi.mock('@/lib/queue-health', () => ({
  readQueueHealth: async () => ({ backlog: 3, dueNow: 1, oldestDueHours: null, enteredToday: 1, closedToday: 1, newWaiting: 0, oldestNewMinutes: null, noPullMinutes: null, inShift: true }),
}));
vi.mock('@/lib/routing-health', () => ({ readUnstaffedOrders: async () => h.unstaffed }));
vi.mock('@/lib/api-client', () => ({ apiJson: async () => h.answer }));

import { GET } from '@/app/api/confirmation/health/route';
import { QueueHealthBoard } from './QueueHealthBoard';
import { unstaffedLine } from '@/lib/queue-health-words';

beforeEach(() => {
  h.unstaffed = undefined;
  h.answer = null;
});
afterEach(cleanup);

describe('1 · the door', () => {
  it('no routing rule in force: no «unstaffed» key — the answer is as before', async () => {
    const body = await (await GET()).json();
    expect(body.enabled).toBe(true);
    expect('unstaffed' in body).toBe(false);
    expect('unstaffed' in body.health).toBe(false);
  });

  it.each([0, 7])('a routing rule in force: the line in the server\'s words, %s orders', async (n) => {
    h.unstaffed = n;
    const body = await (await GET()).json();
    expect(body.unstaffed).toBe(unstaffedLine(n));
    expect(body.unstaffed).toContain(`طلبات بلا موظفة: ${n}`);
  });

  it('NEGATIVE: the words exist only with a count', () => {
    expect(unstaffedLine(undefined)).toBeNull();
    expect(unstaffedLine(3)).toMatch(/بتروح لكل الموظفات/);
    expect(unstaffedLine(3)).not.toMatch(/[٠-٩]/);
  });
});

describe('2 · the board', () => {
  const answer = (extra: Record<string, unknown> = {}) => ({
    enabled: true,
    health: { backlog: 3, dueNow: 1, oldestDueHours: null, enteredToday: 1, closedToday: 1, newWaiting: 0, oldestNewMinutes: null, noPullMinutes: null, inShift: true },
    alerts: [],
    rule: 'قاعدة الاحتساب',
    ...extra,
  });

  it('says the server\'s line under the tiles', async () => {
    h.answer = answer({ unstaffed: unstaffedLine(4) });
    const { container } = render(<QueueHealthBoard />);
    await screen.findByText('صحة الطابور');
    expect(container.querySelector('[data-unstaffed]')!.textContent).toBe(unstaffedLine(4));
  });

  it('NEGATIVE: without the line, the board is as it was', async () => {
    h.answer = answer();
    const { container } = render(<QueueHealthBoard />);
    await screen.findByText('صحة الطابور');
    expect(container.querySelector('[data-unstaffed]')).toBeNull();
    expect(container.textContent).not.toContain('طلبات بلا موظفة');
  });

  it('counts nothing itself: the board imports no word of the line', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/screens/QueueHealthBoard.tsx'), 'utf8');
    expect(src).not.toContain('unstaffedLine');
    expect(src).not.toContain('طلبات بلا موظفة:');
  });
});
