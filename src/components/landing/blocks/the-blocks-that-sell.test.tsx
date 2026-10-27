// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import {
  COD_LINE, LOCKED_SECTIONS, ensureForm, ensureSellingCore, ensureSticky, newSection, parseSections,
  type LandingSection,
} from '@/lib/landing-sections';
import { trustRow } from '@/lib/selling-blocks';
import { repoFile, stripComments } from '@/lib/guard-source';
import { PageBlocks, type BlockContext } from './PageBlocks';

/**
 * «أقسام بتبيع» — THE BLOCKS, AS A COD ORDER ON A PHONE NEEDS THEM.
 *
 * The brief lists eight things a landing page must do before it is a page
 * somebody orders from with cash at their door: the form one tap away at
 * any scroll position · the offers inside the first two screens · a trust
 * row of cash on delivery, delivery time and returns-if-the-seller-set-one
 * · an objections list · a WhatsApp contact · the shortest checkout these
 * fields allow · real stock only · a countdown only from a real offer end
 * date.
 *
 * Seven of them are here. The eighth — the clock — has a file of its own
 * (`Countdown.test.tsx`), because it is the one where the old behaviour was
 * not merely thin but untrue, and the reasoning is long.
 *
 * Every test below is written as the FAILURE it would catch, not as the
 * feature it describes: «the hero shows the base price while the form has a
 * three-pack selected» is a bug somebody can recognise; «the hero shows a
 * price» is not.
 */

afterEach(cleanup);

const offer = (over: Partial<BlockContext['offers'][number]> = {}) => ({
  id: 'o1', name: '3 قطع', quantity: 3, freeQuantity: 1, price: 45, isDefault: true, ...over,
});

const ctx = (over: Partial<BlockContext> = {}): BlockContext => ({
  palette: {} as BlockContext['palette'],
  productName: 'كريم',
  price: 20,
  currency: 'JOD',
  stock: null,
  offers: [],
  form: <div id="zaki-order-form">FORM</div>,
  ...over,
});

const render1 = (section: LandingSection, over: Partial<BlockContext> = {}) =>
  render(<PageBlocks sections={[section]} ctx={ctx(over)} />);

// ─────────────────────────────────────────────────────
// 1 · the order is one tap away from any depth
// ─────────────────────────────────────────────────────

