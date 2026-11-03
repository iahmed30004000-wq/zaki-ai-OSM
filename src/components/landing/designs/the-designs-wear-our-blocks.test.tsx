// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { COD_LINE, ensureSellingCore, newSection, type LandingSection } from '@/lib/landing-sections';
import { buildTemplate } from '@/lib/page-templates';
import { trustRow } from '@/lib/selling-blocks';
import { moneyText } from '@/lib/money';
import { DESIGN_IDS, DESIGN_LOADERS } from './generated/index';
import type { DesignSkin } from '@/lib/landing-designs/skin';
import { repoFile, stripComments } from '@/lib/guard-source';
import { PageBlocks, type BlockContext } from '../blocks/PageBlocks';
import OrderForm from '../OrderForm';

/**
 * OUR BLOCKS, OUR FORM, THEIR LOOK — under every one of the designs.
 *
 * The owner: «تصميمه = الشكل؛ بلوكاتنا = المحتوى والمنطق». So each test
 * below is the failure it catches: a design that swallowed the order form, a
 * design that put its own «اطلب الآن» link where ours goes, a design that
 * dropped the COD line from the first screen, a design that let one of its
 * sentences through, and — first — a page with no design that changed at all.
 */

afterEach(cleanup);

const OFFER = { id: 'o1', name: 'عبوتان', quantity: 2, freeQuantity: 1, price: 45, listPrice: 60, isDefault: true };

const ctx = (over: Partial<BlockContext> = {}): BlockContext => ({
  palette: {} as BlockContext['palette'],
  productName: 'طاقية',
  price: 30,
  currency: 'USD',
  minorUnit: 2,
  stock: null,
  offers: [OFFER],
  form: <div id="zaki-order-form" data-ours="form">FORM</div>,
  trust: trustRow(),
  ...over,
});

/** The page a new seller gets, with words in every block that takes them. */
function page(): LandingSection[] {
  const { sections } = buildTemplate('classic');
  return ensureSellingCore(
    sections.map((s) => {
      if (s.type === 'hero') return { ...s, headline: 'طاقية الشعر الأصلية', subheadline: 'سطر عن المنتج', image: '/api/media/hero.jpg' };
      if (s.type === 'benefits') return { ...s, items: [{ title: 'ميزة كتبها البائع', text: 'شرحها' }] };
      if (s.type === 'faq') return { ...s, items: [{ q: 'سؤال كتبه البائع؟', a: 'جوابه' }] };
      if (s.type === 'reviews') return { ...s, items: [{ ...(s.items[0] ?? {}), name: 'سلمى', text: 'رأي نقله البائع', stars: 5 } as never] };
      return s;
    })
  );
}

const skins = async () => Promise.all(DESIGN_IDS.map(async (id) => (await DESIGN_LOADERS[id]()).default));

/** Their default copy, from the harvest — none of it may ever be on our page. */
const THEIRS = ['+50K', 'عميل سعيد', 'ضمان استرداد', 'مشترية موثقة', 'مفحوص قبل الشحن', 'جودة عالية', 'كوزمتكس', 'تسوق آمن', 'ليش رح تحبه', 'كيف تطلب', 'عبّي النموذج'];

describe('a page with no design is exactly today’s page', () => {
  it('draws the same markup with the field absent, null, or naming nothing this build carries', () => {
    const sections = page();
    const plain = render(<PageBlocks sections={sections} ctx={ctx()} />).container.innerHTML;
    cleanup();
    const nulled = render(<PageBlocks sections={sections} ctx={ctx({ design: null })} />).container.innerHTML;
    expect(nulled).toBe(plain);
    expect(plain).not.toMatch(/data-zd-role|bpr-section|zd-order-section/);
  });
});

describe('under every design, the form is ours', () => {
  it('draws OUR form element — once, inside their order section — and no form of theirs', async () => {
    for (const skin of await skins()) {
      const { container } = render(<PageBlocks sections={page()} ctx={ctx({ design: skin })} />);
      const forms = container.querySelectorAll('#zaki-order-form');
      expect(forms.length, skin.id).toBe(1);
      expect(forms[0].getAttribute('data-ours'), skin.id).toBe('form');
      expect(forms[0].closest('.zd-order-section'), skin.id).not.toBeNull();
      expect(container.querySelector('#order-section, .order-card, form[action]'), skin.id).toBeNull();
      cleanup();
    }
  });

  it('and every order button is ours — none of their «#order-section» links', async () => {
    for (const skin of await skins()) {
      const { container } = render(<PageBlocks sections={page()} ctx={ctx({ design: skin })} />);
      const anchors = [...container.querySelectorAll('a[href^="#"]')].map((a) => a.getAttribute('href'));
      expect(anchors.length, skin.id).toBeGreaterThan(0);
      expect(anchors.every((h) => h === '#zf-full_name'), `${skin.id}: ${anchors.join(' ')}`).toBe(true);
      // the floating button is the plain block's, unchanged
      expect(container.querySelector('.lp-sticky'), skin.id).not.toBeNull();
      cleanup();
    }
  });
});

