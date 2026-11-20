// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import React from 'react';
import { NO_WAREHOUSE_AR, TransferLink, WarehousePicker, firstChoice, useOpsWarehouse } from './WarehousePicker';

/**
 * «من أي مخزن؟» (the warehouse plan, W4c) — the picker the three shipping screens share, and its memory.
 *
 * The memory is a convenience of this device, never the truth: it only ever chooses among what the server just offered,
 * and storage that throws changes nothing but the convenience.
 */

const A = { id: 'wa', name: 'مخزن الشمال' };
const B = { id: 'wb', name: 'مخزن الجنوب' };

beforeEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    /* jsdom */
  }
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('firstChoice — where a list starts', () => {
  it('a store that is not placed (no list) and a list of none: nothing chosen', () => {
    expect(firstChoice(null, 'wa')).toBe('');
    expect(firstChoice([], 'wa')).toBe('');
  });
  it('one warehouse: it, whatever was remembered', () => {
    expect(firstChoice([A], null)).toBe('wa');
    expect(firstChoice([A], 'wb')).toBe('wa');
  });
  it('several: the remembered one if it is still offered, else none', () => {
    expect(firstChoice([A, B], 'wb')).toBe('wb');
    expect(firstChoice([A, B], 'gone')).toBe('');
    expect(firstChoice([A, B], null)).toBe('');
  });
});

describe('useOpsWarehouse — the memory, per person', () => {
  it('a pick is remembered for THIS person and chosen again on the next visit', () => {
    const first = renderHook(() => useOpsWarehouse('u1'));
    act(() => first.result.current.heard([A, B]));
    expect(first.result.current.place).toBe('');
    act(() => first.result.current.choose('wb'));
    expect(first.result.current.place).toBe('wb');

    const again = renderHook(() => useOpsWarehouse('u1'));
    act(() => again.result.current.heard([A, B]));
    expect(again.result.current.place).toBe('wb');

    // Another person on the same device does not inherit it.
    const other = renderHook(() => useOpsWarehouse('u2'));
    act(() => other.result.current.heard([A, B]));
    expect(other.result.current.place).toBe('');
  });

  it('NEGATIVE: a remembered warehouse the server no longer offers is not chosen', () => {
    window.localStorage.setItem('ops-warehouse:u1', 'stopped-one');
    const h = renderHook(() => useOpsWarehouse('u1'));
    act(() => h.result.current.heard([A, B]));
    expect(h.result.current.place).toBe('');
  });

  it('a list without the field (a store that is not placed) clears everything', () => {
    const h = renderHook(() => useOpsWarehouse('u1'));
    act(() => h.result.current.heard([A]));
    expect(h.result.current.place).toBe('wa');
    act(() => h.result.current.heard(undefined));
    expect(h.result.current.warehouses).toBeNull();
    expect(h.result.current.place).toBe('');
  });

  it('a choice still offered survives a refresh of the list', () => {
    const h = renderHook(() => useOpsWarehouse('u1'));
    act(() => h.result.current.heard([A, B]));
    act(() => h.result.current.choose('wa'));
    act(() => h.result.current.heard([A, B]));
    expect(h.result.current.place).toBe('wa');
    // …and one taken away is dropped.
    act(() => h.result.current.heard([B]));
    expect(h.result.current.place).toBe('wb');
  });

  it('storage that throws: the pick still holds for this visit, nothing breaks', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const h = renderHook(() => useOpsWarehouse('u1'));
    act(() => h.result.current.heard([A, B]));
    expect(h.result.current.place).toBe('');
    act(() => h.result.current.choose('wa'));
    expect(h.result.current.place).toBe('wa');
  });

  it('choosing none forgets the memory', () => {
    const h = renderHook(() => useOpsWarehouse('u1'));
    act(() => h.result.current.heard([A, B]));
    act(() => h.result.current.choose('wa'));
    act(() => h.result.current.choose(''));
    expect(window.localStorage.getItem('ops-warehouse:u1')).toBeNull();
  });
});

describe('WarehousePicker — what it draws', () => {
  it('several warehouses: a labelled select with the empty option first', () => {
    const onChange = vi.fn();
    render(<WarehousePicker warehouses={[A, B]} value="" onChange={onChange} label="المخزن" noneLabel="اختار المخزن" />);
    const select = screen.getByLabelText('المخزن') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['اختار المخزن', A.name, B.name]);
    fireEvent.change(select, { target: { value: 'wb' } });
    expect(onChange).toHaveBeenCalledWith('wb');
  });

  it('one warehouse: no empty option — it is the choice', () => {
    render(<WarehousePicker warehouses={[A]} value="wa" onChange={vi.fn()} label="المخزن" noneLabel="اختار المخزن" />);
    const select = screen.getByLabelText('المخزن') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual([A.name]);
    expect(select.value).toBe('wa');
  });

  it('none reached: the sentence, and nothing to pick', () => {
    render(<WarehousePicker warehouses={[]} value="" onChange={vi.fn()} label="المخزن" noneLabel="اختار المخزن" />);
    expect(screen.getByText(NO_WAREHOUSE_AR)).toBeTruthy();
    expect(document.querySelector('select')).toBeNull();
  });

  it('a phone: the select takes the row (full width, no fixed width that could push the page sideways)', () => {
    render(<WarehousePicker warehouses={[A, B]} value="" onChange={vi.fn()} label="المخزن" noneLabel="اختار المخزن" />);
    const select = document.querySelector('select') as HTMLSelectElement;
    expect(select.className).toContain('w-full');
    expect(select.className).toContain('min-w-0');
    // No arbitrary pixel width anywhere in the drawing (the bracket form is the only way to write one).
    expect(document.body.innerHTML).not.toContain('px]');
  });

  it('the way on from a shortage is a link to a new transfer', () => {
    render(<TransferLink />);
    expect(screen.getByRole('link').getAttribute('href')).toBe('/inventory/transfers');
  });
});
