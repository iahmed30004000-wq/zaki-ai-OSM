// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@/lib/guard-source';

/**
 * «سكور القنوات — أيّها يوصِّل فعلاً» — A REPORT, SO IT LIVES WITH THE REPORTS.
 *
 * It stood at the foot of `/settings/channels`, under the channels and their on/off
 * switches. The audit that proposed removing it called it a duplicate of the board's
 * «أداء القنوات». It is not: the board counts what each door BROUGHT, this scores
 * what each door DELIVERED and COLLECTED. So it moved, whole, under the board's table:
 *
 *   · the channels screen is settings only — it asks for no report — and links to
 *     the board for whoever may open it;
 *   · the board's section reads its own report and draws the score, the bands, and
 *     the orders that came through no door;
 *   · and when the report is refused (its door asks `reports.view`, the key of the board) the
 *     section is SILENT, not an error under every table.
 */

const { api, may } = vi.hoisted(() => ({
  api: vi.fn(),
  may: { yes: ((_p: string) => true) as (p: string) => boolean },
}));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a) }));
vi.mock('@/hooks/useMayOpen', () => ({
  useMayOpen: () => (target: string | { path: string }) => may.yes(typeof target === 'string' ? target : target.path),
}));
vi.mock('@/hooks/useLiveRefresh', () => ({
  useLiveRefresh: (load: () => Promise<unknown>) => {
    const latest = React.useRef(load);
    latest.current = load;
    React.useEffect(() => {
      void latest.current();
    }, []);
  },
}));
vi.mock('@/components/ui/Confirm', () => ({ useConfirm: () => vi.fn(async () => true) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), success: vi.fn(), done: vi.fn() }) }));
vi.mock('@/components/ui/PageHeader', () => ({ PageHeader: ({ title }: { title: string }) => <h1>{title}</h1> }));
vi.mock('@/components/ui/Money', () => ({ Money: ({ value }: { value: number }) => <span>{value}</span> }));
vi.mock('@/components/ui/HealthChip', () => ({ HealthChip: () => null }));

import { ChannelScoresSection } from './ChannelScores';
import { ChannelsScreen } from '@/components/screens/ChannelsScreen';

const REPORT = {
  channels: [
    {
      id: 'c1', name: 'صفحة الكريم', kind: 'LANDING_PAGE', isActive: true,
      brought: 40, confirmed: 30, delivered: 24, returned: 4, doorDecided: 28, collected: 0,
      confirmationRate: 75, deliveryRate: 80, returnRate: 14, revenue: 480, deliveredValue: 20,
      score: { total: 67, possible: 85, bands: [], sample: 30, minSample: 10, reason: null },
      whyNoScore: null,
    },
    {
      id: 'c2', name: 'قناة جديدة', kind: 'OTHER', isActive: true,
      brought: 2, confirmed: 1, delivered: 0, returned: 0, doorDecided: 0, collected: 0,
      confirmationRate: null, deliveryRate: null, returnRate: null, revenue: 0, deliveredValue: null,
      score: { total: null, possible: 85, bands: [], sample: 1, minSample: 10, reason: 'BELOW_MINIMUM' },
      whyNoScore: 'عيّنة صغيرة',
    },
  ],
  shop: {
    orders: 60, delivered: 24, collected: 0, withoutChannel: 18, withoutChannelShare: 30,
    collection: { level: 'WITHHELD', present: 0, population: 24, share: 0, ar: 'لا كشف مطابَق بعد.' },
  },
};
const LIST = {
  channels: [{ id: 'c1', name: 'صفحة الكريم', kind: 'LANDING_PAGE', isActive: true, orderCount: 0 }],
};

beforeEach(() => {
  vi.clearAllMocks();
  may.yes = () => true;
  api.mockImplementation(async (url: string) => {
    if (url === '/api/settings/channels/performance') return REPORT;
    if (url === '/api/settings/channels') return LIST;
    throw new Error(`unexpected ${url}`);
  });
});
afterEach(cleanup);

describe('the board’s section', () => {
  it('draws the score of a door that has enough orders, and the line for the orders with no door', async () => {
    render(<ChannelScoresSection />);
    await screen.findByText('سكور القنوات — أيّها يوصِّل فعلاً');
    expect(screen.getByText('صفحة الكريم')).toBeTruthy();
    expect(screen.getByText('67')).toBeTruthy();
    expect(screen.getByText('بلا قناة')).toBeTruthy();
    expect(screen.getByText(/التحصيل خارج السكور/)).toBeTruthy();
  });

  it('NEGATIVE: when the report is refused it draws NOTHING — not an error under the tables', async () => {
    api.mockImplementation(async () => {
      throw new Error('ليس لديك صلاحية');
    });
    const { container } = render(<ChannelScoresSection />);
    await waitFor(() => expect(api).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(container.textContent).toBe('');
  });
});

describe('the channels screen', () => {
  it('is settings only: it never asks for the report, and draws no score', async () => {
    render(<ChannelsScreen />);
    await screen.findByText('صفحة الكريم');
    expect(api.mock.calls.map((c) => c[0])).not.toContain('/api/settings/channels/performance');
    expect(screen.queryByText('سكور القنوات — أيّها يوصِّل فعلاً')).toBeNull();
  });

  it('links to the board for whoever may open it', async () => {
    render(<ChannelsScreen />);
    await screen.findByText('صفحة الكريم');
    expect(screen.getByRole('link', { name: 'سكور القنوات في لوحة الأداء' }).getAttribute('href')).toBe('/growth/performance');
  });

  it('NEGATIVE: and offers no link to somebody who may not open the board', async () => {
    may.yes = (p) => p !== '/growth/performance';
    render(<ChannelsScreen />);
    await screen.findByText('صفحة الكريم');
    expect(screen.queryByRole('link', { name: /لوحة الأداء/ })).toBeNull();
  });
});

describe('the board', () => {
  it('draws the section under its channel attribution table', () => {
    const src = stripComments(readFileSync(join(process.cwd(), 'src/components/screens/PerformanceScreen.tsx'), 'utf8'));
    expect(src).toContain('<ChannelScoresSection />');
    expect(src.indexOf('title="أداء القنوات"')).toBeLessThan(src.indexOf('<ChannelScoresSection />'));
  });
});
