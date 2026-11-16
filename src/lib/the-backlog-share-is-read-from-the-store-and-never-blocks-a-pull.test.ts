import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SHARE_CACHE_MS, readBacklogShare, recentPullLanes } from './queue-priority-share';
import { QUEUE_PRIORITY } from './queue-priority';

/**
 * ═════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — THE READS BEHIND QUEUE PRIORITY v2 (step D1)
 *
 *  1. The share is counted over ONE store (company + store in every query), over the last 7 days, with the three counts the rule names: distinct customers who ordered, orders
 *     whose FIRST «لا يرد» line is that recent, and open backlog older than 48 hours.
 *  2. It is kept for 30 minutes per store: a second pull inside it asks nothing; another store is its own reading.
 *  3. A read that fails is the study's default share, never an error — and the failure is kept for the same 30 minutes (a broken database is not asked on every pull).
 *  4. An agent's latest pulls are read newest first from the claim history of `PULL_NEXT`, as lanes: lines without a lane are skipped, and at most `recentPulls` are kept.
 *  5. Both are reads: no create, update or delete anywhere in the file.
 * ═════════════════════════════════════════════════════════════════
 */

const NOW = new Date('2026-11-12T12:00:00.000Z');
const OPEN = ['NEW', 'IN_PROGRESS'];

function client(counts: { customers?: number; entered?: number; stale?: number; boom?: boolean } = {}) {
  const c = {
    order: {
      findMany: vi.fn(async (_a: unknown) => {
        if (counts.boom) throw new Error('db down');
        return Array.from({ length: counts.customers ?? 0 }, (_, i) => ({ customerId: `c${i}` }));
      }),
      count: vi.fn(async (a: { where: { contactAttempts: { some: Record<string, unknown> } } }) => {
        if (counts.boom) throw new Error('db down');
        // the «entered» count has `none` beside `some`; the stale one has `some: {}` only
        return 'none' in a.where.contactAttempts ? (counts.entered ?? 0) : (counts.stale ?? 0);
      }),
    },
    orderClaimHistory: { findMany: vi.fn(async () => [] as { metadata: string | null }[]) },
  };
  return c;
}

describe('the share is counted over one store, over seven days', () => {
  it('asks for this company and store only, from seven days ago, and the first «لا يرد» line of the backlog', async () => {
    const c = client({ customers: 700, entered: 300, stale: 200 });
    const r = await readBacklogShare(c as never, { companyId: 'cA', storeId: 'sA' }, NOW, OPEN);
    expect(r.result.share).toBeCloseTo(0.34, 10);
    expect(r.note).toContain('34%');

    const since = new Date(NOW.getTime() - 7 * 86_400_000);
    const customers = c.order.findMany.mock.calls[0][0] as { where: Record<string, unknown>; distinct: string[] };
    expect(customers.where).toMatchObject({ companyId: 'cA', storeId: 'sA', createdAt: { gte: since }, replacesOrderId: null });
    expect(customers.distinct).toEqual(['customerId']);

    const [entered, stale] = c.order.count.mock.calls.map((x) => x[0].where as Record<string, any>);
    expect(entered).toMatchObject({ companyId: 'cA', storeId: 'sA' });
    expect(entered.contactAttempts.some).toMatchObject({ result: { in: ['NO_ANSWER', 'BUSY', 'UNREACHABLE'] }, createdAt: { gte: since } });
    expect(entered.contactAttempts.none).toMatchObject({ result: { in: ['NO_ANSWER', 'BUSY', 'UNREACHABLE'] }, createdAt: { lt: since } });
    expect(stale).toMatchObject({ companyId: 'cA', storeId: 'sA', confirmationStatus: { in: OPEN }, createdAt: { lt: new Date(NOW.getTime() - 48 * 3_600_000) }, contactAttempts: { some: {} } });
  });

  it('is kept 30 minutes per store: the second pull asks nothing, another store is its own reading, and after 30 minutes it asks again', async () => {
    const c = client({ customers: 10, entered: 5, stale: 0 });
    await readBacklogShare(c as never, { companyId: 'cB', storeId: 'sB' }, NOW, OPEN);
    await readBacklogShare(c as never, { companyId: 'cB', storeId: 'sB' }, new Date(NOW.getTime() + SHARE_CACHE_MS - 1), OPEN);
    expect(c.order.findMany).toHaveBeenCalledTimes(1);
    await readBacklogShare(c as never, { companyId: 'cB', storeId: 'sB2' }, NOW, OPEN);
    expect(c.order.findMany).toHaveBeenCalledTimes(2);
    await readBacklogShare(c as never, { companyId: 'cB', storeId: 'sB' }, new Date(NOW.getTime() + SHARE_CACHE_MS), OPEN);
    expect(c.order.findMany).toHaveBeenCalledTimes(3);
  });

  it('a read that fails is the study\'s default, kept for the same 30 minutes, and never an error', async () => {
    const c = client({ boom: true });
    const r = await readBacklogShare(c as never, { companyId: 'cC', storeId: 'sC' }, NOW, OPEN);
    expect(r.result.share).toBe(QUEUE_PRIORITY.shareDefault);
    expect(r.note).toContain('37%');
    await readBacklogShare(c as never, { companyId: 'cC', storeId: 'sC' }, new Date(NOW.getTime() + 60_000), OPEN);
    expect(c.order.findMany).toHaveBeenCalledTimes(1);
  });
});

describe('an agent\'s latest pulls', () => {
  it('are read newest first from the PULL_NEXT claims of that user, as lanes; lines without a lane are skipped', async () => {
    const c = client();
    c.orderClaimHistory.findMany.mockResolvedValueOnce([
      { metadata: '{"role":"A","lane":"BACKLOG"}' },
      { metadata: '{"role":"A"}' },
      { metadata: null },
      { metadata: '{"role":"A","lane":"NEW"}' },
      { metadata: 'broken' },
      { metadata: '{"lane":"NEW"}' },
    ]);
    expect(await recentPullLanes(c as never, 'sara')).toEqual(['BACKLOG', 'NEW', 'NEW']);
    expect(c.orderClaimHistory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'sara', action: 'CLAIMED', reason: 'PULL_NEXT' }, orderBy: { createdAt: 'desc' } })
    );
  });

  it('keeps at most the window', async () => {
    const c = client();
    c.orderClaimHistory.findMany.mockResolvedValueOnce(Array.from({ length: 40 }, () => ({ metadata: '{"lane":"NEW"}' })));
    expect(await recentPullLanes(c as never, 'sara')).toHaveLength(QUEUE_PRIORITY.recentPulls);
  });
});

describe('both are reads', () => {
  it('the file writes nothing', () => {
    const src = readFileSync(join(process.cwd(), 'src/lib/queue-priority-share.ts'), 'utf8');
    expect(src).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/);
    expect(src).not.toContain('$executeRaw');
  });
});
