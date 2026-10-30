// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { courierPlaces } from '@/lib/couriers/places';

/**
 * «رمزها عند الشركة» NAMES THE PLACE A TYPED NUMBER IS.
 *
 * Basha works at region level («دمشق - دمشق - دمشق» is intended): the number to type is the id of the same-name placeholder
 * CITY (their API field is cityId), not the Region Id. Next to the box the screen shows the place the number is, and warns
 * (never blocks) when the number is a known Region Id such as 3003.
 */

const { apiJson, failed } = vi.hoisted(() => ({ apiJson: vi.fn(), failed: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson, apiFetch: vi.fn() }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed, ok: vi.fn(), show: vi.fn() }) }));

import { CourierFees } from './CourierFees';

const COURIER = 'c0000000-0000-4000-8000-000000000001';
const SWEIDA = 'r0000000-0000-4000-8000-00000000000a';

const FEES = {
  regions: [{ id: SWEIDA, name: 'السويداء' }],
  fees: [{ id: 'f1', deliveryProviderId: COURIER, regionId: SWEIDA, fee: 3, lateThresholdDays: 3, returnFee: 0, courierCityId: null, isActive: true }],
};

let places: unknown;
const puts = () => apiJson.mock.calls.filter((c) => c[0] === '/api/settings/delivery-fees' && c[1]?.method === 'PUT');

beforeEach(() => {
  vi.clearAllMocks();
  places = courierPlaces('BASHA');
  apiJson.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (String(url).startsWith('/api/settings/delivery-fees/places')) return { places };
    return url === '/api/settings/delivery-fees' && !init?.method ? FEES : { fee: {} };
  });
});
afterEach(cleanup);

const open = async () => {
  render(<CourierFees courierId={COURIER} />);
  await waitFor(() => expect(screen.getAllByLabelText('رمز السويداء عند الشركة').length).toBeGreaterThan(0));
  // The list of names arrives on its own request.
  await waitFor(() => expect(apiJson.mock.calls.some((c) => String(c[0]).includes('/places?courier=' + COURIER))).toBe(true));
};
const box = () => screen.getAllByLabelText('رمز السويداء عند الشركة')[0] as HTMLInputElement;

describe('the code box', () => {
  it('a city id shows the place it is', async () => {
    const user = userEvent.setup();
    await open();
    await user.type(box(), '445153');
    expect((await screen.findAllByText('السويداء — السويداء')).length).toBeGreaterThan(0);
  });

  it('566117 is the town, and says so', async () => {
    const user = userEvent.setup();
    await open();
    await user.type(box(), '566117');
    expect((await screen.findAllByText('مدينة السويداء — السويداء')).length).toBeGreaterThan(0);
  });

  it('a Region Id warns and names the code to type — and the row can still be saved', async () => {
    const user = userEvent.setup();
    await open();
    await user.type(box(), '3003');
    const warnings = await screen.findAllByText(/هذا رقم المنطقة لـ«السويداء» وليس رقم مدينتها — اكتب 445153/);
    expect(warnings[0].className).toContain('text-[var(--sys-warning)]');
    // A warning, not a block: the owner decides.
    await user.click(screen.getAllByRole('button', { name: /تحديث/ })[0]);
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(JSON.parse(puts()[0][1].body as string)).toMatchObject({ regionId: SWEIDA, courierCityId: 3003 });
  });

  it('NEGATIVE: an unknown number, and an empty box, say nothing', async () => {
    const user = userEvent.setup();
    await open();
    await user.type(box(), '123456789');
    expect(screen.queryByText(/هذا رقم المنطقة/)).toBeNull();
    expect(screen.queryByText(/— السويداء$/)).toBeNull();
  });

  it('NEGATIVE: a courier we hold no list for gets the plain box, as before', async () => {
    places = null;
    const user = userEvent.setup();
    await open();
    await user.type(box(), '3003');
    expect(screen.queryByText(/هذا رقم المنطقة/)).toBeNull();
  });

  it('NEGATIVE: if the names cannot be fetched, the box still works', async () => {
    apiJson.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (String(url).startsWith('/api/settings/delivery-fees/places')) throw new Error('down');
      return url === '/api/settings/delivery-fees' && !init?.method ? FEES : { fee: {} };
    });
    const user = userEvent.setup();
    render(<CourierFees courierId={COURIER} />);
    await waitFor(() => expect(screen.getAllByLabelText('رمز السويداء عند الشركة').length).toBeGreaterThan(0));
    await user.type(box(), '445153');
    expect(box().value).toBe('445153');
    expect(failed).not.toHaveBeenCalled();
  });
});
