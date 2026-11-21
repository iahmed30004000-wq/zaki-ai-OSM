import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «صفحات ذكي» — THE OWNER POINTS THIS SYSTEM AT ZAKI PAGES (2026-11-21)
 *
 *  · Owner only: `apps.manage` AND every key. Anybody else: 403, nothing read, nothing written.
 *  · The secret is written only: encrypted at rest, never in a response, never in the audit log, never in a log line.
 *  · Not a second channel: it is the installed app `ZAKI_PAGES` (App + AppInstall) registered for `pages.order_status`;
 *    an app already registered under that code keeps its secret when the field is left empty, and gains the event.
 *  · The status a screen needs: queued · delivered · failed, and the last failure.
 * ═══════════════════════════════════════════════════════════════════════
 */

const h = vi.hoisted(() => ({
  user: { id: 'u1', name: 'المالك', role: 'ADMIN', status: 'ACTIVE' },
  owner: true,
  canManage: true,
  db: {
    app: { findFirst: vi.fn(), update: vi.fn(), create: vi.fn() },
    appInstall: { findFirst: vi.fn(), upsert: vi.fn() },
    appDelivery: { groupBy: vi.fn(), findFirst: vi.fn() },
  },
  logAudit: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db: h.db }));
vi.mock('@/lib/auth', () => ({ requireCompanyTenant: async () => ({ user: h.user, companyId: 'c1' }) }));
vi.mock('@/lib/authorization', () => ({
  requirePermission: async (p: string) => {
    if (p !== 'apps.manage' || !h.canManage) throw new Error(`Forbidden: missing required permission ${p}`);
    return h.user;
  },
  hasFullAccess: () => h.owner,
}));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => h.logAudit(...a) }));

import { decryptSecret } from '@/lib/secrets';
import { GET, PUT } from './route';

const SECRET = 'pages-shared-secret-0123456789abcdef';
const URL_ = 'https://pages.example.test/webhooks/oms';
const put = (body: unknown) => new Request('https://x.test/api/settings/pages-link', { method: 'PUT', body: JSON.stringify(body) });

let stored: { id: string; webhookUrl: string; secret: string | null; events: string; status: string } | null;

beforeAll(() => {
  process.env.APP_ENCRYPTION_KEY = 'd'.repeat(64);
});

beforeEach(() => {
  vi.clearAllMocks();
  h.owner = true;
  h.canManage = true;
  stored = null;
  h.db.app.findFirst.mockImplementation(async () => stored);
  h.db.app.create.mockImplementation(async (a: { data: Record<string, string> }) => {
    stored = { id: 'app-1', webhookUrl: a.data.webhookUrl, secret: a.data.secret, events: a.data.events, status: 'ACTIVE' };
    return { id: 'app-1' };
  });
  h.db.app.update.mockImplementation(async (a: { data: Record<string, string> }) => {
    stored = { ...stored!, ...a.data };
    return { id: stored!.id };
  });
  h.db.appInstall.findFirst.mockResolvedValue({ id: 'inst-1', enabled: true });
  h.db.appInstall.upsert.mockResolvedValue({ id: 'inst-1' });
  h.db.appDelivery.groupBy.mockResolvedValue([
    { status: 'OK', _count: { _all: 7 } },
    { status: 'PENDING', _count: { _all: 2 } },
    { status: 'FAILED', _count: { _all: 1 } },
  ]);
  h.db.appDelivery.findFirst.mockResolvedValue({ error: 'HTTP 401', status: 'FAILED', createdAt: new Date('2026-11-21T10:00:00Z') });
});

describe('owner only', () => {
  it.each([
    ['somebody with apps.manage but not every key', () => { h.owner = false; }],
  ])('%s: 403, nothing read or written', async (_n, setUp) => {
    setUp();
    expect((await GET()).status).toBe(403);
    expect((await PUT(put({ url: URL_, secret: SECRET }))).status).toBe(403);
    expect(h.db.app.findFirst).not.toHaveBeenCalled();
    expect(h.db.app.create).not.toHaveBeenCalled();
    expect(h.db.appInstall.upsert).not.toHaveBeenCalled();
  });

  it('somebody without apps.manage: refused before anything is read', async () => {
    h.canManage = false;
    expect((await GET()).status).toBeGreaterThanOrEqual(400);
    expect((await PUT(put({ url: URL_, secret: SECRET }))).status).toBeGreaterThanOrEqual(400);
    expect(h.db.app.findFirst).not.toHaveBeenCalled();
    expect(h.db.app.create).not.toHaveBeenCalled();
  });
});

