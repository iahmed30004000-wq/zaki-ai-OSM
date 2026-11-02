// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { stripComments, repoFile } from '@/lib/guard-source';

/**
 * «الزبون على الخط — أكّده الآن» — AN OPTION OF THE ONE FORM, NOT A BUTTON ON ANOTHER SCREEN.
 *
 * The shipping-batches screen carried «أضف طلباً مؤكداً»: a second button that opened a second
 * copy of the new-order form and then confirmed the result. The option lives in the form now:
 *
 *   · it is drawn only for somebody who holds `orders.confirm` (the door asks the same);
 *   · ticked, the order is created as ever and THEN confirmed through the ordinary
 *     confirmation door — the same two requests the batches screen made;
 *   · unticked, nothing about creating an order is different;
 *   · if confirming is refused the order still exists and the message says exactly that.
 */

const { apiFetch, apiJson, toast, user } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  apiJson: vi.fn(),
  toast: { done: vi.fn(), warn: vi.fn(), failed: vi.fn() },
  user: { current: null as unknown },
}));

vi.mock('@/lib/api-client', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a), apiJson: (...a: unknown[]) => apiJson(...a) }));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ t: (k: string) => k, locale: 'ar', isRtl: true, currentUser: user.current }),
}));
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

const CONFIRMER = { id: 'u1', status: 'ACTIVE', role: 'MANAGER', permissions: ['orders.create', 'orders.confirm'] };
const ENTRY_ONLY = { id: 'u2', status: 'ACTIVE', role: 'MODERATOR', permissions: ['orders.create'] };
const ORDER = { id: 'o-1', orderNumber: 'ORD-26-0001' };

const onSuccess = vi.fn<(order?: { id: string; orderNumber?: string }) => void>();
let confirmRefusal: string | null;

beforeEach(() => {
  vi.clearAllMocks();
  user.current = CONFIRMER;
  confirmRefusal = null;
  apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/orders' && init?.method === 'POST') return { ok: true, json: async () => ({ order: ORDER }) };
    return { ok: true, json: async () => ({}) };
  });
  apiJson.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      if (confirmRefusal) throw new Error(confirmRefusal);
      return {};
    }
    return { order: { version: 4 } };
  });
});
afterEach(cleanup);

const open = async () => {
  render(<CreateOrderModal isOpen onClose={() => {}} onSuccess={onSuccess} />);
  await screen.findByLabelText('المحافظة');
};
const fill = () => {
  fireEvent.change(screen.getByPlaceholderText('مثال: 0936654998'), { target: { value: '0791234567' } });
  fireEvent.change(screen.getByPlaceholderText('مثال: عبدالله عبدالقادر'), { target: { value: 'سامر أحمد' } });
  fireEvent.change(screen.getByPlaceholderText('الشارع، البناء، المنطقة...'), { target: { value: 'عمّان - الجبيهة' } });
  fireEvent.change(screen.getByLabelText('المحافظة'), { target: { value: 'r1' } });
};
const submit = async () => {
  const button = await screen.findByRole('button', { name: /إنشاء الطلب/ });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  await act(async () => {
    fireEvent.click(button);
  });
};
const confirmCalls = () => apiJson.mock.calls.filter((c) => String(c[0]).endsWith('/confirmation'));

describe('who is offered it', () => {
  it('somebody who may confirm sees the option, unticked', async () => {
    await open();
    const box = screen.getByRole('checkbox', { name: /الزبون على الخط/ }) as HTMLInputElement;
    expect(box.checked).toBe(false);
  });

  it('NEGATIVE: an entry-only moderator is not offered it — confirming is not theirs', async () => {
    user.current = ENTRY_ONLY;
    await open();
    expect(screen.queryByRole('checkbox', { name: /الزبون على الخط/ })).toBeNull();
    expect(screen.queryByText(/أكّده الآن/)).toBeNull();
  });
});

