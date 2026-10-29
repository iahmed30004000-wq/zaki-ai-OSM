import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE DOOR THAT TAKES THE COMPATIBLE SERVER'S ADDRESS, NAME AND KEY.
 *
 * Every case is a refusal, and every refusal asserts that NOTHING was saved:
 * the address is where the server sends the key and every prompt, so a
 * refusal that still wrote half of it is not a refusal.
 *
 * Fake keys carry `test-` on purpose — `scan:secrets` reads that as fake.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { requireContext, requirePermission, saveSystemAi, systemAi, logAudit } = vi.hoisted(() => ({
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  saveSystemAi: vi.fn(),
  systemAi: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/ai-provider', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  saveSystemAi: (...a: unknown[]) => saveSystemAi(...a),
  systemAi: (...a: unknown[]) => systemAi(...a),
}));
vi.mock('@/lib/api-error', () => ({
  apiErrorResponse: (e: unknown) =>
    new Response(JSON.stringify({ error: `UNEXPECTED: ${(e as Error)?.message}` }), { status: 500 }),
}));

import { GET, PUT } from './route';

const URL1 = 'https://models.example.com/v1';
const KEY = 'sk-test-COMPAT-LEAKMARKER-0001';

const put = (body: unknown) =>
  PUT(
    new Request('http://localhost/api/settings/ai/system', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );

/** What the installation holds before the request. */
const state = (over: Record<string, unknown> = {}) => ({
  provider: 'OPENROUTER',
  model: 'm',
  providerKeys: {},
  localBaseUrl: null,
  compat: { baseUrl: null, host: null, model: null },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({ user: { id: 'u1', name: 'المالك', role: 'SUPER_ADMIN' }, companyId: 'c1' });
  requirePermission.mockResolvedValue(undefined);
  systemAi.mockResolvedValue(state());
  saveSystemAi.mockResolvedValue(state({ compat: { baseUrl: URL1, host: 'models.example.com', model: 'glm-4.6' } }));
  logAudit.mockResolvedValue(undefined);
});

const refused = async (body: unknown, code: string) => {
  const res = await put(body);
  const json = await res.json();
  expect(res.status, JSON.stringify(json)).toBe(400);
  expect(json.code).toBe(code);
  expect(saveSystemAi, 'انحفظ شيء رغم الرفض').not.toHaveBeenCalled();
  expect(logAudit).not.toHaveBeenCalled();
};

describe('the address is refused unless it is an https public name', () => {
  it('http', async () => {
    await refused({ compatBaseUrl: 'http://models.example.com/v1', compatModel: 'glm-4.6', providerKeys: { OPENAI_COMPATIBLE: KEY } }, 'NOT_HTTPS');
  });

  it('every internal and literal address the SSRF list names', async () => {
    const cases: [string, string][] = [
      ['https://127.0.0.1/v1', 'PRIVATE'],
      ['https://169.254.169.254/latest/meta-data', 'METADATA'],
      ['https://localhost/v1', 'PRIVATE'],
      ['https://[::1]/v1', 'PRIVATE'],
      ['https://0x7f000001/v1', 'PRIVATE'],
      ['https://2130706433/v1', 'PRIVATE'],
      ['https://10.0.0.5/v1', 'PRIVATE'],
      ['https://user:pass@models.example.com/v1', 'CREDENTIALS'],
      ['https://box.local/v1', 'PRIVATE'],
      ['https://salesflow-db/v1', 'BAD_HOST'],
      ['https://8.8.8.8/v1', 'IP_LITERAL'],
    ];
    for (const [url, code] of cases) {
      vi.clearAllMocks();
      requireContext.mockResolvedValue({ user: { id: 'u1', role: 'SUPER_ADMIN' }, companyId: 'c1' });
      systemAi.mockResolvedValue(state());
      await refused({ compatBaseUrl: url, compatModel: 'glm-4.6', providerKeys: { OPENAI_COMPATIBLE: KEY } }, code);
    }
  });

  it('a name the environment allowlist would have let through as «local» is still refused', async () => {
    process.env.AI_LOCAL_ALLOWED_HOSTS = 'models.example.com,box.lan';
    try {
      await refused({ compatBaseUrl: 'https://box.lan/v1', compatModel: 'glm-4.6', providerKeys: { OPENAI_COMPATIBLE: KEY } }, 'RESERVED_HOST');
    } finally {
      delete process.env.AI_LOCAL_ALLOWED_HOSTS;
    }
  });
});

describe('the name', () => {
  it('a URL with no model, stored or sent', async () => {
    await refused({ compatBaseUrl: URL1, providerKeys: { OPENAI_COMPATIBLE: KEY } }, 'MODEL_REQUIRED');
  });

  it('a stored URL, and the model cleared', async () => {
    systemAi.mockResolvedValue(state({ compat: { baseUrl: URL1, host: 'models.example.com', model: 'glm-4.6' } }));
    await refused({ compatModel: '' }, 'MODEL_REQUIRED');
  });

  it('a key pasted into the model box is refused — by shape, and by exact value', async () => {
    await refused({ compatBaseUrl: URL1, compatModel: KEY, providerKeys: { OPENAI_COMPATIBLE: KEY } }, 'MODEL_INVALID');
    vi.clearAllMocks();
    requireContext.mockResolvedValue({ user: { id: 'u1', role: 'SUPER_ADMIN' }, companyId: 'c1' });
    systemAi.mockResolvedValue(state());
    // Not key-shaped at all — only equal to the key sent in the same request.
    await refused({ compatBaseUrl: URL1, compatModel: 'plainsecret', providerKeys: { OPENAI_COMPATIBLE: 'plainsecret' } }, 'MODEL_INVALID');
  });

  it('characters outside the pattern', async () => {
    await refused({ compatBaseUrl: URL1, compatModel: 'glm 4.6; rm', providerKeys: { OPENAI_COMPATIBLE: KEY } }, 'MODEL_INVALID');
  });
});

describe('the key is bound to its address', () => {
  it('a new address with no key is refused: KEY_REQUIRED_FOR_NEW_URL', async () => {
    await refused({ compatBaseUrl: URL1, compatModel: 'glm-4.6' }, 'KEY_REQUIRED_FOR_NEW_URL');
  });

  it('a CHANGED address with no key is refused too — the old key does not follow it', async () => {
    systemAi.mockResolvedValue(state({ compat: { baseUrl: 'https://other.example.org/v1', host: 'other.example.org', model: 'glm-4.6' } }));
    await refused({ compatBaseUrl: URL1 }, 'KEY_REQUIRED_FOR_NEW_URL');
  });

  it('a key with no address anywhere is refused', async () => {
    await refused({ providerKeys: { OPENAI_COMPATIBLE: KEY } }, 'ENDPOINT_REQUIRED');
  });

  it('choosing it as the default with no address is refused', async () => {
    await refused({ provider: 'OPENAI_COMPATIBLE' }, 'ENDPOINT_REQUIRED');
  });

  it('the same address again needs no new key', async () => {
    systemAi.mockResolvedValue(state({ compat: { baseUrl: URL1, host: 'models.example.com', model: 'glm-4.6' } }));
    const res = await put({ compatBaseUrl: 'https://models.example.com/v1/', compatModel: 'glm-4.7' });
    expect(res.status).toBe(200);
    expect(saveSystemAi.mock.calls[0][0]).toMatchObject({ compatBaseUrl: URL1, compatModel: 'glm-4.7' });
  });
});

describe('who may', () => {
  it('a company administrator cannot write it', async () => {
    requireContext.mockResolvedValue({ user: { id: 'u2', role: 'ADMIN' }, companyId: 'c1' });
    const res = await put({ compatBaseUrl: URL1, compatModel: 'glm-4.6', providerKeys: { OPENAI_COMPATIBLE: KEY } });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('SUPER_ADMIN_ONLY');
    expect(saveSystemAi).not.toHaveBeenCalled();
  });

  it('nor read it', async () => {
    requireContext.mockResolvedValue({ user: { id: 'u2', role: 'ADMIN' }, companyId: 'c1' });
    const res = await GET();
    expect(res.status).toBe(403);
  });
});

describe('a good save', () => {
  it('reaches the store with the normalised address, and leaks nothing into the answer or the audit', async () => {
    const res = await put({
      compatBaseUrl: 'https://models.example.com/v1/?x=1#f',
      compatModel: 'glm-4.6',
      providerKeys: { OPENAI_COMPATIBLE: KEY },
    });
    expect(res.status).toBe(200);
    expect(saveSystemAi.mock.calls[0][0]).toMatchObject({ compatBaseUrl: URL1, compatModel: 'glm-4.6' });

    expect(JSON.stringify(await res.json())).not.toContain('LEAKMARKER');
    const audit = JSON.stringify(logAudit.mock.calls);
    expect(audit).not.toContain('LEAKMARKER');
    expect(logAudit.mock.calls[0][0].newData.keysTouched).toEqual(['OPENAI_COMPATIBLE']);
    expect(logAudit.mock.calls[0][0].newData.compatBaseUrl).toBe(URL1);
  });

  it('clearing the address needs no key and no model', async () => {
    systemAi.mockResolvedValue(state({ compat: { baseUrl: URL1, host: 'models.example.com', model: 'glm-4.6' } }));
    saveSystemAi.mockResolvedValue(state());
    const res = await put({ compatBaseUrl: null });
    expect(res.status).toBe(200);
    expect(saveSystemAi.mock.calls[0][0].compatBaseUrl).toBeNull();
  });
});
