import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «القيم المطلوبة» — THE DOORS (the media buyer's doors, PR-C): `/api/settings/integrations` and its `/test`.
 *
 *   · each setting needs the key of ITS card (`whatsapp.manage` for WhatsApp's, `telegram.connect` for Telegram's) — asked per setting, not per page
 *   · WRITE-ONLY: no answer carries a value, the audit row carries the name and the last four characters, never the value
 *   · a refusal says why and writes nothing (no encryption key → 503, wrong shape → 400, unknown name → 404)
 *   · «جرّب» answers a verdict and a name — never a token or the raw reply of Telegram or Meta
 */

const h = vi.hoisted(() => ({
  user: { current: { id: 'u1' } as Record<string, unknown> },
  can: vi.fn(),
  requirePermission: vi.fn(),
  logAudit: vi.fn(),
  saveSetting: vi.fn(),
  clearSetting: vi.fn(),
  settingsStatus: vi.fn(),
  getMe: vi.fn(),
  getAccessToken: vi.fn(),
  getPhoneNumberId: vi.fn(),
}));

vi.mock('@/lib/geo-context', () => ({ requireContext: async () => ({ user: h.user.current, companyId: 'c1', storeId: 's1' }) }));
vi.mock('@/lib/authorization', () => ({
  can: (...a: unknown[]) => h.can(...a),
  requirePermission: (...a: unknown[]) => h.requirePermission(...a),
}));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => h.logAudit(...a) }));
vi.mock('@/lib/integration-settings', async () => {
  const real = await vi.importActual<typeof import('@/lib/integration-settings')>('@/lib/integration-settings');
  return {
    ...real,
    saveSetting: (...a: unknown[]) => h.saveSetting(...a),
    clearSetting: (...a: unknown[]) => h.clearSetting(...a),
    settingsStatus: (...a: unknown[]) => h.settingsStatus(...a),
  };
});
vi.mock('@/lib/telegram/cloud-api', () => ({ getMe: (...a: unknown[]) => h.getMe(...a) }));
vi.mock('@/lib/whatsapp/config', () => ({
  GRAPH_BASE: 'https://graph.facebook.com',
  GRAPH_VERSION: 'v21.0',
  getAccessToken: (...a: unknown[]) => h.getAccessToken(...a),
  getPhoneNumberId: (...a: unknown[]) => h.getPhoneNumberId(...a),
}));

import { DELETE, GET, PUT } from './route';
import { POST as testIt } from './test/route';

const body = (method: string, payload: unknown) =>
  new Request('http://localhost/api/settings/integrations', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });

const status = (over: Record<string, unknown>) => ({
  key: 'X', group: 'whatsapp', label: 'x', help: 'h', source: 'none', hint: null, envSet: false, unreadable: false, permission: 'whatsapp.manage', ...over,
});

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

beforeEach(() => {
  vi.clearAllMocks();
  h.user.current = { id: 'u1' };
  h.can.mockReturnValue(true);
  h.requirePermission.mockResolvedValue(undefined);
  h.saveSetting.mockResolvedValue({ ok: true, hint: '1234' });
  h.clearSetting.mockResolvedValue(true);
  h.settingsStatus.mockResolvedValue([
    status({ key: 'WHATSAPP_ACCESS_TOKEN', source: 'site', hint: '1234' }),
    status({ key: 'TELEGRAM_BOT_TOKEN', group: 'telegram', permission: 'telegram.connect', source: 'env', envSet: true }),
  ]);
  h.getMe.mockResolvedValue({ ok: true, result: { id: 1, username: 'zaki_bot' } });
  h.getAccessToken.mockResolvedValue('EAAGsecrettoken1234');
  h.getPhoneNumberId.mockResolvedValue('109876543210987');
});

describe('reading', () => {
  it('lists only the settings of the cards the person holds a key for, and never a value', async () => {
    h.can.mockImplementation((_u: unknown, p: string) => p === 'whatsapp.manage');
    const res = await GET();
    const out = await res.json();
    expect(out.items.map((i: { key: string }) => i.key)).toEqual(['WHATSAPP_ACCESS_TOKEN']);
    expect(JSON.stringify(out)).not.toMatch(/value|EAAG|secret/i);
    expect(out.items[0]).toMatchObject({ source: 'site', hint: '1234' });
  });

  it('a person with neither key is refused', async () => {
    h.can.mockReturnValue(false);
    h.requirePermission.mockRejectedValue(new Error('Forbidden: missing required permission whatsapp.manage'));
    expect((await GET()).status).toBe(403);
  });
});

