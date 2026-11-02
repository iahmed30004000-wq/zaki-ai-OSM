// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { courierPlaces } from '@/lib/couriers/places';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — an empty «رمزها عند الشركة» box is no longer a gap when their list names the governorate
 *
 * The owner, 2/11: the governorate's city code is adopted by itself. The press takes that city (`couriers/city-id`); this
 * screen has to say so, or it keeps drawing a warning over a box that needs nothing.
 *
 *  1. Empty box + their list names the governorate: the list’s number is the box’s hint, the city is named beside it
 *     («افتراضي من قايمة الشركة: …»), and the warning border is not drawn.
 *  2. A typed number (or a stored one) takes the hint's place and is described: the place it is — or, for a Region Id, a
 *     warning that says the system ignores it and uses the governorate's city (`couriers/city-id` does exactly that).
 *  3. A governorate the list cannot answer, or no list at all: the box is what it always was — warning border, «بلا رمز».
 *  4. Saving with the box empty still sends no code: the default is used at the press, it is never written as if typed.
 *
 * Blockers: no money, no order, no migration; the 461-row list never reaches the browser.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { apiJson, failed } = vi.hoisted(() => ({ apiJson: vi.fn(), failed: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson, apiFetch: vi.fn() }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed, ok: vi.fn(), show: vi.fn() }) }));

import { CourierFees } from './CourierFees';

const COURIER = 'c0000000-0000-4000-8000-000000000001';

const fee = (regionId: string, courierCityId: number | null) =>
  ({ id: `f-${regionId}`, deliveryProviderId: COURIER, regionId, fee: 3, lateThresholdDays: 3, returnFee: 0, courierCityId, isActive: true });

let regions: { id: string; name: string }[];
let fees: ReturnType<typeof fee>[];
let places: unknown;

const puts = () => apiJson.mock.calls.filter((c) => c[0] === '/api/settings/delivery-fees' && c[1]?.method === 'PUT');

beforeEach(() => {
  vi.clearAllMocks();
  places = courierPlaces('BASHA');
  regions = [{ id: 'r-sweida', name: 'السويداء' }];
  fees = [fee('r-sweida', null)];
  apiJson.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (String(url).startsWith('/api/settings/delivery-fees/places')) return { places };
    return url === '/api/settings/delivery-fees' && !init?.method ? { regions, fees } : { fee: {} };
  });
});
afterEach(cleanup);

const open = async (name: string) => {
  render(<CourierFees courierId={COURIER} />);
  await waitFor(() => expect(screen.getAllByLabelText(`رمز ${name} عند الشركة`).length).toBeGreaterThan(0));
  // The hint comes with the list of names, which arrives on its own request.
  await waitFor(() => expect(apiJson.mock.calls.some((c) => String(c[0]).includes('/places?courier=' + COURIER))).toBe(true));
};
const box = (name: string) => screen.getAllByLabelText(`رمز ${name} عند الشركة`)[0] as HTMLInputElement;
const WARNING_BORDER = 'border-[var(--sys-warning)]';

describe('an empty box where their list names the governorate', () => {
  it('shows the list’s number as the hint and names the city beside it', async () => {
    await open('السويداء');
    await waitFor(() => expect(box('السويداء').placeholder).toBe('445153'));
    expect((await screen.findAllByText('افتراضي من قايمة الشركة: السويداء — السويداء')).length).toBeGreaterThan(0);
    // It is a hint, not a value: the box itself is empty.
    expect(box('السويداء').value).toBe('');
  });

  it('draws no warning: the press needs nothing more for this governorate', async () => {
    await open('السويداء');
    await waitFor(() => expect(box('السويداء').placeholder).toBe('445153'));
    expect(box('السويداء').className).not.toContain(WARNING_BORDER);
    expect(box('السويداء').className).toContain('border-[var(--sys-border-input)]');
  });

  it('finds our «إدلب» under their «ادلب»', async () => {
    regions = [{ id: 'r-idlib', name: 'إدلب' }];
    fees = [fee('r-idlib', null)];
    await open('إدلب');
    await waitFor(() => expect(box('إدلب').placeholder).toBe('570148'));
    expect((await screen.findAllByText('افتراضي من قايمة الشركة: ادلب — ادلب')).length).toBeGreaterThan(0);
  });

  it('and a governorate with no fee row yet gets its hint too — the row does not have to exist', async () => {
    fees = [];
    await open('السويداء');
    await waitFor(() => expect(box('السويداء').placeholder).toBe('445153'));
  });

  it('names «مدينة دير الزور» for دير الزور, whose list has no city with its own name', async () => {
    regions = [{ id: 'r-deir', name: 'دير الزور' }];
    fees = [fee('r-deir', null)];
    await open('دير الزور');
    await waitFor(() => expect(box('دير الزور').placeholder).toBe('949546'));
    expect((await screen.findAllByText('افتراضي من قايمة الشركة: مدينة دير الزور — دير الزور')).length).toBeGreaterThan(0);
  });
});

