// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { earlierDaysNote, profitSinceSentence, sinceDate, startsBefore } from '@/lib/profit-since-words';

/**
 * A1 (25/11) — THE PROFIT SCREEN AND THE PARTNERS' CARD NAME THE SAME START: «الأرباح محسوبة من <التاريخ> — يوم أول كشف مرفوع».
 *
 * The door answers `sinceDay` (the day of the store's first courier statement, as the store writes it); the screen prints it beside
 * the figures, says so when the picked span starts earlier, and «إيراد الموصّل» says what it is made of. A store with no statement
 * (`sinceDay` null) reads as before. Rendered in jsdom: nothing behind the login can be opened in a browser here.
 */

vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ t: { cancel: 'تراجع' }, locale: 'ar', currentUser: { role: 'SUPER_ADMIN', permissions: [] } }) }));

import { FinanceProfitScreen } from './FinanceProfitScreen';

let sinceDay: string | null = '2026-10-28';

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.startsWith('/api/finance/profitability')) return new Response(JSON.stringify({ products: [] }), { status: 200 });
      if (url.startsWith('/api/finance/partners')) return new Response('{}', { status: 403 });
      return new Response(
        JSON.stringify({ currency: 'USD', since: sinceDay ? '2026-10-27T21:00:00.000Z' : null, sinceDay, summary: null, expenses: [], recentDeliveredOrders: [], spend: null }),
        { status: 200 }
      );
    })
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  sinceDay = '2026-10-28';
});

describe('the words', () => {
  it('print the store’s day in Arabic with Western digits, whatever the reader’s clock', () => {
    expect(sinceDate('2026-10-28')).toBe('28 أكتوبر 2026');
    expect(profitSinceSentence('2026-10-28')).toBe('الأرباح محسوبة من 28 أكتوبر 2026 — يوم أول كشف مرفوع');
    expect(earlierDaysNote('2026-10-28')).toBe('الأيام قبل 28 أكتوبر 2026 ما بتنحسب بالأرباح.');
    expect(profitSinceSentence('2026-10-28')).not.toMatch(/[٠-٩]/);
  });

  it('say «earlier» only for a span that starts before the day', () => {
    expect(startsBefore('2026-10-20', '2026-10-28')).toBe(true);
    expect(startsBefore('2026-10-28', '2026-10-28')).toBe(false);
    expect(startsBefore('2026-11-01', '2026-10-28')).toBe(false);
    expect(startsBefore('2026-10-20', null)).toBe(false);
    expect(startsBefore(null, '2026-10-28')).toBe(false);
  });
});

describe('the profit screen', () => {
  it('names the start beside the figures', async () => {
    render(<FinanceProfitScreen />);
    expect(await screen.findByText((t) => t.includes('الأرباح محسوبة من 28 أكتوبر 2026 — يوم أول كشف مرفوع'))).toBeTruthy();
  });

  it('with NO span (the box cleared): the one sentence names the start — never «منذ البداية»', async () => {
    render(<FinanceProfitScreen />);
    await screen.findByText((t) => t.includes('الأرباح محسوبة من'));
    fireEvent.click(screen.getAllByLabelText('امسح التاريخ')[0]);
    expect(await screen.findByText('الأرباح محسوبة من 28 أكتوبر 2026 — يوم أول كشف مرفوع. كل الموصَّل وكل المصاريف من يومها.')).toBeTruthy();
    expect(screen.queryByText((t) => t.includes('الأرقام منذ البداية'))).toBeNull();
  });

  it('NEGATIVE: with no span and no statement it says «منذ البداية», as before', async () => {
    sinceDay = null;
    render(<FinanceProfitScreen />);
    await screen.findAllByText('إيراد الموصَّل');
    fireEvent.click(screen.getAllByLabelText('امسح التاريخ')[0]);
    expect(await screen.findByText('الأرقام منذ البداية — كل الموصَّل وكل المصاريف.')).toBeTruthy();
  });

  it('a span that starts before it (today = 20/10): says the earlier days are not counted', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-20T12:00:00'));
    render(<FinanceProfitScreen />);
    expect(await screen.findByText((t) => t.includes('الأيام قبل 28 أكتوبر 2026 ما بتنحسب بالأرباح.'))).toBeTruthy();
  });

  it('NEGATIVE: a span after the start does not carry the «earlier» note', async () => {
    render(<FinanceProfitScreen />);
    await screen.findByText((t) => t.includes('الأرباح محسوبة من'));
    expect(screen.queryByText((t) => t.includes('ما بتنحسب بالأرباح'))).toBeNull();
  });

  it('NEGATIVE: a store with no statement names no start', async () => {
    sinceDay = null;
    render(<FinanceProfitScreen />);
    await screen.findAllByText('إيراد الموصَّل');
    expect(screen.queryByText((t) => t.includes('يوم أول كشف مرفوع'))).toBeNull();
  });

  it('«إيراد الموصّل» says what it is made of', async () => {
    render(<FinanceProfitScreen />);
    expect(await screen.findByText('ما دفعته شركة الشحن بالكشف، أو سعر الطلب قبل وصول كشفه')).toBeTruthy();
    expect(screen.queryByText('الطلبات المسلَّمة فعلاً، لا المؤكدة')).toBeNull();
  });
});
