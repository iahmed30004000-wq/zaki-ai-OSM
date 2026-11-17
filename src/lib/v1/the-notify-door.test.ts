import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * ONE TELEGRAM GATEWAY — `POST /api/v1/notify` (the media buyer's doors, PR-B, O4).
 *
 * Run with the REAL key guard, the real idempotency module (over an in-memory table) and the real schema; only Telegram itself is a double. What it proves:
 *
 *   · the scope is its own: a key without `notify.send` is refused before anything is read or sent
 *   · «owner», a person and a chat (with a topic) each reach the right chat — and a name this system does not know is 404, never a guess
 *   · the same key sends ONCE for 24 hours; another text under it is 409; a message Telegram refused gives the key back
 *   · a text that looks like a phone number or an address is refused 422 and never sent, never echoed
 * ═══════════════════════════════════════════════════════════════════════
 */

type Record_ = { companyId: string; key: string; requestHash: string; status: number; response: string; createdAt: Date };

const h = vi.hoisted(() => ({
  table: new Map<string, unknown>(),
  db: {
    systemToken: { findUnique: vi.fn(), update: vi.fn() },
    idempotencyRecord: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn(), deleteMany: vi.fn() },
  },
  rateLimit: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db: h.db }));
vi.mock('@/lib/rate-limit', () => ({ rateLimit: (...a: unknown[]) => h.rateLimit(...a) }));
vi.mock('@/lib/telegram/cloud-api', () => ({ sendMessage: (...a: unknown[]) => h.sendMessage(...a) }));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validate } from '../apps/contract';
import { Prisma } from '@prisma/client';
import { POST as postNotify } from '@/app/api/v1/notify/route';
import { MEDIABUYER_SCOPES, REPLIES_SCOPES } from './system-token';
import { containsCustomerData, NOTIFY_KEY_HOURS } from './notify';
import { peopleChats, resolveTelegramTarget } from '../telegram/targets';

const tokenRow = (scopes: string[]) => ({
  id: 'tok_mb', companyId: 'c1', system: 'mediabuyer', scopes: JSON.stringify(scopes), rateLimitPerMin: 60,
  expiresAt: new Date(Date.now() + 86_400_000), revokedAt: null, lastUsedAt: new Date(),
});

