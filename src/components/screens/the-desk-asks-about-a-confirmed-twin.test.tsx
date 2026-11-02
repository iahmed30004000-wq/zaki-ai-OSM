// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@/lib/guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE AGENT'S DESK («طلباتي») ASKS, WHEN THE DOOR SAYS THE CUSTOMER ALREADY HAS A CONFIRMED TWIN (the owner, 2/11).
 *
 * «تأكيد الطلب» on a card posts the confirmation. When the door answers 409 `TWIN_CONFIRMED` nothing was written; the desk must not
 * print a red line and leave her there — it opens the shared dialog and lets her say what the order is: the same one sent again
 * («رفضه كمكرر») or a second one on purpose («طلب تاني فعلاً — أكّد»).
 *
 * DEFINITION OF DONE: the dialog opens on that 409 and on no other (the red line of every other refusal is unchanged); each of the
 * three buttons sends exactly its body — reject as a duplicate / confirm with `acknowledgeTwin` / nothing — at the version the card
 * was drawn at; after a decision the desk reloads and says in a toast what happened; a stale version is the desk's own red line;
 * and the same dialog stands on a phone.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { apiJson, apiFetch, user, toast, phone } = vi.hoisted(() => ({
  apiJson: vi.fn(),
  apiFetch: vi.fn(),
  user: { current: null as unknown },
  toast: { failed: vi.fn(), done: vi.fn(), warn: vi.fn() },
  phone: { current: false },
}));

vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a), apiFetch: (...a: unknown[]) => apiFetch(...a) }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/' }));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ locale: 'ar', t: {}, currentUser: user.current }) }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => phone.current }));
vi.mock('@/hooks/useRegions', () => ({
  useRegions: () => ({ regions: [{ id: 'r-dam', name: 'دمشق' }], countryName: 'سوريا', currency: null, loading: false }),
}));
vi.mock('@/hooks/useLiveRefresh', () => ({
  useLiveRefresh: (load: () => Promise<unknown>) => {
    const latest = React.useRef(load);
    latest.current = load;
    React.useEffect(() => {
      void latest.current();
    }, []);
  },
}));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => <h1>طلباتي</h1> }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => toast }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/components/orders/OrderDetailModal', () => ({ OrderDetailModal: () => null }));
vi.mock('@/components/orders/CustomerHistory', () => ({ CustomerHistoryButton: () => null, CustomerHistoryOffer: () => null }));
vi.mock('@/components/orders/ContactButtons', () => ({ ContactButtons: () => <i data-contact /> }));
vi.mock('@/components/screens/confirmation/AssistantDialog', () => ({ AssistantDialog: () => null }));
vi.mock('@/components/confirmation/PullPanel', () => ({ PullPanel: () => null, useQueue: () => ({ reload: vi.fn() }) }));

import { ConfirmationMineScreen } from './ConfirmationMineScreen';

const TWIN_SENTENCE = 'الزبون عنده طلب مؤكَّد بنفس المنتج (ORD-2026-1711) — إذا هالطلب مكرر ارفضه كمكرر، وإذا طلب تاني فعلاً أكّده وانت متأكد';
const TWIN_BODY = {
  error: TWIN_SENTENCE,
  errorAr: TWIN_SENTENCE,
  code: 'TWIN_CONFIRMED',
  twins: [{ orderNumber: 'ORD-2026-1711', confirmedAt: new Date(Date.now() - 12 * 60_000).toISOString(), confirmedByName: 'سارة' }],
};
const refused = (message: string, data: Record<string, unknown>) => Object.assign(new Error(message), { status: 409, data });
const TITLE = 'الزبون عنده طلب مؤكَّد بنفس المنتج';

const card = () => ({
  id: 'W1',
  orderNumber: 'ORD-W1',
  merchantRef: null,
  confirmationStatus: 'IN_PROGRESS',
  state: 'CLAIMED',
  previousOrders: 0,
  version: 4,
  totalAmount: 45,
  currency: 'JOD',
  claimedAt: null,
  firstActionAt: null,
  postponedUntil: null,
  postponePreferredTime: null,
  postponeCount: 0,
  noAnswerCount: 0,
  source: 'LANDING_PAGE',
  moderatorId: null,
  moderator: null,
  createdBy: null,
  channel: null,
  deliveryAddress: 'شارع الجلاء',
  regionId: 'r-dam',
  region: { name: 'دمشق' },
  customerNotes: null,
  customer: { id: 'c1', fullName: 'زبون', phone: '0790000001', rawPhone: '0790000001', city: 'دمشق', address: 'عنوان' },
  items: [{ id: 'l1', productName: 'كريم', quantity: 1, freeQuantity: 0, lineTotal: 45 }],
  addOns: [],
  // she has already called: the buttons are open
  _count: { contactAttempts: 1, notes: 0 },
});
const desk = () => ({
  leadDays: 2,
  waitingLater: 0,
  noAnswerLimit: 3,
  serverNow: '2026-11-02T08:00:00.000Z',
  work: [card()],
  noAnswer: [],
  closedToday: [],
  confirmed: { day: '2026-11-02', q: '', page: 1, pageSize: 25, total: 0, pages: 1, rows: [] },
});