describe('saving', () => {
  it('asks the key of THAT setting’s card, saves it sealed, and answers the last four — not the value', async () => {
    const res = await PUT(body('PUT', { key: 'TELEGRAM_BOT_TOKEN', value: '123456:ABCDEFSECRET' }));
    expect(res.status).toBe(200);
    expect(h.requirePermission).toHaveBeenCalledWith('telegram.connect');
    expect(h.saveSetting).toHaveBeenCalledWith('TELEGRAM_BOT_TOKEN', '123456:ABCDEFSECRET', 'u1');
    const text = JSON.stringify(await res.json());
    expect(text).toBe(JSON.stringify({ ok: true, key: 'TELEGRAM_BOT_TOKEN', hint: '1234' }));
    expect(text).not.toContain('ABCDEFSECRET');
  });

  it('a WhatsApp key cannot save a Telegram setting: the server asks per setting, not per page', async () => {
    h.requirePermission.mockImplementation(async (p: string) => {
      if (p === 'telegram.connect') throw new Error('Forbidden: missing required permission telegram.connect');
    });
    const res = await PUT(body('PUT', { key: 'TELEGRAM_BOT_TOKEN', value: '123456:ABCDEFSECRET' }));
    expect(res.status).toBe(403);
    expect(h.saveSetting).not.toHaveBeenCalled();
    expect(h.logAudit).not.toHaveBeenCalled();
    const ok = await PUT(body('PUT', { key: 'WHATSAPP_ACCESS_TOKEN', value: 'EAAGsecrettoken1234' }));
    expect(ok.status).toBe(200);
    expect(h.requirePermission).toHaveBeenLastCalledWith('whatsapp.manage');
  });

  it('writes ONE audit row with the NAME and the last four characters — never the value', async () => {
    await PUT(body('PUT', { key: 'WHATSAPP_ACCESS_TOKEN', value: 'EAAGsecrettoken1234' }));
    expect(h.logAudit).toHaveBeenCalledTimes(1);
    const row = h.logAudit.mock.calls[0][0];
    expect(row).toMatchObject({ companyId: 'c1', userId: 'u1', action: 'INTEGRATION_SETTING_SAVED', entity: 'IntegrationSecret', entityId: 'WHATSAPP_ACCESS_TOKEN', newData: { key: 'WHATSAPP_ACCESS_TOKEN', hint: '1234' } });
    expect(JSON.stringify(row)).not.toContain('EAAGsecrettoken1234');
  });

  it('refuses with a reason and writes no audit row: wrong shape 400, no encryption key 503, unknown name 404, a body that is not the shape 400', async () => {
    h.saveSetting.mockResolvedValueOnce({ ok: false, code: 'BAD_SHAPE', message: 'القيمة مش بالشكل المطلوب: أرقام بس' });
    const bad = await PUT(body('PUT', { key: 'WHATSAPP_PHONE_NUMBER_ID', value: 'abc' }));
    expect(bad.status).toBe(400);
    expect(JSON.stringify(await bad.json())).not.toContain('abc"');
    h.saveSetting.mockResolvedValueOnce({ ok: false, code: 'NO_ENCRYPTION_KEY', message: 'مفتاح التشفير غير مُهيّأ' });
    expect((await PUT(body('PUT', { key: 'WHATSAPP_ACCESS_TOKEN', value: 'EAAGsecrettoken1234' }))).status).toBe(503);
    expect((await PUT(body('PUT', { key: 'DATABASE_URL', value: 'postgres://x-1234' }))).status).toBe(404);
    expect((await PUT(body('PUT', { key: 'WHATSAPP_ACCESS_TOKEN' }))).status).toBe(400);
    expect((await PUT(body('PUT', { key: 'WHATSAPP_ACCESS_TOKEN', value: 'EAAGsecrettoken1234', extra: 1 }))).status).toBe(400);
    expect(h.logAudit).not.toHaveBeenCalled();
  });
});

