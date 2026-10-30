import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A8 — A FILE IN A PRODUCT'S FOLDER IS PUBLIC ON ITS OWN ONLY IF THE PRODUCT STILL SHOWS IT.
 *
 * Off by default (`PUBLIC_MEDIA_STRICT`): the old rule, every file of an active product in an
 * open shop, stays exactly as it was, so a published picture never breaks by shipping this.
 * On: the main picture, a gallery picture, or a picture written into the description.
 */

const { db } = vi.hoisted(() => ({
  db: { landingPage: { findFirst: vi.fn() }, product: { findFirst: vi.fn() } },
}));
vi.mock('./db', () => ({ db }));

import { forgetPublicMedia, publicMediaCompany } from './public-media-server';

const PRODUCT = '22222222-2222-4222-8222-222222222222';
const CURRENT = '77fca75e-9831-4147-b8ef-9431e970e963.webp';
const GALLERY = '11111111-aaaa-4bbb-8ccc-dddddddddddd.webp';
const INTEXT = '22222222-aaaa-4bbb-8ccc-dddddddddddd.webp';
const OLD = '99999999-aaaa-4bbb-8ccc-dddddddddddd.webp';
const url = (file: string) => `/api/media/companies/co1/products/${PRODUCT}/${file}`;

const OPEN_SHOP = { storefrontEnabled: true, status: 'ACTIVE' };
const product = (over: Record<string, unknown> = {}) => ({
  companyId: 'co1',
  store: OPEN_SHOP,
  image: url(CURRENT),
  description: `<p>نص</p><img src="${url(INTEXT)}">`,
  descriptionEn: null,
  images: [{ url: url(GALLERY) }],
  ...over,
});
const ask = (file: string) => publicMediaCompany({ owner: PRODUCT, file, via: null, previewPageId: null });

beforeEach(() => {
  vi.clearAllMocks();
  forgetPublicMedia();
  delete process.env.PUBLIC_MEDIA_STRICT;
  db.product.findFirst.mockImplementation(async (args: { select: Record<string, unknown> }) => {
    // the row as the database would give it: only the columns the query asked for
    const row = product();
    return Object.fromEntries(Object.entries(row).filter(([k]) => k in args.select));
  });
});
afterEach(() => {
  delete process.env.PUBLIC_MEDIA_STRICT;
  forgetPublicMedia();
});

describe('with the strict rule OFF (the default) — nothing published changes', () => {
  it('every file of an active product in an open shop is public, as it always was', async () => {
    for (const file of [CURRENT, GALLERY, INTEXT, OLD]) {
      forgetPublicMedia();
      expect(await ask(file), file).toBe('co1');
    }
  });

  it('asks the database for exactly the columns it always asked for', async () => {
    await ask(CURRENT);
    expect(Object.keys(db.product.findFirst.mock.calls[0][0].select).sort()).toEqual(['companyId', 'store']);
  });
});

describe('with the strict rule ON', () => {
  beforeEach(() => {
    process.env.PUBLIC_MEDIA_STRICT = 'on';
  });

  it('PASSES the pictures the product shows: main, gallery, and one written into the description', async () => {
    for (const file of [CURRENT, GALLERY, INTEXT]) {
      forgetPublicMedia();
      expect(await ask(file), file).toBe('co1');
    }
  });

  it('REFUSES a file the product no longer shows — the replaced picture that is still in the folder', async () => {
    expect(await ask(OLD)).toBeNull();
  });

  it('still refuses what it always refused: an inactive product, a closed shop, an unknown product', async () => {
    db.product.findFirst.mockResolvedValueOnce(null);
    expect(await ask(CURRENT)).toBeNull();

    forgetPublicMedia();
    db.product.findFirst.mockResolvedValueOnce(product({ store: { storefrontEnabled: false, status: 'ACTIVE' } }));
    expect(await ask(CURRENT)).toBeNull();

    forgetPublicMedia();
    db.product.findFirst.mockResolvedValueOnce(product({ store: { storefrontEnabled: true, status: 'CLOSED' } }));
    expect(await ask(CURRENT)).toBeNull();

    forgetPublicMedia();
    db.product.findFirst.mockResolvedValueOnce(product({ store: null }));
    expect(await ask(CURRENT)).toBeNull();
  });

  it('a product with no picture at all publishes nothing, rather than everything', async () => {
    db.product.findFirst.mockResolvedValueOnce(product({ image: null, description: null, images: [] }));
    expect(await ask(CURRENT)).toBeNull();
  });
});