/** What the confirmation door answers to the calls the test lets through, in order. */
let doorAnswers: (() => unknown)[];
const doorCalls = () =>
  apiJson.mock.calls
    .filter((c) => String(c[0]).endsWith('/confirmation'))
    .map((c) => ({ url: String(c[0]), body: JSON.parse(String((c[1] as { body: string }).body)) as Record<string, unknown> }));
const deskLoads = () => apiJson.mock.calls.filter((c) => String(c[0]).startsWith('/api/confirmation/mine')).length;

async function draw() {
  user.current = { id: 'u1', name: 'سارة', role: 'CONFIRMATION_AGENT', permissions: ['confirmation.work', 'orders.contact_log'], status: 'ACTIVE' };
  apiJson.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/confirmation/mine')) return desk();
    if (url.endsWith('/confirmation')) {
      const next = doorAnswers.shift();
      if (!next) return { success: true };
      return next();
    }
    throw new Error(`unexpected ${url}`);
  });
  apiFetch.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({}), clone() { return this; } }));
  render(<ConfirmationMineScreen />);
  await screen.findByText('ORD-W1');
}
const pressConfirm = () => fireEvent.click(screen.getByRole('button', { name: /تأكيد الطلب/ }));
const twinDialog = () => screen.findByRole('dialog', { name: TITLE });
const noTwinDialog = () => screen.queryByRole('dialog', { name: TITLE });
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

beforeEach(() => {
  vi.clearAllMocks();
  phone.current = false;
  doorAnswers = [() => Promise.reject(refused(TWIN_SENTENCE, TWIN_BODY))];
});
afterEach(cleanup);

describe('when the door answers TWIN_CONFIRMED', () => {
  it('the dialog opens on the card’s order and lists the other order by number, colleague and time — and the red line stays empty', async () => {
    await draw();
    pressConfirm();
    const d = await twinDialog();
    expect(d.textContent).toContain('ORD-W1');
    expect(d.textContent).toContain('ORD-2026-1711 — أكّده سارة قبل 12 د');
    expect(screen.queryByText(TWIN_SENTENCE)).toBeNull();
    expect(toast.done).not.toHaveBeenCalled();
  });

  it('the first call was the plain confirm at the card’s version — it carries no acknowledgement', async () => {
    await draw();
    pressConfirm();
    await twinDialog();
    expect(doorCalls()).toEqual([{ url: '/api/orders/W1/confirmation', body: { action: 'confirm', expectedVersion: 4 } }]);
  });

  it('«رفضه كمكرر» sends the door’s own reject with the reason that already exists, reloads the desk and says so', async () => {
    await draw();
    pressConfirm();
    await twinDialog();
    const loadsBefore = deskLoads();
    fireEvent.click(button('رفضه كمكرر'));
    await waitFor(() => expect(doorCalls()).toHaveLength(2));
    expect(doorCalls()[1]).toEqual({
      url: '/api/orders/W1/confirmation',
      body: { action: 'reject', rejectionReason: 'DUPLICATE_ORDER', expectedVersion: 4 },
    });
    await waitFor(() => expect(toast.done).toHaveBeenCalledWith('رُفض الطلب ORD-W1 كمكرر'));
    expect(deskLoads()).toBeGreaterThan(loadsBefore);
    expect(noTwinDialog()).toBeNull();
  });

  it('«طلب تاني فعلاً — أكّد» sends the confirm again with her word, at the same version, and says «تم تأكيد الطلب»', async () => {
    await draw();
    pressConfirm();
    await twinDialog();
    fireEvent.click(button('طلب تاني فعلاً — أكّد'));
    await waitFor(() => expect(doorCalls()).toHaveLength(2));
    expect(doorCalls()[1]).toEqual({
      url: '/api/orders/W1/confirmation',
      body: { action: 'confirm', acknowledgeTwin: true, expectedVersion: 4 },
    });
    await waitFor(() => expect(toast.done).toHaveBeenCalled());
    expect(toast.done.mock.calls[0][0]).toBe('تم تأكيد الطلب ORD-W1');
    expect(noTwinDialog()).toBeNull();
  });

  it('«رجوع» sends nothing, says nothing, reloads nothing: the card is as it was', async () => {
    await draw();
    pressConfirm();
    await twinDialog();
    const loadsBefore = deskLoads();
    fireEvent.click(button('رجوع'));
    expect(noTwinDialog()).toBeNull();
    expect(doorCalls()).toHaveLength(1);
    expect(toast.done).not.toHaveBeenCalled();
    expect(deskLoads()).toBe(loadsBefore);
    expect(screen.getByRole('button', { name: /تأكيد الطلب/ })).toBeTruthy();
  });

  it('a stale version is the desk’s own red line with the door’s sentence — the dialog is gone and nothing is claimed done', async () => {
    await draw();
    pressConfirm();
    await twinDialog();
    const stale = 'عدّل هذا الطلبَ شخصٌ آخر قبلك — أعد تحميل الصفحة ثم احفظ';
    doorAnswers.push(() => Promise.reject(refused(stale, { error: stale, errorAr: 'تم تعديل هذا الطلب بواسطة مستخدم آخر.', code: 'VERSION_CONFLICT' })));
    fireEvent.click(button('طلب تاني فعلاً — أكّد'));
    expect(await screen.findByText(stale)).toBeTruthy();
    expect(noTwinDialog()).toBeNull();
    expect(toast.done).not.toHaveBeenCalled();
  });

  it('the same stale version on «رفضه كمكرر» is said the same way', async () => {
    await draw();
    pressConfirm();
    await twinDialog();
    const stale = 'عدّل هذا الطلبَ شخصٌ آخر قبلك — أعد تحميل الصفحة ثم احفظ';
    doorAnswers.push(() => Promise.reject(refused(stale, { error: stale, code: 'VERSION_CONFLICT' })));
    fireEvent.click(button('رفضه كمكرر'));
    expect(await screen.findByText(stale)).toBeTruthy();
    expect(toast.done).not.toHaveBeenCalled();
  });
});

