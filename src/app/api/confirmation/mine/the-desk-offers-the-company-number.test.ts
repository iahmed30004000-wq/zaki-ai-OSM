import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «طلباتي» says `whatsappRoute: 'COMPANY'` only when the sheet's button would be honoured: the country is on the company's
 * number, a template is named, the number is connected — AND she holds `whatsapp.send`, the key the send door asks.
 * Without any one of them the field is absent and the sheet is today's.
 */

const { db, state } = vi.hoisted(() => {
  const state = { perms: new Set<string>(), settings: {} as Record<string, unknown>, connected: true };
  const db = {
    order: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
    orderContactAttempt: { groupBy: vi.fn(async () => []), findMany: vi.fn(async () => []) },
    company: { findUnique: vi.fn(async () => ({ settings: JSON.stringify(state.settings) })) },
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
vi.mock('@/lib/insights-key', () => ({ mayReadInsights: () => false }));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: async () => undefined }));
vi.mock('@/lib/response-clock', () => ({ firstActionTimes: async () => new Map() }));
vi.mock('@/lib/no-answer-rounds-switch', () => ({ roundsSwitch: async () => ({ enabled: false, enabledAt: null }) }));
vi.mock('@/lib/whatsapp/connection', () => ({
  getActiveConnection: async () => ({ id: 'w1' }),
  effectiveStatus: () => (state.connected ? 'CONNECTED' : 'NEEDS_SETUP'),
}));

import { GET } from './route';
import { forgetAfterNoAnswer } from '@/lib/whatsapp/after-no-answer';

const COMPANY = { byDialCode: { '962': 'COMPANY' }, templateName: 'no_answer', templateLang: 'ar', templateParams: 'none' };
const desk = async () => (await GET(new Request('http://localhost/api/confirmation/mine'))).json();

beforeEach(() => {
  vi.clearAllMocks();
  forgetAfterNoAnswer();
  state.perms = new Set(['confirmation.work', 'whatsapp.send']);
  state.settings = { whatsappAfterNoAnswer: COMPANY };
  state.connected = true;
});

describe('whatsappRoute on her desk', () => {
  it('present with COMPANY, a template, the number connected and the key', async () => {
    expect((await desk()).whatsappRoute).toBe('COMPANY');
  });

  it('omitted without `whatsapp.send` — the button would answer 403', async () => {
    state.perms.delete('whatsapp.send');
    expect(await desk()).not.toHaveProperty('whatsappRoute');
  });

  it('omitted when the number is not connected', async () => {
    state.connected = false;
    expect(await desk()).not.toHaveProperty('whatsappRoute');
  });

  it('omitted when the country is on the agent’s WhatsApp, or nothing is saved', async () => {
    state.settings = { whatsappAfterNoAnswer: { ...COMPANY, byDialCode: { '962': 'AGENT' } } };
    expect(await desk()).not.toHaveProperty('whatsappRoute');
    forgetAfterNoAnswer();
    state.settings = {};
    expect(await desk()).not.toHaveProperty('whatsappRoute');
  });

  it('omitted with no template named', async () => {
    state.settings = { whatsappAfterNoAnswer: { ...COMPANY, templateName: '' } };
    expect(await desk()).not.toHaveProperty('whatsappRoute');
  });
});
