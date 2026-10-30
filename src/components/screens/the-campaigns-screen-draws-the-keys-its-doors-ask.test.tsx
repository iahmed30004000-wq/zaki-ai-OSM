// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE CAMPAIGNS SCREEN DRAWS A CONTROL ONLY FOR THE KEY ITS DOOR ASKS (perm-plan PR-11).
 *
 * The list is «عرض الحملات» (campaigns.view); every press that writes — a new campaign, an edit, a delete, the two pulls from
 * the ad platforms, the selection and the drag — is «إدارة الحملات» (campaigns.manage). A viewer sees the numbers and the
 * filters and is offered no press that ends in a refusal. And the offers card on the product page draws its controls for
 * `offers.manage`, the key its own doors ask, not for everybody.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { who, apiJson } = vi.hoisted(() => ({ who: { permissions: [] as string[], role: 'MODERATOR' }, apiJson: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a) }));
vi.mock('@/components/ui/Confirm', () => ({ useConfirm: () => vi.fn(async () => true) }));
vi.mock('@/hooks/useLiveRefresh', () => ({
  useLiveRefresh: (load: () => Promise<void>) => {
    React.useEffect(() => {
      void load();
    }, [load]);
  },
}));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ currentUser: { id: 'u1', name: 'م', role: who.role, status: 'ACTIVE', permissions: who.permissions } }),
}));

import { CampaignsScreen } from './CampaignsScreen';

const CONNECTED = { id: 'acc-c', platform: 'META', accountId: 'act_1', accountName: 'ميتا المربوط', status: 'CONNECTED' };
const campaign = {
  id: 'c-1', name: 'حملة الصيف', platform: 'META', code: 'ABC123', status: 'ACTIVE',
  spendSource: 'MANUAL', adAccount: null, externalId: null, lastSyncAt: null,
  startDate: '2026-10-01T00:00:00.000Z', endDate: null, notes: null,
  landingPage: null, product: null, productId: null,
  link: 'https://shop.example/?c=ABC123', ranInWindow: true,
  funnel: { brought: 0, confirmed: 0, rejected: 0, delivered: 0, returned: 0, confirmationRate: null, deliveryRate: null },
  money: { spend: 100, revenue: 0, net: -100, roas: null, costPerDelivered: null, costPerOrder: null },
};
const totals = { spend: 0, revenue: 0, net: 0, roas: null, costPerDelivered: null, costPerOrder: null, brought: 0, delivered: 0 };

let campaigns: unknown[] = [];
const fetchMock = vi.fn(async (url: string) => {
  if (url.startsWith('/api/growth/campaigns?')) {
    return { ok: true, json: async () => ({ campaigns, totals, currency: 'USD', adAccounts: [CONNECTED], definitions: {}, insights: null }) };
  }
  if (url === '/api/landing-pages') return { ok: true, json: async () => ({ pages: [] }) };
  throw new Error(`unexpected fetch ${url}`);
});

beforeEach(() => {
  campaigns = [campaign];
  vi.stubGlobal('fetch', fetchMock);
  apiJson.mockImplementation(async (url: string) => (url.startsWith('/api/products') ? { products: [] } : { success: true }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function mount(...permissions: string[]) {
  who.permissions = permissions;
  render(<CampaignsScreen />);
  await screen.findByText('حملة الصيف');
  await act(async () => {});
}

const WRITES = ['حملة جديدة', 'اسحب الحملات', 'اسحب الإنفاق', 'اربط'];

describe('a viewer (campaigns.view without campaigns.manage)', () => {
  it('sees the campaign and its numbers, and none of the writing controls', async () => {
    await mount('campaigns.view');
    expect(screen.getByText('حملة الصيف')).toBeTruthy();
    expect(screen.getByText('أُنفق')).toBeTruthy();
    expect(screen.getByText('رابط الإعلان')).toBeTruthy(); // copying the link is reading, not writing
    for (const label of WRITES) expect(screen.queryByText(label), label).toBeNull();
    expect(screen.queryByRole('button', { name: 'تعديل' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'حذف' })).toBeNull();
    expect(screen.queryByLabelText('حدد كل المعروض')).toBeNull();
    expect(screen.queryAllByLabelText(/^اسحب /)).toHaveLength(0);
  });

  it('and an EMPTY list offers no “new campaign” button either — the first step is not his', async () => {
    campaigns = [];
    who.permissions = ['campaigns.view'];
    render(<CampaignsScreen />);
    await screen.findByText('لا حملات بعد');
    expect(screen.queryByText('حملة جديدة')).toBeNull();
  });

  it('NEGATIVE: the old key does not draw them either — reports.view alone is not even a viewer', async () => {
    await mount('reports.view');
    for (const label of WRITES) expect(screen.queryByText(label), label).toBeNull();
    expect(screen.queryByRole('button', { name: 'تعديل' })).toBeNull();
  });
});

describe('a manager (both keys) is offered every one of them', () => {
  it('the new campaign, both pulls, the link to the platform, edit, delete, the selection and the drag', async () => {
    await mount('campaigns.view', 'campaigns.manage');
    expect(screen.getAllByRole('button', { name: /حملة جديدة/ }).length).toBeGreaterThan(0);
    expect(screen.getByText('اسحب الحملات')).toBeTruthy();
    expect(screen.getByText('اسحب الإنفاق')).toBeTruthy();
    expect(screen.getByText('اربط')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'تعديل' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'حذف' })).toBeTruthy();
    expect(screen.getByLabelText('حدد كل المعروض')).toBeTruthy();
    expect(screen.getAllByLabelText(/^اسحب /).length).toBeGreaterThan(0);
  });

  it('and so does SUPER_ADMIN', async () => {
    who.role = 'SUPER_ADMIN';
    try {
      await mount();
      expect(screen.getByText('اسحب الإنفاق')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'تعديل' })).toBeTruthy();
    } finally {
      who.role = 'MODERATOR';
    }
  });
});

describe('the product page: the offers card is drawn for the key the offers’ doors ask', () => {
  const src = readFileSync(path.join(process.cwd(), 'src', 'components', 'screens', 'ProductDetailScreen.tsx'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

  it('passes canManage from offers.manage — it used to be left to default to true for everybody', () => {
    const card = code.slice(code.indexOf('<ProductOffers'), code.indexOf('/>', code.indexOf('<ProductOffers')));
    expect(card).toContain(`canManage={userCan(currentUser, 'offers.manage')}`);
    // NEGATIVE: not the product edit (the old accident), and not left out.
    expect(card).not.toMatch(/canManage=\{canManage\}/);
    expect(card).toContain('canManage=');
  });

  it('and the offers’ own doors really do ask offers.manage (the card follows the server, not a guess)', () => {
    for (const f of ['route.ts', '[id]/route.ts']) {
      const door = readFileSync(path.join(process.cwd(), 'src', 'app', 'api', 'offers', f), 'utf8');
      expect(door, f).toContain(`requirePermission('offers.manage')`);
    }
  });
});
