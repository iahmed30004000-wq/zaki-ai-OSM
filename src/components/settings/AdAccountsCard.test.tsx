// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

/**
 * «اوتوماتيك او ادخال يدوي بالكامل. اريد الخيارين» — THE TWO WAYS, ON THE SCREEN.
 *
 * What the owner asked for is something he has to be able to SEE: a choice
 * that lived behind a menu would be a choice most people never learn exists.
 * So the first claim is the plainest one — before anything is pressed, both
 * names are on the card — and the rest are about what each way shows and
 * does, and about the manual one never asking for a secret.
 */

const { apiJson, confirmFn } = vi.hoisted(() => ({ apiJson: vi.fn(), confirmFn: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a) }));
vi.mock('@/components/ui/Confirm', () => ({ useConfirm: () => confirmFn }));
// The buttons ask «الإعدادات الحسّاسة» (RV168): these tests are about what they DO, so the person holds the key.
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ currentUser: { id: 'u0', role: 'COMPANY_ADMIN', permissions: ['settings.manage'], status: 'ACTIVE' } }),
}));

import { AdAccountsCard } from './AdAccountsCard';

const PLATFORM = (platform: string, short: string) => ({
  platform,
  label: short,
  short,
  fields: [{ key: 'token', label: 'رمز الوصول', secret: true, placeholder: 'EAAB…' }],
  help: { url: 'https://example.com', urlLabel: 'مدير الإعلانات', steps: ['خطوة'] },
  oauth: { available: true as const },
});

const CONNECTED = {
  id: 'a1', platform: 'META', accountId: 'act_1234567890', accountName: 'حساب ميتا',
  tokenHint: '9f3a', status: 'CONNECTED', lastError: null, lastSyncAt: null, _count: { campaigns: 2 },
};
const MANUAL_NO_ID = {
  id: 'a2', platform: 'TIKTOK', accountId: 'manual-1a2b3c4d', accountName: 'تيك توك يدوي',
  tokenHint: null, status: 'MANUAL', lastError: null, lastSyncAt: null, _count: { campaigns: 1 },
};
const MANUAL_WITH_ID = {
  id: 'a3', platform: 'META', accountId: 'act_5555555', accountName: 'يدوي برقمه',
  tokenHint: null, status: 'MANUAL', lastError: null, lastSyncAt: null, _count: { campaigns: 0 },
};

let accounts: unknown[] = [];
let listCalls = 0;
const fetchMock = vi.fn(async (url: string, init?: { method?: string }) => {
  if (url === '/api/settings/ad-accounts' && !init?.method) {
    listCalls++;
    return { ok: true, json: async () => ({ accounts, platforms: [PLATFORM('META', 'ميتا'), PLATFORM('TIKTOK', 'تيك توك')] }) };
  }
  if (init?.method === 'DELETE') return { ok: true, json: async () => ({ message: 'تم الحذف' }) };
  throw new Error(`unexpected fetch ${url}`);
});

beforeEach(() => {
  accounts = [];
  listCalls = 0;
  vi.stubGlobal('fetch', fetchMock);
  apiJson.mockResolvedValue({ account: { accountName: 'حسابي' } });
  confirmFn.mockResolvedValue(true);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const mount = async () => {
  render(<AdAccountsCard storeName="المتجر" />);
  await screen.findByRole('button', { name: 'ربط تلقائي' });
};
const chooseManual = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'إدخال يدوي بالكامل' }));
  });
};
const nameField = () => screen.getByPlaceholderText(/مثلاً: حساب/) as HTMLInputElement;
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

describe('the two ways, before anything is pressed', () => {
  it('— both names are on the card, and the automatic one is the one chosen', async () => {
    await mount();
    const auto = screen.getByRole('button', { name: 'ربط تلقائي' });
    const manual = screen.getByRole('button', { name: 'إدخال يدوي بالكامل' });
    expect(auto.getAttribute('aria-pressed')).toBe('true');
    expect(manual.getAttribute('aria-pressed')).toBe('false');
  });

  it('and the automatic way is exactly what it was: the sign-in, the id, the token, «اربط الحساب»', async () => {
    await mount();
    expect(screen.getByText('اربط الحساب')).toBeTruthy();
    expect(screen.getByText('رقم الحساب الإعلاني')).toBeTruthy();
    expect(screen.getByText('رمز الوصول')).toBeTruthy();
    expect(document.querySelectorAll('input[type="password"]')).toHaveLength(1);
    expect(screen.getByText('سجّل الدخول بحساب ميتا')).toBeTruthy();
    // …and the manual form is not on screen yet.
    expect(screen.queryByText('احفظ الحساب اليدوي')).toBeNull();
  });
});

