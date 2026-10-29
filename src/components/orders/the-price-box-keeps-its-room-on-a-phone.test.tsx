// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import React, { useState } from 'react';

/**
 * THE PRICE BOX KEEPS ITS ROOM ON A PHONE.
 *
 * The owner (29-30/10): «لما يدخلو يعدلو السعر فراغ السعر يكون مبين» — when they
 * open an order to edit the price, the price box must be visible.
 *
 * Each product line was ONE unwrapped row: the quantity stepper (two 36px
 * buttons and a 64px box), the price box, and the 96px line figure. In the
 * width of an order panel on a 360px phone (about 296px inside its padding)
 * the stepper and the figure take about 256px and leave the price box roughly
 * forty — a box too narrow to read the figure being edited.
 *
 * jsdom has no layout, so the width is not measured here; what is measured is
 * the rule that produces it: the row WRAPS, and the price box has a floor it
 * will not shrink below — so on a phone it drops to its own line at the full
 * width, and on a desk, where there is room, it stays beside the stepper.
 */

vi.mock('@/lib/api-client', () => ({ apiFetch: vi.fn(), apiJson: vi.fn() }));
vi.mock('@/components/ui/Confirm', () => ({ useAsk: () => async () => null }));
vi.mock('@/components/ui/ProductThumb', () => ({ ProductThumb: () => <span /> }));
vi.mock('@/components/ui/ProductPicker', () => ({ ProductPicker: () => <span /> }));

import { ProductLinesEditor, newLine, type DraftLine } from './ProductLinesEditor';

const PRODUCT = { id: 'prodTwentyFive', name: 'كريم', basePrice: 25, offers: [] };

function Harness() {
  const [lines, setLines] = useState<DraftLine[]>([
    { ...newLine(), productId: PRODUCT.id, price: '25' },
  ]);
  return <ProductLinesEditor lines={lines} products={[PRODUCT]} currency={{ code: 'JOD', minorUnit: 2 }} onChange={setLines} />;
}

afterEach(() => cleanup());

describe('the price box on a product line', () => {
  it('has a floor under its width — it cannot shrink to the forty pixels the stepper leaves', () => {
    render(<Harness />);
    const box = screen.getByPlaceholderText('سعر السطر');
    const label = box.closest('label')!;
    expect(label.className).toContain('min-w-[150px]');
    expect(label.className).toContain('flex-1');
  });

  it('sits in a row that wraps, so what does not fit goes to the next line instead of squeezing the box', () => {
    render(<Harness />);
    const row = screen.getByPlaceholderText('سعر السطر').closest('label')!.parentElement!;
    expect(row.className).toContain('flex-wrap');
    // NEGATIVE: the stepper and the figure are children of THAT row — the wrap decides all three together.
    expect(row.querySelectorAll('button[aria-label="زد الكمية"]')).toHaveLength(1);
  });
});
