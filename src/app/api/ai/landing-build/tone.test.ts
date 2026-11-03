import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «ابنيلي صفحة الهبوط» HEARS THE WIZARD'S VOICE — and refuses one that is
 * not among the four, before anything is read or sent.
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
vi.mock('@/lib/storage', () => ({ readStoredFile: vi.fn(async () => null) }));
vi.mock('@/lib/ai-provider', () => ({
  AiNotConfigured: class extends Error {},
  aiChat: (...a: unknown[]) => aiChat(...a),
  describeRoute: async () => ({ provider: 'openai', model: 'text-only' }),
}));

import { POST } from './route';

const PRODUCT_ID = '11111111-1111-4111-8111-111111111111';

const ask = (body: Record<string, unknown>) =>
  POST(
    new Request('http://localhost/api/ai/landing-build', {
      method: 'POST',
      body: JSON.stringify({ productId: PRODUCT_ID, ...body }),
    })
  );

const briefSent = () => (aiChat.mock.calls[0][0] as { user: string }).user;

beforeEach(() => {
  vi.clearAllMocks();
  db.product.findFirst.mockResolvedValue({
    id: PRODUCT_ID, name: 'كريم', nameEn: null, description: 'مرطّب', attributes: null, category: null, images: [],
  });
  aiChat.mockResolvedValue(JSON.stringify({ nameAr: 'كريم', tagline: 'جملة' }));
});

describe('the build door and the voice', () => {
  it('puts the chosen voice in the brief as its one sentence', async () => {
    const res = await ask({ tone: 'expert' });
    expect(res.status).toBe(200);
    expect(briefSent()).toContain('الأسلوب: خبير وواقعي');
  });

  it('sends no voice when none was chosen', async () => {
    await ask({});
    expect(briefSent()).not.toContain('الأسلوب:');
  });

  it('refuses a voice that is not one of the four, with no product read and no call made', async () => {
    const res = await ask({ tone: 'shouting' });
    expect(res.status).toBe(400);
    expect(db.product.findFirst).not.toHaveBeenCalled();
    expect(aiChat).not.toHaveBeenCalled();
  });
});
