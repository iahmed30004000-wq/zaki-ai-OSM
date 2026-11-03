import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';
import type { SessionUser } from '@/types/auth';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «عاين كـ سارة» — HER DESK, WITH HER ORDERS, AND NOT ONE WRITE IN HER NAME.
 *
 * The owner, 4/11: «بس بدي تظهرلي شو عندها مش شو». The preview (preview-mode.ts) is not
 * an empty role: the desk door, asked WITHOUT `?agent=`, answers the orders SHE holds,
 * because the session it reads is hers.
 *
 * The session is the REAL one: `getCurrentUser` reads the owner's cookie, the preview
 * cookie and the proxy's stamp, and builds Sara through the real permission engine;
 * `requirePermission('confirmation.work')` inside the door is the real one too. Only the
 * rows, the cookie jar, the request headers and the store context are this file's.
 * ═══════════════════════════════════════════════════════════════════════
 */

type Row = Record<string, unknown>;

const { state, db, SECRET, handedOut } = vi.hoisted(() => {
  const SECRET = 'p'.repeat(48);
  process.env.JWT_SECRET = SECRET;
  const state = {
    user: null as unknown as SessionUser,
    cookies: new Map<string, string>(),
    headers: new Headers(),
    wheres: [] as Row[],
    orders: [] as Row[],
    users: {} as Record<string, Row>,
  };
  const pick = (where: Row) => state.orders.filter((o) => o.claimedById === where.claimedById && o.storeId === where.storeId);
  /** Every write a GET could reach, as a spy that must stay silent. */
  const write = () => vi.fn(async () => ({ count: 0 }));
  const db = {
    user: {
      findUnique: vi.fn(async (q: { where: { id: string } }) => state.users[q.where.id] ?? null),
      update: write(),
      updateMany: write(),
    },
    company: { findFirst: vi.fn(async () => ({ id: 'c1' })) },
    rolePermission: {
      findMany: vi.fn(async (q: { where: { roleId?: string } }) =>
        q.where.roleId === 'r-sara' ? LIVE_AGENT.map((permission) => ({ permission, scope: 'ALL_COMPANY', scopeIds: null })) : []
      ),
    },
    userPermission: { findMany: vi.fn(async () => []) },
    order: {
      findMany: vi.fn(async (q: { where: Row }) => {
        state.wheres.push(q.where);
        return pick(q.where);
      }),
      count: vi.fn(async (q: { where: Row }) => {
        state.wheres.push(q.where);
        return pick(q.where).length;
      }),
      findFirst: vi.fn(async () => null),
      update: write(),
      updateMany: write(),
    },
    orderContactAttempt: { groupBy: vi.fn(async () => []) },
    orderClaimHistory: { findFirst: vi.fn(async () => null), create: write() },
    notification: {
      count: vi.fn(async () => 3),
      groupBy: vi.fn(async () => []),
      findMany: vi.fn(async () => [{ id: 'n1', userId: 'sara', isRead: false, title: 'طلب جديد' }]),
      update: write(),
      updateMany: write(),
      createMany: write(),
    },
    attendanceMark: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null), create: write() },
    auditLog: { create: write() },
  };
  /** CONFIRMATION_AGENT, live, 1/11 (the-live-agent-is-refused-by-the-real-engine.test.ts). */
  const LIVE_AGENT = [
    'ai.assist', 'ai.use', 'confirmation.issues', 'confirmation.issues_correct', 'confirmation.pull', 'confirmation.raise_issue',
    'confirmation.reassign', 'confirmation.supervise', 'confirmation.winback', 'confirmation.work', 'customers.view_basic', 'insights.view',
    'orders.change_price', 'orders.claim', 'orders.confirm', 'orders.contact_log', 'orders.edit', 'orders.note', 'orders.rating_link',
    'orders.release', 'orders.request_change', 'orders.view',
  ];
  return { state, db, SECRET, handedOut: vi.fn() };
});

vi.mock('@/lib/db', () => ({ db, default: db }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (state.cookies.has(name) ? { name, value: state.cookies.get(name)! } : undefined),
  }),
  headers: async () => state.headers,
}));
vi.mock('@/lib/geo-context', () => ({
  requireContext: async () => ({
    user: state.user,
    companyId: 'c1',
    storeId: 's1',
    countryId: 'co1',
    country: { id: 'co1', code: 'JO', name: 'الأردن', currencyCode: 'JOD', minorUnit: 3, timezone: 'Asia/Amman', workHoursStart: '09:00', workHoursEnd: '17:00' },
  }),
  seesAllCountries: () => false,
  ContextError: class extends Error {},
}));
vi.mock('@/lib/notification-audience', () => ({ resolveAudience: async () => [] }));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: handedOut }));
vi.mock('@/lib/response-clock', () => ({ firstActionTimes: async () => new Map() }));
vi.mock('@/lib/customer-risk', () => ({ customerRisk: async () => null }));

