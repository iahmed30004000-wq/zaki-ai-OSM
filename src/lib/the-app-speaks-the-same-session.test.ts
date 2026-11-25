import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * «ZAKI ORDERS» — THE ANDROID APP SIGNS IN THROUGH THE SAME DOORS AND SPEAKS THE SAME SESSION (22/11).
 *
 *   · `client: "android"` on the sign-in: the token comes back in the body, never a cookie, and the session row is kind
 *     APP — counted against the app's own place, so it never signs a laptop out (and a browser never signs the app out).
 *   · The proxy turns `Authorization: Bearer` + `X-Zaki-Context` back into the two cookies (app-bearer.ts), so every door
 *     reads the app exactly as it reads a browser — the session check here is the REAL one.
 */

type Row = {
  id: string;
  userId: string;
  createdAt: Date;
  lastSeenAt: Date;
  revokedAt: Date | null;
  revokeReason: string | null;
  userAgent: string | null;
  kind: string;
};

const { db, jar, rows, user } = vi.hoisted(() => {
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
    if (where.kind !== undefined && r.kind !== where.kind) return false;
    return true;
  };
  const userSession = {
    create: vi.fn(async ({ data }: { data: Partial<Row> & { userId: string } }) => {
      const row = {
        id: `s${++n}`,
        createdAt: new Date(),
        lastSeenAt: new Date(),
        revokedAt: null,
        revokeReason: null,
        userAgent: null,
        kind: 'WEB',
        ...data,
      } as Row;
      rows.push(row);
      return { id: row.id };
    }),
    findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
      rows
        .filter((r) => matches(r, where))
        .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime() || b.createdAt.getTime() - a.createdAt.getTime())
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
  return { db, jar: new Map<string, string>(), rows, user };
});

vi.mock('./db', () => ({ db }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (jar.has(name) ? { value: jar.get(name) } : undefined) }),
  headers: async () => ({ get: (name: string) => (name === 'user-agent' ? 'ZakiOrders/1.0 (Android 14)' : null) }),
}));
vi.mock('./permissions-core', () => ({ computeEffectiveGrants: async () => ({ fullAccess: false, grants: {} }) }));
vi.mock('./authorization', () => ({ attachGrants: () => undefined, requirePermission: vi.fn() }));
vi.mock('./audit', () => ({ logAudit: vi.fn() }));
vi.mock('./attendance', () => ({ markLogin: vi.fn() }));

import { APP_DEVICES, OWNER_APP_DEVICES, appDevicesAllowed, issueSession } from './sign-in';
import { COOKIE_NAME, getSessionVerdict } from './auth';
import { CONTEXT_COOKIE } from './geo-context';
import { PREVIEW_COOKIE, PREVIEW_STAMP_HEADER } from './preview-mode';
import { DEVICE_COOKIE } from './trusted-device';
import { logAudit } from './audit';
import {
  APP_CONTEXT_COOKIE,
  APP_SESSION_COOKIE,
  appRequestHeaders,
  isAppRequest,
  signInClientOf,
  type SignInClient,
} from './app-bearer';

const T0 = new Date('2026-11-22T09:00:00Z').getTime();

/** Signs in through `client` and returns the token that client keeps (the cookie, or the body's token). */
async function signIn(client: SignInClient): Promise<string> {
  const res = await issueSession({ user, remember: true, ip: '127.0.0.1', factor: 'password', client });
  const token = client === 'app' ? (await res.json()).token : res.cookies.get(COOKIE_NAME)?.value;
  expect(token, 'الدخول ما رجّع توكن').toBeTruthy();
  vi.setSystemTime(Date.now() + 60_000);
  return token;
}