describe('the order is one tap away from any scroll position', () => {
  /**
   * THE PROMISE WAS IN TWO CONTRACTS AND KEPT BY NEITHER.
   *
   * Every one of the ten structures is refused by `landing-structure.ts`
   * without a `sticky` in its sequence, and `ctaRhythm.stickyOnMobile` is a
   * `z.literal(true)` with no value that turns it off. None of that reached
   * a page a seller assembled by hand in the builder, or a page built
   * before the block existed: `ensureForm` guaranteed the page could TAKE
   * an order and nothing guaranteed the order was REACHABLE two screens
   * down.
   */
  it('is added to a page that has no floating button at all', () => {
    const out = ensureSellingCore([newSection('hero')]);
    expect(out.map((s) => s.type)).toEqual(['hero', 'form', 'sticky']);
    expect(out.every((s) => s.enabled)).toBe(true);
  });

  it('and switched back on for a page where it was hidden — keeping the seller’s words', () => {
    const mine = { ...newSection('sticky'), text: 'بدّي واحد', enabled: false } as LandingSection;
    const out = ensureSticky([newSection('hero'), mine, newSection('form')]);
    const sticky = out.find((s) => s.type === 'sticky');
    expect(sticky?.enabled).toBe(true);
    // The words on the button are the seller's; only its presence is ours.
    expect(sticky && sticky.type === 'sticky' && sticky.text).toBe('بدّي واحد');
    // And no second copy appeared beside it.
    expect(out.filter((s) => s.type === 'sticky')).toHaveLength(1);
  });

  it('and a page that already has one is returned untouched', () => {
    const already = [newSection('hero'), newSection('form'), newSection('sticky')];
    expect(ensureSellingCore(already)).toEqual(already);
    expect(ensureForm(already)).toEqual(already);
  });

  /**
   * AND THE PUBLIC RENDERER IS THE ONE THAT ASKS FOR IT.
   *
   * A helper nobody calls is the shape this bug had in the first place.
   */
  it('on every public page, because the view calls for the whole core', () => {
    const view = stripComments(repoFile('src/components/landing/LandingPageView.tsx'));
    expect(view, 'الصفحة العامّة ما بتضمن الزرّ العائم').toContain('ensureSellingCore(parseSections(');
    expect(view).not.toMatch(/ensureForm\(parseSections\(/);
  });

  /**
   * A CONTROL THAT LIES ABOUT WHAT IT DID IS WORSE THAN NO CONTROL.
   *
   * With the core re-enabled on every render, «إخفاء» on the form or the
   * button changed nothing a visitor could see — the badge said «مخفي» and
   * the shopper got the block anyway. So those two handles are not drawn
   * for the two locked blocks.
   */
  it('and the builder offers no hide and no delete for the two locked blocks', () => {
    expect(LOCKED_SECTIONS).toEqual(['form', 'sticky']);
    const src = stripComments(repoFile('src/components/landing/blocks/PageBlocks.tsx'));
    expect(src).toContain('!LOCKED_SECTIONS.includes(s.type)');
  });
});

// ─────────────────────────────────────────────────────
// 2 · the offer is in the first screen
// ─────────────────────────────────────────────────────

describe('the first screen carries the offer, not the base price', () => {
  const hero = () => ({ ...newSection('hero'), showPrice: true } as LandingSection);

  /**
   * «السعر مع العرض» — DECLARED BY ALL TEN STRUCTURES, RENDERED BY NONE.
   *
   * `firstScreen.priceWithOffer` is a `z.literal(true)`, and the hero drew
   * `ctx.price`, which is the product's BASE price. A page selling «3 قطع
   * بـ45» opened with «20» — a figure for a quantity the form had not
   * selected — and the visitor met the real number for the first time at
   * the button, which is where a COD order is abandoned.
   */
  it('shows the price of the bundle the form has preselected', () => {
    const { container } = render1(hero(), { offers: [offer({ price: 45 })] });
    const price = container.querySelector('.lp-price');
    expect(price?.textContent, 'الشاشة الأولى بتعرض سعر غير إلّي بالنموذج').toContain('45');
    expect(price?.textContent).not.toContain('20');
  });

  it('and the product’s own price when the page sells no bundles', () => {
    const { container } = render1(hero(), { offers: [] });
    expect(container.querySelector('.lp-price')?.textContent).toContain('20');
  });

  /**
   * ONE STRIKE, AND THE CERTAIN FIGURE WINS — the same rule the offer cards
   * already apply. `listPrice` is this bundle's own price before its own
   * reduction and needs no evidence; `compareAtPrice` is a claim about the
   * past that `price-honesty.ts` has already measured. Two strikes on one
   * price is not a saving, it is a puzzle.
   */
  it('strikes through one figure, the certain one', () => {
    const { container } = render1(hero(), {
      offers: [offer({ price: 45, listPrice: 60, compareAtPrice: 90 })],
    });
    const struck = container.querySelectorAll('.lp-price s');
    expect(struck).toHaveLength(1);
    expect(struck[0].textContent).toContain('60');
  });

  it('and strikes nothing through when the «was» is not above what is charged', () => {
    const { container } = render1(hero(), { offers: [offer({ price: 45, listPrice: 45 })] });
    expect(container.querySelectorAll('.lp-price s')).toHaveLength(0);
  });

  /**
   * «العروض جوّا أول شاشتين» — SAID IN SCREEN ONE, CHOSEN WHERE THEY LIVE.
   *
   * The line names the bundle and how many others there are, and it is a
   * LINK to the picker the seller arranged — not a second copy of it. A
   * page with three pickers is a page where choosing in one does not
   * visibly change the other two; and moving the seller's offers block up
   * the page to satisfy «first two screens» would be a look rearranging
   * what a person arranged.
   */
  it('names the offer in the first screen and points at the picker', () => {
    const { container } = render1(hero(), {
      offers: [offer(), offer({ id: 'o2', name: 'قطعة', isDefault: false })],
    });
    const line = container.querySelector('.lp-hero-offers');
    expect(line?.textContent).toContain('3 قطع');
    // «عرضان», not «2 عروض»: Arabic counts a dual, and getting that wrong
    // on the line that invites somebody to choose reads as machine output.
    expect(line?.textContent).toContain('عرضان');
    // One tap, and it lands in the form rather than at the top of a card.
    expect(line?.getAttribute('href')).toBe('#zf-full_name');
  });

  it('and says nothing about offers on a page that sells none', () => {
    const { container } = render1(hero(), { offers: [] });
    expect(container.querySelector('.lp-hero-offers')).toBeNull();
  });

  /** The locked core's third part stays locked: no value removes it. */
  it('still carries the cash-on-delivery line', () => {
    const { container } = render1(hero(), { offers: [offer()] });
    expect(container.querySelector('.lp-hero-cod')?.textContent).toBe(COD_LINE);
  });
});

// ─────────────────────────────────────────────────────
// 3 · the trust row
// ─────────────────────────────────────────────────────

describe('the trust row draws facts, and invents none', () => {
  /**
   * THE SEED USED TO BE THE PROBLEM.
   *
   * It arrived holding «طلب آمن · بياناتك محفوظة» and «توصيل سريع · خلال
   * أيام» — two sentences nobody measured, pre-written into the one block
   * whose job is to be believed, on a shop that had never delivered
   * anything. A seller who never opened the block published them.
   */
  it('starts empty, so the facts are what a new page shows', () => {
    const seeded = newSection('trust');
    expect(seeded.type === 'trust' && seeded.items, 'القسم بيجي بجمل ما حدا قاسها').toEqual([]);
  });

  it('with no facts to hand, says only the thing true of every shop here', () => {
    const { container } = render1(newSection('trust'));
    const items = container.querySelectorAll('.lp-trust > *');
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toContain('الدفع عند الاستلام');
    expect(container.textContent, 'وعد توصيل بلا قياس').not.toContain('توصيل سريع');
  });

  it('adds the measured delivery window and the seller’s own guarantee', () => {
    const facts = trustRow({
      delivery: { medianDays: 2, slowDays: 3, samples: 11 },
      returns: { text: 'بترجّعه خلال أسبوع' },
    });
    const { container } = render1(newSection('trust'), { trust: facts });
    expect(container.querySelectorAll('.lp-trust > *')).toHaveLength(3);
    expect(container.textContent).toContain('يصل عادةً خلال يومين');
    expect(container.textContent).toContain('بترجّعه خلال أسبوع');
  });

  it('and a published policy is a page to open, not a sentence we wrote', () => {
    const facts = trustRow({ returns: { href: '/s/shop/pages/refund' } });
    render1(newSection('trust'), { trust: facts });
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('/s/shop/pages/refund');
  });

  /** A seller's own three lines still win: they are their words. */
  it('steps aside for a seller who typed their own', () => {
    const mine = {
      ...newSection('trust'),
      items: [{ title: 'ضمان سنة', text: 'بالفاتورة' }],
    } as LandingSection;
    const { container } = render1(mine, { trust: trustRow({ delivery: { medianDays: 1, slowDays: 1, samples: 20 } }) });
    expect(container.textContent).toContain('ضمان سنة');
    expect(container.textContent).not.toContain('يصل عادةً');
  });
});

// ─────────────────────────────────────────────────────
// 4 · the objections, 5 · the contact, 6 · real stock
// ─────────────────────────────────────────────────────

describe('the objections are named and answered', () => {
  it('and a page with none draws nothing rather than an empty heading', () => {
    const { container } = render1(newSection('objections'));
    expect(container.querySelector('.lp-objections')).toBeNull();
  });

  it('and each doubt is drawn beside its answer, with the guarantee under them', () => {
    const block = {
      ...newSection('objections'),
      items: [{ doubt: 'وإذا ما ناسبني؟', answer: 'بترجّعه' }],
      guarantee: 'ضمان أسبوع',
    } as LandingSection;
    const { container } = render1(block);
    expect(container.querySelector('.lp-objection-doubt')?.textContent).toBe('وإذا ما ناسبني؟');
    expect(container.querySelector('.lp-objection-answer')?.textContent).toBe('بترجّعه');
    expect(container.querySelector('.lp-guarantee')?.textContent).toBe('ضمان أسبوع');
  });
});

describe('a person to ask, on the bar that follows the visitor', () => {
  /**
   * A SECOND FLOATING BUBBLE WAS THE ALTERNATIVE, AND IT IS WORSE.
   *
   * Two fixed elements on a 360px screen argue over the same corner, which
   * is what the shop's own floating WhatsApp and this page's button did
   * when a Single Product store rendered both. One bar, two destinations,
   * and they leave the screen together when the form arrives.
   */
  it('is on the bar when the shop has a number', () => {
    render1(newSection('sticky'), { whatsapp: 'https://wa.me/962790000000', offers: [offer()] });
    const wa = screen.getByLabelText('تواصل معنا على واتساب');
    expect(wa.getAttribute('href')).toBe('https://wa.me/962790000000');
    // A new tab, and no window.opener handed to it.
    expect(wa.getAttribute('rel')).toContain('noopener');
  });

  /** A button that opens nothing looks exactly like a shop that does not answer. */
  it('and is absent — not dead — when it has none', () => {
    const { container } = render1(newSection('sticky'), { whatsapp: null, offers: [offer()] });
    expect(container.querySelector('.lp-sticky-wa')).toBeNull();
    expect(container.querySelector('.lp-sticky')).toBeTruthy();
  });
});

describe('the remaining count is the real one', () => {
  const block = () => ({ ...newSection('urgency'), showRealStock: true } as LandingSection);

  it('is drawn when it is genuinely low', () => {
    const { container } = render1(block(), { stock: 4 });
    expect(container.querySelector('.lp-stock')?.textContent).toContain('4');
  });

  it('and is silent for unknown, for none, and for plenty', () => {
    for (const stock of [null, 0, 200]) {
      const { container } = render1(block(), { stock });
      expect(container.querySelector('.lp-stock'), `مخزون ${stock}`).toBeNull();
      cleanup();
    }
  });

  it('and the seller cannot ask for a number the shelf does not have', () => {
    // `showRealStock` off is the only switch; there is no field holding a
    // count. The schema is where that is enforced, so it is read there.
    const parsed = parseSections([{ ...newSection('urgency'), stock: 3 }]);
    expect(parsed[0]).not.toHaveProperty('stock');
  });
});

// ─────────────────────────────────────────────────────
// 7 · the shortest checkout these fields allow
// ─────────────────────────────────────────────────────

describe('the checkout is as short as these fields allow', () => {
  const form = () => stripComments(repoFile('src/components/landing/OrderForm.tsx'));

  /**
   * NO FIELD IS LOST, WHICH IS HALF THE REQUIREMENT.
   *
   * «أقصر إتمام ممكن بالحقول الموجودة (الحقول ما تتغيّر)». The server
   * derives everything else from the slug and the offer id, and a field
   * removed here would be a field the order no longer carries — so what
   * the page sends is pinned by name. The one addition is the store's own
   * «هاتف بديل», asked only when the page hands in its store's «الدفع»
   * (the-form-follows-the-stores-checkout.test.tsx).
   */
  it('still sends the five fields and the honeypot — and the shop’s second number', () => {
    for (const name of ['full_name', 'phone', 'address', 'notes', 'website', 'alt_phone']) {
      expect(form(), `الحقل «${name}» اختفى من النموذج`).toContain(`name="${name}"`);
    }
    // The city is a listbox over the country's own regions, not a text field.
    expect(form()).toContain('id="zf-city"');
  });

  /**
   * AND THE OPTIONAL ONE IS FOLDED.
   *
   * It was a three-row textarea with «(اختياري)» in its placeholder: a
   * whole field's worth of a phone screen, between the address and the only
   * button that matters, that almost nobody fills. Folded, not deleted —
   * one tap away for the visitor who has something to say.
   */
  it('folds the optional note behind one line of text', () => {
    expect(form()).toContain('notesOpen');
    expect(form()).toContain('إضافة ملاحظة');
    expect(form()).toContain('rows={3}');
  });

  /**
   * AND THE BADGE THAT SAID SOMETHING NOBODY MEASURED IS GONE.
   *
   * «توصيل لجميع المحافظات» was written as a fact about every shop on this
   * system and it is a fact about none of them — a shop's reach is its
   * country's regions and its courier's. The trust row says the measured
   * thing or says nothing.
   */
  it('and claims no delivery reach of its own', () => {
    expect(form(), 'النموذج بيوعد بتوصيل ما حدا قاسه').not.toContain('توصيل لجميع المحافظات');
  });
});
