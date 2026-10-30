// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import type { ReviewPreview } from '@/lib/change-request-review';
import { REVIEW_CLOSED_AR, REVIEW_UNAVAILABLE_AR } from '@/lib/change-request-review';

/**
 * THE STATES OF A CHECK THAT ARE NOT «OK» AND NOT «NO»: the answer for an order that has moved, a request that was decided
 * while the screen was open, a budget that said wait, and a card nobody has asked about yet.
 */

const { apiJson } = vi.hoisted(() => ({ apiJson: vi.fn<(url: string) => Promise<unknown>>() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (url: string) => apiJson(url), apiFetch: vi.fn() }));

import { LinesRequestReview, type Verdict } from './LinesRequestReview';

const preview = (cod: number, over: Partial<ReviewPreview> = {}): ReviewPreview => ({
  requestId: 'cr1',
  stale: false,
  lines: [],
  before: { subtotal: 46, discount: 0, deliveryFee: 2.5, addOns: 0, cod: 48.5, giftUnits: 0 },
  after: { subtotal: 70, discount: 0, deliveryFee: 2.5, addOns: 0, cod, giftUnits: 0 },
  stock: [],
  problems: [],
  blocked: false,
  drift: { known: true, moved: false, items: [] },
  door: 'REQUEST',
  orderVersion: 7,
  minorUnit: 3,
  ...over,
});

const refused = (status: number, code: string, message: string) => Object.assign(new Error(message), { status, data: { code } });

beforeEach(() => {
  apiJson.mockReset();
});
afterEach(cleanup);

describe('Ⅰ · the order moved under the screen', () => {
  it('the old verdict is gone the instant the key changes — «loading» until the new answer, never the old one for a moment', async () => {
    const told: Verdict[] = [];
    const onVerdict = (v: Verdict) => told.push(v);
    apiJson.mockResolvedValueOnce(preview(72.5));
    const view = render(<LinesRequestReview requestId="cr1" variant="gate" refreshKey={3} onVerdict={onVerdict} />);
    await screen.findByText('72.500');
    await waitFor(() => expect(told.at(-1)).toMatchObject({ checking: false, shut: null }));

    // The order's version moved; the new answer is slow.
    let answer: (p: ReviewPreview) => void = () => undefined;
    apiJson.mockReturnValueOnce(new Promise((resolve) => { answer = resolve as (p: ReviewPreview) => void; }));
    view.rerender(<LinesRequestReview requestId="cr1" variant="gate" refreshKey={4} onVerdict={onVerdict} />);

    // The old figure is NOT on the screen and the parent has been told «checking» — the button is not open on the old answer.
    expect(screen.queryByText('72.500')).toBeNull();
    expect(screen.getByText(/جارٍ حساب أثر الطلب/)).toBeTruthy();
    await waitFor(() => expect(told.at(-1)).toMatchObject({ checking: true }));

    answer(preview(80));
    await screen.findByText('80.000');
    await waitFor(() => expect(told.at(-1)).toMatchObject({ checking: false, shut: null }));
  });

  it('a key that did not change asks nothing more', async () => {
    apiJson.mockResolvedValue(preview(72.5));
    const view = render(<LinesRequestReview requestId="cr1" variant="gate" refreshKey={3} />);
    await screen.findByText('72.500');
    view.rerender(<LinesRequestReview requestId="cr1" variant="gate" refreshKey={3} />);
    expect(apiJson).toHaveBeenCalledTimes(1);
  });
});

describe('Ⅱ · decided or carried out while the screen was open', () => {
  it('says so — not «تعذّر فحص» — shuts the button, and offers no retry that could not help', async () => {
    apiJson.mockRejectedValue(refused(409, 'NOT_OPEN', 'هذا الطلب انبتّ فيه أو انطبّق — ما في شي ينفحص.'));
    const told: Verdict[] = [];
    render(<LinesRequestReview requestId="cr1" onVerdict={(v) => told.push(v)} />);

    await screen.findByText(REVIEW_CLOSED_AR);
    expect(REVIEW_CLOSED_AR).toBe('انبتّ فيه الآن — حدّث القائمة.');
    expect(document.body.textContent).not.toContain('تعذّر فحص');
    expect(screen.queryByRole('button', { name: 'أعد الفحص' })).toBeNull();
    await waitFor(() => expect(told.at(-1)).toMatchObject({ checking: false, shut: REVIEW_CLOSED_AR, unchecked: false }));
  });

  it('while any other refusal is still «تعذّر فحص», with a retry', async () => {
    apiJson.mockRejectedValue(refused(500, 'X', 'خطأ داخلي'));
    render(<LinesRequestReview requestId="cr1" />);
    await screen.findByText('خطأ داخلي');
    expect(screen.getByText(REVIEW_UNAVAILABLE_AR)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'أعد الفحص' })).toBeTruthy();
  });
});

describe('Ⅲ · the budget says wait', () => {
  it('is «unchecked», not «failed»: no sentence shuts anything, and «افحص» asks again', async () => {
    apiJson.mockRejectedValueOnce(refused(429, 'RATE_LIMITED', 'طلبات كثيرة جداً. أعد المحاولة بعد 30 ثانية'));
    const told: Verdict[] = [];
    render(<LinesRequestReview requestId="cr1" variant="gate" onVerdict={(v) => told.push(v)} />);

    await screen.findByText('الفحص مزدحم الآن — حاول بعد قليل.');
    await waitFor(() => expect(told.at(-1)).toEqual({ checking: false, shut: null, unchecked: true }));

    apiJson.mockResolvedValueOnce(preview(72.5));
    fireEvent.click(screen.getByRole('button', { name: 'افحص' }));
    await screen.findByText('72.500');
    await waitFor(() => expect(told.at(-1)).toMatchObject({ checking: false, shut: null, unchecked: false }));
  });
});

describe('Ⅳ · a card nobody has asked about', () => {
  it('asks nothing until «افحص» is pressed', async () => {
    apiJson.mockResolvedValue(preview(72.5));
    const told: Verdict[] = [];
    render(<LinesRequestReview requestId="cr1" variant="gate" auto={false} onVerdict={(v) => told.push(v)} />);

    await screen.findByText('لم يُفحص هذا الطلب بعد.');
    expect(apiJson).not.toHaveBeenCalled();
    await waitFor(() => expect(told.at(-1)).toMatchObject({ unchecked: true, shut: null }));

    fireEvent.click(screen.getByRole('button', { name: 'افحص' }));
    await screen.findByText('72.500');
    expect(apiJson).toHaveBeenCalledTimes(1);
    expect(apiJson).toHaveBeenCalledWith('/api/control/change-requests/cr1/preview');
  });

  it('and a card that turns out to be among the first is asked without a press', async () => {
    apiJson.mockResolvedValue(preview(72.5));
    const view = render(<LinesRequestReview requestId="cr1" variant="gate" auto={false} />);
    await screen.findByText('لم يُفحص هذا الطلب بعد.');
    view.rerender(<LinesRequestReview requestId="cr1" variant="gate" auto />);
    await screen.findByText('72.500');
  });
});