async function on(token: string) {
  jar.set(COOKIE_NAME, token);
  return getSessionVerdict();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  rows.length = 0;
  jar.clear();
  user.role = 'MODERATOR';
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the sign-in: `client: "android"` gets the token in the body, and a place of its own', () => {
  it('only `client: "android"` is the app; anything else is a browser', () => {
    expect(signInClientOf({ client: 'android' })).toBe('app');
    for (const body of [{}, null, undefined, 'android', { client: 'ANDROID' }, { client: 'ios' }, { client: true }]) {
      expect(signInClientOf(body)).toBe('web');
    }
  });

  it('the app gets {token, expiresAt} in the body and NO cookie of any kind', async () => {
    const res = await issueSession({ user, remember: true, ip: '127.0.0.1', factor: 'password', client: 'app' });
    const body = await res.json();
    expect(typeof body.token).toBe('string');
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(T0);
    expect(body.user.id).toBe('u1');
    expect(res.cookies.getAll(), 'التطبيق انكتبله كوكي').toHaveLength(0);
    expect(rows[0].kind).toBe('APP');
  });

  it('the browser is exactly as before: a cookie, no token in the body, a WEB row', async () => {
    const res = await issueSession({ user, remember: true, ip: '127.0.0.1', factor: 'password' });
    expect((await res.json()).token, 'الويب صار يرجّع التوكن بالجسم').toBeUndefined();
    expect(res.cookies.get(COOKIE_NAME)?.value).toBeTruthy();
    expect(rows[0].kind).toBe('WEB');
  });

  it('the app token opens the same session — both locks, the same person', async () => {
    const app = await signIn('app');
    expect((await on(app)).user?.id).toBe('u1');
  });

  it('opening the app never signs a laptop out: two browsers + the app, all three live', async () => {
    const laptop = await signIn('web');
    const office = await signIn('web');
    const phone = await signIn('app');
    expect((await on(laptop)).user?.id, 'اللابتوب طلع لما فتح التطبيق').toBe('u1');
    expect((await on(office)).user?.id).toBe('u1');
    expect((await on(phone)).user?.id).toBe('u1');
    expect(rows.filter((r) => r.revokedAt)).toHaveLength(0);
  });

  it('and a third browser ends the oldest BROWSER, never the app', async () => {
    const phone = await signIn('app');
    const first = await signIn('web');
    await signIn('web');
    await signIn('web');
    expect(await on(first)).toEqual({ user: null, reason: 'REPLACED' });
    expect((await on(phone)).user?.id, 'متصفح تالت طرد التطبيق').toBe('u1');
  });

  it('a second phone in the app ends the first phone, and no browser', async () => {
    const laptop = await signIn('web');
    const oldPhone = await signIn('app');
    const newPhone = await signIn('app');
    expect(APP_DEVICES).toBe(1);
    expect(await on(oldPhone)).toEqual({ user: null, reason: 'REPLACED' });
    expect((await on(newPhone)).user?.id).toBe('u1');
    expect((await on(laptop)).user?.id, 'تلفون جديد طرد اللابتوب').toBe('u1');
  });

  it('the owner’s account holds two phones in the app; every other role one', async () => {
    expect(appDevicesAllowed('SUPER_ADMIN')).toBe(OWNER_APP_DEVICES);
    expect(OWNER_APP_DEVICES).toBe(2);
    for (const role of ['ADMIN', 'MODERATOR', 'super_admin', '', 'NEW_ROLE']) expect(appDevicesAllowed(role)).toBe(1);
    user.role = 'SUPER_ADMIN';
    const a = await signIn('app');
    const b = await signIn('app');
    const c = await signIn('app');
    expect(await on(a)).toEqual({ user: null, reason: 'REPLACED' });
    expect((await on(b)).user?.id).toBe('u1');
    expect((await on(c)).user?.id).toBe('u1');
  });

  it('the audit row says which kind signed in', async () => {
    await signIn('app');
    const [[row]] = vi.mocked(logAudit).mock.calls as unknown as [[{ newData: Record<string, unknown> }]];
    expect(row.newData.kind).toBe('APP');
  });
});