describe('under every design, the first screen keeps the locked core', () => {
  it('the headline, the price WITH the offer, the order button and the COD line', async () => {
    for (const skin of await skins()) {
      const { container } = render(<PageBlocks sections={page()} ctx={ctx({ design: skin })} />);
      const hero = container.querySelector('[data-zd-role="hero"]');
      expect(hero, skin.id).not.toBeNull();
      const text = hero!.textContent ?? '';
      expect(hero!.querySelector('h1')?.textContent, skin.id).toBe('طاقية الشعر الأصلية');
      // the preselected bundle's price, its own list price struck — the plain hero's rule (`heroPrice`)
      if (skin.sections.find((s) => s.role === 'hero')!.rows.some((r) => r.cols.some((c) => c.widgets.some((w) => w.k === 'heading' && w.slot === 'price')))) {
        expect(text, skin.id).toContain(moneyText(45, 'USD', 2));
        expect(hero!.querySelector('s')?.textContent, skin.id).toBe(moneyText(60, 'USD', 2));
      }
      expect(text, skin.id).toContain(COD_LINE);
      expect(hero!.querySelector('a[href="#zf-full_name"]'), skin.id).not.toBeNull();
      cleanup();
    }
  });
});

describe('the designed first screen prices exactly as the plain one', () => {
  const shapes: [string, BlockContext['offers']][] = [
    ['no bundles: the base price', []],
    ['the preselected bundle, its own list price struck', [OFFER]],
    ['no default: the first bundle', [{ ...OFFER, isDefault: false, listPrice: null }, { ...OFFER, id: 'o2', price: 80, isDefault: false }]],
    ['a claimed old price only', [{ ...OFFER, listPrice: null, compareAtPrice: 70 }]],
    ['an «old» price under the new one is not struck', [{ ...OFFER, listPrice: 40 }]],
  ];
  it.each(shapes)('%s', async (_name, offers) => {
    const skin = (await DESIGN_LOADERS['cod-bold']()).default;
    const hero = { ...newSection('hero'), headline: 'x' } as LandingSection;
    const plain = render(<PageBlocks sections={[hero]} ctx={ctx({ offers })} />).container.querySelector('.lp-price')!;
    const plainText = plain.textContent;
    const plainStruck = plain.querySelector('s')?.textContent ?? null;
    cleanup();
    const designed = render(<PageBlocks sections={[hero]} ctx={ctx({ offers, design: skin })} />).container.querySelector('h3')!;
    expect(designed.textContent).toBe(plainText);
    expect(designed.querySelector('s')?.textContent ?? null).toBe(plainStruck);
  });
});

describe('under every design, the words are ours', () => {
  it('none of their default copy reaches the page', async () => {
    for (const skin of await skins()) {
      const { container } = render(<PageBlocks sections={page()} ctx={ctx({ design: skin })} />);
      const text = container.textContent ?? '';
      for (const w of THEIRS) expect(text.includes(w), `${skin.id}: «${w}»`).toBe(false);
      // and the seller's words are there
      expect(text, skin.id).toContain('ميزة كتبها البائع');
      expect(text, skin.id).toContain('سؤال كتبه البائع؟');
      cleanup();
    }
  });

  it('the reviews are our reviews block — real buyers first, with our badge', async () => {
    const skin = (await DESIGN_LOADERS['cod-bold']()).default;
    const reviews: BlockContext['reviews'] = {
      items: [{ id: 'r1', rating: 5, text: 'وصلني بسرعة', firstName: 'هبة', city: 'حمص', verified: true, at: '2026-10-01' }],
      count: 1,
      average: null,
      showAverage: false,
    };
    const { container } = render(<PageBlocks sections={page()} ctx={ctx({ design: skin, reviews })} />);
    const frame = [...container.querySelectorAll('[data-zd-role="frame"]')].find((f) => f.textContent?.includes('وصلني بسرعة'));
    expect(frame).toBeTruthy();
    expect(frame!.textContent).toContain('مشتري مؤكَّد');
  });

  it('a seller’s marked-up words are sanitised, as they are without a design', async () => {
    const skin = (await DESIGN_LOADERS['cod-bold']()).default;
    const hero = { ...newSection('hero'), headline: '<b>قوي</b><img src=x onerror="alert(1)">' } as LandingSection;
    const { container } = render(<PageBlocks sections={[hero]} ctx={ctx({ design: skin })} />);
    expect(container.querySelector('h1 b')?.textContent).toBe('قوي');
    expect(container.querySelector('[onerror], h1 img')).toBeNull();
  });

  it('a block with nothing to say draws no section of theirs', async () => {
    const skin = (await DESIGN_LOADERS['cod-bold']()).default;
    const empty = [newSection('faq'), { ...newSection('urgency'), text: '', minutes: 0 } as LandingSection, { ...newSection('benefits'), items: [] } as LandingSection];
    const { container } = render(<PageBlocks sections={empty} ctx={ctx({ design: skin })} />);
    expect(container.querySelector('[data-zd-role]')).toBeNull();
  });
});

