// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@/lib/guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «الزبون عنده طلب مؤكَّد بنفس المنتج» — THE DIALOG, ALONE.
 *
 * The question the confirmation door asks before a second «نعم» (`TWIN_CONFIRMED`). It is the words, the list and the three buttons —
 * and it sends nothing: each screen sends the body with its own client. So what is pinned here is what a person reads and what each
 * button hands back; what each screen then sends is pinned in the two screens' own tests.
 *
 * DEFINITION OF DONE: the other orders are listed by number, colleague and time; exactly three buttons, the safe one first; each
 * calls its own callback once and nothing else; every word is Arabic; on a phone the three stack at the full width at 44px;
 * while a decision is in the air all three are shut.
 * ═══════════════════════════════════════════════════════════════════════
 */

import { TwinConfirmedDialog } from './TwinConfirmedDialog';

afterEach(cleanup);

const NOW = new Date('2026-11-02T12:00:00.000Z').getTime();
const TWINS = [
  { orderNumber: 'ORD-2026-1711', confirmedAt: '2026-11-02T11:48:00.000Z', confirmedByName: 'سارة' },
  { orderNumber: 'ORD-2026-1701', confirmedAt: '2026-11-02T09:50:00.000Z', confirmedByName: 'ريم' },
];

function draw(over: Partial<React.ComponentProps<typeof TwinConfirmedDialog>> = {}) {
  const fns = { onRejectAsDuplicate: vi.fn(), onConfirmAnyway: vi.fn(), onBack: vi.fn() };
  render(<TwinConfirmedDialog open orderNumber="ORD-2026-1696" twins={TWINS} now={NOW} {...fns} {...over} />);
  return fns;
}
const dialog = () => screen.getByRole('dialog');
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

describe('what it says', () => {
  it('names the order she is confirming and says what is true: the customer already has a confirmed order for the same product', () => {
    draw();
    expect(within(dialog()).getByRole('heading', { name: 'الزبون عنده طلب مؤكَّد بنفس المنتج' })).toBeTruthy();
    expect(dialog().textContent).toContain('ORD-2026-1696');
    expect(dialog().textContent).toContain('ولسا ما انسلّم لشركة الشحن');
  });

  it('lists the other orders by number, by colleague and by how long ago — the three things an agent says out loud', () => {
    draw();
    const items = within(dialog()).getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toEqual(['ORD-2026-1711 — أكّده سارة قبل 12 د', 'ORD-2026-1701 — أكّده ريم قبل 2 س 10 د']);
  });

  it('says what each answer means, in plain words', () => {
    draw();
    expect(dialog().textContent).toContain('إذا هو نفس الطلب أُرسل مرتين: ارفضه كمكرر');
    expect(dialog().textContent).toContain('وإذا هو طلب تاني فعلاً: أكّده وانت متأكد');
  });

  it('copes with what the door did not know: a gone colleague, a yes with no time, a yes a moment ago', () => {
    draw({
      twins: [
        { orderNumber: 'ORD-A', confirmedAt: null, confirmedByName: 'سارة' },
        { orderNumber: 'ORD-B', confirmedAt: '2026-11-02T11:00:00.000Z', confirmedByName: null },
        { orderNumber: 'ORD-C', confirmedAt: '2026-11-02T11:59:50.000Z', confirmedByName: 'ريم' },
      ],
    });
    expect(within(dialog()).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'ORD-A — أكّده سارة',
      'ORD-B — مؤكَّد قبل 1 س',
      'ORD-C — أكّده ريم قبل لحظات',
    ]);
  });

  it('with no list from the door it still asks the question and still offers the three answers', () => {
    draw({ twins: [] });
    expect(within(dialog()).queryAllByRole('listitem')).toEqual([]);
    for (const name of ['رفضه كمكرر', 'طلب تاني فعلاً — أكّد', 'رجوع']) expect(button(name)).toBeTruthy();
  });

  it('every word is Arabic: nothing in the dialog is Latin except the order numbers themselves', () => {
    draw();
    const text = (dialog().textContent ?? '').replace(/ORD-\d{4}-\d{4}/g, '');
    expect(text).not.toMatch(/[A-Za-z]/);
  });
});

