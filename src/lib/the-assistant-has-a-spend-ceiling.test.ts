import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { repoFile, stripComments } from './guard-source';

/**
 * THE ASSISTANTS HAVE A DAILY AND A MONTHLY CEILING (Q13).
 *
 * The per-minute limit stops a loop and nothing else. This file holds the
 * line the owner writes in «إعدادات الذكاء»: how many tokens a company may use
 * in a day and in a month. The owner’s standing instruction for the open
 * questions of this work: «اي قرار بعد الان اتخذو دون الرجوع الي».
 */

type Doc = { value: string };

const { db, store, state } = vi.hoisted(() => {
  const store = new Map<string, Doc>();
  const state = { company: null as string | null };
  const db = {
    company: { findUnique: vi.fn(), update: vi.fn() },
    systemSetting: { findUnique: vi.fn(), update: vi.fn(), delete: vi.fn() },
    user: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  };
  return { db, store, state };
});

/** The in-memory database every case starts from. */
function wireDb() {
  db.company.findUnique.mockImplementation(async () => ({ settings: state.company }));
  db.company.update.mockImplementation(async ({ data }: { data: { settings: string } }) => {
    state.company = data.settings;
    return {};
  });
  db.systemSetting.findUnique.mockImplementation(async ({ where }: { where: { key: string } }) => {
    const row = store.get(where.key);
    return row ? { value: row.value, updatedAt: new Date('2026-10-30T10:00:00Z'), updatedById: null } : null;
  });
  db.systemSetting.update.mockImplementation(async ({ where, data }: { where: { key: string }; data: { value: string } }) => {
    store.set(where.key, { value: data.value });
    return {};
  });
  db.systemSetting.delete.mockImplementation(async ({ where }: { where: { key: string } }) => {
    store.delete(where.key);
    return {};
  });
  db.user.findUnique.mockResolvedValue(null);
  // The locked write: the company row for settings, the system row for usage.
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn({
      $executeRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
        if (!store.has(String(values[0]))) store.set(String(values[0]), { value: '{}' });
        return 1;
      },
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) =>
        strings.join('').includes('system_settings')
          ? [{ value: store.get(String(values[0]))?.value ?? '{}' }]
          : [{ settings: state.company }],
      company: db.company,
      systemSetting: db.systemSetting,
    })
  );
}

vi.mock('./db', () => ({ db }));

import { AiNotConfigured, AiNotLocal, aiChat, aiSettings, saveAiSettings } from './ai-provider';
import {
  AiCapReached,
  CAP_MESSAGE_AR,
  MAX_CAP_TOKENS,
  addUsage,
  capReached,
  capReachedResponse,
  estimateTokens,
  hasCap,
  readUsage,
  sanitizeCap,
  tokensUsed,
  usageAt,
} from './ai-spend';
import { explainAiError } from './ai-error-message';
import { askAiAssistant } from './ai';
import { encryptSecret } from './secrets';

process.env.APP_ENCRYPTION_KEY = 'a'.repeat(64);

const NOON = new Date('2026-10-30T12:00:00Z');
const USAGE_KEY = 'ai-usage:c1';

const setCompany = (ai: unknown) => {
  state.company = JSON.stringify({ ai });
};
const setUsage = (doc: unknown) => store.set(USAGE_KEY, { value: JSON.stringify(doc) });
const usageNow = () => JSON.parse(store.get(USAGE_KEY)?.value ?? '{}');
const fetchOk = (body: unknown) => {
  const f = vi.fn().mockResolvedValue({ ok: true, json: async () => body });
  vi.stubGlobal('fetch', f);
  return f;
};
const OPENAI_ANSWER = { choices: [{ message: { content: 'جواب' } }] };

beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
  state.company = null;
  wireDb();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOON);
  process.env.OPENROUTER_API_KEY = 'sk-or-test-env-key';
  setCompany({ provider: 'OPENROUTER', model: 'gpt-4o-mini' });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.OPENROUTER_API_KEY;
});