const post = (body: unknown) =>
  new Request('https://oms.test/api/v1/notify', {
    method: 'POST',
    headers: { authorization: 'Bearer zk1_test', 'x-request-id': 'mb_n1', 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const OK = { target: 'owner', text: 'طلب جديد: هوكات جديدة — TRF01 / JOB-12', key: 'mb-vr-vr_example-asked' };

const ENV = { ...process.env };
beforeEach(() => {
  vi.clearAllMocks();
  h.table.clear();
  process.env.TELEGRAM_OWNER_CHAT_ID = '111222333';
  process.env.TELEGRAM_PEOPLE_CHATS = 'sara:444, ahmad:-100555';
  h.rateLimit.mockReturnValue({ allowed: true, remaining: 59, retryAfterSec: 0 });
  h.db.systemToken.update.mockResolvedValue({});
  h.db.systemToken.findUnique.mockResolvedValue(tokenRow(MEDIABUYER_SCOPES));
  // an in-memory idempotency table, with the unique key of the real one
  h.db.idempotencyRecord.create.mockImplementation(async ({ data }: { data: Record_ }) => {
    const k = `${data.companyId}|${data.key}`;
    if (h.table.has(k)) throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' });
    h.table.set(k, { ...data, createdAt: new Date() });
    return {};
  });
  h.db.idempotencyRecord.findUnique.mockImplementation(async ({ where }: { where: { companyId_key: { companyId: string; key: string } } }) =>
    h.table.get(`${where.companyId_key.companyId}|${where.companyId_key.key}`) ?? null
  );
  h.db.idempotencyRecord.update.mockImplementation(async ({ where, data }: { where: { companyId_key: { companyId: string; key: string } }; data: Partial<Record_> }) => {
    const k = `${where.companyId_key.companyId}|${where.companyId_key.key}`;
    h.table.set(k, { ...(h.table.get(k) as object), ...data });
    return {};
  });
  h.db.idempotencyRecord.deleteMany.mockImplementation(async ({ where }: { where: { companyId: string; key: string; status?: number; createdAt?: { lt: Date } } }) => {
    const k = `${where.companyId}|${where.key}`;
    const row = h.table.get(k) as Record_ | undefined;
    if (row && (where.status === undefined || row.status === where.status) && (!where.createdAt || row.createdAt < where.createdAt.lt)) h.table.delete(k);
    return {};
  });
  h.sendMessage.mockResolvedValue({ ok: true, result: { message_id: 4821 } });
});

afterEach(() => {
  process.env = { ...ENV };
});

describe('the scope is its own', () => {
  it('a key without notify.send is refused, and nothing is read or sent', async () => {
    h.db.systemToken.findUnique.mockResolvedValue(tokenRow(['orders.attribution.read', 'ads.spend.read', 'products.read']));
    const res = await postNotify(post(OK));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('SCOPE_MISSING');
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(h.db.idempotencyRecord.create).not.toHaveBeenCalled();
  });

  it('the replies system never has it, and a new media-buyer key starts with it', async () => {
    expect(REPLIES_SCOPES).not.toContain('notify.send');
    expect(MEDIABUYER_SCOPES).toContain('notify.send');
    h.db.systemToken.findUnique.mockResolvedValue(tokenRow([...REPLIES_SCOPES]));
    expect((await postNotify(post(OK))).status).toBe(403);
  });

  it('a revoked key is refused on the next call', async () => {
    h.db.systemToken.findUnique.mockResolvedValue({ ...tokenRow(MEDIABUYER_SCOPES), revokedAt: new Date() });
    expect((await postNotify(post(OK))).status).toBe(401);
    expect(h.sendMessage).not.toHaveBeenCalled();
  });
});

describe('the audience', () => {
  it('«owner» reaches the owner’s chat, and the answer is the contract’s', async () => {
    const res = await postNotify(post(OK));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, delivered: true, duplicate: false, message_id: 4821 });
    expect(h.sendMessage).toHaveBeenCalledWith('111222333', OK.text, undefined, undefined);
  });

  it('a person reaches their chat by the short key', async () => {
    await postNotify(post({ ...OK, target: { person: 'sara' } }));
    expect(h.sendMessage).toHaveBeenCalledWith('444', OK.text, undefined, undefined);
    expect(peopleChats().get('ahmad')).toBe('-100555');
  });

  it('a chat and a topic of a forum group are passed through', async () => {
    await postNotify(post({ ...OK, target: { chat_id: '-1001234567890', topic_id: 1001 }, key: 'mb-chat-key-1' }));
    expect(h.sendMessage).toHaveBeenCalledWith('-1001234567890', OK.text, undefined, 1001);
    await postNotify(post({ ...OK, target: { chat_id: -1009876, topic_id: 7 }, key: 'mb-chat-key-2' }));
    expect(h.sendMessage).toHaveBeenLastCalledWith('-1009876', OK.text, undefined, 7);
  });

  it('a name this system does not know is 404 TARGET_UNKNOWN — before the key is taken and before anything is sent', async () => {
    for (const target of [{ person: 'nobody' }, 'owner'] as const) {
      if (target === 'owner') delete process.env.TELEGRAM_OWNER_CHAT_ID;
      const res = await postNotify(post({ ...OK, target, key: `mb-unknown-${JSON.stringify(target).length}` }));
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe('TARGET_UNKNOWN');
    }
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(h.db.idempotencyRecord.create).not.toHaveBeenCalled();
  });

  it('a chat id that is not a chat id is refused by the schema, and an unparsable pair in the people list is skipped, never guessed', async () => {
    expect((await postNotify(post({ ...OK, target: { chat_id: 'not-a-chat' } }))).status).toBe(422);
    process.env.TELEGRAM_PEOPLE_CHATS = 'Sara:1, ok:abc, fine:77,, :9';
    expect([...peopleChats().entries()]).toEqual([['fine', '77']]);
    expect(resolveTelegramTarget({ person: 'Sara' })).toBeNull();
  });

  it('the link goes on a line of its own after the text', async () => {
    await postNotify(post({ ...OK, link: 'https://crm.zakiai.io/settings/system' }));
    expect(h.sendMessage).toHaveBeenCalledWith('111222333', `${OK.text}\nhttps://crm.zakiai.io/settings/system`, undefined, undefined);
  });
});

describe('the same key sends once for 24 hours', () => {
  it('a second call with the same key and text sends nothing and says duplicate', async () => {
    await postNotify(post(OK));
    const again = await postNotify(post(OK));
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, delivered: true, duplicate: true, message_id: 4821 });
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('the same key with another text is 409 IDEMPOTENCY_CONFLICT, and nothing is sent', async () => {
    await postNotify(post(OK));
    const res = await postNotify(post({ ...OK, text: 'a different message' }));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('the same key to another target is another request', async () => {
    await postNotify(post(OK));
    expect((await postNotify(post({ ...OK, target: { person: 'sara' } }))).status).toBe(409);
  });

  it('a key older than 24 hours is free again: the old record is swept before the key is taken', async () => {
    await postNotify(post(OK));
    const row = h.table.get('c1|notify:' + OK.key) as Record_;
    row.createdAt = new Date(Date.now() - (NOTIFY_KEY_HOURS + 1) * 3_600_000);
    const res = await postNotify(post(OK));
    expect(res.status).toBe(200);
    expect((await res.json()).duplicate).toBe(false);
    expect(h.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('lives under a notify: prefix, so a key can never meet an order’s', async () => {
    await postNotify(post(OK));
    expect([...h.table.keys()]).toEqual(['c1|notify:' + OK.key]);
  });

  it('is the company’s own: the same key from another company is another key', async () => {
    await postNotify(post(OK));
    h.db.systemToken.findUnique.mockResolvedValue({ ...tokenRow(MEDIABUYER_SCOPES), companyId: 'c2' });
    const res = await postNotify(post(OK));
    expect((await res.json()).duplicate).toBe(false);
    expect(h.sendMessage).toHaveBeenCalledTimes(2);
  });
});

describe('when Telegram does not take it', () => {
  it('502 TELEGRAM_UNAVAILABLE — and the key is given back, so the same key sends on the retry', async () => {
    h.sendMessage.mockResolvedValueOnce({ ok: false, errorCode: 'NETWORK' });
    const res = await postNotify(post(OK));
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe('TELEGRAM_UNAVAILABLE');
    expect(h.table.size).toBe(0);
    const retry = await postNotify(post(OK));
    expect(retry.status).toBe(200);
    expect((await retry.json()).duplicate).toBe(false);
  });

  it('no bot token at all is the same 502, not a crash', async () => {
    h.sendMessage.mockResolvedValueOnce({ ok: false, errorCode: 'NO_TOKEN' });
    expect((await postNotify(post(OK))).status).toBe(502);
  });

  it('a chat the bot is not in is 404 TARGET_UNKNOWN, and the key is given back too', async () => {
    h.sendMessage.mockResolvedValueOnce({ ok: false, errorCode: 'API_ERROR', description: 'Bad Request: chat not found' });
    const res = await postNotify(post({ ...OK, target: { chat_id: '-100999' } }));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('TARGET_UNKNOWN');
    expect(h.table.size).toBe(0);
  });

  it('a double that throws is a 502, never a 500', async () => {
    h.sendMessage.mockRejectedValueOnce(new Error('boom'));
    expect((await postNotify(post(OK))).status).toBe(502);
  });
});

describe('not one byte about a customer', () => {
  const REFUSED = [
    '0936654998',
    '+963 936 654 998',
    '٠٩٣٦٦٥٤٩٩٨',
    '963936654998',
    '093-665-4998',
    '962791234567',
    'call him on 0791234567 today',
    'العنوان: حلب، الجميلية',
    'شارع الجلاء بناية 5',
    'he lives on Main street',
    'التوصيل إلى عنوان التوصيل المسجّل',
  ];
  const ALLOWED = [
    'طلب جديد: هوكات جديدة — TRF01 / JOB-12',
    'الإعلان 120211000000000001 صرف 42.00 USD اليوم',
    'CR00147 وقّفته',
    '5200000 ظهور و130 نقرة',
    'حملة 120210000000000009: تكلفة الطلب 3.25',
    'ROAS 2.4 على TRF01 — ركّز الميزانية',
  ];

  it.each(REFUSED)('refuses %s: 422 CONTAINS_CUSTOMER_DATA, nothing sent, nothing echoed', async (text) => {
    const res = await postNotify(post({ ...OK, text, key: 'mb-privacy-key' }));
    expect(res.status).toBe(422);
    const body = await res.text();
    expect(JSON.parse(body).error.code).toBe('CONTAINS_CUSTOMER_DATA');
    expect(body).not.toContain(text);
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(h.db.idempotencyRecord.create).not.toHaveBeenCalled();
  });

  it.each(ALLOWED)('lets an ad’s own words through: %s', (text) => {
    expect(containsCustomerData(text)).toBe(false);
  });

  it('a link with a phone in it is refused too', async () => {
    const res = await postNotify(post({ ...OK, link: 'https://wa.me/963936654998' }));
    expect(res.status).toBe(422);
    expect(h.sendMessage).not.toHaveBeenCalled();
  });
});

describe('the body', () => {
  it('is checked field by field, strictly: a field too many, a short key, an empty or over-long text are 422 and name only the fields', async () => {
    for (const bad of [
      { ...OK, extra: 1 },
      { ...OK, key: 'short' },
      { ...OK, text: '' },
      { ...OK, text: 'x'.repeat(4097) },
      { text: 'no target', key: 'mb-no-target-key' },
      { ...OK, target: { person: 'Bad Key' } },
    ]) {
      const res = await postNotify(post(bad));
      expect(res.status, JSON.stringify(bad).slice(0, 60)).toBe(422);
      const body = await res.json();
      expect(body.error.code).toBe('VALIDATION_FAILED');
      expect(JSON.stringify(body)).not.toContain('no target');
    }
    expect((await postNotify(post('not json'))).status).toBe(422);
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('4096 characters is the longest text, and exactly that goes through', async () => {
    const res = await postNotify(post({ ...OK, text: 'ا'.repeat(4096), key: 'mb-long-key-1' }));
    expect(res.status).toBe(200);
  });
});

describe('the frozen contract — contracts/oms-mediabuyer.v1', () => {
  type Schema = Record<string, unknown>;
  const DIR = join(process.cwd(), 'contracts', 'oms-mediabuyer.v1');
  const file = (n: string) => JSON.parse(readFileSync(join(DIR, n), 'utf8'));
  const REQ = file('notify-request.schema.json') as Schema;
  const RES = file('notify-response.schema.json') as Schema;

  it('the golden request and response fit their schemas', () => {
    expect(validate(REQ, file('notify-request.example.json'))).toEqual([]);
    expect(validate(RES, file('notify-response.example.json'))).toEqual([]);
  });

  it('and the checker is not vacuous: a field too many, a short key, a wrong type all fail', () => {
    const ok = file('notify-request.example.json');
    expect(validate(REQ, { ...ok, extra: 1 }).length).toBeGreaterThan(0);
    expect(validate(REQ, { ...ok, key: 'short' }).length).toBeGreaterThan(0);
    expect(validate(REQ, { ...ok, text: 5 }).length).toBeGreaterThan(0);
    expect(validate(RES, { ok: true }).length).toBeGreaterThan(0);
    expect(validate(RES, { ok: true, delivered: 'yes' }).length).toBeGreaterThan(0);
  });

  it('the golden request is accepted by the door as it is, and the door’s answer fits the response schema', async () => {
    const res = await postNotify(post(file('notify-request.example.json')));
    expect(res.status).toBe(200);
    expect(validate(RES, await res.json())).toEqual([]);
  });

  it('the schema’s limits are the door’s: 4096 characters, a key of 8 to 120', async () => {
    expect((REQ.properties as Record<string, { maxLength?: number; minLength?: number }>).text.maxLength).toBe(4096);
    const key = (REQ.properties as Record<string, { maxLength?: number; minLength?: number }>).key;
    expect([key.minLength, key.maxLength]).toEqual([8, 120]);
  });
});