describe('the proxy: the app’s headers become the two cookies (app-bearer.ts)', () => {
  const SESSION = 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiJ1MSJ9.c2lnbmF0dXJlLWhlcmUtMTIz';
  const CTX = 'eyJhbGciOiJIUzI1NiJ9.eyJ1IjoidTEiLCJjIjoiU1kifQ.Y3R4LXNpZ25hdHVyZS0xMjM';
  const app = (more: Record<string, string> = {}) =>
    new Headers({ 'x-zaki-client': 'android', authorization: `Bearer ${SESSION}`, ...more });

  it('names the very cookies the doors read', () => {
    expect(APP_SESSION_COOKIE).toBe(COOKIE_NAME);
    expect(APP_CONTEXT_COOKIE).toBe(CONTEXT_COOKIE);
  });

  it('Bearer + X-Zaki-Context → the session and context cookies; the headers themselves are gone', () => {
    const out = appRequestHeaders(app({ 'x-zaki-context': CTX }), '/api/orders')!;
    expect(out.get('cookie')).toBe(`${COOKIE_NAME}=${SESSION}; ${CONTEXT_COOKIE}=${CTX}`);
    expect(out.get('authorization')).toBeNull();
    expect(out.get('x-zaki-context')).toBeNull();
    expect(out.get('x-zaki-client')).toBe('android');
  });

  it('drops every cookie the request carried — the preview and the trusted device above all', () => {
    const out = appRequestHeaders(
      app({ cookie: `${PREVIEW_COOKIE}=p; ${DEVICE_COOKIE}=d; ${COOKIE_NAME}=someone-else; other=1` }),
      '/api/orders'
    )!;
    expect(out.get('cookie')).toBe(`${COOKIE_NAME}=${SESSION}`);
  });

  it('an app request with no usable token is nobody — its stray cookies do not speak for it', () => {
    const out = appRequestHeaders(new Headers({ 'x-zaki-client': 'android', cookie: `${COOKIE_NAME}=x.y.z` }), '/api/me')!;
    expect(out.get('cookie')).toBeNull();
    const zk = appRequestHeaders(app({ authorization: 'Bearer zk1_abcdefabcdefabcdef' }), '/api/orders')!;
    expect(zk.get('cookie'), 'مفتاح zk1_ صار كوكي جلسة').toBeNull();
  });

  it('a context without a session is not carried', () => {
    const out = appRequestHeaders(new Headers({ 'x-zaki-client': 'android', 'x-zaki-context': CTX }), '/api/orders')!;
    expect(out.get('cookie')).toBeNull();
  });

  it('leaves the system API, the pages, and any request without X-Zaki-Client exactly as they were', () => {
    expect(appRequestHeaders(app(), '/api/v1/orders')).toBeNull();
    expect(appRequestHeaders(app(), '/admin/orders')).toBeNull();
    expect(appRequestHeaders(new Headers({ authorization: `Bearer ${SESSION}` }), '/api/orders')).toBeNull();
    expect(appRequestHeaders(app({ 'x-zaki-client': 'web' }), '/api/orders')).toBeNull();
    expect(isAppRequest(app(), '/api/context')).toBe(true);
  });

  it('refuses a token too long to be one', () => {
    const long = `${'a'.repeat(3000)}.${'b'.repeat(1000)}.${'c'.repeat(100)}`;
    expect(appRequestHeaders(app({ authorization: `Bearer ${long}` }), '/api/orders')!.get('cookie')).toBeNull();
  });

  it('end to end: the cookie the proxy makes opens the real session check', async () => {
    const token = await signIn('app');
    const out = appRequestHeaders(new Headers({ 'x-zaki-client': 'android', authorization: `Bearer ${token}` }), '/api/orders')!;
    const value = out.get('cookie')!.split('=').slice(1).join('=');
    expect((await on(value)).user?.id).toBe('u1');
  });
});

describe('the wiring, read from the source', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

  it('the proxy rewrites an app request before the preview gate, and strips any preview stamp', () => {
    const src = read('src/proxy.ts');
    const appAt = src.indexOf('appRequestHeaders(req.headers, pathname)');
    expect(appAt, 'البروكسي ما بينادي appRequestHeaders').toBeGreaterThan(0);
    expect(appAt).toBeLessThan(src.indexOf('await previewGate(req, pathname)'));
    expect(src).toContain(`appHeaders.delete(PREVIEW_STAMP_HEADER)`);
    expect(PREVIEW_STAMP_HEADER).toBeTruthy();
  });

  it('both sign-in doors pass the client on to issueSession', () => {
    for (const p of ['src/app/api/auth/login/route.ts', 'src/app/api/auth/2fa/verify/route.ts']) {
      const src = read(p);
      expect(src, p).toContain('signInClientOf(said)');
      const calls = src.match(/issueSession\(\{[\s\S]*?\}\)/g) ?? [];
      expect(calls.length, p).toBeGreaterThan(0);
      for (const call of calls) expect(call, `${p}: issueSession بدون client`).toContain('client');
    }
  });

  it('the context door hands the app its signed selection', () => {
    const src = read('src/app/api/context/route.ts');
    expect(src.match(/isAppRequest\(req\.headers/g)?.length).toBe(2);
    expect(src).toContain('context:');
  });
});
