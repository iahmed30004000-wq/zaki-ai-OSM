import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE UPLOADED-HTML PAGE SHOWS ITS IMAGES.
 *
 * It is served into a sandboxed frame on an opaque origin, which sends no
 * cookies — so an image linked through /api/media (in the seller's HTML,
 * their CSS, or a product photo placed by a marker) was broken for everyone,
 * the seller included. Every one goes out as a public link now.
 */

const { db, verifyPreviewToken } = vi.hoisted(() => ({
  db: {
    landingPage: { findFirst: vi.fn() },
    offer: { findMany: vi.fn(async () => []) },
    // A preview reads the page's unpublished draft when it has one
    // (landing-draft.ts); these fixtures have none, so the statement answers
    // with no rows and the preview shows the live columns.
    $queryRawUnsafe: vi.fn(async () => []),
  },
  verifyPreviewToken: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/selling-currency', () => ({ sellingCurrency: async () => 'SYP', SELLING_STORE_SELECT: {} }));
vi.mock('@/lib/landing-pages', async (orig) => ({
  ...(await orig<typeof import('@/lib/landing-pages')>()),
  verifyPreviewToken: (...a: unknown[]) => verifyPreviewToken(...a),
}));

import { GET } from './route';

const CO = 'e4fcc15a-05de-48e5-80d9-37bfd191adae';
const LP = '11111111-1111-4111-8111-111111111111';
const PRODUCT = '22222222-2222-4222-8222-222222222222';
const FILE = '77fca75e-9831-4147-b8ef-9431e970e963.webp';
const privateUrl = (owner: string) => `/api/media/companies/${CO}/products/${owner}/${FILE}`;

const page = {
  id: LP, name: 'عرض', slug: 'offer', companyId: CO, productId: PRODUCT, store: null, pageSettings: null,
  htmlContent: `<html><head></head><body><img src="${privateUrl(LP)}"><img src="{{product.image}}"></body></html>`,
  cssContent: `.hero{background:url(${privateUrl(LP)})}`,
  product: { name: 'كريم', nameEn: null, image: privateUrl(PRODUCT), description: null, basePrice: 10 },
  recommendations: [],
};

const get = (query = '') =>
  GET(new Request(`http://localhost/lp/offer/raw${query}`), { params: Promise.resolve({ slug: 'offer' }) });

beforeEach(() => {
  vi.clearAllMocks();
  db.landingPage.findFirst.mockResolvedValue(page);
  verifyPreviewToken.mockResolvedValue(null);
});

describe('the served page', () => {
  it('links every stored image publicly — HTML, CSS and the product photo', async () => {
    const html = await (await get()).text();
    expect(html).not.toContain('/api/media/');
    expect(html).toContain(`/api/public/media/${LP}/${LP}/${FILE}`);
    expect(html).toContain(`url(/api/public/media/${LP}/${LP}/${FILE})`);
  });

  it('a preview carries its token on the images of the draft', async () => {
    verifyPreviewToken.mockResolvedValue({ lpId: LP });
    const html = await (await get('?p=tok')).text();
    expect(html).toContain(`/api/public/media/${LP}/${LP}/${FILE}?p=tok`);
  });

  it('an invalid token is no preview — no token is passed on', async () => {
    const html = await (await get('?p=forged')).text();
    expect(html).not.toContain('?p=forged');
  });
});

/**
 * THE SELLER'S CSS CANNOT LEAVE ITS ELEMENT, AND IS NEVER READ AS A TEMPLATE.
 *
 * The CSS field is wrapped in a style element AFTER the HTML sanitizer has
 * run, and was spliced into the document with a replacement STRING.
 */
describe('the seller css in the served page', () => {
  const doc = '<!doctype html><html><head><title>t</title></head><body><p>BODY-MARKER</p></body></html>';
  const serve = async (over: Record<string, unknown>) => {
    db.landingPage.findFirst.mockResolvedValue({ ...page, htmlContent: doc, ...over });
    return (await get()).text();
  };
  // What a browser sees as MARKUP: a style element ends at its first end tag,
  // and whatever sits inside it is inert text.
  const markup = (html: string) => html.replace(/<style\b[^>]*>[\s\S]*?<\/style[^>]*>/gi, '');
  const scripts = (html: string) => (markup(html).match(/<script\b/gi) ?? []).length;

  it('a style end tag in the css does not open a script', async () => {
    const html = await serve({ cssContent: 'a{color:red}</style><script>alert(document.cookie)</script><style>' });
    expect(scripts(html)).toBe(0);
    // the element the css lives in is closed exactly once, by us
    expect(html.match(/<\/style/gi)).toHaveLength(1);
    expect(html).toContain('a{color:red}');
  });

  it('nor an event handler after one', async () => {
    const html = await serve({ cssContent: '</style><img src=x onerror=alert(1)>' });
    expect(markup(html)).not.toMatch(/onerror/i);
  });

  it("a $' in the css does not paste the rest of the page into it", async () => {
    const html = await serve({ cssContent: `.a::after{content:"$'"}` });
    expect(html).toContain(`content:"$'"`);
    expect(html.match(/BODY-MARKER/g)).toHaveLength(1);
  });

  it('the same for $& and the backtick form', async () => {
    const html = await serve({ cssContent: '.a::after{content:"$&"}.b::after{content:"$`"}' });
    expect(html).toContain('content:"$&"');
    expect(html).toContain('content:"$`"');
    expect(html.match(/BODY-MARKER/g)).toHaveLength(1);
  });

  it('the page settings land right after <head>, the seller css right before </head>', async () => {
    const html = await serve({ pageSettings: JSON.stringify({ background: '#112233' }), cssContent: '.a{color:red}' });
    const base = html.indexOf('id="zaki-base-style"');
    const custom = html.indexOf('id="zaki-custom-style"');
    expect(html.indexOf('<head>')).toBeLessThan(base);
    expect(base).toBeLessThan(html.indexOf('<title>'));
    expect(custom).toBeGreaterThan(html.indexOf('</title>'));
    expect(custom).toBeLessThan(html.indexOf('</head>'));
  });

  // negative: a sound page with sound css comes through whole
  it('a sound page keeps its css and its body, once', async () => {
    const html = await serve({ cssContent: '.hero{color:#123;margin:0}@media (width<600px){.hero{margin:4px}}' });
    expect(html).toContain('.hero{color:#123;margin:0}@media (width<600px){.hero{margin:4px}}');
    expect(html.match(/BODY-MARKER/g)).toHaveLength(1);
    expect(scripts(html)).toBe(0);
  });
});
