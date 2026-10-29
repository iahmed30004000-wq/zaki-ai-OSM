import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { repoFile, stripComments } from './guard-source';

const { db } = vi.hoisted(() => ({
  db: {
    company: { findUnique: vi.fn(), update: vi.fn() },
    systemSetting: { findUnique: vi.fn(), update: vi.fn(), delete: vi.fn() },
    user: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
}));
vi.mock('./db', () => ({ db }));

import {
  AiEndpointMissing,
  AiNotConfigured,
  AiNotLocal,
  aiChat,
  aiSettings,
  describeRoute,
  saveAiSettings,
  saveSystemAi,
  systemAi,
} from './ai-provider';
import { encryptSecret } from './secrets';

/**
 * «خادم متوافق مع OpenAI» — A SERVER ON THE INTERNET, ALWAYS AN OUTSIDE PARTY.
 *
 * Three things have to hold, and each case here is about one of them:
 *   the key never comes back out, and never goes anywhere but the address it
 *   was issued for;
 *   the address is judged again at the call, not only when it was saved;
 *   and a customer never reaches it — there is no switch that makes it «ours».
 *
 * Every fake key carries `test-` ON PURPOSE: `scan:secrets` reads that word
 * as «this one is fake».
 */

const SECRET = 'a'.repeat(64);
const original = process.env.APP_ENCRYPTION_KEY;
const URL1 = 'https://models.example.com/v1';
const URL2 = 'https://other.example.org/v1';
const KEY1 = 'sk-test-COMPAT-LEAKMARKER-0001';

const storedSystem = () => JSON.parse(db.systemSetting.update.mock.calls.at(-1)![0].data.value);
const withSystem = (value: unknown) =>
  db.systemSetting.findUnique.mockResolvedValue({
    value: JSON.stringify(value),
    updatedAt: new Date('2026-10-29T10:00:00Z'),
    updatedById: 'u1',
  });
const withCompany = (ai: unknown) =>
  db.company.findUnique.mockResolvedValue({ settings: JSON.stringify({ ai }) });

/** A system document with a compatible server fully configured. */
const configured = (over: Record<string, unknown> = {}) => ({
  provider: 'OPENAI_COMPATIBLE',
  compat: { baseUrl: URL1, model: 'glm-4.6' },
  keys: { OPENAI_COMPATIBLE: { enc: encryptSecret(KEY1), at: '2026-10-29T10:00:00Z', url: URL1 } },
  ...over,
});

const fetchMock = vi.fn();
const lastCall = () => fetchMock.mock.calls.at(-1) as [string, RequestInit];
const ok = (content: string) => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.APP_ENCRYPTION_KEY = SECRET;
  delete process.env.OPENROUTER_API_KEY;
  db.systemSetting.findUnique.mockResolvedValue(null);
  db.systemSetting.update.mockResolvedValue({});
  db.company.findUnique.mockResolvedValue({ settings: null });
  db.company.update.mockResolvedValue({});
  db.user.findUnique.mockResolvedValue({ name: 'المالك' });
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn({
      $executeRaw: async () => 1,
      // One mock serves both row locks: the installation's `value` and a
      // company's `settings` come back on the same row.
      $queryRaw: async () => {
        const row = (await db.systemSetting.findUnique()) as { value: string } | null;
        const company = (await db.company.findUnique()) as { settings: string | null } | null;
        return [{ value: row ? row.value : '{}', settings: company?.settings ?? null }];
      },
      systemSetting: { update: db.systemSetting.update, delete: db.systemSetting.delete },
      company: { update: db.company.update },
    })
  );
  fetchMock.mockResolvedValue(ok('ok'));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  if (original === undefined) delete process.env.APP_ENCRYPTION_KEY;
  else process.env.APP_ENCRYPTION_KEY = original;
  vi.unstubAllGlobals();
});

