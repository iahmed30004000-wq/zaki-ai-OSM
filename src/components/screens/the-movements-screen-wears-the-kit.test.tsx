// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { repoFile, stripComments } from '@/lib/guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «حركات المخزون» WEARS THE KIT — AND READS THE SAME LEDGER (18/11, R12e).
 *
 * The frame is `PageShell`, the search box sits in a `Card`, the log in a `Card plain`, the search press is the kit's `Button`.
 * A movement is never edited, so the only request this screen sends is the read: this file pins that the read asks the same
 * address for the same search, that every column and every figure (quantity, balance after it) prints as it did, and that
 * nothing on it can make a 375px phone scroll sideways. Every expectation was run against the screen before the change (green)
 * and after it (green).
 * ═══════════════════════════════════════════════════════════════════════
 */

const { apiJson } = vi.hoisted(() => ({ apiJson: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson }));

import { InventoryMovementsScreen } from './InventoryMovementsScreen';

const MOVES = [
  {
    id: 'm1', type: 'PRODUCTION', quantity: 40, balanceAfter: 140, reason: 'دفعة جديدة', createdAt: '2026-11-01T09:00:00.000Z',
    product: { id: 'p1', name: 'كريم تجربة', sku: 'SKU-T1' }, batchNumber: 'B-7', createdByName: 'موظف تجربة',
  },
  {
    id: 'm2', type: 'SALE', quantity: -3, balanceAfter: 137, reason: null, createdAt: '2026-11-02T09:00:00.000Z',
    product: null, batchNumber: null, createdByName: null,
  },
];

let asked: string[];
beforeEach(() => {
  asked = [];
  apiJson.mockImplementation(async (url: string) => {
    asked.push(url);
    return { movements: MOVES, types: [{ type: 'PRODUCTION', count: 1 }, { type: 'SALE', count: 1 }], hasMore: true };
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const mount = async () => {
  render(<InventoryMovementsScreen />);
  await screen.findAllByText('كريم تجربة');
};

describe('the ledger reads and prints as before', () => {
  it('one h1, the menu’s name', async () => {
    await mount();
    const h1 = document.querySelectorAll('h1');
    expect(h1).toHaveLength(1);
    expect(h1[0].textContent).toBe('حركات المخزون');
  });

  it('the first read asks the bare address', async () => {
    await mount();
    expect(asked[0]).toBe('/api/inventory/movements?');
  });

  it('the search press asks the same address with the same search', async () => {
    await mount();
    fireEvent.change(screen.getByPlaceholderText('اسم المنتج، الرمز، رقم الدفعة أو السبب'), { target: { value: ' كريم ' } });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'SALE' } });
    const before = asked.length;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'بحث' }));
    });
    await waitFor(() => expect(asked.length).toBeGreaterThan(before));
    expect(asked[asked.length - 1]).toBe('/api/inventory/movements?q=%D9%83%D8%B1%D9%8A%D9%85&type=SALE');
  });

  it('the search press is a submit: one search box, one kind box, one press', async () => {
    await mount();
    const press = screen.getByRole('button', { name: 'بحث' }) as HTMLButtonElement;
    expect(press.type).toBe('submit');
    expect(press.closest('form')).toBeTruthy();
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    expect(screen.getAllByRole('combobox')).toHaveLength(1);
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['الكل', 'إدخال / إنتاج (1)', 'بيع (1)']);
  });

  it('every column, every figure', async () => {
    await mount();
    const text = document.body.textContent ?? '';
    for (const label of ['التاريخ', 'المنتج', 'النوع', 'الكمية', 'الرصيد بعدها', 'الدفعة', 'السبب', 'سجّلها']) {
      expect(screen.getAllByText(label).length, label).toBeGreaterThan(0);
    }
    for (const figure of ['140', '137', 'SKU-T1', 'B-7', 'دفعة جديدة', 'موظف تجربة', 'إدخال / إنتاج', 'بيع']) {
      expect(text, figure).toContain(figure);
    }
    // the quantity is printed without its sign, beside an arrow
    expect(screen.getAllByText('40').length).toBeGreaterThan(0);
    expect(screen.getAllByText('3').length).toBeGreaterThan(0);
    expect(text).not.toContain('-3');
    expect(text).toContain('تُعرض أحدث الحركات — ضيّق البحث لرؤية أقدم منها.');
  });
});

describe('375 px: nothing scrolls sideways', () => {
  it('no fixed width wider than a phone less its gutters, no nowrap row, no sideways scroll', () => {
    const code = stripComments(repoFile('src/components/screens/InventoryMovementsScreen.tsx'));
    for (const bad of [/\bw-screen\b/, /\boverflow-x-/, /\bwhitespace-nowrap\b/, /\bflex-nowrap\b/, /\bw-\d{3,}\b/]) {
      expect(code, String(bad)).not.toMatch(bad);
    }
    for (const m of code.matchAll(/\b(?:min-)?w-\[(\d+)px\]/g)) expect(Number(m[1]), m[0]).toBeLessThanOrEqual(343);
  });
});