describe('the arithmetic', () => {
  it('reads anything unreadable as «no ceiling»', () => {
    expect(sanitizeCap(undefined)).toEqual({ dailyTokens: null, monthlyTokens: null });
    expect(sanitizeCap('x')).toEqual({ dailyTokens: null, monthlyTokens: null });
    expect(sanitizeCap({ dailyTokens: 0, monthlyTokens: -5 })).toEqual({ dailyTokens: null, monthlyTokens: null });
    expect(sanitizeCap({ dailyTokens: NaN, monthlyTokens: '100' })).toEqual({ dailyTokens: null, monthlyTokens: null });
    expect(hasCap(sanitizeCap({}))).toBe(false);
  });

  it('keeps a whole positive number, floors a fraction and clamps a typo', () => {
    expect(sanitizeCap({ dailyTokens: 5000.9, monthlyTokens: 10 ** 15 })).toEqual({
      dailyTokens: 5000,
      monthlyTokens: MAX_CAP_TOKENS,
    });
  });

  it('a total from yesterday is today’s zero, and the month survives the day', () => {
    const doc = { day: '2026-10-29', dayTokens: 900, month: '2026-10', monthTokens: 4000 };
    expect(usageAt(doc, NOON)).toMatchObject({ dayTokens: 0, monthTokens: 4000 });
    expect(usageAt(doc, new Date('2026-11-01T00:00:00Z'))).toMatchObject({ dayTokens: 0, monthTokens: 0 });
  });

  it('adding rolls the day over instead of stacking on yesterday', () => {
    const doc = { day: '2026-10-29', dayTokens: 900, month: '2026-10', monthTokens: 4000 };
    expect(addUsage(doc, 100, NOON)).toEqual({ day: '2026-10-30', dayTokens: 100, month: '2026-10', monthTokens: 4100 });
  });

  it('the line is reached AT the number, not past it', () => {
    const u = { day: 'd', month: 'm', dayTokens: 99, monthTokens: 0 };
    expect(capReached({ dailyTokens: 100, monthlyTokens: null }, u)).toBeNull();
    expect(capReached({ dailyTokens: 100, monthlyTokens: null }, { ...u, dayTokens: 100 })).toBe('DAY');
    expect(capReached({ dailyTokens: null, monthlyTokens: 100 }, { ...u, monthTokens: 100 })).toBe('MONTH');
    expect(capReached({ dailyTokens: null, monthlyTokens: null }, { ...u, dayTokens: 10 ** 9 })).toBeNull();
  });

  it('when both are reached the month is named — «يعود غداً» would be a lie', () => {
    const u = { day: 'd', month: 'm', dayTokens: 500, monthTokens: 500 };
    expect(capReached({ dailyTokens: 100, monthlyTokens: 100 }, u)).toBe('MONTH');
  });

  it('counts what the vendor reported, in either vendor’s words', () => {
    const lengths = { inChars: 3000, images: 0, outChars: 300 };
    expect(tokensUsed({ usage: { input_tokens: 120, output_tokens: 30 } }, 'anthropic', lengths)).toBe(150);
    expect(tokensUsed({ usage: { prompt_tokens: 80, completion_tokens: 20 } }, 'openai', lengths)).toBe(100);
    expect(tokensUsed({ usage: { total_tokens: 77 } }, 'openai', lengths)).toBe(77);
  });

  it('estimates from lengths when the vendor says nothing, a picture counting as many', () => {
    expect(tokensUsed({}, 'openai', { inChars: 3000, images: 0, outChars: 300 })).toBe(1000 + 100);
    expect(tokensUsed(null, 'anthropic', { inChars: 0, images: 1, outChars: 0 })).toBe(estimateTokens(0, 1));
    expect(estimateTokens(0, 1)).toBeGreaterThan(1000);
    // Garbage in the vendor’s numbers is not trusted.
    expect(tokensUsed({ usage: { prompt_tokens: -5, completion_tokens: 'x' } }, 'openai', { inChars: 30, images: 0, outChars: 30 })).toBe(20);
  });

  it('says it in Arabic, with no Latin letters, and never a bare 500', async () => {
    for (const text of Object.values(CAP_MESSAGE_AR)) {
      expect(text).toMatch(/السقف/);
      expect(text).not.toMatch(/[A-Za-z]/);
    }
    const res = capReachedResponse(new AiCapReached('DAY'))!;
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body).toMatchObject({ code: 'AI_CAP_REACHED', errorAr: CAP_MESSAGE_AR.DAY, period: 'DAY' });
    expect(capReachedResponse(new Error('x'))).toBeNull();
    expect(explainAiError(new AiCapReached('MONTH'))).toEqual({ ok: false, error: CAP_MESSAGE_AR.MONTH });
  });
});

