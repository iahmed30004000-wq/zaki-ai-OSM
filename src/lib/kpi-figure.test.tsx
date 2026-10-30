// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import React from 'react';
import { KpiCard } from '@/components/ui/Card';
import { Money } from '@/components/ui/Money';
import { FIGURE_STEPS, figureScale, figureText } from './kpi-figure';
import { repoFile, stripComments } from './guard-source';

/**
 * «بتحس الأرقام طالعة من مكانها» — THE BIG NUMBER ON A CARD STAYS IN ITS CARD.
 *
 * The figure was one size for every length, so «257,229.32 USD» filled a card
 * to both edges. It now takes a smaller step the longer it is, on the steps
 * the product already ships (no stylesheet byte), and the box may shrink and
 * never grows past the card.
 *
 * jsdom has no layout. The widths were measured in a real browser at 1920 ·
 * 1546 · 1280 · 1024 · 768 · 390 (see the pull request); what is held here is
 * what that measurement depends on: the step for each length, the classes
 * that let the box shrink, and the grids that decide how wide a card is.
 *
 * DISPLAY ONLY. The figure is whatever the server sent; nothing here adds,
 * rounds or converts it.
 */

afterEach(cleanup);

const PX: Record<string, number> = { 'text-display': 32, 'text-2xl': 24, 'text-xl': 20, 'text-lg': 18 };
const rule = 'قاعدة الاحتساب لهذا المؤشر جملة طويلة بما يكفي.';

/** The span that holds the figure: the one that is left-to-right and bold. */
function figureOf(container: HTMLElement): HTMLElement {
  const found = container.querySelector<HTMLElement>('span[dir="ltr"].font-bold');
  if (!found) throw new Error('no figure drawn');
  return found;
}

const CASES: ReadonlyArray<{ label: string; value: React.ReactNode; text: string }> = [
  { label: 'zero', value: '0', text: '0' },
  { label: 'a rate', value: '60%', text: '60%' },
  { label: 'a dash', value: '—', text: '—' },
  { label: 'dollars', value: <Money value={170269.02} currency="USD" />, text: '170,269.02 USD' },
  { label: 'dollars, delivered', value: <Money value={257229.32} currency="USD" />, text: '257,229.32 USD' },
  { label: 'lira', value: <Money value={1234567890} currency="SYP" minorUnit={0} />, text: '1,234,567,890 SYP' },
  { label: 'dinars', value: <Money value={123456.789} currency="JOD" minorUnit={3} />, text: '123,456.789 JOD' },
  { label: 'a negative', value: <Money value={-9999999.99} currency="USD" />, text: '-9,999,999.99 USD' },
];

describe('the size follows the length', () => {
  it('gives a short figure the full size and a long one a smaller step', () => {
    expect(figureScale('0')).toBe('text-display');
    expect(figureScale('60%')).toBe('text-display');
    expect(figureScale('—')).toBe('text-display');
    expect(figureScale('1,204')).toBe('text-display');
    expect(figureScale('170,269.02 USD')).toBe('text-xl');
    expect(figureScale('1,234,567,890 SYP')).toBe('text-lg');
  });

  it('holds every boundary of the ladder exactly', () => {
    // The last character that still fits a step, and the first that does not.
    let before = 0;
    for (const step of FIGURE_STEPS) {
      if (Number.isFinite(step.upTo)) {
        expect(figureScale('9'.repeat(step.upTo)), `آخر طول في ${step.size}`).toBe(step.size);
        expect(figureScale('9'.repeat(step.upTo + 1)), `أول طول بعد ${step.size}`).not.toBe(step.size);
      }
      expect(step.upTo).toBeGreaterThan(before);
      before = step.upTo;
    }
  });

  it('never grows a figure when it gets longer', () => {
    let last = Number.POSITIVE_INFINITY;
    for (let n = 0; n <= 40; n++) {
      const px = PX[figureScale('9'.repeat(n))];
      expect(px, `الطول ${n}`).toBeDefined();
      expect(px, `الطول ${n} كبّر الرقم`).toBeLessThanOrEqual(last);
      last = px;
    }
  });

  it('counts what is printed, not the spaces around it', () => {
    expect(figureScale('  60%  ')).toBe(figureScale('60%'));
  });

  it('reads a figure out of the nodes a card is handed', () => {
    for (const c of CASES) {
      expect(figureText(c.value), c.label).toBe(c.text);
    }
    expect(figureText(42)).toBe('42');
    expect(figureText(null)).toBe('');
    expect(figureText(<Money value={1500} currency={null} />)).toBe('1,500.00');
    expect(figureText(<>{'12'}{'%'}</>)).toBe('12%');
  });

  it('assumes a three-letter code when the money does not name one, which only ever errs smaller', () => {
    expect(figureText(<Money value={5} />)).toBe('5.00 USD');
  });
});

