import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «عاين كـ» — THE OWNER SEES WHAT SHE SEES, AND NOTHING CAN BE WRITTEN.
 *
 * The owner, 4/11: «بدي زر معاينة … بس بدي تظهرلي شو عندها». See preview-mode.ts.
 *
 * Nothing about the decision is mocked: the REAL proxy refuses or stamps, the REAL
 * `getCurrentUser` reads the stamp the proxy produced, and the REAL permission engine
 * (`computeEffectiveGrants` → `can`) computes the person. Only the database rows,
 * the cookie jar and the request headers are this file's.
 * ═══════════════════════════════════════════════════════════════════════
 */

type Row = Record<string, unknown>;

const { state, db, SECRET, createNotification } = vi.hoisted(() => {
  const SECRET = 'p'.repeat(48);
  process.env.JWT_SECRET = SECRET;
  const state = {
    cookies: new Map<string, string>(),
    headers: new Headers(),
    users: {} as Record<string, Row>,
    roleRows: {} as Record<string, { permission: string; scope: string; scopeIds: null }[]>,
  };
  const db = {
    user: {
      findUnique: vi.fn(async (q: { where: { id: string } }) => state.users[q.where.id] ?? null),
      findMany: vi.fn(async () => Object.values(state.users)),
    },
    company: { findFirst: vi.fn(async () => ({ id: 'c1' })) },
    rolePermission: {
      findMany: vi.fn(async (q: { where: { roleId?: string } }) => (q.where.roleId ? state.roleRows[q.where.roleId] ?? [] : [])),
    },
    userPermission: { findMany: vi.fn(async () => []) },
    auditLog: { create: vi.fn(async () => ({})) },
    notification: { createMany: vi.fn(async () => ({ count: 0 })), updateMany: vi.fn() },
    attendanceMark: { create: vi.fn() },
  };
  return { state, db, SECRET, createNotification: vi.fn(async () => 1) };
});

vi.mock('@/lib/db', () => ({ db, default: db }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (state.cookies.has(name) ? { name, value: state.cookies.get(name)! } : undefined),
  }),
  headers: async () => state.headers,
}));
vi.mock('@/lib/notification', () => ({ createNotification }));
vi.mock('@/lib/store-redirects', () => ({ redirectFor: vi.fn(async () => null), countRedirectHit: vi.fn() }));
vi.mock('@/lib/landing-domain', async (orig) => ({
  ...(await orig<typeof import('@/lib/landing-domain')>()),
  hostSite: vi.fn(async () => null),
}));
vi.mock('@/lib/geo-context', () => ({
  CONTEXT_COOKIE: 'salesflow_ctx',
  contextCookieOptions: () => ({ path: '/' }),
  readSelection: async () => null,
  signSelection: async () => 'sel',
  validateSelection: async () => ({ countryId: 'co1', storeId: 's1' }),
}));

import { proxy } from '@/proxy';
import { getCurrentUser, inPreviewRead } from '@/lib/auth';
import { can } from '@/lib/authorization';
import { logAudit } from '@/lib/audit';
import { noteCustomersHandedOut } from '@/lib/pii-alert';
import { menuNav } from '@/lib/route-registry';
import { PREVIEW_COOKIE, PREVIEW_STAMP_HEADER, previewStamp, signPreviewToken } from '@/lib/preview-mode';
import * as previewRoute from '@/app/api/preview/route';

const key = new TextEncoder().encode(SECRET);

/** The CONFIRMATION_SUPERVISOR template (migration 20260919205403): supervise and all orders — and NO team.monitor. */
const SUPERVISOR = ['confirmation.work', 'confirmation.supervise', 'confirmation.issues', 'orders.view', 'customers.view_basic', 'reports.view', 'dashboard.view'];

function userRow(id: string, role: string, extra: Row = {}): Row {
  return {
    id, email: `${id}@x`, name: id === 'lina' ? 'لينا' : id, role, roleId: role === 'SUPER_ADMIN' ? null : `r-${id}`,
    status: 'ACTIVE', companyId: 'c1', tokenVersion: 0, avatar: null, commissionRate: 0, systemTheme: null, tourDoneAt: null,
    roleRef: role === 'SUPER_ADMIN' ? null : { systemTheme: null, name: 'مشرفة التأكيد' },
    ...extra,
  };
}

async function sessionFor(id: string): Promise<string> {
  const u = state.users[id];
  return new SignJWT({ userId: id, email: u.email, role: u.role, status: u.status, companyId: u.companyId, tv: 0 })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(key);
}

const cookieHeader = (jar: Record<string, string>) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

