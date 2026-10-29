import { beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizePhoneNumber } from '@/lib/phone';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@/lib/guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «ارقام الهواتف بالادخال بال ai حولها برمجيا من عربي لانجليزي» — THE OWNER, 22/10.
 *
 * The preview of an order read by the assistant carried whatever digits the MODEL wrote: a model shown «٠٧٩١٢٣٤٥٦٧»
 * answers «٠٧٩١٢٣٤٥٦٧» as often as not — and `parseInt('٣', 10)` is NaN, so «الكمية: ٣» silently became a quantity of ONE.
 * The phone, the quantity and the price are made Latin in CODE, before they are returned, whichever engine read the text;
 * and a phone the reviewer types in Arabic digits is stored and checked as Latin.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, requirePermission, aiChat, activeBlock, findOrCreateCustomer, orderRefFields, productCost, resolveRegionId } = vi.hoisted(() => ({
  db: {
    product: { findMany: vi.fn(), findFirst: vi.fn() },
    customer: { findFirst: vi.fn(), update: vi.fn() },
    store: { findFirst: vi.fn(async () => ({ priceIncludesDelivery: false })) },
    user: { findFirst: vi.fn() },
    order: { create: vi.fn() },
    orderItem: { create: vi.fn() },
    orderActivity: { create: vi.fn() },
    $transaction: vi.fn(async (fn: unknown) => (typeof fn === 'function' ? (fn as (tx: unknown) => unknown)(db) : fn)),
  },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  aiChat: vi.fn(),
  activeBlock: vi.fn(),
  findOrCreateCustomer: vi.fn(),
  orderRefFields: vi.fn(),
  productCost: vi.fn(),
  resolveRegionId: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
// OLD → NEW (PR-5): `can: () => false` for everything. The model is asked only for a person who holds the assistants' key
// (`ai.assist`), and this file is about what the model WROTE — so that one key is held; every other question is still «no».
vi.mock('@/lib/authorization', () => ({ can: (_u: unknown, k: string) => k === 'ai.assist', requirePermission: (...a: unknown[]) => requirePermission(...a) }));
vi.mock('@/lib/notify', () => ({ notify: vi.fn() }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/offers', () => ({ activeOffersFor: vi.fn(async () => []) }));
vi.mock('@/lib/blacklist', () => ({ activeBlock: (...a: unknown[]) => activeBlock(...a) }));
vi.mock('@/lib/customer-identity', () => ({ findOrCreateCustomer: (...a: unknown[]) => findOrCreateCustomer(...a) }));
vi.mock('@/lib/order-ref', () => ({ orderRefFields: (...a: unknown[]) => orderRefFields(...a) }));
vi.mock('@/lib/product-cost', () => ({ productCost: (...a: unknown[]) => productCost(...a) }));
vi.mock('@/lib/regions', () => ({ resolveRegionId: (...a: unknown[]) => resolveRegionId(...a) }));
vi.mock('@/lib/ai-prompts', () => ({ resolvePrompt: () => 'prompt' }));
vi.mock('@/lib/ai-provider', () => {
  class AiNotLocal extends Error {}
  class AiNotConfigured extends Error {}
  class AiEndpointMissing extends Error {}
  return { AiNotLocal, AiNotConfigured, AiEndpointMissing, aiChat: (...a: unknown[]) => aiChat(...a), aiSettings: async () => ({ prompts: {} }) };
});

import { POST } from './route';
import { AiNotLocal } from '@/lib/ai-provider';

const AR_PHONE = '٠٧٩١٢٣٤٥٦٧';
const FA_PHONE = '۰۷۹۱۲۳۴۵۶۷';
const NON_LATIN = /[٠-٩۰-۹]/;

const preview = (text: string) =>
  POST(
    new Request('http://localhost/api/orders/ai-intake', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })
  );

const model = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ customerName: 'سارة علي', phone: AR_PHONE, governorate: 'عمّان', address: 'الدوّار السابع', productQuery: 'كريم', quantity: '٣', price: '٢٥.٥', notes: '', source: '', ...over });

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'هدى', role: 'CONFIRMATION_AGENT' },
    companyId: 'c1',
    storeId: 's1',
    countryId: 'co1',
    country: { id: 'co1', code: 'JO', minorUnit: 2, currencyCode: 'JOD', orderPrefix: 'ORD' },
  });
  requirePermission.mockResolvedValue(undefined);
  db.product.findMany.mockResolvedValue([{ id: 'prod-000000001', name: 'كريم مرطّب', sku: 'CRM-1' }]);
  db.customer.findFirst.mockResolvedValue(null);
  aiChat.mockResolvedValue(model());
});

