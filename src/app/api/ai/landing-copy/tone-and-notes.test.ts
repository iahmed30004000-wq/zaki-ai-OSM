import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE DOOR CARRIES THE WIZARD'S VOICE TO THE BRIEF — AND STOPS A NOTE WITH
 * A PHONE NUMBER BEFORE ANY CALL.
 */

const { db, aiChat } = vi.hoisted(() => ({
  db: { product: { findFirst: vi.fn() } },
  aiChat: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({
  requireContext: async () => ({
    user: { id: 'u1' }, companyId: 'c1', storeId: 's1', country: { currencyCode: 'JOD' },
  }),
}));
vi.mock('@/lib/require-assistant', () => ({ requireAssistant: async () => undefined }));
vi.mock('@/lib/ai-rate', () => ({ tooManyAiCalls: () => null }));
vi.mock('@/lib/ai-provider', () => ({
  AiNotConfigured: class extends Error {},
  aiChat: (...a: unknown[]) => aiChat(...a),
}));

import { POST } from './route';

const PRODUCT_ID = '11111111-1111-4111-8111-111111111111';

const ask = (body: Record<string, unknown>) =>
  POST(
    new Request('http://localhost/api/ai/landing-copy', {
      method: 'POST',
      body: JSON.stringify({ structureId: 'problem-solution', productId: PRODUCT_ID, ...body }),
    })
  );

const briefSent = () => (aiChat.mock.calls[0][0] as { user: string }).user;

beforeEach(() => {
  vi.clearAllMocks();
  db.product.findFirst.mockResolvedValue({ name: 'كريم', description: 'مرطّب', basePrice: 10, attributes: null });
  aiChat.mockResolvedValue(JSON.stringify({ heroTitle: 'عنوان' }));
});

describe('the voice', () => {
  it('reaches the brief as its one sentence', async () => {
    const res = await ask({ tone: 'premium' });
    expect(res.status).toBe(200);
    expect(briefSent()).toContain('الأسلوب: فاخر');
  });

  it('is refused when it is not one of the four', async () => {
    const res = await ask({ tone: 'shouting' });
    expect(res.status).toBe(400);
    expect(aiChat).not.toHaveBeenCalled();
  });
});

describe('the notes', () => {
  it('reach the brief when they speak of the product', async () => {
    await ask({ notes: 'ركّز على الريحة' });
    expect(briefSent()).toContain('ركّز على الريحة');
  });

  it('with a phone number in them, stop the call before the product is even read', async () => {
    const res = await ask({ notes: 'الزبون رقمه 0799123456' });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('NOTES_REFUSED');
    expect(aiChat).not.toHaveBeenCalled();
    expect(db.product.findFirst).not.toHaveBeenCalled();
  });
});
