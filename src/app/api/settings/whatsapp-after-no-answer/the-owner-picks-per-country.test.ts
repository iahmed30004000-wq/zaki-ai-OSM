import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «واتساب بعد لا يرد» — the settings door: read by the WhatsApp or the system settings, written with `settings.manage`.
 */

const { store, requirePermission, logAudit, db, perms } = vi.hoisted(() => {
  const store = { doc: {} as Record<string, unknown> };
  const perms = new Set<string>();
  const db = {
    company: { findUnique: vi.fn(async () => ({ settings: JSON.stringify(store.doc) })) },
    country: {
      findMany: vi.fn(async () => [
        { code: 'JO', name: 'الأردن' },
        { code: 'SY', name: 'سوريا' },
        { code: 'ZZ', name: 'غير محدد' },
      ]),
    },
  };
  return { store, perms, requirePermission: vi.fn(async (_key: string) => undefined), logAudit: vi.fn(), db };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: async () => ({ user: { id: 'owner' }, companyId: 'c1', storeId: 's1' }) }));
vi.mock('@/lib/authorization', () => ({
  requirePermission: (k: string) => requirePermission(k),
  can: (_u: unknown, k: string) => perms.has(k),
}));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/whatsapp/connection', () => ({ getActiveConnection: async () => null, effectiveStatus: () => 'NEEDS_SETUP' }));
vi.mock('@/lib/company-settings', () => ({
  updateCompanySettings: async (_c: string, key: string, change: (cur: unknown) => unknown) => {
    const next = change(store.doc[key]);
    store.doc[key] = next;
    return next;
  },
}));

import { GET, PUT } from './route';
import { forgetAfterNoAnswer } from '@/lib/whatsapp/after-no-answer';

const put = (body: unknown) =>
  PUT(new Request('http://localhost/x', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  store.doc = { winback: { coolingDays: 14 } };
  perms.clear();
  perms.add('whatsapp.manage');
  forgetAfterNoAnswer();
});

describe('the door', () => {
  it('reads AGENT everywhere by default, one row per country the company has a calling code for, and says it is not connected', async () => {
    const d = await (await GET()).json();
    expect(d.setting.byDialCode).toEqual({});
    expect(d.countries).toEqual([
      { dialCode: '962', name: 'الأردن' },
      { dialCode: '963', name: 'سوريا' },
    ]);
    expect(d.connected).toBe(false);
  });

  it('saving is the sensitive-settings key, touches only its own key, and is audited', async () => {
    const res = await put({ byDialCode: { '962': 'COMPANY', '963': 'AGENT' }, templateName: 'no_answer', templateLang: 'ar', templateParams: 'name' });
    expect(res.status).toBe(200);
    expect(requirePermission).toHaveBeenCalledWith('settings.manage');
    expect(store.doc.winback).toEqual({ coolingDays: 14 });
    expect((store.doc.whatsappAfterNoAnswer as { byDialCode: unknown }).byDialCode).toEqual({ '962': 'COMPANY', '963': 'AGENT' });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'WHATSAPP_AFTER_NO_ANSWER_SAVED' }));
    // COMPANY is savable before the number is connected — the door asks the connection on every press, not here.
    expect((await (await GET()).json()).setting.byDialCode['962']).toBe('COMPANY');
  });

  it('a body it cannot read is refused in Arabic and nothing is saved', async () => {
    const res = await put({ byDialCode: { '962': 'yes' } });
    expect(res.status).toBe(400);
    expect((await res.json()).errorAr).toMatch(/[؀-ۿ]/);
    expect(store.doc.whatsappAfterNoAnswer).toBeUndefined();
  });

  it('without the keys to read it, the read is asked of `whatsapp.manage`', async () => {
    perms.clear();
    requirePermission.mockRejectedValueOnce(new Error('Forbidden: missing required permission whatsapp.manage'));
    const res = await GET();
    expect(res.status).toBe(403);
  });
});
