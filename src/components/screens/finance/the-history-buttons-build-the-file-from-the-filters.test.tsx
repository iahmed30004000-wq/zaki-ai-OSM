// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';

/**
 * «سحب السجل» ON THE SCREEN (22/11, F5) — the strip of filters and the two buttons.
 *
 *  1. «تنزيل Excel» fetches the history door with EVERY filter on the strip (the span, which date, the choices, the screen's own
 *     wallet) and saves the file; a refusal is said in the server's Arabic words and nothing is saved.
 *  2. «PDF» opens the print page in a new tab with the same filters; the help line says it is the browser's «حفظ كـ PDF».
 *  3. Kit parts only, the strip wraps on a phone, and the three screens draw it.
 */

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a), apiJson: vi.fn() }));

import { HistoryExport } from './HistoryExport';
import { HISTORY_PDF_HELP } from '@/lib/history-export-url';

const res = (status: number, json: unknown = {}) =>
  ({ ok: status < 400, status, blob: async () => new Blob(['PK']), json: async () => json, headers: new Headers() }) as unknown as Response;

let saved: string[];
let opened: string[];
beforeEach(() => {
  vi.clearAllMocks();
  saved = [];
  opened = [];
  (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => 'blob:fake';
  (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    saved.push(this.download);
  });
  vi.spyOn(window, 'open').mockImplementation((u?: string | URL) => {
    opened.push(String(u));
    return null;
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const strip = () =>
  render(
    <HistoryExport
      list="movements"
      fixed={{ walletId: 'w-1' }}
      choices={[{ key: 'direction', label: 'الاتجاه', options: [{ value: 'IN', label: 'وارد' }, { value: 'OUT', label: 'صادر' }] }]}
    />
  );

const params = (u: string) => new URL(u, 'http://x').searchParams;

describe('the history strip', () => {
  it('«تنزيل Excel» sends the span, the date it is read on, the choice and the open wallet, then saves the file', async () => {
    apiFetch.mockResolvedValue(res(200));
    strip();
    fireEvent.change(screen.getByLabelText('أي تاريخ'), { target: { value: 'registered' } });
    fireEvent.change(screen.getByLabelText('الاتجاه'), { target: { value: 'OUT' } });
    fireEvent.click(screen.getByRole('button', { name: /تنزيل Excel/ }));

    await waitFor(() => expect(saved).toHaveLength(1));
    const sent = String(apiFetch.mock.calls[0][0]);
    expect(sent.startsWith('/api/finance/history/movements?')).toBe(true);
    const q = params(sent);
    expect(q.get('basis')).toBe('registered');
    expect(q.get('direction')).toBe('OUT');
    expect(q.get('walletId')).toBe('w-1');
    expect(q.get('format')).toBe('xlsx');
    // The strip opens on the last 30 days.
    expect(q.get('from')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(q.get('to')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect((Date.parse(q.get('to')!) - Date.parse(q.get('from')!)) / 86_400_000).toBe(29);
    expect(saved[0]).toMatch(/^movements-.*\.xlsx$/);
  });

  it('NEGATIVE: a refusal is said in the server’s words, and nothing is saved', async () => {
    apiFetch.mockResolvedValue(res(422, { errorAr: 'الفترة فيها أكتر من 5000 سطر — ضيّق التاريخ.' }));
    strip();
    fireEvent.click(screen.getByRole('button', { name: /تنزيل Excel/ }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'الفترة فيها أكتر من 5000 سطر — ضيّق التاريخ.');
    expect(saved).toHaveLength(0);
  });

  it('«PDF» opens the print page with the same filters; the help line names the browser’s «حفظ كـ PDF»', () => {
    strip();
    fireEvent.change(screen.getByLabelText('الاتجاه'), { target: { value: 'IN' } });
    fireEvent.click(screen.getByRole('button', { name: /PDF/ }));
    expect(opened).toHaveLength(1);
    const q = params(opened[0]);
    expect(q.get('format')).toBe('print');
    expect(q.get('direction')).toBe('IN');
    expect(q.get('walletId')).toBe('w-1');
    expect(screen.getByText(HISTORY_PDF_HELP)).toBeTruthy();
    expect(HISTORY_PDF_HELP).toContain('حفظ كـ PDF');
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('wraps on a phone: the row of filters is a wrapping row, nothing forces a width past the screen', () => {
    const { container } = strip();
    const row = container.querySelector('.items-end');
    expect(row?.className.split(' ')).toContain('flex-wrap');
    const all = [...container.querySelectorAll('[class]')].flatMap((el) => el.getAttribute('class')!.split(/\s+/));
    // Built, not written, so the stylesheet scanner does not grow a rule for them (they are what must be absent).
    for (const banned of [['whitespace', 'nowrap'].join('-'), ['min', 'w', 'max'].join('-'), ['overflow', 'x', 'scroll'].join('-')]) {
      expect(all).not.toContain(banned);
    }
  });
});

describe('the three screens draw the strip, with their own list', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), 'src/components/screens/finance', p), 'utf8');
  it.each([
    ['WalletsScreen.tsx', 'list="movements"'],
    ['TransfersScreen.tsx', 'list="transfers"'],
    ['WithdrawalsSection.tsx', 'list="withdrawals"'],
  ])('%s', (file, list) => {
    const src = read(file);
    expect(src).toContain("import { HistoryExport } from './HistoryExport';");
    expect(src).toContain(list);
  });

  it('the strip uses the kit only — no raw button', () => {
    const src = read('HistoryExport.tsx');
    expect(src).not.toMatch(/<button[\s>]/);
    expect(src).toContain("from '@/components/ui/Button'");
  });
});
