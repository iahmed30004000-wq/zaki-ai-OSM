import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE VENDOR QUOTES THE REQUEST BACK, AND THREE CALLERS LOG THE ERROR.
 *
 * Carrying the vendor's words with the status is what lets «your credit
 * balance is too low» read as a sentence the owner can act on instead of
 * «المزوّد ردّ بخطأ 400». But some vendors quote the request: OpenAI's 401
 * reads «Incorrect API key provided: sk-proj-…», and a proxy in front of
 * a local model can echo the whole `Authorization` header.
 *
 * And this error is LOGGED — `ai.ts` twice and the order intake once all
 * `console.warn` it. So without scrubbing, a rotated key puts its own
 * prefix into the server log, in a repository that deliberately refuses
 * to show even the last four characters on the settings screen.
 *
 * And every fake key below carries `test-` ON PURPOSE: `scan:secrets`
 * reads that word as «this one is fake». Without it the scanner stops on
 * this very file — a leak test that trips the leak scanner.
 *
 * The body is kept for CLASSIFICATION only — «credit balance» and nothing
 * else is read out of it — so redacting it costs nothing.
 * ═══════════════════════════════════════════════════════════════════════
 */

const KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const original = process.env.APP_ENCRYPTION_KEY;

const { db, readSystemSetting } = vi.hoisted(() => ({
  db: { company: { findUnique: vi.fn() } },
  readSystemSetting: vi.fn(),
}));

vi.mock('./db', () => ({ db }));
vi.mock('./system-settings', () => ({
  readSystemSetting: (...a: unknown[]) => readSystemSetting(...a),
  writeSystemSetting: vi.fn(),
  updateSystemSetting: vi.fn(),
  systemSettingMeta: vi.fn(),
  SYSTEM_AI: 'SYSTEM_AI',
}));
vi.mock('./audit', () => ({ logAudit: vi.fn() }));

const fetchMock = vi.fn();

beforeEach(async () => {
  vi.clearAllMocks();
  process.env.APP_ENCRYPTION_KEY = KEY;
  vi.stubGlobal('fetch', fetchMock);
  const { encryptSecret } = await import('./secrets');
  db.company.findUnique.mockResolvedValue({ settings: JSON.stringify({ ai: { provider: 'OPENAI' } }) });
  readSystemSetting.mockResolvedValue({
    provider: 'OPENAI',
    keys: { OPENAI: { enc: encryptSecret('sk-proj-test-LEAKMARKER-0001') } },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (original === undefined) delete process.env.APP_ENCRYPTION_KEY;
  else process.env.APP_ENCRYPTION_KEY = original;
});

/** What `aiChat` threw when the vendor refused with this body. */
async function thrownFor(body: string): Promise<string> {
  fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => body, json: async () => ({}) });
  const { aiChat } = await import('./ai-provider');
  try {
    await aiChat({ companyId: 'c1', system: 's', user: 'u' });
    return '';
  } catch (e) {
    return (e as Error).message;
  }
}

describe('when a vendor quotes the request back', () => {
  it('an OpenAI key in the refusal never reaches the thrown message', async () => {
    const said = await thrownFor(
      '{"error":{"message":"Incorrect API key provided: sk-proj-test-LEAKMARKER-0001. You can find your API key at…"}}'
    );

    expect(said, 'المفتاح طلع بالرسالة اللي بتنكتب بالسجلّ').not.toContain('sk-proj-test-LEAKMARKER-0001');
    expect(said).not.toContain('LEAKMARKER');
    // And the status is still readable, because that is what it is for.
    expect(said).toContain('AI_HTTP_401');
  });

  it('and an Anthropic one, and an OpenRouter one', async () => {
    for (const key of ['sk-ant-api03-test-LEAKMARKER-0002', 'sk-or-v1-test-LEAKMARKER-0003']) {
      const said = await thrownFor(`{"error":"bad key ${key}"}`);
      expect(said, key).not.toContain('LEAKMARKER');
    }
  });

  it('and an Authorization header echoed by a proxy', async () => {
    // A local proxy (litellm and friends) can put the whole request back
    // in its error body. That is the worst case and the likeliest one on
    // a machine the owner runs himself.
    const said = await thrownFor('upstream rejected: Authorization: Bearer abcdef1234567890ABCDEF');
    expect(said).not.toContain('abcdef1234567890ABCDEF');
  });

  it('and what is left still classifies the failure', async () => {
    // The whole reason the body travels: «credit balance» must survive so
    // the owner reads a sentence he can act on.
    const said = await thrownFor('{"error":{"message":"Your credit balance is too low to access the Anthropic API."}}');
    expect(said).toContain('credit balance');
  });
});

/**
 * A GATEWAY'S KEY HAS NO SHAPE, SO THE PATTERNS ABOVE CANNOT SEE IT.
 *
 * `gw.…` or a bare token: nothing in the regexes recognises it. The key this
 * call carried is known, so it is removed by its exact value — in the three
 * spellings an echo takes — and from the WHOLE text before the message is cut
 * to 300 characters (a key straddling the cut would otherwise survive as a
 * prefix that no longer equals it).
 */
describe('a compatible server that quotes a key with no recognisable shape', () => {
  const GW = 'gw.test-LEAKMARKER-9f8e7d6c5b';

  beforeEach(async () => {
    const { encryptSecret } = await import('./secrets');
    db.company.findUnique.mockResolvedValue({ settings: JSON.stringify({ ai: { provider: 'OPENAI_COMPATIBLE' } }) });
    readSystemSetting.mockResolvedValue({
      provider: 'OPENAI_COMPATIBLE',
      compat: { baseUrl: 'https://models.example.com/v1', model: 'glm-4.6' },
      keys: { OPENAI_COMPATIBLE: { enc: encryptSecret(GW), url: 'https://models.example.com/v1' } },
    });
  });

  it('the exact value never reaches the thrown message', async () => {
    const said = await thrownFor(`{"error":"invalid token ${GW} for this route"}`);
    expect(said).toContain('AI_HTTP_401');
    expect(said).not.toContain('LEAKMARKER');
    expect(said).not.toContain(GW);
  });

  it('nor the JSON-escaped or the URL-encoded spelling of it', async () => {
    const odd = 'gw.test-LEAKMARKER"9f8e/7d6c5b';
    const { encryptSecret } = await import('./secrets');
    readSystemSetting.mockResolvedValue({
      provider: 'OPENAI_COMPATIBLE',
      compat: { baseUrl: 'https://models.example.com/v1', model: 'glm-4.6' },
      keys: { OPENAI_COMPATIBLE: { enc: encryptSecret(odd), url: 'https://models.example.com/v1' } },
    });
    const said = await thrownFor(`json: ${JSON.stringify({ k: odd })} url: ?k=${encodeURIComponent(odd)}`);
    expect(said).not.toContain('LEAKMARKER');
  });

  it('a key placed across character 300 is removed before the message is cut', async () => {
    // 295 characters of padding, then the key: the cut at 300 would have kept
    // only its first five characters — which no exact match would find.
    const said = await thrownFor(`${'x'.repeat(295)}${GW} and more after it`);
    expect(said).not.toContain('gw.te');
    expect(said).not.toContain('LEAKMARKER');
    expect(said.split('|')[2].length).toBeLessThanOrEqual(300);
  });

  it('and it is still cut to 300 characters', async () => {
    const said = await thrownFor('y'.repeat(5000));
    expect(said.split('|')[2].length).toBe(300);
  });
});

