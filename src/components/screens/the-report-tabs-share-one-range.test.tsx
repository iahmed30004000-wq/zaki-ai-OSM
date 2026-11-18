// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * «مدة وحدة بتضل لما أتنقّل بين التقارير» (R14a1, 18/11): the span picked on the performance board is the span «الحملات» opens on.
 *
 * Two real screens, one after the other, as a person moves between the report tabs: the board writes the one stored key on a change,
 * the campaigns screen reads it at mount. The date box is stood in for by a button that picks a span (both screens draw the same box).
 */

const { apiFetch, apiJson } = vi.hoisted(() => ({ apiFetch: vi.fn(), apiJson: vi.fn() }));
vi.mock('@/lib/api-client', async (orig) => ({
  ...(await orig<typeof import('@/lib/api-client')>()),
  apiFetch: (...a: unknown[]) => apiFetch(...a),
  apiJson: (...a: unknown[]) => apiJson(...a),
}));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({
    t: {},
    locale: 'ar',
    isRtl: true,
    currentUser: { id: 'u1', role: 'MANAGER', status: 'ACTIVE', permissions: ['reports.view', 'team.monitor', 'campaigns.view'] },
  }),
}));
vi.mock('@/components/ui/Confirm', () => ({ useConfirm: () => vi.fn(async () => true) }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/components/growth/IntelligenceStrip', () => ({ IntelligenceStrip: () => null }));
vi.mock('@/components/dashboard/LossPanel', () => ({ LossPanel: () => null }));
vi.mock('@/components/dashboard/DetailsLinks', () => ({ BackToDashboardLink: () => null }));
vi.mock('@/components/growth/ChannelScores', () => ({ ChannelScoresSection: () => null }));
vi.mock('@/components/ui/DateRange', () => ({
  todayRange: () => ({ from: '2026-11-18', to: '2026-11-18' }),
  DateRange: ({ onChange, label }: { onChange: (r: { from: string; to: string }) => void; label?: string }) => (
    <button type="button" onClick={() => onChange({ from: '2026-11-01', to: '2026-11-07' })}>
      {label}
    </button>
  ),
}));

import { PerformanceScreen } from './PerformanceScreen';
import { CampaignsScreen } from './CampaignsScreen';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const ANALYTICS = { ordersCount: { total: 1 }, rates: {}, financials: {}, rankings: {}, productStats: [], vitals: { door: { delivered: 0, failed: 0, returned: 0, decided: 0, returnRate: null }, cost: { level: 'WITHHELD' } } };

const campaignsAsked: string[] = [];
const fetchMock = vi.fn(async (url: string) => {
  if (url.startsWith('/api/growth/campaigns?')) {
    campaignsAsked.push(url);
    return { ok: true, json: async () => ({ campaigns: [], totals: null, currency: 'USD', adAccounts: [], definitions: {}, insights: null }) };
  }
  return { ok: true, json: async () => ({ pages: [] }) };
});

beforeEach(() => {
  vi.clearAllMocks();
  campaignsAsked.length = 0;
  sessionStorage.clear();
  window.history.replaceState(null, '', '/growth/performance');
  vi.stubGlobal('fetch', fetchMock);
  apiFetch.mockResolvedValue(json(200, ANALYTICS));
  apiJson.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/orders/confirmation/team?')) return { employees: [], totals: null };
    if (url.startsWith('/api/growth/attribution')) return { moderators: [], channels: [] };
    if (url.startsWith('/api/orders/shipping/performance')) return { providers: [], collection: null };
    if (url.startsWith('/api/products')) return { products: [] };
    return {};
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the span moves with the person between the report tabs', () => {
  it('picked on the performance board → «الحملات» opens on the same span, and asks for it once', async () => {
    const board = render(<PerformanceScreen />);
    fireEvent.click(await screen.findByRole('button', { name: 'كل المدة' }));
    await waitFor(() =>
      expect(apiJson.mock.calls.map((c) => String(c[0]))).toContain('/api/orders/confirmation/team?startDate=2026-11-01&endDate=2026-11-07'),
    );
    board.unmount();

    window.history.replaceState(null, '', '/growth/campaigns');
    render(<CampaignsScreen />);
    await waitFor(() => expect(campaignsAsked.length).toBeGreaterThan(0));
    expect(campaignsAsked).toEqual(['/api/growth/campaigns?startDate=2026-11-01&endDate=2026-11-07']);
  });

  it('NEGATIVE: nothing picked on the board → «الحملات» opens on its own today, as it always did', async () => {
    const board = render(<PerformanceScreen />);
    await screen.findByRole('button', { name: 'كل المدة' });
    board.unmount();
    window.history.replaceState(null, '', '/growth/campaigns');
    render(<CampaignsScreen />);
    await waitFor(() => expect(campaignsAsked.length).toBeGreaterThan(0));
    expect(campaignsAsked).toEqual(['/api/growth/campaigns?period=today']);
  });
});