import { getCurrentUser } from '@/lib/auth';
import { PREVIEW_COOKIE, PREVIEW_STAMP_HEADER, previewStamp, signPreviewToken } from '@/lib/preview-mode';
import * as mineRoute from '@/app/api/confirmation/mine/route';
import * as notificationsRoute from '@/app/api/notifications/route';
import * as attendanceRoute from '@/app/api/attendance/mark/route';

const key = new TextEncoder().encode(SECRET);

function userRow(id: string, role: string, name: string, extra: Row = {}): Row {
  return {
    id, email: `${id}@x`, name, role, roleId: role === 'SUPER_ADMIN' ? null : `r-${id}`, status: 'ACTIVE', companyId: 'c1',
    tokenVersion: 0, avatar: null, commissionRate: 0, systemTheme: null, tourDoneAt: null,
    roleRef: role === 'SUPER_ADMIN' ? null : { systemTheme: null, name: 'موظفة تأكيد' },
    ...extra,
  };
}

const order = (id: string, claimedById: string): Row => ({
  id, orderNumber: id, claimedById, storeId: 's1', confirmationStatus: 'IN_PROGRESS', version: 1,
  customer: { id: `cu-${id}`, fullName: 'زبون', phone: '0999', rawPhone: '0999', city: 'دمشق', address: 'شارع', totalOrders: 1 },
  items: [], addOns: [], _count: { contactAttempts: 0, notes: 0 },
});

/** The owner, signed in, previewing Sara — and the proxy's stamp on this read. */
async function ownerPreviewingSara() {
  const session = await new SignJWT({ userId: 'owner', email: 'owner@x', role: 'SUPER_ADMIN', status: 'ACTIVE', companyId: null, tv: 0 })
    .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('7d').sign(key);
  const preview = await signPreviewToken({ ownerId: 'owner', targetId: 'sara', sessionToken: session }, key);
  state.cookies = new Map([['salesflow_session', session], [PREVIEW_COOKIE, preview]]);
  state.headers = new Headers({ [PREVIEW_STAMP_HEADER]: await previewStamp(preview, key) });
  state.user = (await getCurrentUser())!;
}

const writes = () =>
  [db.user.update, db.user.updateMany, db.order.update, db.order.updateMany, db.orderClaimHistory.create, db.notification.update,
    db.notification.updateMany, db.notification.createMany, db.attendanceMark.create, db.auditLog.create].flatMap((f) => f.mock.calls);

beforeEach(() => {
  vi.clearAllMocks();
  state.wheres = [];
  state.users = { owner: userRow('owner', 'SUPER_ADMIN', 'أحمد', { companyId: null }), sara: userRow('sara', 'CONFIRMATION_AGENT', 'سارة') };
  state.orders = [order('O-SARA-1', 'sara'), order('O-SARA-2', 'sara'), order('O-HIND-1', 'hind'), order('O-OWNER-1', 'owner')];
});

describe('the owner previewing Sara opens HER desk — the orders she holds', () => {
  it('the session is hers, and «شغلي» answers her two held orders, no colleague’s and not the owner’s', async () => {
    await ownerPreviewingSara();
    expect(state.user.id).toBe('sara');
    const res = await mineRoute.GET(new Request('http://x/api/confirmation/mine'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.work.map((o: { id: string }) => o.id).sort()).toEqual(['O-SARA-1', 'O-SARA-2']);
    expect(body.viewing ?? null).toBeNull(); // her own desk, not «شاشة موظفة»
    for (const w of state.wheres) expect(w).toMatchObject({ companyId: 'c1', storeId: 's1', claimedById: 'sara' });
  });

  it('and the reading writes nothing — no claim touched, no row in her name', async () => {
    await ownerPreviewingSara();
    await mineRoute.GET(new Request('http://x/api/confirmation/mine'));
    expect(writes()).toEqual([]);
  });
});

describe('previewing her marks none of her notifications read, and clocks her in nowhere', () => {
  it('the bell reads her unread rows and leaves them unread', async () => {
    await ownerPreviewingSara();
    const res = await notificationsRoute.GET(new Request('http://x/api/notifications'));
    expect(res.status).toBe(200);
    expect((await res.json()).unreadCount).toBe(3);
    expect(db.notification.count).toHaveBeenCalledWith({ where: expect.objectContaining({ userId: 'sara', isRead: false }) });
    expect(writes()).toEqual([]);
  });

  it('her shift chip reads her day and writes no attendance mark', async () => {
    await ownerPreviewingSara();
    const res = await attendanceRoute.GET();
    expect(res.status).toBe(200);
    expect(db.attendanceMark.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ userId: 'sara' }) }));
    expect(writes()).toEqual([]);
  });
});
