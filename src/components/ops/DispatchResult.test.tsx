// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import type { DispatchOutcome, DispatchSummary } from '@/lib/couriers/dispatch';
import { DispatchResult } from './DispatchResult';

/**
 * WHAT CAME BACK FROM SENDING A BATCH — grouped by reason, and closed until asked.
 *
 * BATCH-2026-0003 answered «فشل 35» with thirty-five lines that filled the page. This renders the real component the
 * two screens share and reads what a person reads: one line per reason with its count, the larger group first, the
 * order numbers behind a button that is closed on arrival.
 */

const REFUSAL = 'الباشا رفض: رقم تعريف الشركة غير صحيح (400)';
const NO_CODE = 'السويداء: لا رمز لها عند الشركة بعد';

const refused = (n: number): DispatchOutcome => ({
  orderId: `o${n}`, orderNumber: `ORD-2026-${String(n).padStart(4, '0')}`, ok: false, error: REFUSAL,
});
const summaryOf = (outcomes: DispatchOutcome[]): DispatchSummary => ({
  sent: outcomes.filter((o) => o.ok).length,
  skipped: outcomes.filter((o) => o.skipped).length,
  failed: outcomes.filter((o) => !o.ok && !o.skipped).length,
  outcomes,
});

// The no-code order comes FIRST in the data: the larger group must still come first on the screen.
const batch: DispatchOutcome[] = [
  { orderId: 'sw', orderNumber: 'ORD-2026-0508', ok: false, skipped: 'NO_COURIER_CITY', regionName: 'السويداء' },
  ...Array.from({ length: 35 }, (_, i) => refused(i + 1)),
  { orderId: 'ok1', orderNumber: 'ORD-2026-0900', ok: true, trackingNumber: 'KSA1' },
];

afterEach(cleanup);

describe('the dispatch result', () => {
  it('keeps the summary line, and says each reason once with its count — the larger group first', () => {
    render(<DispatchResult summary={summaryOf(batch)} savedNote="الباركودات محفوظة" />);
    expect(screen.getByText('رُحّل 1 · تُخطّي 1 · فشل 35')).toBeTruthy();

    const lines = screen.getAllByText(/ طلب — /).map((p) => p.textContent ?? '');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(`35 طلب — ${REFUSAL}`);
    expect(lines[1]).toContain(`1 طلب — ${NO_CODE}`);
    // One line, not thirty-five.
    expect(document.body.textContent!.split(REFUSAL).length - 1).toBe(1);
    expect(screen.getByText('الباركودات محفوظة')).toBeTruthy();
  });

  it('is CLOSED on arrival: no order number is on the page, and the button says how many it holds', () => {
    render(<DispatchResult summary={summaryOf(batch)} savedNote="x" />);
    const toggle = screen.getByRole('button', { name: 'اعرض الطلبات (35)' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('ORD-2026-0004')).toBeNull();
    expect(screen.queryByText('ORD-2026-0508')).toBeNull();
  });

  it('the button opens the order numbers and closes them again, and tells assistive tech which', () => {
    render(<DispatchResult summary={summaryOf(batch)} savedNote="x" />);
    fireEvent.click(screen.getByRole('button', { name: 'اعرض الطلبات (35)' }));

    const hide = screen.getByRole('button', { name: 'خبّي الطلبات' });
    expect(hide.getAttribute('aria-expanded')).toBe('true');
    const list = document.getElementById(hide.getAttribute('aria-controls')!)!;
    expect(within(list).getAllByText(/^ORD-2026-/)).toHaveLength(35);
    // An order number is a number: written left to right inside a right-to-left line.
    expect(within(list).getByText('ORD-2026-0004').getAttribute('dir')).toBe('ltr');

    fireEvent.click(hide);
    expect(screen.queryByText('ORD-2026-0004')).toBeNull();
    // The other group stayed closed throughout: each group has its own button.
    expect(screen.getByRole('button', { name: 'اعرض الطلبات (35)' }).getAttribute('aria-expanded')).toBe('false');
  });

  it('opens one group without opening the other', () => {
    render(<DispatchResult summary={summaryOf(batch)} savedNote="x" />);
    fireEvent.click(screen.getByRole('button', { name: 'اعرض الطلبات (1)' }));
    expect(screen.getByText('ORD-2026-0508')).toBeTruthy();
    expect(screen.queryByText('ORD-2026-0004')).toBeNull();
  });

  it('is reachable and operable from the keyboard alone', async () => {
    const user = userEvent.setup();
    render(<DispatchResult summary={summaryOf(batch)} savedNote="x" />);
    await user.tab();
    const first = screen.getByRole('button', { name: 'اعرض الطلبات (35)' });
    expect(document.activeElement).toBe(first);
    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'خبّي الطلبات' }).getAttribute('aria-expanded')).toBe('true');
    await user.keyboard(' ');
    expect(screen.getByRole('button', { name: 'اعرض الطلبات (35)' }).getAttribute('aria-expanded')).toBe('false');
  });

  it('NEGATIVE: a batch with no failures has no toggle and no reason line at all', () => {
    const clean = summaryOf([{ orderId: 'ok1', orderNumber: 'ORD-2026-0900', ok: true, trackingNumber: 'KSA1' }]);
    render(<DispatchResult summary={clean} savedNote="الباركودات محفوظة" />);
    expect(screen.getByText('رُحّل 1')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText(/ طلب — /)).toBeNull();
  });

  it('a «maybe it was sent» outcome is its own group and shown as the warning it is', () => {
    const unknown: DispatchOutcome = {
      orderId: 'u1', orderNumber: 'ORD-2026-0777', ok: false, outcomeUnknown: true,
      error: 'LOGESTECHS_TIMEOUT: لم تردّ — قد يكون الطردُ أُنشئ. اسأل الشركة قبل إعادة الإرسال.',
    };
    render(<DispatchResult summary={summaryOf([unknown, refused(1)])} savedNote="x" />);
    const lines = screen.getAllByText(/ طلب — /);
    expect(lines).toHaveLength(2);
    const warn = lines.find((p) => p.textContent?.includes('اسأل الشركة'))!;
    expect(warn.className).toContain('font-bold');
    expect(lines.find((p) => p.textContent?.includes(REFUSAL))!.className).not.toContain('font-bold');
  });

  it('a very long reason is one wrapped line, not a layout break — and still one group', () => {
    const long = 'س'.repeat(300);
    const outcomes = Array.from({ length: 3 }, (_, i): DispatchOutcome => ({ orderId: `l${i}`, orderNumber: `ORD-${i}`, ok: false, error: long }));
    render(<DispatchResult summary={summaryOf(outcomes)} savedNote="x" />);
    expect(screen.getAllByText(/ طلب — /)).toHaveLength(1);
    expect(screen.getByText(`3 طلب — ${long}`)).toBeTruthy();
  });
});
