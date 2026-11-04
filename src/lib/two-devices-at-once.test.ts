import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

/**
 * TWO DEVICES AT ONCE — THE OWNER'S RULING 4/11.
 *
 * Confirmation agents were signed out in the middle of a shift, and the survey found four doors to it. This file is the
 * two on the server:
 *
 *   · ONE SESSION PER ACCOUNT. Every sign-in bumped `tokenVersion`, so opening the system on the phone for the call
 *     helper killed the laptop. Now an account holds two live sessions; a third sign-in ends the OLDEST, and that
 *     device is told why. `tokenVersion` stays the «sign out everywhere» lever and still reaches every cookie.
 *   · A BUSY DATABASE READ AS «SIGNED OUT». `getCurrentUser` swallowed every exception and answered null; a pool timeout
 *     became a 401 and a trip to /login. Now it throws `AuthBackendDown`, and the API answers 503.
 *
 * The sign-in, the session check and the error mapper are the REAL ones; only the database, the request and the
 * permission engine are stood in for. The session table is an in-memory list that answers the queries the code asks.
 */

type Row = {
  id: string;
  userId: string;
  createdAt: Date;
  lastSeenAt: Date;
  revokedAt: Date | null;
  revokeReason: string | null;
  userAgent: string | null;
};

const { db, jar, ua, rows, user } = vi.hoisted(() => {
  const rows: Row[] = [];
  const user = {
    id: 'u1',
    email: 'lina@example.test',
    name: 'لينا',
    role: 'MODERATOR',
    status: 'ACTIVE',
    companyId: 'c1',
    commissionRate: null,
    tokenVersion: 3,
    roleId: null,
    avatar: null,
    systemTheme: null,
    tourDoneAt: null,
    company: { id: 'c1', name: 'زكي' },
    roleRef: null,
  };
  let n = 0;
  const matches = (r: Row, where: Record<string, unknown>) => {
    const id = where.id as string | { in: string[] } | undefined;
    if (typeof id === 'string' && r.id !== id) return false;
    if (id && typeof id === 'object' && !id.in.includes(r.id)) return false;
    if (where.userId !== undefined && r.userId !== where.userId) return false;
    if (where.revokedAt === null && r.revokedAt !== null) return false;
    return true;
  };
  const userSession = {
    create: vi.fn(async ({ data }: { data: Partial<Row> & { userId: string } }) => {
      const row: Row = {
        id: `s${++n}`,
        createdAt: new Date(),
        lastSeenAt: new Date(),
        revokedAt: null,
        revokeReason: null,
        userAgent: null,
        ...data,
      } as Row;
      rows.push(row);
      return { id: row.id };
    }),
    // Honours the `orderBy` the code asks for, key by key, as Postgres would.
    findMany: vi.fn(
      async ({ where, orderBy = [] }: { where: Record<string, unknown>; orderBy?: Record<string, 'asc' | 'desc'>[] }) =>
        rows
          .filter((r) => matches(r, where))
          .sort((a, b) => {
            for (const key of orderBy) {
              const [field, dir] = Object.entries(key)[0] as [keyof Row, 'asc' | 'desc'];
              const x = a[field] instanceof Date ? (a[field] as Date).getTime() : String(a[field]);
              const y = b[field] instanceof Date ? (b[field] as Date).getTime() : String(b[field]);
              if (x !== y) return (x < y ? -1 : 1) * (dir === 'desc' ? -1 : 1);
            }
            return 0;
          })
          .map((r) => ({ id: r.id, lastSeenAt: r.lastSeenAt, createdAt: r.createdAt }))
    ),
    updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
      const hit = rows.filter((r) => matches(r, where));
      for (const r of hit) Object.assign(r, data);
      return { count: hit.length };
    }),
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
      const r = rows.find((x) => x.id === where.id);
      return r ? { userId: r.userId, revokedAt: r.revokedAt, revokeReason: r.revokeReason, lastSeenAt: r.lastSeenAt } : null;
    }),
  };
  const db = {
    user: {
      findUnique: vi.fn(async () => ({ ...user })),
      update: vi.fn(async () => ({ tokenVersion: user.tokenVersion })),
    },
    userSession,
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  };
  return { db, jar: new Map<string, string>(), ua: { value: 'Mozilla/5.0 (Linux; Android 14) Chrome/130' }, rows, user };
});

