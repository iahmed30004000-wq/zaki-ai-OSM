import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE OWNER'S RULE, ON THE ONE ASSISTANT THAT READS A CUSTOMER.
 *
 * «ولا بيانات زبون لأي نموذج خارجي — الاسم والتلفون والعنوان ما بيوصلوا
 * إلا لنموذج شغّال على جهاز المالك.»
 *
 * `ai-assistants.ts` declares this assistant `pii: true` — «whether a
 * customer's phone or address may be in its payload» — and nothing read
 * that declaration. The address was already withheld, with a comment
 * saying why. The NAME and the seller's free-text notes were not: they
 * went to whatever vendor the route resolved to.
 *
 * The notes matter as much as the name. «البيت جنب مدرسة فلان» is an
 * address written as a sentence, and it is the seller's own words, so no
 * schema can promise what is in them.
 *
 * Refusing outright was the other option and it was worse: it would leave
 * the one assistant that reads a customer unusable for every company that
 * has not stood up a local model — which is every company today. So the
 * payload changes shape instead, and `aiChat` refuses only if a caller
 * neither redacts nor routes locally.
 *
 * Asked on the PAYLOAD. A test that checked `describeRoute` was called
 * would pass while the name went out anyway.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, requirePermission, aiChat, describeRoute, customerHistory } = vi.hoisted(() => ({
  db: { order: { findFirst: vi.fn() } },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  aiChat: vi.fn(),
  describeRoute: vi.fn(),
  customerHistory: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a) }));
// The work door's envelope (her own OR the order she holds); this file is about the payload.
vi.mock('@/lib/rbac', () => ({ orderWorkWhere: () => ({}) }));
vi.mock('@/lib/ai-provider', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  aiChat: (...a: unknown[]) => aiChat(...a),
  describeRoute: (...a: unknown[]) => describeRoute(...a),
}));
vi.mock('@/lib/customer-risk', () => ({
  customerHistory: (...a: unknown[]) => customerHistory(...a),
  customerRisk: async () => ({ orders: 2, returns: 0, returnRate: 0, tier: 'SAFE', requiresPrepaymentOrApproval: false }),
}));
vi.mock('@/lib/api-error', () => ({
  apiErrorResponse: (e: unknown) =>
    new Response(JSON.stringify({ error: `UNEXPECTED: ${(e as Error)?.message}` }), { status: 500 }),
}));

import { POST } from './route';

const NAME = 'سامر خليل العبدالله';
const NOTES = 'البيت جنب مدرسة الشامل، اتصل قبل ما تطلع';

const ORDER = {
  id: 'o1',
  orderNumber: 'ORD-9',
  companyId: 'c1',
  totalAmount: 39,
  currency: 'JOD',
  customerNotes: NOTES,
  items: [{ productName: 'قبعة', quantity: 1, freeQuantity: 0 }],
  customer: {
    id: 'cu1',
    fullName: NAME,
    city: 'عمّان',
    address: 'الدوار السابع، شارع المدينة',
    phone: '0791234567',
  },
};

const ask = () =>
  POST(
    new Request('http://localhost/api/ai/confirmation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: '11111111-1111-4111-8111-111111111111' }),
    })
  );

/** Everything that went to the model, as one string. */
const sentToModel = () => JSON.stringify(aiChat.mock.calls[0]?.[0] ?? {});

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({
    user: { id: 'a1', name: 'سارة', role: 'CONFIRMATION_AGENT' },
    companyId: 'c1',
    storeId: 's1',
  });
  requirePermission.mockResolvedValue({ id: 'a1' });
  db.order.findFirst.mockResolvedValue(ORDER);
  customerHistory.mockResolvedValue([]);
  aiChat.mockResolvedValue('اتصل وأكّد');
});

describe('on a vendor that is not ours', () => {
  beforeEach(() => {
    describeRoute.mockResolvedValue({ provider: 'ANTHROPIC', model: 'claude-sonnet-5-5', keyFrom: 'system', baseUrl: null });
  });

  it('the customer’s name never leaves this machine', async () => {
    await ask();
    expect(sentToModel(), 'اسم الزبون راح لمزوّد خارجي').not.toContain(NAME);
    expect(sentToModel(), 'ولا جزء منه').not.toContain('سامر');
  });

  it('and neither do the seller’s notes — only that there are some', async () => {
    await ask();
    const sent = sentToModel();
    expect(sent, 'ملاحظات البائع راحت لمزوّد خارجي').not.toContain('مدرسة الشامل');
    expect(sent).toContain('hasNotes');
  });

  it('and the address and the phone stay out, as they already did', async () => {
    await ask();
    const sent = sentToModel();
    expect(sent).not.toContain('الدوار السابع');
    expect(sent).not.toContain('0791234567');
  });

  it('and the facts the assistant actually needs still go', async () => {
    // Taking the person out must not take the question out. The order
    // number, the money, the city and the items are what it reasons from.
    await ask();
    const sent = sentToModel();
    expect(sent).toContain('ORD-9');
    expect(sent).toContain('عمّان');
    expect(sent).toContain('قبعة');
  });

  it('and it tells aiChat that it redacted, so the guard lets it through', async () => {
    await ask();
    expect(aiChat.mock.calls[0][0].piiSafe, 'ما قال إنّه نظّف — النداء رح ينرفض').toBe(true);
  });
});

describe('on an OpenAI-compatible server — an outside party, whatever its address says', () => {
  beforeEach(() => {
    describeRoute.mockResolvedValue({ provider: 'OPENAI_COMPATIBLE', model: 'glm-4.6', keyFrom: 'system', baseUrl: 'models.example.com' });
  });

  it('the name and the notes are absent from the payload, and it says it redacted', async () => {
    await ask();
    const sent = sentToModel();
    expect(sent, 'اسم الزبون راح لخادم متوافق مع OpenAI').not.toContain('سامر');
    expect(sent, 'ملاحظات البائع راحت لخادم متوافق مع OpenAI').not.toContain('مدرسة الشامل');
    expect(sent).toContain('hasNotes');
    expect(aiChat.mock.calls[0][0].piiSafe).toBe(true);
  });
});

describe('on the owner’s own server', () => {
  beforeEach(() => {
    describeRoute.mockResolvedValue({ provider: 'LOCAL', model: 'llama3.1:8b', keyFrom: 'none', baseUrl: 'http://127.0.0.1:11434' });
  });

  it('the assistant gets everything, because nothing leaves the building', async () => {
    await ask();
    const sent = sentToModel();
    expect(sent).toContain(NAME);
    expect(sent).toContain('مدرسة الشامل');
  });

  it('and it does not claim to have redacted something it did not', async () => {
    // `piiSafe` is a promise about the payload. Passing it here would be
    // a true statement about a false payload.
    await ask();
    expect(aiChat.mock.calls[0][0].piiSafe).toBeUndefined();
  });
});
