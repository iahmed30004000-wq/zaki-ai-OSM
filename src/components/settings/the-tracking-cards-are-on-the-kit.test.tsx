// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «بكسل الإعلانات» ON THE KIT (R15e, 18/11)
 *
 * The page is drawn by the frame, and its three cards — the pixels, the conversions, the ad accounts — are built from
 * the kit's parts. What must not move while the parts change: every tick and every on/off press sends the value the
 * person chose (never its opposite), the edit presses stay with who may edit, every secret field is empty when the card
 * opens and stays empty after a platform switch, the kit's buttons never submit a form by accident, and nothing is
 * wider than a phone.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { who, apiJson } = vi.hoisted(() => ({ who: { permissions: [] as string[] }, apiJson: vi.fn(async () => ({})) }));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ currentUser: { id: 'u1', role: 'STAFF', status: 'ACTIVE', permissions: who.permissions } }),
}));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => (apiJson as (...b: unknown[]) => unknown)(...a) }));

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
    storeId: null, countryId: null, orderEvent: 'Lead', sendViewContent: false, sendInitiateCheckout: true,
    capiTokenHint: null as string | null, capiTestCode: null, capiDatasetId: null,
  },
];
const CONVERSION = {
  id: 'c1', name: 'شراء موصَّل', eventName: 'OrderDelivered', trigger: 'order.delivered', valueSource: 'COLLECTED_AMOUNT', enabled: true,
  pixel: { id: 'p1', name: 'Main', pixelId: '123456789012345', capiTokenHint: '9f3a' },
  stats: { sent: 4, pending: 0, failed: 0, skipped: 0, matchQuality: 0.9 },
};
const OPTIONS = {
  triggers: [{ value: 'order.delivered', label: 'عند الاستلام', hint: 'تلميح', suggested: 'OrderDelivered' }],
  valueSources: [{ value: 'ORDER_TOTAL', label: 'قيمة الطلب' }, { value: 'COLLECTED_AMOUNT', label: 'المحصَّل' }],
};
const PLATFORM = (platform: string, short: string) => ({
  platform, label: short, short,
  fields: [{ key: 'token', label: 'رمز الوصول', secret: true, placeholder: 'EAAB' }],
  help: { url: 'https://example.com', urlLabel: 'مدير الإعلانات', steps: ['خطوة'] },
  oauth: { available: true },
});
const ACCOUNTS = [
  { id: 'a1', platform: 'META', accountId: 'act_1234567890', accountName: 'حساب ميتا', tokenHint: '9f3a', status: 'CONNECTED', lastError: null, lastSyncAt: null, _count: { campaigns: 2 } },
];

const state = { linked: false, conversions: [] as unknown[] };
let calls: { url: string; init?: RequestInit }[] = [];

