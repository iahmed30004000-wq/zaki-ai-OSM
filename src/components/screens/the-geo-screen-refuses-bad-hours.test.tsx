// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { WORK_HOURS_ORDER_MESSAGE } from '@/lib/work-hours';

/**
 * THE SETTINGS PAGE REFUSES A WORKING DAY THAT ENDS BEFORE IT STARTS.
 *
 * Planner ruling 18: no night shift. DoD (see work-hours.test.ts): the screen
 * shows the Arabic message, keeps the previous value (the field goes back),
 * and says it out loud — never a silent failure. A valid change is saved and
 * the field keeps it. The route is the real judge: when the screen's own
 * check lets something through and the route refuses, the message is the
 * route's and the field goes back just the same.
 */

const { api, user } = vi.hoisted(() => ({ api: vi.fn(), user: { current: null as unknown } }));

vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a) }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => '/settings/geo',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ currentUser: user.current }) }));
vi.mock('@/components/settings/StorefrontSettings', () => ({ StorefrontSettings: () => null }));
vi.mock('@/components/settings/StoreIdentityCard', () => ({ StoreIdentityCard: () => null }));

import { GeoSettingsScreen } from './GeoSettingsScreen';
import { ConfirmProvider } from '@/components/ui/Confirm';
import { ToastProvider } from '@/components/ui/Toast';

const manager = { id: 'u1', role: 'COMPANY_ADMIN', permissions: ['geo.view', 'geo.manage'] };
const COUNTRY = {
  id: 'c1', code: 'SY', name: 'سوريا', currencyCode: 'USD', minorUnit: 2, workHoursStart: '09:00', workHoursEnd: '17:00',
  weekendDays: [5], timezone: 'Asia/Damascus', orderPrefix: 'ORD', allowNegativeStock: false, isActive: true,
  stores: [], _count: { regions: 0, orders: 0 },
};

let calls: { url: string; method: string; body?: Record<string, unknown> }[];
let patchAnswer: Error | null;

beforeEach(() => {
  vi.clearAllMocks();
  user.current = manager;
  calls = [];
  patchAnswer = null;
  api.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === 'PATCH') {
      if (patchAnswer) throw patchAnswer;
      return { country: COUNTRY };
    }
    if (url === '/api/geo/countries') return { countries: [COUNTRY] };
    if (url === '/api/geo/stores/usage') return { stores: {} };
    if (url === '/api/geo/countries/c1/regions') return { regions: [], usage: {} };
    throw new Error(`unexpected ${method} ${url}`);
  });
});
afterEach(() => cleanup());

const patches = () => calls.filter((c) => c.method === 'PATCH');

async function open() {
  render(
    <ToastProvider>
      <ConfirmProvider>
        <GeoSettingsScreen />
      </ConfirmProvider>
    </ToastProvider>
  );
  await screen.findByText('سوريا');
  fireEvent.click(screen.getByRole('button', { name: 'الإعدادات' }));
  const start = (await screen.findByLabelText('بداية الدوام')) as HTMLInputElement;
  const end = screen.getByLabelText('نهاية الدوام') as HTMLInputElement;
  return { start, end };
}

/** Type a value and leave the field, as a person does. */
const edit = (input: HTMLInputElement, value: string) => {
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
};

describe('the working-hours fields', () => {
  it('an end before the stored start shows the message, sends nothing, and the field goes back', async () => {
    const { end } = await open();
    edit(end, '08:00');
    expect(await screen.findByText(WORK_HOURS_ORDER_MESSAGE)).toBeTruthy();
    await waitFor(() => expect(end.value).toBe('17:00'));
    expect(patches()).toHaveLength(0);
  });

  it('a start after the stored end, and an equal pair, are refused the same way', async () => {
    const { start, end } = await open();
    edit(start, '18:00');
    expect(await screen.findByText(WORK_HOURS_ORDER_MESSAGE)).toBeTruthy();
    await waitFor(() => expect(start.value).toBe('09:00'));
    edit(end, '09:00');
    await waitFor(() => expect(end.value).toBe('17:00'));
    expect(patches()).toHaveLength(0);
  });

  it('a cleared field (the clock input gives an empty string) is refused as corrupt, and goes back', async () => {
    const { end } = await open();
    edit(end, '');
    await waitFor(() => expect(end.value).toBe('17:00'));
    expect(screen.getByText(/وقت الدوام غير صالح/)).toBeTruthy();
    expect(patches()).toHaveLength(0);
  });

  it('a valid change is sent as that one half only, and the field keeps it', async () => {
    const { start, end } = await open();
    edit(end, '22:00');
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]).toMatchObject({ url: '/api/geo/countries/c1', body: { workHoursEnd: '22:00' } });
    expect(Object.keys(patches()[0].body ?? {})).toEqual(['workHoursEnd']);
    expect(end.value).toBe('22:00');
    expect(start.value).toBe('09:00');
    expect(screen.queryByText(WORK_HOURS_ORDER_MESSAGE)).toBeNull();
  });

  it('when the route refuses, its own message is shown and the field goes back', async () => {
    patchAnswer = new Error('رسالة السيرفر عن الدوام');
    const { end } = await open();
    edit(end, '20:00'); // fine to the screen's own check
    expect(await screen.findByText('رسالة السيرفر عن الدوام')).toBeTruthy();
    await waitFor(() => expect(end.value).toBe('17:00'));
    expect(patches()).toHaveLength(1);
  });

  it('leaving a field unchanged asks nothing and says nothing', async () => {
    const { end } = await open();
    fireEvent.blur(end);
    expect(patches()).toHaveLength(0);
    expect(screen.queryByText(WORK_HOURS_ORDER_MESSAGE)).toBeNull();
  });
});
