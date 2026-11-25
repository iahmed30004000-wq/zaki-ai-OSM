import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { db } = vi.hoisted(() => ({
  db: {
    company: { findUnique: vi.fn(), update: vi.fn() },
    systemSetting: { findUnique: vi.fn(), update: vi.fn(), delete: vi.fn() },
    user: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
}));
vi.mock('./db', () => ({ db }));

import { PROBE_SYSTEM, PROBE_USER, probeLocalServer, testSavedLocalServer } from './ai-local-probe';
import { AiNotLocal, aiChat } from './ai-provider';
import { encryptSecret } from './secrets';

/**
 * «اختبار خادمك» (20/11, A1) — the owner's own model server, asked one fixed
 * question at the SAVED address only, and the real answer said in Arabic.
 *
 * And the rule that must not move: a host is «محلي» by its name or by the
 * owner's own AI_LOCAL_ALLOWED_HOSTS, and `localOnly` refuses before any
 * fetch otherwise. Every address here is a placeholder (`.invalid`,
 * `example.com`, `localhost`).
 */

const KEY = 'a'.repeat(64);
const original = { enc: process.env.APP_ENCRYPTION_KEY, allow: process.env.AI_LOCAL_ALLOWED_HOSTS };

const withSystem = (value: unknown) =>
  db.systemSetting.findUnique.mockResolvedValue({ value: JSON.stringify(value), updatedAt: new Date(), updatedById: 'u1' });

type Call = [string, RequestInit];
// Real responses with real bodies — the probe reads `res.body`, never `res.text()`.
const okJson = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const raw = (text: string, status: number, type = 'basic') =>
  type === 'basic'
    ? new Response(text, { status })
    : ({ ok: false, status, type, body: null } as unknown as Response);

/** A body of `chunks` × `size` bytes that records how far it was read and whether it was cancelled. */
const streamed = (chunks: number, size: number) => {
  const seen = { pulled: 0, cancelled: false };
  const piece = new TextEncoder().encode('x'.repeat(size));
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (seen.pulled >= chunks) return c.close();
      seen.pulled += 1;
      c.enqueue(piece);
    },
    cancel() {
      seen.cancelled = true;
    },
  });
  return { res: new Response(body, { status: 200 }), seen };
};

const fetchWith = (res: Response | (() => Promise<Response>)) =>
  vi.fn(async () => (typeof res === 'function' ? res() : res)) as unknown as typeof fetch & { mock: { calls: Call[] } };

const probe = (over: Partial<Parameters<typeof probeLocalServer>[0]> = {}) =>
  probeLocalServer({ savedUrl: 'http://localhost:11434', allowed: [], model: 'llama3.1:8b', key: null, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.APP_ENCRYPTION_KEY = KEY;
  delete process.env.AI_LOCAL_ALLOWED_HOSTS;
  delete process.env.OPENROUTER_API_KEY;
  db.systemSetting.findUnique.mockResolvedValue(null);
  db.company.findUnique.mockResolvedValue({ settings: null });
});

afterEach(() => {
  if (original.enc === undefined) delete process.env.APP_ENCRYPTION_KEY;
  else process.env.APP_ENCRYPTION_KEY = original.enc;
  if (original.allow === undefined) delete process.env.AI_LOCAL_ALLOWED_HOSTS;
  else process.env.AI_LOCAL_ALLOWED_HOSTS = original.allow;
  vi.unstubAllGlobals();
});