beforeEach(() => {
  who.permissions = ['settings.view', 'settings.tracking', 'settings.manage'];
  state.linked = false;
  state.conversions = [];
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === '/api/settings/tracking-pixels' && !init?.method) {
        const pixels = PIXELS.map((p, i) => ({ ...p, capiTokenHint: state.linked && i === 0 ? '9f3a' : null }));
        return { ok: true, status: 200, json: async () => ({ pixels, stores: [], countries: [] }) };
      }
      if (url === '/api/settings/conversions' && !init?.method) {
        return { ok: true, status: 200, json: async () => ({ conversions: state.conversions, options: OPTIONS }) };
      }
      if (url === '/api/settings/ad-accounts' && !init?.method) {
        return { ok: true, status: 200, json: async () => ({ accounts: ACCOUNTS, platforms: [PLATFORM('META', 'ميتا'), PLATFORM('TIKTOK', 'تيك توك')] }) };
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
const press = async (el: Element) => {
  await act(async () => {
    fireEvent.click(el);
  });
};
const bodyOf = (url: string) => {
  const sent = calls.filter((c) => c.url === url && c.init?.method);
  return sent.length ? JSON.parse(String(sent[sent.length - 1].init?.body)) : null;
};
const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

describe('the page', () => {
  it('— is drawn by the frame, titled from the registry, and draws the three cards', () => {
    const src = read('src/app/(system)/(shell)/settings/tracking/page.tsx');
    expect(src).toMatch(/<PageShell\s+title=\{routeLabel\('\/settings\/tracking'\)\}/);
    expect(src).not.toMatch(/<PageHeader\b/);
    for (const card of ['<TrackingPixelsSection', '<CustomConversionsCard', '<AdAccountsCard storeName={store.name}']) expect(src).toContain(card);
  });

  it('and the pixels card draws no second h1 under the frame’s, with the same name as a heading of its own', async () => {
    wrap(<TrackingPixelsSection />);
    await screen.findAllByTestId('pixel-row');
    expect(screen.queryAllByRole('heading', { level: 1 })).toHaveLength(0);
    expect(screen.getByRole('heading', { level: 2, name: 'بكسل الإعلانات' })).toBeTruthy();
    // The anchor a link may point at stays.
    expect(document.getElementById('tracking')).toBeTruthy();
  });
});

describe('the pixels', () => {
  it('— each tick sends what was chosen, not its opposite, for that row only', async () => {
    wrap(<TrackingPixelsSection />);
    await screen.findAllByTestId('pixel-row');
    const [first, second] = screen.getAllByTestId('pixel-row');
    const seen = within(first).getByLabelText('مشاهدة المنتج') as HTMLInputElement;
    expect(seen.checked).toBe(true);
    await press(seen);
    expect(bodyOf('/api/settings/tracking-pixels/p1')).toEqual({ sendViewContent: false });
    const started = within(second).getByLabelText('بدء الطلب') as HTMLInputElement;
    expect(started.checked).toBe(true);
    await press(within(second).getByLabelText('مشاهدة المنتج'));
    expect(bodyOf('/api/settings/tracking-pixels/p2')).toEqual({ sendViewContent: true });
  });

  it('and each row’s ticks have ids of their own (the same two names repeat on every row)', async () => {
    wrap(<TrackingPixelsSection />);
    await screen.findAllByTestId('pixel-row');
    const ids = [...document.querySelectorAll('input[type="checkbox"]')].map((b) => b.id);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
  });

  it('and «تعطيل» / «تفعيل» sends the other state of THAT pixel', async () => {
    wrap(<TrackingPixelsSection />);
    await screen.findAllByTestId('pixel-row');
    const [first, second] = screen.getAllByTestId('pixel-row');
    await press(within(first).getByRole('button', { name: 'تعطيل' }));
    expect(bodyOf('/api/settings/tracking-pixels/p1')).toEqual({ enabled: false });
    await press(within(second).getByRole('button', { name: 'تفعيل' }));
    expect(bodyOf('/api/settings/tracking-pixels/p2')).toEqual({ enabled: true });
  });

  it('and the two icon presses keep their names', async () => {
    wrap(<TrackingPixelsSection />);
    await screen.findAllByTestId('pixel-row');
    const [first] = screen.getAllByTestId('pixel-row');
    expect(within(first).getByRole('button', { name: 'تعديل الاسم' })).toBeTruthy();
    expect(within(first).getByRole('button', { name: 'حذف' })).toBeTruthy();
  });

  it('and the chosen platform is the one marked, a press moves the mark', async () => {
    wrap(<TrackingPixelsSection />);
    await screen.findAllByTestId('pixel-row');
    expect(screen.getByTestId('platform-META').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('platform-GOOGLE').getAttribute('aria-selected')).toBe('false');
    await press(screen.getByTestId('platform-GOOGLE'));
    expect(screen.getByTestId('platform-GOOGLE').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('platform-META').getAttribute('aria-selected')).toBe('false');
  });

  it('and in the add form only «أضف» submits; the platform presses outside it never do', async () => {
    wrap(<TrackingPixelsSection />);
    await screen.findAllByTestId('pixel-row');
    const form = screen.getByLabelText('رقم بكسل Meta').closest('form')!;
    const buttons = [...form.querySelectorAll('button')];
    expect(buttons.map((b) => b.getAttribute('type'))).toEqual(['submit']);
    for (const b of document.querySelectorAll('button')) expect(b.getAttribute('type'), b.textContent ?? '').toBeTruthy();
  });

  it('NEGATIVE: who may only look gets the ticks locked and no press that writes', async () => {
    who.permissions = ['settings.view'];
    wrap(<TrackingPixelsSection />);
    await screen.findAllByTestId('pixel-row');
    for (const b of document.querySelectorAll('input[type="checkbox"]')) expect((b as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'تعطيل' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'تفعيل' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'تعديل الاسم' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'حذف' })).toBeNull();
    expect(screen.queryByLabelText(/رقم بكسل/)).toBeNull();
  });
});

describe('the conversions', () => {
  it('— the token field is empty when the card opens, and a linked pixel shows only the end of its token', async () => {
    wrap(<CustomConversionsCard />);
    await screen.findByText('رمز واجهة التحويلات');
    const secret = document.querySelector('input[type="password"]') as HTMLInputElement;
    expect(secret).toBeTruthy();
    expect(secret.value).toBe('');
    cleanup();

    state.linked = true;
    wrap(<CustomConversionsCard />);
    await screen.findByText('واجهة التحويلات مربوطة');
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(screen.getByText('••••9f3a')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'فصل' })).toBeTruthy();
  });

  it('and «اربط» sends the token once and empties the field', async () => {
    wrap(<CustomConversionsCard />);
    await screen.findByText('رمز واجهة التحويلات');
    const secret = document.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.change(secret, { target: { value: 'EAAG' + 'x'.repeat(30) } });
    await press(screen.getByRole('button', { name: /اربط/ }));
    expect(bodyOf('/api/settings/tracking-pixels/p1/capi')).toEqual({ token: 'EAAG' + 'x'.repeat(30) });
    expect((document.querySelector('input[type="password"]') as HTMLInputElement).value).toBe('');
  });

  it('and «أوقف» / «شغّل» sends the other state of that conversion', async () => {
    state.linked = true;
    state.conversions = [CONVERSION];
    wrap(<CustomConversionsCard />);
    await screen.findByText('واجهة التحويلات مربوطة');
    await press(screen.getByRole('button', { name: 'أوقف' }));
    expect(bodyOf('/api/settings/conversions/c1')).toEqual({ enabled: false });
  });

  it('and the test code is saved as typed', async () => {
    state.linked = true;
    wrap(<CustomConversionsCard />);
    await screen.findByText('واجهة التحويلات مربوطة');
    fireEvent.change(screen.getByPlaceholderText('TEST12345'), { target: { value: 'TEST777' } });
    await press(screen.getAllByRole('button', { name: 'حفظ' })[0]);
    expect(bodyOf('/api/settings/tracking-pixels/p1/capi')).toEqual({ testCode: 'TEST777' });
  });

  it('and «كيف أُشغّلها؟» says whether it is open', async () => {
    wrap(<CustomConversionsCard />);
    await screen.findByText('رمز واجهة التحويلات');
    const how = screen.getByRole('button', { name: /كيف أُشغّلها/ });
    expect(how.getAttribute('aria-expanded')).toBe('false');
    await press(how);
    expect(how.getAttribute('aria-expanded')).toBe('true');
  });
});

