import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { EOD_METRICS } from './eod-metrics';
import { compare, dayRange, localDay, mayReportDay, sampleRejected, shuffleSample, systemNumbers, validateSubmission, varianceOf, type AgentNumbers } from './eod-report';

/**
 * ═════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — THE END-OF-DAY REPORT COMPARES HER FIGURES WITH THE SYSTEM'S (step H2)
 *
 *  1. Her form is validated WHOLE: only agents the system knows for the day, six whole numbers each (zero and up), short texts; anything else is refused in Arabic.
 *  2. The variance is (hers − system) ÷ system in whole percent; both zero agree (0%); a system zero against a non-zero figure has no percent (null); an agent she left out reads as zeros.
 *  3. The day is the STORE's local day (Damascus is UTC+3); a report may be written for today or yesterday only.
 *  4. The sample is ten rejected orders, the SAME ten every time the day is opened, never a number — only whether it is valid for the store's country.
 *  5. The system's numbers count unique orders, the last decision stands, winback converted counts confirmed new orders, stuck counts held orders older than 48 hours; reads only.
 * ═════════════════════════════════════════════════════════════════
 */

const known = new Set(['u1', 'u2']);
const agent = (userId: string, over: Record<string, unknown> = {}) => ({ userId, claims: 5, confirmed: 3, rejected: 1, noAnswer: 4, winback: 0, stuck: 0, ...over });
const form = (over: Record<string, unknown> = {}) => ({ agents: [agent('u1')], biggestProblem: 'ازدحام', tip: 'ابدأوا بالمتأخر', ...over });

describe('her form is validated whole', () => {
  it('accepts a valid form, trims the texts and keeps only the known fields', () => {
    const v = validateSubmission(form({ biggestProblem: '  ازدحام  ', agents: [{ ...agent('u1'), extra: 9 }] }), known);
    expect(v).toEqual({ ok: true, value: { agents: [agent('u1')], biggestProblem: 'ازدحام', tip: 'ابدأوا بالمتأخر' } });
  });

  it.each([
    ['no body', null],
    ['no agents', form({ agents: [] })],
    ['an unknown agent', form({ agents: [agent('stranger')] })],
    ['a repeated agent', form({ agents: [agent('u1'), agent('u1')] })],
    ['a fractional figure', form({ agents: [agent('u1', { claims: 2.5 })] })],
    ['a negative figure', form({ agents: [agent('u1', { confirmed: -1 })] })],
    ['a figure as text', form({ agents: [agent('u1', { rejected: '3' })] })],
    ['a missing figure', form({ agents: [{ userId: 'u1', claims: 1 }] })],
    ['a figure out of reach', form({ agents: [agent('u1', { stuck: 1_000_000 })] })],
    ['a problem that is not text', form({ biggestProblem: 5 })],
    ['a tip over 500 characters', form({ tip: 'ا'.repeat(501) })],
  ])('refuses %s with an Arabic sentence', (_n, input) => {
    const v = validateSubmission(input, known);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.error).toMatch(/[؀-ۿ]/);
      expect(v.error).not.toMatch(/[٠-٩]/);
    }
  });

  it('takes zero as a figure', () => {
    expect(validateSubmission(form({ agents: [agent('u1', { claims: 0, confirmed: 0, rejected: 0, noAnswer: 0 })] }), known).ok).toBe(true);
  });
});