describe('their product photograph never; ours where theirs stood', () => {
  it('a banner that sat on their photo sits on the page’s own hero picture', async () => {
    const skin = (await DESIGN_LOADERS['daybreak']()).default as DesignSkin;
    const sections = page();
    const { container } = render(<PageBlocks sections={sections} ctx={ctx({ design: skin })} />);
    const banner = container.querySelector('[data-zd-role="topbanner"] .bpr-cta-4') as HTMLElement | null;
    expect(banner).not.toBeNull();
    expect(banner!.style.backgroundImage).toContain('/api/media/hero.jpg');
    expect(container.innerHTML).not.toMatch(/\/web\/media/);
  });
});

describe('the real order form, inside a design', () => {
  it('keeps its fields, its offers and its bot trap', async () => {
    const skin = (await DESIGN_LOADERS['cod-bold']()).default;
    const form = (
      <OrderForm slug="s" productName="طاقية" basePrice={30} currency="USD" offers={[OFFER]} recommendations={[]} regions={['دمشق']} />
    );
    const { container } = render(<PageBlocks sections={page()} ctx={ctx({ design: skin, form })} />);
    const root = container.querySelector('.zd-order-section #zaki-order-form');
    expect(root).not.toBeNull();
    expect(root!.querySelector('#zf-full_name')).not.toBeNull();
    expect(root!.querySelector('input[name="website"]')).not.toBeNull();
    expect(root!.textContent).toContain('عبوتان');
  });
});

const { start, fx, kit } = vi.hoisted(() => ({ start: vi.fn(), fx: vi.fn(), kit: vi.fn() }));
vi.mock('./motion/bpr-reveal', () => ({ start: () => start() }));
vi.mock('./motion/imx-fx', () => ({ start: () => fx() }));
vi.mock('./motion/mx-kit', () => ({ start: () => kit() }));

describe('the motion is loaded lazily, and never for whoever asked for stillness', () => {

  const mount = async (reduce: boolean, reveal = true, animated = false) => {
    start.mockClear();
    fx.mockClear();
    kit.mockClear();
    window.matchMedia = ((q: string) => ({ matches: reduce && q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {} })) as never;
    const { DesignMotion } = await import('./DesignMotion');
    await act(async () => {
      render(<DesignMotion reveal={reveal} animated={animated} />);
      // Long enough for a lazy chunk that WAS asked for to have arrived.
      await new Promise((r) => setTimeout(r, 150));
    });
  };

  it('starts the reveal once the page is idle', async () => {
    await mount(false);
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
  });

  it('loads nothing under prefers-reduced-motion', async () => {
    await mount(true);
    expect(start).not.toHaveBeenCalled();
  });

  it('an animated design loads its effect layer, then its kit — and not the static reveal', async () => {
    await mount(false, false, true);
    await vi.waitFor(() => expect(kit).toHaveBeenCalledTimes(1));
    expect(fx).toHaveBeenCalledTimes(1);
    expect(fx.mock.invocationCallOrder[0]).toBeLessThan(kit.mock.invocationCallOrder[0]);
    expect(start).not.toHaveBeenCalled();
  });

  it('and loads none of it under prefers-reduced-motion', async () => {
    await mount(true, false, true);
    expect(fx).not.toHaveBeenCalled();
    expect(kit).not.toHaveBeenCalled();
  });

  it('loads nothing for a design with no motion', async () => {
    await mount(false, false);
    expect(start).not.toHaveBeenCalled();
  });

  it('is mounted by the published page and never by the builder', () => {
    expect(stripComments(repoFile('src/components/landing/LandingPageView.tsx'))).toMatch(/<DesignMotion\b/);
    expect(stripComments(repoFile('src/components/landing-editor/BlockBuilder.tsx'))).not.toMatch(/DesignMotion/);
  });

  it('and the uploaded-HTML sanitizer has nothing to do with any of it', () => {
    expect(repoFile('src/lib/landing-html-sanitize.ts')).not.toMatch(/landing-designs/);
  });
});

