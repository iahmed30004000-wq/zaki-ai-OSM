// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

/**
 * «انا ليش ما بقدر ادخل الرموز؟» — the courier's own id for a governorate, typed on the fees screen from the list the
 * courier sends, and saved with the row. A number that is not a positive whole number is refused before it is sent. An
 * EMPTY box depends on the row (2/11, the independent review): one that never held a number sends nothing — there is
 * nothing to change — but one that HELD a number and was emptied sends `null`, which clears it so the courier's own list
 * answers again. (Empty used to keep what was stored in both cases, and the box's own hint «leave it empty and the list's
 * number is used» was false for the second.) The endpoint half (absent keeps · number writes · null clears · audited) is
 * in `api/settings/delivery-fees/absent-is-not-zero.test.ts`.
 */

const { apiJson, failed } = vi.hoisted(() => ({ apiJson: vi.fn(), failed: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson, apiFetch: vi.fn() }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed, ok: vi.fn(), show: vi.fn() }) }));

import { CourierFees } from './CourierFees';

const COURIER = 'c0000000-0000-4000-8000-000000000001';
const DAMASCUS = 'r0000000-0000-4000-8000-00000000000a';
const ALEPPO = 'r0000000-0000-4000-8000-00000000000b';

const FEES = {
  regions: [
    { id: DAMASCUS, name: 'دمشق' },
    { id: ALEPPO, name: 'حلب' },
  ],
  fees: [
    { id: 'f1', deliveryProviderId: COURIER, regionId: DAMASCUS, fee: 3, lateThresholdDays: 3, returnFee: 0, courierCityId: null, isActive: true },
    { id: 'f2', deliveryProviderId: COURIER, regionId: ALEPPO, fee: 4, lateThresholdDays: 3, returnFee: 0, courierCityId: 705991, isActive: true },
  ],
};

const puts = () => apiJson.mock.calls.filter((c) => c[0] === '/api/settings/delivery-fees' && c[1]?.method === 'PUT');
const sent = () => JSON.parse(puts()[0][1].body as string) as Record<string, unknown>;
const box = (label: string) => screen.getAllByLabelText(label)[0] as HTMLInputElement;
const updateButtons = () => screen.getAllByRole('button', { name: /تحديث/ });

beforeEach(() => {
  vi.clearAllMocks();
  apiJson.mockImplementation(async (url: string, init?: { method?: string }) =>
    url === '/api/settings/delivery-fees' && !init?.method ? FEES : { fee: {} }
  );
});
afterEach(cleanup);

const open = async () => {
  render(<CourierFees courierId={COURIER} />);
  await waitFor(() => expect(screen.getAllByLabelText('رمز دمشق عند الشركة').length).toBeGreaterThan(0));
};

describe('the fees screen', () => {
  it('shows a stored code in its box, and an empty box where there is none', async () => {
    await open();
    expect(box('رمز حلب عند الشركة').value).toBe('705991');
    expect(box('رمز دمشق عند الشركة').value).toBe('');
  });

  it('a typed code is saved with the row — no fee reason asked, the fee did not change', async () => {
    const user = userEvent.setup();
    await open();
    await user.type(box('رمز دمشق عند الشركة'), '445053');
    await user.click(updateButtons()[0]);
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(sent()).toMatchObject({ regionId: DAMASCUS, fee: 3, courierCityId: 445053 });
    expect(sent().reason).toBeUndefined();
  });

  it('NEGATIVE: a box that was EMPTY FROM THE START sends no code at all — there is nothing to change or to clear', async () => {
    const user = userEvent.setup();
    await open();
    await user.click(updateButtons()[0]);
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(Object.keys(sent())).not.toContain('courierCityId');
  });

  it('a stored code that is left alone is sent as it is', async () => {
    const user = userEvent.setup();
    await open();
    await user.click(updateButtons()[1]);
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(sent()).toMatchObject({ regionId: ALEPPO, fee: 4, courierCityId: 705991 });
  });

  it('a stored code that is EMPTIED is cleared: the PUT carries courierCityId null, so the list answers again', async () => {
    const user = userEvent.setup();
    await open();
    await user.clear(box('رمز حلب عند الشركة'));
    await user.click(updateButtons()[1]);
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(sent()).toMatchObject({ regionId: ALEPPO, fee: 4 });
    // The key is there, and it is null — not absent (absent keeps the stored number) and not 0.
    expect(Object.keys(sent())).toContain('courierCityId');
    expect(sent().courierCityId).toBeNull();
    expect(sent().reason).toBeUndefined();
  });

  it('a stored code that is emptied and typed over is the new number, not a clear', async () => {
    const user = userEvent.setup();
    await open();
    await user.clear(box('رمز حلب عند الشركة'));
    await user.type(box('رمز حلب عند الشركة'), '705992');
    await user.click(updateButtons()[1]);
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(sent().courierCityId).toBe(705992);
  });

  it('NEGATIVE: a governorate with no fee row yet has nothing to clear — adding it sends no code', async () => {
    const HOMS = 'r0000000-0000-4000-8000-00000000000c';
    apiJson.mockImplementation(async (url: string, init?: { method?: string }) =>
      url === '/api/settings/delivery-fees' && !init?.method
        ? { regions: [...FEES.regions, { id: HOMS, name: 'حمص' }], fees: FEES.fees }
        : { fee: {} }
    );
    const user = userEvent.setup();
    render(<CourierFees courierId={COURIER} />);
    await waitFor(() => expect(screen.getAllByLabelText('رمز حمص عند الشركة').length).toBeGreaterThan(0));
    await user.type(screen.getAllByLabelText('أجرة حمص')[0], '5');
    await user.click(screen.getAllByRole('button', { name: /إضافة/ })[0]);
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(sent()).toMatchObject({ regionId: HOMS, fee: 5 });
    expect(Object.keys(sent())).not.toContain('courierCityId');
  });

  it('NEGATIVE: a code that is not a positive whole number is refused before anything is sent', async () => {
    const user = userEvent.setup();
    await open();
    await user.type(box('رمز دمشق عند الشركة'), '-5');
    await user.click(updateButtons()[0]);
    await waitFor(() => expect(failed).toHaveBeenCalled());
    expect(puts()).toHaveLength(0);
  });
});

