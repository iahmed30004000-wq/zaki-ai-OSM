import { AsyncLocalStorage } from 'node:async_hooks';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE SESSION IS READ ONCE PER REQUEST, NOT ONCE PER DOOR (13/11 — the site's slow-down, plan PR-4).
 *
 * One API request walks several doors (`requireContext`, `requirePermission`, the tenant, a scope) and each one used to ask
 * «who is this» again from the top: the account, its role, its grants and this device's row — eight to ten queries a time.
 * `getSessionVerdict` now keeps the first read on the request's own cookie jar and the doors after it wait for that same one.
 *
 * WHAT THIS FILE HOLDS DOWN, because the keeping is only safe in these exact shapes:
 *   · the premise is Next's: inside one request every `await cookies()` is the SAME jar and the next request gets another —
 *     run here against Next's own request store, not a stand-in, so an upgrade that changes it fails here;
 *   · the answer never leaves its request, never crosses to another cookie, never outlives five seconds, never
 *     keeps a failure, and `{ preview: 'ignore' }` is a question of its own;
 *   · what the first read said is what a fresh read says (every branch of the verdict), and a second request pays its own
 *     read — a sign-out or a version bump made by ANOTHER request reaches the next request at once;
 *   · the sharing is only safe while no door writes to the user it was handed: one scan of the source.
 * ═══════════════════════════════════════════════════════════════════════
 */

const T0 = new Date('2026-11-13T09:00:00Z').getTime();
const SESSION_COOKIE = 'salesflow_session';
const PREVIEW_COOKIE = 'zaki_preview';

const h = vi.hoisted(() => {
  const state = {
    users: new Map<string, Record<string, unknown>>(),
    sessions: new Map<string, Record<string, unknown>>(),
    reads: { user: 0, session: 0, grants: 0 },
    /** The next account read fails with this (and then the one after it is fine). */
    failNext: null as Error | null,
    /** While set, every account read waits for it before it answers. */
    hold: null as Promise<void> | null,
  };
  const db = {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        state.reads.user += 1;
        const fail = state.failNext;
        state.failNext = null;
        if (state.hold) await state.hold;
        if (fail) throw fail;
        const row = state.users.get(where.id);
        return row ? { ...row } : null;
      }),
    },
    userSession: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        state.reads.session += 1;
        const row = state.sessions.get(where.id);
        return row ? { ...row } : null;
      }),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
  };
  return { state, db };
});

vi.mock('./db', () => ({ db: h.db }));
vi.mock('./permissions-core', () => ({
  computeEffectiveGrants: async () => {
    h.state.reads.grants += 1;
    return { fullAccess: false, grants: {} };
  },
}));
vi.mock('./authorization', () => ({ attachGrants: () => undefined, requirePermission: vi.fn() }));

// ── Next's own request machinery, loaded the way its server loads it ─────────────────────────────────────────────────
// `AsyncLocalStorage` is a global before anything of Next's loads, in the server; a test file has to do the same first.
type Jar = { get(name: string): { value: string } | undefined; set(name: string, value: string): unknown };
let nextCookies: () => Promise<Jar>;
let runWork: (store: unknown, fn: () => Promise<unknown>) => Promise<unknown>;
let runUnit: (store: unknown, fn: () => Promise<unknown>) => Promise<unknown>;
let newStore: (cookieHeader: string) => unknown;
let auth: typeof import('./auth');
let authErrors: typeof import('./auth-errors');

const WORK_STORE = { route: '/api/test', page: '/api/test', forceStatic: false, dynamicShouldError: false, isStaticGeneration: false };

