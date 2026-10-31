import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * A3 + A4 — WHO MAY REGISTER, AND WHAT A STRANGER LEARNS FROM TRYING.
 *
 * Self sign-up is OFF until the owner turns it on (D7). The owner's own bootstrap still
 * works with it off, but only while the database has no owner. A taken email gets the
 * very answer a new one gets, so the form cannot be used to list the accounts.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, logAudit, hashPassword, ip } = vi.hoisted(() => ({
  db: { user: { findUnique: vi.fn(), create: vi.fn(), count: vi.fn() } },
  logAudit: vi.fn(),
  hashPassword: vi.fn(async (p: string) => `hash:${p}`),
  ip: { n: 0 },
}));
vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/auth', () => ({ hashPassword: (...a: [string]) => hashPassword(...a) }));
// A fresh address per request: the 5-an-hour ceiling is not what is under test here.
vi.mock('@/lib/rate-limit', async (orig) => ({
  ...(await orig<typeof import('@/lib/rate-limit')>()),
  getClientIp: () => `10.0.0.${++ip.n}`,
}));

import { POST } from './route';

const OWNER = 'owner@shop.example';
const body = (over: Record<string, unknown> = {}) => ({
  fullName: 'سارة أحمد',
  email: 'new.person@shop.example',
  password: 'Str0ngPassword',
  confirmPassword: 'Str0ngPassword',
  ...over,
});
const post = (b: unknown) => POST(new Request('http://localhost/api/auth/register', { method: 'POST', body: JSON.stringify(b) }));

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.AUTH_SELF_SIGNUP;
  delete process.env.AUTH_BOOTSTRAP_GUARD;
  delete process.env.INITIAL_SUPER_ADMIN_EMAIL;
  db.user.findUnique.mockResolvedValue(null);
  db.user.count.mockResolvedValue(0);
  db.user.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'new1', companyId: null, ...data }));
});
afterEach(() => {
  delete process.env.AUTH_SELF_SIGNUP;
  delete process.env.AUTH_BOOTSTRAP_GUARD;
  delete process.env.INITIAL_SUPER_ADMIN_EMAIL;
});

describe('A4 — with the door shut (the default)', () => {
  it('REFUSES an ordinary registration, creates nothing, and says why in Arabic', async () => {
    const res = await post(body());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/التسجيل الذاتي مغلق/);
    expect(db.user.create).not.toHaveBeenCalled();
  });

  it('answers the same whether the email is taken or not, and before judging the form', async () => {
    db.user.findUnique.mockResolvedValue({ id: 'taken' });
    const taken = await post(body({ email: 'taken@shop.example' }));
    db.user.findUnique.mockResolvedValue(null);
    const fresh = await post(body({ email: 'fresh@shop.example' }));
    const garbage = await post({ email: 'x', password: '1' });
    expect(taken.status).toBe(403);
    expect(await taken.json()).toEqual(await fresh.json());
    expect(garbage.status).toBe(403);
  });

  it('still lets the owner bootstrap while there is no owner', async () => {
    process.env.INITIAL_SUPER_ADMIN_EMAIL = OWNER;
    const res = await post(body({ email: OWNER.toUpperCase() }));
    expect(res.status).toBe(200);
    expect(db.user.create.mock.calls[0][0].data).toMatchObject({ email: OWNER, role: 'SUPER_ADMIN', status: 'ACTIVE' });
    expect(logAudit.mock.calls[0][0].action).toBe('INITIAL_SUPER_ADMIN_CREATED');
  });
});

