import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A SHOPPER SEES THE SHOP'S IMAGES.
 *
 * Every stored image was linked through /api/media, which needs a session,
 * so the public pages showed broken images to every visitor. Public pages
 * now link them through /api/public/media, which serves an image only while
 * a public page shows it (or, for a storefront, its product is on sale) —
 * and never says whether a private one exists.
 */

const { db, readStoredFile, verifyPreviewToken } = vi.hoisted(() => ({
  db: {
    landingPage: { findFirst: vi.fn() },
    product: { findFirst: vi.fn(), findMany: vi.fn() },
  },
  readStoredFile: vi.fn(),
  verifyPreviewToken: vi.fn(),
}));

vi.mock('./db', () => ({ db }));
vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/storage', () => ({
  readStoredFile: (...a: unknown[]) => readStoredFile(...a),
  isSafeStorageKey: (k: string) => !k.includes('..'),
  // Read by `storefront-images.ts` (the shelf asks storage before it hands a
  // picture to a card). A folder that does not exist means «cannot judge»,
  // so every link these tests assert on is kept — see storefront-images.test.ts.
  STORAGE_PROVIDER: 'local',
  LOCAL_STORAGE_DIR: '/no-such-uploads-folder-in-this-test',
}));
vi.mock('@/lib/landing-pages', () => ({ verifyPreviewToken: (...a: unknown[]) => verifyPreviewToken(...a) }));

import { publicizeMedia, toPublicMedia } from './public-media';
import { forgetPublicMedia } from './public-media-server';
import { GET } from '@/app/api/public/media/[...parts]/route';
import { storefrontProduct, storefrontProducts } from './storefront';

const CO = 'e4fcc15a-05de-48e5-80d9-37bfd191adae';
const PAGE = '11111111-1111-4111-8111-111111111111';
const OTHER_PAGE = '33333333-3333-4333-8333-333333333333';
const PRODUCT = '22222222-2222-4222-8222-222222222222';
const FILE = '77fca75e-9831-4147-b8ef-9431e970e963.webp';
const privateUrl = (owner: string) => `/api/media/companies/${CO}/products/${owner}/${FILE}`;

const get = (parts: string[], query = '') =>
  GET(new Request(`http://localhost/api/public/media/${parts.join('/')}${query}`), { params: Promise.resolve({ parts }) });

/** A page as the rule reads it; published, showing nothing unless told. */
const pageRow = (over: Record<string, unknown> = {}) => ({
  id: PAGE, companyId: CO, isPublished: true, productId: null,
  sections: '[]', theme: null, htmlContent: null, cssContent: null, pageSettings: null, recommendations: [],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  forgetPublicMedia();
  db.landingPage.findFirst.mockResolvedValue(null);
  db.product.findFirst.mockResolvedValue(null);
  verifyPreviewToken.mockResolvedValue(null);
  readStoredFile.mockImplementation(async () => ({ stream: Readable.from([Buffer.from('img')]), mimeType: 'image/webp', size: 3 }));
});

describe('the links a public page renders', () => {
  it('are rewritten to the public route, without the company id', () => {
    expect(toPublicMedia(`<img src="${privateUrl(PAGE)}">`)).toBe(`<img src="/api/public/media/${PAGE}/${FILE}">`);
    expect(toPublicMedia(`url(${privateUrl(PAGE)})`)).not.toContain(CO);
  });

  it('name the page showing them — only path characters, which a theme backdrop accepts', () => {
    const out = toPublicMedia(privateUrl(OTHER_PAGE), { via: PAGE });
    expect(out).toBe(`/api/public/media/${PAGE}/${OTHER_PAGE}/${FILE}`);
    expect(out).toMatch(/^\/[A-Za-z0-9/_.\-]*$/);
  });

  it('carry the preview token for a frame that sends no cookies', () => {
    expect(toPublicMedia(privateUrl(PAGE), { via: PAGE, previewToken: 'tok en' })).toBe(
      `/api/public/media/${PAGE}/${PAGE}/${FILE}?p=tok%20en`
    );
  });

  it('reach every image in a block list or theme, whatever its shape', () => {
    const sections = [{ type: 'hero', image: privateUrl(PAGE) }, { type: 'gallery', images: [privateUrl(PAGE), 'https://cdn.example.com/a.jpg'] }];
    const out = publicizeMedia(sections, { via: PAGE });
    expect(JSON.stringify(out)).not.toContain('/api/media/');
    expect((out[1] as { images: string[] }).images[1]).toBe('https://cdn.example.com/a.jpg'); // someone else's link is left alone
  });

  it('leave values with no stored image untouched, and nothing at all as nothing', () => {
    const v = { a: 1 };
    expect(publicizeMedia(v)).toBe(v);
    expect(publicizeMedia(null)).toBeNull();
  });
});

