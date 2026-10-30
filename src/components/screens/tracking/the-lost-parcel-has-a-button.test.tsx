// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import { stripComments } from '@/lib/guard-source';

/**
 * A DOOR THAT WRITES MONEY AND NO BUTTON OPENS IT.
 *
 * `POST /api/ops/tracking/write-off` has existed, with its own tests, since
 * the transfer flow was built. `nothing-unused-ships.test.ts` named it in
 * writing: «أخواتُه collect وdeliver وtransfer تُستدعى من الشاشات؛ شطبُ
 * الشحنة المفقودة لا يُستدعى من أيِّ زرّ».
 *
 * WHAT ITS ABSENCE COST. When an order is pulled away from a shipping
 * company a replacement is raised at once and the original waits at
 * `RETURN_REQUESTED` for the goods to come back. Sometimes they never do,
 * and nothing on any screen could say so — the order waited forever, its
 * units reserved against a parcel that no longer exists, so the shelf kept
 * promising stock nobody could pick. On this database today that is **zero
 * orders**, measured: NOT_READY 26, DELIVERED 21, PARTIALLY_DELIVERED 5,
 * RETURNED 4, and nothing at RETURN_REQUESTED. The gap is latent, not
 * theoretical — it is the state every recalled parcel passes through.
 *
 * SHOWN ONLY WHERE THE DOOR ACCEPTS IT. Anywhere else the route answers
 * 409 `NOT_AWAITING_RETURN`, and a button that always refuses is a broken
 * one. That condition is pinned below against the route's own guard, so
 * the two cannot drift apart.
 */

vi.mock('@/context/StoreCurrency', () => ({
  useStoreCurrency: () => ({ code: 'JOD', minorUnit: 3 }),
}));

import { WriteOffDialog } from './WriteOffDialog';

const ORDER = {
  id: '2f1c3a44-0000-4000-8000-000000000001',
  orderNumber: 'ORD-2026-0101',
  merchantRef: 'MR-0101',
  trackingNumber: '77881234',
  totalAmount: 45,
  currency: 'JOD',
  daysInTransit: 23,
  deliveryProvider: { name: 'أرامكس' },
};

let sent: { url: string; body: any }[] = [];
let answer: { ok: boolean; payload: any };

beforeEach(() => {
  sent = [];
  answer = { ok: true, payload: { message: 'أُغلق ORD-2026-0101 كخسارة — خرجت بضاعته من المخزون ولن تعود.' } };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      sent.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      return { ok: answer.ok, status: answer.ok ? 200 : 409, json: async () => answer.payload } as any;
    })
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const reasonBox = () => screen.getByLabelText('سبب الخسارة *');
/** The submit control, found by its JOB rather than its label — the label
 * changes to «جارٍ الإغلاق…» while the write is in flight, and a lookup by
 * name then reports «no such button» for a button that is right there. */
const confirm = () => document.querySelector('form button[type=submit]') as HTMLButtonElement;

const open = (overrides: Partial<React.ComponentProps<typeof WriteOffDialog>['order']> = {}) => {
  const done = vi.fn();
  render(<WriteOffDialog order={{ ...ORDER, ...overrides }} onClose={() => undefined} onDone={done} />);
  return done;
};

describe('the dialog states the loss before it takes it', () => {
  it('names the money that leaves the shelf, and says it does not come back', () => {
    open();
    const text = document.body.textContent ?? '';
    // The consequence in money, not «سيتم تحديث المخزون».
    expect(text).toContain('45');
    expect(text).toContain('تخرج من المخزون ولا تعود');
    // And WHY it is not restored — the sentence a person needs to accept.
    expect(text).toContain('جردٍ بعدها ناقصاً');
  });

  it('and says what it is NOT, because it is not a deletion', () => {
    open();
    const text = document.body.textContent ?? '';
    expect(text).toContain('يبقى الطلب برقمه وباركوده وسجلّه');
    // What justifies giving up, from the row rather than invented here.
    expect(text).toContain('أرامكس');
    expect(text).toContain('23');
    expect(text).toContain('77881234');
  });

  it('and draws no transit line for a parcel whose days are unknown', () => {
    // `daysInTransit` is nullable on the row. A «منذ null يوماً» is worse
    // than no sentence, and a 0 invented here would be a lie about a date.
    open({ daysInTransit: null });
    expect(document.body.textContent).not.toContain('منذ');
  });
});