describe('ticked', () => {
  it('creates the order, then confirms it through the ordinary door — with the version it read', async () => {
    await open();
    fill();
    fireEvent.click(screen.getByRole('checkbox', { name: /الزبون على الخط/ }));
    expect(screen.getByRole('button', { name: /إنشاء الطلب وتأكيده/ })).toBeTruthy();
    await submit();
    await waitFor(() => expect(confirmCalls()).toHaveLength(1));
    const [url, init] = confirmCalls()[0];
    expect(url).toBe('/api/orders/o-1/confirmation');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ action: 'confirm', expectedVersion: 4 });
    expect(toast.done).toHaveBeenCalledTimes(1);
    expect(toast.done.mock.calls[0][0]).toContain('ORD-26-0001');
    expect(toast.done.mock.calls[0][0]).toContain('وتأكيده');
    expect(onSuccess).toHaveBeenCalledWith(ORDER);
  });

  it('a refusal to confirm leaves the order made, and says so', async () => {
    confirmRefusal = 'الطلب مقفول';
    await open();
    fill();
    fireEvent.click(screen.getByRole('checkbox', { name: /الزبون على الخط/ }));
    await submit();
    await waitFor(() => expect(toast.warn).toHaveBeenCalled());
    expect(toast.warn.mock.calls[0][0]).toContain('أُنشئ ORD-26-0001 لكن تعذّر تأكيده');
    expect(toast.warn.mock.calls[0][0]).toContain('الطلب مقفول');
    expect(toast.done).not.toHaveBeenCalled();
    expect(onSuccess).toHaveBeenCalledWith(ORDER);
  });

  it('NEGATIVE: if the order itself could not be created nothing is confirmed', async () => {
    apiFetch.mockImplementation(async (url: string, init?: RequestInit) =>
      url === '/api/orders' && init?.method === 'POST'
        ? { ok: false, json: async () => ({ error: 'رقم محظور' }) }
        : { ok: true, json: async () => ({}) }
    );
    await open();
    fill();
    fireEvent.click(screen.getByRole('checkbox', { name: /الزبون على الخط/ }));
    await submit();
    await waitFor(() => expect(toast.failed).toHaveBeenCalledWith('رقم محظور'));
    expect(apiJson).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });
});

describe('unticked', () => {
  it('creating an order is exactly what it was — no confirmation request at all', async () => {
    await open();
    fill();
    await submit();
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(ORDER));
    expect(apiJson).not.toHaveBeenCalled();
    expect(toast.done.mock.calls[0][0]).toBe('تم إنشاء الطلب ORD-26-0001 بنجاح');
  });

  it('and the option does not carry over to the next time the form opens', async () => {
    const { rerender } = render(<CreateOrderModal isOpen onClose={() => {}} onSuccess={onSuccess} />);
    await screen.findByLabelText('المحافظة');
    fireEvent.click(screen.getByRole('checkbox', { name: /الزبون على الخط/ }));
    rerender(<CreateOrderModal isOpen={false} onClose={() => {}} onSuccess={onSuccess} />);
    rerender(<CreateOrderModal isOpen onClose={() => {}} onSuccess={onSuccess} />);
    await screen.findByLabelText('المحافظة');
    expect((screen.getByRole('checkbox', { name: /الزبون على الخط/ }) as HTMLInputElement).checked).toBe(false);
  });
});