describe('the three buttons — and only three', () => {
  it('are «رفضه كمكرر», «طلب تاني فعلاً — أكّد» and «رجوع», the safe one first and the way back last', () => {
    draw();
    const footer = button('رجوع').parentElement as HTMLElement;
    expect([...footer.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['رفضه كمكرر', 'طلب تاني فعلاً — أكّد', 'رجوع']);
  });

  it('«رفضه كمكرر» tells its screen to reject as a duplicate — once, and nothing else', () => {
    const fns = draw();
    fireEvent.click(button('رفضه كمكرر'));
    expect(fns.onRejectAsDuplicate).toHaveBeenCalledTimes(1);
    expect(fns.onConfirmAnyway).not.toHaveBeenCalled();
    expect(fns.onBack).not.toHaveBeenCalled();
  });

  it('«طلب تاني فعلاً — أكّد» tells its screen to confirm with her word — once, and nothing else', () => {
    const fns = draw();
    fireEvent.click(button('طلب تاني فعلاً — أكّد'));
    expect(fns.onConfirmAnyway).toHaveBeenCalledTimes(1);
    expect(fns.onRejectAsDuplicate).not.toHaveBeenCalled();
    expect(fns.onBack).not.toHaveBeenCalled();
  });

  it('«رجوع» only goes back — and so does Escape and the modal’s close; neither of them decides anything', () => {
    const fns = draw();
    fireEvent.click(button('رجوع'));
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'إغلاق' }));
    expect(fns.onBack).toHaveBeenCalledTimes(3);
    expect(fns.onRejectAsDuplicate).not.toHaveBeenCalled();
    expect(fns.onConfirmAnyway).not.toHaveBeenCalled();
  });

  it('while a decision is in the air all three are shut: a second press cannot send a second request', () => {
    const fns = draw({ busy: true });
    for (const name of ['رفضه كمكرر', 'طلب تاني فعلاً — أكّد', 'رجوع']) expect(button(name).disabled, name).toBe(true);
    fireEvent.click(button('رفضه كمكرر'));
    fireEvent.click(button('طلب تاني فعلاً — أكّد'));
    expect(fns.onRejectAsDuplicate).not.toHaveBeenCalled();
    expect(fns.onConfirmAnyway).not.toHaveBeenCalled();
  });

  it('closed, it draws nothing at all', () => {
    draw({ open: false });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('on a phone', () => {
  const has = (el: Element, c: string) => el.classList.contains(c);

  it('the three buttons are 44px tall, stacked at the full width, and share the footer row from sm up', () => {
    draw();
    for (const name of ['رفضه كمكرر', 'طلب تاني فعلاً — أكّد', 'رجوع']) {
      const b = button(name);
      expect(has(b, 'h-11'), `${name}: أقل من 44`).toBe(true);
      expect(has(b, 'w-full'), `${name}: ما أخذ العرض كله`).toBe(true);
      expect(has(b, 'sm:w-auto'), `${name}: ما رجع لعرضه من sm`).toBe(true);
    }
    const row = button('رجوع').parentElement as HTMLElement;
    expect(has(row, 'flex-col')).toBe(true);
    expect(has(row, 'sm:flex-row')).toBe(true);
  });

  it('the row is the modal’s footer, outside the part that scrolls, so the list can be long and the buttons stay on screen', () => {
    draw();
    const body = dialog().querySelector('[data-modal-body]') as HTMLElement;
    expect(body.contains(button('رجوع'))).toBe(false);
    expect(dialog().contains(button('رجوع'))).toBe(true);
  });

  it('the safe answer is drawn as the destructive decision it is, and the others are not', () => {
    draw();
    expect(button('رفضه كمكرر').className).toContain('--sys-destructive');
    expect(button('طلب تاني فعلاً — أكّد').className).not.toContain('bg-[var(--sys-destructive)]');
  });
});

describe('the file', () => {
  const src = stripComments(readFileSync(join(process.cwd(), 'src/components/orders/TwinConfirmedDialog.tsx'), 'utf8'));

  it('sends nothing and decides nothing itself: no request, no body, no acknowledgement', () => {
    expect(src).not.toMatch(/apiFetch|apiJson|fetch\(|acknowledgeTwin|rejectionReason|JSON\.stringify/);
  });

  it('uses the shared Button and Modal, not hand-made controls', () => {
    expect(src).toContain("from '@/components/ui/Button'");
    expect(src).toContain("from '@/components/ui/Modal'");
    expect(src).not.toMatch(/<button[\s>]/);
  });
});