describe('the assistant read the text', () => {
  it('— a phone, a quantity and a price the MODEL wrote in Arabic digits reach the reviewer in Latin ones', async () => {
    const body = await (await preview('الاسم: سارة علي\nالرقم: ٠٧٩١٢٣٤٥٦٧')).json();
    expect(body.engine).toBe('ai');
    expect(body.parsed.phone).toBe('0791234567');
    expect(body.parsed.quantity, '«٣» صارت واحداً').toBe(3);
    expect(body.parsed.price).toBe(25.5);
  });

  it('and so do Persian ones', async () => {
    aiChat.mockResolvedValue(model({ phone: FA_PHONE, quantity: '۲', price: '۴۰' }));
    const body = await (await preview('x')).json();
    expect([body.parsed.phone, body.parsed.quantity, body.parsed.price]).toEqual(['0791234567', 2, 40]);
  });

  it('and a price the model did not write the way a number is written is NO price — never a zero, never sixteen', async () => {
    for (const price of ['', '0x10', '٢٥,٥', 'free']) {
      aiChat.mockResolvedValue(model({ price }));
      const body = await (await preview('x')).json();
      expect(body.parsed.price, JSON.stringify(price)).toBeNull();
    }
  });

  it('and a phone the model wrapped in spaces comes back without them', async () => {
    aiChat.mockResolvedValue(model({ phone: '  ٠٧٩١٢٣٤٥٦٧ ' }));
    const body = await (await preview('x')).json();
    expect(body.parsed.phone).toBe('0791234567');
  });

  it('and a phone the model left out is filled from the text by the deterministic parser — in Latin digits', async () => {
    aiChat.mockResolvedValue(model({ phone: '' }));
    const body = await (await preview('الاسم: سارة علي\nالرقم: ٠٧٩١٢٣٤٥٦٧')).json();
    expect(body.parsed.phone).toBe('0791234567');
  });

  it('and a number the model already wrote in Latin digits is exactly what it was', async () => {
    aiChat.mockResolvedValue(model({ phone: '0791234567', quantity: 3, price: 25.5 }));
    const body = await (await preview('x')).json();
    expect([body.parsed.phone, body.parsed.quantity, body.parsed.price]).toEqual(['0791234567', 3, 25.5]);
  });

  it('and the duplicate check still asks about the one number a customer is stored under — nothing about it moved', async () => {
    await preview('x');
    const where = db.customer.findFirst.mock.calls[0][0].where;
    expect(where.phone.in).toContain(normalizePhoneNumber('0791234567'));
    expect(NON_LATIN.test(where.phone.in.join(''))).toBe(false);
  });

  it('and nothing in what comes back is in another script — whatever the model wrote', async () => {
    for (const phone of [AR_PHONE, FA_PHONE, `+٩٦٢ ٧٩ ١٢٣٤٥٦٧`, '٠٧٩-١٢٣-٤٥٦٧']) {
      aiChat.mockResolvedValue(model({ phone }));
      const body = await (await preview('x')).json();
      expect(NON_LATIN.test(body.parsed.phone), phone).toBe(false);
    }
  });
});

describe('the assistant did not read the text — the deterministic parser did', () => {
  it('— an Arabic-digit phone, quantity and price are Latin in the preview', async () => {
    aiChat.mockRejectedValue(new AiNotLocal('OPENROUTER'));
    const body = await (await preview('الاسم: سارة علي\nالرقم: ٠٧٩١٢٣٤٥٦٧\nالكمية: ٣\nالسعر: ٢٥')).json();
    expect(body.engine).toBe('deterministic');
    expect([body.parsed.phone, body.parsed.quantity, body.parsed.price]).toEqual(['0791234567', 3, 25]);
  });
});

describe('the reviewer confirms', () => {
  const confirm = (phone: string) =>
    POST(
      new Request('http://localhost/api/orders/ai-intake', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confirm: true,
          parsed: { customerName: 'سارة علي', phone, address: 'عمّان', governorate: 'عمّان', productId: 'prod-000000001', quantity: 2, finalPrice: 25 },
        }),
      })
    );

  beforeEach(() => {
    activeBlock.mockResolvedValue(null);
    findOrCreateCustomer.mockResolvedValue({ id: 'cu1', city: 'عمّان', firstOrderDate: null });
    orderRefFields.mockResolvedValue({ orderNumber: 'ORD-1', merchantRef: 'ORD-1' });
    productCost.mockResolvedValue({ average: 7 });
    db.product.findFirst.mockResolvedValue({ id: 'prod-000000001', name: 'كريم مرطّب', image: null, basePrice: 14, batches: [] });
    db.order.create.mockResolvedValue({ id: 'o1', orderNumber: 'ORD-1' });
    db.user.findFirst.mockResolvedValue({ id: 'u1', commissionRate: 0 });
  });

  it('— a phone typed in Arabic digits is stored as Latin, and the blacklist is asked about the Latin one', async () => {
    await confirm(AR_PHONE);
    const customer = findOrCreateCustomer.mock.calls[0][1];
    expect(customer.rawPhone).toBe('0791234567');
    expect(customer.phone).toBe(normalizePhoneNumber('0791234567'));
    expect(activeBlock.mock.calls[0][2]).toBe('0791234567');
  });

  it('and one already in Latin digits is stored as it was — the door’s own trim of its edges untouched', async () => {
    await confirm(' 0791234567 ');
    expect(findOrCreateCustomer.mock.calls[0][1].rawPhone).toBe('0791234567');
  });
});

describe('how it is done', () => {
  const src = () => stripComments(readFileSync(join(process.cwd(), 'src/app/api/orders/ai-intake/route.ts'), 'utf8'));

  it('— by code, from one function: the route reads the model’s numbers through `toLatinDigits`, and never trusts the model to', () => {
    expect(src()).toContain("from '@/lib/latin-digits'");
    expect(src()).toMatch(/phone: toLatinDigits\(String\(parsed\.phone/);
    expect(src()).toMatch(/parseInt\(toLatinDigits\(String\(parsed\.quantity/);
    expect(src()).toMatch(/const phone = toLatinDigits\(p\.phone\)/);
  });
});
