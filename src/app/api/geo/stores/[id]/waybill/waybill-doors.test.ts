import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';

/**
 * «البوليصة المطبوعة» — THE DOORS (25/11, F15): who may read, save, upload and preview; that a store's choice is
 * written under that store only; that the courier's parts cannot be hidden; and that the own logo goes through the
 * storage pipeline's checks (type by claim AND by bytes, a size cap). People are built by the real permission engine.
 */

const { db, current, settings, saveProductImage, logAudit } = vi.hoisted(() => ({
  db: { store: { findFirst: vi.fn() }, company: { findUnique: vi.fn() } },
  current: { user: null as unknown as SessionUser },
  settings: { doc: undefined as unknown },
  saveProductImage: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/auth', () => ({ requireCompanyTenant: async () => ({ user: current.user, companyId: 'c1' }) }));
vi.mock('@/lib/company-settings', () => ({
  updateCompanySettings: async (_c: string, _k: string, change: (cur: unknown) => unknown) => {
    settings.doc = change(settings.doc);
    return settings.doc;
  },
}));
vi.mock('@/lib/storage', async (orig) => ({
  ...(await orig<typeof import('@/lib/storage')>()),
  saveProductImage: (...a: unknown[]) => saveProductImage(...a),
}));
vi.mock('@/lib/authorization', async (orig) => {
  const real = await orig<typeof import('@/lib/authorization')>();
  return {
    ...real,
    requirePermission: async (k: string) => {
      if (!real.can(current.user, k)) throw new Error(`Forbidden: missing required permission ${k}`);
      return current.user;
    },
  };
});

import { attachGrants } from '@/lib/authorization';
import { computeEffectiveGrants } from '@/lib/permissions-core';
import { GET, PUT } from './route';
import { POST as UPLOAD, DELETE as REMOVE } from './logo/route';
import { POST as PREVIEW } from './preview/route';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const FILE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.webp';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

let n = 0;
async function as(keys: string[], opts: { legacy?: string } = {}) {
  const base = {
    id: `u${++n}`, email: 'u@x', name: 'موظف', role: opts.legacy ?? 'CUSTOM', roleId: opts.legacy ? null : 'r1',
    status: 'ACTIVE', companyId: 'c1',
  } as unknown as SessionUser;
  current.user = attachGrants(
    base,
    await computeEffectiveGrants(base as never, {
      roleRows: async () => keys.map((k) => ({ permission: k, scope: 'ALL_COMPANY', scopeIds: null })),
      overrideRows: async () => [],
    })
  );
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const put = (id: string, body: unknown) =>
  PUT(new Request('http://x/api/geo/stores/x/waybill', { method: 'PUT', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }), ctx(id));
const get = (id: string) => GET(new Request('http://x/api/geo/stores/x/waybill'), ctx(id));
function upload(id: string, bytes: Buffer, type: string, name = 'logo.png') {
  const form = new FormData();
  form.append('file', new File([new Uint8Array(bytes)], name, { type }));
  return UPLOAD(new Request('http://x/api/geo/stores/x/waybill/logo', { method: 'POST', body: form }), ctx(id));
}
const preview = (id: string, body: unknown) =>
  PREVIEW(new Request('http://x/api/geo/stores/x/waybill/preview', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }), ctx(id));

const MANAGER = ['geo.view', 'geo.manage'];

beforeEach(() => {
  vi.clearAllMocks();
  settings.doc = undefined;
  // Two stores of company c1; anything else is not this company's.
  db.store.findFirst.mockImplementation(async ({ where }: { where: { id: string; companyId: string } }) =>
    where.companyId === 'c1' && (where.id === A || where.id === B)
      ? { id: where.id, name: 'متجر', logo: null, supportPhone: null }
      : null
  );
  db.company.findUnique.mockImplementation(async () => ({
    settings: settings.doc === undefined ? null : JSON.stringify({ waybillPrint: settings.doc }),
  }));
  saveProductImage.mockImplementation(async ({ productId }: { productId: string }) => ({
    url: `/api/media/companies/c1/products/${productId}/${FILE}`, fileName: FILE, storageKey: 'k', mimeType: 'image/webp', fileSize: 10,
  }));
});

describe('who may do what — through the real permission engine', () => {
  it('«geo.view» reads and previews; it may not save, upload or remove', async () => {
    await as(['geo.view']);
    expect((await get(A)).status).toBe(200);
    expect((await preview(A, { hide: [], logo: 'store' })).status).toBe(200);
    expect((await put(A, { hide: ['qr'], logo: 'store' })).status).toBe(403);
    expect((await upload(A, PNG, 'image/png')).status).toBe(403);
    expect((await REMOVE(new Request('http://x'), ctx(A))).status).toBe(403);
    expect(settings.doc).toBeUndefined();
    expect(saveProductImage).not.toHaveBeenCalled();
  });

  it('NEGATIVE: with neither key, every door is refused and nothing is read', async () => {
    await as(['orders.view', 'ops.labels']);
    for (const res of [await get(A), await preview(A, { hide: [], logo: 'store' }), await put(A, { hide: [], logo: 'store' }), await upload(A, PNG, 'image/png')]) {
      expect(res.status).toBe(403);
      expect((await res.json()).errorAr).toMatch(/[؀-ۿ]/);
    }
    expect(db.store.findFirst).not.toHaveBeenCalled();
  });

  it('«geo.manage» saves; and so does a legacy account with no role row (COMPANY_ADMIN)', async () => {
    await as(MANAGER);
    expect((await put(A, { hide: ['qr'], logo: 'none' })).status).toBe(200);
    await as([], { legacy: 'COMPANY_ADMIN' });
    expect((await put(A, { hide: ['note'], logo: 'store' })).status).toBe(200);
  });

  it('NEGATIVE: a legacy account with no role row and no geo key (MODERATOR) may not save', async () => {
    await as([], { legacy: 'MODERATOR' });
    expect((await put(A, { hide: ['note'], logo: 'store' })).status).toBe(403);
    expect(settings.doc).toBeUndefined();
  });
});

describe('one store’s choice is that store’s alone', () => {
  it('saving store A leaves store B printing today’s waybill', async () => {
    await as(MANAGER);
    await put(A, { hide: ['qr', 'items'], logo: 'none' });
    const a = await (await get(A)).json();
    const b = await (await get(B)).json();
    expect(a.settings).toEqual({ hide: ['items', 'qr'], logo: 'none' });
    expect(b.settings).toEqual({ hide: [], logo: 'store' });
    expect(Object.keys((settings.doc as { stores: object }).stores)).toEqual([A]);
  });

  it('NEGATIVE: a store of another company is «not found» on every door, and nothing is written', async () => {
    await as(MANAGER);
    const other = '33333333-3333-4333-8333-333333333333';
    for (const res of [await get(other), await put(other, { hide: [], logo: 'store' }), await upload(other, PNG, 'image/png'), await preview(other, { hide: [], logo: 'store' })]) {
      expect(res.status).toBe(404);
    }
    expect(settings.doc).toBeUndefined();
  });
});

describe('the courier’s parts are locked at the door too', () => {
  it.each(['name', 'phones', 'place', 'cod', 'barcode'])('NEGATIVE: PUT hiding «%s» → 400 COURIER_FIELD_LOCKED, nothing saved', async (k) => {
    await as(MANAGER);
    const res = await put(A, { hide: [k], logo: 'store' });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('COURIER_FIELD_LOCKED');
    expect(settings.doc).toBeUndefined();
  });

  it('NEGATIVE: the preview refuses them the same way', async () => {
    await as(MANAGER);
    const res = await preview(A, { hide: ['barcode'], logo: 'store' });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('COURIER_FIELD_LOCKED');
  });
});

describe('the own logo goes through the storage checks', () => {
  it('a PNG is stored in THIS store’s folder, picked for the waybill, and kept by a later save', async () => {
    await as(MANAGER);
    const res = await upload(A, PNG, 'image/png');
    expect(res.status).toBe(200);
    const url = `/api/media/companies/c1/products/${A}/${FILE}`;
    expect((await res.json()).waybillLogo).toBe(url);
    expect(saveProductImage).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'c1', productId: A, maxDimension: 600 }));
    await put(A, { hide: ['qr'], logo: 'own' });
    expect((settings.doc as { stores: Record<string, unknown> }).stores[A]).toEqual({ hide: ['qr'], logo: 'own', ownLogo: url });
    const got = await (await get(A)).json();
    expect(got.ownLogo).toBe(url);
  });

  it('NEGATIVE: an SVG by its type is refused before anything is read', async () => {
    await as(MANAGER);
    const res = await upload(A, SVG, 'image/svg+xml', 'logo.svg');
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('BAD_TYPE');
    expect(saveProductImage).not.toHaveBeenCalled();
  });

  it('NEGATIVE: an SVG renamed and labelled as a PNG is refused by its bytes', async () => {
    await as(MANAGER);
    const res = await upload(A, SVG, 'image/png', 'logo.png');
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('BAD_TYPE');
    expect(saveProductImage).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a file over two megabytes is refused', async () => {
    await as(MANAGER);
    const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]);
    const res = await upload(A, big, 'image/png');
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('TOO_BIG');
    expect(saveProductImage).not.toHaveBeenCalled();
  });

  it('NEGATIVE: «شعار خاص» cannot be picked before one is uploaded', async () => {
    await as(MANAGER);
    const res = await put(A, { hide: [], logo: 'own' });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('NO_OWN_LOGO');
  });

  it('removing it sends the waybill back to the store’s logo', async () => {
    await as(MANAGER);
    await upload(A, PNG, 'image/png');
    expect((await REMOVE(new Request('http://x'), ctx(A))).status).toBe(200);
    expect((settings.doc as { stores: Record<string, unknown> }).stores[A]).toEqual({ hide: [], logo: 'store' });
  });
});

describe('the preview is the print renderer’s page, and commits nothing', () => {
  it('draws the made-up order without the left-off part, in PDF mode, paper only', async () => {
    await as(['geo.view']);
    const res = await preview(A, { hide: ['qr'], logo: 'store', width: 100, height: 150 });
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const html = await res.text();
    expect(html).toContain('<section class="label');
    expect(html).not.toContain('<figure class="qr">');
    expect(html).toContain('var PDF = true');
    expect(html).toContain('.bar, .setup { display: none; }');
    // No order of the store was read: only the store row.
    expect(Object.keys(db)).toEqual(['store', 'company']);
  });

  it('NEGATIVE: a paper outside 40–300 mm is refused', async () => {
    await as(['geo.view']);
    const res = await preview(A, { hide: [], logo: 'store', width: 10, height: 150 });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('BAD_SIZE');
  });
});
