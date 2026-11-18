// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React, { useState } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Checkbox } from './Checkbox';

/**
 * A TICK BOX THAT IS A TICK BOX (R2b, 18/11).
 *
 * Seventy-six hand-written checkboxes, in dozens of shapes. These pin the one
 * shape the screens will move onto: a real input, a label that toggles it, a
 * name, a keyboard, a row a thumb can hit, and a sentence tied to the box.
 *
 * jsdom cannot lay anything out, so «44px» is proved the way the rest of this
 * repository proves it: the classes that make it 44px on a phone and let the
 * desk go back to its own height, and no pseudo-element trick that a
 * checkbox cannot draw.
 */

afterEach(cleanup);

/** A box that holds its own tick, the way every screen holds one. */
function Harness(props: Partial<React.ComponentProps<typeof Checkbox>> & { start?: boolean }) {
  const [on, setOn] = useState(props.start ?? false);
  const { start, onChange, ...rest } = props;
  void start;
  return (
    <>
      <Checkbox
        label="أرسل رسالة بعد الشحن"
        {...rest}
        checked={on}
        onChange={(v, e) => {
          setOn(v);
          onChange?.(v, e);
        }}
      />
      <span data-testid="now">{String(on)}</span>
    </>
  );
}
const now = () => screen.getByTestId('now').textContent;

describe('the box', () => {
  it('is a real checkbox input, and nothing else is announced as one', () => {
    render(<Harness />);
    const box = screen.getByRole('checkbox', { name: 'أرسل رسالة بعد الشحن' });
    expect(box.tagName).toBe('INPUT');
    expect(box.getAttribute('type')).toBe('checkbox');
    expect(screen.getAllByRole('checkbox').length, 'عنصرٌ آخر يدّعي أنه مربّع اختيار').toBe(1);
  });

  it('takes its name from the label, and the label points at it', () => {
    render(<Harness />);
    const box = screen.getByRole('checkbox');
    const label = box.closest('label')!;
    expect(label.getAttribute('for')).toBe(box.id);
    expect(box.id, 'بلا معرّف لا يشير الوسم إلى شيء').not.toBe('');
  });

  it('takes a name from aria-label when there are no words', () => {
    render(<Harness label={undefined} aria-label="حدد كل المعروض" />);
    expect(screen.getByRole('checkbox', { name: 'حدد كل المعروض' })).toBeTruthy();
  });

  it('keeps the id the caller gave, then the name, before inventing one', () => {
    render(<Harness id="mine" />);
    expect(screen.getByRole('checkbox').id).toBe('mine');
    cleanup();
    render(<Harness name="after" />);
    expect(screen.getByRole('checkbox').id).toBe('after');
  });
});

describe('pressing it', () => {
  it('toggles when the WORDS are pressed, not only the box', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByText('أرسل رسالة بعد الشحن'));
    expect(now(), 'ضغطُ الكلمات لم يعلّم المربّع').toBe('true');
    await user.click(screen.getByText('أرسل رسالة بعد الشحن'));
    expect(now()).toBe('false');
  });

  it('toggles on Space, and a Tab reaches it', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('checkbox'));
    await user.keyboard(' ');
    expect(now(), 'المسطرة لم تعلّم المربّع').toBe('true');
    await user.keyboard(' ');
    expect(now()).toBe('false');
  });

  it('says the value it is asking for, and what the event was', async () => {
    const user = userEvent.setup();
    const seen = vi.fn();
    render(<Harness onChange={seen} />);
    await user.click(screen.getByRole('checkbox'));
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen.mock.calls[0][0]).toBe(true);
    expect(seen.mock.calls[0][1].target).toBe(screen.getByRole('checkbox'));
  });

  it('is controlled: a parent that ignores the change keeps the box where it was', async () => {
    const user = userEvent.setup();
    render(<Checkbox label="ثابت" checked={false} onChange={() => {}} />);
    await user.click(screen.getByRole('checkbox'));
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  });
});

describe('a box that cannot be pressed', () => {
  it('ignores the label, the box and the keyboard', async () => {
    const user = userEvent.setup();
    const seen = vi.fn();
    render(<Harness disabled onChange={seen} />);
    const box = screen.getByRole('checkbox') as HTMLInputElement;
    expect(box.disabled).toBe(true);
    await user.click(screen.getByText('أرسل رسالة بعد الشحن'));
    await user.click(box);
    await user.tab();
    await user.keyboard(' ');
    expect(seen, 'المعطَّل استجاب').not.toHaveBeenCalled();
    expect(now()).toBe('false');
  });

  it('and an enabled one is not disabled by accident', () => {
    render(<Harness />);
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(false);
  });
});