describe('what it dials', () => {
  it('the saved address, in the shape the local provider already speaks, with the fixed question only', async () => {
    const f = fetchWith(okJson({ choices: [{ message: { content: 'OK' } }] }));
    const r = await probe({ fetchImpl: f });
    expect(r).toEqual({ ok: true, host: 'localhost', model: 'llama3.1:8b', reply: 'OK' });
    expect(f.mock.calls).toHaveLength(1);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('http://localhost:11434/v1/chat/completions');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      model: 'llama3.1:8b',
      messages: [
        { role: 'system', content: PROBE_SYSTEM },
        { role: 'user', content: PROBE_USER },
      ],
    });
  });

  it('never follows a redirect — the hop is reported, not taken', async () => {
    const f = fetchWith(raw('', 302));
    const r = await probe({ fetchImpl: f });
    expect(f.mock.calls[0][1].redirect).toBe('manual');
    expect(r).toMatchObject({ ok: false, code: 'REDIRECT_REFUSED' });
    expect(f.mock.calls).toHaveLength(1);
    const opaque = await probe({ fetchImpl: fetchWith(raw('', 0, 'opaqueredirect')) });
    expect(opaque).toMatchObject({ ok: false, code: 'REDIRECT_REFUSED' });
  });

  it('NEGATIVE: no address saved → refused, nothing dialled', async () => {
    const f = fetchWith(okJson({}));
    const r = await probe({ savedUrl: null, fetchImpl: f });
    expect(r).toMatchObject({ ok: false, code: 'NO_ADDRESS' });
    expect(f.mock.calls).toHaveLength(0);
  });

  it('NEGATIVE: a public-looking address in the store is refused by the save’s own rule, nothing dialled', async () => {
    const f = fetchWith(okJson({}));
    const r = await probe({ savedUrl: 'http://models.example.invalid:8000', fetchImpl: f });
    expect(r).toMatchObject({ ok: false, code: 'ADDRESS_REFUSED' });
    expect((r as { errorAr: string }).errorAr).toMatch(/ليس على شبكتك/);
    expect(f.mock.calls).toHaveLength(0);
  });

  it('NEGATIVE: the cloud metadata range is refused, nothing dialled', async () => {
    const f = fetchWith(okJson({}));
    const r = await probe({ savedUrl: 'http://169.254.169.254', fetchImpl: f });
    expect(r).toMatchObject({ ok: false, code: 'ADDRESS_REFUSED' });
    expect(f.mock.calls).toHaveLength(0);
  });

  it('the same name passes only when the owner allowed it himself', async () => {
    const f = fetchWith(okJson({ choices: [{ message: { content: 'OK' } }] }));
    const r = await probe({ savedUrl: 'http://models.example.invalid:8000', allowed: ['models.example.invalid'], fetchImpl: f });
    expect(r.ok).toBe(true);
    expect(f.mock.calls[0][0]).toBe('http://models.example.invalid:8000/v1/chat/completions');
  });
});

describe('what it says back, in Arabic', () => {
  const says = async (res: Response | (() => Promise<Response>), code: string, words: RegExp, over = {}) => {
    const r = await probe({ fetchImpl: fetchWith(res), ...over });
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ code });
    expect((r as { errorAr: string }).errorAr).toMatch(words);
  };

  it('a server that speaks another language', async () => {
    await says(raw('Not Found', 404), 'NOT_OPENAI', /ما بيحكي بنفس اللغة/);
    await says(raw('<html>hello</html>', 200), 'NOT_OPENAI', /ما بيحكي بنفس اللغة/);
    await says(okJson({ response: 'OK' }), 'NOT_OPENAI', /ما بيحكي بنفس اللغة/);
  });

  it('a model the server does not have', async () => {
    await says(raw('{"error":"model \\"llama3.1:8b\\" not found"}', 404), 'MODEL_NOT_FOUND', /مش موجود على خادمك/);
  });

  it('a server that wants a key, or refuses the saved one', async () => {
    await says(raw('', 401), 'AUTH', /طلب مفتاح/);
    await says(raw('', 403), 'AUTH', /رفض المفتاح/, { key: 'local-key-12345678' });
  });

  it('a server error', async () => {
    await says(raw('boom', 500), 'SERVER_ERROR', /ردّ بخطأ 500/);
  });

  it('nobody there, and nobody answering in time', async () => {
    await says(() => Promise.reject(new TypeError('fetch failed')), 'UNREACHABLE', /ما قدرنا نوصل/);
    const hang = (_u: string, init: RequestInit) =>
      new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    const r = await probe({ fetchImpl: hang as unknown as typeof fetch, timeoutMs: 20 });
    expect(r).toMatchObject({ ok: false, code: 'TIMEOUT' });
  });
});