function call(method: string, path: string, jar: Record<string, string>, extra: Record<string, string> = {}) {
  return proxy(new Request(`https://app.example.com${path}`, { method, headers: { host: 'app.example.com', cookie: cookieHeader(jar), ...extra } }));
}

const refused = async (res: Response) => res.status === 403 && (await res.clone().json()).code === 'PREVIEW_READ_ONLY';
const stampOf = (res: Response) => res.headers.get(`x-middleware-request-${PREVIEW_STAMP_HEADER}`);

let ownerSession: string;
let preview: string;

/** Put the browser jar AND the proxy's verdict on the request into what the server reads. */
async function serverSees(jar: Record<string, string>, path = '/api/orders') {
  state.cookies = new Map(Object.entries(jar));
  const res = await call('GET', path, jar);
  state.headers = new Headers();
  const stamp = stampOf(res);
  if (stamp) state.headers.set(PREVIEW_STAMP_HEADER, stamp);
}

beforeEach(async () => {
  vi.clearAllMocks();
  state.users = {
    owner: userRow('owner', 'SUPER_ADMIN', { companyId: null, name: 'أحمد' }),
    lina: userRow('lina', 'CONFIRMATION_SUPERVISOR'),
    agent: userRow('agent', 'CONFIRMATION_AGENT'),
    boss2: userRow('boss2', 'SUPER_ADMIN', { companyId: 'c1' }),
    other: userRow('other', 'CONFIRMATION_AGENT', { companyId: 'c2' }),
    off: userRow('off', 'CONFIRMATION_AGENT', { status: 'SUSPENDED' }),
  };
  state.roleRows = {
    'r-lina': SUPERVISOR.map((permission) => ({ permission, scope: 'ALL_COMPANY', scopeIds: null })),
    'r-agent': ['confirmation.work', 'confirmation.pull', 'orders.view'].map((permission) => ({ permission, scope: 'ALL_COMPANY', scopeIds: null })),
  };
  state.headers = new Headers();
  state.cookies = new Map();
  ownerSession = await sessionFor('owner');
  preview = await signPreviewToken({ ownerId: 'owner', targetId: 'lina', sessionToken: ownerSession }, key);
});

const ownerJar = () => ({ salesflow_session: ownerSession, [PREVIEW_COOKIE]: preview });

describe('the server refuses every write while the owner previews — before any handler runs', () => {
  const WRITES: [string, string][] = [
    ['POST', '/api/orders/o1/confirmation'],
    ['POST', '/api/orders'],
    ['POST', '/api/confirmation/pull'],
    ['PUT', '/api/settings'],
    ['PATCH', '/api/notifications'],
    ['POST', '/api/attendance/mark'],
    ['DELETE', '/api/orders/o1'],
    ['POST', '/orders'], // a page POST (a server action) is a write too
  ];

  it.each(WRITES)('%s %s → 403 «وضع المعاينة — قراءة بس»', async (method, path) => {
    const res = await call(method, path, ownerJar());
    expect(await refused(res)).toBe(true);
    expect((await res.json()).errorAr).toContain('وضع المعاينة — قراءة بس');
  });

  it.each(WRITES.filter(([, p]) => p.startsWith('/api/')))('%s %s works again after leaving the preview', async (method, path) => {
    const res = await call(method, path, { salesflow_session: ownerSession });
    expect(res.status).not.toBe(403);
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });

  it('the three open doors still pass: leave the preview, sign out, pick a store', async () => {
    for (const [m, p] of [['DELETE', '/api/preview'], ['POST', '/api/preview'], ['POST', '/api/auth/logout'], ['POST', '/api/context']]) {
      expect(await refused(await call(m, p, ownerJar()))).toBe(false);
    }
  });

  it('a GET that writes by design (the ad account OAuth hand-off) is refused too', async () => {
    expect(await refused(await call('GET', '/api/settings/ad-accounts/oauth/meta/start', ownerJar()))).toBe(true);
  });

  it('a read is let through, stamped with the HMAC of the preview cookie', async () => {
    const res = await call('GET', '/api/confirmation/mine', ownerJar());
    expect(res.status).toBe(200);
    expect(stampOf(res)).toBe(await previewStamp(preview, key));
  });
});