describe('a number in the box wins', () => {
  it('typing one takes the hint away and names the place the number is — exactly as before', async () => {
    const user = userEvent.setup();
    await open('السويداء');
    await waitFor(() => expect(box('السويداء').placeholder).toBe('445153'));
    await user.type(box('السويداء'), '566117');
    expect((await screen.findAllByText('مدينة السويداء — السويداء')).length).toBeGreaterThan(0);
    expect(screen.queryByText(/افتراضي من قايمة الشركة/)).toBeNull();
    expect(box('السويداء').className).not.toContain(WARNING_BORDER);
  });

  it('a Region Id typed still warns, and says the system ignores it and uses the city — the hint does not hide the mistake', async () => {
    const user = userEvent.setup();
    await open('السويداء');
    await waitFor(() => expect(box('السويداء').placeholder).toBe('445153'));
    await user.type(box('السويداء'), '3003');
    const warnings = await screen.findAllByText(/هذا رقم المنطقة لـ«السويداء» وليس رقم مدينتها — النظام بيتجاهله ويستعمل 445153/);
    expect(warnings[0].className).toContain('text-[var(--sys-warning)]');
    expect(screen.queryByText(/افتراضي من قايمة الشركة/)).toBeNull();
  });

  it('a stored number shows itself, and the hint is not drawn over it', async () => {
    fees = [fee('r-sweida', 566117)];
    await open('السويداء');
    await waitFor(() => expect(box('السويداء').value).toBe('566117'));
    expect(screen.queryByText(/افتراضي من قايمة الشركة/)).toBeNull();
    expect(box('السويداء').placeholder).toBe('بلا رمز');
  });

  it('emptying the box brings the hint back', async () => {
    const user = userEvent.setup();
    await open('السويداء');
    await user.type(box('السويداء'), '12');
    expect(screen.queryByText(/افتراضي من قايمة الشركة/)).toBeNull();
    await user.clear(box('السويداء'));
    expect((await screen.findAllByText('افتراضي من قايمة الشركة: السويداء — السويداء')).length).toBeGreaterThan(0);
  });
});

describe('where the list cannot answer, the box is what it always was', () => {
  it('NEGATIVE: a governorate their list does not name keeps «بلا رمز» and the warning border', async () => {
    regions = [{ id: 'r-baghdad', name: 'بغداد' }];
    fees = [fee('r-baghdad', null)];
    await open('بغداد');
    expect(box('بغداد').placeholder).toBe('بلا رمز');
    expect(box('بغداد').className).toContain(WARNING_BORDER);
    expect(screen.queryByText(/افتراضي من قايمة الشركة/)).toBeNull();
  });

  it('NEGATIVE: a courier we hold no list for gets the plain box', async () => {
    places = null;
    await open('السويداء');
    expect(box('السويداء').placeholder).toBe('بلا رمز');
    expect(box('السويداء').className).toContain(WARNING_BORDER);
    expect(screen.queryByText(/افتراضي من قايمة الشركة/)).toBeNull();
  });

  it('NEGATIVE: if the list cannot be fetched the box still works as the plain box', async () => {
    apiJson.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (String(url).startsWith('/api/settings/delivery-fees/places')) throw new Error('down');
      return url === '/api/settings/delivery-fees' && !init?.method ? { regions, fees } : { fee: {} };
    });
    render(<CourierFees courierId={COURIER} />);
    await waitFor(() => expect(screen.getAllByLabelText('رمز السويداء عند الشركة').length).toBeGreaterThan(0));
    expect(box('السويداء').placeholder).toBe('بلا رمز');
    expect(box('السويداء').className).toContain(WARNING_BORDER);
    expect(failed).not.toHaveBeenCalled();
  });
});

describe('the hint is never saved as if somebody typed it', () => {
  it('saving a row with the box empty sends no code at all', async () => {
    const user = userEvent.setup();
    await open('السويداء');
    await waitFor(() => expect(box('السويداء').placeholder).toBe('445153'));
    await user.click(screen.getAllByRole('button', { name: /تحديث/ })[0]);
    await waitFor(() => expect(puts()).toHaveLength(1));
    const body = JSON.parse(puts()[0][1].body as string) as Record<string, unknown>;
    expect(body).toMatchObject({ regionId: 'r-sweida' });
    expect(Object.keys(body)).not.toContain('courierCityId');
  });
});

/**
 * THE NOTE PROMISES WHAT THE PRESS WILL DO FOR THIS ROW (the independent review, 2/11).
 *
 * A Region Id typed in the box is ignored, and the city used instead is the one of the ROW's governorate — not the city of
 * the Region Id's own region. The note used to name the second, so 3002 (الحسكة's) typed on the السويداء row said 445152 while
 * the press sent 445153: only the sentence was false, the parcel went right. It names the first now.
 */
