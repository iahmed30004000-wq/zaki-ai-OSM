// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * M9 OF THE PHONE AUDIT — THE NEW-ORDER FORM, LAID OUT FOR A PHONE, SENDING WHAT IT ALWAYS SENT.
 *
 * ORD-09. On a phone the form was four framed sections and the button that makes the order sat at the very
 * bottom of the last one — three screens down. The header was a list of features in a subtitle. «الزبون على
 * الخط» was the browser's 13px box.
 *
 * Now, on a phone only: the buttons are in the dialog's foot (outside the part that scrolls), the sections lose
 * their frames, the two optional ones are one fold, and the checkbox has a 44px label.
 *
 * THIS IS A FILE OF THE ORDER-CREATION SET, SO IT IS LAYOUT AND NOTHING ELSE. What is held:
 *   • THE BODY: the same fields filled in produce the same JSON on a desk and on a phone — compared to each other
 *     AND to the body written out here, key by key, so a field that disappears from both is still caught;
 *   • the same with every optional field filled in (they are folded away on a phone, and must still be sent);
 *   • «أكّده الآن»: the same two calls, in the same order, with the same arguments;
 *   • the submit button in the foot belongs to the form (\`form="…"\`), so pressing it submits THIS form's handler;
 *   • and A DESK IS WHAT IT WAS: buttons at the end of the form, framed sections, nothing folded, no \`form\`
 *     attribute on the button, the old subtitle.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { apiFetch, apiJson, toast, user, phone } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  apiJson: vi.fn(),
  toast: { done: vi.fn(), warn: vi.fn(), failed: vi.fn() },
  user: { current: null as unknown },
  phone: { value: false },
}));

vi.mock('@/lib/api-client', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a), apiJson: (...a: unknown[]) => apiJson(...a) }));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ t: (k: string) => k, locale: 'ar', isRtl: true, currentUser: user.current }),
}));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => phone.value }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => toast }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/hooks/useRegions', () => ({
  useRegions: () => ({
    regions: [{ id: 'r1', name: 'عمّان', delivery: null, deliveryAr: null }],
    countryName: 'الأردن',
    currency: { code: 'JOD', minorUnit: 3 },
    loading: false,
  }),
}));
vi.mock('@/hooks/useDeliveryEta', () => ({ useDeliveryEta: () => ({ eta: null, loading: false }) }));
vi.mock('@/hooks/useProducts', () => ({
  useProducts: () => ({ products: [{ id: 'p1', name: 'كريم', basePrice: 10, offers: [] }], loading: false }),
}));

import { CreateOrderModal } from './CreateOrderModal';

const CONFIRMER = { id: 'u1', status: 'ACTIVE', role: 'MANAGER', permissions: ['orders.create', 'orders.confirm', 'orders.assign'] };
const ORDER = { id: 'o-1', orderNumber: 'ORD-26-0001' };

beforeEach(() => {
  vi.clearAllMocks();
  phone.value = false;
  user.current = CONFIRMER;
  apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/orders' && init?.method === 'POST') return { ok: true, json: async () => ({ order: ORDER }) };
    if (url === '/api/orders/form-options') {
      return {
        ok: true,
        json: async () => ({ channels: [{ id: 'ch1', name: 'فيسبوك' }], moderators: [{ id: 'm1', name: 'سارة' }], mayAssign: true }),
      };
    }
    return { ok: true, json: async () => ({}) };
  });
  apiJson.mockImplementation(async (_url: string, init?: RequestInit) => (init?.method === 'POST' ? {} : { order: { version: 4 } }));
});
afterEach(cleanup);

const open = async () => {
  render(<CreateOrderModal isOpen onClose={() => {}} onSuccess={vi.fn()} />);
  await screen.findByLabelText('المحافظة');
  // the form's own options (channels, moderators) arrive after the dialog opens
  await screen.findByRole('option', { name: 'فيسبوك' });
};
const fill = () => {
  fireEvent.change(screen.getByPlaceholderText('مثال: 0936654998'), { target: { value: '0791234567' } });
  fireEvent.change(screen.getByPlaceholderText('مثال: عبدالله عبدالقادر'), { target: { value: 'سامر أحمد' } });
  fireEvent.change(screen.getByPlaceholderText('الشارع، البناء، المنطقة...'), { target: { value: 'عمّان - الجبيهة' } });
  fireEvent.change(screen.getByLabelText('المحافظة'), { target: { value: 'r1' } });
};
const fillOptional = () => {
  fireEvent.change(screen.getByPlaceholderText('اختياري'), { target: { value: '0781112223' } });
  fireEvent.change(screen.getByLabelText('قناة الطلب'), { target: { value: 'ch1' } });
  fireEvent.change(screen.getByLabelText('المودريتور المسؤول'), { target: { value: 'm1' } });
  fireEvent.change(screen.getByPlaceholderText('مثال: يرجى الاتصال قبل الوصول'), { target: { value: 'اتصلوا قبل الوصول' } });
  fireEvent.change(screen.getByPlaceholderText('مثال: عميل من إعلان تيك توك'), { target: { value: 'من تيك توك' } });
};
const submit = async () => {
  const button = await screen.findByRole('button', { name: /إنشاء الطلب/ });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  await act(async () => {
    fireEvent.click(button);
  });
};
const postBody = () => {
  const call = apiFetch.mock.calls.find((c) => c[0] === '/api/orders' && c[1]?.method === 'POST');
  expect(call, 'ما انرسل طلب إنشاء').toBeTruthy();
  return JSON.parse(String(call![1].body));
};

/** The whole body, written out. If either mode drops or renames a field this stops being equal. */
const BASE = {
  customerName: 'سامر أحمد',
  customerPhone: '0791234567',
  customerAltPhone: '',
  customerAddress: 'عمّان - الجبيهة',
  customerCity: 'عمّان',
  regionId: 'r1',
  items: [{ productId: 'p1', offerId: null, quantity: 1, unitPrice: expect.any(String) }],
  channelId: null,
  moderatorId: null,
  customerNotes: '',
  internalNotes: '',
};

describe('THE BODY — the same fields, the same JSON, on a desk and on a phone', () => {
  it('the required fields only', async () => {
    const sent: unknown[] = [];
    for (const isPhone of [false, true]) {
      cleanup();
      vi.clearAllMocks();
      phone.value = isPhone;
      await open();
      fill();
      await submit();
      await waitFor(() => expect(apiFetch.mock.calls.some((c) => c[0] === '/api/orders')).toBe(true));
      const body = postBody();
      expect(body, isPhone ? 'phone' : 'desk').toEqual(BASE);
      expect(Object.keys(body).sort()).toEqual(Object.keys(BASE).sort());
      sent.push(body);
    }
    expect(sent[1], 'الجوال والديسكتوب أرسلا جسمين مختلفين').toEqual(sent[0]);
  });

  it('every optional field filled in — folded away on a phone, and still sent', async () => {
    const sent: unknown[] = [];
    for (const isPhone of [false, true]) {
      cleanup();
      vi.clearAllMocks();
      phone.value = isPhone;
      await open();
      fill();
      fillOptional();
      await submit();
      await waitFor(() => expect(apiFetch.mock.calls.some((c) => c[0] === '/api/orders')).toBe(true));
      const body = postBody();
      expect(body, isPhone ? 'phone' : 'desk').toEqual({
        ...BASE,
        customerAltPhone: '0781112223',
        channelId: 'ch1',
        moderatorId: 'm1',
        customerNotes: 'اتصلوا قبل الوصول',
        internalNotes: 'من تيك توك',
      });
      sent.push(body);
    }
    expect(sent[1]).toEqual(sent[0]);
  });

  it('«أكّده الآن»: the same two calls, in the same order, with the same arguments', async () => {
    const trace: string[][] = [];
    for (const isPhone of [false, true]) {
      cleanup();
      vi.clearAllMocks();
      phone.value = isPhone;
      await open();
      fill();
      fireEvent.click(screen.getByRole('checkbox', { name: /الزبون على الخط/ }));
      await submit();
      await waitFor(() => expect(apiJson).toHaveBeenCalledWith('/api/orders/o-1/confirmation', expect.anything()));
      trace.push([
        ...apiFetch.mock.calls.filter((c) => c[1]?.method === 'POST').map((c) => `${c[0]} ${c[1].body}`),
        ...apiJson.mock.calls.filter((c) => c[1]?.method === 'POST').map((c) => `${c[0]} ${c[1].body}`),
      ]);
      expect(toast.done).toHaveBeenCalledTimes(1);
      expect(toast.done.mock.calls[0][0]).toContain('وتأكيده');
    }
    expect(trace[1]).toEqual(trace[0]);
    expect(trace[0]).toHaveLength(2);
    expect(trace[0][1]).toBe('/api/orders/o-1/confirmation {"action":"confirm","expectedVersion":4}');
  });

  it('NEGATIVE: with the required fields empty, pressing the button sends nothing — on both', async () => {
    for (const isPhone of [false, true]) {
      cleanup();
      vi.clearAllMocks();
      phone.value = isPhone;
      await open();
      const button = (await screen.findByRole('button', { name: /إنشاء الطلب/ })) as HTMLButtonElement;
      expect(button.disabled, isPhone ? 'phone' : 'desk').toBe(true);
      fireEvent.click(button);
      expect(apiFetch.mock.calls.some((c) => c[0] === '/api/orders')).toBe(false);
    }
  });
});

describe('A PHONE — where the buttons are', () => {
  it('in the dialog’s foot, outside the body that scrolls, tied to the form by form="…"', async () => {
    phone.value = true;
    await open();
    const body = document.querySelector('[data-modal-body]')!;
    const form = body.querySelector('form')!;
    const submitButton = screen.getByRole('button', { name: /إنشاء الطلب/ });
    expect(body.contains(submitButton), 'الزر لسه داخل الجزء اللي بيتمرّر').toBe(false);
    expect(submitButton.getAttribute('type')).toBe('submit');
    expect(submitButton.getAttribute('form')).toBe(form.id);
    expect(form.id).not.toBe('');
    // cancel is in the foot too, and there is ONE of each
    expect(screen.getAllByRole('button', { name: 'إلغاء' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /إنشاء الطلب/ })).toHaveLength(1);
    expect(body.contains(screen.getByRole('button', { name: 'إلغاء' }))).toBe(false);
  });

  it('the sections lose their frames, the two optional ones are ONE closed fold that says what it holds', async () => {
    phone.value = true;
    await open();
    expect(document.querySelectorAll('[data-modal-body] form > div.border').length, 'إطار القسم').toBe(0);
    const folds = document.querySelectorAll('details[data-advanced-group]');
    expect(folds).toHaveLength(1);
    const fold = folds[0] as HTMLDetailsElement;
    expect(fold.open).toBe(false);
    expect(fold.querySelector('summary')!.textContent).toContain('اختياري');
    expect(fold.querySelector('summary')!.textContent).toContain('المودريتور');
    // the fields are in the fold, and in the page
    expect(fold.contains(screen.getByLabelText('قناة الطلب'))).toBe(true);
    expect(fold.contains(screen.getByPlaceholderText('مثال: يرجى الاتصال قبل الوصول'))).toBe(true);
    // the required ones are not in it
    expect(fold.contains(screen.getByPlaceholderText('مثال: 0936654998'))).toBe(false);
    expect(fold.contains(screen.getByLabelText('المحافظة'))).toBe(false);
  });

  it('the subtitle is gone and the confirm-now box has a 44px label', async () => {
    phone.value = true;
    await open();
    expect(screen.queryByText(/فحص تلقائي للعميل المكرر/)).toBeNull();
    const box = screen.getByRole('checkbox', { name: /الزبون على الخط/ });
    expect(box.getAttribute('class')).toContain('h-5');
    expect(box.getAttribute('class')).toContain('w-5');
    expect(box.closest('label')!.getAttribute('class')).toContain('min-h-11');
  });
});

describe('A DESK — what it was', () => {
  it('buttons at the end of the form, no `form` attribute, one of each', async () => {
    await open();
    const form = document.querySelector('[data-modal-body] form')!;
    const submitButton = screen.getByRole('button', { name: /إنشاء الطلب/ });
    expect(form.contains(submitButton)).toBe(true);
    expect(submitButton.hasAttribute('form')).toBe(false);
    expect(submitButton.parentElement!.parentElement!.getAttribute('class')).toBe('flex items-center justify-end pt-1');
    expect(screen.getAllByRole('button', { name: 'إلغاء' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /إنشاء الطلب/ })).toHaveLength(1);
  });

  it('four framed sections, nothing folded, the subtitle, the plain checkbox', async () => {
    await open();
    expect(document.querySelectorAll('[data-modal-body] form > div.border')).toHaveLength(4);
    expect(document.querySelectorAll('details[data-advanced-group]')).toHaveLength(0);
    expect(screen.getByText('فحص تلقائي للعميل المكرر • تعبئة السعر تلقائياً من العرض • تعيين المودريتور')).toBeTruthy();
    const box = screen.getByRole('checkbox', { name: /الزبون على الخط/ });
    expect(box.getAttribute('class')).toBe('mt-1');
    expect(box.closest('label')!.getAttribute('class')).toBe('flex items-start gap-2 text-sm text-[var(--sys-foreground)]');
    // the frame is the one it always was
    const frame = document.querySelector('[data-modal-body] form > div.border')!;
    expect(frame.getAttribute('class')).toBe('border border-[var(--sys-border)] rounded-lg p-4 bg-[var(--sys-surface)]/60 space-y-3');
  });
});