describe('NEGATIVE: every other refusal is the red line it always was', () => {
  it('the contact-first refusal keeps its two-part sentence and opens no dialog', async () => {
    doorAnswers = [() => Promise.reject(refused('اتصل بالزبون أول — أو اكبس «لا يرد»', { code: 'CONTACT_FIRST' }))];
    await draw();
    pressConfirm();
    expect(await screen.findByText(/اتصل بالزبون أول/)).toBeTruthy();
    expect(noTwinDialog()).toBeNull();
  });

  it('the invalid-transition refusal keeps its «حدّث الشاشة» advice and opens no dialog', async () => {
    doorAnswers = [() => Promise.reject(refused('لا يمكن الانتقال من «لا يرد» إلى «مؤكد»', { code: 'INVALID_TRANSITION' }))];
    await draw();
    pressConfirm();
    expect(await screen.findByText(/حدّث الشاشة/)).toBeTruthy();
    expect(noTwinDialog()).toBeNull();
  });

  it('a body that has the twins but not the code is not the question', async () => {
    doorAnswers = [() => Promise.reject(refused('شي تاني', { twins: TWIN_BODY.twins }))];
    await draw();
    pressConfirm();
    expect(await screen.findByText('شي تاني')).toBeTruthy();
    expect(noTwinDialog()).toBeNull();
  });

  it('an ordinary confirmation says «تم تأكيد الطلب» and opens no dialog', async () => {
    doorAnswers = [() => Promise.resolve({ success: true })];
    await draw();
    pressConfirm();
    await waitFor(() => expect(toast.done).toHaveBeenCalled());
    expect(toast.done.mock.calls[0][0]).toBe('تم تأكيد الطلب ORD-W1');
    expect(noTwinDialog()).toBeNull();
  });
});

describe('on a phone', () => {
  it('the same question, the same three buttons — each 44px tall and the full width — and the same bodies', async () => {
    phone.current = true;
    await draw();
    pressConfirm();
    const d = await twinDialog();
    expect(d.textContent).toContain('ORD-2026-1711');
    for (const name of ['رفضه كمكرر', 'طلب تاني فعلاً — أكّد', 'رجوع']) {
      expect(button(name).classList.contains('h-11'), name).toBe(true);
      expect(button(name).classList.contains('w-full'), name).toBe(true);
    }
    fireEvent.click(button('رفضه كمكرر'));
    await waitFor(() => expect(doorCalls()).toHaveLength(2));
    expect(doorCalls()[1].body).toEqual({ action: 'reject', rejectionReason: 'DUPLICATE_ORDER', expectedVersion: 4 });
  });
});

describe('the file', () => {
  const src = stripComments(readFileSync(join(process.cwd(), 'src/components/screens/ConfirmationMineScreen.tsx'), 'utf8'));

  it('draws the shared dialog and takes the two bodies from the one builder — it never writes the acknowledgement itself', () => {
    expect(src).toContain("from '@/components/orders/TwinConfirmedDialog'");
    expect(src).toMatch(/<TwinConfirmedDialog\b/);
    expect(src).toContain('confirmAnywayBody(order.version)');
    expect(src).toContain('rejectAsDuplicateBody(order.version)');
    expect(src).not.toMatch(/acknowledgeTwin\s*:/);
    expect(src).not.toContain("rejectionReason: 'DUPLICATE_ORDER'");
  });

  it('reads the refusal with the shared parser, and an unrecognised refusal still reaches `refusalText`', () => {
    expect(src).toContain('twinsFromRefusal(');
    expect(src).not.toContain("'TWIN_CONFIRMED'");
    expect(src).toContain('if (!answered?.(e)) setError(refusalText(e));');
  });
});
