// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { LabelSizePicker, dimsOf, forgetLabelSize, useLabelSize } from './LabelSize';

/**
 * PICKING A SIZE AND PRINTING IT.
 *
 * The complaint from every warehouse: choosing a label size has no effect.
 * The reproduction is below, and it is not the @page rule — that rule is
 * written with a literal value.
 *
 * `useLabelSize()` is a hook over localStorage with NO shared state. A
 * screen that prints calls it once for the size, and renders
 * `<LabelSizePicker />`, which calls it again for the dropdown. Two calls,
 * two independent pieces of React state, and nothing connecting them:
 *
 *   - `setItem` does not notify the document that called it. The `storage`
 *     event fires in OTHER tabs, never in this one — by specification.
 *   - There is no context, no custom event, no external store.
 *
 * So the dropdown changes, localStorage changes, and the print button goes
 * on sending the size that was in storage when the screen mounted. It
 * starts working after a reload, which is why it reads as "sometimes" and
 * why nobody could pin it down.
 */

/** A screen: it prints with one instance and renders the picker, which has another. */
function ScreenThatPrints() {
  const forPrinting = useLabelSize();
  return (
    <div>
      <output data-testid="will-print">
        {forPrinting.dims.width}×{forPrinting.dims.height}
      </output>
      <LabelSizePicker />
    </div>
  );
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  // The store is one module-level value shared by every caller — which is
  // the whole point of it, and which means a test must clear it too.
  forgetLabelSize();
});

describe('the size the print button will actually send', () => {
  it('starts at the default', async () => {
    await act(async () => {
      render(<ScreenThatPrints />);
    });
    expect(screen.getByTestId('will-print').textContent).toBe('100×150');
  });

  it('FOLLOWS the dropdown in the same tab — the defect', async () => {
    await act(async () => {
      render(<ScreenThatPrints />);
    });

    await act(async () => {
      fireEvent.change(screen.getByLabelText('مقاس البوليصة'), { target: { value: '100x100' } });
    });

    // The choice reached storage...
    expect(JSON.parse(localStorage.getItem('salesflow.labelSize')!).key).toBe('100x100');
    // ...and it must reach the thing that prints, in this tab, now.
    expect(screen.getByTestId('will-print').textContent).toBe('100×100');
  });

  it('and a custom size in millimetres reaches it too', async () => {
    await act(async () => {
      render(<ScreenThatPrints />);
    });

    await act(async () => {
      fireEvent.change(screen.getByLabelText('مقاس البوليصة'), { target: { value: 'custom' } });
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('العرض (مم)'), { target: { value: '80' } });
      fireEvent.change(screen.getByLabelText('الطول (مم)'), { target: { value: '60' } });
    });

    expect(screen.getByTestId('will-print').textContent).toBe('80×60');
  });

  it('survives a reload — the size is remembered, not just current', async () => {
    await act(async () => {
      render(<ScreenThatPrints />);
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('مقاس البوليصة'), { target: { value: 'a6' } });
    });

    cleanup();
    await act(async () => {
      render(<ScreenThatPrints />);
    });
    expect(screen.getByTestId('will-print').textContent).toBe('105×148');
  });
});

/**
 * THE GUARD FOR THE DEFECT ITSELF.
 *
 * The cure is one external store instead of a `useState` per caller. These
 * check the property that matters — every reader agrees, now — rather than
 * the mechanism, so a future rewrite that keeps the promise still passes.
 */
describe('every reader agrees', () => {
  function ThreeReaders() {
    const a = useLabelSize();
    const b = useLabelSize();
    return (
      <div>
        <output data-testid="a">{a.dims.width}</output>
        <output data-testid="b">{b.dims.width}</output>
        <LabelSizePicker />
      </div>
    );
  }

  it('three instances in one tree move together', async () => {
    await act(async () => {
      render(<ThreeReaders />);
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('مقاس البوليصة'), { target: { value: 'a4' } });
    });
    expect(screen.getByTestId('a').textContent).toBe('210');
    expect(screen.getByTestId('b').textContent).toBe('210');
  });

  it('and a change made in another tab reaches this one', async () => {
    await act(async () => {
      render(<ThreeReaders />);
    });
    // What the browser does when a second tab writes the key.
    localStorage.setItem('salesflow.labelSize', JSON.stringify({ key: '100x100', custom: { width: 100, height: 150 } }));
    await act(async () => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'salesflow.labelSize' }));
    });
    expect(screen.getByTestId('a').textContent).toBe('100');
  });
});

describe('the preview shows what will print', () => {
  it('names the millimetres that will be sent', async () => {
    await act(async () => {
      render(<LabelSizePicker />);
    });
    expect(screen.getByTestId('preview-mm').textContent).toBe('100×150 mm');
  });

  it('and follows the choice', async () => {
    await act(async () => {
      render(<LabelSizePicker />);
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('مقاس البوليصة'), { target: { value: 'a6' } });
    });
    expect(screen.getByTestId('preview-mm').textContent).toBe('105×148 mm');
    // A6 on A4 is four to a sheet — the dropdown's claim, shown.
    expect(screen.getByText('4 لكل ورقة')).toBeTruthy();
  });
});

/**
 * «بخانة الطباعة مقاس مخصص حدد خانة الطول و العرض مش محطوط».
 *
 * The two custom boxes had a name only for a screen reader. And they sent
 * what was being typed: a «7» on the way to «75» reached the batch
 * endpoint, which takes whole millimetres from 40 to 300, and the print
 * failed with a validation error.
 */
