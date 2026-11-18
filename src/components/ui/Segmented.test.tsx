// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React, { useState } from 'react';
import { Segmented, type SegmentedOption } from './Segmented';

/**
 * TWO TO FIVE CHOICES IN ONE BAR (R2b, 18/11).
 *
 * Twenty-five screens draw this by hand as a row of buttons. These pin what
 * those rows never agreed on: it says it is a set of exclusive choices, it
 * is one stop on the way down the page, the arrows go the way the page
 * reads in BOTH directions, a disabled option is jumped over, and a finger
 * can hit it.
 */

const OPTIONS: SegmentedOption[] = [
  { value: 'today', label: 'اليوم' },
  { value: 'yesterday', label: 'أمس' },
  { value: 'week', label: 'الأسبوع' },
  { value: 'month', label: 'الشهر' },
];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Harness({
  start = 'today',
  options = OPTIONS,
  dir = 'rtl',
  onChange,
  ...rest
}: Partial<React.ComponentProps<typeof Segmented>> & { start?: string; dir?: 'rtl' | 'ltr' }) {
  const [v, setV] = useState(start);
  return (
    <div dir={dir}>
      <Segmented
        aria-label="الفترة"
        {...rest}
        options={options}
        value={v}
        onChange={(next) => {
          setV(next);
          onChange?.(next);
        }}
      />
      <span data-testid="now">{v}</span>
    </div>
  );
}
const now = () => screen.getByTestId('now').textContent;
const radios = () => screen.getAllByRole('radio') as HTMLButtonElement[];