describe('the call', () => {
  it('with no ceiling it behaves exactly as before, and never even reads the meter', async () => {
    const f = fetchOk(OPENAI_ANSWER);
    expect(await aiChat({ companyId: 'c1', system: 's', user: 'u' })).toBe('جواب');
    expect(f).toHaveBeenCalledTimes(1);
    const reads = db.systemSetting.findUnique.mock.calls.map((c) => (c[0] as { where: { key: string } }).where.key);
    expect(reads).not.toContain(USAGE_KEY);
  });

  it('counts what the vendor reports, into today and into this month', async () => {
    fetchOk({ ...OPENAI_ANSWER, usage: { prompt_tokens: 700, completion_tokens: 300 } });
    await aiChat({ companyId: 'c1', system: 's', user: 'u' });
    expect(usageNow()).toEqual({ day: '2026-10-30', dayTokens: 1000, month: '2026-10', monthTokens: 1000 });
    await aiChat({ companyId: 'c1', system: 's', user: 'u' });
    expect(usageNow()).toMatchObject({ dayTokens: 2000, monthTokens: 2000 });
    expect(await readUsage('c1', NOON)).toMatchObject({ dayTokens: 2000 });
  });

  it('counts an Anthropic reply by its own fields', async () => {
    setCompany({ provider: 'ANTHROPIC', model: 'claude-sonnet-4-5', keys: { ANTHROPIC: { enc: encryptSecret('sk-test-ant-0001') } } });
    fetchOk({ content: [{ text: 'رد' }], usage: { input_tokens: 40, output_tokens: 2 } });
    await expect(aiChat({ companyId: 'c1', system: 's', user: 'u' })).resolves.toBe('رد');
    expect(usageNow().dayTokens).toBe(42);
  });

  it('estimates when the reply carries no count — from LENGTHS, keeping no words', async () => {
    fetchOk(OPENAI_ANSWER);
    await aiChat({ companyId: 'c1', system: 'تعليمات', user: 'سؤال سري جداً عن الزبون' });
    const doc = usageNow();
    expect(doc.dayTokens).toBeGreaterThan(0);
    // Numbers only: not the question, not the answer.
    expect(Object.keys(doc).sort()).toEqual(['day', 'dayTokens', 'month', 'monthTokens']);
    expect(JSON.stringify([...store.values()])).not.toContain('سري');
    expect(JSON.stringify([...store.values()])).not.toContain('جواب');
  });

  it('over the daily line it refuses BEFORE anything is sent', async () => {
    setCompany({ provider: 'OPENROUTER', spendCap: { dailyTokens: 1000, monthlyTokens: null } });
    setUsage({ day: '2026-10-30', dayTokens: 1000, month: '2026-10', monthTokens: 1000 });
    const f = fetchOk(OPENAI_ANSWER);
    const err = await aiChat({ companyId: 'c1', system: 's', user: 'u' }).catch((e) => e);
    expect(err).toBeInstanceOf(AiCapReached);
    expect(err.period).toBe('DAY');
    expect(err.messageAr).toBe(CAP_MESSAGE_AR.DAY);
    expect(f).not.toHaveBeenCalled();
    // And nothing more was counted.
    expect(usageNow().dayTokens).toBe(1000);
  });

  it('over the monthly line it says the month', async () => {
    setCompany({ provider: 'OPENROUTER', spendCap: { dailyTokens: null, monthlyTokens: 5000 } });
    setUsage({ day: '2026-10-30', dayTokens: 10, month: '2026-10', monthTokens: 5000 });
    fetchOk(OPENAI_ANSWER);
    await expect(aiChat({ companyId: 'c1', system: 's', user: 'u' })).rejects.toMatchObject({ period: 'MONTH' });
  });

  it('a new day opens the daily line again, and a new month the monthly one', async () => {
    setCompany({ provider: 'OPENROUTER', spendCap: { dailyTokens: 1000, monthlyTokens: 5000 } });
    setUsage({ day: '2026-10-29', dayTokens: 1000, month: '2026-10', monthTokens: 1200 });
    fetchOk(OPENAI_ANSWER);
    await expect(aiChat({ companyId: 'c1', system: 's', user: 'u' })).resolves.toBe('جواب');
    vi.setSystemTime(new Date('2026-11-02T08:00:00Z'));
    setUsage({ day: '2026-10-31', dayTokens: 1000, month: '2026-10', monthTokens: 5000 });
    await expect(aiChat({ companyId: 'c1', system: 's', user: 'u' })).resolves.toBe('جواب');
  });

  it('the call that crosses the line is answered; the NEXT one is refused', async () => {
    setCompany({ provider: 'OPENROUTER', spendCap: { dailyTokens: 1000, monthlyTokens: null } });
    fetchOk({ ...OPENAI_ANSWER, usage: { prompt_tokens: 900, completion_tokens: 400 } });
    await expect(aiChat({ companyId: 'c1', system: 's', user: 'u' })).resolves.toBe('جواب');
    await expect(aiChat({ companyId: 'c1', system: 's', user: 'u' })).rejects.toBeInstanceOf(AiCapReached);
  });

  it('is per company: another company’s usage is not this one’s', async () => {
    setCompany({ provider: 'OPENROUTER', spendCap: { dailyTokens: 1000, monthlyTokens: null } });
    store.set('ai-usage:other', { value: JSON.stringify({ day: '2026-10-30', dayTokens: 9999, month: '2026-10', monthTokens: 9999 }) });
    fetchOk(OPENAI_ANSWER);
    await expect(aiChat({ companyId: 'c1', system: 's', user: 'u' })).resolves.toBe('جواب');
  });

  it('a model on the owner’s own machine costs nothing: not stopped, not counted', async () => {
    setCompany({ provider: 'LOCAL', spendCap: { dailyTokens: 1, monthlyTokens: 1 } });
    store.set('ai', { value: JSON.stringify({ localBaseUrl: 'http://localhost:11434' }) });
    setUsage({ day: '2026-10-30', dayTokens: 10 ** 6, month: '2026-10', monthTokens: 10 ** 6 });
    fetchOk(OPENAI_ANSWER);
    await expect(aiChat({ companyId: 'c1', system: 's', user: 'u' })).resolves.toBe('جواب');
    expect(usageNow().dayTokens).toBe(10 ** 6);
  });

  it('a meter that cannot be read lets the call through — a cost control is not a lock', async () => {
    setCompany({ provider: 'OPENROUTER', spendCap: { dailyTokens: 1000, monthlyTokens: null } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    db.systemSetting.findUnique.mockImplementation(async ({ where }: { where: { key: string } }) => {
      if (where.key === USAGE_KEY) throw new Error('connection lost');
      return null;
    });
    fetchOk(OPENAI_ANSWER);
    await expect(aiChat({ companyId: 'c1', system: 's', user: 'u' })).resolves.toBe('جواب');
    warn.mockRestore();
  });

  it('a meter that cannot be written never takes down the answer already paid for', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    db.$transaction.mockRejectedValueOnce(new Error('table missing'));
    fetchOk(OPENAI_ANSWER);
    await expect(aiChat({ companyId: 'c1', system: 's', user: 'u' })).resolves.toBe('جواب');
    warn.mockRestore();
  });

  it('a vendor that fails is not counted', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'boom', json: async () => ({}) }));
    await expect(aiChat({ companyId: 'c1', system: 's', user: 'u' })).rejects.toBeDefined();
    expect(store.has(USAGE_KEY)).toBe(false);
  });
});

