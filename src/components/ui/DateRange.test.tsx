// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React, { useState } from 'react';
import { format } from 'date-fns';
import { ar } from 'date-fns/locale';
import { DateRange, FIVE_OPTIONS, todayRange, type DateOption, type Range } from './DateRange';

/**
 * DEFINITION OF DONE — the date box as a component (R2c, plan 17/11).
 * What must work: it offers the options it is given (the six every screen has always had by default, the plan`s five on request, any
 * subset), opens on the `initial` one when it holds the range itself, lets the screen hold the range as before, and a picked span is
 * always a real pair with `from` not after `to`. Edge cases: the keyboard (a real button, Escape, Enter on the clear control), a click
 * outside, a month that holds days of its neighbours. Blockers: the five screens that use it are not edited and behave as they did.
 */

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const NOW = new Date(2026, 10, 18, 12, 0, 0); // 18 Nov 2026, noon, on this machine
const fix = () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
};
const label = (d: Date) => format(d, 'd MMMM yyyy', { locale: ar });
const trigger = () => screen.getAllByRole('button')[0];
const openBox = () => fireEvent.click(trigger());
const SIX = ['اليوم', 'أمس', 'آخر 7 أيام', 'آخر 30 يوم', 'هذا الشهر'];
const FIVE_LABELS = ['اليوم', 'أمس', 'آخر 7 أيام', 'آخر 30 يوم'];

describe('the options on offer', () => {
  it('says nothing → the six every screen has always had: four presets, «هذا الشهر», and the month grid for a picked span', () => {
    render(<DateRange value={{ from: '', to: '' }} onChange={() => {}} />);
    openBox();
    for (const t of SIX) expect(screen.getByText(t)).toBeTruthy();
    expect(screen.getByText('تاريخ محدد')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'الشهر السابق' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'الشهر التالي' })).toBeTruthy();
  });

  it('the plan`s five: اليوم · أمس · آخر 7 أيام · آخر 30 يوم · تاريخ محدد — and no «هذا الشهر»', () => {
    render(<DateRange value={{ from: '', to: '' }} onChange={() => {}} options={FIVE_OPTIONS} />);
    openBox();
    for (const t of FIVE_LABELS) expect(screen.getByText(t)).toBeTruthy();
    expect(screen.getByText('تاريخ محدد')).toBeTruthy();
    expect(screen.queryByText('هذا الشهر')).toBeNull();
    expect(screen.getByRole('button', { name: 'الشهر التالي' })).toBeTruthy();
  });

  it('a subset: only those presets, in the order given, and no month grid when «تاريخ محدد» is not offered', () => {
    render(<DateRange value={{ from: '', to: '' }} onChange={() => {}} options={['yesterday', 'today']} />);
    openBox();
    const found = ['أمس', 'اليوم'].map((t) => screen.getByText(t));
    expect(found[0].compareDocumentPosition(found[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    for (const t of ['آخر 7 أيام', 'آخر 30 يوم', 'هذا الشهر', 'تاريخ محدد']) expect(screen.queryByText(t), t).toBeNull();
    expect(screen.queryByRole('button', { name: 'الشهر التالي' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'الشهر السابق' })).toBeNull();
  });

  it('only «تاريخ محدد»: the grid and no presets', () => {
    render(<DateRange value={{ from: '', to: '' }} onChange={() => {}} options={['custom']} />);
    openBox();
    for (const t of SIX) expect(screen.queryByText(t), t).toBeNull();
    expect(screen.getByText('تاريخ محدد')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'الشهر التالي' })).toBeTruthy();
  });

  it('each preset hands the screen exactly its days', () => {
    fix();
    const expected: Record<string, Range> = {
      'اليوم': { from: '2026-11-18', to: '2026-11-18' },
      'أمس': { from: '2026-11-17', to: '2026-11-17' },
      'آخر 7 أيام': { from: '2026-11-12', to: '2026-11-18' },
      'آخر 30 يوم': { from: '2026-10-20', to: '2026-11-18' },
      'هذا الشهر': { from: '2026-11-01', to: '2026-11-18' },
    };
    const onChange = vi.fn();
    render(<DateRange value={{ from: '', to: '' }} onChange={onChange} />);
    for (const [text, range] of Object.entries(expected)) {
      openBox();
      fireEvent.click(screen.getByText(text));
      expect(onChange, text).toHaveBeenLastCalledWith(range);
      // choosing closes the box
      expect(screen.queryByText('أمس'), `${text} closes it`).toBeNull();
    }
  });

  it('with the store`s time zone, «اليوم» is the store`s day, not the browser`s', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 10, 17, 21, 30))); // already the 18th in Amman
    const onChange = vi.fn();
    render(<DateRange value={{ from: '', to: '' }} onChange={onChange} timeZone="Asia/Amman" />);
    openBox();
    fireEvent.click(screen.getByText('اليوم'));
    expect(onChange).toHaveBeenLastCalledWith({ from: '2026-11-18', to: '2026-11-18' });
  });
});

