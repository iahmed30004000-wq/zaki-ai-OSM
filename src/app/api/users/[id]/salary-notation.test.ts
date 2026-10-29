import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * SOMEBODY'S PAY, READ BY `Number()`.
 *
 * `PATCH /api/users/:id` with `action: 'updateContact'` is the ONLY door in
 * this repository that writes `User.salaryAmount`. It read the figure with
 * `Number(raw)` under `Number.isFinite` and a 0…100_000_000 range. The
 * finiteness and the range were right; the NOTATION was not:
 *
 *     '0x10'   →  16          a salary of sixteen
 *     '0b11'   →   3
 *     '0o17'   →  15
 *     '   '    →   0          a field holding one space
 *     ['5']    →   5
 *     true     →   1
 *
 * The zero is the one that costs somebody a month: `UserSalary.tsx` shows the
 * «اصرف» button for ANY non-null amount, and `payroll.ts:85` refuses a salary
 * of `<= 0` as NO_SALARY. So a space in the box produces a person who has a
 * salary on file that cannot be paid, and nothing says why.
 *
 * `''` and `null` were ALREADY handled correctly, by the clearing branch that
 * runs before the number is read at all — that is verified below rather than
 * assumed, because a fix that moved them would be a regression.
 *
 * Every case asserts THE ROW HANDED TO PRISMA before the status code, so a
 * failure prints the figure that would have been filed as wages.
 */

const { db, logAudit, canConferRole, actor } = vi.hoisted(() => ({
  db: {
    user: { findUnique: vi.fn(), update: vi.fn(), delete: vi.fn() },
    role: { findFirst: vi.fn(), findUnique: vi.fn() },
    company: { findMany: vi.fn() },
  },
  logAudit: vi.fn(),
  canConferRole: vi.fn(),
  actor: { current: { id: 'admin', name: 'مدير', role: 'COMPANY_ADMIN', companyId: 'c1' as string | null } },
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/auth', () => ({
  hashPassword: vi.fn(),
  resolveSingleCompanyId: async () => 'c1',
}));
vi.mock('@/lib/authorization', () => ({
  requirePermission: async () => actor.current,
  // The salary branch asks for `payroll.pay` on its own key; the guard for
  // that is asserted separately below, so the default here is «held».
  can: () => true,
}));
// Acting on a more senior account is its own test (people-act-within-their-reach).
vi.mock('@/lib/user-permissions', () => ({
  canConferRole: (...a: unknown[]) => canConferRole(...a),
  canActOnUser: async () => ({ ok: true }),
}));

import { PATCH } from './route';

const patch = (body: unknown) =>
  PATCH(new Request('http://localhost/x', { method: 'PATCH', body: JSON.stringify(body) }), {
    params: Promise.resolve({ id: 'u2' }),
  });

const pay = (salaryAmount: unknown) => patch({ action: 'updateContact', salaryAmount });

/** The salary exactly as it reached the database. */
const written = () => db.user.update.mock.calls.map((c) => c[0].data.salaryAmount);

beforeEach(() => {
  vi.clearAllMocks();
  actor.current = { id: 'admin', name: 'مدير', role: 'COMPANY_ADMIN', companyId: 'c1' };
  canConferRole.mockResolvedValue({ ok: true });
  db.user.findUnique.mockResolvedValue({
    id: 'u2',
    name: 'سارة',
    email: 's@x.com',
    role: 'CONFIRMATION_AGENT',
    roleId: 'role-agent',
    status: 'ACTIVE',
    companyId: 'c1',
    phone: null,
    salaryAmount: 5000,
    salaryCurrency: 'EGP',
    assignedBy: null,
  });
  db.user.update.mockImplementation(async () => ({
    id: 'u2',
    name: 'سارة',
    email: 's@x.com',
    role: 'CONFIRMATION_AGENT',
    status: 'ACTIVE',
  }));
});

describe('a salary written in another notation never becomes a wage', () => {
  const PREFIXED = [
    ['0x10', 16],
    ['0X10', 16],
    ['0b11', 3],
    ['0B11', 3],
    ['0o17', 15],
    ['0O17', 15],
  ] as const;

  it.each(PREFIXED)('refuses «%s», which Number() reads as %i', async (typed, wouldFile) => {
    expect(Number(typed), 'the hazard is measured at the door, not remembered').toBe(wouldFile);
    const res = await pay(typed);
    expect(
      written(),
      `«${typed}» was handed to Prisma as a salary; Number() reads it as ${wouldFile}`
    ).toEqual([]);
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error).toBe('الراتب رقم موجب');
  });

  it("refuses a box holding one space, though Number('   ') is 0 — and a stored 0 is worse than nothing", async () => {
    expect(Number('   ')).toBe(0);
    const res = await pay('   ');
    expect(
      written(),
      "a salary of 0 would have been filed: the screen then offers «اصرف» and payroll refuses it as NO_SALARY"
    ).toEqual([]);
    expect(res.status).toBe(400);
  });

  it("refuses a one-element array, though Number(['5']) is 5", async () => {
    expect(Number(['5'])).toBe(5);
    const res = await pay(['5']);
    expect(written()).toEqual([]);
    expect(res.status).toBe(400);
  });

  it('refuses true, though Number(true) is 1', async () => {
    expect(Number(true)).toBe(1);
    const res = await pay(true);
    expect(written()).toEqual([]);
    expect(res.status).toBe(400);
  });

  it('refuses an Arabic-Indic numeral — this screen is Arabic-facing and ٥٠٠٠ is not 5000', async () => {
    expect(Number('٥٠٠٠')).toBeNaN();
    const res = await pay('٥٠٠٠');
    expect(written()).toEqual([]);
    expect(res.status).toBe(400);
  });

  it('refuses a decimal comma rather than filing the whole part', async () => {
    // `parseFloat('3500,50')` is 3500 — the same defect with the other shoe on.
    const res = await pay('3500,50');
    expect(written()).toEqual([]);
    expect(res.status).toBe(400);
  });
});