vi.mock('./db', () => ({ db }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (jar.has(name) ? { value: jar.get(name) } : undefined) }),
  headers: async () => ({ get: (name: string) => (name === 'user-agent' ? ua.value : null) }),
}));
vi.mock('./permissions-core', () => ({ computeEffectiveGrants: async () => ({ fullAccess: false, grants: {} }) }));
vi.mock('./authorization', () => ({ attachGrants: () => undefined, requirePermission: vi.fn() }));
vi.mock('./audit', () => ({ logAudit: vi.fn() }));
vi.mock('./attendance', () => ({ markLogin: vi.fn() }));

import { issueSession } from './sign-in';
import { COOKIE_NAME, createSessionToken, getCurrentUser, getSessionVerdict, requireAuth, SEEN_EVERY_MS } from './auth';
import { AuthBackendDown, SESSION_REPLACED_AR, SessionEnded } from './auth-errors';
import { apiError } from './api-error';

const T0 = new Date('2026-11-04T09:00:00Z').getTime();

/** Signs in on «a device» and returns that device's cookie. */
async function signIn(): Promise<string> {
  const res = await issueSession({ user, remember: false, ip: '127.0.0.1', factor: 'password' });
  const token = res.cookies.get(COOKIE_NAME)?.value;
  expect(token, 'الدخول ما كتب كوكي').toBeTruthy();
  // The next device signs in a minute later.
  vi.setSystemTime(Date.now() + 60_000);
  return token!;
}