beforeAll(async () => {
  (globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;
  nextCookies = (await import('next/headers')).cookies as unknown as () => Promise<Jar>;
  const work = (await import('next/dist/server/app-render/work-async-storage.external')).workAsyncStorage;
  const unit = (await import('next/dist/server/app-render/work-unit-async-storage.external')).workUnitAsyncStorage;
  const { createRequestStoreForAPI } = await import('next/dist/server/async-storage/request-store');
  runWork = (store, fn) => work.run(store as never, fn);
  runUnit = (store, fn) => unit.run(store as never, fn);
  newStore = (cookieHeader) =>
    createRequestStoreForAPI(
      { headers: new Headers(cookieHeader ? { cookie: cookieHeader } : {}) } as never,
      { pathname: '/api/test', search: '' } as never,
      { tags: [], expirationsByCacheKind: new Map() } as never,
      undefined,
      undefined,
      undefined
    );
  auth = await import('./auth');
  authErrors = await import('./auth-errors');
});

/** One REQUEST: everything inside `fn` shares one cookie jar, exactly as a route handler's doors do; the next call is the next request. */
function inRequest<T>(cookieHeader: string, fn: () => Promise<T>, phase: 'action' | 'render' = 'action'): Promise<T> {
  const store = newStore(cookieHeader);
  if (phase === 'render') (store as { phase: string }).phase = 'render';
  return runWork(WORK_STORE, () => runUnit(store, fn)) as Promise<T>;
}

function userRow(id: string, tokenVersion: number, name: string) {
  return {
    id,
    email: `${id}@example.test`,
    name,
    role: 'MODERATOR',
    status: 'ACTIVE',
    companyId: 'c1',
    commissionRate: null,
    tokenVersion,
    roleId: null,
    avatar: null,
    systemTheme: null,
    tourDoneAt: null,
    company: { id: 'c1', name: 'زكي' },
    roleRef: null,
  };
}

const sessionRow = (id: string, userId: string) => ({ id, userId, revokedAt: null, revokeReason: null, lastSeenAt: new Date() });

function seed() {
  h.state.users.clear();
  h.state.sessions.clear();
  h.state.users.set('u1', userRow('u1', 3, 'لينا'));
  h.state.users.set('u2', userRow('u2', 5, 'سارة'));
  h.state.sessions.set('s1', sessionRow('s1', 'u1'));
  h.state.sessions.set('s2', sessionRow('s2', 'u2'));
  h.state.failNext = null;
  h.state.hold = null;
  resetReads();
}

function resetReads() {
  h.state.reads.user = 0;
  h.state.reads.session = 0;
  h.state.reads.grants = 0;
}

async function tokenOf(over: Partial<{ userId: string; tv: number; sid: string | undefined }> = {}) {
  return auth.createSessionToken({
    userId: 'u1',
    email: 'u1@example.test',
    role: 'MODERATOR',
    status: 'ACTIVE',
    companyId: 'c1',
    tv: 3,
    sid: 's1',
    ...over,
  });
}

const jarOf = (token?: string, preview?: string) =>
  [token && `${SESSION_COOKIE}=${token}`, preview && `${PREVIEW_COOKIE}=${preview}`].filter(Boolean).join('; ');

const backendDown = () => Object.assign(new Error('Timed out fetching a new connection from the connection pool'), { name: 'PrismaClientKnownRequestError', code: 'P2024' });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  seed();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('the premise: Next hands every door of one request the same cookie jar, and the next request another', () => {
  it('inside one request every `await cookies()` is one jar — in a route handler and in a page render', async () => {
    for (const phase of ['action', 'render'] as const) {
      const [a, b] = await inRequest('a=1', async () => [await nextCookies(), await nextCookies()], phase);
      expect(a === b, `مرحلة ${phase}: الكوكيز صار كائنين بنفس الطلب — الحفظ ما رح يلاقي شي`).toBe(true);
    }
  });

  it('two requests are two jars, each with its own cookies', async () => {
    const a = await inRequest('salesflow_session=aaa', async () => nextCookies());
    const b = await inRequest('salesflow_session=bbb', async () => nextCookies());
    expect(a === b).toBe(false);
    expect(a.get(SESSION_COOKIE)?.value).toBe('aaa');
    expect(b.get(SESSION_COOKIE)?.value).toBe('bbb');
  });

  it('a cookie set in the middle of a request is what the same jar says next (so a replaced cookie is a new question)', async () => {
    const seen = await inRequest('salesflow_session=aaa', async () => {
      const jar = await nextCookies();
      jar.set(SESSION_COOKIE, 'zzz');
      const again = await nextCookies();
      return { sameJar: again === jar, value: again.get(SESSION_COOKIE)?.value };
    });
    expect(seen).toEqual({ sameJar: true, value: 'zzz' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('one request, one read', () => {
  it('three doors in a row cost ONE read of the account, the device row and the grants — and hand out one user', async () => {
    const cookie = jarOf(await tokenOf());
    const out = await inRequest(cookie, async () => {
      const a = await auth.requireAuth();
      const b = await auth.getCurrentUser();
      const c = (await auth.getSessionVerdict()).user;
      return { a, b, c };
    });
    expect(h.state.reads, 'ثلاث أبواب بطلب واحد لازم تقرا مرة وحدة').toEqual({ user: 1, session: 1, grants: 1 });
    expect(out.a.id).toBe('u1');
    expect(out.b).toBe(out.a);
    expect(out.c).toBe(out.a);
  });

  it('doors that ask at the very same moment share the read that is already under way', async () => {
    const cookie = jarOf(await tokenOf());
    const out = await inRequest(cookie, () => Promise.all([auth.getSessionVerdict(), auth.getSessionVerdict(), auth.getCurrentUser(), auth.requireAuth()]));
    expect(h.state.reads).toEqual({ user: 1, session: 1, grants: 1 });
    expect(new Set(out.map((x) => ('user' in (x as object) && (x as { user: unknown }).user ? (x as { user: unknown }).user : x))).size).toBe(1);
  });

  it('the NEXT request pays its own read — the same cookie, another jar', async () => {
    const cookie = jarOf(await tokenOf());
    await inRequest(cookie, async () => auth.getSessionVerdict());
    await inRequest(cookie, async () => auth.getSessionVerdict());
    expect(h.state.reads).toEqual({ user: 2, session: 2, grants: 2 });
  });

  it('what ANOTHER request changed reaches the next request at once: a version bump signs the cookie out', async () => {
    const cookie = jarOf(await tokenOf());
    const before = await inRequest(cookie, async () => auth.getSessionVerdict());
    expect(before.user?.id).toBe('u1');
    h.state.users.set('u1', userRow('u1', 4, 'لينا')); // «sign out everywhere» happened in some other request
    const after = await inRequest(cookie, async () => auth.getSessionVerdict());
    expect(after).toEqual({ user: null, reason: 'NONE' });
  });

  it('a device that signed out, and one a third sign-in ended, are told apart on the next request', async () => {
    const cookie = jarOf(await tokenOf());
    h.state.sessions.set('s1', { ...sessionRow('s1', 'u1'), revokedAt: new Date(), revokeReason: 'LOGOUT' });
    expect(await inRequest(cookie, async () => auth.getSessionVerdict())).toEqual({ user: null, reason: 'NONE' });
    h.state.sessions.set('s1', { ...sessionRow('s1', 'u1'), revokedAt: new Date(), revokeReason: 'REPLACED' });
    expect(await inRequest(cookie, async () => auth.getSessionVerdict())).toEqual({ user: null, reason: 'REPLACED' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('the answer is kept only as far as it is safe to', () => {
  it('FIVE SECONDS FROM THE MOMENT THE ANSWER ARRIVED: at 4.999 s the doors still share; at 5 s a door asks again', async () => {
    const cookie = jarOf(await tokenOf());
    await inRequest(cookie, async () => {
      await auth.getSessionVerdict();
      vi.setSystemTime(T0 + 4_999);
      await auth.getSessionVerdict();
      expect(h.state.reads.user, 'قبل الخمس ثواني').toBe(1);
      vi.setSystemTime(T0 + 5_000);
      await auth.getSessionVerdict();
      expect(h.state.reads.user, 'عند الخمس ثواني').toBe(2);
    });
  });

  it('a clock that went BACK is not trusted: the kept answer is asked again, not kept for the length of the jump', async () => {
    const cookie = jarOf(await tokenOf());
    await inRequest(cookie, async () => {
      await auth.getSessionVerdict();
      vi.setSystemTime(T0 - 60_000);
      await auth.getSessionVerdict();
      expect(h.state.reads.user).toBe(2);
    });
  });

  it('`{ preview: ignore }` is a question of its own — signing out asks as the owner, and asking twice is still one read each', async () => {
    const cookie = jarOf(await tokenOf());
    await inRequest(cookie, async () => {
      await auth.getSessionVerdict({ preview: 'ignore' });
      await auth.getSessionVerdict();
      expect(h.state.reads.user, 'سؤالين مختلفين').toBe(2);
      await auth.getSessionVerdict({ preview: 'ignore' });
      await auth.getSessionVerdict();
      expect(h.state.reads.user, 'التكرار ما بيقرا من جديد').toBe(2);
    });
  });

  it('the preview cookie is part of the question: a different one, in the same request, is asked again', async () => {
    const cookie = jarOf(await tokenOf(), 'p1');
    await inRequest(cookie, async () => {
      await auth.getSessionVerdict();
      await auth.getSessionVerdict();
      expect(h.state.reads.user).toBe(1);
      (await nextCookies()).set(PREVIEW_COOKIE, 'p2');
      await auth.getSessionVerdict();
      expect(h.state.reads.user, 'كوكي المعاينة تغيّر').toBe(2);
    });
  });

  it('a session cookie replaced in the middle is a NEW question and answers the other person — nothing bleeds between cookies', async () => {
    const mine = await tokenOf();
    const hers = await tokenOf({ userId: 'u2', tv: 5, sid: 's2' });
    await inRequest(jarOf(mine), async () => {
      expect((await auth.getSessionVerdict()).user?.id).toBe('u1');
      expect((await auth.getSessionVerdict({ preview: 'ignore' })).user?.id).toBe('u1');
      (await nextCookies()).set(SESSION_COOKIE, hers);
      expect((await auth.getSessionVerdict()).user?.id, 'الكوكي الجديد لازم يجاوب عن صاحبو').toBe('u2');
      expect((await auth.getSessionVerdict({ preview: 'ignore' })).user?.id, 'وسؤال «مين الدخلان فعلاً» كمان').toBe('u2');
      (await nextCookies()).set(SESSION_COOKIE, mine);
      expect((await auth.getSessionVerdict()).user?.id).toBe('u1');
      expect((await auth.getSessionVerdict({ preview: 'ignore' })).user?.id).toBe('u1');
    });
  });

  it('A FAILURE IS SHARED BY THE DOORS WAITING ON IT AND NEVER KEPT: the next door asks again, and the database is back', async () => {
    const cookie = jarOf(await tokenOf());
    await inRequest(cookie, async () => {
      h.state.failNext = backendDown();
      const both = await Promise.allSettled([auth.getSessionVerdict(), auth.requireAuth()]);
      expect(both.map((r) => r.status)).toEqual(['rejected', 'rejected']);
      for (const r of both) expect((r as PromiseRejectedResult).reason).toBeInstanceOf(authErrors.AuthBackendDown);
      expect(h.state.reads.user, 'بابين وقت الانقطاع = محاولة وحدة').toBe(1);
      const next = await auth.getSessionVerdict();
      expect(next.user?.id, 'القاعدة رجعت — الباب اللي بعدو لازم يسأل من جديد').toBe('u1');
      expect(h.state.reads.user).toBe(2);
    });
  });

  it('A READ STILL UNDER WAY IS SHARED HOWEVER LONG IT TAKES: a slow database is not asked a second time', async () => {
    const cookie = jarOf(await tokenOf());
    let release!: () => void;
    h.state.hold = new Promise<void>((resolve) => (release = resolve));
    await inRequest(cookie, async () => {
      const first = auth.getSessionVerdict();
      await vi.waitFor(() => expect(h.state.reads.user).toBe(1));
      vi.setSystemTime(T0 + 30_000); // the read has been stuck for half a minute
      const second = auth.requireAuth(); // a second door arrives while it is
      await new Promise((resolve) => setImmediate(resolve)); // and decides what to do about it
      release();
      const [a, b] = await Promise.all([first, second]);
      expect(h.state.reads.user, 'قراءة عالقة نص دقيقة وانسألت مرتين — هاد الضغط اللي بدنا نوقفو').toBe(1);
      expect(b).toBe((a as { user: unknown }).user);
    });
  });

  it('THE FIVE SECONDS COUNT FROM WHEN THE ANSWER ARRIVED, not from when the read began: a slow read does not make the next door ask again', async () => {
    const cookie = jarOf(await tokenOf());
    let release!: () => void;
    h.state.hold = new Promise<void>((resolve) => (release = resolve));
    await inRequest(cookie, async () => {
      const first = auth.getSessionVerdict();
      await vi.waitFor(() => expect(h.state.reads.user).toBe(1));
      vi.setSystemTime(T0 + 8_000); // the read took eight seconds…
      release();
      await first; // …and its answer arrives now
      vi.setSystemTime(T0 + 8_000 + 4_999);
      await auth.getSessionVerdict();
      expect(h.state.reads.user, 'الجواب وصل من أقل من خمس ثواني').toBe(1);
      vi.setSystemTime(T0 + 8_000 + 5_000);
      await auth.getSessionVerdict();
      expect(h.state.reads.user, 'مرّت خمس ثواني على وصول الجواب').toBe(2);
    });
  });

  it('a call outside any request has no jar to keep anything on: nobody, no read, as before', async () => {
    expect(await auth.getSessionVerdict()).toEqual({ user: null, reason: 'NONE' });
    expect(h.state.reads).toEqual({ user: 0, session: 0, grants: 0 });
  });

  it('no cookie at all is nobody without touching the database', async () => {
    const out = await inRequest('', async () => [await auth.getSessionVerdict(), await auth.getSessionVerdict()]);
    expect(out).toEqual([{ user: null, reason: 'NONE' }, { user: null, reason: 'NONE' }]);
    expect(h.state.reads).toEqual({ user: 0, session: 0, grants: 0 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
type Situation = {
  name: string;
  cookie: () => Promise<string>;
  prepare?: () => void;
  user: boolean;
  reason?: 'NONE' | 'REPLACED';
};

const SITUATIONS: Situation[] = [
  { name: 'no cookie at all', cookie: async () => '', user: false, reason: 'NONE' },
  { name: 'a cookie this server did not sign', cookie: async () => jarOf('not-a-jwt'), user: false, reason: 'NONE' },
  { name: 'a valid cookie', cookie: async () => jarOf(await tokenOf()), user: true },
  {
    name: 'a cookie from before the last «sign out everywhere»',
    cookie: async () => jarOf(await tokenOf()),
    prepare: () => h.state.users.set('u1', userRow('u1', 4, 'لينا')),
    user: false,
    reason: 'NONE',
  },
  {
    name: 'a device that signed out',
    cookie: async () => jarOf(await tokenOf()),
    prepare: () => h.state.sessions.set('s1', { ...sessionRow('s1', 'u1'), revokedAt: new Date(), revokeReason: 'LOGOUT' }),
    user: false,
    reason: 'NONE',
  },
  {
    name: 'a device a third sign-in ended',
    cookie: async () => jarOf(await tokenOf()),
    prepare: () => h.state.sessions.set('s1', { ...sessionRow('s1', 'u1'), revokedAt: new Date(), revokeReason: 'REPLACED' }),
    user: false,
    reason: 'REPLACED',
  },
  { name: 'a device row that is somebody else’s', cookie: async () => jarOf(await tokenOf({ sid: 's2' })), user: false, reason: 'NONE' },
  { name: 'a cookie from before the two-devices ruling (no sid)', cookie: async () => jarOf(await tokenOf({ sid: undefined })), user: true },
  {
    name: 'a person who no longer exists',
    cookie: async () => jarOf(await tokenOf()),
    prepare: () => h.state.users.delete('u1'),
    user: false,
    reason: 'NONE',
  },
];

describe.each(SITUATIONS)('what the first read says is what a fresh read says: $name', (s) => {
  it('three doors, one door and a brand-new request all answer the same — and the three doors cost what the one door costs', async () => {
    s.prepare?.();
    const cookie = await s.cookie();

    resetReads();
    const one = await inRequest(cookie, async () => auth.getSessionVerdict());
    const costOfOne = { ...h.state.reads };

    resetReads();
    const three = await inRequest(cookie, async () => {
      const first = await auth.getSessionVerdict();
      const user = await auth.getCurrentUser();
      const last = await auth.getSessionVerdict();
      return { first, user, last };
    });
    expect(h.state.reads, 'ثلاث أبواب لازم تكلّف قد باب واحد').toEqual(costOfOne);

    const fresh = await inRequest(cookie, async () => auth.getSessionVerdict());

    for (const verdict of [one, fresh, three.first]) {
      if (s.user) {
        expect(verdict.user?.id).toBe('u1');
      } else {
        expect(verdict).toEqual({ user: null, reason: s.reason });
      }
    }
    expect(three.first).toEqual(one);
    expect(fresh).toEqual(one);
    if (s.user) {
      expect(three.user, 'نفس الكائن للأبواب كلها').toBe(three.first.user);
      expect(three.last).toBe(three.first);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('the sharing is only safe while no door writes to the user it was handed', () => {
  const FIELDS = 'id|email|name|role|status|avatar|companyId|companyName|commissionRate|systemTheme|tourDoneAt|roleTheme|permissions|legacyPermissions|preview|previewEnded';
  const WRITES = new RegExp(`\\b(user|sessionUser|currentUser|actor|me)\\.(${FIELDS})\\s*(?:=(?!=)|\\+=|-=|\\|\\|=|&&=|\\?\\?=)`, 'g');

  function sources(dir: string, into: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) sources(p, into);
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) into.push(p);
    }
    return into;
  }

  it('the only write to a session user in all of src is the one inside the read itself, on the object it has not handed out yet', () => {
    const root = path.join(process.cwd(), 'src');
    const found: string[] = [];
    for (const file of sources(root)) {
      const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '');
      for (const m of text.matchAll(WRITES)) found.push(`${path.relative(root, file).split(path.sep).join('/')}:${m[1]}.${m[2]}`);
    }
    expect(found.sort(), 'باب كتب على المستخدم — بعد اليوم كل الأبواب بتشوف الكتابة').toEqual(['lib/auth.ts:sessionUser.previewEnded']);
  });
});