describe('the card draws it so it cannot leave', () => {
  it('lets the box shrink, caps it at the card, and keeps the digits tabular and left-to-right', () => {
    for (const c of CASES) {
      const { container, unmount } = render(<KpiCard title="مؤشر" value={c.value} rule={rule} />);
      const fig = figureOf(container);
      const cls = fig.className.split(/\s+/);
      expect(cls, c.label).toContain('min-w-0');
      expect(cls, c.label).toContain('max-w-full');
      expect(cls, c.label).toContain('tabular-nums');
      expect(cls, c.label).toContain('font-bold');
      expect(fig.getAttribute('dir'), c.label).toBe('ltr');
      expect(cls, c.label).toContain(figureScale(c.text));
      // One step, never two: a second size class would fight the first.
      expect(cls.filter((k) => k in PX), c.label).toHaveLength(1);
      unmount();
    }
  });

  it('puts a long figure on a smaller step than the full one', () => {
    const { container } = render(
      <KpiCard title="مؤشر" value={<Money value={257229.32} currency="USD" />} rule={rule} />,
    );
    expect(figureOf(container).className).not.toContain('text-display');
  });

  it('keeps the figure in Latin digits', () => {
    for (const c of CASES) {
      const { container, unmount } = render(<KpiCard title="مؤشر" value={c.value} rule={rule} />);
      expect(figureOf(container).textContent, c.label).not.toMatch(/[٠-٩۰-۹]/);
      expect(figureOf(container).textContent, c.label).toBe(c.text);
      unmount();
    }
  });

  it('lets the card itself shrink inside its grid, and keeps the health chip beside the figure', () => {
    const { container } = render(
      <KpiCard
        title="مؤشر"
        value="71%"
        rule={rule}
        health={{ tone: 'bad', label: 'ضعيف', why: 'تحت الحد' }}
      />,
    );
    const card = container.firstElementChild as HTMLElement;
    expect(card.className.split(/\s+/)).toContain('min-w-0');
    const row = figureOf(container).parentElement as HTMLElement;
    expect(row.className.split(/\s+/)).toContain('min-w-0');
    expect(row.textContent).toContain('ضعيف');
  });

  it('does not hang the figure on a tooltip', () => {
    const { container } = render(<KpiCard title="مؤشر" value="60%" rule={rule} />);
    expect(figureOf(container).hasAttribute('title')).toBe(false);
  });
});

describe('the grids that decide how wide a card is', () => {
  const read = (rel: string) => stripComments(repoFile(rel));

  it('draws the dashboard six as three by two and three as one row, never four across', () => {
    const src = read('src/components/screens/DashboardScreen.tsx');
    expect(src).toContain("'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4'");
    expect(src).toContain("'grid grid-cols-1 md:grid-cols-3 gap-4'");
    const old = ['grid grid-cols-2', ['lg', 'grid-cols-4'].join(':')].join(' ');
    expect(src, 'ست بطاقات بأربعة أعمدة تترك صفاً نصفه فارغ').not.toContain(old);
  });

  it('starts the money screens at one column on a phone and four only when a card has the room', () => {
    const profit = read('src/components/screens/FinanceProfitScreen.tsx');
    expect(profit).toContain('grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4');
    const products = read('src/components/screens/ProductsScreen.tsx');
    expect(products).toContain('grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4');
    // And a products page without the stock value has three cards, not four with a hole.
    expect(products).toContain('grid grid-cols-1 md:grid-cols-3 gap-4');
  });

  it('keeps one rule for the four-across breakpoint, so the stylesheet does not grow', () => {
    // A second breakpoint for the same four columns is a second rule in the sheet.
    const needle = ['lg', 'grid-cols-4'].join(':');
    for (const rel of [
      'src/components/screens/DashboardScreen.tsx',
      'src/components/screens/FinanceProfitScreen.tsx',
      'src/components/screens/ProductsScreen.tsx',
      'src/components/screens/PerformanceScreen.tsx',
      'src/components/settings/ThemePicker.tsx',
    ]) {
      expect(read(rel), rel).not.toContain(needle);
    }
  });

  it('lays the theme picker out three across before four, so twelve themes are not six rows', () => {
    expect(read('src/components/settings/ThemePicker.tsx')).toContain('sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4');
  });

  it('keeps the card on the scale the product already has', () => {
    const src = stripComments(repoFile('src/lib/kpi-figure.ts'));
    const sizes = [...src.matchAll(/size:\s*'([^']+)'/g)].map((m) => m[1]);
    expect(sizes.sort()).toEqual(['text-2xl', 'text-display', 'text-lg', 'text-xl']);
  });
});
