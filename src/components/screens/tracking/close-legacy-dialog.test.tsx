// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * «أقفل القديمة بلا باركود» — THE DIALOG SHOWS THE NUMBER BEFORE IT ASKS (12/11).
 *
 *   «كل الطلبات الي بانتظار التحصيل وما الها بار كود سويها تم تحصيلها بدون ما تأثر على المالية» (the owner)
 *
 * It measures first and only draws; the door is the one that decides (`close-legacy.test.ts`). What is held to here: the numbers
 * are on the screen before the press can be made, the press needs the tick and sends back exactly what was shown, a new cut is a
 * new question (the tick is taken back), a refusal is said and the numbers are read again, and a press goes once.
 */

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));

import { CloseLegacyDialog } from './CloseLegacyDialog';
import type { LegacyMeasure } from '@/lib/legacy-closeout-words';

const measureOf = (over: Partial<LegacyMeasure> = {}): LegacyMeasure => ({
  age: 14,
  cutoff: '2026-10-29T00:00:00.000Z',
  tooMany: false,
  closeable: {
    count: 820,
    fingerprint: 'a'.repeat(24),
    oldestAt: '2026-10-01T10:00:00.000Z',
    newestAt: '2026-10-25T10:00:00.000Z',
    byCourier: [
      { name: 'الباشا', count: 700 },
      { name: 'الو دليفيري', count: 120 },
    ],
    value: [{ currency: 'USD', amount: 18250.5 }],
  },
  options: [
    { age: 1, count: 900 },
    { age: 3, count: 880 },
    { age: 7, count: 850 },
    { age: 14, count: 820 },
    { age: 30, count: 600 },
  ],
  left: { tooRecent: 80, moneyRecorded: 3, onAStatement: 2 },
  ...over,
});

const posts = () => api.mock.calls.filter((c) => (c[1] as { method?: string } | undefined)?.method === 'POST');
const gets = () => api.mock.calls.filter((c) => !(c[1] as { method?: string } | undefined)?.method);

let onClose: () => void;
let onDone: (message: string) => void;

beforeEach(() => {
  vi.clearAllMocks();
  onClose = vi.fn();
  onDone = vi.fn();
  api.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (init?.method === 'POST') return { closed: 820, message: 'اتقفل 820 طلب كمحصَّل — بلا أي حركة مصاري' };
    const age = Number(new URL(url, 'http://x').searchParams.get('age'));
    return measureOf({ age: age as LegacyMeasure['age'] });
  });
});
afterEach(() => cleanup());

const open = async () => {
  render(<CloseLegacyDialog onClose={onClose} onDone={onDone} />);
  await screen.findByText('طلب رح ينقفل كمحصَّل');
};
const tick = () => fireEvent.click(screen.getByRole('checkbox'));
const pressButton = () => screen.getByRole('button', { name: /^أقفل \d+ طلب$/ }) as HTMLButtonElement;

describe('the numbers come before the press', () => {
  it('measures at the default cut (14 days) the moment it opens, and says how many, whose, what they are worth and what is left', async () => {
    await open();

    expect(gets().map((c) => c[0])).toEqual(['/api/ops/tracking/close-legacy?age=14']);
    expect(screen.getByText('820')).toBeTruthy();
    expect(screen.getByText('الباشا')).toBeTruthy();
    expect(screen.getByText('700')).toBeTruthy();
    expect(screen.getByText('الو دليفيري')).toBeTruthy();
    // What it is worth is said as the orders' value, never as money that moves.
    expect(screen.getByText(/قيمة الطلبات، مش مصاري رح تنزل/)).toBeTruthy();
    expect(screen.getByText(/18,250/)).toBeTruthy();
    // And what it leaves, with the reason of each.
    expect(screen.getByText('اللي ما رح ينقفل:')).toBeTruthy();
    expect(screen.getByText(/أحدث من العمر المختار/)).toBeTruthy();
    expect(screen.getByText(/تسويتها بحالة تانية/)).toBeTruthy();
    expect(screen.getByText(/ذكرها كشف/)).toBeTruthy();
  });

  it('says in plain words that NO money moves and the commission does not become payable', async () => {
    await open();
    expect(screen.getByText(/ما بينزل ولا قرش بأي محفظة، وعمولتها ما بتصير قابلة للدفع/)).toBeTruthy();
  });

  it('every cut shows how many it would close, the chosen one first', async () => {
    await open();
    const select = screen.getByLabelText('اقفل اللي أقدم من') as HTMLSelectElement;
    expect(select.value).toBe('14');
    expect([...select.options].map((o) => o.textContent)).toEqual([
      'أقدم من يوم — 900 طلب',
      'أقدم من 3 أيام — 880 طلب',
      'أقدم من أسبوع — 850 طلب',
      'أقدم من أسبوعين — 820 طلب',
      'أقدم من شهر — 600 طلب',
    ]);
  });

  it('asks for NO amount and NO wallet: one list (the cut) and one tick, nothing to type', async () => {
    await open();
    expect(document.querySelectorAll('select')).toHaveLength(1);
    expect([...document.querySelectorAll('input')].map((i) => i.type)).toEqual(['checkbox']);
  });
});