describe('how much of an answer is read (review of #438)', () => {
  it('NEGATIVE: a 60 MB answer stops at the cap — the reader is cancelled, the rest is never pulled', async () => {
    const big = streamed(60 * 16, 64 * 1024); // 60 MB in 64 KB pieces
    const r = await probe({ fetchImpl: fetchWith(big.res) });
    expect(r).toMatchObject({ ok: false, code: 'NOT_OPENAI' });
    expect(big.seen.cancelled).toBe(true);
    expect(big.seen.pulled).toBeLessThanOrEqual(2);
  });

  it('NEGATIVE: the same for a refusal body (a 500 that never ends)', async () => {
    const seen = { pulled: 0, cancelled: false };
    const endless = new ReadableStream<Uint8Array>({
      pull(c) {
        seen.pulled += 1;
        c.enqueue(new TextEncoder().encode('e'.repeat(65536)));
      },
      cancel() {
        seen.cancelled = true;
      },
    });
    const r = await probe({ fetchImpl: fetchWith(new Response(endless, { status: 500 })) });
    expect(r).toMatchObject({ ok: false, code: 'SERVER_ERROR', status: 500 });
    expect(seen.cancelled).toBe(true);
    expect(seen.pulled).toBeLessThanOrEqual(3);
  });

  it('NEGATIVE: a body that drips past the deadline is a timeout, not a malformed answer', async () => {
    const enc = new TextEncoder();
    let cancelled = false;
    const drip = new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode('{"choices":['));
        },
        pull() {
          return new Promise(() => undefined); // never another byte
        },
        cancel() {
          cancelled = true;
        },
      }),
      { status: 200 }
    );
    const r = await probe({ fetchImpl: fetchWith(drip), timeoutMs: 30 });
    expect(r).toMatchObject({ ok: false, code: 'TIMEOUT' });
    expect(cancelled).toBe(true);
  });

  it('a small answer still reads whole', async () => {
    const r = await probe({ fetchImpl: fetchWith(okJson({ choices: [{ message: { content: 'OK' } }] })) });
    expect(r).toMatchObject({ ok: true, reply: 'OK' });
  });
});