describe('the ad accounts', () => {
  it('— the secret field is empty when the card opens, and a platform switch empties it again', async () => {
    wrap(<AdAccountsCard storeName="المتجر" />);
    await screen.findByText('حساب ميتا');
    const secret = () => document.querySelector('input[type="password"]') as HTMLInputElement;
    expect(secret().value).toBe('');
    fireEvent.change(secret(), { target: { value: 'secret-typed-here' } });
    expect(secret().value).toBe('secret-typed-here');
    await press(screen.getByRole('radio', { name: 'تيك توك' }));
    expect(screen.getByRole('radio', { name: 'تيك توك' }).getAttribute('aria-checked')).toBe('true');
    expect(secret().value).toBe('');
    // …and the token's end is all the list ever shows.
    expect(screen.getByText(/act_1234567890 · ••••9f3a/)).toBeTruthy();
  });

  it('and pressing the platform already chosen empties the typed secret too, as the old tabs did', async () => {
    wrap(<AdAccountsCard storeName="المتجر" />);
    await screen.findByText('حساب ميتا');
    const secret = () => document.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.change(secret(), { target: { value: 'secret-typed-here' } });
    await press(screen.getByRole('radio', { name: 'ميتا' }));
    expect(screen.getByRole('radio', { name: 'ميتا' }).getAttribute('aria-checked')).toBe('true');
    expect(secret().value).toBe('');
  });

  it('and «اربط الحساب» stays locked with no token, and after linking the token box is empty', async () => {
    wrap(<AdAccountsCard storeName="المتجر" />);
    await screen.findByText('حساب ميتا');
    const connect = () => screen.getByRole('button', { name: /اربط الحساب/ }) as HTMLButtonElement;
    fireEvent.change(screen.getByPlaceholderText('act_1234567890'), { target: { value: 'act_777777' } });
    expect(connect().disabled).toBe(true);
    await press(connect());
    expect(calls.some((c) => c.url === '/api/settings/ad-accounts' && c.init?.method)).toBe(false);
    fireEvent.change(document.querySelector('input[type="password"]')!, { target: { value: 'tok' } });
    expect(connect().disabled).toBe(false);
    await press(connect());
    expect((document.querySelector('input[type="password"]') as HTMLInputElement).value).toBe('');
  });

  it('and the manual way asks for no secret at all', async () => {
    wrap(<AdAccountsCard storeName="المتجر" />);
    await screen.findByText('حساب ميتا');
    await press(screen.getByRole('radio', { name: 'إدخال يدوي بالكامل' }));
    expect(screen.getByRole('radio', { name: 'إدخال يدوي بالكامل' }).getAttribute('aria-checked')).toBe('true');
    expect(document.querySelectorAll('input[type="password"]')).toHaveLength(0);
  });

  it('and «اربط الحساب» sends the platform, the id and the token as typed', async () => {
    wrap(<AdAccountsCard storeName="المتجر" />);
    await screen.findByText('حساب ميتا');
    fireEvent.change(screen.getByPlaceholderText('act_1234567890'), { target: { value: 'act_777777' } });
    fireEvent.change(document.querySelector('input[type="password"]')!, { target: { value: 'tok' } });
    await press(screen.getByRole('button', { name: /اربط الحساب/ }));
    expect(bodyOf('/api/settings/ad-accounts')).toEqual({ platform: 'META', accountId: 'act_777777', credentials: { token: 'tok' } });
  });

  it('and the how-to says whether it is open', async () => {
    wrap(<AdAccountsCard storeName="المتجر" />);
    await screen.findByText('حساب ميتا');
    const how = screen.getByRole('button', { name: /من أين أحصل على بيانات/ });
    expect(how.getAttribute('aria-expanded')).toBe('false');
    await press(how);
    expect(how.getAttribute('aria-expanded')).toBe('true');
  });

  it('NEGATIVE: who may only look gets neither way in, nor the two row presses', async () => {
    who.permissions = ['settings.view'];
    wrap(<AdAccountsCard storeName="المتجر" />);
    await screen.findByText('حساب ميتا');
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByRole('button', { name: 'فصل' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'حوّله إلى يدوي' })).toBeNull();
    expect(document.querySelectorAll('input')).toHaveLength(0);
  });
});

describe('a phone, 375 px wide', () => {
  it('— nothing in the three cards has a fixed width wider than the screen', async () => {
    state.linked = true;
    state.conversions = [CONVERSION];
    wrap(
      <>
        <TrackingPixelsSection />
        <CustomConversionsCard />
        <AdAccountsCard storeName="المتجر" />
      </>
    );
    await screen.findAllByTestId('pixel-row');
    await screen.findByText('حساب ميتا');
    const wide: string[] = [];
    for (const el of document.querySelectorAll('[class]')) {
      for (const m of String(el.getAttribute('class')).matchAll(/(?:^|\s)(?:min-)?w-\[(\d+)px\]/g)) {
        if (Number(m[1]) > 343) wide.push(m[0]);
      }
    }
    expect(wide).toEqual([]);
    const fixed = [...document.querySelectorAll('[style]')].filter((el) => /width:\s*(\d{4,}|[4-9]\d\d)px/.test(el.getAttribute('style') ?? ''));
    expect(fixed).toEqual([]);
  });
});
