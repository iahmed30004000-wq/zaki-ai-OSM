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

import { AI_PROVIDERS, aiChat, saveSystemAi, systemAi } from './ai-provider';
import { encryptSecret } from './secrets';

/**
 * «المزوّد والمفتاح ... واحفظو للـ System».
 *
 * The accounts are the installation's, not a company's, and the key must
 * leave the process in exactly one direction: in. Every case here is about
 * one of those two facts.
 */

const KEY = 'a'.repeat(64);
const original = process.env.APP_ENCRYPTION_KEY;

/** What the installation row holds after a save. */
const storedSystem = () => JSON.parse(db.systemSetting.update.mock.calls.at(-1)![0].data.value);
const withSystem = (value: unknown) =>
  db.systemSetting.findUnique.mockResolvedValue({
    value: JSON.stringify(value),
    updatedAt: new Date('2026-09-29T10:00:00Z'),
    updatedById: 'u1',
  });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.APP_ENCRYPTION_KEY = KEY;
  delete process.env.OPENROUTER_API_KEY;
  db.systemSetting.findUnique.mockResolvedValue(null);
  db.systemSetting.update.mockResolvedValue({});
  db.company.findUnique.mockResolvedValue({ settings: null });
  db.user.findUnique.mockResolvedValue({ name: 'المالك' });
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn({
      $executeRaw: async () => 1,
      $queryRaw: async () => {
        const row = (await db.systemSetting.findUnique()) as { value: string } | null;
        return row ? [{ value: row.value }] : [{ value: '{}' }];
      },
      systemSetting: { update: db.systemSetting.update, delete: db.systemSetting.delete },
    })
  );
});

afterEach(() => {
  if (original === undefined) delete process.env.APP_ENCRYPTION_KEY;
  else process.env.APP_ENCRYPTION_KEY = original;
  vi.unstubAllGlobals();
});

