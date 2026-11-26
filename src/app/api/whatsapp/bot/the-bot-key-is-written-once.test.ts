import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE BOT'S SETTINGS DOOR — read with `whatsapp.view`, written with `whatsapp.manage`, and the model's key written once.
 *
 * The database is a fake row; the sealing is the real `secrets.ts` with a test key. Held:
 *  · the key is sealed when saved, and no answer ever carries it or its seal — only its last four characters;
 *  · the audit row names the fields that changed and nothing they hold;
 *  · an address that is not a public https name is refused (the AI screen's own rule), before anything is saved;
 *  · each door asks the key it should.
 */

const h = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  db: {
    whatsAppBotSettings: { findUnique: vi.fn(), upsert: vi.fn() },
    product: { findMany: vi.fn() },
  },
  asked: [] as string[],
  audit: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ db: h.db }));
vi.mock('@/lib/audit', () => ({ logAudit: h.audit }));
vi.mock('@/lib/auth', () => ({
  requirePermission: async (p: string) => {
    h.asked.push(p);
    return { id: 'u1', role: 'COMPANY_ADMIN', companyId: 'co1' };
  },
  tenantOf: async () => ({ companyId: 'co1' }),
}));
vi.mock('@/lib/authorization', () => ({ can: () => true }));

process.env.APP_ENCRYPTION_KEY = 'a'.repeat(64);

import { GET, PUT } from './route';

const KEY = 'test-model-key-ABCD';
const put = (body: unknown) => PUT(new Request('http://x/api/whatsapp/bot', { method: 'PUT', body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  h.asked = [];
  h.row = null;
  h.db.whatsAppBotSettings.findUnique.mockImplementation(async () => h.row);
  h.db.whatsAppBotSettings.upsert.mockImplementation(async ({ create, update }: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
    h.row = { ...(h.row ?? create), ...update };
    return h.row;
  });
  h.db.product.findMany.mockResolvedValue([{ id: 'p1', name: 'كريم' }]);
});

describe('the key', () => {
  it('is sealed when saved, and the answer shows only its last four characters', async () => {
    const res = await put({ apiKey: KEY, enabled: true });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain(KEY);
    expect(String(h.row?.apiKeyEncrypted)).toMatch(/^v1:/);
    expect(String(h.row?.apiKeyEncrypted)).not.toContain(KEY);
    const body = JSON.parse(text);
    expect(body.settings).toMatchObject({ keySet: true, keyHint: 'ABCD', active: true, enabled: true });
    expect(text).not.toContain('apiKeyEncrypted');
  });

  it('NEGATIVE: the read door never carries it, nor its seal', async () => {
    await put({ apiKey: KEY });
    const text = await (await GET()).text();
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(String(h.row?.apiKeyEncrypted));
    expect(JSON.parse(text).settings.keyHint).toBe('ABCD');
  });

  it('NEGATIVE: the audit row names the fields, never the key or the owner’s words', async () => {
    await put({ apiKey: KEY, persona: 'سرّ المتجر' });
    const logged = JSON.stringify(h.audit.mock.calls);
    expect(logged).toContain('apiKey');
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain('سرّ المتجر');
  });
});

describe('the address', () => {
  it.each(['http://glm.erv.zakiai.io/v1', 'https://127.0.0.1/v1', 'https://localhost/v1', 'https://169.254.169.254/'])('NEGATIVE: %s is refused and nothing is saved', async (baseUrl) => {
    const res = await put({ baseUrl });
    expect(res.status).toBe(400);
    expect(h.db.whatsAppBotSettings.upsert).not.toHaveBeenCalled();
  });

  it('Sarah’s server is the default and is accepted', async () => {
    const res = await put({ baseUrl: 'https://glm.erv.zakiai.io/v1', name: 'ليلى' });
    expect(res.status).toBe(200);
    expect((await res.json()).settings).toMatchObject({ baseUrl: 'https://glm.erv.zakiai.io/v1', name: 'ليلى' });
  });
});

describe('who may', () => {
  it('reads with whatsapp.view and writes with whatsapp.manage', async () => {
    await GET();
    expect(h.asked).toEqual(['whatsapp.view']);
    h.asked = [];
    await put({ name: 'سارة' });
    expect(h.asked).toEqual(['whatsapp.manage']);
  });
});