describe('the bar', () => {
  it('says it is a group of exclusive choices, with a name, and which is chosen', () => {
    render(<Harness />);
    expect(screen.getByRole('radiogroup', { name: 'الفترة' })).toBeTruthy();
    expect(radios().length).toBe(4);
    expect(radios().map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false', 'false']);
    expect(screen.queryAllByRole('tab').length, 'شريط الخيارات ليس تبويبات').toBe(0);
    expect(screen.queryAllByRole('button').length, 'خيارٌ أُعلن زرّاً').toBe(0);
  });

  it('names the group from aria-labelledby as well', () => {
    render(
      <>
        <span id="cap">طريقة العرض</span>
        <Harness aria-label={undefined} aria-labelledby="cap" />
      </>
    );
    expect(screen.getByRole('radiogroup', { name: 'طريقة العرض' })).toBeTruthy();
  });

  it('shows a count beside a name when it has one', () => {
    render(
      <Harness
        options={[
          { value: 'a', label: 'الجديدة', count: 12 },
          { value: 'b', label: 'المؤجلة', count: 0 },
          { value: 'c', label: 'المغلقة' },
        ]}
        start="a"
      />
    );
    expect(radios()[0].textContent).toContain('12');
    expect(radios()[1].textContent, 'الصفر عدد وليس غياباً').toContain('0');
    expect(radios()[2].textContent).toBe('المغلقة');
  });

  it('chooses by a press, once, and says which', async () => {
    const user = userEvent.setup();
    const seen = vi.fn();
    render(<Harness onChange={seen} />);
    await user.click(screen.getByRole('radio', { name: 'الأسبوع' }));
    expect(now()).toBe('week');
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledWith('week');
  });

  it('does not say «changed» when the chosen one is pressed again', async () => {
    const user = userEvent.setup();
    const seen = vi.fn();
    render(<Harness onChange={seen} />);
    await user.click(screen.getByRole('radio', { name: 'اليوم' }));
    expect(seen).not.toHaveBeenCalled();
  });

  it('is controlled: a parent that ignores the change keeps the highlight where it was', async () => {
    const user = userEvent.setup();
    render(<Segmented aria-label="س" options={OPTIONS} value="today" onChange={() => {}} />);
    await user.click(screen.getByRole('radio', { name: 'الشهر' }));
    expect(radios().map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false', 'false']);
  });
});

describe('one stop on the way down the page', () => {
  const stops = () => radios().filter((r) => r.tabIndex === 0).length;

  it('is the chosen option', () => {
    render(<Harness start="week" />);
    expect(stops()).toBe(1);
    expect(radios()[2].tabIndex).toBe(0);
  });

  it('is the first option that can be chosen when nothing is', () => {
    render(
      <Harness
        start="nothing"
        options={[{ value: 'a', label: 'أ', disabled: true }, ...OPTIONS.slice(0, 2)]}
      />
    );
    expect(stops()).toBe(1);
    expect(radios()[1].tabIndex, 'المحطّة على خيارٍ معطَّل').toBe(0);
  });

  it('is reached by Tab once, and leaves by Tab once', async () => {
    const user = userEvent.setup();
    render(
      <>
        <Harness start="month" />
        <button type="button">التالي</button>
      </>
    );
    await user.tab();
    expect(document.activeElement).toBe(radios()[3]);
    await user.tab();
    expect(document.activeElement, 'Tab مرّ على كل خيار').toBe(screen.getByRole('button', { name: 'التالي' }));
  });

  it('follows the choice when the screen changes it', () => {
    const { rerender } = render(<Segmented aria-label="س" options={OPTIONS} value="today" onChange={() => {}} />);
    rerender(<Segmented aria-label="س" options={OPTIONS} value="month" onChange={() => {}} />);
    expect(radios()[3].tabIndex).toBe(0);
    expect(radios()[0].tabIndex).toBe(-1);
  });
});

describe('the arrow keys, in a page that reads right to left', () => {
  it('the left arrow is the NEXT one and the right arrow the previous', async () => {
    const user = userEvent.setup();
    render(<Harness start="yesterday" dir="rtl" />);
    radios()[1].focus();
    await user.keyboard('{ArrowLeft}');
    expect(now(), 'اليسار لم يذهب إلى التالي').toBe('week');
    await user.keyboard('{ArrowRight}');
    expect(now()).toBe('yesterday');
    await user.keyboard('{ArrowRight}');
    expect(now()).toBe('today');
  });

  it('and the focus goes where the choice goes', async () => {
    const user = userEvent.setup();
    render(<Harness dir="rtl" />);
    radios()[0].focus();
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(radios()[1]);
    // The very next arrow starts from there, not from where focus was left.
    await user.keyboard('{ArrowLeft}');
    expect(now()).toBe('week');
    expect(document.activeElement).toBe(radios()[2]);
  });
});

describe('the arrow keys, in a page that reads left to right', () => {
  it('the right arrow is the NEXT one and the left arrow the previous', async () => {
    const user = userEvent.setup();
    render(<Harness start="yesterday" dir="ltr" />);
    radios()[1].focus();
    await user.keyboard('{ArrowRight}');
    expect(now(), 'اليمين لم يذهب إلى التالي في الاتجاه المعاكس').toBe('week');
    await user.keyboard('{ArrowLeft}');
    expect(now()).toBe('yesterday');
  });
});

describe('the keys that do not depend on direction', () => {
  it('down is next and up is previous, in either', async () => {
    const user = userEvent.setup();
    for (const dir of ['rtl', 'ltr'] as const) {
      cleanup();
      render(<Harness start="yesterday" dir={dir} />);
      radios()[1].focus();
      await user.keyboard('{ArrowDown}');
      expect(now()).toBe('week');
      await user.keyboard('{ArrowUp}');
      expect(now()).toBe('yesterday');
    }
  });

  it('Home and End go to the first and the last', async () => {
    const user = userEvent.setup();
    render(<Harness start="yesterday" />);
    radios()[1].focus();
    await user.keyboard('{End}');
    expect(now()).toBe('month');
    expect(document.activeElement).toBe(radios()[3]);
    await user.keyboard('{Home}');
    expect(now()).toBe('today');
    expect(document.activeElement).toBe(radios()[0]);
  });

  it('wraps round at both ends', async () => {
    const user = userEvent.setup();
    render(<Harness start="month" dir="rtl" />);
    radios()[3].focus();
    await user.keyboard('{ArrowLeft}');
    expect(now(), 'لم يلتفّ إلى الأول').toBe('today');
    await user.keyboard('{ArrowRight}');
    expect(now(), 'لم يلتفّ إلى الأخير').toBe('month');
  });

  it('leaves other keys alone', async () => {
    const user = userEvent.setup();
    const seen = vi.fn();
    render(<Harness onChange={seen} />);
    radios()[0].focus();
    await user.keyboard('a');
    await user.keyboard('{Escape}');
    expect(seen).not.toHaveBeenCalled();
  });

  it('chooses with Space and Enter on a focused option, as any button does', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    radios()[2].focus();
    await user.keyboard(' ');
    expect(now()).toBe('week');
    radios()[3].focus();
    await user.keyboard('{Enter}');
    expect(now()).toBe('month');
  });
});

describe('an option that cannot be chosen', () => {
  const WITH_OFF: SegmentedOption[] = [
    { value: 'a', label: 'الأول' },
    { value: 'b', label: 'الثاني', disabled: true },
    { value: 'c', label: 'الثالث' },
    { value: 'd', label: 'الرابع', disabled: true },
  ];

  it('is not chosen by a press', async () => {
    const user = userEvent.setup();
    const seen = vi.fn();
    render(<Harness options={WITH_OFF} start="a" onChange={seen} />);
    expect(radios()[1].disabled).toBe(true);
    await user.click(radios()[1]);
    expect(seen).not.toHaveBeenCalled();
    expect(now()).toBe('a');
  });

  it('is jumped over by the arrows, not stopped on', async () => {
    const user = userEvent.setup();
    render(<Harness options={WITH_OFF} start="a" dir="rtl" />);
    radios()[0].focus();
    await user.keyboard('{ArrowLeft}');
    expect(now(), 'توقّف على الخيار المعطَّل').toBe('c');
    await user.keyboard('{ArrowLeft}');
    expect(now(), 'الالتفاف لم يتجاوز المعطَّل').toBe('a');
    await user.keyboard('{ArrowRight}');
    expect(now()).toBe('c');
  });

  it('is not the end that End goes to, nor the start that Home goes to', async () => {
    const user = userEvent.setup();
    render(
      <Harness
        options={[
          { value: 'a', label: 'أ', disabled: true },
          { value: 'b', label: 'ب' },
          { value: 'c', label: 'ج' },
          { value: 'd', label: 'د', disabled: true },
        ]}
        start="b"
      />
    );
    radios()[1].focus();
    await user.keyboard('{End}');
    expect(now()).toBe('c');
    await user.keyboard('{Home}');
    expect(now()).toBe('b');
  });

  it('still shows as the chosen one when the screen chose it', () => {
    render(<Harness options={WITH_OFF} start="b" />);
    expect(radios()[1].getAttribute('aria-checked')).toBe('true');
    // …and the Tab stop is on one that can be pressed.
    expect(radios().filter((r) => r.tabIndex === 0).length).toBe(1);
    expect(radios()[0].tabIndex).toBe(0);
  });

  it('with every option off, nothing moves and nothing is a stop', async () => {
    const user = userEvent.setup();
    const seen = vi.fn();
    render(<Harness disabled onChange={seen} />);
    expect(radios().every((r) => r.disabled)).toBe(true);
    expect(radios().filter((r) => r.tabIndex === 0).length).toBe(0);
    await user.click(radios()[2]);
    fireEvent.keyDown(screen.getByRole('radiogroup'), { key: 'ArrowLeft' });
    expect(seen).not.toHaveBeenCalled();
  });
});

describe('a thumb', () => {
  it('md: 44px on a phone, 40px on a desk', () => {
    render(<Harness size="md" />);
    for (const r of radios()) {
      expect(r.className).toContain('min-h-11');
      expect(r.className).toContain('md:min-h-10');
    }
  });

  it('sm: 44px on a phone and a compact desk row', () => {
    render(<Harness size="sm" />);
    for (const r of radios()) {
      expect(r.className).toContain('min-h-11');
      expect(r.className).toContain('md:min-h-0');
      expect(r.className).toContain('text-xs');
    }
  });

  it('is the default size md', () => {
    render(<Harness />);
    expect(radios()[0].className).toContain('md:min-h-10');
  });

  it('options are plain neighbours — no overlay grown over the next one', () => {
    render(<Harness />);
    for (const r of radios()) {
      expect(r.className).not.toContain('tap-safe');
      expect(r.className).not.toContain('absolute');
    }
  });

  it('wraps a long name inside its own option instead of scrolling the bar sideways', () => {
    render(
      <Harness
        options={[
          { value: 'a', label: 'الطلبات التي تنتظر ردّ الزبون منذ أكثر من يومين' },
          { value: 'b', label: 'الكل' },
        ]}
        start="a"
      />
    );
    const group = screen.getByRole('radiogroup');
    expect(group.className).toContain('max-w-full');
    expect(group.className).not.toContain('overflow-x');
    for (const r of radios()) {
      expect(r.className).toContain('min-w-0');
      expect(r.className).not.toContain('whitespace-nowrap');
    }
  });
});

describe('how many options it holds', () => {
  const opts = (n: number): SegmentedOption[] =>
    Array.from({ length: n }, (_, i) => ({ value: `v${i}`, label: `خيار ${i + 1}` }));

  it('says so at the desk for one, and for six', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<Segmented aria-label="س" options={opts(1)} value="v0" onChange={() => {}} />);
    expect(warn).toHaveBeenCalledTimes(1);
    cleanup();
    render(<Segmented aria-label="س" options={opts(6)} value="v0" onChange={() => {}} />);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('is silent from two to five', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const n of [2, 3, 4, 5]) {
      render(<Segmented aria-label="س" options={opts(n)} value="v0" onChange={() => {}} />);
      cleanup();
    }
    expect(warn, 'تحذيرٌ على عددٍ مسموح').not.toHaveBeenCalled();
  });

  it('still draws what it was given — it does not drop an option quietly', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<Segmented aria-label="س" options={opts(6)} value="v0" onChange={() => {}} />);
    expect(radios().length).toBe(6);
  });
});
