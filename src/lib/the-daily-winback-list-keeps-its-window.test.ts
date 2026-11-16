import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dailyVerdict, dailyWindow, foldLines, readDailyList } from './winback-daily';
import { CALL_RESULTS, DAILY_FROM_HOURS, DAILY_REASONS, DAILY_TO_HOURS } from './winback-daily-words';

/**
 * ═════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — THE DAILY WINBACK LIST KEEPS ITS WINDOW (step F1)
 *
 *  1. The window is 24 to 72 hours after the outcome, both ends inclusive: 23h59m is too early, 24h is due, 72h is due, 72h and a millisecond is too late; the future is too early.
 *  2. The lost orders are asked for the four reasons of the spec (a changed mind, a price, five unanswered calls — three under the old rule), a REJECTED/CANCELLED status, not shipped, with NO
 *     replacement (nothing was offered yet) — in this company and store; the postponed ones are asked for by their date in the same window and are still postponed.
 *  3. The LAST lost decision of an order is the one that counts; a missed-date order is flagged as that kind (a call list only).
 *  4. Who calls and what the last call came to are the LATEST audit lines of the two kinds; malformed lines and results outside the four are ignored.
 *  5. Reads only, and no customer field is selected.
 * ═════════════════════════════════════════════════════════════════
 */

const NOW = new Date('2026-11-20T12:00:00.000Z');
const ago = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);

describe('the window', () => {
  it('is 24 to 72 hours, both ends inclusive', () => {
    expect(dailyVerdict(ago(23 + 59 / 60), NOW)).toBe('TOO_EARLY');
    expect(dailyVerdict(ago(24), NOW)).toBe('DUE');
    expect(dailyVerdict(ago(48), NOW)).toBe('DUE');
    expect(dailyVerdict(ago(72), NOW)).toBe('DUE');
    expect(dailyVerdict(new Date(ago(72).getTime() - 1), NOW)).toBe('TOO_LATE');
    expect(dailyVerdict(ago(-3), NOW)).toBe('TOO_EARLY');
  });

  it('the figures are the spec\'s, and the window the database is asked for is the same one', () => {
    expect([DAILY_FROM_HOURS, DAILY_TO_HOURS]).toEqual([24, 72]);
    const w = dailyWindow(NOW);
    expect(w.latest.toISOString()).toBe(ago(24).toISOString());
    expect(w.earliest.toISOString()).toBe(ago(72).toISOString());
    expect(dailyVerdict(w.latest, NOW)).toBe('DUE');
    expect(dailyVerdict(w.earliest, NOW)).toBe('DUE');
  });

  it('the reasons are the four of the spec (the 5-attempt close and, under the old rule, the 3-attempt one)', () => {
    expect([...DAILY_REASONS].sort()).toEqual(['CUSTOMER_CHANGED_MIND', 'NO_ANSWER_3_ATTEMPTS', 'NO_ANSWER_5_ATTEMPTS', 'PRICE_TOO_HIGH']);
  });
});

describe('the audit lines: who calls, and what the last call came to', () => {
  const line = (action: string, entityId: string, userId: string | null, data: unknown, hours: number) => ({ action, entityId, userId, newData: typeof data === 'string' ? data : JSON.stringify(data), createdAt: ago(hours) });
  const names = new Map([['u1', 'سارة'], ['u2', 'هدى'], ['boss', 'المشرفة']]);

  it('the latest assignment and the latest call win, per order', () => {
    const folded = foldLines(
      [
        line('WINBACK_ASSIGNED', 'o1', 'boss', { assigneeId: 'u1' }, 10),
        line('WINBACK_ASSIGNED', 'o1', 'boss', { assigneeId: 'u2' }, 5),
        line('WINBACK_CALLED', 'o1', 'u2', { result: 'NO_ANSWER' }, 4),
        line('WINBACK_CALLED', 'o1', 'u2', { result: 'AGREED', note: 'وافق على العرض' }, 2),
        line('WINBACK_CALLED', 'o2', 'u1', { result: 'DECLINED' }, 3),
      ],
      names
    );
    expect(folded.get('o1')?.assignee).toEqual({ id: 'u2', name: 'هدى' });
    expect(folded.get('o1')?.lastCall).toMatchObject({ result: 'AGREED', note: 'وافق على العرض', by: 'هدى' });
    expect(folded.get('o2')?.assignee).toBeNull();
    expect(folded.get('o2')?.lastCall?.result).toBe('DECLINED');
  });

  it('lines lines may come in any order, and malformed or foreign ones are ignored', () => {
    const folded = foldLines(
      [
        line('WINBACK_CALLED', 'o1', 'u1', { result: 'AGREED' }, 1),
        line('WINBACK_CALLED', 'o1', 'u1', { result: 'NO_ANSWER' }, 9),
        line('WINBACK_CALLED', 'o1', 'u1', { result: 'SOMETHING_ELSE' }, 0.5),
        line('WINBACK_CALLED', 'o1', 'u1', 'not json', 0.4),
        line('WINBACK_ASSIGNED', 'o1', 'boss', { assigneeId: 7 }, 0.3),
        line('SOMETHING', 'o1', 'u1', { result: 'DECLINED' }, 0.2),
      ],
      names
    );
    expect(folded.get('o1')?.lastCall?.result).toBe('AGREED');
    expect(folded.get('o1')?.assignee).toBeNull();
    expect(CALL_RESULTS).toEqual(['NO_ANSWER', 'DECLINED', 'AGREED', 'CALL_LATER']);
  });

  it('a note is cut to 200 characters', () => {
    const folded = foldLines([line('WINBACK_CALLED', 'o1', 'u1', { result: 'AGREED', note: 'ا'.repeat(300) }, 1)], names);
    expect(folded.get('o1')?.lastCall?.note).toHaveLength(200);
  });
});

