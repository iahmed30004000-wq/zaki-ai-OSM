// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@/lib/guard-source';
import { CARD_CLASS } from '@/lib/theme-shape';
import { countsOf } from '../../../scripts/ui-debt';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE REST OF THE PERFORMANCE BOARD IS ON THE KIT (request R14a2, 18/11) — AND NOTHING IT DID CHANGED.
 *
 * The six parts under the board (`EodReportForm`, `HeldFlowPanel`, `LandingAnalyticsTab`, `CommissionPreview`, `NoAnswerWatch`,
 * `WeeklyMeasures`) moved from hand-made toggles, buttons, tiles and surfaces to the kit. This file holds what the move promised:
 *   - the end-of-day form still sends ONCE, its two days are one choice, and the send is a real non-submitting button;
 *   - the landing analytics tab still asks with the screen's own range query, unchanged;
 *   - the commission estimate says its own window beside it (R14 DoD 2);
 *   - the tiles are the kit's tile, the surfaces the kit's card;
 *   - a phone: no fixed width wider than the viewport, every list through `Rows`.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { api, failed, fetchReply } = vi.hoisted(() => ({
  api: vi.fn(),
  failed: vi.fn(),
  fetchReply: { status: 200, body: {} as unknown },
}));
vi.mock('@/lib/api-client', () => ({
  apiJson: (...a: unknown[]) => api(...a),
  apiFetch: vi.fn(async () => ({ ok: fetchReply.status === 200, status: fetchReply.status, json: async () => fetchReply.body })),
  saidBy: async (res: { json: () => Promise<{ errorAr?: string }> }, fallback: string) => (await res.json()).errorAr ?? fallback,
}));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed }) }));
vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));

import { EodReportForm } from './EodReportForm';
import { LandingAnalyticsTab } from './LandingAnalyticsTab';
import { CommissionPreview } from './CommissionPreview';
import { NoAnswerWatch } from './NoAnswerWatch';

const SRC = (name: string) => stripComments(readFileSync(join(process.cwd(), 'src/components/performance', `${name}.tsx`), 'utf8'));
const PARTS = ['EodReportForm', 'HeldFlowPanel', 'LandingAnalyticsTab', 'CommissionPreview', 'NoAnswerWatch', 'WeeklyMeasures'];

beforeEach(() => {
  vi.clearAllMocks();
  fetchReply.status = 200;
  fetchReply.body = {};
});
afterEach(cleanup);

describe('the end-of-day form', () => {
  const sys = { userId: 'u1', name: 'سارة', claims: 10, confirmed: 6, rejected: 2, noAnswer: 8, winback: 0, stuck: 3, rejectedByReason: {}, winbackConverted: 0 };
  const answer = { day: '2026-11-10', mayReport: true, reasons: {}, system: [sys], submitted: null };

  it('its two days are ONE choice (a radio group named «اليوم»), today chosen first, and choosing yesterday asks for yesterday', async () => {
    api.mockResolvedValue(answer);
    render(<EodReportForm />);
    await screen.findByText('سارة');
    const group = screen.getByRole('radiogroup', { name: 'اليوم' });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((r) => r.textContent)).toEqual(['اليوم', 'أمس']);
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    expect(String(api.mock.calls[0][0])).toBe('/api/confirmation/eod-report');
    fireEvent.click(within(group).getByRole('radio', { name: 'أمس' }));
    await waitFor(() => expect(String(api.mock.calls.at(-1)![0])).toMatch(/^\/api\/confirmation\/eod-report\?day=\d{4}-\d{2}-\d{2}$/));
    expect(within(group).getByRole('radio', { name: 'أمس' }).getAttribute('aria-checked')).toBe('true');
  });

  it('sends ONCE: two presses while the first is in the air make one request, and the button does not submit a form', async () => {
    api.mockResolvedValue(answer);
    render(<EodReportForm />);
    await screen.findByText('سارة');
    let release: (v: unknown) => void = () => undefined;
    api.mockImplementationOnce(() => new Promise((r) => (release = r)));
    const send = screen.getByRole('button', { name: 'إرسال التقرير (مرة وحدة)' });
    expect(send.getAttribute('type')).toBe('button');
    fireEvent.click(send);
    fireEvent.click(send);
    fireEvent.click(screen.getByRole('button', { name: 'إرسال التقرير (مرة وحدة)' }));
    const posts = () => api.mock.calls.filter((c) => c[1] && (c[1] as { method?: string }).method === 'POST');
    expect(posts()).toHaveLength(1);
    // While it is in the air the boxes are frozen too — the screen's own flag, not only the button.
    expect((screen.getByRole('button', { name: 'إرسال التقرير (مرة وحدة)' }) as HTMLButtonElement).disabled).toBe(true);
    for (const box of screen.getAllByRole('spinbutton')) expect((box as HTMLInputElement).disabled).toBe(true);
    release({ ok: true });
    await waitFor(() => expect(posts()).toHaveLength(1));
  });

  it('a day she may no longer report cannot be sent at all', async () => {
    api.mockResolvedValue({ ...answer, mayReport: false });
    render(<EodReportForm />);
    await screen.findByText('سارة');
    fireEvent.click(screen.getByRole('button', { name: 'إرسال التقرير (مرة وحدة)' }));
    expect(api.mock.calls.filter((c) => c[1])).toHaveLength(0);
  });
});

