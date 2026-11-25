import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «باركود المنتجات» — the server side: what a save accepts, who owns a short link, what `/v/<slug>` answers, and the
 * one verdict a product page may give.
 */

const { db } = vi.hoisted(() => ({
  db: {
    productVerifyPage: { findUnique: vi.fn() },
    productVerifyPageSlug: { findUnique: vi.fn() },
    authenticityCode: { findUnique: vi.fn(), update: vi.fn() },
    landingPage: { findFirst: vi.fn() },
  },
}));
vi.mock('@/lib/db', () => ({ db }));

import {
  designSchema,
  isGenuineForProduct,
  lookupBySlug,
  normalizeProductCode,
  productCodeCandidates,
  publicImage,
  SLUG_TAKEN,
  slugTaken,
} from './product-verify';

const CO = '11111111-1111-4111-8111-111111111111';
const PRODUCT = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const FILE = '44444444-4444-4444-8444-444444444444.webp';

const pageRow = (over: Record<string, unknown> = {}) => ({
  id: 'page-1',
  companyId: CO,
  productId: PRODUCT,
  publicId: 'AbCdEf123_-x',
  slug: 'krem',
  active: true,
  headline: null,
  nameOverride: null,
  imageUrl: null,
  logoUrl: null,
  primaryColor: null,
  backgroundColor: null,
  description: null,
  features: '["خفيف"]',
  genuineMessage: null,
  notGenuineMessage: null,
  whatsappNumber: null,
  reorderMode: 'none',
  reorderUrl: null,
  product: { name: 'كريم', description: null, image: null, images: [], store: { logo: null } },
  ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
  db.authenticityCode.update.mockResolvedValue({});
});

describe('what a save accepts — and refuses in Arabic', () => {
  const issue = (body: unknown) => {
    const r = designSchema.safeParse(body);
    return r.success ? null : r.error.issues.map((i) => i.message).join(' | ');
  };

  it('a full, valid design parses; colours, https links and features are kept', () => {
    const r = designSchema.parse({
      slug: ' Krem-1 ',
      primaryColor: '#0E9F6E',
      backgroundColor: '#ffffff',
      imageUrl: 'https://cdn.example/p.webp',
      logoUrl: `/api/media/companies/${CO}/products/${PRODUCT}/${FILE}`,
      features: ['أصلي', '', 'مضمون'],
      whatsappNumber: '+963 912 345 678',
      reorderMode: 'custom',
      reorderUrl: 'https://shop.example/krem',
    });
    expect(r.slug).toBe('krem-1');
    expect(r.features).toEqual(['أصلي', 'مضمون']);
  });

  it.each([
    [{ primaryColor: 'red' }, 'اللون'],
    [{ backgroundColor: '#12345' }, 'اللون'],
    [{ imageUrl: 'http://insecure.example/a.png' }, 'https://'],
    [{ logoUrl: 'javascript:alert(1)' }, 'https://'],
    [{ reorderMode: 'custom' }, 'اطلب مرة تانية'],
    [{ reorderMode: 'custom', reorderUrl: 'http://x.example' }, 'https://'],
    [{ whatsappNumber: '12' }, 'رمز البلد'],
    [{ headline: 'x'.repeat(161) }, 'العنوان طويل'],
    [{ features: Array(9).fill('م') }, 'ميزات على الأكثر'],
    [{ slug: 'admin' }, 'محجوزة'],
    [{ slug: 'كريم' }, 'إنكليزية'],
  ])('NEGATIVE: %j is refused', (body, word) => {
    expect(issue(body)).toContain(word);
  });
});