describe('the press', () => {
  it('is shut until the tick is given — and says how many it closes', async () => {
    await open();
    expect(pressButton().disabled).toBe(true);
    tick();
    expect(pressButton().disabled).toBe(false);
    expect(pressButton().textContent).toBe('أقفل 820 طلب');
  });

  it('sends back EXACTLY what was shown — the cut, the fingerprint, the count and the tick — and tells the screen what the door said', async () => {
    await open();
    tick();
    fireEvent.click(pressButton());

    await waitFor(() => expect(onDone).toHaveBeenCalledWith('اتقفل 820 طلب كمحصَّل — بلا أي حركة مصاري'));
    expect(posts()).toHaveLength(1);
    expect(posts()[0][0]).toBe('/api/ops/tracking/close-legacy');
    expect(JSON.parse((posts()[0][1] as { body: string }).body)).toEqual({
      age: 14,
      fingerprint: 'a'.repeat(24),
      count: 820,
      acknowledged: true,
    });
  });

  it('goes ONCE: two quick presses send one request', async () => {
    await open();
    tick();
    const btn = pressButton();
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(posts()).toHaveLength(1);
  });

  it('a new cut is a new question: it asks again with that age, and the tick is taken back', async () => {
    await open();
    tick();
    expect(pressButton().disabled).toBe(false);

    fireEvent.change(screen.getByLabelText('اقفل اللي أقدم من'), { target: { value: '7' } });
    await waitFor(() => expect(gets().map((c) => c[0])).toContain('/api/ops/tracking/close-legacy?age=7'));
    await screen.findByText('طلب رح ينقفل كمحصَّل');
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    expect(pressButton().disabled).toBe(true);
  });

  it('a tick given to an earlier look is not given to this one — even when the cut comes back to the same age', async () => {
    await open();
    tick();
    const select = screen.getByLabelText('اقفل اللي أقدم من');

    fireEvent.change(select, { target: { value: '7' } });
    await waitFor(() => expect(gets().map((c) => c[0])).toContain('/api/ops/tracking/close-legacy?age=7'));
    await screen.findByText('طلب رح ينقفل كمحصَّل');
    fireEvent.change(select, { target: { value: '14' } });
    await waitFor(() => expect(gets()).toHaveLength(3));
    await screen.findByText('طلب رح ينقفل كمحصَّل');

    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    expect(pressButton().disabled).toBe(true);
  });

  it('a late answer to an old question is never drawn: the numbers on the screen are the ones for the cut on the screen', async () => {
    let releaseOld: (m: LegacyMeasure) => void = () => undefined;
    api.mockImplementation((url: string) => {
      const age = Number(new URL(url, 'http://x').searchParams.get('age'));
      if (age === 14) return new Promise<LegacyMeasure>((resolve) => (releaseOld = resolve));
      return Promise.resolve(measureOf({ age: age as LegacyMeasure['age'], closeable: { ...measureOf().closeable, count: 111 } }));
    });
    render(<CloseLegacyDialog onClose={onClose} onDone={onDone} />);
    // The first question (14 days) is still in the air; the owner moves to 7 days and that answer lands first.
    await waitFor(() => expect(gets()).toHaveLength(1));
    fireEvent.change(screen.getByLabelText('اقفل اللي أقدم من'), { target: { value: '7' } });
    expect(await screen.findByText('111')).toBeTruthy();

    // Now the OLD answer (820 for 14 days) arrives — it must not replace the 7-day numbers.
    releaseOld(measureOf());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByText('111')).toBeTruthy();
    expect(screen.queryByText('820')).toBeNull();
  });

  it('a refusal is said, the numbers are read again, and the tick is taken back — nothing is closed on the screen’s say-so', async () => {
    api.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (init?.method === 'POST') {
        throw Object.assign(new Error('تغيّرت الأرقام من لما فتحت النافذة — افتحها من جديد وراجعها قبل ما تقفل.'), { status: 409 });
      }
      return measureOf({ age: Number(new URL(url, 'http://x').searchParams.get('age')) as LegacyMeasure['age'] });
    });
    await open();
    tick();
    fireEvent.click(pressButton());

    expect((await screen.findByRole('alert')).textContent).toContain('تغيّرت الأرقام');
    await waitFor(() => expect(gets()).toHaveLength(2));
    await waitFor(() => expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false));
    expect(pressButton().disabled).toBe(true);
    expect(onDone).not.toHaveBeenCalled();
    // The refusal is still on the screen after the re-read: that is exactly when it is read.
    expect(screen.getByRole('alert').textContent).toContain('تغيّرت الأرقام');
  });

  it('cancel closes without a request', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'إلغاء' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(posts()).toHaveLength(0);
  });
});

