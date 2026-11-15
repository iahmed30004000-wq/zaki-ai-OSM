import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workClock } from './no-answer-rounds';
import { returnsMode } from './no-answer-returns';
import { RETRY_SCAN_PAGE, RETRY_SCAN_WARN_AT, RETURNS_MODE, pickMostOverdueRetry, pickPromiseArrived } from './confirmation-queue';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — THE EARLY WARNING OF THE PULL'S SCANS (the planner 15/11 22:30, ruling 31)
 *
 * What must work. The global retry ordering is NOT built now (the live pile is 422). The log says so BEFORE it is needed: the existing `console.warn` when a scan page is full
 * (`RETRY_SCAN_PAGE`, 2000) stays, and a second one is added when a scan reads `RETRY_SCAN_WARN_AT` (1500) rows or more and is not full — the same style: a fixed sentence, the page
 * size and the count, no customer data, once per scan.
 *
 * The tests: for BOTH scans (the promise scan, the retry scan) — 1499 rows say nothing · 1500 say the early sentence · 1999 say it · 2000 say the FULL one and not the early one ·
 * exactly one line per scan · no name, no phone, no id in it · the pick (the rank, the page, the order) is unchanged by the warning.
 * Edge cases: the constants themselves are pinned (1500 / 2000) so that moving one is a decision, not an accident.
 * Blockers: no money, no order creation, no migration, no change of pick order or page size.
 * ═══════════════════════════════════════════════════════════════════════
 */

const NOW = new Date('2026-11-12T12:00:00.000Z');
const SINCE = new Date('2026-11-10T08:00:00.000Z');
const scope = { companyId: 'c1', storeId: 's1' };
const MODE = returnsMode(NOW, workClock({ workHoursStart: '00:00', workHoursEnd: '23:59', weekendDays: [], timezone: 'UTC' }), RETURNS_MODE.idleBusinessMinutes, SINCE);
const MODE_WITH_CADENCE = MODE as typeof MODE & { cadence: { since: Date } };

/** A database that answers the scan with `n` rows, each carrying a customer, as a real row would. */
const dbReading = (n: number, row: (i: number) => Record<string, unknown>) => ({ order: { findMany: vi.fn(async () => Array.from({ length: n }, (_, i) => row(i))) } }) as never;
const promiseRow = (i: number) => ({ id: `p${i}`, createdAt: new Date(NOW.getTime() - (10_000 - i) * 1000), postponedUntil: null, nextFollowUpAt: null, contactAttempts: [], customer: { fullName: 'سارة', phone: '0791234567' } });
const retryRow = (i: number) => ({ id: `r${i}`, createdAt: new Date(NOW.getTime() - (10_000 - i) * 1000), contactAttempts: [], customer: { fullName: 'سارة', phone: '0791234567' } });

const SCANS = [
  ['the promise scan', 'promise', promiseRow, (db: never) => pickPromiseArrived(db, scope, NOW, 'sara', MODE_WITH_CADENCE)],
  ['the retry scan', 'retry', retryRow, (db: never) => pickMostOverdueRetry(db, scope, NOW, 'sara', MODE_WITH_CADENCE)],
] as const;

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => warn.mockRestore());

describe('the thresholds are pinned', () => {
  it('the page is 2000 and the early warning is at 1500 — a decision to move, not an accident', () => {
    expect(RETRY_SCAN_PAGE).toBe(2000);
    expect(RETRY_SCAN_WARN_AT).toBe(1500);
  });
});

describe.each(SCANS)('%s', (_name, scanName, row, run) => {
  it('1499 rows: silent', async () => {
    await run(dbReading(1499, row));
    expect(warn).not.toHaveBeenCalled();
  });

  it('a small scan: silent', async () => {
    await run(dbReading(30, row));
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([1500, 1501, 1999])('%i rows: the EARLY sentence, once, with the page size and the count', async (n) => {
    await run(dbReading(n, row));
    expect(warn).toHaveBeenCalledTimes(1);
    const said = String(warn.mock.calls[0][0]);
    expect(said).toContain(scanName);
    expect(said).toContain('filling');
    expect(said).not.toContain('is full');
    expect(said).toContain(String(n));
    expect(said).toContain(String(RETRY_SCAN_PAGE));
    expect(warn.mock.calls[0]).toHaveLength(1);
  });

  it('2000 rows: the FULL sentence, once — and not the early one as well', async () => {
    await run(dbReading(2000, row));
    expect(warn).toHaveBeenCalledTimes(1);
    const said = String(warn.mock.calls[0][0]);
    expect(said).toContain(scanName);
    expect(said).toContain('is full');
    expect(said).not.toContain('filling');
    expect(said).toContain(String(RETRY_SCAN_PAGE));
  });

  it('no name, no phone and no order id in either sentence', async () => {
    await run(dbReading(1500, row));
    await run(dbReading(2000, row));
    expect(warn).toHaveBeenCalledTimes(2);
    for (const call of warn.mock.calls) {
      const said = String(call[0]);
      for (const leak of ['سارة', '0791234567', 'p0', 'r0', 'ORD-', 'c1', 's1']) expect(said, `leaks «${leak}»`).not.toContain(leak);
    }
  });
});

describe('the pick is the pick: the warning changes nothing it returns', () => {
  it('the promise scan still answers the promise whose date came first, at 1500 rows', async () => {
    const dated = (i: number) => ({
      id: `p${i}`,
      createdAt: new Date(NOW.getTime() - (10_000 - i) * 1000),
      postponedUntil: null,
      nextFollowUpAt: new Date(NOW.getTime() - (60_000 + (i === 7 ? 99_999 : i)) * 1000),
      contactAttempts: [],
    });
    expect(await pickPromiseArrived(dbReading(1500, dated), scope, NOW, 'sara', MODE_WITH_CADENCE)).toBe('p7');
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
