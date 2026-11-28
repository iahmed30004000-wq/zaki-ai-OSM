import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «التصميم» IN THE DOORS OF «البوليصة المطبوعة» (27/11): chosen per store, «التصميم الأساسي» first and stored as no
 * design at all; a logo upload or removal never changes it; the preview draws the chosen design on made-up orders and
 * reads no order of the store; a value nobody offers is refused.
 */

const { db, settings } = vi.hoisted(() => ({
  db: { store: { findFirst: vi.fn() }, company: { findUnique: vi.fn() }, order: { findMany: vi.fn() } },
  settings: { doc: undefined as unknown },
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/auth', () => ({ requireCompanyTenant: async () => ({ user: { id: 'u1' }, companyId: 'c1' }) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: vi.fn() }));
vi.mock('@/lib/company-settings', () => ({
  updateCompanySettings: async (_c: string, _k: string, change: (cur: unknown) => unknown) => {
    settings.doc = change(settings.doc);
    return settings.doc;
  },
}));
vi.mock('@/lib/storage', async (orig) => ({
  ...(await orig<typeof import('@/lib/storage')>()),
  saveProductImage: async () => ({ url: '/api/media/companies/c1/products/11111111-1111-4111-8111-111111111111/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.webp' }),
}));

import { GET, PUT } from './route';
import { POST as UPLOAD, DELETE as REMOVE } from './logo/route';
import { POST as PREVIEW } from './preview/route';

const A = '11111111-1111-4111-8111-111111111111';
const ctx = { params: Promise.resolve({ id: A }) };
const json = (method: string, body: unknown) =>
  new Request('http://x', { method, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
const save = (body: unknown) => PUT(json('PUT', body), ctx);
const read = async () => (await GET(new Request('http://x'), ctx)).json();
const preview = async (body: Record<string, unknown>) => {
  const res = await PREVIEW(json('POST', { width: 100, height: 150, hide: [], logo: 'store', ...body }), ctx);
  return { status: res.status, html: await res.text() };
};
const entry = () => (settings.doc as { stores: Record<string, Record<string, unknown>> }).stores[A];

beforeEach(() => {
  vi.clearAllMocks();
  settings.doc = undefined;
  db.store.findFirst.mockResolvedValue({ id: A, name: 'متجر', logo: null, supportPhone: null });
  db.company.findUnique.mockImplementation(async () => ({
    settings: settings.doc === undefined ? null : JSON.stringify({ waybillPrint: settings.doc }),
  }));
});

describe('the choice', () => {
  it('the screen is given «التصميم الأساسي» first, then أ and ب, and the offer’s switch apart', async () => {
    const got = await read();
    expect(got.designs).toEqual([
      { value: 'classic', ar: 'التصميم الأساسي' },
      { value: 'a', ar: 'التصميم أ' },
      { value: 'b', ar: 'التصميم ب' },
    ]);
    expect(got.designElements).toEqual([{ key: 'offer', ar: 'بطاقة العرض (اسم العرض)', locked: false }]);
    expect(got.elements.map((e: { key: string }) => e.key)).not.toContain('offer');
    expect(got.settings).toEqual({ hide: [], logo: 'store' });
  });

  it('a design is saved for this store; «التصميم الأساسي» stores no design', async () => {
    expect((await save({ hide: ['offer', 'qr'], logo: 'none', design: 'a' })).status).toBe(200);
    expect(entry()).toEqual({ hide: ['qr', 'offer'], logo: 'none', design: 'a' });
    expect((await read()).settings).toEqual({ hide: ['qr', 'offer'], logo: 'none', design: 'a' });
    expect((await save({ hide: [], logo: 'store', design: 'classic' })).status).toBe(200);
    expect(entry()).toEqual({ hide: [], logo: 'store' });
    await save({ hide: [], logo: 'store', design: 'b' });
    await save({ hide: [], logo: 'store' });
    expect(entry()).toEqual({ hide: [], logo: 'store' });
  });

  it.each(['c', '', 'A', 1, null])('NEGATIVE: «%s» is no design — refused in Arabic, nothing written', async (design) => {
    const res = await save({ hide: [], logo: 'store', design });
    expect(res.status).toBe(400);
    expect((await res.json()).errorAr).toMatch(/[؀-ۿ]/);
    expect(settings.doc).toBeUndefined();
  });

  it('a logo upload and its removal leave the design as it was', async () => {
    await save({ hide: ['note'], logo: 'store', design: 'b' });
    const form = new FormData();
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
    form.append('file', new File([new Uint8Array(png)], 'logo.png', { type: 'image/png' }));
    expect((await UPLOAD(new Request('http://x', { method: 'POST', body: form }), ctx)).status).toBe(200);
    expect(entry()).toMatchObject({ hide: ['note'], logo: 'own', design: 'b' });
    expect((await REMOVE(new Request('http://x'), ctx)).status).toBe(200);
    expect(entry()).toEqual({ hide: ['note'], logo: 'store', design: 'b' });
  });
});

describe('the preview', () => {
  it('«التصميم الأساسي»: one made-up order on the current waybill, the same page as with no design sent', async () => {
    const a = await preview({});
    const b = await preview({ design: 'classic' });
    expect(a.status).toBe(200);
    expect(b.html).toBe(a.html);
    expect(a.html).not.toContain('wb-');
    expect(a.html.match(/<section /g)).toHaveLength(1);
  });

  it.each(['a', 'b'])('design «%s»: two made-up orders — one product with its ticket, and several — and no order is read', async (design) => {
    const p = await preview({ design });
    expect(p.status).toBe(200);
    expect([...p.html.matchAll(/data-order="([^"]+)"/g)].map((m) => m[1])).toEqual(['preview-1', 'preview-2']);
    expect(p.html).toContain(`wb wb-${design} `);
    expect(p.html).toContain('قطعتين + قطعة هدية');
    // Design ب sets the number and its word apart, so the page is read as words.
    expect(p.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).toContain('3 عبوات');
    expect(db.order.findMany).not.toHaveBeenCalled();
    expect((await preview({ design, hide: ['offer'] })).html).not.toContain('class="wb-ticket"');
  });

  it.each(['a', 'b'])('design «%s» on a paper under 70 mm: the preview is the current waybill, as the print will be', async (design) => {
    const small = { width: 60, height: 40 };
    const basic = await preview(small);
    const chosen = await preview({ ...small, design });
    expect(chosen.status).toBe(200);
    expect(chosen.html).toBe(basic.html);
    expect(chosen.html).not.toContain('wb-');
    expect((await preview({ ...small, design, hide: ['offer'] })).html).toBe(basic.html);
    expect((await preview({ width: 70, height: 70, design })).html).toContain(`wb wb-${design} `);
  });

  it('NEGATIVE: a design nobody offers is refused', async () => {
    expect((await preview({ design: 'z' })).status).toBe(400);
  });
});
