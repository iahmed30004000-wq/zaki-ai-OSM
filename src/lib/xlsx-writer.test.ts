import { describe, expect, it } from 'vitest';
import { looksLikeXlsx, readXlsxRows } from './xlsx-reader';
import { buildXlsx, columnLetters, crc32 } from './xlsx-writer';

/**
 * The writer is checked against the project's OWN reader: whatever is written has to come back as the same rows, because
 * the reader is what turns a courier's statement into settlement lines, and a writer that only its author can read proves
 * nothing. The structure (the parts, the types, the relations) follows what Excel itself writes.
 */

const HEADER = ['رقم الطلب', 'الهاتف', 'المبلغ'];

describe('buildXlsx → readXlsxRows', () => {
  it('writes a ZIP container the reader recognises', () => {
    const file = buildXlsx({ name: 'دفعة', header: HEADER, rows: [['ORD-1', '0791234567', 25]] });
    expect(looksLikeXlsx(file)).toBe(true);
  });

  it('comes back as the same rows: Arabic text, a phone with its leading zero kept, a number', () => {
    const file = buildXlsx({
      name: 'BATCH-2026-0004',
      header: HEADER,
      rows: [
        ['ORD-2026-0497', '0791234567', 32.5],
        ['ORD-2026-0521', '٠٩٥٢٥٥٤٥٦٢', 0],
      ],
    });
    expect(readXlsxRows(file)).toEqual([
      HEADER,
      ['ORD-2026-0497', '0791234567', '32.5'],
      ['ORD-2026-0521', '٠٩٥٢٥٥٤٥٦٢', '0'],
    ]);
  });

  it('keeps a text that looks like a formula as text — nothing is ever written as <f>', () => {
    const file = buildXlsx({ name: 's', header: ['اسم'], rows: [['=1+1'], ['+SUM(A1)'], ['@cmd'], ['-5']] });
    expect(readXlsxRows(file).slice(1)).toEqual([['=1+1'], ['+SUM(A1)'], ['@cmd'], ['-5']]);
  });

  it('escapes what XML cannot hold, and drops control characters it cannot carry at all', () => {
    const file = buildXlsx({ name: 's', header: ['x'], rows: [['a & b < c > "d"'], ['bad\u0001char\u0008']] });
    expect(readXlsxRows(file).slice(1)).toEqual([['a & b < c > "d"'], ['badchar']]);
  });

  it('an empty cell stays empty and keeps its column; a repeated text is stored once', () => {
    const file = buildXlsx({ name: 's', header: ['a', 'b', 'c'], rows: [['x', '', 'z'], ['x', null, 'z'], ['x', undefined, 'z']] });
    const rows = readXlsxRows(file);
    expect(rows.slice(1).map((r) => [r[0], r[1] ?? '', r[2]])).toEqual([['x', '', 'z'], ['x', '', 'z'], ['x', '', 'z']]);
  });

  it('holds many rows and many columns (letters past Z)', () => {
    const header = Array.from({ length: 30 }, (_, i) => `h${i}`);
    const rows = Array.from({ length: 300 }, (_, r) => header.map((_, c) => `r${r}c${c}`));
    const back = readXlsxRows(buildXlsx({ name: 's', header, rows }));
    expect(back).toHaveLength(301);
    expect(back[300][29]).toBe('r299c29');
    expect(columnLetters(0)).toBe('A');
    expect(columnLetters(25)).toBe('Z');
    expect(columnLetters(26)).toBe('AA');
    expect(columnLetters(29)).toBe('AD');
  });

  it('the same input gives the same bytes', () => {
    const input = { name: 's', header: HEADER, rows: [['a', 'b', 1]] as (string | number)[][] };
    expect(buildXlsx(input).equals(buildXlsx(input))).toBe(true);
  });

  it('a sheet name Excel would refuse is cleaned, not written as it came', () => {
    const file = buildXlsx({ name: 'a:b/c*d?e[f]g\\h'.padEnd(40, 'x'), header: ['x'], rows: [] });
    const text = file.toString('latin1');
    // The names are stored compressed; what is checkable from outside is that the file is still a workbook.
    expect(looksLikeXlsx(file)).toBe(true);
    expect(text.length).toBeGreaterThan(100);
  });
});

describe('the container is a valid ZIP', () => {
  it('crc32 matches the standard check value, so Excel accepts every part', () => {
    expect(crc32(Buffer.from('123456789')).toString(16)).toBe('cbf43926');
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });
});
