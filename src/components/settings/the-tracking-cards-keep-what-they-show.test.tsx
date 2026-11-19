// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «بكسل الإعلانات» KEEPS EVERY CONTROL ITS THREE CARDS HAD WHEN THEY MOVED ONTO THE KIT (R15e, 18/11)
 *
 * Written and measured against osm/main BEFORE the cards changed, then kept green after: the same fixture, the same
 * presses, the same number of things to press, fields, ticks and links at every step — the pixels (who may edit and
 * who may only look), the conversions (not linked yet, linked with a conversion, the add form open, the how-to open)
 * and the ad accounts (both ways in, the how-to, read-only).
 *
 * «Things to press» are counted by what a person can press, whatever role the kit gives it: a button, a tab, or one
 * choice of a segmented pair (the kit draws those as radios).
 * ═══════════════════════════════════════════════════════════════════════
 */

const { who } = vi.hoisted(() => ({ who: { permissions: [] as string[] } }));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ currentUser: { id: 'u1', role: 'STAFF', status: 'ACTIVE', permissions: who.permissions } }),
}));
vi.mock('@/lib/api-client', () => ({ apiJson: vi.fn(async () => ({})) }));

import { TrackingPixelsSection } from './TrackingPixelsSection';
import { CustomConversionsCard } from './CustomConversionsCard';
import { AdAccountsCard } from './AdAccountsCard';
import { ConfirmProvider } from '@/components/ui/Confirm';
import { ToastProvider } from '@/components/ui/Toast';

const PIXELS = [
  {
    id: 'p1', platform: 'META', name: 'Main', pixelId: '123456789012345', enabled: true, scope: 'GLOBAL', createdAt: '',
    storeId: null, countryId: null, orderEvent: 'Purchase', sendViewContent: true, sendInitiateCheckout: false,
    capiTokenHint: null as string | null, capiTestCode: null, capiDatasetId: null,
  },
  {
    id: 'p2', platform: 'META', name: 'Second', pixelId: '222222222222222', enabled: false, scope: 'LANDING_PAGES', createdAt: '',
    storeId: 's1', countryId: null, orderEvent: 'Lead', sendViewContent: false, sendInitiateCheckout: true,
    capiTokenHint: null as string | null, capiTestCode: null, capiDatasetId: null,
  },
];
const CONVERSION = {
  id: 'c1', name: 'شراء موصَّل', eventName: 'OrderDelivered', trigger: 'order.delivered', valueSource: 'COLLECTED_AMOUNT', enabled: true,
  pixel: { id: 'p1', name: 'Main', pixelId: '123456789012345', capiTokenHint: '9f3a' },
  stats: { sent: 4, pending: 1, failed: 1, skipped: 0, matchQuality: 0.3 },
};
const OPTIONS = {
  triggers: [
    { value: 'order.confirmed', label: 'عند التأكيد', hint: 'تلميح', suggested: 'OrderConfirmed' },
    { value: 'order.delivered', label: 'عند الاستلام', hint: 'تلميح', suggested: 'OrderDelivered' },
  ],
  valueSources: [{ value: 'ORDER_TOTAL', label: 'قيمة الطلب' }, { value: 'COLLECTED_AMOUNT', label: 'المحصَّل' }],
};
const PLATFORM = (platform: string, short: string, oauth: boolean) => ({
  platform, label: short, short,
  fields: [{ key: 'token', label: 'رمز الوصول', secret: true, placeholder: 'EAAB' }],
  help: { url: 'https://example.com', urlLabel: 'مدير الإعلانات', steps: ['خطوة', 'خطوة تانية'] },
  oauth: oauth ? { available: true } : { available: false, envKeys: ['A_ID', 'A_SECRET'], register: { url: 'https://example.com/r', note: 'ملاحظة' } },
});
const ACCOUNTS = [
  { id: 'a1', platform: 'META', accountId: 'act_1234567890', accountName: 'حساب ميتا', tokenHint: '9f3a', status: 'CONNECTED', lastError: null, lastSyncAt: null, _count: { campaigns: 2 } },
  { id: 'a2', platform: 'TIKTOK', accountId: 'manual-1a2b', accountName: 'تيك توك يدوي', tokenHint: null, status: 'MANUAL', lastError: null, lastSyncAt: null, _count: { campaigns: 1 } },
  { id: 'a3', platform: 'META', accountId: 'act_9', accountName: 'معطّل', tokenHint: '1111', status: 'ERROR', lastError: 'انتهى الرمز', lastSyncAt: null, _count: { campaigns: 0 } },
];

const state = { linked: false, conversions: [] as unknown[] };