describe('the animated designs, with our words', () => {
  it('there are twenty-eight, each with its effect layer in the first screen and no text in it', async () => {
    const animated = (await skins()).filter((s) => s.animated);
    expect(animated).toHaveLength(28);
    for (const skin of animated) {
      const { container } = render(<PageBlocks sections={page()} ctx={ctx({ design: skin })} />);
      const fxLayer = container.querySelector('[data-zd-role="hero"] .imx-fx');
      expect(fxLayer, skin.id).not.toBeNull();
      expect(fxLayer!.textContent?.trim(), skin.id).toBe('');
      expect(fxLayer!.getAttribute('aria-hidden'), skin.id).toBe('true');
      cleanup();
    }
  });

  it('the running line runs the page’s own benefit titles — or the trust facts — never theirs', async () => {
    const skin = (await DESIGN_LOADERS['imx-nebula']()).default;
    const { container } = render(<PageBlocks sections={page()} ctx={ctx({ design: skin })} />);
    const rows = container.querySelectorAll('.mx-marquee .mx-marquee-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('ميزة كتبها البائع');
    expect(rows[1].getAttribute('aria-hidden')).toBe('true');
    cleanup();
    const noBenefits = page().filter((s) => s.type !== 'benefits');
    const r2 = render(<PageBlocks sections={noBenefits} ctx={ctx({ design: skin })} />);
    expect(r2.container.querySelector('.mx-marquee-row')?.textContent).toContain(trustRow()[0].title);
  });

  it('a kit section of theirs carries a block of ours: benefits in the cascade, steps on the road', async () => {
    const skin = (await DESIGN_LOADERS['imx-aurum']()).default;
    const steps = { ...newSection('timeline'), title: 'مراحل كتبها البائع', points: [{ when: 'أول أسبوع', what: 'شي' }] } as LandingSection;
    const { container } = render(<PageBlocks sections={[...page(), steps]} ctx={ctx({ design: skin })} />);
    const card = container.querySelector('.mx-cascade .mx-cascade-card');
    expect(card?.textContent).toContain('ميزة كتبها البائع');
    expect(card?.querySelector('img')?.getAttribute('src')).toBe('/api/media/hero.jpg');
    expect(container.querySelector('.mx-road .mx-road-title')?.textContent).toBe('مراحل كتبها البائع');
    expect(container.querySelector('.mx-road .mx-road-step')?.textContent).toContain('أول أسبوع');
  });

  it('their top bar wears the product’s name and OUR order button, in place of ours', async () => {
    const { DesignNavbar } = await import('./DesignedBlocks');
    const skin = (await DESIGN_LOADERS['imx-aurum']()).default;
    const { container } = render(<DesignNavbar productName="طاقية" skin={skin} />);
    expect(container.querySelector('.mx-topbar .mx-topbar-brand')?.textContent).toBe('طاقية');
    expect(container.querySelector('.mx-topbar a.mx-topbar-cta')?.getAttribute('href')).toBe('#zf-full_name');
    expect(container.querySelector('.zd-navbar')).toBeNull();
    cleanup();
    const plain = render(<DesignNavbar productName="طاقية" skin={(await DESIGN_LOADERS['imx-nebula']()).default} />);
    expect(plain.container.querySelector('.zd-navbar')).not.toBeNull();
  });

  it('the real order form inside an animated design keeps its fields, its offers and its bot trap — and no motion hook', async () => {
    const skin = (await DESIGN_LOADERS['imx-nebula']()).default;
    const form = (
      <OrderForm slug="s" productName="طاقية" basePrice={30} currency="USD" offers={[OFFER]} recommendations={[]} regions={['دمشق']} />
    );
    const { container } = render(<PageBlocks sections={page()} ctx={ctx({ design: skin, form })} />);
    const root = container.querySelector('.zd-order-section #zaki-order-form');
    expect(root).not.toBeNull();
    expect(root!.querySelector('#zf-full_name')).not.toBeNull();
    expect(root!.querySelector('input[name="website"]')).not.toBeNull();
    // The kit hides what carries its reveal classes until the script shows it; the form must never wait on a script.
    expect(root!.closest('[class*="mx-"]')).toBeNull();
    expect(root!.querySelector('[class*="mx-up"], [class*="mx-split"], [class*="mx-stagger"], [class*="mx-scale"], [class*="mx-clip"]')).toBeNull();
  });
});
