// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * THE MONTH GRID ON THE NIGHT THE CLOCK GOES BACK.
 *
 * The grid used to add `i × 24 hours` to the first cell. In a zone with daylight saving, the day the clocks go back is 25 hours long, so
 * the 25th hour landed on the same date again: the grid showed «1» twice and lost the last day of the month. This file runs in such a
 * zone (it is set before anything reads the clock; each test file has its own process).
 */
process.env.TZ = 'America/New_York';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { DateRange } from './DateRange';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const cells = (container: HTMLElement) => {
  const grid = container.querySelector('[style*="repeat(7"]') as HTMLElement;
  return Array.from(grid.querySelectorAll('button')).map((b) => b.textContent);
};

describe('the zone really is one with daylight saving', () => {
  it('the 1st of November 2026 is 25 hours long here', () => {
    const a = new Date(2026, 10, 1).getTime();
    const b = new Date(2026, 10, 2).getTime();
    expect((b - a) / 3_600_000).toBe(25);
  });
});

describe('the grid, night by night', () => {
  it.each([
    // [value, first cell count to check, the days the 42 cells must read]
    ['November 2026 (the clocks go back on the 1st)', '2026-11-18', [...Array.from({ length: 30 }, (_, i) => String(i + 1)), ...Array.from({ length: 12 }, (_, i) => String(i + 1))]],
    // 1 March 2026 is a Sunday; the clocks go forward on the 8th, a 23-hour day
    ['March 2026 (the clocks go forward on the 8th)', '2026-03-18', [...Array.from({ length: 31 }, (_, i) => String(i + 1)), ...Array.from({ length: 11 }, (_, i) => String(i + 1))]],
  ])('%s: forty-two cells, every date once and in order', (_why, from, want) => {
    const { container } = render(<DateRange value={{ from, to: from }} onChange={() => {}} />);
    fireEvent.click(screen.getAllByRole('button')[0]);
    expect(cells(container)).toEqual(want);
  });

  it('a day picked after the change is that day', () => {
    const onChange = vi.fn();
    render(<DateRange value={{ from: '2026-11-18', to: '2026-11-18' }} onChange={onChange} />);
    fireEvent.click(screen.getAllByRole('button')[0]);
    fireEvent.click(screen.getAllByText('2')[0]); // the 2nd, the day after the 25-hour one
    fireEvent.click(screen.getAllByText('2')[0]);
    expect(onChange).toHaveBeenLastCalledWith({ from: '2026-11-02', to: '2026-11-02' });
  });

  it('the presets are calendar days, so «آخر 7 أيام» across the change is still seven dates', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 3, 12, 0, 0));
    const onChange = vi.fn();
    render(<DateRange value={{ from: '', to: '' }} onChange={onChange} />);
    fireEvent.click(screen.getAllByRole('button')[0]);
    fireEvent.click(screen.getByText('آخر 7 أيام'));
    expect(onChange).toHaveBeenLastCalledWith({ from: '2026-10-28', to: '2026-11-03' });
  });

  it('yesterday on the morning after the 25-hour day is the 1st', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 2, 0, 30, 0));
    const onChange = vi.fn();
    render(<DateRange value={{ from: '', to: '' }} onChange={onChange} />);
    fireEvent.click(screen.getAllByRole('button')[0]);
    fireEvent.click(screen.getByText('أمس'));
    expect(onChange).toHaveBeenLastCalledWith({ from: '2026-11-01', to: '2026-11-01' });
  });
});