describe('the installation’s keys', () => {
  it('are encrypted before they are stored — never the plain text', async () => {
    await saveSystemAi({ provider: 'OPENAI', model: 'gpt-4o-mini', providerKeys: { OPENAI: 'sk-secret-value' } });
    const raw = db.systemSetting.update.mock.calls.at(-1)![0].data.value;
    expect(raw).not.toContain('sk-secret-value');
    expect(storedSystem().keys.OPENAI.enc).toMatch(/^v1:/);
  });

  it('and NO hint of one is stored beside it', async () => {
    // A stored fragment is a fragment that leaks later, through some other
    // reader. The courier pattern hints the login and never the password.
    await saveSystemAi({ provider: 'OPENAI', model: 'gpt-4o-mini', providerKeys: { OPENAI: 'sk-secret-value' } });
    const raw = db.systemSetting.update.mock.calls.at(-1)![0].data.value;
    expect(raw).not.toContain('hint');
    expect(raw).not.toContain('lue');
  });

  it('never come back from the reader — not the key, not a fragment', async () => {
    await saveSystemAi({ provider: 'OPENAI', model: 'gpt-4o-mini', providerKeys: { OPENAI: 'sk-secret-value' } });
    withSystem(storedSystem());
    const read = await systemAi();
    const body = JSON.stringify(read);
    expect(body).not.toContain('sk-secret-value');
    expect(body).not.toContain('lue');
    expect(body).not.toContain('v1:');
    expect(body).not.toContain('•');
    // Which vendor holds one, and when it was put there. Nothing else.
    expect(read.providerKeys.OPENAI.configured).toBe(true);
    expect(read.providerKeys.ANTHROPIC.configured).toBe(false);
    expect(read.providerKeys.OPENAI.savedAt).toBeTruthy();
  });

  it('refuse to save rather than store a key in the clear', async () => {
    delete process.env.APP_ENCRYPTION_KEY;
    await expect(
      saveSystemAi({ provider: 'OPENAI', model: 'gpt-4o-mini', providerKeys: { OPENAI: 'sk-x' } })
    ).rejects.toThrow('ENCRYPTION_KEY_MISSING');
    expect(db.systemSetting.update).not.toHaveBeenCalled();
    // BEFORE ANYTHING IS TOUCHED, which is not the same as failing part way
    // through. Without the guard, `encryptSecret` still throws — but only
    // after a row has been inserted and locked.
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('but a save with no key at all is allowed without encryption', async () => {
    // Changing the default model on a box with no encryption key configured
    // is not a secret operation and must not be refused as one.
    delete process.env.APP_ENCRYPTION_KEY;
    await expect(saveSystemAi({ provider: 'OPENAI', model: 'gpt-4o' })).resolves.toBeTruthy();
  });

  it('keep the others when one vendor’s key is set', async () => {
    await saveSystemAi({ provider: 'OPENAI', model: 'gpt-4o-mini', providerKeys: { OPENAI: 'sk-one' } });
    withSystem(storedSystem());
    await saveSystemAi({ provider: 'ANTHROPIC', model: 'claude-sonnet-5', providerKeys: { ANTHROPIC: 'sk-ant-two' } });
    const keys = storedSystem().keys;
    expect(Object.keys(keys).sort()).toEqual(['ANTHROPIC', 'OPENAI']);
  });

  it('and clear only the one asked for', async () => {
    await saveSystemAi({
      provider: 'OPENAI',
      model: 'gpt-4o-mini',
      providerKeys: { OPENAI: 'sk-one', ANTHROPIC: 'sk-ant-two' },
    });
    withSystem(storedSystem());
    await saveSystemAi({ provider: 'OPENAI', model: 'gpt-4o-mini', providerKeys: { OPENAI: null } });
    expect(Object.keys(storedSystem().keys)).toEqual(['ANTHROPIC']);
  });

  it('a vendor this system does not know is dropped, never stored', async () => {
    // A typo would otherwise sit in the document holding a real key under a
    // name nothing ever reads.
    await saveSystemAi({ provider: 'OPENAI', model: 'gpt-4o-mini', providerKeys: { NOTAVENDOR: 'sk-typo' } });
    const raw = db.systemSetting.update.mock.calls.at(-1)![0].data.value;
    expect(raw).not.toContain('sk-typo');
    expect(raw).not.toContain('NOTAVENDOR');
  });

  it('records who last changed the installation’s settings', async () => {
    withSystem({ provider: 'OPENAI', model: 'gpt-4o' });
    const read = await systemAi();
    expect(read.savedBy).toBe('المالك');
    expect(read.savedAt).toBeTruthy();
  });
});

describe('before the migration has run', () => {
  it('reads as "nothing configured" rather than taking the screen down', async () => {
    // Code ships before a migration is applied, and on this project the
    // migration is run by hand. In that window the AI must degrade to
    // unconfigured, not 500.
    const missing = Object.assign(new Error('table does not exist'), { code: 'P2021' });
    db.systemSetting.findUnique.mockRejectedValue(missing);
    const read = await systemAi();
    expect(read.providerKeys.OPENAI.configured).toBe(false);
    expect(read.localBaseUrl).toBeNull();
  });

  it('but any OTHER database error is still thrown, never swallowed', async () => {
    // A connection failure is not the same thing as "nothing is configured".
    db.systemSetting.findUnique.mockRejectedValue(
      Object.assign(new Error('connection refused'), { code: 'P1001' })
    );
    await expect(systemAi()).rejects.toThrow('connection refused');
  });
});

describe('more than one model', () => {
  it('several vendors are configured at once, in one save', async () => {
    // «بحيث أقدر أدخل أكثر من موديل» — not one box behind a dropdown.
    await saveSystemAi({
      provider: 'ANTHROPIC',
      model: 'claude-sonnet-5',
      providerKeys: { OPENAI: 'sk-a', ANTHROPIC: 'sk-ant-b', OPENROUTER: 'sk-or-c' },
    });
    withSystem(storedSystem());
    const read = await systemAi();
    expect(read.providerKeys.OPENAI.configured).toBe(true);
    expect(read.providerKeys.ANTHROPIC.configured).toBe(true);
    expect(read.providerKeys.OPENROUTER.configured).toBe(true);
  });

  it('and the vendor list includes a model the owner runs himself', () => {
    const local = AI_PROVIDERS.find((p) => p.id === 'LOCAL');
    expect(local, 'لا مزوّد محلي').toBeTruthy();
    expect(local!.needsEndpoint).toBe(true);
    expect(local!.keyOptional).toBe(true);
    // The existing guards demand every vendor suggest models of its own.
    expect(local!.models).toContain(local!.defaultModel);
  });
});

describe('routing a call to a local model', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) }));
  });

  it('sends it to the owner’s own server, in the OpenAI shape', async () => {
    withSystem({ provider: 'LOCAL', model: 'llama3.1:8b', localBaseUrl: 'http://localhost:11434' });
    await aiChat({ companyId: 'c1', system: 's', user: 'u' });
    const [url, init] = (globalThis.fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(url).toBe('http://localhost:11434/v1/chat/completions');
    expect(JSON.parse(init.body as string).model).toBe('llama3.1:8b');
  });

  it('and sends NO Authorization header when there is no key', async () => {
    // `Bearer null` is how a server that ignores auth starts refusing.
    withSystem({ provider: 'LOCAL', model: 'llama3.1:8b', localBaseUrl: 'http://localhost:11434' });
    await aiChat({ companyId: 'c1', system: 's', user: 'u' });
    const [, init] = (globalThis.fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('refuses when a local model is chosen and nowhere to send it', async () => {
    withSystem({ provider: 'LOCAL', model: 'llama3.1:8b' });
    await expect(aiChat({ companyId: 'c1', system: 's', user: 'u' })).rejects.toThrow('AI_ENDPOINT_MISSING');
  });

  it('the installation’s KEY wins over a company’s own, for the same vendor', async () => {
    // Both exist and they are different accounts. Taking the company's would
    // bill the wrong person and, on a revoked company key, fail while a
    // working installation key sat unused.
    withSystem({ provider: 'ANTHROPIC', model: 'claude-sonnet-5', keys: { ANTHROPIC: { enc: encryptSecret('sk-ant-INSTALLATION') } } });
    db.company.findUnique.mockResolvedValue({
      settings: JSON.stringify({
        ai: { provider: 'ANTHROPIC', model: 'claude-sonnet-5', keys: { ANTHROPIC: { enc: encryptSecret('sk-ant-COMPANY') } } },
      }),
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ content: [{ text: 'ok' }] }) }));
    await aiChat({ companyId: 'c1', system: 's', user: 'u' });
    const [, init] = (globalThis.fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('sk-ant-INSTALLATION');
  });

  /**
   * ⚠️ THIS RULE WAS REVERSED, AND THE REVERSAL IS THE OWNER'S TO KEEP.
   *
   * It used to read «the installation's vendor wins over a company's own
   * stored one», on the reasoning that a deployment configured before the
   * system card existed keeps answering without anybody re-entering
   * anything.
   *
   * That reasoning holds only for a company that never chose. And the
   * combination of this rule with a second defect is exactly the bug the
   * owner reported: every key save used to stamp `SYSTEM_AI.provider`, so
   * every installation that had ever saved a key had one, and it beat
   * whatever the company picked in «المزوّد». «حطّيت المفتاح وما اشتغل».
   *
   * O8 states the order plainly — «the assistant's own vendor+model → the
   * company's (when it chose one) → the installation default → OPENROUTER»
   * — so the company's explicit choice now wins. A company that never
   * chose still falls through to the installation, which is the whole of
   * what the old reasoning protected.
   *
   * The KEY precedence is NOT reversed: the installation's key still wins
   * for the resolved vendor, because taking the company's would bill the
   * wrong person. See the case above.
   */
  it('a company’s own stored vendor wins over the installation default', async () => {
    withSystem({ provider: 'LOCAL', model: 'llama3.1:8b', localBaseUrl: 'http://localhost:11434' });
    db.company.findUnique.mockResolvedValue({
      settings: JSON.stringify({
        ai: { provider: 'OPENAI', model: 'gpt-4o', keys: { OPENAI: { enc: encryptSecret('sk-COMPANY') } } },
      }),
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) }));
    await aiChat({ companyId: 'c1', system: 's', user: 'u' });
    const [url] = (globalThis.fetch as unknown as { mock: { calls: [string][] } }).mock.calls[0];
    expect(url, 'افتراض التنصيب لسّا بيغلب اختيار الشركة').toContain('api.openai.com');
  });

  it('and a company that never chose still falls through to the installation', async () => {
    // The whole of what the old rule protected: a deployment configured
    // before the system card existed, whose companies never picked
    // anything, keeps answering with nobody re-entering a thing.
    withSystem({ provider: 'LOCAL', model: 'llama3.1:8b', localBaseUrl: 'http://localhost:11434' });
    db.company.findUnique.mockResolvedValue({ settings: JSON.stringify({ ai: { prompts: {} } }) });
    await aiChat({ companyId: 'c1', system: 's', user: 'u' });
    const [url] = (globalThis.fetch as unknown as { mock: { calls: [string][] } }).mock.calls[0];
    expect(url).toBe('http://localhost:11434/v1/chat/completions');
  });
});