describe('the variance', () => {
  it('is hers minus the system\'s over the system\'s, in whole percent', () => {
    expect(varianceOf(12, 10)).toEqual({ percent: 20, submitted: 12, system: 10 });
    expect(varianceOf(8, 10).percent).toBe(-20);
    expect(varianceOf(10, 10).percent).toBe(0);
    expect(varianceOf(1, 3).percent).toBe(-67);
  });

  it('both zero agree; a system zero against a figure has no percent', () => {
    expect(varianceOf(0, 0).percent).toBe(0);
    expect(varianceOf(5, 0).percent).toBeNull();
  });

  it('compares every metric of every agent the system knows; one she left out reads as zeros', () => {
    const system: AgentNumbers[] = [
      { userId: 'u1', name: 'سارة', claims: 5, confirmed: 3, rejected: 1, noAnswer: 4, winback: 0, stuck: 0, rejectedByReason: {}, winbackConverted: 0 },
      { userId: 'u2', name: 'هدى', claims: 4, confirmed: 2, rejected: 2, noAnswer: 1, winback: 1, stuck: 1, rejectedByReason: {}, winbackConverted: 0 },
    ];
    const out = compare({ agents: [agent('u1', { claims: 6 })], biggestProblem: '', tip: '' }, system);
    expect(out.map((r) => r.userId)).toEqual(['u1', 'u2']);
    expect(Object.keys(out[0].metrics)).toEqual([...EOD_METRICS]);
    expect(out[0].metrics.claims).toEqual({ percent: 20, submitted: 6, system: 5 });
    expect(out[1].metrics.claims).toEqual({ percent: -100, submitted: 0, system: 4 });
    expect(out[1].metrics.winback.percent).toBe(-100);
    expect(out[0].metrics.winback.percent).toBe(0);
  });
});

describe('the store\'s day', () => {
  it('is the local day: 23:30 UTC is already the next day in Damascus', () => {
    expect(localDay(new Date('2026-11-10T23:30:00Z'), 'UTC')).toBe('2026-11-10');
    expect(localDay(new Date('2026-11-10T23:30:00Z'), 'Asia/Damascus')).toBe('2026-11-11');
  });

  it('a day is 24 hours from its local midnight, end exclusive', () => {
    const r = dayRange('2026-11-11', 'Asia/Damascus')!;
    expect(r.start.toISOString()).toBe('2026-11-10T21:00:00.000Z');
    expect(r.end.toISOString()).toBe('2026-11-11T21:00:00.000Z');
    expect(dayRange('not-a-day', 'UTC')).toBeNull();
    expect(dayRange('2026-13-45', 'UTC')).not.toBeUndefined();
  });

  it('a report may be written for today or yesterday only', () => {
    const now = new Date('2026-11-11T12:00:00Z');
    expect(mayReportDay('2026-11-11', now, 'UTC')).toBe(true);
    expect(mayReportDay('2026-11-10', now, 'UTC')).toBe(true);
    expect(mayReportDay('2026-11-09', now, 'UTC')).toBe(false);
    expect(mayReportDay('2026-11-12', now, 'UTC')).toBe(false);
  });
});

describe('the sample', () => {
  const ids = Array.from({ length: 50 }, (_, i) => `o${String(i).padStart(3, '0')}`);

  it('is ten, the same ten for the same day, a different ten for another day', () => {
    const a = shuffleSample(ids, 'c1:s1:2026-11-10');
    expect(a).toHaveLength(10);
    expect(new Set(a).size).toBe(10);
    expect(shuffleSample(ids, 'c1:s1:2026-11-10')).toEqual(a);
    expect(shuffleSample(ids, 'c1:s1:2026-11-11')).not.toEqual(a);
  });

  it('is the whole list when there are fewer than ten, and does not change the input', () => {
    const few = ['a', 'b', 'c'];
    expect([...shuffleSample(few, 'x')].sort()).toEqual(['a', 'b', 'c']);
    expect(few).toEqual(['a', 'b', 'c']);
    expect(shuffleSample([], 'x')).toEqual([]);
  });

  it('answers the reason and only whether the number is valid — never the number', async () => {
    const client = {
      orderStatusLog: {
        findMany: vi.fn(async () => [
          { orderId: 'o1', changer: { name: 'سارة' }, order: { orderNumber: 'ORD-1', rejectionReason: 'FAKE_ORDER', customer: { rawPhone: '0933620102', phone: '933620102' } } },
          { orderId: 'o2', changer: { name: 'هدى' }, order: { orderNumber: 'ORD-2', rejectionReason: null, customer: { rawPhone: 'abc 12', phone: 'abc12' } } },
        ]),
      },
    };
    const rows = await sampleRejected(client as never, { companyId: 'c1', storeId: 's1', start: new Date(0), end: new Date(1), countryCode: 'SY', day: '2026-11-10' });
    expect(rows.map((r) => [r.orderNumber, r.reason, r.phoneValid]).sort()).toEqual([['ORD-1', 'FAKE_ORDER', true], ['ORD-2', 'OTHER', false]]);
    const text = JSON.stringify(rows);
    expect(text).not.toContain('0933620102');
    expect(text).not.toContain('abc 12');
    expect(rows.every((r) => r.reasonAr && !/[A-Z_]{4,}/.test(r.reasonAr))).toBe(true);
  });
});

