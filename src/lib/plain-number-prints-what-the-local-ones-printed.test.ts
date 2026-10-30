import { describe, expect, it } from 'vitest';
import { plainNumber } from './format';

/**
 * ONE `plainNumber`, AND IT PRINTS WHAT THE LOCAL ONES PRINTED.
 *
 * Five local `fmt` helpers and a dozen `toLocaleString('en-US')` calls each wrote
 * the same thing out. They are one function now, and moving them must change no
 * figure on any screen: this holds the new one against the exact expressions it
 * replaced, over numbers that tell them apart (thousands, decimals, negatives,
 * zero, the ends of the range).
 */

const SAMPLES = [
  0, -0, 1, -1, 7, 12, 999, 1000, 1234, 1234.5, 1234.5678, 0.5, 0.005, 0.0049, 1.005, 2.675, 99.995,
  12345678, 123456789.987654, -1234567.891, 1e21, 1e-7, Number.MAX_SAFE_INTEGER, NaN, Infinity, -Infinity,
];

describe('the figure without a currency', () => {
  it('— no second argument prints exactly what `toLocaleString(\'en-US\')` printed (the counts, the totals)', () => {
    for (const n of SAMPLES) expect(plainNumber(n), String(n)).toBe(n.toLocaleString('en-US'));
  });

  it('— two decimals at most is the rate and the average (the campaigns boards, the product headline)', () => {
    for (const n of SAMPLES) {
      expect(plainNumber(n, 2), String(n)).toBe(n.toLocaleString('en-US', { maximumFractionDigits: 2 }));
    }
  });

  it('— none is the whole count (the stores strip)', () => {
    for (const n of SAMPLES) {
      expect(plainNumber(n, 0), String(n)).toBe(n.toLocaleString('en-US', { maximumFractionDigits: 0 }));
    }
  });

  it('— the digits are Latin whatever the machine, and a thousand is separated by a comma', () => {
    expect(plainNumber(1234567)).toBe('1,234,567');
    expect(plainNumber(1234.5678)).toBe('1,234.568');
    expect(plainNumber(1234.5678, 2)).toBe('1,234.57');
    expect(plainNumber(1234.5678, 0)).toBe('1,235');
    expect(/[٠-٩۰-۹]/.test(plainNumber(987654321.123))).toBe(false);
  });

  it('— a number left out of the options stays a default, never a zero (0 decimals is asked for, not assumed)', () => {
    expect(plainNumber(1.5)).toBe('1.5');
    expect(plainNumber(1.5, 0)).toBe('2');
  });
});
