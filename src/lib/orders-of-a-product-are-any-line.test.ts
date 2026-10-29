import { describe, expect, it } from 'vitest';
import { ordersWhere } from './order-filters';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «كل الطلبات على هذا المنتج» = أي سطر، لا السطر الأول فقط (RV75).
 *
 * `Order.productId` is the legacy column and names the FIRST line's product. The reports and the grades count LINES, so an
 * order of two products appeared under the second product in the reports and NOT under the list's product filter nor on the
 * product page's «أحدث الطلبات». The filter now matches the first line (the column — also the only record a row written
 * before it had lines has) OR any line.
 *
 * A small reader of the clause shapes this filter uses is run over real-looking orders — the same method as
 * `queue-counter.test.ts` — so the claim is about which ORDERS come back, not about the spelling of the clause.
 *
 * The decision — the owner, 28/10: «اي قرار بعد الان اتخذو دون الرجوع الي». The conservative reading: widen the filter to
 * what the reports already count; touch nothing a person is allowed to see (the callers AND their own envelope over it).
 * ═══════════════════════════════════════════════════════════════════════
 */

type Order = { productId: string; items: { productId: string }[]; orderNumber?: string };

/** The clause shapes `ordersWhere` produces for this filter, evaluated on one in-memory order. */
function matches(where: unknown, o: Order): boolean {
  return Object.entries(where as Record<string, unknown>).every(([key, want]) => {
    if (key === 'AND') return (want as unknown[]).every((w) => matches(w, o));
    if (key === 'OR') return (want as unknown[]).some((w) => matches(w, o));
    if (key === 'productId') return o.productId === want;
    if (key === 'items') {
      const some = (want as { some: Record<string, unknown> }).some;
      return o.items.some((it) => Object.entries(some).every(([k, v]) => (it as Record<string, unknown>)[k] === v));
    }
    throw new Error('a clause this reader does not know: ' + key);
  });
}

const where = (query: string) => {
  const built = ordersWhere(new URLSearchParams(query));
  if (!built.ok) throw new Error(built.error);
  return built.where;
};

const ONE_LINE_A: Order = { productId: 'A', items: [{ productId: 'A' }] };
const TWO_LINES_A_THEN_B: Order = { productId: 'A', items: [{ productId: 'A' }, { productId: 'B' }] };
const ONE_LINE_C: Order = { productId: 'C', items: [{ productId: 'C' }] };
/** Written before orders had lines: the column is the only record there is. */
const NO_LINES_B: Order = { productId: 'B', items: [] };

describe('RV75 — the product filter reads every line', () => {
  it('الطلب بسطرين (A ثم B) يظهر تحت B — وهذا كان الغائب', () => {
    const w = where('productId=B');
    expect(matches(w, TWO_LINES_A_THEN_B), 'المنتج الثاني لا يجد طلبه').toBe(true);
    expect(matches(w, ONE_LINE_A)).toBe(false);
    expect(matches(w, ONE_LINE_C)).toBe(false);
  });

  it('وتحت A كما كان — السطر الأول لم يُفقَد', () => {
    const w = where('productId=A');
    expect(matches(w, TWO_LINES_A_THEN_B)).toBe(true);
    expect(matches(w, ONE_LINE_A)).toBe(true);
    expect(matches(w, ONE_LINE_C)).toBe(false);
  });

  it('وطلبٌ قديم بلا أسطر يبقى تحت منتجه بالعمود', () => {
    expect(matches(where('productId=B'), NO_LINES_B)).toBe(true);
    expect(matches(where('productId=A'), NO_LINES_B)).toBe(false);
  });

  it('ولا فلتر منتج ("all" أو فارغ) لا يضيف شرطاً', () => {
    expect(where('productId=all')).toEqual({});
    expect(where('')).toEqual({});
  });

  it('وبحثُ النص يبقى `OR` سليماً — الشرط الجديد لا يكتب فوقه', () => {
    const w = where('productId=B&q=ORD-5') as { OR?: unknown[]; AND?: unknown[] };
    expect(w.OR, 'البحث ضاع').toBeDefined();
    expect(w.AND).toHaveLength(1);
    // The search clause is not touched by the product clause and the product clause is not folded into the search.
    expect(JSON.stringify(w.OR)).not.toContain('items');
  });

  it('وبقية الفلاتر تجتمع معه (الحالة + المنتج): كلاهما شرط', () => {
    const w = where('productId=B&status=NEW') as { AND?: unknown[] };
    expect(w.AND).toHaveLength(2);
  });

  it('والمصدر ما زال واحداً: صفحة المنتج وقائمة الطلبات والتصدير تسأل `ordersWhere` نفسها', () => {
    // The product page's card builds its query through the same function (`products/[id]/orders/route.ts`), so the card
    // and the link under it ("كل الطلبات على هذا المنتج") cannot disagree.
    const w = where('productId=B');
    expect(w).toEqual({ AND: [{ OR: [{ productId: 'B' }, { items: { some: { productId: 'B' } } }] }] });
  });
});