describe('the reads', () => {
  function client(over: { lost?: unknown[]; postponed?: unknown[]; lines?: unknown[] } = {}) {
    return {
      orderStatusLog: { findMany: vi.fn(async (..._a: unknown[]) => over.lost ?? []) },
      order: { findMany: vi.fn(async (..._a: unknown[]) => over.postponed ?? []) },
      auditLog: { findMany: vi.fn(async (..._a: unknown[]) => over.lines ?? []) },
      user: { findMany: vi.fn(async (..._a: unknown[]) => [{ id: 'u1', name: 'سارة' }]) },
    };
  }

  it('asks this company and store, the four reasons, a lost status, not shipped, no replacement, in the window — and the postponed ones by their date', async () => {
    const c = client();
    await readDailyList(c as never, { companyId: 'c1', storeId: 's1' }, NOW);
    const lost = (c.orderStatusLog.findMany.mock.calls[0] as unknown as [{ where: Record<string, any> }])[0].where;
    expect(lost).toMatchObject({ companyId: 'c1', statusType: 'CONFIRMATION', newValue: { in: ['REJECTED', 'CANCELLED'] }, createdAt: { gte: ago(72), lte: ago(24) } });
    expect(lost.order).toMatchObject({ storeId: 's1', shippedAt: null, replacedBy: null, replacesOrderId: null, rejectionReason: { in: [...DAILY_REASONS] } });
    const post = (c.order.findMany.mock.calls[0] as unknown as [{ where: Record<string, any> }])[0].where;
    expect(post).toMatchObject({ companyId: 'c1', storeId: 's1', confirmationStatus: 'POSTPONED' });
    expect(post.OR).toEqual([{ postponedUntil: { gte: ago(72), lte: ago(24) } }, { postponedUntil: null, nextFollowUpAt: { gte: ago(72), lte: ago(24) } }]);
  });

  it('the last lost decision of an order counts once; a missed date is its own kind; newest first; and nothing is asked of the audit when the list is empty', async () => {
    const empty = client();
    expect(await readDailyList(empty as never, { companyId: 'c1', storeId: 's1' }, NOW)).toEqual([]);
    expect(empty.auditLog.findMany).not.toHaveBeenCalled();

    const c = client({
      lost: [
        { orderId: 'o1', createdAt: ago(30), order: { orderNumber: 'ORD-1', rejectionReason: 'PRICE_TOO_HIGH' } },
        { orderId: 'o1', createdAt: ago(50), order: { orderNumber: 'ORD-1', rejectionReason: 'PRICE_TOO_HIGH' } },
        { orderId: 'o3', createdAt: ago(40), order: { orderNumber: 'ORD-3', rejectionReason: null } },
      ],
      postponed: [{ id: 'o2', orderNumber: 'ORD-2', postponedUntil: ago(60), nextFollowUpAt: null }, { id: 'o9', orderNumber: 'ORD-9', postponedUntil: null, nextFollowUpAt: null }],
      lines: [{ entityId: 'o2', action: 'WINBACK_ASSIGNED', userId: 'u1', newData: JSON.stringify({ assigneeId: 'u1' }), createdAt: ago(1) }],
    });
    const items = await readDailyList(c as never, { companyId: 'c1', storeId: 's1' }, NOW);
    expect(items.map((i) => [i.orderNumber, i.kind])).toEqual([['ORD-1', 'LOST'], ['ORD-3', 'LOST'], ['ORD-2', 'MISSED_POSTPONED']]);
    expect(items[0].reasonAr).toBeTruthy();
    expect(items.find((i) => i.orderNumber === 'ORD-2')?.assignee).toEqual({ id: 'u1', name: 'سارة' });
    expect(items.find((i) => i.orderNumber === 'ORD-2')?.reasonAr).toContain('فات موعد');
  });

  it('only reads, and selects no customer field', () => {
    const src = readFileSync('src/lib/winback-daily.ts', 'utf8').split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.trim().startsWith('/*')).join('\n');
    expect(src).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/);
    expect(src).not.toMatch(/customer|rawPhone|phone|address/i);
  });
});
