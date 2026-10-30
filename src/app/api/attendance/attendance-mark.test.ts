import { beforeEach, describe, expect, it, vi } from 'vitest';

const { db, requireContext } = vi.hoisted(() => ({
  db: {
    attendanceMark: { findFirst: vi.fn(), create: vi.fn(), findMany: vi.fn() },
    orderClaimHistory: { findFirst: vi.fn() },
    order: { findFirst: vi.fn() },
    // PR-13 (D11): a person outside the eight jobs is asked about her stored shift.
    user: { findUnique: vi.fn() },
  },
  requireContext: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));

import { GET, POST } from './mark/route';

/**
 * The fingerprint button. An attendance system has exactly one thing it
 * must never allow: marking somebody else's arrival.
 */

const post = (body: unknown) =>
  POST(
    new Request('http://localhost/api/attendance/mark', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({
    user: { id: 'me', name: 'سارة', role: 'CONFIRMATION_AGENT' },
    companyId: 'c1',
    storeId: 's1',
    country: { timezone: 'Asia/Amman', workHoursStart: '09:00', workHoursEnd: '17:00' },
  });
  db.attendanceMark.findFirst.mockResolvedValue(null);
  db.attendanceMark.findMany.mockResolvedValue([]);
  db.orderClaimHistory.findFirst.mockResolvedValue(null);
  db.order.findFirst.mockResolvedValue(null);
  db.user.findUnique.mockResolvedValue({ shiftStart: null, shiftEnd: null, restDays: null });
  db.attendanceMark.create.mockResolvedValue({ at: new Date('2026-09-21T06:00:00Z') });
});

describe('marking attendance', () => {
  it('writes the mark for whoever holds the session', async () => {
    const res = await post({ kind: 'CHECK_IN' });
    expect(res.status).toBe(200);
    expect(db.attendanceMark.create.mock.calls[0][0].data).toMatchObject({
      userId: 'me',
      kind: 'CHECK_IN',
      source: 'MANUAL',
    });
  });

  it('cannot be aimed at another employee', async () => {
    // There is no userId to forge: a body that names somebody else still
    // writes the mark for the person signed in.
    await post({ kind: 'CHECK_IN', userId: 'somebody-else' });
    expect(db.attendanceMark.create.mock.calls[0][0].data.userId).toBe('me');
  });

  it('refuses a kind that is not arriving or leaving', async () => {
    // LOGIN is the system's to write, never a button's.
    const res = await post({ kind: 'LOGIN' });
    expect(res.status).toBe(400);
    expect(db.attendanceMark.create).not.toHaveBeenCalled();
  });

  it('treats a double tap as one arrival', async () => {
    // A day must not gain minutes because somebody pressed twice.
    db.attendanceMark.findFirst.mockResolvedValue({ id: 'm1', at: new Date('2026-09-21T06:00:00Z') });
    const res = await post({ kind: 'CHECK_IN' });
    expect((await res.json()).duplicate).toBe(true);
    expect(db.attendanceMark.create).not.toHaveBeenCalled();
  });

  it('lets a check-out through right after a check-in', async () => {
    // The duplicate guard is per kind: leaving is not a repeat of arriving.
    db.attendanceMark.findFirst.mockResolvedValue(null);
    await post({ kind: 'CHECK_OUT' });
    expect(db.attendanceMark.findFirst.mock.calls[0][0].where.kind).toBe('CHECK_OUT');
    expect(db.attendanceMark.create).toHaveBeenCalled();
  });
});

describe('who is shown a shift at all', () => {
  const asRole = (role: string) =>
    requireContext.mockResolvedValue({
      user: { id: 'me', name: 'من', role },
      companyId: 'c1',
      storeId: 's1',
      country: { timezone: 'Asia/Amman', workHoursStart: '09:00', workHoursEnd: '17:00' },
    });

  it('does not offer one to the owner', async () => {
    // The person who sets the hours does not clock in, and a button shown
    // to them teaches everybody that the control is decorative.
    asRole('SUPER_ADMIN');
    expect(await (await GET()).json()).toEqual({ shift: false });
    expect(db.attendanceMark.findMany).not.toHaveBeenCalled();
  });

  it('does not offer one to the company admin either', async () => {
    asRole('COMPANY_ADMIN');
    expect((await (await GET()).json()).shift).toBe(false);
  });

  it('offers one to a confirmation agent', async () => {
    asRole('CONFIRMATION_AGENT');
    expect((await (await GET()).json()).shift).toBe(true);
  });

  it("counts a confirmation agent by what she pulls from the pool", async () => {
    asRole('CONFIRMATION_AGENT');
    db.orderClaimHistory.findFirst.mockResolvedValue({ createdAt: new Date('2026-09-21T06:00:00Z') });
    const body = await (await GET()).json();
    expect(body.lastAction.label).toContain('سحبته');
    expect(db.order.findFirst).not.toHaveBeenCalled();
  });

  it('counts a moderator by what he brings in', async () => {
    // Same question, a different record: a moderator never claims from the
    // pool, so a claim-based counter would read "—" forever.
    asRole('MODERATOR');
    db.order.findFirst.mockResolvedValue({ createdAt: new Date('2026-09-21T06:00:00Z') });
    const body = await (await GET()).json();
    expect(body.lastAction.label).toContain('رفعته');
    expect(db.order.findFirst.mock.calls[0][0].where.moderatorId).toBe('me');
  });

  it('says plainly when there is nothing to count yet', async () => {
    asRole('MODERATOR');
    const body = await (await GET()).json();
    expect(body.shift).toBe(true);
    expect(body.lastAction).toBeNull();
  });
});

/**
 * D11 (perm-plan PR-13): the chip follows the SHIFT, not only the role's name. A person with a start time, a hand-over time or rest
 * days on file sees it whatever her role is called; the eight jobs keep it by default for people whose shift is not entered yet —
 * so no agent loses her arrival button on the day (the owner's rule: nobody loses a door).
 */
describe('who is shown a shift — by the shift itself (D11)', () => {
  const asRole = (role: string) =>
    requireContext.mockResolvedValue({
      user: { id: 'me', name: 'من', role },
      companyId: 'c1',
      storeId: 's1',
      country: { timezone: 'Asia/Amman', workHoursStart: '09:00', workHoursEnd: '17:00' },
    });

  it.each([
    ['a start time', { shiftStart: '11:00', shiftEnd: null, restDays: null }],
    ['a hand-over time', { shiftStart: null, shiftEnd: '19:00', restDays: null }],
    ['rest days', { shiftStart: null, shiftEnd: null, restDays: '5,6' }],
  ])('a custom role with %s on file is shown the chip', async (_n, stored) => {
    asRole('دور مخصص');
    db.user.findUnique.mockResolvedValue(stored);
    const body = await (await GET()).json();
    expect(body.shift).toBe(true);
    expect(db.user.findUnique.mock.calls[0][0].where).toEqual({ id: 'me' });
  });

  it('even the company admin, once someone gives her a shift', async () => {
    asRole('COMPANY_ADMIN');
    db.user.findUnique.mockResolvedValue({ shiftStart: '10:00', shiftEnd: null, restDays: null });
    expect((await (await GET()).json()).shift).toBe(true);
  });

  it('NEGATIVE: a custom role with no shift on file is not', async () => {
    asRole('دور مخصص');
    db.user.findUnique.mockResolvedValue({ shiftStart: null, shiftEnd: null, restDays: null });
    expect(await (await GET()).json()).toEqual({ shift: false });
    expect(db.attendanceMark.findMany).not.toHaveBeenCalled();
  });

  it('NEGATIVE: an account the database cannot find is not shown one either', async () => {
    asRole('دور مخصص');
    db.user.findUnique.mockResolvedValue(null);
    expect(await (await GET()).json()).toEqual({ shift: false });
  });

  it('and nobody of the eight jobs loses it for want of an entered shift — and costs no extra query', async () => {
    for (const role of ['CONFIRMATION_AGENT', 'CONFIRMATION_SUPERVISOR', 'MODERATOR', 'WAREHOUSE', 'DELIVERY_AGENT', 'SETTLEMENT_OFFICER', 'ACCOUNTANT', 'MANAGER']) {
      asRole(role);
      db.user.findUnique.mockResolvedValue({ shiftStart: null, shiftEnd: null, restDays: null });
      expect((await (await GET()).json()).shift, role).toBe(true);
    }
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });
});