describe('a cookie that does not bind to THIS session is nothing', () => {
  it('copied into an agent’s browser: her writes pass as before, her reads carry no stamp', async () => {
    state.users.agent.status = 'ACTIVE';
    const agentJar = { salesflow_session: await sessionFor('agent'), [PREVIEW_COOKIE]: preview };
    expect(await refused(await call('POST', '/api/orders', agentJar))).toBe(false);
    expect(stampOf(await call('GET', '/api/orders', agentJar))).toBeNull();
  });

  it('forged with another key: ignored', async () => {
    const forged = await signPreviewToken({ ownerId: 'owner', targetId: 'lina', sessionToken: ownerSession }, new TextEncoder().encode('x'.repeat(48)));
    const jar = { salesflow_session: ownerSession, [PREVIEW_COOKIE]: forged };
    expect(await refused(await call('POST', '/api/orders', jar))).toBe(false);
    expect(stampOf(await call('GET', '/api/orders', jar))).toBeNull();
  });

  it('from an older sign-in of the owner: ignored (a new session kills the preview)', async () => {
    const older = await signPreviewToken({ ownerId: 'owner', targetId: 'lina', sessionToken: 'an-older-session-token' }, key);
    expect(stampOf(await call('GET', '/api/orders', { salesflow_session: ownerSession, [PREVIEW_COOKIE]: older }))).toBeNull();
  });

  it('a stamp the browser sends itself is dropped at the door', async () => {
    const res = await call('GET', '/api/orders', { salesflow_session: ownerSession }, { [PREVIEW_STAMP_HEADER]: 'f'.repeat(64) });
    expect(stampOf(res)).toBeNull();
    expect(res.headers.get('x-middleware-override-headers') ?? '').not.toContain(PREVIEW_STAMP_HEADER);
  });
});

describe('getCurrentUser answers HER only on a read the proxy stamped', () => {
  it('the owner previewing Lina IS Lina: her id, her keys, her scopes — the engine’s answer for her own session', async () => {
    await serverSees(ownerJar());
    const seen = (await getCurrentUser())!;
    expect(seen.id).toBe('lina');
    expect(seen.role).toBe('CONFIRMATION_SUPERVISOR');
    expect(seen.preview).toMatchObject({ ownerId: 'owner', ownerName: 'أحمد', roleName: 'مشرفة التأكيد' });

    // Her own session, signed in herself — the same keys, the same answers.
    state.cookies = new Map([['salesflow_session', await sessionFor('lina')]]);
    state.headers = new Headers();
    const herself = (await getCurrentUser())!;
    expect(seen.permissions.sort()).toEqual(herself.permissions.sort());
    for (const k of [...SUPERVISOR, 'team.monitor', 'settings.edit', 'users.view', 'orders.create']) expect(can(seen, k)).toBe(can(herself, k));
    expect(can(seen, 'team.monitor')).toBe(false); // the owner's example: the supervisor has no «لا رد والمحجوزة» tab
  });

  it('the menu is hers, not the owner’s', async () => {
    await serverSees(ownerJar());
    const seen = (await getCurrentUser())!;
    state.cookies = new Map([['salesflow_session', await sessionFor('lina')]]);
    state.headers = new Headers();
    const herself = (await getCurrentUser())!;
    state.cookies = new Map([['salesflow_session', ownerSession]]);
    const owner = (await getCurrentUser())!;
    const paths = (u: typeof seen) => menuNav(u, can).flatMap((g) => g.routes.map((r) => r.path));
    expect(paths(seen)).toEqual(paths(herself));
    expect(paths(seen)).not.toEqual(paths(owner));
    expect(paths(seen)).not.toContain('/admin/users');
    expect(paths(owner)).toContain('/admin/users');
  });

  it('no stamp (a request the proxy never saw) → the owner himself, never her', async () => {
    state.cookies = new Map(Object.entries(ownerJar()));
    state.headers = new Headers();
    expect((await getCurrentUser())!.id).toBe('owner');
    state.headers = new Headers({ [PREVIEW_STAMP_HEADER]: 'a'.repeat(64) });
    expect((await getCurrentUser())!.id).toBe('owner');
  });

  it('`{ preview: "ignore" }` → the owner (signing out and the preview door act as him)', async () => {
    await serverSees(ownerJar());
    expect((await getCurrentUser({ preview: 'ignore' }))!.id).toBe('owner');
  });

  it('a NON-owner holding a validly signed preview cookie for her own session gets nothing: she is herself', async () => {
    const agentSession = await sessionFor('agent');
    const own = await signPreviewToken({ ownerId: 'agent', targetId: 'lina', sessionToken: agentSession }, key);
    const jar = { salesflow_session: agentSession, [PREVIEW_COOKIE]: own };
    state.cookies = new Map(Object.entries(jar));
    state.headers = new Headers({ [PREVIEW_STAMP_HEADER]: await previewStamp(own, key) });
    const seen = (await getCurrentUser())!;
    expect(seen.id).toBe('agent');
    expect(seen.preview).toBeUndefined();
    expect(can(seen, 'confirmation.supervise')).toBe(false);
  });

  it.each([
    ['another owner', 'boss2'],
    ['a person of another company', 'other'],
    ['a suspended account', 'off'],
    ['the owner himself', 'owner'],
  ])('never %s: the owner stays himself', async (_label, target) => {
    preview = await signPreviewToken({ ownerId: 'owner', targetId: target, sessionToken: ownerSession }, key);
    await serverSees(ownerJar());
    expect((await getCurrentUser())!.id).toBe('owner');
  });

  it('an expired preview → the owner', async () => {
    const stale = await new SignJWT({ typ: 'preview', own: 'owner', sid: await (await import('@/lib/preview-mode')).sessionFingerprint(ownerSession) })
      .setProtectedHeader({ alg: 'HS256' }).setSubject('lina').setIssuedAt(1).setExpirationTime(2).sign(key);
    preview = stale;
    await serverSees(ownerJar());
    expect((await getCurrentUser())!.id).toBe('owner');
  });

  it('a preview token is not a session: put in the session cookie, it signs nobody in', async () => {
    state.cookies = new Map([['salesflow_session', preview]]);
    expect(await getCurrentUser()).toBeNull();
  });
});

