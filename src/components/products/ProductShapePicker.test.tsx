// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PRODUCT_SHAPES, SHAPE_INFO } from '@/lib/product-shapes';

/** «شكل القطعة» ON THE PRODUCT PAGE (27/11): nine real radio buttons, all in view, saved as one is pressed. */

const { apiJson, toast } = vi.hoisted(() => ({ apiJson: vi.fn(), toast: { done: vi.fn(), warn: vi.fn(), failed: vi.fn() } }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => toast }));

import { ProductShapePicker } from './ProductShapePicker';

beforeEach(() => {
  vi.clearAllMocks();
  apiJson.mockImplementation(async (_u: string, init?: RequestInit) => (init ? { shape: 'jar' } : { shape: null }));
});
afterEach(cleanup);

const radio = (name: string) => screen.getByRole('radio', { name }) as HTMLInputElement;

describe('the picker', () => {
  it('draws the nine shapes; a product nobody chose for is «قطعة عامة»', async () => {
    render(<ProductShapePicker productId="p1" canManage />);
    await screen.findAllByRole('radio');
    expect(screen.getAllByRole('radio')).toHaveLength(9);
    for (const s of PRODUCT_SHAPES) expect(radio(SHAPE_INFO[s].ar)).toBeTruthy();
    expect(radio('قطعة عامة').checked).toBe(true);
    expect(apiJson).toHaveBeenCalledWith('/api/products/p1/shape');
  });

  it('pressing one saves it; «قطعة عامة» clears the choice', async () => {
    render(<ProductShapePicker productId="p1" canManage />);
    await screen.findAllByRole('radio');
    fireEvent.click(radio('مرطبان'));
    await waitFor(() => expect(toast.done).toHaveBeenCalled());
    expect(JSON.parse(apiJson.mock.calls.at(-1)![1].body)).toEqual({ shape: 'jar' });
    expect(screen.getByText(/3 مرطبانات/)).toBeTruthy();
    await waitFor(() => expect((radio('قطعة عامة').closest('fieldset') as HTMLFieldSetElement).disabled).toBe(false));
    fireEvent.click(radio('قطعة عامة'));
    await waitFor(() => expect(JSON.parse(apiJson.mock.calls.at(-1)![1].body)).toEqual({ shape: null }));
  });

  it('a refused save puts the old choice back and says why', async () => {
    apiJson.mockImplementation(async (_u: string, init?: RequestInit) => {
      if (init) throw new Error('مش من صلاحيّاتك');
      return { shape: 'shoe' };
    });
    render(<ProductShapePicker productId="p1" canManage />);
    await screen.findAllByRole('radio');
    fireEvent.click(radio('علبة'));
    await waitFor(() => expect(toast.failed).toHaveBeenCalledWith('مش من صلاحيّاتك'));
    expect(radio('حذاء').checked).toBe(true);
  });

  it('NEGATIVE: without the edit key the choices are shown and disabled', async () => {
    render(<ProductShapePicker productId="p1" canManage={false} />);
    await screen.findAllByRole('radio');
    expect((radio('عبوة').closest('fieldset') as HTMLFieldSetElement).disabled).toBe(true);
  });
});