describe('a short link belongs to one page — for ever', () => {
  it('free when no page has it, now or before', async () => {
    db.productVerifyPage.findUnique.mockResolvedValue(null);
    db.productVerifyPageSlug.findUnique.mockResolvedValue(null);
    expect(await slugTaken('krem')).toBe(false);
  });

  it('NEGATIVE: taken when another page has it now', async () => {
    db.productVerifyPage.findUnique.mockResolvedValue({ id: 'page-2' });
    db.productVerifyPageSlug.findUnique.mockResolvedValue(null);
    expect(await slugTaken('krem', 'page-1')).toBe(true);
  });

  it('NEGATIVE: taken when another page HAD it — a barcode printed with it must not open another product', async () => {
    db.productVerifyPage.findUnique.mockResolvedValue(null);
    db.productVerifyPageSlug.findUnique.mockResolvedValue({ pageId: 'page-2' });
    expect(await slugTaken('krem', 'page-1')).toBe(true);
    expect(await slugTaken('krem')).toBe(true);
  });

  it('a page may take back its own old slug, and keep its current one', async () => {
    db.productVerifyPage.findUnique.mockResolvedValue({ id: 'page-1' });
    db.productVerifyPageSlug.findUnique.mockResolvedValue({ pageId: 'page-1' });
    expect(await slugTaken('krem', 'page-1')).toBe(false);
  });

  it('the refusal says it in the owner\'s words', () => {
    expect(SLUG_TAKEN).toContain('الرابط مستعمل لمنتج تاني');
  });
});

describe('what /v/<slug> answers', () => {
  it('the current slug of an active page → the page, drawn from the product', async () => {
    db.productVerifyPage.findUnique.mockResolvedValue(pageRow());
    const r = await lookupBySlug('Krem');
    expect(r.kind).toBe('page');
    if (r.kind !== 'page') return;
    expect(r.design.name).toBe('كريم');
    expect(r.design.features).toEqual(['خفيف']);
    expect(r.design.reorderUrl).toBeNull();
    expect(db.productVerifyPage.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { slug: 'krem' } }));
  });

  it('an old slug → moved to the current one (the redirect that keeps printed barcodes working)', async () => {
    db.productVerifyPage.findUnique.mockResolvedValue(null);
    db.productVerifyPageSlug.findUnique.mockResolvedValue({ page: { slug: 'krem-new', active: true } });
    expect(await lookupBySlug('krem-old')).toEqual({ kind: 'moved', slug: 'krem-new' });
  });

  it('NEGATIVE: an inactive page is a 404 — by its slug and by an old one', async () => {
    db.productVerifyPage.findUnique.mockResolvedValue(pageRow({ active: false }));
    expect(await lookupBySlug('krem')).toEqual({ kind: 'none' });
    db.productVerifyPage.findUnique.mockResolvedValue(null);
    db.productVerifyPageSlug.findUnique.mockResolvedValue({ page: { slug: 'krem', active: false } });
    expect(await lookupBySlug('krem-old')).toEqual({ kind: 'none' });
  });

  it('NEGATIVE: a reserved word or a malformed slug never reaches the database', async () => {
    for (const s of ['admin', 'a', '../etc', 'كريم']) expect(await lookupBySlug(s)).toEqual({ kind: 'none' });
    expect(db.productVerifyPage.findUnique).not.toHaveBeenCalled();
  });

  it('the landing page reorder link is the newest published one of this product', async () => {
    db.productVerifyPage.findUnique.mockResolvedValue(pageRow({ reorderMode: 'landing' }));
    db.landingPage.findFirst.mockResolvedValue({ slug: 'krem-lp', domain: null, domainVerifiedAt: null });
    const r = await lookupBySlug('krem');
    expect(r.kind === 'page' && r.design.reorderUrl).toBe('/lp/krem-lp');
    expect(db.landingPage.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { companyId: CO, productId: PRODUCT, isPublished: true } }));
  });
});