describe('the older refusals still come first', () => {
  it('no key is still «no key», not «the ceiling»', async () => {
    delete process.env.OPENROUTER_API_KEY;
    setCompany({ provider: 'OPENROUTER', spendCap: { dailyTokens: 1, monthlyTokens: null } });
    setUsage({ day: '2026-10-30', dayTokens: 5, month: '2026-10', monthTokens: 5 });
    await expect(aiChat({ companyId: 'c1', system: 's', user: 'u' })).rejects.toBeInstanceOf(AiNotConfigured);
  });

  it('a customer’s payload is still refused as «not local», never reaching the cap or the vendor', async () => {
    setCompany({ provider: 'OPENROUTER', spendCap: { dailyTokens: 1, monthlyTokens: null } });
    setUsage({ day: '2026-10-30', dayTokens: 5, month: '2026-10', monthTokens: 5 });
    const f = fetchOk(OPENAI_ANSWER);
    await expect(aiChat({ companyId: 'c1', system: 's', user: 'u', localOnly: true })).rejects.toBeInstanceOf(AiNotLocal);
    expect(f).not.toHaveBeenCalled();
  });
});

describe('the settings', () => {
  it('start with no ceiling, which is what every company has today', async () => {
    const s = await aiSettings('c1');
    expect(hasCap(s.spendCap)).toBe(false);
  });

  it('save, read back, and survive a save that is about something else', async () => {
    state.company = JSON.stringify({ ai: { provider: 'OPENROUTER', prompts: { house: 'نص' } } });

    const saved = await saveAiSettings('c1', { spendCap: { dailyTokens: 20000, monthlyTokens: null } });
    expect(saved.spendCap).toEqual({ dailyTokens: 20000, monthlyTokens: null });

    // A prompt save, a scope save: neither may switch the ceiling off.
    await saveAiSettings('c1', { prompts: { house: 'نص جديد' } });
    await saveAiSettings('c1', { intelligenceScopes: [] });
    expect((await aiSettings('c1')).spendCap).toEqual({ dailyTokens: 20000, monthlyTokens: null });

    // Both sides null stores nothing at all.
    await saveAiSettings('c1', { spendCap: { dailyTokens: null, monthlyTokens: null } });
    expect(JSON.parse(state.company!).ai.spendCap).toBeUndefined();
    expect(hasCap((await aiSettings('c1')).spendCap)).toBe(false);
  });
});