/** Who this device is, as the server reads it on its next request. */
async function on(token: string) {
  jar.set(COOKIE_NAME, token);
  return getSessionVerdict();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  rows.length = 0;
  jar.clear();
  user.tokenVersion = 3;
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ruling 4/11: two devices per account', () => {
  it('a second sign-in keeps the first — the phone no longer signs the laptop out', async () => {
    const laptop = await signIn();
    const phone = await signIn();
    expect((await on(laptop)).user?.id, 'اللابتوب طلع لما دخلت من التلفون').toBe('u1');
    expect((await on(phone)).user?.id).toBe('u1');
  });

  it('a third sign-in ends the OLDEST, and only it', async () => {
    const first = await signIn();
    const second = await signIn();
    const third = await signIn();
    expect(await on(first)).toEqual({ user: null, reason: 'REPLACED' });
    expect((await on(second)).user?.id, 'التاني طلع بدل الأقدم').toBe('u1');
    expect((await on(third)).user?.id).toBe('u1');
    expect(rows.filter((r) => r.revokedAt).map((r) => [r.id, r.revokeReason])).toEqual([[rows[0].id, 'REPLACED']]);
  });

  it('a fourth ends the next oldest — always two left', async () => {
    for (let i = 0; i < 4; i++) await signIn();
    expect(rows.filter((r) => !r.revokedAt).map((r) => r.id)).toEqual([rows[2].id, rows[3].id]);
  });

  /*
   * A DEAD ROW MUST NOT PUSH OUT A LIVE DEVICE (review of #206). The laptop signs in at 08:00 and is worked on all
   * morning; the phone signs in at 09:00, loses its cookie, and signs in again at 10:00. Ranked by creation, the laptop
   * was «the oldest» and went — mid-work. Ranked by use, the dead 09:00 phone row goes.
   */
  it('keeps the device in use, not the newest rows: laptop + new phone stay, the dead phone row goes', async () => {
    vi.setSystemTime(new Date('2026-11-04T08:00:00Z'));
    const laptop = await signIn();
    vi.setSystemTime(new Date('2026-11-04T09:00:00Z'));
    const lostPhone = await signIn();
    // The laptop is worked on until 09:55 (its lastSeenAt is refreshed by use).
    vi.setSystemTime(new Date('2026-11-04T09:55:00Z'));
    expect((await on(laptop)).user?.id).toBe('u1');
    await Promise.resolve();
    await Promise.resolve();
    vi.setSystemTime(new Date('2026-11-04T10:00:00Z'));
    const newPhone = await signIn();
    expect((await on(laptop)).user?.id, 'اللابتوب اللي عم تشتغل عليه طلع بسبب صف ميت').toBe('u1');
    expect((await on(newPhone)).user?.id).toBe('u1');
    expect(await on(lostPhone)).toEqual({ user: null, reason: 'REPLACED' });
  });

  it('a row unused for longer than any cookie lives is STALE, and is not one of the two', async () => {
    const forgotten = await signIn();
    vi.setSystemTime(Date.now() + 31 * 24 * 60 * 60 * 1000);
    const laptop = await signIn();
    const phone = await signIn();
    const forgottenRow = rows.find((r) => r.revokedAt && r.revokeReason === 'STALE');
    expect(forgottenRow, 'الصف الميت ما انعلّم STALE').toBeTruthy();
    expect(await on(forgotten)).toEqual({ user: null, reason: 'NONE' });
    // Both live devices kept: the dead row was not counted against them.
    expect((await on(laptop)).user?.id).toBe('u1');
    expect((await on(phone)).user?.id).toBe('u1');
    expect(rows.filter((r) => r.revokeReason === 'REPLACED')).toHaveLength(0);
  });

  it('does it in one transaction, the account row first (its lock queues two sign-ins at once)', async () => {
    await signIn();
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    const order = [db.user.update, db.userSession.create].map((f) => f.mock.invocationCallOrder[0]);
    expect(order[0]).toBeLessThan(order[1]);
  });

  it('and no longer bumps tokenVersion', async () => {
    await signIn();
    for (const [arg] of db.user.update.mock.calls as unknown as [{ data: Record<string, unknown> }][]) {
      expect(arg.data, 'الدخول رجع يرفع tokenVersion').not.toHaveProperty('tokenVersion');
    }
  });

  it('writes what browser it was, cut to 200 characters', async () => {
    ua.value = 'x'.repeat(500);
    try {
      await signIn();
    } finally {
      ua.value = 'Mozilla/5.0 (Linux; Android 14) Chrome/130';
    }
    expect(rows[0].userAgent).toHaveLength(200);
  });

  it('the ended device is told why: SESSION_REPLACED on the API, in Arabic', async () => {
    const first = await signIn();
    await signIn();
    await signIn();
    jar.set(COOKIE_NAME, first);
    const thrown = await requireAuth().catch((e) => e);
    expect(thrown).toBeInstanceOf(SessionEnded);
    expect(thrown.message, 'الكلمة اللي بتقراها كل الأبواب تغيّرت').toBe('Unauthorized');
    const { status, body } = apiError(thrown);
    expect(status).toBe(401);
    expect(body.code).toBe('SESSION_REPLACED');
    expect(body.errorAr).toBe(SESSION_REPLACED_AR);
  });

  it('an ordinary signed-out request carries no such code', async () => {
    const { status, body } = apiError(await requireAuth().catch((e) => e));
    expect(status).toBe(401);
    expect(body.code).toBeUndefined();
  });
});

describe('the «sign out everywhere» lever still reaches every device', () => {
  it('a tokenVersion bump ends both live sessions at once', async () => {
    const laptop = await signIn();
    const phone = await signIn();
    user.tokenVersion = 4; // force-logout, suspension, password or 2FA reset
    expect((await on(laptop)).user).toBeNull();
    expect((await on(phone)).user).toBeNull();
  });
});

describe('a cookie from before the ruling (no sid)', () => {
  it('is still accepted by the tokenVersion rule — nobody is signed out at the deploy', async () => {
    const old = await createSessionToken({
      userId: 'u1', email: user.email, role: 'MODERATOR', status: 'ACTIVE', companyId: 'c1', tv: 3,
    });
    expect((await on(old)).user?.id).toBe('u1');
    expect(db.userSession.findUnique, 'كوكي قديم انسأل عن صف ما إلو').not.toHaveBeenCalled();
  });

  it('and still dies with a version bump', async () => {
    const old = await createSessionToken({
      userId: 'u1', email: user.email, role: 'MODERATOR', status: 'ACTIVE', companyId: 'c1', tv: 2,
    });
    expect((await on(old)).user).toBeNull();
  });
});