describe('the manual way', () => {
  it('— swaps the form, and never asks for a secret, a sign-in or a platform’s instructions', async () => {
    await mount();
    await chooseManual();
    expect(screen.getByRole('button', { name: 'إدخال يدوي بالكامل' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('احفظ الحساب اليدوي')).toBeTruthy();
    expect(screen.getByText('اسم الحساب')).toBeTruthy();
    expect(screen.getByText(/رقم الحساب الإعلاني \(اختياري\)/)).toBeTruthy();
    // No secret anywhere on the screen.
    expect(document.querySelectorAll('input[type="password"]'), 'حقل سرّي بالنموذج اليدوي').toHaveLength(0);
    expect(screen.queryByText('اربط الحساب')).toBeNull();
    expect(screen.queryByText('رمز الوصول')).toBeNull();
    expect(screen.queryByText(/سجّل الدخول بحساب/)).toBeNull();
    expect(screen.queryByText(/من أين أحصل على بيانات/)).toBeNull();
  });

  it('and says what a manual account is — no connection, the campaigns are typed by hand', async () => {
    await mount();
    await chooseManual();
    expect(screen.getByText(/لا ربط ولا رمز ولا سحب/)).toBeTruthy();
  });

  it('and going back to the automatic way brings its form back', async () => {
    await mount();
    await chooseManual();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'ربط تلقائي' }));
    });
    expect(screen.getByText('اربط الحساب')).toBeTruthy();
    expect(screen.queryByText('احفظ الحساب اليدوي')).toBeNull();
  });

  it('and cannot be saved without a name', async () => {
    await mount();
    await chooseManual();
    const save = screen.getByText('احفظ الحساب اليدوي').closest('button') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    type(nameField(), 'أ');
    expect(save.disabled, 'حرف واحد').toBe(true);
    type(nameField(), 'حسابي');
    expect(save.disabled).toBe(false);
  });

  it('and saves with the platform and the name — and no credentials at all', async () => {
    await mount();
    await chooseManual();
    type(nameField(), '  حسابي  ');
    await act(async () => {
      fireEvent.click(screen.getByText('احفظ الحساب اليدوي'));
    });
    expect(apiJson).toHaveBeenCalledTimes(1);
    const [url, init] = apiJson.mock.calls[0];
    expect(url).toBe('/api/settings/ad-accounts/manual');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body).toEqual({ platform: 'META', accountName: 'حسابي' });
    expect(JSON.stringify(body)).not.toMatch(/credential|token/i);
  });

  it('and sends the platform’s id when the seller has it', async () => {
    await mount();
    await chooseManual();
    type(nameField(), 'حسابي');
    type(screen.getByPlaceholderText('act_1234567890'), ' act_1234567890 ');
    await act(async () => {
      fireEvent.click(screen.getByText('احفظ الحساب اليدوي'));
    });
    expect(JSON.parse(apiJson.mock.calls[0][1].body)).toEqual({
      platform: 'META', accountName: 'حسابي', accountId: 'act_1234567890',
    });
  });

  it('and is for the platform picked in the tabs above it', async () => {
    await mount();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'تيك توك' }));
    });
    await chooseManual();
    type(nameField(), 'حساب تيك توك');
    await act(async () => {
      fireEvent.click(screen.getByText('احفظ الحساب اليدوي'));
    });
    expect(JSON.parse(apiJson.mock.calls[0][1].body).platform).toBe('TIKTOK');
  });

  it('and after saving, clears the form, reloads the list and says what to do next', async () => {
    await mount();
    await chooseManual();
    const before = listCalls;
    type(nameField(), 'حسابي');
    await act(async () => {
      fireEvent.click(screen.getByText('احفظ الحساب اليدوي'));
    });
    await waitFor(() => expect(listCalls).toBe(before + 1));
    expect(nameField().value).toBe('');
    expect(await screen.findByText(/أُضيف «حسابي» كحساب يدوي/)).toBeTruthy();
    expect(screen.getByText(/من شاشة الحملات/)).toBeTruthy();
  });

  it('and shows the server’s own sentence when it refuses (a duplicate, a bad id)', async () => {
    apiJson.mockRejectedValue(new Error('هذا الحساب مضاف يدوياً من قبل.'));
    await mount();
    await chooseManual();
    type(nameField(), 'حسابي');
    await act(async () => {
      fireEvent.click(screen.getByText('احفظ الحساب اليدوي'));
    });
    expect(await screen.findByText('هذا الحساب مضاف يدوياً من قبل.')).toBeTruthy();
    // The name stays, so the seller can correct and press again.
    expect(nameField().value).toBe('حسابي');
  });
});