/**
 * A DRAFT IS A SNAPSHOT — AND A STALE ONE MUST NOT WIPE A CODE SOMEBODY ELSE WROTE (the second independent review, 2/11).
 *
 * «Empty box, and the row holds a code» means «clear it» only when the OPERATOR emptied the box. A row's draft is made when it
 * is first edited and a reload does not refresh it, while the row itself is read fresh. So: edit only دمشق's late days (its code
 * box is '' then), let a second admin write 445053 for دمشق, save حلب (which re-fetches the rows), then save دمشق — and its PUT
 * carried `courierCityId: null` for a box nobody touched, wiping their code. The code box now says whether it was touched
 * (`codeEdited`, set by its own `onChange` and by nothing else, and cleared by a successful save).
 *
 * These run against a small fake of the endpoint that KEEPS the rows between calls: GET answers what is stored NOW, and PUT
 * applies the body the way the route does (absent keeps · a number writes · null clears) — so "their code stays" is a thing
 * the test can read, not only a body it can inspect.
 */
describe('a stale draft must not wipe a code somebody else wrote', () => {
  let stored: Record<string, number | null>;
  const getCount = () => apiJson.mock.calls.filter((c) => c[0] === '/api/settings/delivery-fees' && !c[1]?.method).length;
  const body = (i: number) => JSON.parse(puts()[i][1].body as string) as Record<string, unknown>;
  /** A saved row wears «تم الحفظ» for two seconds: the same button, named differently. */
  const rowButtons = () => screen.getAllByRole('button', { name: /تحديث|تم الحفظ|إضافة/ });
  const reloaded = (n: number) => waitFor(() => expect(getCount()).toBe(n));
  const lateDays = (name: string) => screen.getAllByLabelText(`حد التأخير في ${name}`)[0] as HTMLInputElement;

  beforeEach(() => {
    stored = { [DAMASCUS]: null, [ALEPPO]: 705991 };
    apiJson.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
      if (url !== '/api/settings/delivery-fees') return { fee: {} };
      if (!init?.method) {
        return { regions: FEES.regions, fees: FEES.fees.map((f) => ({ ...f, courierCityId: stored[f.regionId] })) };
      }
      const put = JSON.parse(init.body as string) as { regionId: string; courierCityId?: number | null };
      if ('courierCityId' in put) stored[put.regionId] = put.courierCityId ?? null;
      return { fee: {} };
    });
  });

  // Whichever OTHER box the operator edits first, the draft is made with the code box '' — the three are tried, because the
  // flag must be set by the code box's own `onChange` and by none of the others.
  it.each([
    { box: 'حد التأخير في دمشق', value: '5', sent: { lateThresholdDays: 5 } },
    { box: 'أجرة إرجاع دمشق', value: '2', sent: { returnFee: 2 } },
    // The fee is re-typed to the same 3, so no reason is asked (a changed fee on an existing row opens the reason dialog).
    { box: 'أجرة دمشق', value: '3', sent: { fee: 3 } },
  ])('edit only دمشق’s «$box», let somebody write its code, save حلب, then save دمشق: no code key is sent, and their code stays', async ({ box: label, value, sent: expected }) => {
    const user = userEvent.setup();
    await open();
    // 1. Only that one box of دمشق. Nothing was stored for it then, so its code box is '' in the draft.
    await user.clear(screen.getAllByLabelText(label)[0]);
    await user.type(screen.getAllByLabelText(label)[0], value);
    // 2. Meanwhile a second admin writes 445053 for دمشق.
    stored[DAMASCUS] = 445053;
    // 3. The operator saves حلب — that re-fetches the rows, so دمشق now HAS a code.
    await user.click(rowButtons()[1]);
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(body(0)).toMatchObject({ regionId: ALEPPO });
    await reloaded(2);
    // 4. The operator saves دمشق. Its code box was never touched and still shows ''.
    expect(box('رمز دمشق عند الشركة').value).toBe('');
    await user.click(rowButtons()[0]);
    await waitFor(() => expect(puts()).toHaveLength(2));
    expect(body(1)).toMatchObject({ regionId: DAMASCUS, ...expected });
    expect(Object.keys(body(1))).not.toContain('courierCityId');
    // …and the code the other person wrote is exactly where they left it.
    expect(stored[DAMASCUS]).toBe(445053);
  });

  it('a stored code the operator clears is still cleared (null) — and the server really lets go of it', async () => {
    const user = userEvent.setup();
    await open();
    await user.clear(box('رمز حلب عند الشركة'));
    await user.click(rowButtons()[1]);
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(body(0).courierCityId).toBeNull();
    expect(stored[ALEPPO]).toBeNull();
  });

  it('after a SUCCESSFUL save the box counts as untouched again: saving the same stale draft later cannot wipe a third person’s code', async () => {
    const user = userEvent.setup();
    await open();
    // The operator clears حلب's code and saves: cleared.
    await user.clear(box('رمز حلب عند الشركة'));
    await user.click(rowButtons()[1]);
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(body(0).courierCityId).toBeNull();
    await reloaded(2);
    // A third person writes a new code for حلب; another save (دمشق) re-fetches the rows.
    stored[ALEPPO] = 705999;
    await user.click(rowButtons()[0]);
    await waitFor(() => expect(puts()).toHaveLength(2));
    await reloaded(3);
    // The operator saves حلب again WITHOUT touching its box: the stale draft still says ''.
    expect(box('رمز حلب عند الشركة').value).toBe('');
    await user.click(rowButtons()[1]);
    await waitFor(() => expect(puts()).toHaveLength(3));
    expect(Object.keys(body(2))).not.toContain('courierCityId');
    expect(stored[ALEPPO]).toBe(705999);
  });

  it('a stored code that is cleared and then typed again is the typed number', async () => {
    const user = userEvent.setup();
    await open();
    await user.clear(box('رمز حلب عند الشركة'));
    await user.type(box('رمز حلب عند الشركة'), '705992');
    await user.click(rowButtons()[1]);
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(body(0).courierCityId).toBe(705992);
    expect(stored[ALEPPO]).toBe(705992);
  });

  it('NEGATIVE: a box the operator touched and emptied again, on a row that never held a number, still sends nothing', async () => {
    const user = userEvent.setup();
    await open();
    await user.type(box('رمز دمشق عند الشركة'), '4');
    await user.clear(box('رمز دمشق عند الشركة'));
    await user.click(rowButtons()[0]);
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(Object.keys(body(0))).not.toContain('courierCityId');
    expect(stored[DAMASCUS]).toBeNull();
  });

  it('editing only the late days or the return fee of a row that holds a code sends the code as it is — never null', async () => {
    const user = userEvent.setup();
    await open();
    await user.clear(lateDays('حلب'));
    await user.type(lateDays('حلب'), '9');
    await user.clear(screen.getAllByLabelText('أجرة إرجاع حلب')[0]);
    await user.type(screen.getAllByLabelText('أجرة إرجاع حلب')[0], '2');
    await user.click(rowButtons()[1]);
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(body(0)).toMatchObject({ regionId: ALEPPO, lateThresholdDays: 9, returnFee: 2, courierCityId: 705991 });
    expect(stored[ALEPPO]).toBe(705991);
  });

  it('switching to another courier and back starts the drafts over, the flag included: a box cleared before is the stored number again', async () => {
    const OTHER = 'c0000000-0000-4000-8000-000000000002';
    const user = userEvent.setup();
    const { rerender } = render(<CourierFees courierId={COURIER} />);
    await waitFor(() => expect(screen.getAllByLabelText('رمز حلب عند الشركة').length).toBeGreaterThan(0));
    await user.clear(box('رمز حلب عند الشركة'));
    expect(box('رمز حلب عند الشركة').value).toBe('');
    rerender(<CourierFees courierId={OTHER} />);
    rerender(<CourierFees courierId={COURIER} />);
    await waitFor(() => expect(box('رمز حلب عند الشركة').value).toBe('705991'));
    await user.click(rowButtons()[1]);
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(body(0).courierCityId).toBe(705991);
    expect(stored[ALEPPO]).toBe(705991);
  });
});