beforeEach(() => {
  who.permissions = ['settings.view', 'settings.tracking', 'settings.manage'];
  state.linked = false;
  state.conversions = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/settings/tracking-pixels') {
        const pixels = PIXELS.map((p, i) => ({ ...p, capiTokenHint: state.linked && i === 0 ? '9f3a' : null }));
        return { ok: true, status: 200, json: async () => ({ pixels, stores: [{ id: 's1', name: 'متجر', countryId: 'k1' }], countries: [{ id: 'k1', name: 'سوريا' }] }) };
      }
      if (url === '/api/settings/conversions') return { ok: true, status: 200, json: async () => ({ conversions: state.conversions, options: OPTIONS }) };
      if (url === '/api/settings/ad-accounts') {
        return { ok: true, status: 200, json: async () => ({ accounts: ACCOUNTS, platforms: [PLATFORM('META', 'ميتا', true), PLATFORM('TIKTOK', 'تيك توك', false)] }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    })
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const wrap = (node: React.ReactNode) =>
  render(
    <ToastProvider>
      <ConfirmProvider>{node}</ConfirmProvider>
    </ToastProvider>
  );

/** What a person can press, fill, tick and follow — by what it is, not by which part of the kit drew it. */
function census() {
  const presses =
    screen.queryAllByRole('button').length + screen.queryAllByRole('tab').length + screen.queryAllByRole('radio').length;
  const fields = document.querySelectorAll('input:not([type="checkbox"]), select, textarea').length;
  const ticks = document.querySelectorAll('input[type="checkbox"]').length;
  const links = document.querySelectorAll('a[href]').length;
  return { presses, fields, ticks, links };
}

const press = async (el: HTMLElement) => {
  await act(async () => {
    fireEvent.click(el);
  });
};

describe('the pixels', () => {
  it('— who may edit: four platforms, two rows, the add form', async () => {
    wrap(<TrackingPixelsSection />);
    await screen.findAllByTestId('pixel-row');
    expect(screen.getAllByTestId('pixel-row')).toHaveLength(2);
    expect(census()).toEqual({ presses: 11, fields: 9, ticks: 4, links: 0 });
  });

  it('— who may only look: the platforms, nothing to change', async () => {
    who.permissions = ['settings.view'];
    wrap(<TrackingPixelsSection />);
    await screen.findAllByTestId('pixel-row');
    expect(census()).toEqual({ presses: 4, fields: 6, ticks: 4, links: 0 });
  });
});

describe('the conversions', () => {
  it('— not linked yet: the token, the dataset, «اربط», the how-to', async () => {
    wrap(<CustomConversionsCard />);
    await screen.findByText('رمز واجهة التحويلات');
    expect(census()).toEqual({ presses: 5, fields: 3, ticks: 0, links: 0 });
  });

  it('— linked, with one conversion: the test code, the dataset, the row, «أضف تحويلاً»', async () => {
    state.linked = true;
    state.conversions = [CONVERSION];
    wrap(<CustomConversionsCard />);
    await screen.findByText('واجهة التحويلات مربوطة');
    expect(census()).toEqual({ presses: 7, fields: 3, ticks: 0, links: 0 });
  });

  it('— the add form open, a moment chosen, and the how-to open', async () => {
    state.linked = true;
    state.conversions = [CONVERSION];
    wrap(<CustomConversionsCard />);
    await screen.findByText('واجهة التحويلات مربوطة');
    await press(screen.getByText('أضف تحويلاً'));
    await press(screen.getByText('عند التأكيد'));
    await press(screen.getByText('كيف أُشغّلها؟'));
    expect(census()).toEqual({ presses: 10, fields: 6, ticks: 0, links: 1 });
  });
});

describe('the ad accounts', () => {
  it('— the automatic way, with three accounts listed', async () => {
    wrap(<AdAccountsCard storeName="المتجر" />);
    await screen.findByText('حساب ميتا');
    expect(census()).toEqual({ presses: 12, fields: 2, ticks: 0, links: 1 });
  });

  it('— the other platform (no sign-in app) and the how-to open', async () => {
    wrap(<AdAccountsCard storeName="المتجر" />);
    await screen.findByText('حساب ميتا');
    await press(screen.getAllByText('تيك توك').find((el) => el.tagName === 'BUTTON')!);
    await press(screen.getByText(/من أين أحصل على بيانات/));
    expect(census()).toEqual({ presses: 12, fields: 2, ticks: 0, links: 2 });
  });

  it('— the manual way', async () => {
    wrap(<AdAccountsCard storeName="المتجر" />);
    await screen.findByText('حساب ميتا');
    await press(screen.getByText('إدخال يدوي بالكامل'));
    expect(census()).toEqual({ presses: 10, fields: 2, ticks: 0, links: 0 });
  });

  it('— who may only look: the list, nothing to change', async () => {
    who.permissions = ['settings.view'];
    wrap(<AdAccountsCard storeName="المتجر" />);
    await screen.findByText('حساب ميتا');
    expect(census()).toEqual({ presses: 1, fields: 0, ticks: 0, links: 0 });
  });
});