describe('a sid the server did not issue to this person', () => {
  it('a row that is gone is nobody', async () => {
    const token = await signIn();
    rows.length = 0;
    expect(await on(token)).toEqual({ user: null, reason: 'NONE' });
  });

  it('a row that is somebody else\'s is nobody', async () => {
    const token = await signIn();
    rows[0].userId = 'u2';
    expect((await on(token)).user).toBeNull();
  });

  it('a row ended by its own sign-out is nobody, and not «replaced»', async () => {
    const token = await signIn();
    Object.assign(rows[0], { revokedAt: new Date(), revokeReason: 'LOGOUT' });
    expect(await on(token)).toEqual({ user: null, reason: 'NONE' });
  });
});

describe('lastSeenAt — at most once every five minutes, never on the request\'s path', () => {
  it('a fresh session is not written to', async () => {
    const token = await signIn();
    db.userSession.updateMany.mockClear();
    await on(token);
    expect(db.userSession.updateMany).not.toHaveBeenCalled();
  });

  it('a stale one is, for its own row only', async () => {
    const token = await signIn();
    db.userSession.updateMany.mockClear();
    vi.setSystemTime(Date.now() + SEEN_EVERY_MS);
    await on(token);
    await Promise.resolve();
    await Promise.resolve();
    expect(db.userSession.updateMany).toHaveBeenCalledTimes(1);
    expect(db.userSession.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: rows[0].id, revokedAt: null } });
  });

  it('and a failed write does not fail the request', async () => {
    const token = await signIn();
    vi.setSystemTime(Date.now() + SEEN_EVERY_MS);
    db.userSession.updateMany.mockImplementationOnce(() => {
      throw new Error('write failed');
    });
    expect((await on(token)).user?.id).toBe('u1');
  });
});

describe('a busy database is not a sign-out', () => {
  const poolTimeout = () =>
    new Prisma.PrismaClientKnownRequestError('Timed out fetching a new connection from the connection pool.', {
      code: 'P2024',
      clientVersion: '6',
    });

  it('getCurrentUser throws AuthBackendDown instead of answering «nobody»', async () => {
    const token = await signIn();
    jar.set(COOKIE_NAME, token);
    db.user.findUnique.mockRejectedValueOnce(poolTimeout());
    await expect(getCurrentUser()).rejects.toBeInstanceOf(AuthBackendDown);
  });

  it('and the API answers 503 SERVICE_BUSY, not 401', async () => {
    const token = await signIn();
    jar.set(COOKIE_NAME, token);
    db.user.findUnique.mockRejectedValueOnce(poolTimeout());
    const thrown = await requireAuth().catch((e) => e);
    const { status, body } = apiError(thrown);
    expect(status, 'زحمة القاعدة رجعت 401').toBe(503);
    expect(body).toEqual({ error: 'Service busy', errorAr: 'السيرفر مشغول هلّق — جرّبي كمان شوي', code: 'SERVICE_BUSY' });
  });

  it('a database that cannot be reached at all is the same', async () => {
    const token = await signIn();
    jar.set(COOKIE_NAME, token);
    db.userSession.findUnique.mockRejectedValueOnce(
      new Prisma.PrismaClientInitializationError("Can't reach database server at `localhost:5432`", '6')
    );
    await expect(getCurrentUser()).rejects.toBeInstanceOf(AuthBackendDown);
  });

  it('but an error that is not the database is still «nobody», as before', async () => {
    const token = await signIn();
    jar.set(COOKIE_NAME, token);
    db.user.findUnique.mockRejectedValueOnce(new Error('something else'));
    expect(await getCurrentUser()).toBeNull();
  });
});
