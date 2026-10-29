import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «اختبر الاتصال» SAYS EXACTLY WHAT IT PROVED.
 *
 * It asks the courier's city list. That call carries the company id (the `company-id` header, like every call) and NO
 * password, so a good answer proves the company id and the network path, and the password is first proven by the first
 * dispatch. It used to say «الحساب يعمل», and to blame the user name and password for any 4xx.
 */

const { db, requireContext, logAudit } = vi.hoisted(() => ({
  db: { deliveryProvider: { findFirst: vi.fn() } },
  requireContext: vi.fn(),
  logAudit: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: vi.fn() }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));

process.env.APP_ENCRYPTION_KEY = 'c'.repeat(64);

import { POST } from './route';
import { encryptJson } from '@/lib/secrets';

const PASSWORD = 'Sup3r-Secret-pw';
const account = encryptJson({
  email: 'shop@example.com', password: PASSWORD, companyId: 744, originCityId: 445053, senderName: 'متجر', senderPhone: '0999000000',
});
const provider = { id: 'p1', name: 'الباشا', adapterCode: 'LOGESTECHS', code: 'BASHA', apiCredentials: account };

const run = () => POST(new Request('http://localhost/x', { method: 'POST' }), { params: Promise.resolve({ id: 'p1' }) });
const seen: { url: string; headers: Record<string, string> }[] = [];
const courierAnswers = (res: () => Response) =>
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    seen.push({ url: String(url), headers: init.headers as Record<string, string> });
    return res();
  }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  seen.length = 0;
  requireContext.mockResolvedValue({ user: { id: 'u1' }, companyId: 'c1', storeId: 's1' });
  db.deliveryProvider.findFirst.mockResolvedValue(provider);
});

describe('what a good answer proves', () => {
  it('the company id and the way there, and it says the password is proven at the first dispatch', async () => {
    courierAnswers(() => new Response(JSON.stringify({ data: [{ id: 445053, arabicName: 'عمان' }] }), { status: 200 }));
    const body = await (await run()).json();
    expect(body.ok).toBe(true);
    expect(body.message).toContain('رقم الشركة مقبول');
    expect(body.message).toContain('كلمة المرور تُفحص عند أول ترحيل');
    // It never claims more than it asked.
    expect(body.message).not.toContain('الحساب يعمل');
    // And the city list went with the company id, as every call does.
    expect(seen[0].headers['company-id']).toBe('744');
    expect(new URL(seen[0].url).pathname).toBe('/api/addresses/cities');
  });

  it('an answer with no matching test city is the same good news', async () => {
    courierAnswers(() => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const body = await (await run()).json();
    expect(body).toMatchObject({ ok: true, reason: 'OK_NO_MATCH' });
    expect(body.message).toContain('كلمة المرور تُفحص عند أول ترحيل');
  });
});

describe('a refusal shows the courier’s own words', () => {
  it('a 400 {"error":…} is quoted, not turned into «راجع اسم المستخدم وكلمة المرور»', async () => {
    courierAnswers(() => new Response(JSON.stringify({ error: 'رقم تعريف الشركة غير صحيح' }), { status: 400 }));
    const body = await (await run()).json();
    expect(body.ok).toBe(false);
    expect(body.message).toBe('ردّت الشركة برفض (400): رقم تعريف الشركة غير صحيح');
    expect(body.message).not.toContain('كلمة المرور');
  });

  it('a body that is not JSON is quoted trimmed too', async () => {
    courierAnswers(() => new Response('forbidden by gateway', { status: 403 }));
    const body = await (await run()).json();
    expect(body.message).toBe('ردّت الشركة برفض (403): forbidden by gateway');
  });

  it('NEGATIVE: a server that echoes the request back leaks neither the password nor the e-mail, to the screen or the audit row', async () => {
    courierAnswers(() => new Response(JSON.stringify({ error: `bad request ${PASSWORD} shop@example.com` }), { status: 400 }));
    const body = await (await run()).json();
    const audit = JSON.stringify(logAudit.mock.calls);
    for (const text of [JSON.stringify(body), audit]) {
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain('shop@example.com');
    }
  });

  it('the refusal is audited with the courier’s words', async () => {
    courierAnswers(() => new Response(JSON.stringify({ error: 'رقم تعريف الشركة غير صحيح' }), { status: 400 }));
    await run();
    expect(logAudit).toHaveBeenCalledTimes(1);
    const entry = logAudit.mock.calls[0][0];
    expect(entry.action).toBe('COURIER_CREDENTIALS_TEST_FAILED');
    expect(entry.newData.courierSaid).toContain('رقم تعريف الشركة غير صحيح');
    expect(entry.newData.reason).toBe('REFUSED');
  });

  it('NEGATIVE: a network failure is still «unreachable», not a refusal', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const body = await (await run()).json();
    expect(body.reason).toBe('UNREACHABLE');
    expect(body.message).toContain('تعذّر الوصول إلى الشركة');
  });
});