describe('the verdict on a product page', () => {
  it('a code tagged to THIS product → genuine', async () => {
    db.authenticityCode.findUnique.mockResolvedValue({ id: 'c1', productId: PRODUCT });
    expect(await isGenuineForProduct(CO, PRODUCT, 'P-1')).toBe(true);
  });

  it('a code tagged to no product → genuine (it belongs to every product)', async () => {
    db.authenticityCode.findUnique.mockResolvedValue({ id: 'c1', productId: null });
    expect(await isGenuineForProduct(CO, PRODUCT, 'P-1')).toBe(true);
  });

  it('NEGATIVE: a code tagged to ANOTHER product → not genuine, and its count is not bumped', async () => {
    db.authenticityCode.findUnique.mockResolvedValue({ id: 'c1', productId: OTHER });
    expect(await isGenuineForProduct(CO, PRODUCT, 'P-1')).toBe(false);
    expect(db.authenticityCode.update).not.toHaveBeenCalled();
  });

  it('NEGATIVE: unknown or empty → not genuine; the lookup is inside the page\'s company only', async () => {
    db.authenticityCode.findUnique.mockResolvedValue(null);
    expect(await isGenuineForProduct(CO, PRODUCT, 'P-1')).toBe(false);
    expect(db.authenticityCode.findUnique).toHaveBeenCalledWith({ where: { companyId_code: { companyId: CO, code: 'P-1' } }, select: { id: true, productId: true } });
    expect(await isGenuineForProduct(CO, PRODUCT, null)).toBe(false);
  });

  it('a scanned piece QR (/v/<slug>?code=…) is read as the code inside it', () => {
    expect(normalizeProductCode('https://crm.example/v/krem?code=p-0042')).toBe('P-0042');
    expect(normalizeProductCode('https://crm.example/verify/p/AbCdEf123_-x?code=p-0042')).toBe('P-0042');
    expect(normalizeProductCode('  p-0042 ')).toBe('P-0042');
  });

  // 25/11 (owner): «الباركود يكون يقدر يكون كلشي — روابط او رموز». A saved link of any shape is a code too.
  it('a scan is tried as the code inside a piece link, then as itself — so any saved link or code matches', () => {
    // A piece link: its code first, then the whole link (the owner may have saved the link itself).
    expect(productCodeCandidates('https://crm.example/v/krem?code=p-0042')).toEqual(['P-0042', 'https://crm.example/v/krem?code=p-0042']);
    // The page's own link with no code: only the link itself — it matches when the owner saved it as a code.
    expect(productCodeCandidates('https://crm.example/v/vara-harir')).toEqual(['https://crm.example/v/vara-harir']);
    // Any other link, Arabic, a plain code: once, as saved.
    expect(productCodeCandidates('https://other.example/x?id=7')).toEqual(['https://other.example/x?id=7']);
    expect(productCodeCandidates('  p-0042 ')).toEqual(['P-0042']);
    expect(productCodeCandidates('رمز ١٢٣')).toEqual(['رمز ١٢٣']);
    // Too short or a control character: nothing to look up.
    expect(productCodeCandidates('ab')).toEqual([]);
  });
});

describe('which pictures the public may load', () => {
  const page = { publicId: 'AbCdEf123_-x', companyId: CO, productId: PRODUCT };
  it('https as is; an upload in this product\'s folder through the page\'s own media door', () => {
    expect(publicImage('https://cdn.example/a.png', page)).toBe('https://cdn.example/a.png');
    expect(publicImage(`/api/media/companies/${CO}/products/${PRODUCT}/${FILE}`, page)).toBe(`/api/public/verify-product/AbCdEf123_-x/media/${FILE}`);
  });
  it('NEGATIVE: another product\'s or company\'s folder, or a bare path, is not shown', () => {
    expect(publicImage(`/api/media/companies/${CO}/products/${OTHER}/${FILE}`, page)).toBeNull();
    expect(publicImage(`/api/media/companies/${OTHER}/products/${PRODUCT}/${FILE}`, page)).toBeNull();
    expect(publicImage('/etc/passwd', page)).toBeNull();
    expect(publicImage('http://insecure.example/a.png', page)).toBeNull();
  });
});