describe('an image a landing page shows', () => {
  it('its own image, while it is published — from its own company folder', async () => {
    db.landingPage.findFirst.mockResolvedValue(pageRow());
    const res = await get([PAGE, PAGE, FILE]);
    expect(res.status).toBe(200);
    expect(readStoredFile).toHaveBeenCalledWith(`companies/${CO}/products/${PAGE}/${FILE}`);
  });

  it('refused while the page is a draft', async () => {
    db.landingPage.findFirst.mockResolvedValue(pageRow({ isPublished: false }));
    expect((await get([PAGE, PAGE, FILE])).status).toBe(404);
    expect(readStoredFile).not.toHaveBeenCalled();
  });

  it('a draft with its own preview token — and not with another page\'s', async () => {
    db.landingPage.findFirst.mockResolvedValue(pageRow({ isPublished: false }));
    verifyPreviewToken.mockResolvedValue({ lpId: PAGE });
    const res = await get([PAGE, PAGE, FILE], '?p=t');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');

    verifyPreviewToken.mockResolvedValue({ lpId: OTHER_PAGE });
    expect((await get([PAGE, PAGE, FILE], '?p=t')).status).toBe(404);
  });

  it('an image in another page\'s folder that this page references — a duplicated page', async () => {
    db.landingPage.findFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      where.id === PAGE
        ? pageRow({ sections: JSON.stringify([{ type: 'hero', image: privateUrl(OTHER_PAGE) }]) })
        : where.id === OTHER_PAGE && where.companyId === CO ? { companyId: CO } : null
    );
    const res = await get([PAGE, OTHER_PAGE, FILE]);
    expect(res.status).toBe(200);
    expect(readStoredFile).toHaveBeenCalledWith(`companies/${CO}/products/${OTHER_PAGE}/${FILE}`);
  });

  it('refused for another page\'s image this page does not reference', async () => {
    db.landingPage.findFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      where.id === PAGE ? pageRow() : { companyId: CO }
    );
    expect((await get([PAGE, OTHER_PAGE, FILE])).status).toBe(404);
  });

  it('refused for another COMPANY\'s folder, even when referenced', async () => {
    db.landingPage.findFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      where.id === PAGE ? pageRow({ htmlContent: `<img src="${FILE}">` }) : null // not of CO
    );
    expect((await get([PAGE, OTHER_PAGE, FILE])).status).toBe(404);
  });

  it('the photo of the product it sells, whatever the product\'s status', async () => {
    db.landingPage.findFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      where.id === PAGE ? pageRow({ productId: PRODUCT }) : null
    );
    db.product.findFirst.mockResolvedValue({ companyId: CO });
    expect((await get([PAGE, PRODUCT, FILE])).status).toBe(200);
    expect(db.product.findFirst.mock.calls[0][0].where).toEqual({ id: PRODUCT, companyId: CO });
  });

  it('the photo of an add-on it offers', async () => {
    db.landingPage.findFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      where.id === PAGE ? pageRow({ recommendations: [{ productId: PRODUCT }] }) : null
    );
    db.product.findFirst.mockResolvedValue({ companyId: CO });
    expect((await get([PAGE, PRODUCT, FILE])).status).toBe(200);
  });

  it('remembers an answer for a minute — one lookup per image, not per request', async () => {
    db.landingPage.findFirst.mockResolvedValue(pageRow());
    await get([PAGE, PAGE, FILE]);
    await get([PAGE, PAGE, FILE]);
    expect(db.landingPage.findFirst).toHaveBeenCalledTimes(1);
  });
});

describe('a storefront\'s product image', () => {
  it('served for an active product of an open storefront', async () => {
    db.product.findFirst.mockResolvedValue({ companyId: CO, store: { storefrontEnabled: true, status: 'ACTIVE' } });
    expect((await get([PRODUCT, FILE])).status).toBe(200);
    expect(db.product.findFirst.mock.calls[0][0].where).toMatchObject({ id: PRODUCT, status: 'ACTIVE' });
  });

  it('refused when the store is closed, or the product off sale', async () => {
    db.product.findFirst.mockResolvedValue({ companyId: CO, store: { storefrontEnabled: false, status: 'ACTIVE' } });
    expect((await get([PRODUCT, FILE])).status).toBe(404);
    forgetPublicMedia();
    db.product.findFirst.mockResolvedValue(null);
    expect((await get([PRODUCT, FILE])).status).toBe(404);
  });
});

describe('a page image asked for without its page', () => {
  it('is refused even when the page is published: a page image is always asked for through the page', async () => {
    db.landingPage.findFirst.mockResolvedValue(pageRow());
    expect((await get([PAGE, FILE])).status).toBe(404);
  });
});

describe('what is never an image request', () => {
  it('anything that is not ids and a stored file name', async () => {
    for (const parts of [['not-a-uuid', FILE], [PAGE, '../secret.webp'], [PAGE, 'x.svg'], [PAGE, `${FILE}.html`], [FILE], [PAGE, PAGE, PAGE, FILE], ['bad', PAGE, FILE]]) {
      expect((await get(parts)).status, parts.join('/')).toBe(404);
    }
    expect(db.landingPage.findFirst).not.toHaveBeenCalled();
  });

  it('a missing file answers like a private one', async () => {
    db.landingPage.findFirst.mockResolvedValue(pageRow());
    readStoredFile.mockResolvedValue(null);
    expect((await get([PAGE, PAGE, FILE])).status).toBe(404);
  });
});

describe('the storefront', () => {
  it('lists and shows products with public image links', async () => {
    const row = {
      id: PRODUCT, sku: 'SKU1', name: 'كريم', description: null, image: privateUrl(PRODUCT), basePrice: 10,
      offers: [], images: [{ url: privateUrl(PRODUCT) }],
    };
    db.product.findMany.mockResolvedValue([row]);
    db.product.findFirst.mockResolvedValue(row);

    const [listed] = await storefrontProducts('c1', 's1');
    expect(listed.image).toBe(`/api/public/media/${PRODUCT}/${FILE}`);

    const one = await storefrontProduct('c1', 's1', 'sku1');
    expect(one!.image).toBe(`/api/public/media/${PRODUCT}/${FILE}`);
    expect(one!.gallery.every((u) => u.startsWith('/api/public/media/'))).toBe(true);
  });
});
