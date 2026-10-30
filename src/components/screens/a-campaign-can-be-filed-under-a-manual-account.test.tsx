// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * A MANUAL AD ACCOUNT IS A PLACE TO PUT A CAMPAIGN — NOT A SOURCE FOR ITS SPEND.
 *
 * «ادخال يدوي بالكامل». On the campaigns screen that has three consequences,
 * and each is a way to get it wrong that looks fine:
 *
 *   • the buttons that CALL a platform («اسحب الحملات», «اسحب الإنفاق», «اربط»)
 *     appear because an account exists — and a manual one has nothing to call,
 *     so offering them would be a button that does nothing, or worse;
 *   • the campaign editor lets the seller file a campaign under a manual
 *     account of ITS OWN platform, and nothing else — a connected account is
 *     linked with «اربط», which also picks the remote campaign, and a select
 *     cannot;
 *   • saving files it AFTER the campaign is saved, only when the choice
 *     changed, and a failure there must not leave the editor open on a saved
 *     campaign (in «new» mode a second press would create it twice).
 */

const { apiJson, confirmFn } = vi.hoisted(() => ({ apiJson: vi.fn(), confirmFn: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a) }));
vi.mock('@/components/ui/Confirm', () => ({ useConfirm: () => confirmFn }));
// was: no session — the screen draws its writes only for «campaigns.manage» since PR-11, so it asks who is looking.
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ currentUser: { id: 'u1', name: 'م', role: 'MODERATOR', status: 'ACTIVE', permissions: ['campaigns.view', 'campaigns.manage'] } }),
}));
vi.mock('@/hooks/useLiveRefresh', () => ({
  useLiveRefresh: (load: () => Promise<void>) => {
    React.useEffect(() => {
      void load();
    }, [load]);
  },
}));

import { CampaignsScreen } from './CampaignsScreen';

const ACCOUNTS = {
  connectedMeta: { id: 'acc-c', platform: 'META', accountId: 'act_1', accountName: 'ميتا المربوط', status: 'CONNECTED' },
  manualMeta: { id: 'acc-m-meta', platform: 'META', accountId: 'manual-aaaaaaaa', accountName: 'ميتا اليدوي', status: 'MANUAL' },
  manualTiktok: { id: 'acc-m-tt', platform: 'TIKTOK', accountId: 'manual-bbbbbbbb', accountName: 'تيك توك اليدوي', status: 'MANUAL' },
};

const campaign = (over: Record<string, unknown> = {}) => ({
  id: 'c-1', name: 'حملة الصيف', platform: 'META', code: 'ABC123', status: 'ACTIVE',
  spendSource: 'MANUAL', adAccount: null, externalId: null, lastSyncAt: null,
  startDate: '2026-10-01T00:00:00.000Z', endDate: null, notes: null,
  landingPage: null, product: null, productId: null,
  link: 'https://shop.example/?c=ABC123', ranInWindow: true,
  funnel: { brought: 0, confirmed: 0, rejected: 0, delivered: 0, returned: 0, confirmationRate: null, deliveryRate: null },
  money: { spend: 100, revenue: 0, net: -100, roas: null, costPerDelivered: null, costPerOrder: null },
  ...over,
});

let payload: { campaigns: unknown[]; adAccounts: unknown[] };
const fetchCalls: { url: string; method: string; body: unknown }[] = [];

const fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
  const method = init?.method ?? 'GET';
  fetchCalls.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined });
  if (url.startsWith('/api/growth/campaigns?')) {
    return {
      ok: true,
      json: async () => ({
        campaigns: payload.campaigns,
        totals: { spend: 0, revenue: 0, net: 0, roas: null, costPerDelivered: null, costPerOrder: null, brought: 0, delivered: 0 },
        currency: 'USD',
        adAccounts: payload.adAccounts,
        definitions: {},
      }),
    };
  }
  if (url === '/api/landing-pages') return { ok: true, json: async () => ({ pages: [] }) };
  if (url === '/api/growth/campaigns' && method === 'POST') return { ok: true, json: async () => ({ success: true, campaign: { id: 'new-1' } }) };
  if (url.startsWith('/api/growth/campaigns/') && method === 'PATCH') return { ok: true, json: async () => ({ success: true }) };
  throw new Error(`unexpected fetch ${method} ${url}`);
});