describe('the assistants that answer in a sentence', () => {
  it('the bubble says why it went plain, then gives the verified numbers', async () => {
    setCompany({ provider: 'OPENROUTER', spendCap: { dailyTokens: 100, monthlyTokens: null } });
    setUsage({ day: '2026-10-30', dayTokens: 100, month: '2026-10', monthTokens: 100 });
    const f = fetchOk(OPENAI_ANSWER);
    const answer = await askAiAssistant('كم الطلبات؟', { total_orders: 12 }, { companyId: 'c1' });
    expect(answer.startsWith(CAP_MESSAGE_AR.DAY)).toBe(true);
    expect(f).not.toHaveBeenCalled();
  });
});

describe('every door that can reach a vendor knows what to say at the ceiling', () => {
  const DOORS = [
    'src/app/api/ai/confirmation/route.ts',
    'src/app/api/ai/landing-build/route.ts',
    'src/app/api/ai/landing-copy/route.ts',
    'src/app/api/ai/landing-match/route.ts',
    'src/app/api/ai/picking/route.ts',
    'src/app/api/growth/intelligence/ask/route.ts',
  ];

  it.each(DOORS)('%s answers the ceiling in Arabic and not with a 500', (rel) => {
    const src = stripComments(repoFile(rel));
    expect(src).toMatch(/aiChat\(/);
    expect(src).toMatch(/capReachedResponse\(|instanceof AiCapReached/);
  });

  it('the two doors that carry a customer ask for a local model, which is never metered', () => {
    for (const rel of ['src/app/api/orders/ai-intake/route.ts', 'src/app/api/palette/today/route.ts']) {
      expect(stripComments(repoFile(rel))).toMatch(/localOnly: true/);
    }
    const provider = stripComments(repoFile('src/lib/ai-provider/call.ts'));
    expect(provider).toMatch(/const metered = route\.provider !== 'LOCAL'/);
  });

  it('the check is made after the privacy guards and before the first byte leaves', () => {
    const src = stripComments(repoFile('src/lib/ai-provider/call.ts'));
    const at = (needle: string | RegExp) => (typeof needle === 'string' ? src.indexOf(needle) : src.search(needle));
    const check = at('await assertUnderCap(');
    const firstFetch = at("fetch('https://api.anthropic.com");
    expect(check).toBeGreaterThan(at(/if \(req\.localOnly && route\.provider !== 'LOCAL'\)/));
    expect(check).toBeGreaterThan(at(/!req\.piiSafe && route\.provider !== 'LOCAL' && req\.job/));
    expect(check).toBeGreaterThan(at('throw new AiNotConfigured()'));
    expect(check).toBeLessThan(firstFetch);
  });
});
