import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * INSTALLING A TEMPLATE WRITES THE DRAFT, NEVER WHAT IS LIVE.
 *
 * A template is a starting point: the seller must be able to try one, look
 * at it and walk away. If installing touched the live page, "try one" would
 * mean "show every customer something you have not seen".
 */

const { db, requireContext, requirePermission, logAudit } = vi.hoisted(() => ({
  db: {
    store: { findFirst: vi.fn(), update: vi.fn() },
    // The gallery draws its previews with the seller's OWN products,
    // so the route reads four of them. A double that does not know
    // about this is a double that has fallen behind the route.
    product: { findMany: vi.fn().mockResolvedValue([]) },
    /*
     * AND THE SHELF IS ASKED FIRST.
     *
     * `Product.storeId` is nullable, so a shop whose goods predate
     * per-store catalogues matched nothing in `product.findMany` — and
     * the gallery told a shop with twelve published pages that it had no
     * products («؟» · «لا منتجات», reported 15/10). What a shopper
     * actually sees is the product of a published, shown landing page,
     * and those carry the store themselves.
     */
    landingPage: { findMany: vi.fn().mockResolvedValue([]) },
  },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));

import { GET, POST } from './route';
import { PAGE_TEMPLATES } from '@/lib/page-templates';
import { STORE_TEMPLATES } from '@/lib/store-templates';
import { DEFAULT_STORE_THEME } from '@/lib/store-theme';
import { TEMPLATE_FILE_KIND } from '@/lib/store-template-file';

const STORE = {
  id: 's1', name: 'صحة بلس', type: 'MULTI_PRODUCT',
  theme: JSON.stringify({ ...DEFAULT_STORE_THEME, footer: { copyright: '© صحة بلس' } }),
  homeDraft: null as string | null,
};

const post = (body: unknown) =>
  POST(new Request('http://localhost/api/store/templates', { method: 'POST', body: JSON.stringify(body) }));
const get = (url = 'http://localhost/api/store/templates') => GET(new Request(url));

beforeEach(() => {
  vi.resetAllMocks();
  requireContext.mockResolvedValue({ user: { id: 'u1' }, companyId: 'c1', storeId: 's1' });
  requirePermission.mockResolvedValue(undefined);
  // `resetAllMocks` wipes implementations, so this belongs here and not in
  // the factory: a shop with no products still has a gallery, and its
  // previews are drawn with empty boxes.
  db.product.findMany.mockResolvedValue([]);
  db.landingPage.findMany.mockResolvedValue([]);
  db.store.findFirst.mockResolvedValue({ ...STORE });
  db.store.update.mockResolvedValue({});
});

describe('installing from the gallery', () => {
  it('writes the draft, and ONLY the draft', async () => {
    // stores.theme is what every live storefront page and every published
    // landing page renders from. Writing it here would repaint the whole
    // shop the instant a seller pressed "try this one" — while the screen
    // told them it was a draft.
    const res = await post({ source: 'builtin', key: PAGE_TEMPLATES[0].key });
    expect(res.status).toBe(200);
    const data = db.store.update.mock.calls[0][0].data;
    expect(Object.keys(data)).toEqual(['homeDraft']);
    expect(JSON.parse(data.homeDraft).length).toBeGreaterThan(0);
  });

  it('hands the palette back as a proposal, and says it is not applied', async () => {
    const body = await (await post({ source: 'builtin', key: PAGE_TEMPLATES[0].key })).json();
    expect(body.themeApplied).toBe(false);
    expect(body.theme.accent).toBeTruthy();
  });

  it('and that proposal keeps the shop settings the template has no opinion about', async () => {
    // A template is a look. It must not empty the footer's copyright, the
    // header height or the checkout wording the seller set.
    const body = await (await post({ source: 'builtin', key: PAGE_TEMPLATES[0].key })).json();
    expect(body.theme.footer.copyright).toBe('© صحة بلس');
  });

  it('refuses a key it does not know, rather than installing something else', async () => {
    // buildTemplate falls back to its last entry for an unknown key, which
    // would quietly install a template nobody picked.
    const res = await post({ source: 'builtin', key: 'no-such-template' });
    expect(res.status).toBe(404);
    expect(db.store.update).not.toHaveBeenCalled();
  });
});

describe('installing from a file', () => {
  const file = {
    kind: TEMPLATE_FILE_KIND,
    version: 1,
    name: 'قالب صديقي',
    theme: DEFAULT_STORE_THEME,
    sections: [
      { id: 'h1', type: 'hero', enabled: true, headline: 'مرحباً', subheadline: '', showPrice: false, ctaText: 'اطلب',
        image: '/api/media/companies/OTHER/products/x/y.webp' },
    ],
  };

  it('goes through, and the other company’s image does not come with it', async () => {
    const res = await post({ source: 'file', file });
    expect(res.status).toBe(200);
    const written = db.store.update.mock.calls[0][0].data.homeDraft;
    expect(written).not.toContain('/api/media/');
    expect(written).toContain('مرحباً');
    expect(Object.keys(db.store.update.mock.calls[0][0].data)).toEqual(['homeDraft']);
  });

  it('a file that is not one is refused, and nothing is written', async () => {
    for (const bad of [{ kind: 'other' }, 'garbage', null, { kind: TEMPLATE_FILE_KIND, version: 99 }]) {
      const res = await post({ source: 'file', file: bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect(db.store.update).not.toHaveBeenCalled();
  });

  it('a file carrying a block type the system does not have is refused', async () => {
    const res = await post({
      source: 'file',
      file: { ...file, sections: [{ id: 'x', type: 'run-my-code', enabled: true }] },
    });
    expect(res.status).toBe(400);
    expect(db.store.update).not.toHaveBeenCalled();
  });
});

describe('exporting', () => {
  it('hands back a file named after the shop, as a download', async () => {
    const res = await get('http://localhost/api/store/templates?export=1');
    expect(res.headers.get('content-disposition')).toContain('.zaki-template.json');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('carries the shape but not the shop’s images', async () => {
    db.store.findFirst.mockResolvedValue({
      ...STORE,
      homeDraft: JSON.stringify([
        { id: 'h1', type: 'hero', enabled: true, headline: 'عنوان', subheadline: '', showPrice: false,
          ctaText: 'اطلب', image: '/api/media/companies/c1/products/p1/x.webp' },
      ]),
    });
    const body = await (await get('http://localhost/api/store/templates?export=1')).text();
    expect(body).toContain('عنوان');
    expect(body).not.toContain('/api/media/');
  });
});

describe('the guards', () => {
  it('reading is storefront.view, installing is storefront.manage', async () => {
    await get();
    expect(requirePermission).toHaveBeenCalledWith('storefront.view');
    vi.clearAllMocks();
    requirePermission.mockResolvedValue(undefined);
    db.store.findFirst.mockResolvedValue({ ...STORE });
    db.store.update.mockResolvedValue({});
    await post({ source: 'builtin', key: PAGE_TEMPLATES[0].key });
    expect(requirePermission).toHaveBeenCalledWith('storefront.manage');
  });

  it('installing needs no publish permission — nothing reaches a customer', async () => {
    await post({ source: 'builtin', key: PAGE_TEMPLATES[0].key });
    expect(requirePermission).not.toHaveBeenCalledWith('storefront.publish');
  });

  it('a Single Product store is refused at the server, not by a hidden button', async () => {
    db.store.findFirst.mockResolvedValue({ ...STORE, type: 'SINGLE_PRODUCT' });
    const res = await post({ source: 'builtin', key: PAGE_TEMPLATES[0].key });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('SINGLE_PRODUCT');
    expect(db.store.update).not.toHaveBeenCalled();
  });

  it('another company’s store reads as missing', async () => {
    db.store.findFirst.mockResolvedValue(null);
    expect((await get()).status).toBe(404);
    expect((await post({ source: 'builtin', key: PAGE_TEMPLATES[0].key })).status).toBe(404);
  });

  it('the gallery lists every template, with something to choose by', async () => {
    const body = await (await get()).json();
    expect(body.templates).toHaveLength(PAGE_TEMPLATES.length);
    for (const t of body.templates) {
      expect(t.label.length).toBeGreaterThan(1);
      expect(t.hint.length).toBeGreaterThan(5);
      expect(t.swatch).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

/**
 * THE TEN SHOP TEMPLATES.
 *
 * They were written, validated at module load and shipped, and no screen
 * in this system could reach one: a gallery of fifteen PAGE shapes stood
 * where a seller would look for them. The unit is different — a page
 * template orders the blocks of a home page, a shop template dresses the
 * whole engine — so they are one gallery with two sources rather than a
 * second screen.
 */
describe('the shop templates', () => {
  it('the gallery lists all ten, with what a seller chooses by', async () => {
    const body = await (await get()).json();
    expect(body.skins).toHaveLength(STORE_TEMPLATES.length);
    for (const s of body.skins) {
      expect(s.label.length).toBeGreaterThan(1);
      // The filter the brief asks for — «فلتر حسب الفئة المقترحة».
      expect(s.suggestedFor.length).toBeGreaterThan(3);
      // The one capability this template puts forward.
      expect(s.feature.length).toBeGreaterThan(2);
      // Drawn, not described: the card needs the resolved palette, the
      // arrangement of each part, and the corner radius.
      expect(s.palette.accent).toMatch(/^#[0-9a-f]{6}$/i);
      expect(s.palette.surface0).toBeTruthy();
      expect(s.palette.textPrimary).toBeTruthy();
      expect(['soft', 'sharp']).toContain(s.corners);
      expect(s.layout.header).toBeTruthy();
      expect(s.layout.hero).toBeTruthy();
      expect(s.layout.productCard).toBeTruthy();
    }
  });

  it('draws the previews with the seller’s own products', async () => {
    db.product.findMany.mockResolvedValue([
      // Real shapes: `publicizeMedia` rewrites an address only when the
      // owner and the file are the UUIDs the storage layer writes. A
      // fixture with `p1/a.webp` is refused — correctly — and a test
      // built on one would be testing nothing.
      {
        id: 'p-1',
        name: 'كريم مرطّب',
        image: null,
        basePrice: 14,
        images: [{ url: '/api/media/companies/11111111-1111-1111-1111-111111111111/products/22222222-2222-2222-2222-222222222222/33333333-3333-3333-3333-333333333333.webp' }],
      },
    ]);
    const body = await (await get()).json();
    expect(body.sample).toHaveLength(1);
    expect(body.sample[0].name).toBe('كريم مرطّب');
    // The image reaches the gallery by its PUBLIC address — a shopper's
    // route, because the preview draws it the way the shop will.
    expect(body.sample[0].image).toContain('/api/public/media/');
    // The company id never reaches a public address.
    expect(body.sample[0].image).not.toContain('11111111');
  });

  /**
   * THE BUG THE OWNER REPORTED ON 15/10, AS A TEST.
   *
   * «previews show ؟ and لا منتجات although the store has published
   * landing pages». Both halves were true at once: the route asked
   * `product.findMany` for `storeId: store.id`, and `Product.storeId` is
   * NULLABLE — «null only until a product from before this is placed».
   * A shop whose goods predate per-store catalogues matched nothing, and
   * the gallery drew a letter «؟» for a shop that sells twelve things.
   */
  it('and finds them through the shown pages when no product carries the store', async () => {
    // The catalogue table knows nothing about this shop…
    db.product.findMany.mockResolvedValue([]);
    // …and the shelf does.
    db.landingPage.findMany.mockResolvedValue([
      { product: { id: 'p-1', name: 'كريم مرطّب', image: null, basePrice: 14, images: [] } },
    ]);
    const body = await (await get()).json();
    expect(body.sample, 'المعاينة ما لقيت منتجات رغم صفحةٍ معروضة').toHaveLength(1);
    expect(body.sample[0].name).toBe('كريم مرطّب');

    // It asks for the PUBLISHED and SHOWN pages of THIS shop only — the
    // shelf's own rule (D2), not «every page this company ever made».
    const where = db.landingPage.findMany.mock.calls[0][0].where;
    expect(where.storeId).toBe('s1');
    expect(where.companyId).toBe('c1');
    expect(where.isPublished).toBe(true);
    expect(where.showInStore).toBe(true);
  });

  it('and one product with two shown pages is one card, not two', async () => {
    db.product.findMany.mockResolvedValue([]);
    const one = { id: 'p-1', name: 'كريم مرطّب', image: null, basePrice: 14, images: [] };
    db.landingPage.findMany.mockResolvedValue([{ product: one }, { product: one }]);
    const body = await (await get()).json();
    expect(body.sample, 'منتجٌ واحدٌ ظهر مرّتين').toHaveLength(1);
  });

  it('and a shop with neither gets the honest empty answer', async () => {
    db.product.findMany.mockResolvedValue([]);
    db.landingPage.findMany.mockResolvedValue([]);
    const body = await (await get()).json();
    // Empty, so the gallery draws labelled placeholders and says why —
    // which is true for a shop that really has nothing on its shelf.
    expect(body.sample).toEqual([]);
  });

  it('installing one writes the draft and nothing a customer sees', async () => {
    const res = await post({ source: 'skin', key: STORE_TEMPLATES[0].id });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.themeApplied).toBe(false);
    expect(body.installed).toBe(STORE_TEMPLATES[0].name);

    const written = db.store.update.mock.calls[0][0].data;
    // THE DRAFT, AND ONLY THE DRAFT. `theme` is what every live page
    // renders from; writing it here would repaint the shop on "try this".
    expect(Object.keys(written)).toEqual(['homeDraft']);
    expect(JSON.parse(written.homeDraft).length).toBeGreaterThan(0);
  });

  it('and the proposal says which template it came from', async () => {
    const body = await (await post({ source: 'skin', key: 'pearl' })).json();
    expect(body.theme.template).toBe('pearl');
    // Recorded, so «القالب المثبّت معلّم» stays true after a seller
    // changes a colour.
    expect(body.theme.accent).toBeTruthy();
    expect(body.theme.layout.header).toBeTruthy();
  });

  it('keeps the settings a template has no opinion about', async () => {
    const body = await (await post({ source: 'skin', key: 'souq' })).json();
    // The checkout fields and the cart bar are the shop's, not the
    // template's: installing a look must not empty a seller's settings.
    expect(body.theme.checkout).toBeDefined();
    expect(body.theme.cartBar).toBeDefined();
  });

  it('refuses a template that does not exist, rather than installing the last one', async () => {
    const res = await post({ source: 'skin', key: 'no-such-template' });
    expect(res.status).toBe(404);
    expect(db.store.update).not.toHaveBeenCalled();
  });

  it('a Single Product shop is told where its template lives', async () => {
    db.store.findFirst.mockResolvedValue({ ...STORE, type: 'SINGLE_PRODUCT' });
    const res = await post({ source: 'skin', key: 'lab' });
    expect(res.status).toBe(409);
    expect(db.store.update).not.toHaveBeenCalled();
  });

  it('marks the one this shop is wearing, and only if it still exists', async () => {
    db.store.findFirst.mockResolvedValue({
      ...STORE,
      theme: JSON.stringify({ ...DEFAULT_STORE_THEME, template: 'amber' }),
    });
    expect((await (await get()).json()).installed).toBe('amber');

    db.store.findFirst.mockResolvedValue({
      ...STORE,
      theme: JSON.stringify({ ...DEFAULT_STORE_THEME, template: 'a-template-that-was-removed' }),
    });
    expect((await (await get()).json()).installed).toBeNull();

    db.store.findFirst.mockResolvedValue(STORE);
    expect((await (await get()).json()).installed).toBeNull();
  });
});

/**
 * THE EIGHTEEN HOME DESIGNS OF THE OWNER'S OTHER PLATFORM — the same two
 * halves as a skin: the page into the home DRAFT, the look as a proposal.
 */
describe('installing one of their home designs', () => {
  it('writes the home draft and nothing a customer sees, and proposes its look unsaved', async () => {
    const res = await post({ source: 'design', key: 'nova-main' });
    expect(res.status).toBe(200);
    const data = db.store.update.mock.calls[0][0].data;
    expect(Object.keys(data)).toEqual(['homeDraft']);
    const sections = JSON.parse(data.homeDraft);
    expect(sections[0].type).toBe('slider');
    expect(sections.some((s: { type: string; sort?: string }) => s.type === 'catalog' && s.sort === 'best')).toBe(true);
    const body = await res.json();
    expect(body.themeApplied).toBe(false);
    expect(body.theme.look).toBe('nova');
    // the shop's own settings stay
    expect(body.theme.footer.copyright).toBe('© صحة بلس');
  });

  it('builds on the saved draft, not on what is live', async () => {
    db.store.findFirst.mockResolvedValue({ ...STORE, themeDraft: JSON.stringify({ ...DEFAULT_STORE_THEME, font: 'cairo' }) });
    const body = await (await post({ source: 'design', key: 'tech' })).json();
    expect(body.theme.font).toBe('cairo');
  });

  it('refuses a design it does not carry, and writes nothing', async () => {
    const res = await post({ source: 'design', key: 'no-such-design' });
    expect(res.status).toBe(404);
    expect(db.store.update).not.toHaveBeenCalled();
  });

  it('needs storefront.manage, like every install', async () => {
    requirePermission.mockRejectedValueOnce(Object.assign(new Error('forbidden'), { status: 403 }));
    const res = await post({ source: 'design', key: 'tech' });
    expect(res.status).not.toBe(200);
    expect(requirePermission).toHaveBeenCalledWith('storefront.manage');
    expect(db.store.update).not.toHaveBeenCalled();
  });
});

/**
 * THE REVIEW OF #188, ITEM 10: a skin or a design replaces the whole home
 * draft, so over a draft that has blocks it asks first.
 */
describe('installing over a home draft that has blocks', () => {
  const withDraft = () =>
    db.store.findFirst.mockResolvedValue({ ...STORE, homeDraft: JSON.stringify([{ id: 'h1', type: 'text', title: 'كتبه البائع', body: 'نص' }]) });

  it.each([
    ['a design', { source: 'design', key: 'tech' }],
    ['a skin', { source: 'skin', key: STORE_TEMPLATES[0].id }],
  ])('%s is refused with the question, and writes nothing', async (_w, body) => {
    withDraft();
    const res = await post(body);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('REPLACES_HOME_DRAFT');
    expect(db.store.update).not.toHaveBeenCalled();
  });

  it.each([
    ['a design', { source: 'design', key: 'tech', confirm: true }],
    ['a skin', { source: 'skin', key: STORE_TEMPLATES[0].id, confirm: true }],
  ])('%s goes through once the seller said yes', async (_w, body) => {
    withDraft();
    expect((await post(body)).status).toBe(200);
    expect(db.store.update).toHaveBeenCalled();
  });

  it('over an empty draft nothing is lost, so nothing is asked', async () => {
    expect((await post({ source: 'design', key: 'tech' })).status).toBe(200);
  });
});
