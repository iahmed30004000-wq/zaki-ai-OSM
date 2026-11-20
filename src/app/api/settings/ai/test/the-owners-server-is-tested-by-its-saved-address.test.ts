import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «اختبار خادمك» through the door (20/11, A1): the same key as the general
 * test («الإعدادات الحسّاسة»), the installation-level narrowing the address
 * itself has, a ceiling on presses, and nothing from the request dialled.
 */

const { aiChat, testSavedLocalServer, requireCompanyTenant, requirePermission, who } = vi.hoisted(() => ({
  aiChat: vi.fn(),
  testSavedLocalServer: vi.fn(),
  requireCompanyTenant: vi.fn(),
  requirePermission: vi.fn(),
  who: { n: 0 },
}));

vi.mock('@/lib/ai-provider', () => ({
  aiChat: (...a: unknown[]) => aiChat(...a),
  describeRoute: async () => ({ provider: 'OPENROUTER', model: 'm', keyFrom: 'system', baseUrl: null }),
  AiNotConfigured: class extends Error {},
  AiEndpointMissing: class extends Error {},
}));
vi.mock('@/lib/ai-local-probe', () => ({ testSavedLocalServer: (...a: unknown[]) => testSavedLocalServer(...a) }));
vi.mock('@/lib/auth', () => ({ requireCompanyTenant: (...a: unknown[]) => requireCompanyTenant(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a) }));

import { POST } from './route';

const press = (body: unknown) =>
  POST(new Request('http://x.invalid/api/settings/ai/test', { method: 'POST', body: JSON.stringify(body) }));

beforeEach(() => {
  vi.resetAllMocks();
  // A fresh person per test, so the in-memory ceiling of one test never meets another.
  who.n += 1;
  requireCompanyTenant.mockResolvedValue({ user: { id: `owner-${who.n}`, role: 'SUPER_ADMIN' }, companyId: 'c1' });
  requirePermission.mockResolvedValue(undefined);
  testSavedLocalServer.mockResolvedValue({ ok: true, host: 'localhost', model: 'llama3.1:8b', reply: 'OK' });
});

describe('the owner’s server', () => {
  it('asks the saved server and repeats what it said', async () => {
    const res = await press({ target: 'LOCAL' });
    expect(await res.json()).toEqual({ ok: true, provider: 'LOCAL', host: 'localhost', model: 'llama3.1:8b', reply: 'OK' });
    expect(testSavedLocalServer).toHaveBeenCalledWith('c1');
    expect(aiChat).not.toHaveBeenCalled();
  });

  it('NEGATIVE: an address in the request is not what is dialled — only the company id goes in', async () => {
    await press({ target: 'LOCAL', url: 'http://169.254.169.254', baseUrl: 'http://models.example.invalid' });
    expect(testSavedLocalServer).toHaveBeenCalledTimes(1);
    expect(testSavedLocalServer.mock.calls[0]).toEqual(['c1']);
  });

  it('a refusal comes back as an Arabic sentence with its code', async () => {
    testSavedLocalServer.mockResolvedValue({
      ok: false, code: 'NOT_OPENAI', errorAr: 'الخادم ما بيحكي بنفس اللغة — ما عنده /v1/chat/completions على هالعنوان.',
      host: 'localhost', model: 'llama3.1:8b', status: 404,
    });
    const body = await (await press({ target: 'LOCAL' })).json();
    expect(body).toMatchObject({ ok: false, code: 'NOT_OPENAI', status: 404 });
    expect(body.errorAr).toMatch(/ما بيحكي بنفس اللغة/);
    expect(body.error).toBe(body.errorAr);
  });

  it('NEGATIVE: without «الإعدادات الحسّاسة» nothing is dialled', async () => {
    requirePermission.mockRejectedValue(new Error('Forbidden: missing required permission settings.manage'));
    const res = await press({ target: 'LOCAL' });
    expect(res.status).toBe(403);
    expect(testSavedLocalServer).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a company admin may not make the installation’s server be dialled', async () => {
    requireCompanyTenant.mockResolvedValue({ user: { id: `admin-${who.n}`, role: 'ADMIN' }, companyId: 'c1' });
    const res = await press({ target: 'LOCAL' });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('SUPER_ADMIN_ONLY');
    expect(body.errorAr).toMatch(/مدير النظام/);
    expect(testSavedLocalServer).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a loop of presses meets the ceiling and stops dialling', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) statuses.push((await press({ target: 'LOCAL' })).status);
    expect(statuses.slice(0, 6).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(6)).toEqual([429, 429]);
    expect(testSavedLocalServer).toHaveBeenCalledTimes(6);
  });
});

describe('the general test is unchanged', () => {
  it('no body, or another target, asks the default route as before', async () => {
    aiChat.mockResolvedValue('OK');
    const a = await (await POST()).json();
    const b = await (await press({ target: 'SOMETHING' })).json();
    expect(a).toMatchObject({ ok: true, provider: 'OPENROUTER', reply: 'OK' });
    expect(b).toMatchObject({ ok: true, provider: 'OPENROUTER', reply: 'OK' });
    expect(testSavedLocalServer).not.toHaveBeenCalled();
  });
});