describe('the hint and the error', () => {
  it('a hint is tied to the box, and is not an error', () => {
    render(<Harness hint="تصل الرسالة بعد خروج الشحنة" />);
    const box = screen.getByRole('checkbox');
    const hint = screen.getByText('تصل الرسالة بعد خروج الشحنة');
    expect(box.getAttribute('aria-describedby')).toBe(hint.id);
    expect(box.getAttribute('aria-invalid'), 'التلميح علّم المربّع غير صالح').toBeNull();
    expect(hint.className).not.toContain('destructive');
  });

  it('an error replaces the hint, is tied to the box, and marks it invalid', () => {
    render(<Harness hint="تلميح" error="لازم توافق أولاً" />);
    const box = screen.getByRole('checkbox');
    const err = screen.getByText('لازم توافق أولاً');
    expect(box.getAttribute('aria-describedby')).toBe(err.id);
    expect(box.getAttribute('aria-invalid')).toBe('true');
    expect(err.className).toContain('destructive');
    expect(screen.queryByText('تلميح'), 'التلميح بقي مع الخطأ').toBeNull();
  });

  it('says nothing, and points at nothing, when there is neither', () => {
    render(<Harness />);
    const box = screen.getByRole('checkbox');
    expect(box.getAttribute('aria-describedby')).toBeNull();
    expect(box.getAttribute('aria-invalid')).toBeNull();
  });

  it('keeps a description the caller tied on, beside its own', () => {
    render(
      <>
        <p id="outside">ملاحظة خارجية</p>
        <Harness hint="تلميح" aria-describedby="outside" />
      </>
    );
    const ids = (screen.getByRole('checkbox').getAttribute('aria-describedby') ?? '').split(' ');
    expect(ids).toContain('outside');
    expect(ids.length).toBe(2);
  });
});

describe('the half-ticked state', () => {
  it('is set on the node, because there is no attribute for it', () => {
    render(<Checkbox label="الكل" checked={false} indeterminate onChange={() => {}} />);
    expect((screen.getByRole('checkbox') as HTMLInputElement).indeterminate).toBe(true);
  });

  it('is not set when it is not asked for', () => {
    render(<Checkbox label="الكل" checked={false} onChange={() => {}} />);
    expect((screen.getByRole('checkbox') as HTMLInputElement).indeterminate).toBe(false);
  });

  it('comes back after a re-render, and goes when the screen drops it', () => {
    const { rerender } = render(<Checkbox label="الكل" checked={false} indeterminate onChange={() => {}} />);
    const box = screen.getByRole('checkbox') as HTMLInputElement;
    box.indeterminate = false; // what a click does by itself
    rerender(<Checkbox label="الكل" checked={false} indeterminate onChange={() => {}} />);
    expect(box.indeterminate, 'لم يعد «بعضها محدّد» بعد إعادة الرسم').toBe(true);
    rerender(<Checkbox label="الكل" checked indeterminate={false} onChange={() => {}} />);
    expect(box.indeterminate).toBe(false);
  });

  it('is ticked by a press, which is what a select-all means', async () => {
    const user = userEvent.setup();
    const seen = vi.fn();
    render(<Checkbox label="الكل" checked={false} indeterminate onChange={seen} />);
    await user.click(screen.getByRole('checkbox'));
    expect(seen.mock.calls[0][0]).toBe(true);
  });
});

describe('a thumb', () => {
  it('hits a 44px row on a phone, and the desk goes back to its own height', () => {
    render(<Harness />);
    const row = screen.getByRole('checkbox').closest('label')!;
    expect(row.className).toContain('min-h-11');
    expect(row.className).toContain('md:min-h-0');
    // Wide as well as tall, for a box with no words beside it.
    expect(row.className).toContain('min-w-11');
    expect(row.className).toContain('md:min-w-0');
  });

  it('is a plain row — no pseudo-element grown over its neighbour', () => {
    render(<Harness />);
    const row = screen.getByRole('checkbox').closest('label')!;
    expect(row.className).not.toContain('absolute');
    expect(screen.getByRole('checkbox').className, 'tap-safe لا يرسم شيئاً على مربّع').not.toContain('tap-safe');
  });

  it('keeps the box beside the first line of a long label', () => {
    const long = 'أوافق على أن تُرسَل لي رسالة بعد كل شحنة وبعد كل تسليم وبعد كل مرتجع مهما طالت هذه الجملة';
    render(<Harness label={long} />);
    const row = screen.getByRole('checkbox').closest('label')!;
    expect(row.className).toContain('items-start');
    // The words may shrink and wrap; they must not push the row off the page.
    expect(row.className).toContain('max-w-full');
    expect(screen.getByText(long).className).toContain('min-w-0');
  });
});

describe('what it is made of', () => {
  const src = readFileSync(join(process.cwd(), 'src/components/ui/Checkbox.tsx'), 'utf8');

  it('draws the box with colours from the system, never a literal one', () => {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).toContain('var(--sys-');
    expect(code, 'لون حرفي في مربّع الاختيار').not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(/);
  });

  it('has no word on it that is not Arabic', () => {
    // The only visible text a caller does not supply: none.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const strings = [...code.matchAll(/>\s*([A-Za-z][A-Za-z ]+)\s*</g)].map((m) => m[1]);
    expect(strings).toEqual([]);
  });
});