describe('a preview read writes nothing in her name', () => {
  it('the audit trail stays silent on a preview read, and writes as usual otherwise', async () => {
    await serverSees(ownerJar());
    expect(await inPreviewRead()).toBe(true);
    await logAudit({ companyId: 'c1', userId: 'lina', action: 'REPORT_EXPORTED', entity: 'Report', entityId: 'x' });
    expect(db.auditLog.create).not.toHaveBeenCalled();

    state.headers = new Headers();
    expect(await inPreviewRead()).toBe(false);
    await logAudit({ companyId: 'c1', userId: 'owner', action: 'X', entity: 'Y', entityId: 'z' });
    expect(db.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it('the «many customers read» tally and alarm are not hers to trip', async () => {
    await serverSees(ownerJar());
    const seen = (await getCurrentUser())!;
    const rows = Array.from({ length: 2000 }, (_, i) => ({ customerId: `c${i}`, customer: { id: `c${i}`, phone: '0999' } }));
    await noteCustomersHandedOut({ companyId: 'c1', storeId: 's1', user: seen, where: 'الطلبات', rows: rows as never });
    expect(createNotification).not.toHaveBeenCalled();

    // The same reading by her own session does trip it — so the silence above is the preview's, not the fixture's.
    await noteCustomersHandedOut({ companyId: 'c1', storeId: 's1', user: { ...seen, preview: null }, where: 'الطلبات', rows: rows as never });
    expect(createNotification).toHaveBeenCalledTimes(1);
  });
});

describe('the preview door — the owner alone, audited under his name', () => {
  const post = (body: unknown) => previewRoute.POST(new Request('http://x/api/preview', { method: 'POST', body: JSON.stringify(body) }));

  it('an agent asking to start one is «not found», and no cookie is set', async () => {
    state.cookies = new Map([['salesflow_session', await sessionFor('agent')]]);
    const res = await post({ userId: 'lina' });
    expect(res.status).toBe(404);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect((await previewRoute.GET()).status).toBe(404);
  });

  it('the owner starts one: a two-hour httpOnly cookie, and PREVIEW_START under HIS id naming her', async () => {
    state.cookies = new Map([['salesflow_session', ownerSession]]);
    const res = await post({ userId: 'lina' });
    expect(res.status).toBe(200);
    const set = res.headers.get('set-cookie')!;
    expect(set).toContain(`${PREVIEW_COOKIE}=`);
    expect(set).toContain('HttpOnly');
    expect(set).toContain('Max-Age=7200');
    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: 'owner', action: 'PREVIEW_START', entityId: 'lina', companyId: 'c1' }),
    });
  });

  it.each(['boss2', 'other', 'off'])('the owner cannot start one of %s', async (target) => {
    state.cookies = new Map([['salesflow_session', ownerSession]]);
    expect((await post({ userId: target })).status).toBe(404);
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it('leaving: the cookie is cleared, and PREVIEW_END under his id', async () => {
    state.cookies = new Map(Object.entries(ownerJar()));
    const res = await previewRoute.DELETE();
    expect(res.headers.get('set-cookie')).toMatch(new RegExp(`${PREVIEW_COOKIE}=;.*Max-Age=0`));
    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: 'owner', action: 'PREVIEW_END', entityId: 'lina' }),
    });
  });

  it('the list is his company’s ACTIVE people, never an owner, never himself', async () => {
    state.cookies = new Map([['salesflow_session', ownerSession]]);
    await previewRoute.GET();
    expect(db.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { companyId: 'c1', status: 'ACTIVE', role: { not: 'SUPER_ADMIN' }, id: { not: 'owner' } } })
    );
  });
});