describe('the landing analytics tab', () => {
  const row = (key: string, views: number, orders: number) => ({ key, label: key, views, orders, conversion: views ? Math.round((orders / views) * 100) : null });
  const data = { countingSince: '2026-01-01', totals: row('all', 200, 10), byPage: [row('p1', 200, 10)], byDevice: [row('mobile', 200, 10)], byCampaign: [], countCheck: null };

  it('asks with the screen’s own range query, exactly as given — and asks again when the range changes', async () => {
    api.mockResolvedValue(data);
    const { rerender } = render(<LandingAnalyticsTab dateQuery="startDate=2026-11-01&endDate=2026-11-18" from="2026-11-01" />);
    await screen.findByText('المشاهدات');
    expect(api.mock.calls.map((c) => c[0])).toEqual(['/api/growth/landing-analytics?startDate=2026-11-01&endDate=2026-11-18']);
    rerender(<LandingAnalyticsTab dateQuery="period=all" from="" />);
    await waitFor(() => expect(api.mock.calls.map((c) => c[0])).toContain('/api/growth/landing-analytics?period=all'));
  });

  it('the screen still hands it the shared range’s query (the same one the team table reads)', () => {
    const screenSrc = stripComments(readFileSync(join(process.cwd(), 'src/components/screens/PerformanceScreen.tsx'), 'utf8'));
    expect(screenSrc).toContain('<LandingAnalyticsTab dateQuery={dateQuery} from={range.from} />');
    expect(screenSrc).toContain('`/api/orders/confirmation/team?${dateQuery}`');
  });

  it('draws its three totals as the kit tile and its sections as the kit card', async () => {
    api.mockResolvedValue(data);
    const { container } = render(<LandingAnalyticsTab dateQuery="period=all" from="" />);
    await screen.findByText('المشاهدات');
    const terms = [...container.querySelectorAll('dt')].map((d) => d.textContent);
    // The first three terms are the tiles (on a phone `Rows` draws its cards as terms too, after them).
    expect(terms.slice(0, 3)).toEqual(['المشاهدات', 'الطلبات', 'نسبة التحويل']);
    const page = [...container.querySelectorAll('div')].filter((d) => d.className.split(' ').includes(CARD_CLASS));
    // «حسب الصفحة», «حسب الجهاز», «حسب الحملة» — page-level surfaces.
    expect(page.length).toBe(3);
  });

  it('a failure is said on the kit card, never a blank tab', async () => {
    api.mockRejectedValue(new Error('500'));
    const { container } = render(<LandingAnalyticsTab dateQuery="period=all" from="" />);
    expect(await screen.findByText('تعذّر تحميل التحليلات.')).toBeTruthy();
    expect(container.firstElementChild?.className.split(' ')).toContain(CARD_CLASS);
  });
});

describe('the commission estimate says its own window', () => {
  it('beside the figures, in a caption: the month so far, not the board’s range', async () => {
    api.mockResolvedValue({ window: { start: '2026-11-01T00:00:00Z', end: '2026-11-16T00:00:00Z' }, rows: [] });
    const { container } = render(<CommissionPreview />);
    const line = await screen.findByText('التقدير على الشهر الحالي من أولو لهلّق — ما بيتبع المدة المختارة فوق.');
    expect(line.className.split(' ')).toContain('text-note');
    expect(container.textContent).toContain('تقدير بس، مش المحسوب ولا المصروف');
  });

  it('a refusal still draws nothing — the caption does not appear on its own', async () => {
    api.mockRejectedValue(new Error('403'));
    const { container } = render(<CommissionPreview />);
    await waitFor(() => expect(api).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    expect(container.textContent).toBe('');
  });
});

describe('the no-answer board’s four figures are the kit tile', () => {
  it('each label is a term of the tile and its figure beside it', async () => {
    fetchReply.body = {
      board: {
        agents: [],
        totals: { held: 131, onlyNoAnswer: 87, promisesDue: 0, stuck: 0, confirmedToday: 0 },
        team: { freshUnclaimed: 17, unclaimedWithNoAnswer: 23 },
        truncated: false,
      },
      rules: { stuckBusinessDays: 2, freshNewHours: 2 },
      report: { byHour: [], byAttempt: [], total: { key: 'الكل', reached: 0, notReached: 0, base: 0, notACall: 0, rate: null }, truncated: false },
    };
    const { container } = render(<NoAnswerWatch />);
    await screen.findByText('بيد الموظفات الآن');
    const tile = (label: string) => [...container.querySelectorAll('dt')].find((d) => d.textContent === label)?.closest('dl') as HTMLElement;
    expect(within(tile('بيد الموظفات الآن')).getByText('131')).toBeTruthy();
    expect(within(tile('منها لا رد فقط')).getByText('87')).toBeTruthy();
    expect(within(tile('مفتوحة بلا صاحب وفيها لا رد')).getByText('23')).toBeTruthy();
  });
});

describe('the six parts, read as source', () => {
  it('no hand-made button, toggle, caption size or card surface is left (the debt counter itself, per file: all zero)', () => {
    for (const name of PARTS) {
      const src = readFileSync(join(process.cwd(), 'src/components/performance', `${name}.tsx`), 'utf8');
      const c = countsOf(src);
      expect([c.rawButtons, c.rawCheckboxes, c.rawSurfaces, c.rawDatePickers, c.textXs], name).toEqual([0, 0, 0, 0, 0]);
      expect(stripComments(src), name).not.toContain('aria-pressed');
    }
  });

  it('a phone: no fixed width wider than 375 px, and every list is drawn through `Rows`', () => {
    for (const name of PARTS) {
      const src = SRC(name);
      for (const m of src.matchAll(/(?:min-)?w-\[(\d+)px\]/g)) expect(Number(m[1]), `${name}: ${m[0]}`).toBeLessThanOrEqual(375);
      expect(src, name).not.toMatch(/<table[\s>]/);
    }
    for (const name of ['LandingAnalyticsTab', 'CommissionPreview', 'NoAnswerWatch']) expect(SRC(name), name).toContain('<Rows');
  });
});
