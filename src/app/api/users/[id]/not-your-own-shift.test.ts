import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * NOT YOUR OWN SHIFT, UNLESS YOU MAY ALREADY MOVE PAY (RV159).
 *
 * `updateContact` skips `canActOnUser` on purpose — correcting a colleague's phone is not power over them — and that
 * skip also covered the person themselves: whoever held «تعديل المستخدمين» could set their own start time and rest
 * days, and lateness and the deduction are counted from exactly those. A CHANGE to one's own schedule now asks for
 * `payroll.pay`, the key that already guards what the business pays a person. No new key.
 */

const { db, logAudit, actor, held } = vi.hoisted(() => ({
  db: {
    user: { findUnique: vi.fn(), update: vi.fn() },
    role: { findFirst: vi.fn(), findUnique: vi.fn() },
    company: { findMany: vi.fn() },
  },
  logAudit: vi.fn(),
  actor: { current: { id: 'admin', name: 'مدير', role: 'COMPANY_ADMIN', companyId: 'c1' as string | null } },
  held: { keys: new Set<string>() },
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/auth', () => ({ hashPassword: vi.fn(), resolveSingleCompanyId: async () => 'c1' }));
vi.mock('@/lib/authorization', () => ({
  requirePermission: async () => actor.current,
  can: (_u: unknown, key: string) => held.keys.has(key),
}));
vi.mock('@/lib/user-permissions', () => ({
  canConferRole: async () => ({ ok: true }),
  canActOnUser: async () => ({ ok: true }),
}));

import { PATCH } from './route';

const STORED = { shiftStart: '09:00', shiftEnd: '17:00', restDays: '5' };

const patch = (id: string, body: unknown) =>
  PATCH(new Request('http://localhost/x', { method: 'PATCH', body: JSON.stringify(body) }), {
    params: Promise.resolve({ id }),
  });

const row = (id: string) => ({
  id, name: 'سارة', email: 's@x.com', role: 'CONFIRMATION_AGENT', roleId: 'role-agent', status: 'ACTIVE',
  companyId: 'c1', phone: '0911222333', ...STORED, assignedBy: null,
});

const written = () => db.user.update.mock.calls.map((c) => c[0].data);

beforeEach(() => {
  vi.clearAllMocks();
  held.keys = new Set();
  actor.current = { id: 'admin', name: 'مدير', role: 'COMPANY_ADMIN', companyId: 'c1' };
  db.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => row(where.id));
  db.user.update.mockImplementation(async () => row('x'));
});

describe('changing your own schedule', () => {
  it.each([
    ['the start time', { shiftStart: '11:00' }],
    ['the hand-over time', { shiftEnd: '19:00' }],
    ['the rest days', { restDays: [5, 6] }],
    ['all of them, as the shift card posts them', { shiftStart: '12:00', shiftEnd: '20:00', restDays: [0] }],
  ])('is refused without the pay key: %s — and nothing is written', async (_n, change) => {
    const res = await patch('admin', { action: 'updateContact', ...change });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(403);
    expect((await res.json()).code).toBe('OWN_SHIFT');
    expect(written()).toEqual([]);
  });

  it('and the refusal is Arabic, short, and names no key', async () => {
    const res = await patch('admin', { action: 'updateContact', shiftStart: '11:00' });
    const { errorAr } = await res.json();
    expect(errorAr).toMatch(/دوام/);
    expect(errorAr).not.toMatch(/payroll|permission/i);
  });

  it('is allowed for whoever already holds the pay key', async () => {
    held.keys.add('payroll.pay');
    const res = await patch('admin', { action: 'updateContact', shiftStart: '11:00' });
    expect(res.status).toBe(200);
    expect(written()[0].shiftStart).toBe('11:00');
  });

  it('saving the values the account already has is not a change: the card posts them together', async () => {
    const res = await patch('admin', { action: 'updateContact', shiftStart: '09:00', shiftEnd: '17:00', restDays: [5] });
    expect(res.status).toBe(200);
  });

  it('and correcting your own phone is still yours to do', async () => {
    const res = await patch('admin', { action: 'updateContact', phone: '0922333444' });
    expect(res.status).toBe(200);
    expect(written()[0].phone).toBe('0922333444');
  });

  it('an unchanged shift beside a changed phone passes; a changed shift beside the same phone does not', async () => {
    expect((await patch('admin', { action: 'updateContact', phone: '0933444555', shiftStart: '09:00' })).status).toBe(200);
    expect((await patch('admin', { action: 'updateContact', phone: '0911222333', shiftStart: '10:00' })).status).toBe(403);
  });
});

describe('and a colleague’s shift is unchanged by this rule', () => {
  it('an admin without the pay key still sets somebody else’s shift', async () => {
    const res = await patch('u2', { action: 'updateContact', shiftStart: '11:00', shiftEnd: '19:00', restDays: [6] });
    expect(res.status).toBe(200);
    expect(written()[0]).toMatchObject({ shiftStart: '11:00', shiftEnd: '19:00', restDays: '6' });
  });
});
