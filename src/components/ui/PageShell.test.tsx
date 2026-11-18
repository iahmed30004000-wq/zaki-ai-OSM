// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';

/**
 * DEFINITION OF DONE — the frame of a screen (R2c, plan 17/11).
 * What must work: the header comes from the existing `PageHeader` (the name as ONE h1, the sentence, the ⓘ, the actions and a chip),
 * then the toolbar, the filters and the content, in that order; `width` only ever CAPS the width. Edge cases: no part is drawn when it
 * is not given; nothing in it can make a phone scroll sideways; nothing in it is left- or right-handed (the page is right-to-left).
 * Blockers: it holds no data and no state, asks the router nothing, and changes no screen (no screen uses it yet).
 */

// The ⓘ lives in `PageHeader` and reads the shell's context; here it is a stand-in so the test can see WHERE the frame puts it.
vi.mock('@/components/shell/ScreenGuide', () => ({
  GuideButton: () => <button type="button" data-testid="guide">اشرح لي هذه الشاشة</button>,
}));

import { PageShell, PAGE_WIDTHS, type PageWidth } from './PageShell';

afterEach(cleanup);

const SOURCE = readFileSync('src/components/ui/PageShell.tsx', 'utf8');
/** The code with its comments taken out: the rules below are about what is drawn, not what is said. */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function all(root: HTMLElement): HTMLElement[] {
  return [root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))];
}

describe('the header', () => {
  it('is the screen`s ONE h1, drawn by PageHeader, with its sentence, its ⓘ, its chip and its actions', () => {
    render(
      <div dir="rtl">
        <PageShell
          title="الطلبات"
          description="كل طلب وصل المتجر."
          badge={<span>٣ جديدة</span>}
          actions={<button type="button">طلب جديد</button>}
        >
          <p>المحتوى</p>
        </PageShell>
      </div>,
    );
    const heads = screen.getAllByRole('heading', { level: 1 });
    expect(heads).toHaveLength(1);
    expect(heads[0].textContent).toBe('الطلبات');
    const header = document.querySelector('header')!;
    expect(header).not.toBeNull();
    expect(within(header).getByText('كل طلب وصل المتجر.')).toBeTruthy();
    expect(within(header).getByTestId('guide')).toBeTruthy();
    expect(within(header).getByText('٣ جديدة')).toBeTruthy();
    expect(within(header).getByRole('button', { name: 'طلب جديد' })).toBeTruthy();
  });

  it('draws no other heading of its own: the content brings its own h2s', () => {
    render(<PageShell title="س"><h2>قسم</h2></PageShell>);
    expect(screen.getAllByRole('heading').map((h) => h.tagName)).toEqual(['H1', 'H2']);
  });

  it('is built from PageHeader and does not copy its markup', () => {
    expect(CODE).toMatch(/import \{ PageHeader \} from '\.\/PageHeader'/);
    expect(CODE).toContain('<PageHeader');
    expect(CODE).not.toContain('<h1');
    expect(CODE).not.toContain('GuideButton');
  });
});

describe('the parts and their order', () => {
  it('reads header, toolbar, filters, content — top to bottom', () => {
    render(
      <PageShell title="س" toolbar={<span>الشريط</span>} filters={<span>المرشّحات</span>}>
        <span>المحتوى</span>
      </PageShell>,
    );
    const order = ['س', 'الشريط', 'المرشّحات', 'المحتوى'].map((t) => screen.getByText(t));
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING, `الجزء ${i}`).toBeTruthy();
    }
  });

  it('draws no empty row for a part that was not given', () => {
    const { container } = render(<PageShell title="س"><span>المحتوى</span></PageShell>);
    const frame = container.firstElementChild as HTMLElement;
    // the header and the content, nothing between them
    expect(Array.from(frame.children).map((c) => c.tagName)).toEqual(['HEADER', 'DIV']);
    expect(screen.queryByTestId('guide')).toBeTruthy(); // the ⓘ is the header`s, not the frame`s
  });

  it('gives the toolbar and the filters a row each, and the content the page`s rhythm', () => {
    const { container } = render(
      <PageShell title="س" toolbar={<span>الشريط</span>} filters={<span>المرشّحات</span>}>
        <span>أ</span>
        <span>ب</span>
      </PageShell>,
    );
    const frame = container.firstElementChild as HTMLElement;
    expect(Array.from(frame.children).map((c) => c.tagName)).toEqual(['HEADER', 'DIV', 'DIV', 'DIV']);
    expect(frame.children[1].textContent).toBe('الشريط');
    expect(frame.children[2].textContent).toBe('المرشّحات');
    expect(frame.children[3].className).toContain('space-y-6');
    expect(frame.children[3].textContent).toBe('أب');
  });

  it('holds no state and fetches nothing: no hook, no router, no network', () => {
    expect(CODE).not.toMatch(/\buse[A-Z]\w*\(/);
    expect(CODE).not.toContain('next/navigation');
    expect(CODE).not.toMatch(/fetch|apiFetch|useApi/);
  });
});