describe('when there is nothing to close, or too much', () => {
  it('nothing old enough: says so, and there is no tick and no press', async () => {
    api.mockImplementation(async () => measureOf({ closeable: { ...measureOf().closeable, count: 0, byCourier: [], value: [], oldestAt: null, newestAt: null }, left: { tooRecent: 5, moneyRecorded: 0, onAStatement: 0 } }));
    render(<CloseLegacyDialog onClose={onClose} onDone={onDone} />);
    expect(await screen.findByText('ما في طلب قديم بلا باركود بهالعمر ينقفل.')).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect((screen.getByRole('button', { name: 'أقفل' }) as HTMLButtonElement).disabled).toBe(true);
    // And still says what it left, so the owner sees why.
    expect(screen.getByText(/أحدث من العمر المختار/)).toBeTruthy();
  });

  it('more than a press may hold: says so, and the press stays shut', async () => {
    api.mockImplementation(async () => measureOf({ tooMany: true, closeable: { ...measureOf().closeable, count: 0, byCourier: [], value: [] } }));
    render(<CloseLegacyDialog onClose={onClose} onDone={onDone} />);
    expect(await screen.findByText(/أكثر من 20000 طلب/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'أقفل' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('the measure fails: the door’s sentence is shown, and the press stays shut', async () => {
    api.mockRejectedValue(Object.assign(new Error('قفل الطلبات القديمة بلا باركود مش من صلاحياتك — اطلبها من المالك.'), { status: 403 }));
    render(<CloseLegacyDialog onClose={onClose} onDone={onDone} />);
    expect(await screen.findByText(/مش من صلاحياتك/)).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect((screen.getByRole('button', { name: 'أقفل' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the first six companies and folds the rest into one line', async () => {
    const counts = [100, 91, 82, 73, 64, 55, 46, 37, 28];
    const many = counts.map((count, i) => ({ name: `شركة ${i + 1}`, count }));
    api.mockImplementation(async () => measureOf({ closeable: { ...measureOf().closeable, byCourier: many } }));
    render(<CloseLegacyDialog onClose={onClose} onDone={onDone} />);
    await screen.findByText('طلب رح ينقفل كمحصَّل');
    expect(screen.getByText('شركة 6')).toBeTruthy();
    expect(screen.queryByText('شركة 7')).toBeNull();
    expect(screen.getByText('شركات تانية')).toBeTruthy();
    // The companies 7..9 are folded into one line: 46 + 37 + 28.
    expect(screen.getByText('111')).toBeTruthy();
  });
});