describe('the secret is written only', () => {
  it('saved encrypted, registered for the event, installed — and the answer says only that a secret is saved', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await PUT(put({ url: URL_, secret: SECRET }));
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain(SECRET);
      const json = JSON.parse(text);
      expect(json).toMatchObject({ configured: true, url: URL_, secretSet: true, enabled: true });
      expect(json).not.toHaveProperty('secret');

      const created = h.db.app.create.mock.calls[0][0].data;
      expect(created).toMatchObject({ companyId: 'c1', code: 'ZAKI_PAGES', webhookUrl: URL_ });
      expect(JSON.parse(created.events)).toEqual(['pages.order_status']);
      expect(created.secret).not.toContain(SECRET);
      expect(decryptSecret(created.secret)).toBe(SECRET);
      expect(h.db.appInstall.upsert.mock.calls[0][0]).toMatchObject({
        where: { companyId_appCode: { companyId: 'c1', appCode: 'ZAKI_PAGES' } },
        create: { companyId: 'c1', appCode: 'ZAKI_PAGES', appId: 'app-1', enabled: true },
      });

      // Never in the audit log, never in a log line.
      expect(JSON.stringify(h.logAudit.mock.calls)).not.toContain(SECRET);
      expect(h.logAudit.mock.calls[0][0].newData).toMatchObject({ secretChanged: true });
      expect(JSON.stringify([log.mock.calls, err.mock.calls, warn.mock.calls])).not.toContain(SECRET);
    } finally {
      log.mockRestore();
      err.mockRestore();
      warn.mockRestore();
    }
  });

  it('GET never returns it either', async () => {
    stored = { id: 'app-1', webhookUrl: URL_, secret: 'v1:sealed', events: '["pages.order_status"]', status: 'ACTIVE' };
    const text = await (await GET()).text();
    expect(text).not.toContain('v1:sealed');
    expect(JSON.parse(text)).toMatchObject({ secretSet: true, configured: true });
  });

  it('an app already registered under the code keeps its secret when the field is empty, and gains the event', async () => {
    stored = { id: 'app-old', webhookUrl: 'https://old.test/h', secret: 'v1:kept', events: '["order.delivered"]', status: 'ACTIVE' };
    const res = await PUT(put({ url: URL_ }));
    expect(res.status).toBe(200);
    const data = h.db.app.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('secret');
    expect(JSON.parse(data.events)).toEqual(['order.delivered', 'pages.order_status']);
    expect(data.webhookUrl).toBe(URL_);
    expect(h.logAudit.mock.calls[0][0].newData).toMatchObject({ secretChanged: false });
  });

  it.each([
    ['no secret on a first save', { url: URL_ }],
    ['a short secret', { url: URL_, secret: 'short' }],
    ['an address that is not https', { url: 'http://pages.example.test/x', secret: SECRET }],
  ])('refused: %s — and the refusal never echoes the secret', async (_n, body) => {
    const res = await PUT(put(body));
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain(SECRET);
    expect(h.db.app.create).not.toHaveBeenCalled();
  });

  it('switching it off keeps the address and the secret', async () => {
    stored = { id: 'app-1', webhookUrl: URL_, secret: 'v1:kept', events: '["pages.order_status"]', status: 'ACTIVE' };
    await PUT(put({ url: URL_, enabled: false }));
    expect(h.db.appInstall.upsert.mock.calls[0][0].update).toEqual({ appId: 'app-1', enabled: false });
    expect(h.db.app.update.mock.calls[0][0].data).not.toHaveProperty('secret');
  });
});

describe('the status a screen can show', () => {
  it('delivered · queued · failed for the Pages event, and the last failure', async () => {
    stored = { id: 'app-1', webhookUrl: URL_, secret: 'v1:x', events: '["pages.order_status"]', status: 'ACTIVE' };
    const json = await (await GET()).json();
    expect(json.deliveries).toEqual({ ok: 7, pending: 2, failed: 1 });
    expect(json.lastFailure).toMatchObject({ error: 'HTTP 401', status: 'FAILED' });
    expect(h.db.appDelivery.groupBy.mock.calls[0][0].where).toEqual({ companyId: 'c1', installId: 'inst-1', event: 'pages.order_status' });
  });
});