/**
 * The rules that are only true if the code still says so.
 */
describe('the shape of the thing', () => {
  it('the daily summary no longer reads a key out of the environment', () => {
    // It used to call OpenRouter itself with OPENROUTER_API_KEY, so a company
    // that had chosen Anthropic and pasted an Anthropic key got a summary
    // from whatever was in the deploy's env — or none at all.
    const src = stripComments(repoFile('src/lib/ai.ts'));
    expect(src).not.toContain('process.env.OPENROUTER_API_KEY');
    expect(src).not.toContain('process.env.OPENROUTER_MODEL');
    expect(src).not.toContain('openrouter.ai/api');
    expect(src).toContain('aiChat(');
  });

  it('every outbound AI call carries a timeout', () => {
    const src = stripComments(repoFile('src/lib/ai-provider/call.ts'));
    // One controller, aborted on a timer, wrapping every vendor branch.
    expect(src).toMatch(/new AbortController\(\)/);
    expect(src).toMatch(/setTimeout\(\(\) => controller\.abort\(\)/);
    const fetches = src.match(/await fetch\(/g) ?? [];
    const signals = src.match(/signal: controller\.signal/g) ?? [];
    expect(signals.length, 'نداءٌ بلا مهلة').toBe(fetches.length);
  });

  it('the system route never returns or logs a key', () => {
    const src = stripComments(repoFile('src/app/api/settings/ai/system/route.ts'));
    // Nothing decrypts here, and nothing hints.
    expect(src).not.toContain('decryptSecret');
    expect(src).not.toContain('secretHint');
    // The audit records which vendors moved, never the values.
    expect(src).toMatch(/keysTouched: Object\.keys/);
  });

  it('and the address of a local model is checked before it is stored', () => {
    const src = stripComments(repoFile('src/app/api/settings/ai/system/route.ts'));
    expect(src).toMatch(/parseLocalEndpoint\(/);
    // With the operator's allowlist, not an empty one — otherwise the escape
    // hatch silently does nothing.
    expect(src).toMatch(/parseLocalEndpoint\(parsed\.data\.localBaseUrl, allowedHosts\(\)\)/);
  });

  it('and the address of a compatible server is checked by a rule that takes no allowlist', () => {
    const src = stripComments(repoFile('src/app/api/settings/ai/system/route.ts'));
    expect(src).toMatch(/parseCompatEndpoint\(parsed\.data\.compatBaseUrl\)/);
    expect(src).not.toMatch(/parseCompatEndpoint\([^)]*allowedHosts/);
    // And the model name is checked too, beside the key it must not be.
    expect(src).toMatch(/parseCompatModel\(parsed\.data\.compatModel\)/);
  });

  it('and only a system administrator may write them', () => {
    const src = stripComments(repoFile('src/app/api/settings/ai/system/route.ts'));
    // The exact comparison, not merely the word: `if (role)` mentions
    // SUPER_ADMIN in the same file and lets every settings manager through.
    expect(src).toMatch(/role === 'SUPER_ADMIN'/);
    // And it is asked on BOTH doors, not only the one that writes.
    expect((src.match(/refuseUnlessInstallationAdmin\(user\.role\)/g) ?? []).length).toBe(2);
  });
});
