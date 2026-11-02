import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE DAY'S WORK IS NOT THE WIRE (T-09, 3/11).
 *
 * `telegram.manage` opened both the buttons on «طلبات تلجرام» (إعادة المعالجة · تجاهل · تعديل وترحيل) and the bot's
 * connection: the webhook registration and which group feeds which store. Whoever was given it to clear the review queue
 * could unbind a group or re-point the webhook, and the orders would stop arriving with nothing on a screen saying why.
 *
 * The connection is `telegram.connect` now, granted to nobody. Through the REAL engine (`computeEffectiveGrants`, `can`
 * and the real `requirePermission` — only the session lookup is stubbed):
 *
 *   · each CONNECTION door: the new key → past the gate and the write happens; `telegram.manage` alone → 403 and nothing
 *     is written; a «منع» on the new key beats a role that carries it;
 *   · each DAILY door: `telegram.manage` alone → past the gate, exactly as before;
 *   · the read of the bot's state stays on `telegram.view`, and no answer carries the token or the webhook secret;
 *   · who holds the new key on the day: SUPER_ADMIN (its full access), and nobody else — not a legacy role, not a role
 *     template as the migrations left it.
 * ═══════════════════════════════════════════════════════════════════════
 */

const TOKEN = '123456789:AAFakeTokenNeverShownZZZZZZZZZZZZZZZ';
const SECRET = 'webhook-secret-never-shown-0f9e8d7c';

const { db, tg, current } = vi.hoisted(() => ({
  db: {
    telegramSource: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
    telegramMessage: { findFirst: vi.fn(), updateMany: vi.fn(), groupBy: vi.fn() },
  },
  tg: { getMe: vi.fn(), getWebhookInfo: vi.fn(), setWebhook: vi.fn() },
  current: { user: null as unknown as SessionUser },
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/auth', () => ({
  requireAuth: async () => current.user,
  requireCompanyTenant: async () => ({ user: current.user, companyId: 'c1' }),
}));
vi.mock('@/lib/geo-context', () => ({
  requireContext: async () => ({ user: current.user, companyId: 'c1', storeId: 'store-A' }),
}));
vi.mock('@/lib/audit', async (orig) => ({ ...(await orig<typeof import('@/lib/audit')>()), logAudit: vi.fn() }));
vi.mock('@/lib/telegram/cloud-api', () => ({
  getMe: (...a: unknown[]) => tg.getMe(...a),
  getWebhookInfo: (...a: unknown[]) => tg.getWebhookInfo(...a),
  setWebhook: (...a: unknown[]) => tg.setWebhook(...a),
}));
vi.mock('@/lib/telegram/inbound', () => ({ processStoredMessage: vi.fn(async () => ({ status: 'PROCESSED', orderId: 'o1' })) }));

import { attachGrants, can } from '@/lib/authorization';
import { computeEffectiveGrants } from '@/lib/permissions-core';
import { catalogItem } from '@/lib/permission-catalog';
import { ROLE_PERMISSIONS, type UserRole } from '@/types/auth';
import * as sources from './sources/route';
import * as source from './sources/[id]/route';
import * as sourceTest from './sources/[id]/test/route';
import * as webhook from './webhook/setup/route';
import * as status from './status/route';
import * as retry from './messages/[id]/retry/route';
import * as ignore from './messages/[id]/ignore/route';
import * as correct from './messages/[id]/correct/route';

async function person(roleKeys: string[], deny: string[] = [], role = 'CUSTOM'): Promise<SessionUser> {
  const base = { id: 'u1', email: 'u@x', name: 'سارة', role, roleId: 'r1', status: 'ACTIVE', companyId: 'c1' } as unknown as SessionUser;
  return attachGrants(
    base,
    await computeEffectiveGrants(base as never, {
      roleRows: async () => roleKeys.map((k) => ({ permission: k, scope: 'ALL_COMPANY', scopeIds: null })),
      overrideRows: async () => deny.map((k) => ({ permission: k, effect: 'DENY', scope: null, scopeIds: null })),
    })
  );
}

async function as(roleKeys: string[], deny: string[] = []) {
  current.user = await person(roleKeys, deny);
}

const DAILY_HOLDER = ['telegram.view', 'telegram.manage'];
const CONNECT_HOLDER = ['telegram.view', 'telegram.manage', 'telegram.connect'];

