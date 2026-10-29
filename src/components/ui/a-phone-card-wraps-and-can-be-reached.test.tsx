// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import React from 'react';
import { Rows, type Column } from './Rows';
import { repoFile, stripComments } from '@/lib/guard-source';

/**
 * A CARD IN A HAND MUST WRAP, MUST SAY WHAT IS WIDE, AND MUST BE REACHED.
 *
 * M4 of the phone audit (FIN-08 · FIN-09 · FIN-25). Three faults of the shared
 * card, each one the same fault on every list that draws a card:
 *
 *   FIN-08  the heading was a flex line that could not shrink, so a statement's
 *           file name or a barcode — one unbroken string — pushed the status chip
 *           off the card and the page sideways;
 *   FIN-09  every field was «label … value» on one line, so a value that is not a
 *           figure (two decisions, a list of receipts) was squeezed into what the
 *           label left over;
 *   FIN-25  the foot of the card held text links 16px tall.
 *
 * jsdom has no layout, so what is held here is what the layout depends on: the
 * classes that let a box shrink and wrap, the flag that stacks a field, and the
 * stylesheet rule that gives the foot its 44px. The measuring was done in a real
 * browser at 375px, against the built stylesheet (see the pull request).
 */

type Row = { id: string; code: string; note: string };
const ROW: Row = { id: 'r1', code: 'statement_aramex_2026_09_final_reconciled_copy.xlsx', note: 'ملاحظة' };

const cols = (wide: boolean): Column<Row>[] => [
  { key: 'code', label: 'الملف', primary: true, render: (r) => r.code },
  { key: 'note', label: 'ما وصل', wide, render: (r) => r.note },
  { key: 'plain', label: 'العدد', render: () => '٣' },
];

const draw = (wide = true, withActions = true) =>
  render(
    <Rows
      rows={[ROW]}
      keyOf={(r) => r.id}
      columns={cols(wide)}
      actions={withActions ? () => <button type="button">اعتماد</button> : undefined}
    />
  );

const card = (container: HTMLElement) => container.querySelector('ul > li') as HTMLElement;

afterEach(cleanup);

describe('the heading of a card (FIN-08)', () => {
  it('may shrink below its content and wraps, so one unbroken string cannot widen the card', () => {
    const { container } = draw();
    // The innermost span that says the code: the title itself, not the line that holds it.
    const title = [...card(container).querySelectorAll('span')].filter((s) => s.textContent === ROW.code).pop()!;
    expect(title.className, 'العنوان لا ينكمش').toContain('min-w-0');
    expect(title.className, 'العنوان لا ينكسر').toContain('break-words');
    const line = title.parentElement!;
    expect(line.className, 'سطر العنوان لا يلتفّ').toContain('flex-wrap');
    expect(line.className, 'سطر العنوان لا ينكمش').toContain('min-w-0');
  });

  it('and a long value on the card breaks as well, instead of leaving it', () => {
    const { container } = draw();
    const dd = card(container).querySelector('dd')!;
    expect(dd.className).toContain('min-w-0');
    expect(dd.className).toContain('break-words');
  });
});

describe('a wide field (FIN-09)', () => {
  it('puts the label above the value, at the full width of the card', () => {
    const { container } = draw(true);
    const field = [...card(container).querySelectorAll('dl > div')].find((d) => d.textContent?.includes('ما وصل'))!;
    expect(field.className).toContain('flex-col');
    expect(field.className).not.toContain('justify-between');
  });

  it('NEGATIVE: a field that is not wide keeps the label and the value on one line', () => {
    const { container } = draw(false);
    const fields = [...card(container).querySelectorAll('dl > div')];
    expect(fields).toHaveLength(2);
    for (const f of fields) {
      expect(f.className).toContain('justify-between');
      expect(f.className).not.toContain('flex-col');
    }
  });

  it('and the table is the same table — the flag changes the card only', () => {
    const wide = draw(true);
    const desk = wide.container.querySelector('table')!.outerHTML;
    cleanup();
    const plain = draw(false);
    expect(plain.container.querySelector('table')!.outerHTML).toBe(desk);
  });
});

describe('the foot of a card (FIN-25)', () => {
  it('is marked, so the stylesheet can give a finger 44px', () => {
    const { container } = draw();
    const foot = card(container).querySelector('.card-acts')!;
    expect(foot, 'ذيل البطاقة بلا علامة').not.toBeNull();
    expect(foot.querySelector('button')!.textContent).toBe('اعتماد');
  });

  it('and a card with no actions has no foot', () => {
    const { container } = draw(true, false);
    expect(card(container).querySelector('.card-acts')).toBeNull();
  });

  it('the rule is under a finger only, on the buttons and links the foot holds', () => {
    const css = stripComments(repoFile('src/app/(system)/system.css'));
    const coarse = /@media \(pointer: coarse\)\s*\{([\s\S]*?)\n\}/.exec(css);
    expect(coarse, 'لا كتلة للمس').not.toBeNull();
    const rule = /\.card-acts > :is\(a, button\)\s*\{([^}]*)\}/.exec(coarse![1]);
    expect(rule, 'لا قاعدة لذيل البطاقة داخل كتلة اللمس').not.toBeNull();
    expect(rule![1]).toMatch(/min-height:\s*44px/);
    // Centred, or a 16px word sits at the top of its 44px box.
    expect(rule![1]).toMatch(/align-items:\s*center/);
    // Nothing outside the touch block asks for it: a mouse keeps its dense foot.
    expect(css.replace(coarse![0], '')).not.toContain('.card-acts');
  });
});

/**
 * AND THE ONE FIELD THAT IS LARGER THAN 16PX ON PURPOSE.
 *
 * M1 lifted every field to 16px under a finger (system.css), which stops the
 * iPhone zooming on focus — and also shrinks the two-factor code box from 18 to
 * 16, because an unlayered rule beats a utility. An inline size beats that rule,
 * costs no stylesheet byte, and is still above the zoom threshold.
 */
describe('the two-factor code box', () => {
  it('keeps its 18px under the phone rule, in both steps that ask for a code', () => {
    const src = stripComments(repoFile('src/components/shell/SecondFactor.tsx'));
    // A field is read up to its own `/>`: the handlers inside it contain `>` of their own.
    const boxes = (src.match(/<input\b[\s\S]*?\/>/g) ?? []).filter((b) => b.includes('inputMode="numeric"'));
    expect(boxes).toHaveLength(2);
    for (const box of boxes) expect(box).toContain("style={{ fontSize: '1.125rem' }}");
  });
});