describe('the reason is required here, not discovered at the door', () => {
  it('keeps the button shut until there is a reason worth reading', async () => {
    const user = userEvent.setup();
    open();
    expect(confirm().disabled).toBe(true);
    await user.type(reasonBox(), 'فقد');
    // Four characters: under the door's own `min(5)`.
    expect(confirm().disabled).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it('and opens it at the length the door accepts, not one character sooner', async () => {
    const user = userEvent.setup();
    open();
    await user.type(reasonBox(), 'فقدان');
    expect(confirm().disabled).toBe(false);
  });

  it('refuses whitespace dressed as a reason', async () => {
    const user = userEvent.setup();
    open();
    await user.type(reasonBox(), '      ');
    expect(confirm().disabled).toBe(true);
  });
});

describe('what reaches the door', () => {
  it('is the order and the trimmed reason, and nothing else', async () => {
    const user = userEvent.setup();
    const done = open();
    await user.type(reasonBox(), '  الشركة أقرّت بفقدان الشحنة  ');
    await user.click(confirm());
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].url).toBe('/api/ops/tracking/write-off');
    expect(sent[0].body).toEqual({
      orderId: ORDER.id,
      reason: 'الشركة أقرّت بفقدان الشحنة',
    });
    await waitFor(() => expect(done).toHaveBeenCalledWith(expect.stringContaining('كخسارة')));
  });

  it('and a refusal is shown rather than swallowed, with the door’s own words', async () => {
    const user = userEvent.setup();
    answer = {
      ok: false,
      payload: { error: 'لا يُغلق كخسارة إلا طلب مطلوب إرجاعه ولم يصل — هذا الطلب في حالة أخرى.' },
    };
    const done = open();
    await user.type(reasonBox(), 'فقدان الشحنة');
    await user.click(confirm());
    await waitFor(() => expect(screen.getByText(/هذا الطلب في حالة أخرى/)).toBeTruthy());
    expect(done).not.toHaveBeenCalled();
    // And the dialog stays open so the reason typed is not lost.
    expect(reasonBox()).toBeTruthy();
  });

  it('and the button does not come back, so an impatient second click is impossible', async () => {
    /*
     * This started as «click twice, expect one request» and the second
     * click threw — because the button is genuinely unclickable, which is
     * the stronger result. Before the fix `saving` was released in a
     * `finally` and the second click DID send a second write.
     */
    const user = userEvent.setup();
    open();
    await user.type(reasonBox(), 'فقدان الشحنة');
    await user.click(confirm());
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(confirm().disabled).toBe(true);
  });

  it('but a refused attempt gives the button back, so it can be tried again', async () => {
    const user = userEvent.setup();
    answer = { ok: false, payload: { error: 'تعذر الاتصال' } };
    open();
    await user.type(reasonBox(), 'فقدان الشحنة');
    await user.click(confirm());
    await waitFor(() => expect(screen.getByText('تعذر الاتصال')).toBeTruthy());
    expect(confirm().disabled).toBe(false);
  });
});

describe('the button is where the door can answer', () => {
  const read = (p: string) => stripComments(readFileSync(join(process.cwd(), p), 'utf8'));

  it('appears only on a parcel the route accepts', () => {
    const screenSrc = read('src/components/screens/TrackingScreen.tsx');
    // PR-8: the button is also drawn only for whoever holds the write-off box (`acts.writeOff`, from the server).
    expect(screenSrc).toContain("{acts.writeOff && o.shippingStatus === 'RETURN_REQUESTED' && (");
    expect(screenSrc).toContain('setWriteOffFor(o)');
  });

  it('and that condition is the ROUTE’s condition, read from the route', () => {
    /*
     * Not two copies of a status string. The route's guard is lifted out of
     * its own source, so renaming the state in one place and not the other
     * shows up here rather than as a button that always answers 409.
     */
    const route = read('src/app/api/ops/tracking/write-off/route.ts');
    const guard = route.match(/order\.shippingStatus !== '([A-Z_]+)'/);
    expect(guard, 'حارسُ الحالة اختفى من الباب').toBeTruthy();
    const accepted = guard![1];
    expect(read('src/components/screens/TrackingScreen.tsx')).toContain(
      `o.shippingStatus === '${accepted}'`
    );
  });

  it('and the tracking list actually carries that state', () => {
    // A button on a status the list filters out is a button on no row.
    const list = read('src/app/api/ops/tracking/route.ts');
    expect(list).toContain('RETURN_REQUESTED');
  });

  it('and it is no longer listed as a door nothing opens', () => {
    const guard = readFileSync(join(process.cwd(), 'src/lib/nothing-unused-ships.test.ts'), 'utf8');
    expect(guard).not.toContain("'/api/ops/tracking/write-off'");
  });
});