describe('A3 — the bootstrap works only while there is no owner', () => {
  beforeEach(() => {
    process.env.INITIAL_SUPER_ADMIN_EMAIL = OWNER;
  });

  it('REFUSES to make an owner once one exists — shut door, so the registration is refused outright', async () => {
    db.user.count.mockResolvedValue(1);
    const res = await post(body({ email: OWNER }));
    expect(res.status).toBe(403);
    expect(db.user.create).not.toHaveBeenCalled();
    expect(db.user.count).toHaveBeenCalledWith({ where: { role: 'SUPER_ADMIN' } });
  });

  it('REFUSES to make an owner once one exists — open door, so it is an ordinary pending account, never an owner', async () => {
    process.env.AUTH_SELF_SIGNUP = 'on';
    db.user.count.mockResolvedValue(1);
    const res = await post(body({ email: OWNER }));
    expect(res.status).toBe(200);
    expect(db.user.create.mock.calls[0][0].data).toMatchObject({ role: 'PENDING_USER', status: 'PENDING' });
    expect(logAudit.mock.calls[0][0].action).toBe('USER_REGISTERED');
  });

  it('another email never becomes the owner, whatever the count', async () => {
    process.env.AUTH_SELF_SIGNUP = 'on';
    const res = await post(body({ email: 'someone@else.example' }));
    expect(res.status).toBe(200);
    expect(db.user.create.mock.calls[0][0].data.role).toBe('PENDING_USER');
  });

  it('the guard off puts back the old behaviour — for a recovery the owner chooses', async () => {
    process.env.AUTH_BOOTSTRAP_GUARD = 'off';
    db.user.count.mockResolvedValue(2);
    const res = await post(body({ email: OWNER }));
    expect(res.status).toBe(200);
    expect(db.user.create.mock.calls[0][0].data.role).toBe('SUPER_ADMIN');
  });
});

describe('A4 — with the door open', () => {
  beforeEach(() => {
    process.env.AUTH_SELF_SIGNUP = 'on';
  });

  it('a new person registers as a pending user — the sign-up that always worked', async () => {
    const res = await post(body());
    const out = await res.json();
    expect(res.status).toBe(200);
    expect(out).toMatchObject({ success: true, status: 'PENDING', role: 'PENDING_USER', signIn: true });
    expect(db.user.create.mock.calls[0][0].data).toMatchObject({ role: 'PENDING_USER', status: 'PENDING' });
  });

  it('a TAKEN email gets the very same answer — status, body — and nothing is created', async () => {
    const fresh = await post(body({ email: 'fresh@shop.example' }));
    const freshBody = await fresh.json();
    db.user.create.mockClear();
    db.user.findUnique.mockResolvedValue({ id: 'taken' });
    const taken = await post(body({ email: 'taken@shop.example' }));
    expect(taken.status).toBe(fresh.status);
    expect(await taken.json()).toEqual(freshBody);
    expect(db.user.create).not.toHaveBeenCalled();
  });

  it('the password is hashed BEFORE the lookup, so a taken email is not faster (the order is the guard)', async () => {
    const order: string[] = [];
    hashPassword.mockImplementationOnce(async (p: string) => {
      order.push('hash');
      return `hash:${p}`;
    });
    db.user.findUnique.mockImplementationOnce(async () => {
      order.push('lookup');
      return null;
    });
    await post(body({ email: 'order@shop.example' }));
    expect(order).toEqual(['hash', 'lookup']);
  });

  it('two requests racing one new email: the loser gets the neutral answer, not a 409', async () => {
    db.user.create.mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }));
    const res = await post(body({ email: 'race@shop.example' }));
    expect(res.status).toBe(200);
    expect((await res.json()).message).toMatch(/استلمنا طلبك/);
  });

  it('a weak password is still refused with its reason', async () => {
    const res = await post(body({ password: 'abc', confirmPassword: 'abc' }));
    expect(res.status).toBe(400);
    expect(db.user.create).not.toHaveBeenCalled();
  });

  it('a role in the body is never believed', async () => {
    await post(body({ role: 'SUPER_ADMIN', status: 'ACTIVE' }));
    expect(db.user.create.mock.calls[0][0].data).toMatchObject({ role: 'PENDING_USER', status: 'PENDING' });
  });
});