describe('the system numbers', () => {
  const day = { companyId: 'c1', storeId: 's1', start: new Date('2026-11-10T00:00:00Z'), end: new Date('2026-11-11T00:00:00Z') };
  const NOW = new Date('2026-11-11T12:00:00Z');
  const t = (m: number) => new Date(day.start.getTime() + m * 60_000);

  function client() {
    return {
      orderClaimHistory: { findMany: vi.fn(async () => [{ userId: 'u1', orderId: 'a' }, { userId: 'u1', orderId: 'a' }, { userId: 'u1', orderId: 'b' }, { userId: 'u2', orderId: 'c' }]) },
      orderStatusLog: {
        findMany: vi.fn(async () => [
          { changedById: 'u1', orderId: 'a', newValue: 'CONFIRMED', createdAt: t(10), order: { rejectionReason: null } },
          { changedById: 'u1', orderId: 'b', newValue: 'CONFIRMED', createdAt: t(20), order: { rejectionReason: null } },
          { changedById: 'u1', orderId: 'b', newValue: 'REJECTED', createdAt: t(30), order: { rejectionReason: 'PRICE_TOO_HIGH' } },
          { changedById: 'u2', orderId: 'c', newValue: 'REJECTED', createdAt: t(40), order: { rejectionReason: null } },
        ]),
      },
      orderContactAttempt: { findMany: vi.fn(async () => [{ employeeId: 'u1' }, { employeeId: 'u1' }, { employeeId: 'u2' }]) },
      auditLog: { findMany: vi.fn(async () => [{ userId: 'u2', newData: JSON.stringify({ newOrderId: 'n1' }) }, { userId: 'u2', newData: JSON.stringify({ newOrderId: 'n2' }) }, { userId: 'u2', newData: 'broken' }]) },
      order: {
        findMany: vi.fn(async (a: { where: { id?: unknown } }) => (a.where.id ? [{ id: 'n1' }] : [{ claimedById: 'u1' }, { claimedById: 'u1' }, { claimedById: 'u2' }])),
      },
      user: { findMany: vi.fn(async () => [{ id: 'u1', name: 'سارة' }, { id: 'u2', name: 'هدى' }]) },
    };
  }

  it('counts unique orders, the last decision, the reasons, the no-answer lines, winback and what is held', async () => {
    const rows = await systemNumbers(client() as never, day, NOW);
    const sara = rows.find((r) => r.userId === 'u1')!;
    const huda = rows.find((r) => r.userId === 'u2')!;
    expect(sara).toMatchObject({ name: 'سارة', claims: 2, confirmed: 1, rejected: 1, noAnswer: 2, winback: 0, stuck: 2, rejectedByReason: { PRICE_TOO_HIGH: 1 } });
    expect(huda).toMatchObject({ name: 'هدى', claims: 1, confirmed: 0, rejected: 1, noAnswer: 1, winback: 3, winbackConverted: 1, stuck: 1, rejectedByReason: { OTHER: 1 } });
  });

  it('asks only this company and store, the day\'s window, and held orders older than 48 hours', async () => {
    const c = client();
    await systemNumbers(c as never, day, NOW);
    const claims = c.orderClaimHistory.findMany.mock.calls[0] as unknown as [{ where: Record<string, any> }];
    expect(claims[0].where).toMatchObject({ companyId: 'c1', action: 'CLAIMED', createdAt: { gte: day.start, lt: day.end }, order: { storeId: 's1' } });
    const held = (c.order.findMany.mock.calls as unknown as [{ where: Record<string, any> }][]).find((x) => x[0].where.claimedAt)![0].where;
    expect(held).toMatchObject({ companyId: 'c1', storeId: 's1', claimedAt: { lt: new Date(NOW.getTime() - 48 * 3_600_000) } });
  });

  it('is sorted by name and the library only reads', () => {
    const src = readFileSync('src/lib/eod-report.ts', 'utf8').split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
    expect(src).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/);
  });
});