describe('clearing', () => {
  it('asks the setting’s own key, removes what the site holds, and writes one audit row with the name', async () => {
    const res = await DELETE(body('DELETE', { key: 'TELEGRAM_BOT_TOKEN' }));
    expect(await res.json()).toEqual({ ok: true, key: 'TELEGRAM_BOT_TOKEN', removed: true });
    expect(h.requirePermission).toHaveBeenCalledWith('telegram.connect');
    expect(h.logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'INTEGRATION_SETTING_CLEARED', entityId: 'TELEGRAM_BOT_TOKEN' }));
  });

  it('clearing what was never saved is not an event: no audit row', async () => {
    h.clearSetting.mockResolvedValue(false);
    expect((await (await DELETE(body('DELETE', { key: 'TELEGRAM_BOT_TOKEN' }))).json()).removed).toBe(false);
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it('an unknown name is 404 and nothing is cleared', async () => {
    expect((await DELETE(body('DELETE', { key: 'DATABASE_URL' }))).status).toBe(404);
    expect(h.clearSetting).not.toHaveBeenCalled();
  });
});

describe('«جرّب»', () => {
  const post = (group: unknown) => testIt(new Request('http://localhost/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ group }) }));

  it('Telegram: asks the bot who it is and says «يشتغل» with its name — and asks telegram.connect', async () => {
    const out = await (await post('telegram')).json();
    expect(out).toEqual({ ok: true, message: 'يشتغل · @zaki_bot' });
    expect(h.requirePermission).toHaveBeenCalledWith('telegram.connect');
  });

  it('Telegram: says why in a sentence when it does not work — never Telegram’s own words', async () => {
    h.getMe.mockResolvedValue({ ok: false, errorCode: 'API_ERROR', description: 'Unauthorized: bot token 123:SECRET is wrong' });
    const text = JSON.stringify(await (await post('telegram')).json());
    expect(text).toContain('تيليجرام رفض الرمز');
    expect(text).not.toContain('SECRET');
    h.getMe.mockResolvedValue({ ok: false, errorCode: 'NO_TOKEN' });
    expect((await (await post('telegram')).json()).message).toBe('ما في رمز بوت محفوظ');
  });

  it('WhatsApp: asks Meta for the number’s own name with the token in the HEADER, and never returns the token or the id', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ verified_name: 'صحة بلس', display_phone_number: '+962 7 9000 0000' }) });
    const out = await (await post('whatsapp')).json();
    expect(out).toEqual({ ok: true, message: 'يشتغل · صحة بلس' });
    expect(h.requirePermission).toHaveBeenCalledWith('whatsapp.manage');
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://graph.facebook.com/v21.0/109876543210987?fields=display_phone_number,verified_name');
    expect(String(url)).not.toContain('EAAG');
    expect(init.headers.Authorization).toBe('Bearer EAAGsecrettoken1234');
    expect(JSON.stringify(out)).not.toMatch(/EAAG|109876543210987|\+962/);
  });

  it('WhatsApp: a missing value, a refusal by Meta and a network failure are each a verdict, not a crash', async () => {
    h.getAccessToken.mockResolvedValue(null);
    expect((await (await post('whatsapp')).json()).ok).toBe(false);
    h.getAccessToken.mockResolvedValue('EAAGsecrettoken1234');
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ error: { message: 'Invalid OAuth access token EAAGsecrettoken1234' } }) });
    const refused = await (await post('whatsapp')).json();
    expect(refused).toEqual({ ok: false, message: 'ميتا رفضت الرمز أو المعرّف' });
    fetchMock.mockRejectedValue(new Error('network'));
    expect((await (await post('whatsapp')).json()).message).toBe('تعذّر الوصول لميتا');
  });

  it('a group it does not know is a 400, and a key that is missing is refused', async () => {
    expect((await post('sms')).status).toBe(400);
    h.requirePermission.mockRejectedValue(new Error('Forbidden: missing required permission telegram.connect'));
    expect((await post('telegram')).status).toBe(403);
  });
});