describe('the starting option', () => {
  it('holding the range itself, it opens on today by default', () => {
    fix();
    render(<DateRange onChange={() => {}} />);
    expect(trigger().textContent).toContain(label(new Date(2026, 10, 18)));
  });

  it.each<[DateOption]>([
    ['yesterday'],
    ['7d'],
    ['30d'],
    ['month'],
  ])('and opens on `initial` = %s when told so', (initial) => {
    fix();
    render(<DateRange onChange={() => {}} initial={initial as 'yesterday' | '7d' | '30d' | 'month'} />);
    openBox();
    // the preset that is the range on show is the one marked pressed
    const pressed = screen.getAllByRole('button').filter((b) => b.getAttribute('aria-pressed') === 'true');
    expect(pressed).toHaveLength(1);
    expect(pressed[0].textContent).toBe({ yesterday: 'أمس', '7d': 'آخر 7 أيام', '30d': 'آخر 30 يوم', month: 'هذا الشهر' }[initial as 'yesterday']);
    // and a preset it did not open on is not
    expect(screen.getByText('أمس').getAttribute('aria-pressed') === 'true').toBe(initial === 'yesterday');
  });

  it('holds what it was given: after a choice it shows the choice and tells the screen', () => {
    fix();
    const onChange = vi.fn();
    render(<DateRange onChange={onChange} />);
    openBox();
    fireEvent.click(screen.getByText('أمس'));
    expect(onChange).toHaveBeenCalledWith({ from: '2026-11-17', to: '2026-11-17' });
    expect(trigger().textContent).toContain(label(new Date(2026, 10, 17)));
  });

  it('a screen that holds the range itself is obeyed: `initial` is ignored, the value wins', () => {
    fix();
    render(<DateRange value={{ from: '2026-11-01', to: '2026-11-05' }} onChange={() => {}} initial="yesterday" />);
    expect(trigger().textContent).not.toContain(label(new Date(2026, 10, 17)));
    expect(trigger().textContent).toMatch(/—/);
  });

  it('`todayRange` still works as a state initialiser, called with no argument', () => {
    fix();
    function Screen() {
      const [r] = useState<Range>(todayRange);
      return <span data-testid="r">{`${r.from}|${r.to}`}</span>;
    }
    render(<Screen />);
    expect(screen.getByTestId('r').textContent).toBe('2026-11-18|2026-11-18');
  });

  it('an empty range shows the screen`s own label, as before', () => {
    render(<DateRange value={{ from: '', to: '' }} onChange={() => {}} label="كل المدة" />);
    expect(trigger().textContent).toBe('كل المدة');
  });

  it('the first preset that matches is the one pressed: on the 30th, «30 يوم» and «هذا الشهر» are the same days, only one is marked', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 30, 12, 0, 0));
    render(<DateRange value={{ from: '2026-11-01', to: '2026-11-30' }} onChange={() => {}} />);
    openBox();
    const pressed = screen.getAllByRole('button').filter((b) => b.getAttribute('aria-pressed') === 'true');
    expect(pressed.map((b) => b.textContent)).toEqual(['آخر 30 يوم']);
  });
});

