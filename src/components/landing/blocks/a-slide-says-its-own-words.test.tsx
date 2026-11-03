// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { PageBlocks, type BlockContext } from './PageBlocks';
import { landingSectionSchema, newSection, parseSections, type LandingSection } from '@/lib/landing-sections';

/**
 * «الشرائح» — their slider's per-slide title, line, button and link — and
 * the promise that came with it: a slider saved before keeps drawing exactly
 * as it did.
 */
const ctx = { palette: {} as BlockContext['palette'], productName: 'x', price: 0, currency: 'USD', stock: null, offers: [], form: null } as BlockContext;
const old = { id: 'sl', type: 'slider', enabled: true, title: 'الجديد', images: ['/api/public/media/a.jpg', '/api/public/media/b.jpg'], autoplay: true, seconds: 5 };
const draw = (s: LandingSection) => render(<PageBlocks sections={[s]} ctx={ctx} />).container;

describe('a slider saved before slides existed', () => {
  it('parses with no `slides` key at all', () => {
    const [s] = parseSections([old]);
    expect(s.type).toBe('slider');
    expect('slides' in s).toBe(false);
    expect('slides' in newSection('slider')).toBe(false);
  });

  it('draws its pictures with no caption, no link and no new attribute', () => {
    const html = draw(parseSections([old])[0]);
    expect(html.querySelectorAll('.lp-slider-slide img')).toHaveLength(2);
    expect(html.querySelector('.lp-slider-slide [style]')).toBeNull();
    expect(html.querySelector('.lp-slider-slide')?.getAttribute('style')).toBeNull();
    expect(html.querySelector('.lp-slider a')).toBeNull();
  });
});

describe('a slider with slides', () => {
  const slides = [
    { image: '/api/public/media/a.jpg', title: 'تشكيلة الشتاء', text: 'قطع جديدة كل أسبوع', button: 'تسوّق', link: '/s/my-shop/shop' },
    { image: '/api/public/media/b.jpg', title: 'عنوان ثاني', text: '', button: 'بلا رابط', link: '' },
    { image: '', title: 'بلا صورة', text: '', button: '', link: '' },
  ];
  const withSlides = () => parseSections([{ ...old, slides }])[0];

  it('each slide says its own words, and its button goes where the seller said', () => {
    const html = draw(withSlides());
    expect(html.textContent).toContain('تشكيلة الشتاء');
    expect(html.textContent).toContain('قطع جديدة كل أسبوع');
    const link = html.querySelector('.lp-slider a.lp-cta');
    expect(link?.getAttribute('href')).toBe('/s/my-shop/shop');
    expect(link?.textContent).toBe('تسوّق');
  });

  it('a button with no link is not drawn, and a slide with no picture is not a slide', () => {
    const html = draw(withSlides());
    expect(html.textContent).toContain('عنوان ثاني');
    expect(html.textContent).not.toContain('بلا رابط');
    expect(html.querySelectorAll('.lp-slider a.lp-cta')).toHaveLength(1);
    expect(html.textContent).not.toContain('بلا صورة');
    expect(html.querySelectorAll('.lp-slider-slide')).toHaveLength(2);
  });

  it('the link is the footer’s rule: never a script', () => {
    for (const link of ['javascript:alert(1)', 'data:text/html,x', '//evil.example']) {
      const bad = { ...old, slides: [{ ...slides[0], link }] };
      expect(landingSectionSchema.safeParse(bad).success, link).toBe(false);
    }
    expect(landingSectionSchema.safeParse({ ...old, slides: [{ ...slides[0], link: 'https://example.com/x' }] }).success).toBe(true);
  });

  it('holds at most ten', () => {
    expect(landingSectionSchema.safeParse({ ...old, slides: Array(11).fill(slides[0]) }).success).toBe(false);
  });
});