const id = (v = 's1') => ({ params: Promise.resolve({ id: v }) });
const req = (body?: unknown, method = 'POST') =>
  new Request('http://x/api/telegram', { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

const SOURCE_ROW = { id: 's1', companyId: 'c1', chatId: '-1001234567890', topicId: null, isActive: true };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.TELEGRAM_BOT_TOKEN = TOKEN;
  process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
  process.env.APP_URL = 'https://oms.example.test';
  db.telegramSource.findFirst.mockResolvedValue(null);
  db.telegramSource.findUnique.mockResolvedValue(SOURCE_ROW);
  db.telegramSource.create.mockResolvedValue({ ...SOURCE_ROW });
  db.telegramSource.update.mockResolvedValue({ ...SOURCE_ROW, isActive: false });
  db.telegramSource.delete.mockResolvedValue(SOURCE_ROW);
  db.telegramSource.count.mockResolvedValue(1);
  db.telegramMessage.findFirst.mockResolvedValue(null);
  db.telegramMessage.groupBy.mockResolvedValue([]);
  tg.getMe.mockResolvedValue({ ok: true, result: { username: 'zaki_bot' } });
  tg.getWebhookInfo.mockResolvedValue({ ok: true, result: { url: 'https://oms.example.test/api/webhooks/telegram' } });
  tg.setWebhook.mockResolvedValue({ ok: true });
});

afterEach(() => {
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
  delete process.env.APP_URL;
});

/** The connection doors — each with the write that must not happen when it refuses. */
const CONNECTION = [
  {
    name: 'POST /api/telegram/sources (ربط مجموعة بالمتجر)',
    call: () => sources.POST(req({ chatId: '-1001234567890', chatType: 'supergroup' })),
    wrote: () => db.telegramSource.create,
    ok: 201,
  },
  {
    name: 'PATCH /api/telegram/sources/[id] (إيقاف/تشغيل المجموعة)',
    call: () => source.PATCH(req({ isActive: false }, 'PATCH'), id()),
    wrote: () => db.telegramSource.update,
    ok: 200,
  },
  {
    name: 'DELETE /api/telegram/sources/[id] (فكّ الربط)',
    call: () => source.DELETE(req(undefined, 'DELETE'), id()),
    wrote: () => db.telegramSource.delete,
    ok: 200,
  },
  {
    name: 'POST /api/telegram/sources/[id]/test (فحص الربط)',
    call: () => sourceTest.POST(req(), id()),
    // A read, not a write: what must not happen is the read of the binding.
    wrote: () => db.telegramSource.findUnique,
    ok: 200,
  },
  {
    name: 'POST /api/telegram/webhook/setup (تسجيل الويبهوك)',
    call: () => webhook.POST(),
    wrote: () => tg.setWebhook,
    ok: 200,
  },
];

describe.each(CONNECTION)('CONNECTION — $name', ({ call, wrote, ok }) => {
  it('lets in who holds telegram.connect', async () => {
    await as(CONNECT_HOLDER);
    const res = await call();
    expect(res.status).toBe(ok);
    expect(wrote()).toHaveBeenCalledTimes(1);
  });

  it('NEGATIVE: refuses who holds the day\'s message key only — 403, and nothing is written', async () => {
    await as(DAILY_HOLDER);
    const res = await call();
    expect(res.status).toBe(403);
    expect(wrote()).not.toHaveBeenCalled();
  });

  it('NEGATIVE: refuses who only sees the orders', async () => {
    await as(['telegram.view']);
    expect((await call()).status).toBe(403);
    expect(wrote()).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a «منع» on telegram.connect beats a role that carries it', async () => {
    await as(CONNECT_HOLDER, ['telegram.connect']);
    expect((await call()).status).toBe(403);
    expect(wrote()).not.toHaveBeenCalled();
  });
});

/** The day's work — these answer to telegram.manage exactly as before (a 404 is past the gate: no such message). */
const DAILY = [
  { name: 'POST /api/telegram/messages/[id]/retry (إعادة المعالجة)', call: () => retry.POST(req(), id('m1')) },
  { name: 'POST /api/telegram/messages/[id]/ignore (تجاهل)', call: () => ignore.POST(req(), id('m1')) },
  { name: 'POST /api/telegram/messages/[id]/correct (تعديل وترحيل)', call: () => correct.POST(req({}), id('m1')) },
];

describe.each(DAILY)('DAILY — $name', ({ call }) => {
  it('lets in who holds telegram.manage alone, without the connection key', async () => {
    await as(DAILY_HOLDER);
    const res = await call();
    expect(res.status).toBe(404);
    expect(db.telegramMessage.findFirst).toHaveBeenCalledTimes(1);
  });

  it('NEGATIVE: still refuses who only sees the orders', async () => {
    await as(['telegram.view']);
    expect((await call()).status).toBe(403);
    expect(db.telegramMessage.findFirst).not.toHaveBeenCalled();
  });
});