describe('the key', () => {
  // A key whose JSON and URL spellings differ from the raw one.
  const ODD = 'loc"al/key+12\\345678';
  const SPELLINGS = [ODD, JSON.stringify(ODD).slice(1, -1), encodeURIComponent(ODD)];

  it('NEGATIVE: every spelling of the key an echo can take is scrubbed from the reply', async () => {
    for (const spelling of SPELLINGS) {
      const r = await probe({
        fetchImpl: fetchWith(okJson({ choices: [{ message: { content: `you sent ${spelling} back` } }] })),
        key: ODD,
      });
      const out = JSON.stringify(r);
      expect(r.ok).toBe(true);
      expect((r as { reply: string }).reply).toContain('«مفتاح»');
      for (const s of SPELLINGS) expect((r as { reply: string }).reply, s).not.toContain(s);
      expect(out).not.toContain('345678');
    }
  });

  it('NEGATIVE: the refusal of a key never carries the key', async () => {
    for (const status of [401, 403]) {
      const r = await probe({ fetchImpl: fetchWith(raw(`bad key ${ODD}`, status)), key: ODD });
      expect(r).toMatchObject({ ok: false, code: 'AUTH' });
      const out = JSON.stringify(r);
      for (const s of SPELLINGS) expect(out).not.toContain(s);
      expect(out).not.toContain('345678');
    }
  });

  it('rides in the header when one is saved, and none is sent without one', async () => {
    const f = fetchWith(okJson({ choices: [{ message: { content: 'OK' } }] }));
    await probe({ fetchImpl: f, key: 'local-key-12345678' });
    expect((f.mock.calls[0][1].headers as Record<string, string>).Authorization).toBe('Bearer local-key-12345678');
    const g = fetchWith(okJson({ choices: [{ message: { content: 'OK' } }] }));
    await probe({ fetchImpl: g });
    expect((g.mock.calls[0][1].headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('NEGATIVE: an echoing server does not get the key onto the screen', async () => {
    const r = await probe({
      fetchImpl: fetchWith(okJson({ choices: [{ message: { content: 'you sent local-key-12345678' } }] })),
      key: 'local-key-12345678',
    });
    expect(JSON.stringify(r)).not.toContain('local-key-12345678');
  });
});

describe('testSavedLocalServer reads only what is saved', () => {
  it('the stored address, the stored key and the LOCAL model — nothing from the request', async () => {
    withSystem({
      provider: 'LOCAL',
      model: 'qwen2.5:14b',
      localBaseUrl: 'http://localhost:11434',
      keys: { LOCAL: { enc: encryptSecret('local-key-12345678') } },
    });
    const f = fetchWith(okJson({ choices: [{ message: { content: 'OK' } }] }));
    const r = await testSavedLocalServer('c1', f);
    expect(r).toMatchObject({ ok: true, model: 'qwen2.5:14b', host: 'localhost' });
    expect(f.mock.calls[0][0]).toBe('http://localhost:11434/v1/chat/completions');
    expect((f.mock.calls[0][1].headers as Record<string, string>).Authorization).toBe('Bearer local-key-12345678');
  });

  it('when LOCAL is not the route, it still asks the saved server with the LOCAL default model', async () => {
    withSystem({ provider: 'OPENROUTER', localBaseUrl: 'http://localhost:11434' });
    const f = fetchWith(okJson({ choices: [{ message: { content: 'OK' } }] }));
    const r = await testSavedLocalServer('c1', f);
    expect(r).toMatchObject({ ok: true, model: 'llama3.1:8b' });
  });

  it('NEGATIVE: a public-looking address in the store is not dialled', async () => {
    withSystem({ provider: 'LOCAL', localBaseUrl: 'http://models.example.invalid:8000' });
    const f = fetchWith(okJson({}));
    const r = await testSavedLocalServer('c1', f);
    expect(r).toMatchObject({ ok: false, code: 'ADDRESS_REFUSED' });
    expect(f.mock.calls).toHaveLength(0);
  });
});

/**
 * HARD RULE 1: `aiChat({ localOnly: true })` refuses BEFORE any fetch unless
 * the route is truly the owner's own server.
 */
describe('localOnly with a server address saved', () => {
  const stub = () => {
    const f = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) });
    vi.stubGlobal('fetch', f);
    return f;
  };

  it('NEGATIVE: LOCAL with a public-looking address saved → refused, no fetch', async () => {
    const f = stub();
    withSystem({ provider: 'LOCAL', model: 'llama3.1:8b', localBaseUrl: 'http://models.example.invalid:8000' });
    await expect(aiChat({ companyId: 'c1', system: 's', user: 'a customer', localOnly: true })).rejects.toThrow();
    expect(f).not.toHaveBeenCalled();
  });

  it('NEGATIVE: the compatible server (a public name) → AiNotLocal, no fetch', async () => {
    const f = stub();
    withSystem({
      provider: 'OPENAI_COMPATIBLE',
      compat: { baseUrl: 'https://models.example.com/v1', model: 'm' },
      keys: { OPENAI_COMPATIBLE: { enc: encryptSecret('compat-key-12345678'), url: 'https://models.example.com/v1' } },
    });
    await expect(aiChat({ companyId: 'c1', system: 's', user: 'a customer', localOnly: true })).rejects.toBeInstanceOf(AiNotLocal);
    expect(f).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a vendor route with a local address also saved → AiNotLocal, no fetch', async () => {
    const f = stub();
    process.env.OPENROUTER_API_KEY = 'or-key-12345678';
    withSystem({ provider: 'OPENROUTER', localBaseUrl: 'http://localhost:11434' });
    await expect(aiChat({ companyId: 'c1', system: 's', user: 'a customer', localOnly: true })).rejects.toBeInstanceOf(AiNotLocal);
    expect(f).not.toHaveBeenCalled();
  });

  it('the same public-looking name is reached only once the OWNER lists it in the environment', async () => {
    const f = stub();
    withSystem({ provider: 'LOCAL', model: 'llama3.1:8b', localBaseUrl: 'http://models.example.invalid:8000' });
    process.env.AI_LOCAL_ALLOWED_HOSTS = 'models.example.invalid';
    await aiChat({ companyId: 'c1', system: 's', user: 'u', localOnly: true });
    expect(f.mock.calls[0][0]).toBe('http://models.example.invalid:8000/v1/chat/completions');
  });

  it('and a private-network name reaches it with no allowlist at all', async () => {
    const f = stub();
    withSystem({ provider: 'LOCAL', model: 'llama3.1:8b', localBaseUrl: 'http://models.internal:8000' });
    await aiChat({ companyId: 'c1', system: 's', user: 'u', localOnly: true });
    expect(f.mock.calls[0][0]).toBe('http://models.internal:8000/v1/chat/completions');
  });
});
