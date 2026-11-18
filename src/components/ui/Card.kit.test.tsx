// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { Card } from './Card';
import { StatTile } from './StatTile';
import { CARD_CLASS } from '@/lib/theme-shape';

/**
 * R2a (18/11) — A CARD THAT PADS ITSELF, A CARD WITHOUT THE THEME'S
 * DECORATIONS, AND THE TILE BUILT ON THEM.
 */

afterEach(cleanup);

const surface = () => screen.getByTestId('c').firstElementChild as HTMLElement;
const tokens = (el: Element) => new Set(el.className.split(/\s+/).filter(Boolean));

const show = (props: React.ComponentProps<typeof Card> = { children: 'x' }) =>
  render(
    <div data-testid="c">
      <Card {...props} />
    </div>
  );

describe('a Card that is written the way it always was', () => {
  it('still carries the theme class, and pads nothing', () => {
    show({ children: 'x' });
    const set = tokens(surface());
    expect(set.has(CARD_CLASS)).toBe(true);
    expect([...set].filter((t) => /^p[xytblr]?-\d/.test(t))).toEqual([]);
  });
});

describe('padding', () => {
  const steps: Array<['sm' | 'md' | 'lg', string]> = [
    ['sm', 'p-3'],
    ['md', 'p-4'],
    ['lg', 'p-6'],
  ];
  for (const [name, cls] of steps) {
    it(`${name} is ${cls}`, () => {
      show({ children: 'x', padding: name });
      expect(tokens(surface()).has(cls)).toBe(true);
    });
  }

  it('none is no padding at all', () => {
    show({ children: 'x', padding: 'none' });
    expect([...tokens(surface())].filter((t) => /^p-\d/.test(t))).toEqual([]);
  });

  it('only the asked step, not a second one', () => {
    show({ children: 'x', padding: 'sm' });
    expect([...tokens(surface())].filter((t) => /^p-\d/.test(t))).toEqual(['p-3']);
  });
});

describe('plain', () => {
  it('drops the theme class — the corner, the arch and the glyph live on it', () => {
    show({ children: 'x', plain: true });
    expect(tokens(surface()).has(CARD_CLASS)).toBe(false);
  });

  it('and keeps the fill, the edge and the radius', () => {
    show({ children: 'x', plain: true });
    const set = tokens(surface());
    expect(set.has('rounded-lg')).toBe(true);
    expect(set.has('border')).toBe(true);
    expect([...set].some((t) => t.startsWith('bg-'))).toBe(true);
  });

  it('and composes with padding and with a caller class', () => {
    show({ children: 'x', plain: true, padding: 'md', className: 'mt-2' });
    const set = tokens(surface());
    expect(set.has('p-4')).toBe(true);
    expect(set.has('mt-2')).toBe(true);
    expect(set.has(CARD_CLASS)).toBe(false);
  });

  it('is off by default: a page-level card is still decorated', () => {
    show({ children: 'x', plain: false });
    expect(tokens(surface()).has(CARD_CLASS)).toBe(true);
  });
});

describe('StatTile', () => {
  it('shows the label, the figure and the caption, in that order', () => {
    render(<StatTile label="المسلَّمة اليوم" value="42" caption="أمس ٣٨" />);
    const text = document.body.textContent ?? '';
    expect(text.indexOf('المسلَّمة اليوم')).toBeLessThan(text.indexOf('42'));
    expect(text.indexOf('42')).toBeLessThan(text.indexOf('أمس ٣٨'));
  });

  it('names its figure by its label for a reader (a term and its value)', () => {
    render(<StatTile label="المسلَّمة اليوم" value="42" />);
    const dt = screen.getByText('المسلَّمة اليوم');
    expect(dt.tagName).toBe('DT');
    expect(screen.getByText('42').closest('dd')).toBeTruthy();
  });

  it('draws the caption only when there is one', () => {
    const { container, rerender } = render(<StatTile label="س" value="1" />);
    expect(container.querySelectorAll('dd').length).toBe(1);
    rerender(<StatTile label="س" value="1" caption="ملاحظة" />);
    expect(container.querySelectorAll('dd').length).toBe(2);
  });

  it('keeps the figure left-to-right inside an Arabic line, so a code stays after its number', () => {
    render(
      <div dir="rtl">
        <StatTile label="الربح" value="1,250.50 USD" />
      </div>
    );
    const fig = screen.getByText('1,250.50 USD');
    expect(fig.getAttribute('dir')).toBe('ltr');
    expect(tokens(fig).has('tabular-nums')).toBe(true);
  });

  it('does not compute: it prints exactly what it was given', () => {
    render(<StatTile label="س" value="٠٠٧٬٥" caption="+٣ ٪" />);
    expect(screen.getByText('٠٠٧٬٥')).toBeTruthy();
    expect(screen.getByText('+٣ ٪')).toBeTruthy();
  });

  it('takes a node as the figure, and the size steps down for a long one', () => {
    const { rerender } = render(<StatTile label="س" value="12" />);
    const short = tokens(screen.getByText('12'));
    rerender(<StatTile label="س" value="257,229.32 USD" />);
    const long = tokens(screen.getByText('257,229.32 USD'));
    expect(short.has('text-display')).toBe(true);
    expect(long.has('text-display')).toBe(false);
    expect(long.has('min-w-0')).toBe(true);
    expect(long.has('max-w-full')).toBe(true);
  });

  it('sits on a plain card: no theme decoration on a strip of tiles', () => {
    const { container } = render(<StatTile label="س" value="1" />);
    const root = container.firstElementChild as HTMLElement;
    expect(tokens(root).has(CARD_CLASS)).toBe(false);
    expect(tokens(root).has('p-4')).toBe(true);
  });
});
