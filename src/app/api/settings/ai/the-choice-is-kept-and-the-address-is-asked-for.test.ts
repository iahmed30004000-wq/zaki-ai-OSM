import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * TWO THINGS THE COMPANY SETTINGS DOOR DID NOT DO.
 *
 * It accepted `assistants` all along, and the screen never sent them — so
 * «المساعدون» was a tab where every control worked, nothing was refused,
 * and nothing survived a reload. The screen is fixed; this holds the door
 * that has to keep them.
 *
 * And it refused LOCAL outright. «نموذج على خادمك» is in the vendor list
 * and the dropdown offers it, and `z.enum` did not — so choosing it and
 * saving answered with a validation error that named no field. It is
 * accepted now, and refused WITHOUT an address, in the words the system
 * settings door already uses: a local model with nowhere to send the
 * request saves cleanly and fails when somebody asks a question.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { requireContext, requirePermission, aiSettings, saveAiSettings, systemAi, describeRoute, logAudit } =
  vi.hoisted(() => ({
    requireContext: vi.fn(),
    requirePermission: vi.fn(),
    aiSettings: vi.fn(),
    saveAiSettings: vi.fn(),
    systemAi: vi.fn(),
    describeRoute: vi.fn(),
    logAudit: vi.fn(),
  }));

vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/ai-provider', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  aiSettings: (...a: unknown[]) => aiSettings(...a),
  saveAiSettings: (...a: unknown[]) => saveAiSettings(...a),
  systemAi: (...a: unknown[]) => systemAi(...a),
  describeRoute: (...a: unknown[]) => describeRoute(...a),
}));
vi.mock('@/lib/api-error', () => ({
  apiErrorResponse: (e: unknown) =>
    new Response(JSON.stringify({ error: `UNEXPECTED: ${(e as Error)?.message}` }), { status: 500 }),
}));

import { PUT } from './route';

const put = (body: unknown) =>
  PUT(
    new Request('http://localhost/api/settings/ai', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );

const BASE = { provider: 'OPENROUTER', model: 'meta-llama/llama-3.3-70b-instruct:free' };

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({ user: { id: 'u1', name: 'المالك' }, companyId: 'c1' });
  requirePermission.mockResolvedValue(undefined);
  aiSettings.mockResolvedValue({ ...BASE, prompts: {}, assistants: {} });
  saveAiSettings.mockResolvedValue({ ...BASE, prompts: {}, assistants: {} });
  systemAi.mockResolvedValue({ provider: 'OPENROUTER', localBaseUrl: null });
  describeRoute.mockResolvedValue({ provider: 'OPENROUTER', model: 'x', keyFrom: 'none', baseUrl: null });
  logAudit.mockResolvedValue(undefined);
});

describe('an assistant’s own vendor and model', () => {
  it('reaches the store, so the choice survives a reload', async () => {
    const assistants = { confirmation: { provider: 'ANTHROPIC', model: 'claude-sonnet-5-5' } };
    const res = await put({ ...BASE, assistants });

    expect(res.status, await res.clone().text()).toBeLessThan(400);
    expect(saveAiSettings).toHaveBeenCalledTimes(1);
    expect(saveAiSettings.mock.calls[0][1].assistants, 'التوجيه ما وصل للمخزن').toEqual(assistants);
  });

  it('and an unknown vendor in it is not a reason to refuse the whole save', async () => {
    // The store drops a vendor it does not know rather than storing it, so
    // the door does not need to be the one that says no — and refusing the
    // save would lose the prompts the same request carries.
    const res = await put({ ...BASE, assistants: { confirmation: { provider: 'ACME' } } });
    expect(res.status).toBeLessThan(400);
  });
});