describe('the note names the ROW’s city, not the typed Region Id’s own', () => {
  const NOTE = (region: string, city: number) => `هذا رقم المنطقة لـ«${region}» وليس رقم مدينتها — النظام بيتجاهله ويستعمل ${city}`;

  it('3002 (الحسكة’s Region Id) on the السويداء row: the system uses 445153 — never الحسكة’s 445152', async () => {
    const user = userEvent.setup();
    await open('السويداء');
    await waitFor(() => expect(box('السويداء').placeholder).toBe('445153'));
    await user.type(box('السويداء'), '3002');
    const notes = await screen.findAllByText(NOTE('الحسكة', 445153));
    expect(notes[0].className).toContain('text-[var(--sys-warning)]');
    expect(screen.queryByText(/445152/)).toBeNull();
  });

  it('4035 (اربد’s Region Id) on the السويداء row: 445153, not 949533', async () => {
    const user = userEvent.setup();
    await open('السويداء');
    await waitFor(() => expect(box('السويداء').placeholder).toBe('445153'));
    await user.type(box('السويداء'), '4035');
    expect((await screen.findAllByText(NOTE('اربد', 445153))).length).toBeGreaterThan(0);
    expect(screen.queryByText(/949533/)).toBeNull();
  });

  it('the same 3002 on the دمشق row names دمشق’s city: the note follows the row', async () => {
    regions = [{ id: 'r-dam', name: 'دمشق' }];
    fees = [fee('r-dam', null)];
    const user = userEvent.setup();
    await open('دمشق');
    await waitFor(() => expect(box('دمشق').placeholder).toBe('445053'));
    await user.type(box('دمشق'), '3002');
    expect((await screen.findAllByText(NOTE('الحسكة', 445053))).length).toBeGreaterThan(0);
  });

  it('a Region Id on a row their list does not name: the old wording, with no promise', async () => {
    regions = [{ id: 'r-baghdad', name: 'بغداد' }];
    fees = [fee('r-baghdad', null)];
    const user = userEvent.setup();
    await open('بغداد');
    await user.type(box('بغداد'), '3003');
    expect((await screen.findAllByText('هذا رقم المنطقة لـ«السويداء» وليس رقم مدينتها — اكتب رقم مدينتها من قائمتهم')).length).toBeGreaterThan(0);
    expect(screen.queryByText(/بيتجاهله/)).toBeNull();
  });
});

/**
 * THE BOX'S TITLE IS TRUE IN EACH OF ITS THREE STATES.
 *
 * «Leave it empty and the list's number is used» was false for a row that held a number: emptying it sent nothing and the
 * PUT kept the stored one. Emptying a stored number now clears it (see `the-courier-city-code-is-typed-from-their-list`),
 * and the title says how.
 */
describe('the box’s title says what is true', () => {
  it('empty, and the list answers: leave it empty — or clear a number and press «تحديث» — and the list’s number is used', async () => {
    await open('السويداء');
    await waitFor(() => expect(box('السويداء').placeholder).toBe('445153'));
    expect(box('السويداء').title).toBe(
      'اتركه فاضي (أو امسح الرقم واضغط «تحديث») وبيُستعمل رمز قايمة الشركة الظاهر تحته، أو اكتب رقماً ثانياً وبيصير هو المعتمد.',
    );
  });

  it('a number in it, and the list answers: clear it and press «تحديث» to go back to the list’s number', async () => {
    fees = [fee('r-sweida', 566117)];
    await open('السويداء');
    await waitFor(() => expect(box('السويداء').value).toBe('566117'));
    expect(box('السويداء').title).toBe('امسح الرقم واضغط «تحديث» وبيرجع النظام يستعمل رمز قايمة الشركة لهذه المحافظة.');
  });

  it('the list cannot answer: the old title — without a number the shipment is not created', async () => {
    regions = [{ id: 'r-baghdad', name: 'بغداد' }];
    fees = [fee('r-baghdad', null)];
    await open('بغداد');
    expect(box('بغداد').title).toBe('رمز هذه المحافظة لدى الشركة، من قائمة مناطقهم — بدونه لا تُنشأ الشحنة آلياً.');
  });
});

/**
 * A stored number emptied here is sent as `null` — through the real screen, in this file's own fixtures too.
 */
describe('emptying a stored number on this screen', () => {
  it('sends null, and the hint is what the box shows after the save', async () => {
    fees = [fee('r-sweida', 566117)];
    const user = userEvent.setup();
    await open('السويداء');
    await waitFor(() => expect(box('السويداء').value).toBe('566117'));
    await user.clear(box('السويداء'));
    // Emptied (not yet saved): the list's number is already the hint.
    await waitFor(() => expect(box('السويداء').placeholder).toBe('445153'));
    await user.click(screen.getAllByRole('button', { name: /تحديث/ })[0]);
    await waitFor(() => expect(puts()).toHaveLength(1));
    const body = JSON.parse(puts()[0][1].body as string) as Record<string, unknown>;
    expect(body.courierCityId).toBeNull();
  });
});
