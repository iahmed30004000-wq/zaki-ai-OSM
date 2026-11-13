import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@/lib/guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — THE QUEUE SAYS WHAT IS NOT READY TO PULL (the owner, 13/11: «يضيف عليهم المؤجل والطلبات الي عليها مشاكل», over the
 * full pull card)
 *
 *  1. `GET /api/confirmation/queue` answers `openIssues` — the entry issues still OPEN in this store, the very count the work card
 *     «إشكال بستنى تصحيح» and the issues list use — next to `waitingOnADate` (the postponed orders whose day has not come).
 *  2. It is said ONLY to whoever may open that list (`confirmation.issues`): for everybody else the field is ABSENT (not zero), and the
 *     count is never even asked.
 *  3. Neither is part of the big number: `waiting` is still new + returned + due, whatever the issues are.
 *  4. Nothing else moved; the read still writes nothing (`the-queue-read-writes-nothing.test.ts`).
 * Blockers: no money, no order creation, no migration.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, can, queue } = vi.hoisted(() => ({
  db: { order: { findMany: vi.fn() }, orderIssue: { count: vi.fn() } },
  requireContext: vi.fn(),
  can: vi.fn(),
  queue: {
    waitingBreakdown: vi.fn(),
    ownedCounts: vi.fn(),
    postponedNotDueCount: vi.fn(),
    reservedForColleaguesCount: vi.fn(),
  },
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ can: (...a: unknown[]) => can(...a), requirePermission: vi.fn(async () => ({})) }));
vi.mock('@/lib/confirmation-queue', async (orig) => ({
  ...(await orig<typeof import('@/lib/confirmation-queue')>()),
  waitingBreakdown: (...a: unknown[]) => queue.waitingBreakdown(...a),
  ownedCounts: (...a: unknown[]) => queue.ownedCounts(...a),
  postponedNotDueCount: (...a: unknown[]) => queue.postponedNotDueCount(...a),
  reservedForColleaguesCount: (...a: unknown[]) => queue.reservedForColleaguesCount(...a),
}));

import { GET } from './route';
import { openIssuesCount } from '@/lib/confirmation-queue';

const COUNTRY = { workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6], timezone: 'Asia/Amman' };
const as = (id: string, keys: string[]) => {
  requireContext.mockResolvedValue({ user: { id }, companyId: 'c1', storeId: 's1', country: COUNTRY });
  can.mockImplementation((_u: unknown, k: string) => keys.includes(k));
};
const read = async () => (await GET()).json();

beforeEach(() => {
  vi.clearAllMocks();
  // The owner's screenshot of 13/11: 117 new + 347 returned = 464 ready, 65 waiting on a date, 1 held for a colleague.
  queue.waitingBreakdown.mockResolvedValue({ fresh: 117, returned: 347, due: 0 });
  queue.ownedCounts.mockResolvedValue({ total: 0, withoutAttempt: 0, untouched: null });
  queue.postponedNotDueCount.mockResolvedValue(65);
  queue.reservedForColleaguesCount.mockResolvedValue(1);
  db.order.findMany.mockResolvedValue([]);
  db.orderIssue.count.mockResolvedValue(4);
});

describe('the open entry issues travel with the queue — for whoever may open that list', () => {
  it('a puller who holds `confirmation.issues` is told 4, next to the 65 on a date — and the big number is not touched', async () => {
    as('huda', ['confirmation.pull', 'confirmation.issues']);
    const body = await read();
    expect(body).toMatchObject({ waiting: 464, waitingNew: 117, waitingReturned: 347, waitingDue: 0, waitingOnADate: 65, openIssues: 4, reservedForColleagues: 1 });
  });

  it('it is counted over THIS company and THIS store, status OPEN — exactly what the issues list and the work card count', async () => {
    as('huda', ['confirmation.pull', 'confirmation.issues']);
    await read();
    expect(db.orderIssue.count).toHaveBeenCalledTimes(1);
    expect(db.orderIssue.count.mock.calls[0][0]).toEqual({ where: { companyId: 'c1', status: 'OPEN', order: { storeId: 's1' } } });
  });

  it('a supervisor who holds the key is told too', async () => {
    as('sara', ['confirmation.supervise', 'confirmation.issues']);
    expect((await read()).openIssues).toBe(4);
  });

  it('zero is said as zero when the person may open the list (a box «0» is a statement; an absent field is not)', async () => {
    db.orderIssue.count.mockResolvedValue(0);
    as('huda', ['confirmation.pull', 'confirmation.issues']);
    const body = await read();
    expect(body).toHaveProperty('openIssues', 0);
  });

  it('NEGATIVE: a puller WITHOUT `confirmation.issues` gets no field at all — and the count is never even asked', async () => {
    as('noor', ['confirmation.pull']);
    const body = await read();
    expect(body).not.toHaveProperty('openIssues');
    expect(db.orderIssue.count).not.toHaveBeenCalled();
    // everything she had is still there
    expect(body).toMatchObject({ waiting: 464, waitingOnADate: 65, reservedForColleagues: 1 });
  });

  it('NEGATIVE: the other keys near it do not stand in for it — supervising and pulling are not reading the issues list', async () => {
    as('x', ['confirmation.pull', 'confirmation.supervise', 'confirmation.raise_issue', 'dashboard.view']);
    expect(await read()).not.toHaveProperty('openIssues');
    expect(db.orderIssue.count).not.toHaveBeenCalled();
  });

  it('the figure is NOT added to the pool: `waiting` is new + returned + due for any number of issues', async () => {
    for (const issues of [0, 4, 500]) {
      db.orderIssue.count.mockResolvedValue(issues);
      as('huda', ['confirmation.pull', 'confirmation.issues']);
      const body = await read();
      expect(body.waiting).toBe(464);
      expect(body.waiting).toBe(body.waitingNew + body.waitingReturned + body.waitingDue);
    }
  });
});

describe('one definition of «an open issue», read by the card, the work card and the list', () => {
  it('`openIssuesCount` asks the store’s OPEN issues once', async () => {
    const tx = { orderIssue: { count: vi.fn().mockResolvedValue(9) } };
    expect(await openIssuesCount(tx as never, { companyId: 'c9', storeId: 's9' })).toBe(9);
    expect(tx.orderIssue.count).toHaveBeenCalledWith({ where: { companyId: 'c9', status: 'OPEN', order: { storeId: 's9' } } });
  });

  it('the work card (`ISSUES_OPEN` in /api/me/work) counts with the very same where', () => {
    const root = process.cwd();
    const work = stripComments(readFileSync(join(root, 'src/app/api/me/work/route.ts'), 'utf8'));
    expect(work).toMatch(/db\.orderIssue\.count\(\{ where: \{ companyId, status: 'OPEN', order: \{ storeId \} \} \}\)/);
    const lib = stripComments(readFileSync(join(root, 'src/lib/confirmation-queue.ts'), 'utf8'));
    expect(lib).toMatch(/orderIssue\.count\(\{ where: \{ companyId: scope\.companyId, status: 'OPEN', order: \{ storeId: scope\.storeId \} \} \}\)/);
  });
});