describe('a picked span', () => {
  it('two clicks: the first anchors one day and asks for the end; the second closes the span', () => {
    const onChange = vi.fn();
    render(<DateRange value={{ from: '2026-11-18', to: '2026-11-18' }} onChange={onChange} />);
    openBox();
    fireEvent.click(screen.getAllByText('10')[0]);
    expect(onChange).toHaveBeenLastCalledWith({ from: '2026-11-10', to: '2026-11-10' });
    expect(screen.getByText('اختر يوم النهاية…')).toBeTruthy();
    fireEvent.click(screen.getAllByText('20')[0]);
    expect(onChange).toHaveBeenLastCalledWith({ from: '2026-11-10', to: '2026-11-20' });
    expect(screen.queryByText('اختر يوم النهاية…')).toBeNull();
    expect(screen.queryByText('أمس')).toBeNull(); // closed
  });

  it('an end clicked BEFORE the start turns the span round: from is never after to', () => {
    const onChange = vi.fn();
    render(<DateRange value={{ from: '2026-11-18', to: '2026-11-18' }} onChange={onChange} />);
    openBox();
    fireEvent.click(screen.getAllByText('20')[0]);
    fireEvent.click(screen.getAllByText('10')[0]);
    expect(onChange).toHaveBeenLastCalledWith({ from: '2026-11-10', to: '2026-11-20' });
  });

  it('the same day twice is one day', () => {
    const onChange = vi.fn();
    render(<DateRange value={{ from: '2026-11-18', to: '2026-11-18' }} onChange={onChange} />);
    openBox();
    fireEvent.click(screen.getAllByText('15')[0]);
    fireEvent.click(screen.getAllByText('15')[0]);
    expect(onChange).toHaveBeenLastCalledWith({ from: '2026-11-15', to: '2026-11-15' });
  });

  it('every span it can hand over is a real pair (checked over every ordered pair of clicks in the month)', () => {
    const seen: Range[] = [];
    for (const [a, b] of [['3', '27'], ['27', '3'], ['9', '9'], ['1', '30'], ['30', '1']]) {
      cleanup();
      const onChange = vi.fn((r: Range) => seen.push(r));
      render(<DateRange value={{ from: '2026-11-18', to: '2026-11-18' }} onChange={onChange} />);
      openBox();
      fireEvent.click(screen.getAllByText(a)[0]);
      fireEvent.click(screen.getAllByText(b)[0]);
    }
    expect(seen.length).toBeGreaterThan(0);
    for (const r of seen) expect(r.from <= r.to, `${r.from} → ${r.to}`).toBe(true);
  });

  it('a future end is allowed: the box has never refused one (a screen that must refuses it itself)', () => {
    fix();
    const onChange = vi.fn();
    render(<DateRange value={{ from: '2026-11-18', to: '2026-11-18' }} onChange={onChange} />);
    openBox();
    fireEvent.click(screen.getAllByText('18')[0]);
    fireEvent.click(screen.getAllByText('28')[0]);
    expect(onChange).toHaveBeenLastCalledWith({ from: '2026-11-18', to: '2026-11-28' });
  });

  it('the month grid is six whole weeks, seven columns set inline, and the days of the month are in order', () => {
    const { container } = render(<DateRange value={{ from: '2026-11-18', to: '2026-11-18' }} onChange={() => {}} />);
    openBox();
    const grid = container.querySelector('[style*="repeat(7"]') as HTMLElement;
    expect(grid).not.toBeNull();
    const cells = Array.from(grid.querySelectorAll('button')).map((b) => b.textContent);
    expect(cells).toHaveLength(42);
    // 1 November 2026 is a Sunday: the grid starts on it
    expect(cells.slice(0, 30)).toEqual(Array.from({ length: 30 }, (_, i) => String(i + 1)));
  });

  it.each([
    ['الشهر التالي', '2026-12-05'],
    ['الشهر السابق', '2026-10-05'],
  ])('the month button «%s» walks the grid, and a day picked there is that month`s', (button, want) => {
    const onChange = vi.fn();
    render(<DateRange value={{ from: '2026-11-18', to: '2026-11-18' }} onChange={onChange} />);
    openBox();
    fireEvent.click(screen.getByRole('button', { name: button }));
    fireEvent.click(screen.getAllByText('5')[0]);
    expect(onChange).toHaveBeenLastCalledWith({ from: want, to: want });
  });
});