describe('the batches screen', () => {
  it('no longer carries its own button, its own copy of the form, or its own confirmation call', () => {
    const src = stripComments(repoFile('src/components/screens/ShippingBatchesScreen.tsx'));
    expect(src).not.toContain('CreateOrderModal');
    expect(src).not.toContain('أضف طلباً مؤكداً');
    expect(src).not.toContain("action: 'confirm'");
  });

  it('and the confirmation call is written once', () => {
    const src = stripComments(repoFile('src/lib/confirm-now.ts'));
    expect(src).toContain("action: 'confirm'");
    expect(stripComments(repoFile('src/components/orders/CreateOrderModal.tsx'))).not.toContain("action: 'confirm'");
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «أكّده الآن» MEETS A CONFIRMED TWIN (the owner, 2/11).
 *
 * The door refuses a yes for a customer who already has a confirmed order for the same product (`TWIN_CONFIRMED`). This form must
 * not read that as «try again»: pressing confirm a second time is the mistake the door is there to stop. The order was made; the
 * message says the customer has a confirmed twin, names it, and says what to do INSTEAD of «أكّده من شاشة الطلبات» — and the form
 * never sends the acknowledgement: a tick box in the middle of a call is not the answer to a question nobody asked.
 * ═══════════════════════════════════════════════════════════════════════
 */
describe('the door holds the yes back for a confirmed twin', () => {
  const SENTENCE = 'الزبون عنده طلب مؤكَّد بنفس المنتج (ORD-2026-1711) — إذا هالطلب مكرر ارفضه كمكرر، وإذا طلب تاني فعلاً أكّده وانت متأكد';
  const TWIN = {
    error: SENTENCE,
    errorAr: SENTENCE,
    code: 'TWIN_CONFIRMED',
    twins: [
      { orderNumber: 'ORD-2026-1711', confirmedAt: '2026-11-02T09:30:00.000Z', confirmedByName: 'سارة' },
      { orderNumber: 'ORD-2026-1701', confirmedAt: null, confirmedByName: null },
    ],
  };

  const refuseWith = (data: Record<string, unknown>, message = SENTENCE) =>
    apiJson.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') throw Object.assign(new Error(message), { status: 409, data });
      return { order: { version: 4 } };
    });
  const tickAndSubmit = async () => {
    await open();
    fill();
    fireEvent.click(screen.getByRole('checkbox', { name: /الزبون على الخط/ }));
    await submit();
    await waitFor(() => expect(toast.warn).toHaveBeenCalled());
  };

  it('the order stays made, and the message says the customer has a confirmed twin, names it, and says what to do instead', async () => {
    refuseWith(TWIN);
    await tickAndSubmit();
    const said = toast.warn.mock.calls[0][0] as string;
    expect(said).toContain('أُنشئ ORD-26-0001 لكن تعذّر تأكيده: عند الزبون طلب مؤكَّد بنفس المنتج (ORD-2026-1711، ORD-2026-1701)');
    expect(said).toContain('افتحه من شاشة الطلبات: ارفضه كمكرر، أو أكّده إذا هو طلب تاني فعلاً.');
    // the usual advice would have been a push to press it again
    expect(said).not.toContain('— أكّده من شاشة الطلبات.');
    expect(toast.done).not.toHaveBeenCalled();
    expect(onSuccess).toHaveBeenCalledWith(ORDER);
  });

  it('it asked ONCE, plainly: one confirmation request, at the version it read, and it carries no acknowledgement', async () => {
    refuseWith(TWIN);
    await tickAndSubmit();
    expect(confirmCalls()).toHaveLength(1);
    expect(JSON.parse(String((confirmCalls()[0][1] as RequestInit).body))).toEqual({ action: 'confirm', expectedVersion: 4 });
  });

  it('NEGATIVE: any other refusal keeps the usual advice, word for word', async () => {
    refuseWith({ code: 'REGION_REQUIRED' }, 'حدّد المحافظة أولاً');
    await tickAndSubmit();
    expect(toast.warn.mock.calls[0][0]).toBe('أُنشئ ORD-26-0001 لكن تعذّر تأكيده: حدّد المحافظة أولاً — أكّده من شاشة الطلبات.');
  });

  it('NEGATIVE: a body with the twins but not the code is just a refusal', async () => {
    refuseWith({ twins: TWIN.twins }, 'مرفوض');
    await tickAndSubmit();
    expect(toast.warn.mock.calls[0][0]).toBe('أُنشئ ORD-26-0001 لكن تعذّر تأكيده: مرفوض — أكّده من شاشة الطلبات.');
  });

  it('confirmOrderNow returns it as a result with its own code, not as a throw', async () => {
    refuseWith(TWIN);
    const { confirmOrderNow } = await import('@/lib/confirm-now');
    expect(await confirmOrderNow('o-1')).toEqual({
      ok: false,
      code: 'TWIN_CONFIRMED',
      reason: 'عند الزبون طلب مؤكَّد بنفس المنتج (ORD-2026-1711، ORD-2026-1701)',
      then: 'افتحه من شاشة الطلبات: ارفضه كمكرر، أو أكّده إذا هو طلب تاني فعلاً.',
    });
  });

  it('and the form never writes the acknowledgement: no `acknowledgeTwin` in the call, none in the form', () => {
    expect(stripComments(repoFile('src/lib/confirm-now.ts'))).not.toContain('acknowledgeTwin');
    expect(stripComments(repoFile('src/lib/confirm-now.ts'))).not.toContain('confirmAnywayBody');
    expect(stripComments(repoFile('src/components/orders/CreateOrderModal.tsx'))).not.toContain('acknowledgeTwin');
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════
 * T-06 — THE DOOR SAYS WHETHER THE YES WILL COME («انعمل ولكن ما اتأكد»).
 *
 * Ticked, the form tells the creation door so (`confirmNow: true`): for an agent bound by «اشتغل على اللي بإيدك» the order becomes
 * hers and the call she is on is recorded. The door answers `confirmNow.ready`; when it is false (the 300 cap sent the order to the
 * pool, the box is not hers to tick, no governorate) the form says «انعمل … ولكن ما اتأكد» with the reason — ONE message — and does
 * not make the confirmation call it already knows will be refused.
 * ═══════════════════════════════════════════════════════════════════════
 */
describe('the creation door answers whether the yes will come', () => {
  const CAP = 'وصلت للحد (300) — الطلب راح للطابور';
  const createWith = (extra: Record<string, unknown>) =>
    apiFetch.mockImplementation(async (url: string, init?: RequestInit) =>
      url === '/api/orders' && init?.method === 'POST'
        ? { ok: true, json: async () => ({ order: ORDER, ...extra }) }
        : { ok: true, json: async () => ({}) }
    );
  const createBody = () => {
    const call = apiFetch.mock.calls.find((c) => c[0] === '/api/orders' && (c[1] as RequestInit | undefined)?.method === 'POST');
    return JSON.parse(String((call?.[1] as RequestInit).body)) as Record<string, unknown>;
  };

  it('ticked, the order is sent with «confirmNow: true»; unticked, the body carries no such key at all', async () => {
    await open();
    fill();
    fireEvent.click(screen.getByRole('checkbox', { name: /الزبون على الخط/ }));
    await submit();
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(createBody().confirmNow).toBe(true);
    cleanup();
    vi.clearAllMocks();
    await open();
    fill();
    await submit();
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect('confirmNow' in createBody()).toBe(false);
  });

  it('NEGATIVE: ready false (the cap) — ONE warning «انعمل … ولكن ما اتأكد — <reason>», and no confirmation call', async () => {
    createWith({ notice: CAP, confirmNow: { ready: false, code: 'CAP_FULL', reason: CAP } });
    await open();
    fill();
    fireEvent.click(screen.getByRole('checkbox', { name: /الزبون على الخط/ }));
    await submit();
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(ORDER));
    expect(confirmCalls()).toHaveLength(0);
    expect(apiJson).not.toHaveBeenCalled();
    expect(toast.warn).toHaveBeenCalledTimes(1);
    expect(toast.warn.mock.calls[0][0]).toBe(`انعمل الطلب ORD-26-0001 ولكن ما اتأكد — ${CAP}`);
    expect(toast.done).not.toHaveBeenCalled();
  });

  it('ready true — the ordinary confirmation call follows', async () => {
    createWith({ confirmNow: { ready: true } });
    await open();
    fill();
    fireEvent.click(screen.getByRole('checkbox', { name: /الزبون على الخط/ }));
    await submit();
    await waitFor(() => expect(confirmCalls()).toHaveLength(1));
    expect(toast.done.mock.calls[0][0]).toContain('وتأكيده');
  });

  it('the governorate is required on the form, so the box cannot send an order the door will refuse to confirm', async () => {
    await open();
    expect((screen.getByLabelText('المحافظة') as HTMLSelectElement).required).toBe(true);
  });
});
