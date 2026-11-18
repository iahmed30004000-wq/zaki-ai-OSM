// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { repoFile, stripComments } from '@/lib/guard-source';

/**
 * «اليوم»'s ONE CHART (R9, 18/11): the orders of each day, from `GET /api/analytics/daily`, drawn and never recomputed.
 *
 * What must hold: each day's three counts are the server's (read through the hidden list a screen reader gets); the legend prints
 * the answer's own totals — the fixture's totals are deliberately NOT the sum of its days, so a chart that adds them up goes red; a
 * refusal is said in the door's own sentence; a truncated read says so; an empty period is a sentence, not an empty frame.
 */

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/api-client', async (orig) => ({
  ...(await orig<typeof import('@/lib/api-client')>()),
  apiFetch: (...a: unknown[]) => apiFetch(...a),
}));
vi.mock('@/hooks/useLiveRefresh', () => ({
  useLiveRefresh: (load: () => Promise<unknown>) => {
    React.useEffect(() => {
      void load();
    }, [load]);
  },
}));
vi.mock('@/components/shell/ThemeDecor', () => ({ ThemeDecor: () => null }));

import { DailyChart, heightOf } from './DailyChart';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const RANGE = { from: '2026-11-16', to: '2026-11-18' };
const DAYS = [
  { day: '2026-11-16', created: 4, confirmed: 3, delivered: 1 },
  { day: '2026-11-17', created: 0, confirmed: 0, delivered: 0 },
  { day: '2026-11-18', created: 8, confirmed: 5, delivered: 2 },
];
/** NOT the sum of the days (12 · 8 · 3): the legend must print the server's figure. */
const TOTALS = { created: 41, confirmed: 27, delivered: 9 };

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

/** The days said in words, as the hidden list gives them to a screen reader. */
const spoken = () => within(screen.getByRole('list', { name: 'الطلبات كل يوم' })).getAllByRole('listitem').map((li) => li.textContent);