describe('the width', () => {
  const widths = Object.keys(PAGE_WIDTHS) as PageWidth[];

  it('is full unless the screen says otherwise, and each other width is a cap', () => {
    const { container } = render(<PageShell title="س" />);
    expect((container.firstElementChild as HTMLElement).className).toBe('min-w-0');
    expect(widths).toEqual(['full', 'wide', 'medium', 'narrow']);
    for (const w of widths) {
      cleanup();
      const { container: c } = render(<PageShell title="س" width={w} />);
      const cls = (c.firstElementChild as HTMLElement).className;
      if (w === 'full') expect(cls).toBe('min-w-0');
      else expect(cls, w).toMatch(/\bmax-w-\w+\b/);
    }
  });

  it('only caps — never a fixed or a minimum width that a phone could not fit', () => {
    // The class names are written in pieces: the stylesheet scans this file too, and a bare name here would grow it.
    const bad = new RegExp(
      [
        ['w', 'screen'].join('-'),
        'w-\\[',
        'min-w-\\[',
        ['min-w', 'full'].join('-'),
        ['min-w', 'screen'].join('-'),
        ['overflow-x', 'scroll'].join('-'),
        ['whitespace', 'nowrap'].join('-'),
      ].join('|'),
    );
    for (const w of widths) {
      cleanup();
      const { container } = render(
        <PageShell title="س" width={w} toolbar={<i />} filters={<i />} actions={<i />}>
          <i />
        </PageShell>,
      );
      for (const el of all(container)) expect(el.getAttribute('class') ?? '', `${w}: ${el.tagName}`).not.toMatch(bad);
    }
    expect(Object.values(PAGE_WIDTHS).join(' ')).not.toMatch(bad);
  });

  it('lets every block shrink (`min-w-0`) so a wide table or a long word cannot widen the page', () => {
    const { container } = render(<PageShell title="س" toolbar={<i />} filters={<i />}><i /></PageShell>);
    const frame = container.firstElementChild as HTMLElement;
    expect(frame.className).toContain('min-w-0');
    for (const part of Array.from(frame.children).slice(1)) expect(part.className, part.textContent ?? '').toContain('min-w-0');
  });
});

describe('right to left', () => {
  it('uses no left- or right-handed class: the page flips with the language, not with a rule', () => {
    const hand = new RegExp(
      [
        '(^|\\s)(ml|mr|pl|pr)-',
        ['text', 'left'].join('-'),
        ['text', 'right'].join('-'),
        '(^|\\s)(left|right)-',
        ['float', 'left'].join('-'),
        ['float', 'right'].join('-'),
      ].join('|'),
    );
    const { container } = render(
      <div dir="rtl">
        <PageShell title="س" width="wide" toolbar={<i />} filters={<i />} actions={<i />}><i /></PageShell>
      </div>,
    );
    for (const el of all(container)) expect(el.getAttribute('class') ?? '', el.tagName).not.toMatch(hand);
    expect(Object.values(PAGE_WIDTHS).join(' ')).not.toMatch(hand);
  });

  it('puts the actions after the name in reading order, so on a desk they sit at the end of the row', () => {
    render(
      <div dir="rtl">
        <PageShell title="الاسم" actions={<button type="button">إجراء</button>} />
      </div>,
    );
    const name = screen.getByText('الاسم');
    const action = screen.getByRole('button', { name: 'إجراء' });
    expect(name.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