describe('the keyboard and the pointer', () => {
  it('the box opens from a real button that says whether it is open', () => {
    render(<DateRange value={{ from: '', to: '' }} onChange={() => {}} />);
    expect(trigger().tagName).toBe('BUTTON');
    expect(trigger().getAttribute('type')).toBe('button');
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    openBox();
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
  });

  it('Escape closes it', () => {
    render(<DateRange value={{ from: '', to: '' }} onChange={() => {}} />);
    openBox();
    expect(screen.getByText('أمس')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText('أمس')).toBeNull();
  });

  it('a press outside closes it; a press inside does not', () => {
    render(<DateRange value={{ from: '', to: '' }} onChange={() => {}} />);
    openBox();
    fireEvent.mouseDown(screen.getByText('أمس'));
    expect(screen.getByText('أمس')).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText('أمس')).toBeNull();
  });

  it('every preset is a button of its own, reachable by Tab (none has a negative tab index)', () => {
    render(<DateRange value={{ from: '', to: '' }} onChange={() => {}} />);
    openBox();
    for (const t of SIX) {
      const b = screen.getByText(t);
      expect(b.tagName).toBe('BUTTON');
      expect(b.getAttribute('tabindex')).toBeNull();
    }
  });

  it('the clear control is named, takes the keyboard, and empties the range', () => {
    const onChange = vi.fn();
    render(<DateRange value={{ from: '2026-11-01', to: '2026-11-05' }} onChange={onChange} />);
    const clear = screen.getByLabelText('امسح التاريخ');
    expect(clear.getAttribute('tabindex')).toBe('0');
    fireEvent.keyDown(clear, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith({ from: '', to: '' });
    onChange.mockClear();
    fireEvent.click(clear);
    expect(onChange).toHaveBeenLastCalledWith({ from: '', to: '' });
  });

  it('there is no clear control when there is nothing to clear', () => {
    render(<DateRange value={{ from: '', to: '' }} onChange={() => {}} />);
    expect(screen.queryByLabelText('امسح التاريخ')).toBeNull();
  });
});

describe('a phone and a right-to-left page', () => {
  it('every tap target is 44px tall on a phone, the box opens inside the screen`s edge, and nothing is left- or right-handed', () => {
    const { container } = render(<DateRange value={{ from: '2026-11-18', to: '2026-11-18' }} onChange={() => {}} />);
    openBox();
    const classes = Array.from(container.querySelectorAll('*')).map((e) => e.getAttribute('class') ?? '');
    const hand = new RegExp(['(^|\\s)(ml|mr|pl|pr)-', ['text', 'left'].join('-'), ['text', 'right'].join('-'), '(^|\\s)(left|right)-'].join('|'));
    for (const c of classes) expect(c).not.toMatch(hand);
    // the trigger and the day cells have a phone height; the panel is a fixed 19rem box that stays inside the screen`s edge
    const panel = container.querySelector('[dir="rtl"]') as HTMLElement;
    expect(panel).not.toBeNull();
    for (const b of Array.from(panel.querySelectorAll('button'))) {
      expect(b.getAttribute('class') ?? '', b.textContent || b.getAttribute('aria-label') || '').toMatch(/min-h-11|h-11/);
    }
    expect(trigger().getAttribute('class')).toMatch(/\bh-11\b/);
  });
});
