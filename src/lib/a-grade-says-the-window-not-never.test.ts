import { describe, expect, it } from 'vitest';
import { catalogueReadiness, gradeProduct, type ProductCatalogue, type ProductSales } from './product-grade';
import { repoFile, stripComments } from './guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE
 *
 * The owner, 31/10, on the products screen: «الارقام كلها غلط». Read off the live catalogue: the grade told FIFTEEN products
 * «لم يُطلب قطّ — لا سطرَ طلبٍ واحداً على هذا المنتج قطّ», and four of them had delivered 154, 148, 103 and 18 units. The grade
 * reads the last ninety days only (`getDateRange({ period: 'all' })`, clamped), so «never» was a claim about the window
 * dressed as a claim about the history.
 *
 *  1. A product with no order line in the window is told so IN THE WINDOW's words — «لا طلب في الفترة» — and the line beneath
 *     says it does not mean the product was never sold, and points to the «المبيعات» column (from the first order).
 *  2. A product ordered and never confirmed in the window says «في فترة التقييم», not «ولا مرّة» as if for ever.
 *  3. The catalogue sentence («من 26 منتجاً: …») counts them as «لم يُطلب في فترة التقييم».
 *  4. No Arabic «قطّ» is left in the code of the grade (comments aside), so a new sentence cannot say «never» again.
 *
 * Blockers: no figure changes (counts, scores, bands untouched) — wording only; no money.
 * ═══════════════════════════════════════════════════════════════════════
 */

const READY: ProductCatalogue = { status: 'ACTIVE', basePrice: 20, imageCount: 1, hasCategory: true };
const sales = (over: Partial<ProductSales> = {}): ProductSales => ({
  confirmed: 0, delivered: 0, returned: 0, refused: 0, deliveredRevenue: 0, deliveredCogs: 0, bestDeliveredValue: 20, ...over,
});
const grade = (s: ProductSales | null, id = 'p1') => gradeProduct({ productId: id, catalogue: READY, sales: s });

describe('no order line in the window', () => {
  const g = grade(sales());

  it('is the state it always was, with a chip that names the period and not for ever', () => {
    expect(g.state).toBe('NEVER_ORDERED');
    expect(g.label).toBe('لا طلب في الفترة');
    expect(g.label).not.toContain('قطّ');
  });

  it('says «in the evaluation period», that it does not mean never sold, and where the sales are', () => {
    expect(g.why).toContain('في فترة التقييم');
    expect(g.why).toContain('لا يعني أنه لم يُبَع قبلها');
    expect(g.why).toContain('«المبيعات»');
    expect(g.why).not.toContain('قطّ');
  });
});

describe('ordered in the window and never confirmed', () => {
  const g = grade(sales({ refused: 3 }));

  it('says it of the period', () => {
    expect(g.state).toBe('NEVER_CONFIRMED');
    expect(g.label).toBe('لا تأكيد في الفترة');
    expect(g.why).toContain('طُلب 3 مرةً في فترة التقييم');
    expect(g.why).not.toContain('قطّ');
  });
});

describe('the catalogue sentence', () => {
  it('counts the products with no order in the window as exactly that', () => {
    const r = catalogueReadiness([grade(sales(), 'a'), grade(sales(), 'b')]);
    expect(r.neverOrdered).toBe(2);
    expect(r.why).toContain('2 لم يُطلب في فترة التقييم');
    expect(r.why).not.toContain('قطّ');
  });
});

describe('the grade cannot say «never» again', () => {
  it('has no «قطّ» in its code — only in the comment that explains why', () => {
    const code = stripComments(repoFile('src/lib/product-grade.ts'));
    expect(code, 'جملةٌ تقول «قطّ» عن نافذة من تسعين يوماً').not.toContain('قطّ');
  });
});
