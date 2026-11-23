// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * «أسعار الصرف» — THE SETTINGS CARD (23/11, F8).
 *
 * One row per currency the company uses: today's rate as «1 دولار = …», «تلقائي» + its source or «يدوي», its date; the Syrian pound's
 * box is «سعر الليرة السورية بالدولار» and the row says «اكتب السعر» until it is typed; a rate older than three days says so; «حفظ»
 * sends only what changed, and an emptied box sends null (back to automatic). Nobody without `finance.partners` is drawn it.
 */

const { api, can, toast } = vi.hoisted(() => ({ api: vi.fn(), can: { value: true }, toast: { done: vi.fn(), warn: vi.fn(), failed: vi.fn() } }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => toast }));
vi.mock('@/hooks/useCan', () => ({ useCan: (key: string) => can.value && key === 'finance.partners' }));

import { ExchangeRatesCard } from './ExchangeRatesCard';

const FRESH = '2026-11-23T00:00:00.000Z';
const OLD = '2026-11-15T00:00:00.000Z';
const STALE = 'السعر أقدم من 3 أيام — ما قدرنا نجيب سعر جديد من الإنترنت';
const ANSWER = {
  attemptedAt: FRESH,
  failed: {},
  staleSentence: STALE,
  rows: [
    { code: 'JOD', label: 'دينار أردني (JOD)', effective: { code: 'JOD', perUsd: 0.709, kind: 'AUTO', source: 'open.er-api.com', asOf: OLD, stale: true }, auto: null, manual: null, ownerOnly: false, missingSentence: null },
    { code: 'SYP', label: 'ليرة سورية (SYP)', effective: null, auto: null, manual: null, ownerOnly: true, missingSentence: 'ما في سعر — اكتب سعر الليرة بالإعدادات' },
    { code: 'USD', label: 'دولار أمريكي (USD)', effective: { code: 'USD', perUsd: 1, kind: 'FIXED', source: null, asOf: null, stale: false }, auto: null, manual: null, ownerOnly: false, missingSentence: null },
    { code: 'USDT', label: 'USDT', effective: { code: 'USDT', perUsd: 1.5, kind: 'MANUAL', source: null, asOf: FRESH, stale: false }, auto: { code: 'USDT', perUsd: 1.0012, kind: 'AUTO', source: 'api.kraken.com', asOf: FRESH, stale: false }, manual: { perUsd: 1.5, at: FRESH }, ownerOnly: false, missingSentence: null },
  ],
};

const row = (code: string) => document.querySelector(`[data-code="${code}"]`) as HTMLElement;
const puts = () => api.mock.calls.filter((c) => (c[1] as { method?: string } | undefined)?.method === 'PUT');
const open = async () => {
  render(<ExchangeRatesCard />);
  await screen.findByText('أسعار الصرف');
  await waitFor(() => expect(row('SYP')).toBeTruthy());
};

beforeEach(() => {
  api.mockReset();
  can.value = true;
  api.mockResolvedValue(ANSWER);
});
afterEach(() => cleanup());

describe('what each row says', () => {
  it('JOD: the rate, «تلقائي», its source, its date — and the three-days sentence when it is old', async () => {
    await open();
    expect(row('JOD').textContent).toContain('1 دولار = 0.709 JOD · تلقائي · open.er-api.com · 2026/11/15');
    expect(row('JOD').textContent).toContain(STALE);
  });

  it('SYP: «اكتب السعر», a box named «سعر الليرة السورية بالدولار», and no automatic figure', async () => {
    await open();
    expect(row('SYP').textContent).toContain('اكتب السعر');
    expect(screen.getByLabelText('سعر الليرة السورية بالدولار')).toBeTruthy();
    expect(row('SYP').textContent).not.toContain('تلقائي');
  });

  it('USD: «ثابت — 1» and no box to type in', async () => {
    await open();
    expect(row('USD').textContent).toContain('ثابت — 1');
    expect(row('USD').querySelector('input')).toBeNull();
  });

  it('a typed rate says «يدوي», keeps its value in the box, and shows the automatic one beside it', async () => {
    await open();
    expect(row('USDT').textContent).toContain('· يدوي');
    expect((row('USDT').querySelector('input') as HTMLInputElement).value).toBe('1.5');
    expect(row('USDT').textContent).toContain('التلقائي: 1 دولار = 1.0012 USDT — سعرك بيغلب');
  });
});

describe('saving', () => {
  it('«حفظ» is closed until something changed; then it sends ONLY what changed — the SYP rate, and an emptied USDT box as null', async () => {
    await open();
    const save = screen.getByRole('button', { name: 'حفظ' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('سعر الليرة السورية بالدولار'), { target: { value: '13000' } });
    fireEvent.change(row('USDT').querySelector('input')!, { target: { value: '' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(puts()).toHaveLength(1));
    const [url, init] = puts()[0] as [string, { body: string }];
    expect(url).toBe('/api/finance/exchange-rates');
    expect(JSON.parse(init.body)).toEqual({ rates: [{ code: 'SYP', perUsd: '13000' }, { code: 'USDT', perUsd: null }] });
    await waitFor(() => expect(toast.done).toHaveBeenCalledWith('انحفظت أسعار الصرف'));
  });

  it('NEGATIVE: the door’s refusal is printed, the boxes stay as typed', async () => {
    await open();
    api.mockRejectedValueOnce(new Error('السعر أكبر من صفر'));
    fireEvent.change(screen.getByLabelText('سعر الليرة السورية بالدولار'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    await screen.findByText('السعر أكبر من صفر');
    expect((screen.getByLabelText('سعر الليرة السورية بالدولار') as HTMLInputElement).value).toBe('0');
  });
});

describe('who sees it, and how it is built', () => {
  it('NEGATIVE: without «الشركاء والسحوبات» the card is not drawn and nothing is asked', () => {
    can.value = false;
    const { container } = render(<ExchangeRatesCard />);
    expect(container.textContent).toBe('');
    expect(api).not.toHaveBeenCalled();
  });

  it('the kit’s card, button and boxes; no raw button; nothing wider than a phone', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/settings/ExchangeRatesCard.tsx'), 'utf8');
    expect(src).toContain("from '@/components/ui/Card'");
    expect(src).toContain("from '@/components/ui/Button'");
    expect(src).toContain("from '@/components/ui/Input'");
    expect(src).not.toMatch(/<button\b/);
    for (const bad of [/\bw-screen\b/, /\boverflow-x-/, /\bwhitespace-nowrap\b/, /\bflex-nowrap\b/]) expect(src, String(bad)).not.toMatch(bad);
  });
});