describe('the custom boxes say which is which, and send only what prints', () => {
  async function customPicker(compact?: boolean) {
    await act(async () => {
      render(
        <div>
          <ScreenThatPrints />
          {compact && <LabelSizePicker compact />}
        </div>
      );
    });
    await act(async () => {
      fireEvent.change(screen.getAllByLabelText('مقاس البوليصة')[0], { target: { value: 'custom' } });
    });
  }

  it.each([false, true])('names both boxes on the screen, width first (compact: %s)', async (compact) => {
    await customPicker(compact);
    const widths = screen.getAllByText('العرض (مم)');
    const heights = screen.getAllByText('الطول (مم)');
    expect(widths.length).toBe(compact ? 2 : 1);
    for (const [i, w] of widths.entries()) {
      // A visible label element, tied to its own box.
      expect(w.tagName).toBe('LABEL');
      const wBox = document.getElementById(w.getAttribute('for')!) as HTMLInputElement;
      const hBox = document.getElementById(heights[i].getAttribute('for')!) as HTMLInputElement;
      expect(wBox.value).toBe('100');
      expect(hBox.value).toBe('150');
      expect(wBox.compareDocumentPosition(hBox) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it.each([
    ['7', '40×150'],
    ['75.5', '76×150'],
    ['999', '300×150'],
    ['', '100×150'],
    ['80', '80×150'],
  ])('a width typed as «%s» prints as %s', async (typed, prints) => {
    await customPicker();
    await act(async () => {
      fireEvent.change(screen.getByLabelText('العرض (مم)'), { target: { value: typed } });
    });
    expect(screen.getByTestId('will-print').textContent).toBe(prints);
    expect(screen.getByTestId('preview-mm').textContent).toBe(`${prints} mm`);
  });

  it('a half-typed height is held too', async () => {
    await customPicker();
    await act(async () => {
      fireEvent.change(screen.getByLabelText('الطول (مم)'), { target: { value: '3' } });
    });
    expect(screen.getByTestId('will-print').textContent).toBe('100×40');
  });

  it('leaving the box writes back what will print', async () => {
    await customPicker();
    const box = screen.getByLabelText('العرض (مم)') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(box, { target: { value: '7' } });
    });
    expect(box.value).toBe('7'); // typing is not interrupted
    await act(async () => {
      fireEvent.blur(box);
    });
    expect(box.value).toBe('40');
    expect(JSON.parse(localStorage.getItem('salesflow.labelSize')!).custom.width).toBe(40);
  });

  it('dimsOf never returns a half-typed number', () => {
    expect(dimsOf({ key: 'custom', custom: { width: 7, height: 75.5 } })).toEqual({ width: 40, height: 76 });
    expect(dimsOf({ key: 'custom', custom: { width: Number.NaN, height: 0 } })).toEqual({ width: 100, height: 150 });
    expect(dimsOf({ key: 'custom', custom: { width: 301, height: 299.6 } })).toEqual({ width: 300, height: 300 });
    expect(dimsOf({ key: 'custom', custom: { width: 40, height: 300 } })).toEqual({ width: 40, height: 300 });
  });

  it('a stored nonsense size is settled on reading, not thrown back to the default', async () => {
    localStorage.setItem('salesflow.labelSize', JSON.stringify({ key: 'custom', custom: { width: 58.4, height: 'x' } }));
    await act(async () => {
      render(<ScreenThatPrints />);
    });
    expect(screen.getByTestId('will-print').textContent).toBe('58×150');
    // The boxes show the settled numbers too, not the stored nonsense.
    expect((screen.getByLabelText('العرض (مم)') as HTMLInputElement).value).toBe('58');
    expect((screen.getByLabelText('الطول (مم)') as HTMLInputElement).value).toBe('150');
  });

  it.each([false, true])('says the barcode may not scan under 60 mm wide, and only then (compact: %s)', async (compact) => {
    await customPicker(compact);
    const hint = 'عرض أقل من 60 مم — الباركود ممكن ما يقرأه الماسح.';
    expect(screen.queryAllByText(hint)).toHaveLength(0);
    await act(async () => {
      fireEvent.change(screen.getAllByLabelText('العرض (مم)')[0], { target: { value: '59' } });
    });
    expect(screen.getAllByText(hint).length).toBe(compact ? 2 : 1);
    await act(async () => {
      fireEvent.change(screen.getAllByLabelText('العرض (مم)')[0], { target: { value: '60' } });
    });
    expect(screen.queryAllByText(hint)).toHaveLength(0);
  });

  it.each([
    ['', false],
    ['0', false],
    ['59.6', false],
    ['7', true],
  ])('reads the width that PRINTS, not the one being typed: «%s» → hint %s', async (typed, shown) => {
    // An empty box or «0» prints 100 mm and «59.6» prints 60: no warning.
    // «7» prints 40: warning. The raw number would say the opposite for the first three.
    await customPicker();
    const hint = 'عرض أقل من 60 مم — الباركود ممكن ما يقرأه الماسح.';
    await act(async () => {
      fireEvent.change(screen.getByLabelText('العرض (مم)'), { target: { value: typed } });
    });
    expect(screen.queryAllByText(hint)).toHaveLength(shown ? 1 : 0);
  });
});