describe('and editing a prompt is not choosing a vendor', () => {
  it('a save that carries no provider does not store one', async () => {
    /*
     * `aiSettings()` COMPUTES `provider` and `model` when the company
     * never chose, so the screen echoing them back was a write. Saving a
     * sentence used to store `provider: 'OPENROUTER'` — and since a
     * company's choice now outranks the installation default, that stamp
     * would override a deliberate LOCAL on the owner's own server.
     */
    const res = await put({ prompts: { picking: 'رتّب حسب الرفّ' } });

    expect(res.status, await res.clone().text()).toBeLessThan(400);
    const sent = saveAiSettings.mock.calls[0][1];
    expect(sent.provider, 'حفظُ نصٍّ خزّن مزوّداً ما حدا اختاره').toBeUndefined();
    expect(sent.model).toBeUndefined();
    expect(sent.prompts).toEqual({ picking: 'رتّب حسب الرفّ' });
  });

  it('and a provider sent explicitly still lands', async () => {
    systemAi.mockResolvedValue({ provider: 'OPENROUTER', localBaseUrl: null });
    await put({ provider: 'ANTHROPIC', model: 'claude-sonnet-5-5', prompts: {} });
    expect(saveAiSettings.mock.calls[0][1].provider).toBe('ANTHROPIC');
  });
});

describe('«نموذج على خادمك»', () => {
  it('is accepted — the dropdown has been offering it all along', async () => {
    systemAi.mockResolvedValue({ provider: 'LOCAL', localBaseUrl: 'http://127.0.0.1:11434' });
    const res = await put({ ...BASE, provider: 'LOCAL' });
    expect(res.status, await res.clone().text()).toBeLessThan(400);
  });

  it('and refused without an address, in words, before anything is stored', async () => {
    systemAi.mockResolvedValue({ provider: 'OPENROUTER', localBaseUrl: null });
    const res = await put({ ...BASE, provider: 'LOCAL' });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.code).toBe('ENDPOINT_REQUIRED');
    expect(body.error).toContain('عنوان الخادم');
    expect(saveAiSettings, 'انحفظ مزوّد محلّي بلا عنوان').not.toHaveBeenCalled();
  });

  it('and the refusal is the same sentence the system door uses', async () => {
    // Two wordings for one refusal is two things to learn.
    systemAi.mockResolvedValue({ provider: 'OPENROUTER', localBaseUrl: null });
    const body = await (await put({ ...BASE, provider: 'LOCAL' })).json();
    expect(body.error).toBe('اكتب عنوان الخادم الذي يشغّل النموذج قبل اختياره مزوّداً.');
  });
});

describe('«خادم متوافق مع OpenAI»', () => {
  it('is accepted once the installation has an address for it', async () => {
    systemAi.mockResolvedValue({
      provider: 'OPENROUTER',
      localBaseUrl: null,
      compat: { baseUrl: 'https://models.example.com/v1', host: 'models.example.com', model: 'glm-4.6' },
    });
    const res = await put({ ...BASE, provider: 'OPENAI_COMPATIBLE' });
    expect(res.status, await res.clone().text()).toBeLessThan(400);
    expect(saveAiSettings.mock.calls[0][1].provider).toBe('OPENAI_COMPATIBLE');
  });

  it('and refused without one, in words, before anything is stored', async () => {
    systemAi.mockResolvedValue({
      provider: 'OPENROUTER',
      localBaseUrl: null,
      compat: { baseUrl: null, host: null, model: null },
    });
    const res = await put({ ...BASE, provider: 'OPENAI_COMPATIBLE' });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.code).toBe('ENDPOINT_REQUIRED');
    expect(body.error).toBe('اكتب عنوان الخادم الذي يشغّل النموذج قبل اختياره مزوّداً.');
    expect(saveAiSettings, 'انحفظ مزوّد بلا عنوان').not.toHaveBeenCalled();
  });

  it('and this door never takes its address, its name or a declaration — the schema has no such field', async () => {
    systemAi.mockResolvedValue({
      provider: 'OPENROUTER',
      localBaseUrl: null,
      compat: { baseUrl: 'https://models.example.com/v1', host: 'models.example.com', model: 'glm-4.6' },
    });
    await put({
      ...BASE,
      provider: 'OPENAI_COMPATIBLE',
      compatBaseUrl: 'https://evil.example.net/v1',
      compatModel: 'x',
      compatOwnServer: true,
      ownServer: true,
    });
    const sent = saveAiSettings.mock.calls[0][1];
    expect(Object.keys(sent).filter((k) => /compat|ownServer/i.test(k))).toEqual([]);
  });
});

