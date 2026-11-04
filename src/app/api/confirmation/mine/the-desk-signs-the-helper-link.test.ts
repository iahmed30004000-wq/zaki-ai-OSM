import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';

/**
 * «مساعد الاتصال» ON «طلباتي» — `callHelperLink` on the rows she rings from, ONLY when her phone is paired.
 *
 *   · no active device → no field on any row, and one lookup was the whole cost;
 *   · a device → every row of «للشغل» and «لا يرد» carries the Android intent; its `sig` verifies with the contract's
 *     formula (computed here by hand with node's crypto), and the phone in it is EXACTLY what the WhatsApp button builds
 *     (`waNumber` with the desk's calling code) — the number the app will dial;
 *   · a colleague's desk read through «شاشة موظفة» carries none and does not look her device up.
 */

const { db, state } = vi.hoisted(() => {
  const state = { device: null as null | { callKeyEncrypted: string }, perms: new Set<string>() };
  const row = (id: string, rawPhone: string, noAnswer = false) => ({
    id,
    orderNumber: `JO-${id}`,
    confirmationStatus: noAnswer ? 'NO_ANSWER' : 'NEW',
    shippingStatus: null,
    totalAmount: 10,
    currency: 'JOD',
    customer: { id: `c-${id}`, fullName: 'زبون', phone: rawPhone.replace(/\D/g, ''), rawPhone, totalOrders: 1 },
    items: [],
    addOns: [],
    _count: { contactAttempts: 0, notes: 0 },
  });
  const db = {
    order: {
      // Only the «في التأكيد» read has an OR at the top; the closed and confirmed reads are empty here.
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        'OR' in where ? [row('o1', '0791234567'), row('o2', '+962 79 765 4321'), row('o3', '', false)] : []
      ),
      count: vi.fn(async () => 0),
    },
    orderContactAttempt: {
      groupBy: vi.fn(async () => [{ orderId: 'o2', _count: { _all: 1 } }]),
      findMany: vi.fn(async () => []),
    },
    company: { findUnique: vi.fn(async () => ({ settings: '{}' })) },
    callHelperDevice: { findFirst: vi.fn(async () => state.device) },
  };
  return { db, state };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({
  requireContext: async () => ({
    user: { id: 'u1', name: 'Sara', role: 'CONFIRMATION_AGENT', companyId: 'c1', status: 'ACTIVE', permissions: [] },
    companyId: 'c1',
    storeId: 's1',
    countryId: 'co1',
    country: { id: 'co1', code: 'JO', timezone: 'Asia/Amman', workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6] },
  }),
}));
vi.mock('@/lib/authorization', () => ({
  requirePermission: async () => undefined,
  can: (_u: unknown, k: string) => state.perms.has(k),
}));
vi.mock('@/lib/desk-watch', () => ({
  DESK_NOT_FOUND: 'x',
  DESK_WATCH_REFUSAL: 'x',
  mayWatchDesks: () => true,
  watchedAgent: async () => ({ id: 'u2', name: 'Lina' }),
}));
vi.mock('@/lib/insights-key', () => ({ mayReadInsights: () => false }));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: async () => undefined }));
vi.mock('@/lib/response-clock', () => ({ firstActionTimes: async () => new Map() }));
vi.mock('@/lib/no-answer-rounds-switch', () => ({ roundsSwitch: async () => ({ enabled: false, enabledAt: null }) }));

import { GET } from './route';
import { encryptSecret } from '@/lib/secrets';
import { waNumber } from '@/lib/message-templates';

const before = process.env.APP_ENCRYPTION_KEY;
process.env.APP_ENCRYPTION_KEY = ['test', 'only', 'encryption', 'key', 'not', 'real'].join('-').padEnd(40, 'z');
afterAll(() => {
  process.env.APP_ENCRYPTION_KEY = before;
});
// Obviously fake: assembled, never a real key.
const CALL_KEY = ['fake', 'call', 'key', 'for', 'the', 'desk'].join('_').padEnd(43, 'y');

type Row = { id: string; customer: { rawPhone: string }; callHelperLink?: string };
const desk = async (url = 'http://localhost/api/confirmation/mine') =>
  (await GET(new Request(url))).json() as Promise<{ work: Row[]; noAnswer: Row[]; dialCode: string }>;

const contractSig = (key: string, orderId: string, phone: string, exp: string) =>
  crypto.createHmac('sha256', Buffer.from(key, 'utf8')).update(`${orderId}.${phone}.${exp}`, 'utf8').digest('hex');

beforeEach(() => {
  vi.clearAllMocks();
  state.device = null;
  state.perms = new Set(['confirmation.work']);
});

describe('callHelperLink on her desk', () => {
  it('absent on every row without a paired phone — and one lookup was all it cost', async () => {
    const d = await desk();
    for (const r of [...d.work, ...d.noAnswer]) expect(r).not.toHaveProperty('callHelperLink');
    expect(db.callHelperDevice.findFirst).toHaveBeenCalledTimes(1);
    expect(db.callHelperDevice.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { companyId: 'c1', userId: 'u1', revokedAt: null } })
    );
  });

  it('present with an active device: signed by the contract, for the number the WhatsApp button builds', async () => {
    state.device = { callKeyEncrypted: encryptSecret(CALL_KEY) };
    const d = await desk();
    const rows = [...d.work, ...d.noAnswer];
    const linked = rows.filter((r) => r.callHelperLink);
    // o3 has no number: no link, and its «اتصل» stays today's tel:.
    expect(linked.map((r) => r.id).sort()).toEqual(['o1', 'o2']);
    const nowS = Date.now() / 1000;
    for (const r of linked) {
      const m = /^intent:\/\/call\?([^#]+)#Intent;scheme=zakicall;package=io\.zakiai\.callhelper;S\.browser_fallback_url=([^;]+);end$/.exec(
        r.callHelperLink!
      );
      expect(m, r.callHelperLink).not.toBeNull();
      const q = new URLSearchParams(m![1]);
      const phone = q.get('phone')!;
      expect(q.get('order')).toBe(r.id);
      expect(phone).toBe(waNumber(r.customer.rawPhone, d.dialCode));
      expect(phone.startsWith('962')).toBe(true);
      const exp = q.get('exp')!;
      expect(Number(exp)).toBeGreaterThan(nowS + 11 * 3600);
      expect(Number(exp)).toBeLessThanOrEqual(nowS + 24 * 3600);
      expect(q.get('sig')).toBe(contractSig(CALL_KEY, r.id, phone, exp));
      expect(decodeURIComponent(m![2])).toBe(`tel:+${phone}`);
    }
  });

  it('a key that does not decrypt: no link, and the desk still loads', async () => {
    state.device = { callKeyEncrypted: 'v1:00:00:00' };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = await desk();
    expect(d.work.length).toBeGreaterThan(0);
    for (const r of [...d.work, ...d.noAnswer]) expect(r).not.toHaveProperty('callHelperLink');
    err.mockRestore();
  });

  it('a colleague’s desk read through «شاشة موظفة»: no link, and her device is not looked up', async () => {
    state.device = { callKeyEncrypted: encryptSecret(CALL_KEY) };
    const d = await desk('http://localhost/api/confirmation/mine?agent=u2');
    for (const r of [...d.work, ...d.noAnswer]) expect(r).not.toHaveProperty('callHelperLink');
    expect(db.callHelperDevice.findFirst).not.toHaveBeenCalled();
  });
});