describe('the list shows which kind each account is', () => {
  const rowOf = (name: string) => screen.getByText(name).closest('div.rounded-lg') as HTMLElement;

  beforeEach(() => {
    accounts = [CONNECTED, MANUAL_NO_ID, MANUAL_WITH_ID];
  });

  it('— a connected one: the badge, the id with the end of its token, and both ways off', async () => {
    await mount();
    const row = await waitFor(() => rowOf('حساب ميتا'));
    expect(within(row).getByText('متصل')).toBeTruthy();
    expect(within(row).getByText(/act_1234567890 · ••••9f3a/)).toBeTruthy();
    expect(within(row).getByText('2 حملة مربوطة')).toBeTruthy();
    expect(within(row).getByLabelText('فصل')).toBeTruthy();
    expect(within(row).getByLabelText('حوّله إلى يدوي')).toBeTruthy();
  });

  it('and a manual one without an id says so, rather than print one this system made up', async () => {
    await mount();
    const row = await waitFor(() => rowOf('تيك توك يدوي'));
    expect(within(row).getByText('يدوي')).toBeTruthy();
    expect(within(row).getByText('بلا رقم من المنصة')).toBeTruthy();
    expect(row.textContent, 'رقم مصنوع ظاهر كأنه من المنصة').not.toContain('manual-');
    expect(within(row).getByText('1 حملة في هذا الحساب')).toBeTruthy();
    expect(row.textContent).not.toContain('••••');
    // «delete», not «disconnect» — it was never connected — and nothing to switch.
    expect(within(row).getByLabelText('احذف')).toBeTruthy();
    expect(within(row).queryByLabelText('فصل')).toBeNull();
    expect(within(row).queryByLabelText('حوّله إلى يدوي')).toBeNull();
  });

  it('and a manual one that was given its id shows it', async () => {
    await mount();
    const row = await waitFor(() => rowOf('يدوي برقمه'));
    expect(within(row).getByText('act_5555555')).toBeTruthy();
    expect(row.textContent).not.toContain('بلا رقم');
    expect(row.textContent).not.toContain('••••');
  });
});

describe('switching a connected account to manual', () => {
  beforeEach(() => {
    accounts = [CONNECTED];
  });
  const switchIt = async () => {
    await mount();
    const row = (await screen.findByText('حساب ميتا')).closest('div.rounded-lg') as HTMLElement;
    await act(async () => {
      fireEvent.click(within(row).getByLabelText('حوّله إلى يدوي'));
    });
  };

  it('— asks first, and says the token goes and the campaigns stay', async () => {
    await switchIt();
    expect(confirmFn).toHaveBeenCalledTimes(1);
    const ask = confirmFn.mock.calls[0][0];
    expect(ask.title).toBe('تحويل «حساب ميتا» إلى يدوي؟');
    expect(ask.body).toContain('سيُحذف الرمز المحفوظ');
    expect(ask.body).toContain('2 حملة تبقى في الحساب');
    expect(ask.body).toContain('مصروف حقيقي');
  });

  it('and on yes sends the switch, reloads, and shows what the server said', async () => {
    apiJson.mockResolvedValue({ message: 'صار الحساب يدوياً: حُذف الرمز، و2 حملة باقية فيه.' });
    const before = listCalls;
    await switchIt();
    expect(apiJson).toHaveBeenCalledTimes(1);
    const [url, init] = apiJson.mock.calls[0];
    expect(url).toBe('/api/settings/ad-accounts/a1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ mode: 'MANUAL' });
    await waitFor(() => expect(listCalls).toBeGreaterThan(before));
    expect(await screen.findByText(/صار الحساب يدوياً/)).toBeTruthy();
  });

  it('and on no sends nothing', async () => {
    confirmFn.mockResolvedValue(false);
    await switchIt();
    expect(apiJson).not.toHaveBeenCalled();
  });

  it('and a refusal is shown, not swallowed', async () => {
    apiJson.mockRejectedValue(new Error('الحساب غير موجود'));
    await switchIt();
    expect(await screen.findByText('الحساب غير موجود')).toBeTruthy();
  });
});

describe('removing an account says which kind it is removing', () => {
  it('— «فصل» for a connected one, «حذف» for a manual one', async () => {
    accounts = [CONNECTED, MANUAL_NO_ID];
    await mount();
    const connected = (await screen.findByText('حساب ميتا')).closest('div.rounded-lg') as HTMLElement;
    await act(async () => {
      fireEvent.click(within(connected).getByLabelText('فصل'));
    });
    expect(confirmFn.mock.calls[0][0]).toMatchObject({ title: 'فصل «حساب ميتا»؟', confirmLabel: 'افصل' });

    const manual = screen.getByText('تيك توك يدوي').closest('div.rounded-lg') as HTMLElement;
    await act(async () => {
      fireEvent.click(within(manual).getByLabelText('احذف'));
    });
    const ask = confirmFn.mock.calls[1][0];
    expect(ask).toMatchObject({ title: 'حذف «تيك توك يدوي»؟', confirmLabel: 'احذف' });
    expect(ask.body, 'حساب يدوي ما انفصل').not.toContain('إدخال الإنفاق يدوياً');
    expect(ask.body).toContain('1 حملة ستبقى بلا حساب');
  });
});