describe('saving the address, the name and the key', () => {
  it('encrypts the key, binds it to the address, and stores no hint of it', async () => {
    await saveSystemAi({
      providerKeys: { OPENAI_COMPATIBLE: KEY1 },
      compatBaseUrl: URL1,
      compatModel: 'glm-4.6',
    });
    const raw = db.systemSetting.update.mock.calls.at(-1)![0].data.value;
    expect(raw).not.toContain('LEAKMARKER');
    expect(raw).not.toContain('hint');
    const doc = storedSystem();
    expect(doc.keys.OPENAI_COMPATIBLE.enc).toMatch(/^v1:/);
    expect(doc.keys.OPENAI_COMPATIBLE.url).toBe(URL1);
    expect(doc.compat).toEqual({ baseUrl: URL1, model: 'glm-4.6' });
  });

  it('reads back the host and the name — and nothing of the key', async () => {
    await saveSystemAi({ providerKeys: { OPENAI_COMPATIBLE: KEY1 }, compatBaseUrl: URL1, compatModel: 'glm-4.6' });
    withSystem(storedSystem());
    const read = await systemAi();
    expect(read.compat).toEqual({ baseUrl: URL1, host: 'models.example.com', model: 'glm-4.6' });
    expect(read.providerKeys.OPENAI_COMPATIBLE.configured).toBe(true);
    const body = JSON.stringify(read);
    expect(body).not.toContain('LEAKMARKER');
    expect(body).not.toContain('v1:');
    expect(body).not.toContain('•');
  });

  it('REFUSES with no encryption key, before any row is touched', async () => {
    delete process.env.APP_ENCRYPTION_KEY;
    await expect(
      saveSystemAi({ providerKeys: { OPENAI_COMPATIBLE: KEY1 }, compatBaseUrl: URL1, compatModel: 'glm-4.6' })
    ).rejects.toThrow('ENCRYPTION_KEY_MISSING');
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.systemSetting.update).not.toHaveBeenCalled();
  });

  it('REFUSES a key with no address to be bound to, and writes nothing', async () => {
    await expect(saveSystemAi({ providerKeys: { OPENAI_COMPATIBLE: KEY1 } })).rejects.toThrow('COMPAT_ENDPOINT_REQUIRED');
    expect(db.systemSetting.update).not.toHaveBeenCalled();
  });

  it('a different address DELETES the key kept for the old one', async () => {
    withSystem(configured());
    await saveSystemAi({ compatBaseUrl: URL2 });
    const doc = storedSystem();
    expect(doc.compat.baseUrl).toBe(URL2);
    expect(doc.keys).toBeUndefined();
    withSystem(doc);
    expect((await systemAi()).providerKeys.OPENAI_COMPATIBLE.configured).toBe(false);
  });

  it('…and the very next call has no key to send — fetch is never called', async () => {
    withSystem(configured());
    await saveSystemAi({ compatBaseUrl: URL2 });
    withSystem(storedSystem());
    await expect(aiChat({ companyId: 'c1', system: 's', user: 'u' })).rejects.toBeInstanceOf(AiNotConfigured);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a new key arriving WITH the new address is bound to the new address', async () => {
    withSystem(configured());
    await saveSystemAi({ compatBaseUrl: URL2, providerKeys: { OPENAI_COMPATIBLE: 'sk-test-COMPAT-LEAKMARKER-0002' } });
    const doc = storedSystem();
    expect(doc.keys.OPENAI_COMPATIBLE.url).toBe(URL2);
    withSystem(doc);
    await aiChat({ companyId: 'c1', system: 's', user: 'u' });
    const [url, init] = lastCall();
    expect(url).toBe('https://other.example.org/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test-COMPAT-LEAKMARKER-0002');
  });

  it('clearing the address removes the server, the model AND the key', async () => {
    withSystem(configured());
    await saveSystemAi({ compatBaseUrl: null });
    const doc = storedSystem();
    expect(doc.compat).toBeUndefined();
    expect(doc.keys).toBeUndefined();
  });

  it('…and setting an address afterwards does not bring the old key back', async () => {
    withSystem(configured());
    await saveSystemAi({ compatBaseUrl: null });
    withSystem(storedSystem());
    await saveSystemAi({ compatBaseUrl: URL1, compatModel: 'glm-4.6' });
    withSystem(storedSystem());
    expect((await systemAi()).providerKeys.OPENAI_COMPATIBLE.configured).toBe(false);
    await expect(aiChat({ companyId: 'c1', system: 's', user: 'u' })).rejects.toBeInstanceOf(AiNotConfigured);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('saving the same address again keeps the key', async () => {
    withSystem(configured());
    await saveSystemAi({ compatBaseUrl: URL1, compatModel: 'glm-4.7' });
    const doc = storedSystem();
    expect(doc.keys.OPENAI_COMPATIBLE.url).toBe(URL1);
    expect(doc.compat.model).toBe('glm-4.7');
  });

  it('a company never holds one: a key sent through the company door is dropped', async () => {
    await saveAiSettings('c1', { providerKeys: { OPENAI_COMPATIBLE: KEY1 } });
    const raw = db.company.update.mock.calls.at(-1)![0].data.settings;
    expect(raw).not.toContain('OPENAI_COMPATIBLE');
    expect(raw).not.toContain('LEAKMARKER');
  });
});

describe('routing a call to the compatible server', () => {
  it('posts to <address>/chat/completions with the Bearer key, the saved name, no redirects and a timeout', async () => {
    withSystem(configured());
    await aiChat({ companyId: 'c1', system: 's', user: 'u' });
    const [url, init] = lastCall();
    expect(url).toBe('https://models.example.com/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY1}`);
    expect(JSON.parse(init.body as string).model).toBe('glm-4.6');
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeTruthy();
  });

  it('no other vendor gets redirect: "error" — it is this one’s rule', async () => {
    withSystem({ provider: 'OPENAI', keys: { OPENAI: { enc: encryptSecret('sk-test-openai') } } });
    await aiChat({ companyId: 'c1', system: 's', user: 'u' });
    expect(lastCall()[1].redirect).toBeUndefined();
  });

  it('a company that chose it uses it, and an assistant’s own model beats the saved one', async () => {
    withSystem(configured({ provider: 'OPENROUTER' }));
    withCompany({ provider: 'OPENAI_COMPATIBLE', assistants: { advisor: { model: 'glm-4.5-air' } } });
    await aiChat({ companyId: 'c1', system: 's', user: 'u', job: 'advisor' });
    expect(lastCall()[0]).toBe('https://models.example.com/v1/chat/completions');
    expect(JSON.parse(lastCall()[1].body as string).model).toBe('glm-4.5-air');
  });

  it('the model a company stamped for ANOTHER vendor is ignored for this one', async () => {
    withSystem(configured());
    withCompany({ provider: 'OPENAI_COMPATIBLE', model: 'gpt-4o' });
    await aiChat({ companyId: 'c1', system: 's', user: 'u' });
    expect(JSON.parse(lastCall()[1].body as string).model).toBe('glm-4.6');
  });

  it('describing the route gives the host and the name — never the address in full, never the key', async () => {
    withSystem(configured({ compat: { baseUrl: 'https://models.example.com/v1/team', model: 'glm-4.6' }, keys: { OPENAI_COMPATIBLE: { enc: encryptSecret(KEY1), url: 'https://models.example.com/v1/team' } } }));
    const d = await describeRoute('c1');
    expect(d).toEqual({ provider: 'OPENAI_COMPATIBLE', model: 'glm-4.6', keyFrom: 'system', baseUrl: 'models.example.com' });
    expect(JSON.stringify(d)).not.toContain('LEAKMARKER');
  });
});

describe('it is an outside party — a customer never reaches it (fetch is NEVER called)', () => {
  beforeEach(() => withSystem(configured()));

  it('localOnly is refused', async () => {
    await expect(aiChat({ companyId: 'c1', system: 's', user: 'u', localOnly: true })).rejects.toBeInstanceOf(AiNotLocal);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the order intake assistant is refused, and the confirmation assistant unless the person was taken out', async () => {
    await expect(aiChat({ companyId: 'c1', user: 'u', job: 'order_intake' })).rejects.toBeInstanceOf(AiNotLocal);
    await expect(aiChat({ companyId: 'c1', user: 'u', job: 'confirmation' })).rejects.toBeInstanceOf(AiNotLocal);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('and nothing that is merely written into the document makes it ours', async () => {
    // A declaration of «this is my own server» exists nowhere in this code. A
    // hand-edited document that carries one changes nothing.
    withSystem(configured({ compat: { baseUrl: URL1, model: 'glm-4.6', ownServer: { url: URL1, at: 'x', by: 'u1' } }, ownServer: true }));
    await expect(aiChat({ companyId: 'c1', system: 's', user: 'u', localOnly: true })).rejects.toBeInstanceOf(AiNotLocal);
    await expect(aiChat({ companyId: 'c1', user: 'u', job: 'order_intake' })).rejects.toBeInstanceOf(AiNotLocal);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('and neither does AI_LOCAL_ALLOWED_HOSTS naming its host', async () => {
    process.env.AI_LOCAL_ALLOWED_HOSTS = 'models.example.com';
    try {
      await expect(aiChat({ companyId: 'c1', system: 's', user: 'u', localOnly: true })).rejects.toBeInstanceOf(AiNotLocal);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      delete process.env.AI_LOCAL_ALLOWED_HOSTS;
    }
  });
});

describe('the address and the key are judged again at the call (fetch is NEVER called)', () => {
  it('an address that is not https, written straight into the document', async () => {
    withSystem(configured({ compat: { baseUrl: 'http://models.example.com/v1', model: 'glm-4.6' } }));
    await expect(aiChat({ companyId: 'c1', system: 's', user: 'u' })).rejects.toBeInstanceOf(AiEndpointMissing);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('an address that is an internal one, written straight into the document', async () => {
    for (const bad of ['https://169.254.169.254/v1', 'https://127.0.0.1/v1', 'https://localhost/v1', 'https://[::1]/v1', 'https://0x7f000001/v1', 'https://2130706433/v1', 'https://user:pass@models.example.com/v1']) {
      withSystem(configured({ compat: { baseUrl: bad, model: 'glm-4.6' } }));
      await expect(aiChat({ companyId: 'c1', system: 's', user: 'u' }), bad).rejects.toBeInstanceOf(AiEndpointMissing);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('no key at all', async () => {
    withSystem(configured({ keys: undefined }));
    await expect(aiChat({ companyId: 'c1', system: 's', user: 'u' })).rejects.toBeInstanceOf(AiNotConfigured);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a key bound to a DIFFERENT address than the saved one (a hand-edited document)', async () => {
    withSystem(configured({ keys: { OPENAI_COMPATIBLE: { enc: encryptSecret(KEY1), url: URL2 } } }));
    await expect(aiChat({ companyId: 'c1', system: 's', user: 'u' })).rejects.toBeInstanceOf(AiNotConfigured);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a key with no address recorded at all (the shape every other vendor’s key has)', async () => {
    withSystem(configured({ keys: { OPENAI_COMPATIBLE: { enc: encryptSecret(KEY1) } } }));
    await expect(aiChat({ companyId: 'c1', system: 's', user: 'u' })).rejects.toBeInstanceOf(AiNotConfigured);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the OpenRouter key in the environment is not a fallback for it', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test-env-key';
    withSystem(configured({ keys: undefined }));
    await expect(aiChat({ companyId: 'c1', system: 's', user: 'u' })).rejects.toBeInstanceOf(AiNotConfigured);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the company’s legacy single key is never sent to it', async () => {
    withSystem(configured({ keys: undefined }));
    withCompany({ provider: 'OPENAI_COMPATIBLE', apiKeyEncrypted: encryptSecret('sk-test-legacy-0003') });
    await expect(aiChat({ companyId: 'c1', system: 's', user: 'u' })).rejects.toBeInstanceOf(AiNotConfigured);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('nor a key a company stored under its name (not that any screen writes one)', async () => {
    withSystem(configured({ keys: undefined }));
    withCompany({ provider: 'OPENAI_COMPATIBLE', keys: { OPENAI_COMPATIBLE: { enc: encryptSecret('sk-test-company-0004') } } });
    await expect(aiChat({ companyId: 'c1', system: 's', user: 'u' })).rejects.toBeInstanceOf(AiNotConfigured);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the screen’s answer to «is there a key?»', () => {
  it('a company on it never reports a company key', async () => {
    withCompany({ provider: 'OPENAI_COMPATIBLE', apiKeyEncrypted: encryptSecret('sk-test-legacy-0003') });
    const s = await aiSettings('c1');
    expect(s.hasKey).toBe(false);
    expect(s.providerKeys.OPENAI_COMPATIBLE).toBe(false);
  });

  it('RV37: a local model needs no key, so it is never reported as keyless — even beside an OpenRouter env key', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test-env-key';
    withCompany({ provider: 'LOCAL' });
    expect((await aiSettings('c1')).hasKey).toBe(true);
    delete process.env.OPENROUTER_API_KEY;
    expect((await aiSettings('c1')).hasKey).toBe(true);
  });

  it('RV37: the environment key counts for OpenRouter only', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test-env-key';
    withCompany({ provider: 'ANTHROPIC' });
    expect((await aiSettings('c1')).hasKey).toBe(false);
    withCompany({ provider: 'OPENROUTER' });
    expect((await aiSettings('c1')).hasKey).toBe(true);
  });
});

describe('the answer', () => {
  it('a leading reasoning block is removed from the compatible server’s answer', async () => {
    withSystem(configured());
    fetchMock.mockResolvedValue(ok('<think>let me see\nthe order…</think>\n\n{"a":1}'));
    const text = await aiChat({ companyId: 'c1', system: 's', user: 'u', json: true });
    expect(text).toBe('{"a":1}');
    expect(() => JSON.parse(text)).not.toThrow();
  });

  it('a gateway that returns the content as an array of parts is handed back untouched, not crashed on', async () => {
    withSystem(configured());
    const parts = [{ type: 'text', text: '<think>x</think>{"a":1}' }];
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: parts } }] }) });
    await expect(aiChat({ companyId: 'c1', system: 's', user: 'u' })).resolves.toBe(parts);
  });

  it('the same content from OpenAI is returned unchanged', async () => {
    withSystem({ provider: 'OPENAI', keys: { OPENAI: { enc: encryptSecret('sk-test-openai') } } });
    fetchMock.mockResolvedValue(ok('<think>x</think>{"a":1}'));
    expect(await aiChat({ companyId: 'c1', system: 's', user: 'u' })).toBe('<think>x</think>{"a":1}');
  });
});

describe('the shape of the thing', () => {
  it('the two guards still say «not LOCAL» and nothing else — no declaration exists', () => {
    const src = stripComments(repoFile('src/lib/ai-provider.ts'));
    expect(src).toMatch(/req\.localOnly && route\.provider !== 'LOCAL'\)/);
    expect(src).toMatch(/!req\.piiSafe && route\.provider !== 'LOCAL' && req\.job/);
    expect(src).not.toMatch(/ownServer/);
    const confirmation = stripComments(repoFile('src/app/api/ai/confirmation/route.ts'));
    expect(confirmation).toMatch(/const local = route\.provider === 'LOCAL';/);
  });

  it('the address is validated by a function that takes no allowlist', () => {
    const route = stripComments(repoFile('src/app/api/settings/ai/system/route.ts'));
    expect(route).toMatch(/parseCompatEndpoint\(parsed\.data\.compatBaseUrl\)/);
    expect(route).not.toMatch(/parseCompatEndpoint\([^)]*allowedHosts/);
    const provider = stripComments(repoFile('src/lib/ai-provider.ts'));
    expect(provider).not.toMatch(/parseCompatEndpoint\([^)]*allowedHosts/);
  });

  it('the redirect rule sits on the compatible server’s fetch', () => {
    const src = stripComments(repoFile('src/lib/ai-provider.ts'));
    expect(src).toMatch(/route\.provider === 'OPENAI_COMPATIBLE' \? \{ redirect: 'error' as const \}/);
  });
});
