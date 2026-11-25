import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE MEDIA BUYER IS AN INSTALLED APP (PR-B, O5) — registered on the page that already exists, with its own URL, its own signing secret shown ONCE, and the one extra
 * event it listens to. No new screen, no new table: `POST /api/apps` accepts the stop request by name beside the six, and nothing else about registration changed.
 */

const h = vi.hoisted(() => ({
  db: {
    app: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() },
    appInstall: { findMany: vi.fn() },
    deliveryProvider: { count: vi.fn() },
    trackingPixel: { count: vi.fn() },
    whatsAppConnection: { count: vi.fn() },
    telegramSource: { count: vi.fn() },
  },
  logAudit: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db: h.db }));
vi.mock('@/lib/auth', () => ({ requireCompanyTenant: async () => ({ user: { id: 'u1' }, companyId: 'c1' }) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: async () => undefined, can: () => true }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => h.logAudit(...a) }));
vi.mock('@/lib/secrets', () => ({ encryptSecret: (s: string) => `enc:${s.length}`, encryptionAvailable: () => true }));

import { GET, POST } from './route';
import { APP_EVENTS, OWNER_STOP_EVENT } from '@/lib/apps/events';

const post = (body: unknown) => new Request('https://crm.test/api/apps', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
const MEDIABUYER = {
  name: 'الميديا باير',
  code: 'MEDIABUYER',
  webhookUrl: 'https://mediabuyer.zakiai.io/api/inbound/oms',
  events: [OWNER_STOP_EVENT],
};

beforeEach(() => {
  vi.clearAllMocks();
  h.db.app.findFirst.mockResolvedValue(null);
  h.db.app.create.mockImplementation(async ({ data }: { data: { code: string; name: string } }) => ({ id: 'a1', code: data.code, name: data.name }));
  h.db.appInstall.findMany.mockResolvedValue([]);
  h.db.app.findMany.mockResolvedValue([]);
  for (const t of ['deliveryProvider', 'trackingPixel', 'whatsAppConnection', 'telegramSource'] as const) h.db[t].count.mockResolvedValue(0);
});

describe('registering the media buyer', () => {
  it('accepts the stop request by name, stores it, and shows the signing secret once — never in the audit row', async () => {
    const res = await POST(post(MEDIABUYER));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.secret).toMatch(/^zk_[0-9a-f]{64}$/);
    const data = h.db.app.create.mock.calls[0][0].data;
    expect(JSON.parse(data.events)).toEqual([OWNER_STOP_EVENT]);
    expect(data.webhookUrl).toBe('https://mediabuyer.zakiai.io/api/inbound/oms');
    expect(data.secret).toMatch(/^enc:/);
    expect(data.secret).not.toContain(body.secret);
    const audit = JSON.stringify(h.logAudit.mock.calls);
    expect(audit).toContain('APP_REGISTERED');
    expect(audit).not.toContain(body.secret);
  });

  it('may listen to the stop request and the six together; an unknown name is dropped, and only unknown names is a 400', async () => {
    const mixed = await POST(post({ ...MEDIABUYER, code: 'MB2', events: ['order.created', OWNER_STOP_EVENT, 'order.exploded'] }));
    expect(mixed.status).toBe(200);
    expect(JSON.parse(h.db.app.create.mock.calls[0][0].data.events)).toEqual(['order.created', OWNER_STOP_EVENT]);
    const none = await POST(post({ ...MEDIABUYER, code: 'MB3', events: ['order.exploded'] }));
    expect(none.status).toBe(400);
    expect(h.db.app.create).toHaveBeenCalledTimes(1);
  });

  it('the rest of registration is as it was: https only, and a code already used is 409', async () => {
    expect((await POST(post({ ...MEDIABUYER, webhookUrl: 'http://mediabuyer.zakiai.io/x' }))).status).toBe(400);
    h.db.app.findFirst.mockResolvedValue({ id: 'old' });
    expect((await POST(post(MEDIABUYER))).status).toBe(409);
  });
});

describe('what the page offers', () => {
  it('the six, then the owner’s stop request, then Zaki Pages’ order status (2026-11-21), each with its label', async () => {
    const { availableEvents } = await (await GET()).json();
    expect(availableEvents.map((e: { code: string }) => e.code)).toEqual([...APP_EVENTS, OWNER_STOP_EVENT, 'pages.order_status']);
    expect(availableEvents.every((e: { label: string }) => e.label.length > 0)).toBe(true);
  });

  it('never returns a secret', async () => {
    h.db.app.findMany.mockResolvedValue([
      { id: 'a1', code: 'MEDIABUYER', name: 'الميديا باير', description: null, developerName: null, iconUrl: null, webhookUrl: MEDIABUYER.webhookUrl, events: JSON.stringify([OWNER_STOP_EVENT]), status: 'ACTIVE', createdAt: new Date(), _count: { installs: 1 } },
    ]);
    const body = await (await GET()).text();
    expect(body).not.toMatch(/secret/i);
    expect(JSON.parse(body).external[0].events).toEqual([OWNER_STOP_EVENT]);
    expect(h.db.app.findMany.mock.calls[0][0].select).not.toHaveProperty('secret');
  });
});