describe('the chart draws the server’s days', () => {
  it('asks the daily door for the chosen days, with the reports’ wait', async () => {
    apiFetch.mockResolvedValue(json(200, { days: DAYS, totals: TOTALS, truncated: false, timezone: 'Asia/Amman' }));
    render(<DailyChart range={RANGE} />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(apiFetch.mock.calls[0][0]).toBe('/api/analytics/daily?from=2026-11-16&to=2026-11-18');
    expect(apiFetch.mock.calls[0][1]).toEqual({ timeoutMs: 60_000 });
  });

  it('each day carries its own three counts', async () => {
    apiFetch.mockResolvedValue(json(200, { days: DAYS, totals: TOTALS, truncated: false }));
    render(<DailyChart range={RANGE} />);
    await screen.findByRole('img');
    expect(spoken()).toEqual([
      '2026-11-16: انعمل 4، تأكّد 3، توصّل 1',
      '2026-11-17: انعمل 0، تأكّد 0، توصّل 0',
      '2026-11-18: انعمل 8، تأكّد 5، توصّل 2',
    ]);
  });

  it('the legend prints the answer’s totals — never a sum of the days', async () => {
    apiFetch.mockResolvedValue(json(200, { days: DAYS, totals: TOTALS, truncated: false }));
    render(<DailyChart range={RANGE} />);
    await screen.findByRole('img');
    expect(screen.getByText('41')).toBeTruthy();
    expect(screen.getByText('27')).toBeTruthy();
    expect(screen.getByText('9')).toBeTruthy();
    // NEGATIVE: the sum of the days is nowhere
    expect(screen.queryByText('12')).toBeNull();
  });

  it('the bars are drawn against the tallest day, inline — no fixed width anywhere', async () => {
    apiFetch.mockResolvedValue(json(200, { days: DAYS, totals: TOTALS, truncated: false }));
    const { container } = render(<DailyChart range={RANGE} />);
    await screen.findByRole('img');
    const plot = screen.getByRole('img');
    expect(plot.className).toContain('w-full');
    const bars = [...plot.querySelectorAll('span')].map((b) => (b as HTMLElement).style.height);
    expect(bars).toEqual(['50%', '38%', '13%', '0%', '0%', '0%', '100%', '63%', '25%']);
    // At 375 px the chart is as wide as its card: no pixel width, no horizontal scroll.
    expect(container.innerHTML).not.toMatch(/w-\[\d+px\]|min-w-\[\d+px\]|overflow-x-auto/);
  });

  it('tells the screen the store’s clock', async () => {
    const told = vi.fn();
    apiFetch.mockResolvedValue(json(200, { days: DAYS, totals: TOTALS, truncated: false, timezone: 'Asia/Damascus' }));
    render(<DailyChart range={RANGE} onTimeZone={told} />);
    await waitFor(() => expect(told).toHaveBeenCalledWith('Asia/Damascus'));
  });
});

describe('what it says instead of bars', () => {
  it('a refused span is said in the door’s own sentence', async () => {
    apiFetch.mockResolvedValue(json(400, { errorAr: 'المدة أطول من 92 يوماً. اختر مدة أقصر.' }));
    render(<DailyChart range={{ from: '2026-01-01', to: '2026-11-18' }} />);
    expect(await screen.findByText('المدة أطول من 92 يوماً. اختر مدة أقصر.')).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('a read that hit the ceiling says its counts are a floor', async () => {
    apiFetch.mockResolvedValue(json(200, { days: DAYS, totals: TOTALS, truncated: true }));
    render(<DailyChart range={RANGE} />);
    expect(await screen.findByText(/فالأرقام هون أقل من الحقيقة/)).toBeTruthy();
  });

  it('NEGATIVE: and a whole read says nothing of the kind', async () => {
    apiFetch.mockResolvedValue(json(200, { days: DAYS, totals: TOTALS, truncated: false }));
    render(<DailyChart range={RANGE} />);
    await screen.findByRole('img');
    expect(screen.queryByText(/أقل من الحقيقة/)).toBeNull();
  });

  it('an empty period is a sentence, not an empty frame', async () => {
    const quiet = [{ day: '2026-11-18', created: 0, confirmed: 0, delivered: 0 }];
    apiFetch.mockResolvedValue(json(200, { days: quiet, totals: { created: 0, confirmed: 0, delivered: 0 }, truncated: false }));
    render(<DailyChart range={{ from: '2026-11-18', to: '2026-11-18' }} />);
    expect(await screen.findByText('ما في طلبات بهالمدة')).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByRole('list', { name: 'الطلبات كل يوم' })).toBeNull();
  });

  it('a dropped connection is said in Arabic, never the browser’s English', async () => {
    apiFetch.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<DailyChart range={RANGE} />);
    expect(await screen.findByText('تعذّر الاتصال. تأكّد من الشبكة وجرّب كمان مرة.')).toBeTruthy();
    expect(screen.queryByText('Failed to fetch')).toBeNull();
  });

  it('and nothing is asked for a range that is not a pair of days', async () => {
    render(<DailyChart range={{ from: '', to: '' }} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(apiFetch).not.toHaveBeenCalled();
  });
});

describe('it computes nothing', () => {
  it('heightOf is a share of the tallest bar, and zero when every day is zero', () => {
    expect(heightOf(5, 10)).toBe('50%');
    expect(heightOf(10, 10)).toBe('100%');
    expect(heightOf(0, 0)).toBe('0%');
  });

  it('the only arithmetic in the file is the bar height', () => {
    const src = stripComments(repoFile('src/components/dashboard/DailyChart.tsx'));
    const outside = src.replace(/export function heightOf[\s\S]*?\n}\n/, '');
    expect(outside).not.toMatch(/reduce\(|\+=|-=/);
    // no figure of the answer is added, subtracted, multiplied or divided
    expect(outside).not.toMatch(/(?:\.created|\.confirmed|\.delivered|\]\))\s*[-+*/]\s*[\w(]/);
    expect(outside).not.toMatch(/[-+*/]\s*(?:d|day|totals|answer)\.(?:created|confirmed|delivered)/);
  });
});
