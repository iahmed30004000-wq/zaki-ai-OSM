import { describe, expect, it } from 'vitest';
import { repoFile, stripComments } from './guard-source';
import { whatsappHref } from './store-contact';

/**
 * THE THANK-YOU SCREEN, SHARED BY ALL TEN STRUCTURES.
 *
 * «صفحة الشكر مشتركة بين العشرة» — so it is one screen in one component,
 * and the structures differ in the story that leads to it and in nothing
 * after the order is placed.
 *
 * MOST OF THIS STAGE ALREADY EXISTED and the useful work was finding out
 * which parts. The post-order offer is a mature, signed-token endpoint; the
 * commission rule that keeps it off an agent's cross-sell is structural and
 * was written long before this brief. What was missing was smaller and
 * entirely about what the customer is told: when they pay, how to reach a
 * person, and how to say no.
 */

const form = () => stripComments(repoFile('src/components/landing/OrderForm.tsx'));

describe('«رقم المرجع والمبلغ المتوقع عند الاستلام»', () => {
  it('shows the order number', () => {
    expect(form()).toContain('result.orderNumber');
  });

  it('and says WHEN the amount is paid, not only what it is', () => {
    // The figure was already there and said nothing about itself. A
    // receipt that states the amount and not the moment is half a receipt.
    expect(form()).toContain('تدفعه عند الاستلام');
  });

  it('and the amount it shows includes anything added afterwards', () => {
    // `totals` is the server's answer after an add-on, not a sum this
    // component worked out.
    expect(form()).toContain("state === 'success' && totals ? totals.total");
  });
});

describe('«زر تأكيد اختياري عبر واتساب برسالة معبّاة»', () => {
  it('is drawn only when the shop has a number', () => {
    const src = form();
    // The block may now switch it off (`whatsappAfter`) — but with no number there is still no button.
    expect(src).toContain('const waBase = whatsappHref(whatsapp);');
    expect(src).toContain("afterOrderWhatsapp?.enabled !== false && waBase && result.orderNumber");
    expect(src).toContain('{waAfter && (');
    // A button that opens WhatsApp with nothing behind it is worse than
    // none.
    expect(whatsappHref(null)).toBeNull();
    expect(whatsappHref('123')).toBeNull();
    expect(whatsappHref('+962790000000')).toBe('https://wa.me/962790000000');
  });

  it('and the message is already written, carrying the order number', () => {
    // «برسالة معبّاة» — so the person on the other end is not asking
    // «شو رقم طلبك؟» first.
    // The words are the seller's now (`whatsappMessage`), and `{رقم_الطلب}` becomes the number; the default is the
    // sentence it always was. Behaviour is drawn in after-the-order-is-the-sellers.test.tsx.
    expect(form()).toContain('text=${encodeURIComponent(afterOrderMessage(afterOrderWhatsapp?.message, result.orderNumber))}');
    expect(form()).toContain("'مرحباً، بدّي أأكّد طلبي رقم {رقم_الطلب}'");
  });

  it('and it is optional: the order is placed with or without it', () => {
    // It sits on the SUCCESS screen, after the order exists. Nothing in
    // the submit path mentions it.
    const src = form();
    const success = src.slice(src.indexOf("state === 'success' ? ("));
    expect(success).toContain('{waAfter && (');
  });

  it('the shop’s number reaches it from both doors', () => {
    expect(stripComments(repoFile('src/components/landing/LandingPageView.tsx')))
      .toContain('whatsapp={formChoices?.whatsappNumber?.trim() || lp.store?.supportPhone || null}');
    expect(stripComments(repoFile('src/app/s/[store]/p/[sku]/page.tsx')))
      .toContain('whatsapp={store.whatsappPhone ?? store.supportPhone}');
  });
});

describe('«بيظهر مرة وحدة، وبيختفي إذا رفضه الزائر»', () => {
  const src = () => form();

  it('there is a way to refuse', () => {
    expect(src()).toContain('setOfferRefused(true)');
    expect(src()).toContain('لا شكراً');
  });

  it('and refusing hides it', () => {
    expect(src()).toContain('const showCrossSell = !offerRefused &&');
    expect(src()).toContain('{showCrossSell && (');
  });

  it('while anything already added stays on the order', () => {
    // Refusing is about the OFFER, not about undoing what the customer
    // chose. Nothing in the refusal touches `addons`.
    // THE HANDLER, not the declaration. `indexOf('setOfferRefused')` finds
    // the `useState` line first, so a window measured from there looks at
    // the wrong four hundred characters entirely — and a mutation that
    // cleared the add-ons inside the handler was caught by nothing.
    const s = src();
    const at = s.indexOf('setOfferRefused(true)');
    expect(at).toBeGreaterThan(0);
    expect(s.slice(at - 200, at + 200)).not.toContain('setAddons');
  });
});

describe('«بيعدّل الطلب نفسه، ما بينشئ طلب جديد»', () => {
  const route = () =>
    stripComments(
      repoFile('src/app/api/public/landing-pages/[slug]/orders/[orderNumber]/add-product/route.ts')
    );

  it('writes an add-on against the existing order, and creates no order', () => {
    const src = route();
    expect(src).toContain('orderAddOn');
    expect(src).not.toContain('order.create');
  });

  it('and the price comes from the database, never from the browser', () => {
    // The client sends a token and a recommendation id. Nothing else.
    const src = route();
    expect(src).toContain('token: z.string()');
    expect(src).toContain('recommendationId: z.string()');
    expect(src).not.toContain('price: z.');
    expect(src).not.toContain('quantity: z.');
  });

  it('and knowing the order number is not enough to touch somebody’s order', () => {
    // CALLED, not merely named: `verifyAddonTokenX` contains the string
    // `verifyAddonToken`, so a rename slips straight past a substring
    // check — which is how a mutation that removed the call went
    // unnoticed.
    // The CALL, not the import: renaming the imported symbol leaves
    // the call site reading the same and proves nothing.
    expect(route()).toContain('await verifyAddonToken(v.token)');
  });

  it('and the sale is filed against the page that made it', () => {
    // The page's own id, not merely the field's name: `landingPageId:
    // null` contains `landingPageId` and files the sale against nobody.
    // The CREATE, not the `where` clause above it — both mention the
    // field, and only one files the sale.
    expect(route()).toContain('orderId: order.id,');
    expect(route()).toContain("landingPageId: order.landingPage!.id,");
  });
});

describe('«ما بيحتسب كروس سيل لموظفة التأكيد»', () => {
  /**
   * This rule was already true and the useful thing was to find out WHY,
   * so a later change cannot quietly break it.
   *
   * An agent's cross-sell counts `orderItem` rows that the agent added
   * after intake. A post-order add-on is an `orderAddOn` — a different
   * table — added by an anonymous visitor with no user id at all. There is
   * no join by which it could be attributed to a person on the phone.
   */
  const metrics = () => stripComments(repoFile('src/lib/commission-metrics.ts'));

  it('the agent’s cross-sell counts order ITEMS, added by a named user, after intake', () => {
    const src = metrics();
    const fn = src.slice(src.indexOf('async function crossSellUnits'), src.indexOf('async function multiUnitOrders'));
    expect(fn).toContain('orderItem.findMany');
    expect(fn).toContain('addedById: scope.userId');
    expect(fn).toContain("addedStage: { not: 'INTAKE' }");
  });

  it('and never reads the add-on table at all', () => {
    const src = metrics();
    expect(src).not.toContain('orderAddOn');
  });
});