beforeEach(() => {
  payload = { campaigns: [], adAccounts: [] };
  fetchCalls.length = 0;
  vi.stubGlobal('fetch', fetchMock);
  // The products list the editor loads, and (by URL) the filing call.
  apiJson.mockImplementation(async (url: string) => (url.startsWith('/api/products') ? { products: [] } : { success: true }));
  confirmFn.mockResolvedValue(true);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const mount = async () => {
  render(<CampaignsScreen />);
  await waitFor(() => expect(fetchCalls.some((c) => c.url.startsWith('/api/growth/campaigns?'))).toBe(true));
  await act(async () => {});
};
const openNew = async () => {
  await act(async () => {
    fireEvent.click(screen.getAllByRole('button', { name: /حملة جديدة/ })[0]);
  });
};
const fieldSelect = (label: string) => screen.getByText(label).parentElement!.querySelector('select') as HTMLSelectElement;
const optionTexts = (select: HTMLSelectElement) => Array.from(select.options).map((o) => o.textContent);
const linkCalls = () => apiJson.mock.calls.filter(([u]) => String(u).startsWith('/api/growth/campaigns/'));

describe('the buttons that call a platform need a platform', () => {
  it('— a connected account brings «اسحب الحملات» and «اسحب الإنفاق»', async () => {
    payload = { campaigns: [campaign()], adAccounts: [ACCOUNTS.connectedMeta] };
    await mount();
    expect(await screen.findByText('اسحب الحملات')).toBeTruthy();
    expect(screen.getByText('اسحب الإنفاق')).toBeTruthy();
    // …and each row offers «اربط».
    expect(screen.getByText('اربط')).toBeTruthy();
  });

  it('and a manual account alone does not — there is nothing to call', async () => {
    payload = { campaigns: [campaign()], adAccounts: [ACCOUNTS.manualMeta, ACCOUNTS.manualTiktok] };
    await mount();
    await screen.findByText('حملة الصيف');
    expect(screen.queryByText('اسحب الحملات')).toBeNull();
    expect(screen.queryByText('اسحب الإنفاق')).toBeNull();
    expect(screen.queryByText('اربط')).toBeNull();
  });

  it('and with both kinds the buttons are there, because one of them can answer', async () => {
    payload = { campaigns: [campaign()], adAccounts: [ACCOUNTS.manualMeta, ACCOUNTS.connectedMeta] };
    await mount();
    expect(await screen.findByText('اسحب الإنفاق')).toBeTruthy();
  });

  it('and with none at all, neither', async () => {
    payload = { campaigns: [campaign()], adAccounts: [] };
    await mount();
    await screen.findByText('حملة الصيف');
    expect(screen.queryByText('اسحب الإنفاق')).toBeNull();
  });
});

describe('a row says which account it is filed under', () => {
  it('— by the account’s name', async () => {
    payload = {
      campaigns: [campaign({ adAccount: { id: 'acc-m-meta', accountName: 'ميتا اليدوي', accountId: 'manual-aaaaaaaa', status: 'MANUAL' } })],
      adAccounts: [ACCOUNTS.manualMeta],
    };
    await mount();
    expect(await screen.findByText(/الحساب ميتا اليدوي/)).toBeTruthy();
  });

  it('and says nothing about an account when there is none', async () => {
    payload = { campaigns: [campaign()], adAccounts: [ACCOUNTS.manualMeta] };
    await mount();
    await screen.findByText('حملة الصيف');
    expect(screen.queryByText(/الحساب /)).toBeNull();
  });
});

describe('the editor offers the manual accounts of the campaign’s own platform', () => {
  beforeEach(() => {
    payload = { campaigns: [], adAccounts: [ACCOUNTS.manualMeta, ACCOUNTS.manualTiktok, ACCOUNTS.connectedMeta] };
  });

  it('— Meta’s, for a Meta campaign, with «بلا حساب» first; never a connected one, never another platform’s', async () => {
    await mount();
    await openNew();
    const select = fieldSelect('الحساب الإعلاني');
    expect(optionTexts(select)).toEqual(['بلا حساب', 'ميتا اليدوي']);
  });

  it('and follows the platform when the seller changes it', async () => {
    await mount();
    await openNew();
    await act(async () => {
      fireEvent.change(fieldSelect('المنصّة'), { target: { value: 'TIKTOK' } });
    });
    expect(optionTexts(fieldSelect('الحساب الإعلاني'))).toEqual(['بلا حساب', 'تيك توك اليدوي']);
  });

  it('and is not drawn at all when there is nothing to choose — a select with one «بلا حساب» is clutter', async () => {
    await mount();
    await openNew();
    await act(async () => {
      fireEvent.change(fieldSelect('المنصّة'), { target: { value: 'GOOGLE' } });
    });
    expect(screen.queryByText('الحساب الإعلاني')).toBeNull();
  });

  it('and is not drawn when the only accounts are connected ones', async () => {
    payload = { campaigns: [], adAccounts: [ACCOUNTS.connectedMeta] };
    await mount();
    await openNew();
    expect(screen.queryByText('الحساب الإعلاني')).toBeNull();
  });
});

describe('saving files the campaign after it is saved', () => {
  const fillAndSave = async (account?: string) => {
    await mount();
    await openNew();
    fireEvent.change(screen.getByPlaceholderText(/عرض رمضان/), { target: { value: 'حملة جديدة تماماً' } });
    if (account) {
      await act(async () => {
        fireEvent.change(fieldSelect('الحساب الإعلاني'), { target: { value: account } });
      });
    }
    await act(async () => {
      fireEvent.click(screen.getByText('أنشئ الحملة'));
    });
  };

  beforeEach(() => {
    payload = { campaigns: [], adAccounts: [ACCOUNTS.manualMeta] };
  });

  it('— a new campaign: created first, then filed under the account that was chosen', async () => {
    await fillAndSave('acc-m-meta');
    const create = fetchCalls.find((c) => c.method === 'POST' && c.url === '/api/growth/campaigns')!;
    expect(create, 'ما انحفظت الحملة').toBeTruthy();
    // The body of the create has no account: the link is its own request, as on the server.
    expect(JSON.stringify(create.body)).not.toContain('adAccountId');
    await waitFor(() => expect(linkCalls()).toHaveLength(1));
    const [url, init] = linkCalls()[0];
    expect(url).toBe('/api/growth/campaigns/new-1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ adAccountId: 'acc-m-meta', externalId: null });
  });

  it('and no account chosen means no second request', async () => {
    await fillAndSave();
    await waitFor(() => expect(fetchCalls.some((c) => c.method === 'POST')).toBe(true));
    expect(linkCalls()).toHaveLength(0);
  });

  it('and when the filing fails the campaign is still saved, the editor closes, and the screen says what did not happen', async () => {
    apiJson.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/products')) return { products: [] };
      throw new Error('منصة الحساب غير منصة الحملة');
    });
    await fillAndSave('acc-m-meta');
    expect(await screen.findByText('حُفظت الحملة، لكن تعذّر نسبتها إلى الحساب: منصة الحساب غير منصة الحملة')).toBeTruthy();
    // Closed — a second press of «أنشئ الحملة» would have created it twice.
    expect(screen.queryByText('أنشئ الحملة')).toBeNull();
    expect(fetchCalls.filter((c) => c.method === 'POST' && c.url === '/api/growth/campaigns')).toHaveLength(1);
  });
});

describe('editing a campaign', () => {
  const filed = campaign({
    adAccount: { id: 'acc-m-meta', accountName: 'ميتا اليدوي', accountId: 'manual-aaaaaaaa', status: 'MANUAL' },
  });
  const openEdit = async () => {
    await mount();
    await act(async () => {
      fireEvent.click(await screen.findByLabelText('تعديل'));
    });
  };

  it('— shows the account it is filed under as the chosen one', async () => {
    payload = { campaigns: [filed], adAccounts: [ACCOUNTS.manualMeta] };
    await openEdit();
    expect(fieldSelect('الحساب الإعلاني').value).toBe('acc-m-meta');
  });

  it('and a rename alone does not re-file it', async () => {
    payload = { campaigns: [filed], adAccounts: [ACCOUNTS.manualMeta] };
    await openEdit();
    fireEvent.change(screen.getByPlaceholderText(/عرض رمضان/), { target: { value: 'اسم جديد' } });
    await act(async () => {
      fireEvent.click(screen.getByText('احفظ'));
    });
    await waitFor(() => expect(fetchCalls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(linkCalls()).toHaveLength(0);
  });

  it('and choosing «بلا حساب» un-files it', async () => {
    payload = { campaigns: [filed], adAccounts: [ACCOUNTS.manualMeta] };
    await openEdit();
    await act(async () => {
      fireEvent.change(fieldSelect('الحساب الإعلاني'), { target: { value: '' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByText('احفظ'));
    });
    await waitFor(() => expect(linkCalls()).toHaveLength(1));
    expect(JSON.parse(linkCalls()[0][1].body)).toEqual({ adAccountId: null, externalId: null });
    expect(linkCalls()[0][0]).toBe('/api/growth/campaigns/c-1');
  });

  it('and a campaign filed under a CONNECTED account is left to «اربط» — no select, no filing call', async () => {
    payload = {
      campaigns: [campaign({
        spendSource: 'SYNCED', externalId: 'ext-1',
        adAccount: { id: 'acc-c', accountName: 'ميتا المربوط', accountId: 'act_1', status: 'CONNECTED' },
      })],
      adAccounts: [ACCOUNTS.connectedMeta, ACCOUNTS.manualMeta],
    };
    await openEdit();
    expect(screen.queryByText('الحساب الإعلاني')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByText('احفظ'));
    });
    await waitFor(() => expect(fetchCalls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(linkCalls()).toHaveLength(0);
  });
});