describe('the apps catalogue asks the same key to configure Telegram', () => {
  it('«تلجرام» in the app store greys out for the day\'s key and opens for the connection key', async () => {
    const { builtInApps } = await import('@/lib/apps/registry');
    const app = builtInApps(db as never).find((a) => a.code === 'TELEGRAM')!;
    expect(app.settingsPath).toBe('/settings/links');
    expect(can(await person(DAILY_HOLDER), app.permission)).toBe(false);
    expect(can(await person(CONNECT_HOLDER), app.permission)).toBe(true);
  });
});

describe('the bot\'s state is read on telegram.view, and no answer carries a secret', () => {
  it('GET /api/telegram/status answers who only sees the orders — the orders screen\'s «البوت متصل» stays', async () => {
    await as(['telegram.view']);
    const res = await status.GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.botConfigured).toBe(true);
    expect(body.botApiOk).toBe(true);
  });

  it('neither the token nor the webhook secret is in the status answer or in the webhook answer, for the owner either', async () => {
    current.user = await person([], [], 'SUPER_ADMIN');
    const statusText = await (await status.GET()).text();
    const setupText = await (await webhook.POST()).text();
    for (const text of [statusText, setupText]) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain('AAFakeToken');
    }
    // The secret goes to Telegram and only there.
    expect(tg.setWebhook).toHaveBeenCalledWith('https://oms.example.test/api/webhooks/telegram', SECRET);
  });
});

describe('who holds telegram.connect on the day — measured with the real engine', () => {
  it('the catalog offers it, behind the message key, which sits behind the orders screen', () => {
    expect(catalogItem('telegram.connect')?.requires).toBe('telegram.manage');
    expect(catalogItem('telegram.manage')?.requires).toBe('telegram.view');
  });

  it('SUPER_ADMIN holds it — its full access is every key', async () => {
    const owner = await person([], [], 'SUPER_ADMIN');
    expect(can(owner, 'telegram.connect')).toBe(true);
  });

  it('NO legacy role holds it through the in-code fallback, though COMPANY_ADMIN keeps telegram.manage', async () => {
    const holders: string[] = [];
    for (const role of Object.keys(ROLE_PERMISSIONS) as UserRole[]) {
      if (role === 'SUPER_ADMIN') continue;
      const base = { id: 'u-' + role, role, roleId: null, status: 'ACTIVE', companyId: 'c1' } as unknown as SessionUser;
      // No template rows and no roleId → the legacy fallback, which is where an implicit grant would hide.
      const u = attachGrants(base, await computeEffectiveGrants(base as never, { roleRows: async () => [], overrideRows: async () => [] }));
      if (can(u, 'telegram.connect')) holders.push(role);
      if (role === 'COMPANY_ADMIN') expect(can(u, 'telegram.manage'), 'COMPANY_ADMIN يحتفظ بشغل الرسائل').toBe(true);
    }
    expect(holders).toEqual([]);
  });

  it('NO role template as the migrations left it holds it — the COMPANY_ADMIN template keeps the messages and loses the connection', async () => {
    // The 12/09 migration gave telegram.manage to every role holding settings.edit; nothing gives telegram.connect.
    const template = await person(['settings.view', 'settings.edit', 'orders.view', 'telegram.view', 'telegram.manage'], [], 'COMPANY_ADMIN');
    expect(can(template, 'telegram.manage')).toBe(true);
    expect(can(template, 'telegram.connect')).toBe(false);
  });

  it('nothing in the migrations, the seed or the engine names the new key', async () => {
    const { readdirSync, readFileSync, existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const root = process.cwd();
    const dir = join(root, 'prisma', 'migrations');
    const named: string[] = [];
    for (const m of readdirSync(dir)) {
      for (const f of ['migration.sql', 'rollback.sql']) {
        const p = join(dir, m, f);
        if (existsSync(p) && readFileSync(p, 'utf8').includes('telegram.connect')) named.push(`${m}/${f}`);
      }
    }
    for (const f of ['prisma/seed.ts', 'src/lib/permissions-core.ts', 'src/types/auth.ts', 'src/lib/permission-aliases.ts']) {
      if (readFileSync(join(root, f), 'utf8').includes('telegram.connect')) named.push(f);
    }
    expect(named).toEqual([]);
  });
});
