// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';

// Unmount what each test drew: a tree left mounted when the file ends is
// still scheduled work, and it runs after the DOM is gone («window is not defined»).
afterEach(cleanup);
import { PageBlocks, catalogHeading, sortCatalog, type BlockContext, type CatalogItem } from './PageBlocks';
import { newSection, type LandingSection } from '@/lib/landing-sections';

/**
 * A HOME DESIGN'S ROWS — «وصل حديثاً», «الأكثر مبيعاً», «الأقل سعراً» — and
 * the one rule that matters: «الأكثر مبيعاً» is an ORDER taken from this
 * shop's delivered orders, never a number on the page, and with nothing
 * proven the row is «مختارات», in the shelf's own order.
 */
const item = (id: string, over: Partial<CatalogItem> = {}): CatalogItem => ({
  id, kind: 'product', name: id, image: null, href: `/p/${id}`, price: 10, categoryId: null, ...over,
});

const ctx = (items: CatalogItem[]): BlockContext =>
  ({
    palette: {} as BlockContext['palette'], productName: 'x', price: 0, currency: 'USD', stock: null, offers: [], form: null,
    catalog: { items, categories: [] },
  }) as BlockContext;

const row = (over: Record<string, unknown>) =>
  ({ ...newSection('catalog'), id: 'c1', title: '', source: 'products', ...over }) as LandingSection;

const names = (html: HTMLElement) => [...html.querySelectorAll('.lp-catalog-name')].map((n) => n.textContent);

describe('a sorted catalogue row', () => {
  const items = [
    item('a', { addedAt: 1, price: 30 }),
    item('b', { addedAt: 3, price: 0, sold: 6 }),
    item('c', { addedAt: 2, price: 20, sold: 9 }),
  ];

  it('keeps the shelf order when it was never asked for one — every saved block', () => {
    expect(sortCatalog(items, 'shelf')).toBe(items);
    expect(newSection('catalog')).toMatchObject({ sort: 'shelf' });
  });

  it('orders by when the product was added, by price (a price of nothing last), and by delivered orders', () => {
    expect(sortCatalog(items, 'newest').map((i) => i.id)).toEqual(['b', 'c', 'a']);
    expect(sortCatalog(items, 'priceAsc').map((i) => i.id)).toEqual(['c', 'a', 'b']);
    expect(sortCatalog(items, 'best').map((i) => i.id)).toEqual(['c', 'b', 'a']);
  });

  it('writes «الأكثر مبيعاً» only over a row the orders prove, «مختارات» otherwise', () => {
    // `a` was never proven: a row that needs it as a filler claims nothing.
    expect(catalogHeading('best', items)).toBe('مختارات');
    expect(catalogHeading('best', items.filter((i) => i.sold !== undefined))).toBe('الأكثر مبيعاً');
    expect(catalogHeading('best', [])).toBe('مختارات');
    expect(catalogHeading('best', items.map(({ sold: _s, ...i }) => i))).toBe('مختارات');
    const html = render(<PageBlocks sections={[row({ sort: 'best' })]} ctx={ctx([item('a'), item('b')])} />).container;
    expect(html.textContent).toContain('مختارات');
    expect(html.textContent).not.toContain('الأكثر مبيعاً');
    expect(names(html)).toEqual(['a', 'b']);
  });

  it('one proven product among unproven fillers is «مختارات», the proven one first', () => {
    const html = render(<PageBlocks sections={[row({ sort: 'best' })]} ctx={ctx([item('x'), item('y', { sold: 5 }), item('z')])} />).container;
    expect(html.textContent).toContain('مختارات');
    expect(html.textContent).not.toContain('الأكثر مبيعاً');
    expect(names(html)[0]).toBe('y');
  });

  it('and a row cut to its proven products by the limit is «الأكثر مبيعاً»', () => {
    const html = render(<PageBlocks sections={[row({ sort: 'best', limit: 2 })]} ctx={ctx(items)} />).container;
    expect(html.textContent).toContain('الأكثر مبيعاً');
  });

  it('draws no count, ever', () => {
    const html = render(<PageBlocks sections={[row({ sort: 'best', limit: 2 })]} ctx={ctx(items)} />).container;
    expect(html.textContent).toContain('الأكثر مبيعاً');
    expect(html.textContent).not.toMatch(/\b(6|9)\b/);
  });

  it('keeps the seller’s own title over its own heading', () => {
    const html = render(<PageBlocks sections={[row({ sort: 'newest', title: 'جديدنا' })]} ctx={ctx(items)} />).container;
    expect(html.textContent).toContain('جديدنا');
    expect(html.textContent).not.toContain('وصل حديثاً');
  });

  it('cuts at the limit after ordering — the featured product is the top seller', () => {
    const html = render(<PageBlocks sections={[row({ sort: 'best', limit: 1, cardSize: 'lg' })]} ctx={ctx(items)} />).container;
    expect(names(html)).toEqual(['c']);
  });
});