describe('the bounds that were already right stay right', () => {
  it('refuses an overflowing exponent, though isNaN(Infinity) is false', async () => {
    expect(Number('1e400')).toBe(Infinity);
    expect(isNaN(Infinity), 'which is how 1e400 passes a guard that looks careful').toBe(false);
    const res = await pay('1e400');
    expect(written()).toEqual([]);
    expect(res.status).toBe(400);
  });

  it('refuses a negative salary', async () => {
    const res = await pay(-1);
    expect(written()).toEqual([]);
    expect(res.status).toBe(400);
  });

  it('refuses above the hundred-million ceiling the column can hold', async () => {
    const res = await pay(100_000_001);
    expect(written()).toEqual([]);
    expect(res.status).toBe(400);
  });

  it('files the ceiling itself — the bound is inclusive, as it always was', async () => {
    const res = await pay(100_000_000);
    expect(written()).toEqual([100_000_000]);
    expect(res.status).toBe(200);
  });
});

describe('what a payroll clerk actually sends still works', () => {
  it('files a number', async () => {
    const res = await pay(5000);
    expect(written()).toEqual([5000]);
    expect(res.status).toBe(200);
  });

  it('files a numeric string, which is what a form posts', async () => {
    const res = await pay('5000.50');
    expect(written()).toEqual([5000.5]);
    expect(res.status).toBe(200);
  });

  it('files a padded numeric string — a trimmed number is still a number', async () => {
    const res = await pay(' 5000 ');
    expect(written()).toEqual([5000]);
    expect(res.status).toBe(200);
  });

  it('files a deliberate zero when it is TYPED as zero, which is a real entry', async () => {
    const res = await pay(0);
    expect(written()).toEqual([0]);
    expect(res.status).toBe(200);
  });
});

/**
 * THE CLEARING BRANCH — VERIFIED, NOT ASSUMED.
 *
 * The brief said `''` and `null` were already handled correctly. They are,
 * and the reason is that they are caught BEFORE the number is read: `money()`
 * refuses both (they are not written the way a number is written), so a fix
 * that put the reader first would have turned «no salary on file» into a 400
 * and taken the clear button away.
 */
describe('clearing the salary — the branch that runs before the reader', () => {
  it('null means «no salary on file», stored as null and not as zero', async () => {
    expect(Number(null), 'which is why the clearing branch must come first').toBe(0);
    const res = await pay(null);
    expect(written()).toEqual([null]);
    expect(res.status).toBe(200);
  });

  it("the empty box means the same, and is not read as Number('') === 0", async () => {
    expect(Number('')).toBe(0);
    const res = await pay('');
    expect(written()).toEqual([null]);
    expect(res.status).toBe(200);
  });
});

describe('the salary key is still its own', () => {
  it('a refused notation never reaches the payroll authority question or the audit trail', async () => {
    const res = await pay('0x10');
    expect(res.status).toBe(400);
    expect(db.user.update).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('does not touch the salary when the request never mentions it', async () => {
    const res = await patch({ action: 'updateContact', phone: '+962791234567' });
    expect(res.status).toBe(200);
    expect(db.user.update.mock.calls[0][0].data).not.toHaveProperty('salaryAmount');
  });
});

/* ── 29/10: the audit row says what the salary BECAME, not only what it was (56) ─── */

describe('a salary change is audited from both sides', () => {
  const audit = () => logAudit.mock.calls.map((c) => c[0]).find((a) => a.action === 'USER_CONTACT_UPDATED');

  it('records the old figure AND the new one, and the currency', async () => {
    const res = await patch({ action: 'updateContact', salaryAmount: '6500', salaryCurrency: 'usd' });
    expect(res.status).toBe(200);
    expect(audit().previousData).toMatchObject({ salaryAmount: 5000, salaryCurrency: 'EGP' });
    expect(audit().newData).toMatchObject({ salaryAmount: 6500, salaryCurrency: 'USD' });
  });

  it('clearing a salary is recorded as a null, not as «nothing happened»', async () => {
    const res = await patch({ action: 'updateContact', salaryAmount: null });
    expect(res.status).toBe(200);
    expect(audit().previousData.salaryAmount).toBe(5000);
    expect(audit().newData).toHaveProperty('salaryAmount', null);
  });

  it('an edit that does not send a salary does not claim to have set one', async () => {
    const res = await patch({ action: 'updateContact', phone: '0790000000' });
    expect(res.status).toBe(200);
    expect(audit().newData).not.toHaveProperty('salaryAmount');
    expect(audit().newData).not.toHaveProperty('salaryCurrency');
  });
});
