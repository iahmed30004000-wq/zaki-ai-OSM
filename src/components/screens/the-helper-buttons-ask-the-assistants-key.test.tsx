// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * THE HELPER BUTTONS ARE DRAWN FOR WHO THE DOOR WILL ANSWER (perm-plan PR-5, UO-06 / UG-F27).
 *
 *   · «مساعدة» on a confirmation card, and «رتّب لي الجولة» on the preparation screen, ask `ai.assist` — a person without
 *     the box would only ever press them to be told «ممنوع»;
 *   · «اسأل الذكاء» on the intelligence centre asks `ai.use`, the key its own door asks;
 *   · and the one helper that is NOT hidden is the AI order entry: with no box it still opens and still enters the order
 *     by the rules, and says why the model was not asked — hiding it would take a working door away from that person.
 */

const { api, apiFetch, user } = vi.hoisted(() => ({
  api: vi.fn(),
  apiFetch: vi.fn(),
  user: { current: { id: 'u1', name: 'سارة', role: 'CONFIRMATION_AGENT', permissions: [] as string[], status: 'ACTIVE' } as Record<string, unknown> },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/confirmation/mine',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: (...a: unknown[]) => apiFetch(...a) }));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ currentUser: user.current, t: { cancel: 'إلغاء' }, locale: 'ar', isRtl: true }),
}));
vi.mock('@/context/StoreCurrency', () => ({ useStoreCurrency: () => ({ code: 'JOD', minorUnit: 2 }) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ done: vi.fn(), warn: vi.fn(), failed: vi.fn() }) }));
vi.mock('@/hooks/useLiveRefresh', () => ({
  useLiveRefresh: (load: () => Promise<unknown>) => {
    const latest = React.useRef(load);
    latest.current = load;
    React.useEffect(() => {
      void latest.current();
    }, []);
  },
}));
vi.mock('@/hooks/useRegions', () => ({
  useRegions: () => ({ regions: [{ id: 'r1', name: 'دمشق' }], countryName: 'سوريا', currency: { code: 'JOD', minorUnit: 2 } }),
}));
vi.mock('@/hooks/useProducts', () => ({ useProducts: () => ({ products: [{ id: 'prod-a', name: 'كريم' }] }) }));
vi.mock('@/components/ui/ProductPicker', () => ({ ProductPicker: () => null }));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => <h1>العنوان</h1> }));
vi.mock('@/components/orders/CustomerHistory', () => ({ CustomerHistoryButton: () => null }));
vi.mock('@/components/orders/ContactButtons', () => ({ ContactButtons: () => null }));
vi.mock('@/components/orders/OrderDetailModal', () => ({ OrderDetailModal: () => null }));
vi.mock('./confirmation/ActionDialogs', () => ({ ChangeRequestDialog: () => null, IssueDialog: () => null, PostponeDialog: () => null, RejectDialog: () => null }));
vi.mock('./confirmation/AssistantDialog', () => ({ AssistantDialog: () => null }));
vi.mock('@/components/screens/ConfirmationPostponedScreen', () => ({ ConfirmationPostponedScreen: () => null }));
vi.mock('@/components/growth/AskAi', () => ({ AskAi: () => <section>صندوق اسأل الذكاء</section> }));
vi.mock('@/components/ui/Tabs', () => ({ Tabs: () => null }));

import { ConfirmationMineScreen } from './ConfirmationMineScreen';
import { PreparationScreen } from './PreparationScreen';
import { IntelligenceScreen } from './IntelligenceScreen';
import { AiOrderModal } from '@/components/orders/AiOrderModal';

const ROW = {
  id: 'o1', orderNumber: 'JO-1', merchantRef: null, confirmationStatus: 'IN_CONFIRMATION', state: 'IN_CONFIRMATION',
  previousOrders: 0, version: 1, totalAmount: 20, currency: 'JOD', claimedAt: null, firstActionAt: '2026-10-28T08:00:00.000Z',
  postponedUntil: null, postponePreferredTime: null, postponeCount: 0, noAnswerCount: 0,
  source: 'MANUAL', moderatorId: 'm1', moderator: { id: 'm1', name: 'منى' }, createdBy: { id: 'm1', name: 'منى' }, channel: null,
  customer: { id: 'c1', fullName: 'سعاد', phone: '0790000000', rawPhone: '0790000000', city: 'عمّان', address: 'شارع' },
  items: [{ id: 'i1', productName: 'كريم', quantity: 1, freeQuantity: 0, lineTotal: 20 }],
  _count: { contactAttempts: 1, notes: 0 }, risk: null, changeRequests: [],
};
const DESK = {
  leadDays: 2, waitingLater: 0, noAnswerLimit: 3, serverNow: '2026-10-28T08:00:00.000Z',
  work: [ROW], noAnswer: [], closedToday: [],
  confirmed: { day: '', q: '', page: 1, pageSize: 25, total: 0, pages: 1, rows: [] },
};
const POOL = { waiting: 0, owned: { total: 1, withoutAttempt: 0 }, caps: { withoutAttempt: 3, total: 10 }, leadDays: 2, canPull: false, refusal: null, autoReleased: 0, orders: null };
const PREPARATION = {
  groups: [{ productId: 'p1', productName: 'كريم', orders: 1, required: 2, available: 5, shortage: 0, lines: [] }],
  totals: { products: 1, orders: 1, shortages: 0 },
  allowNegativeStock: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  api.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/confirmation/mine')) return DESK;
    if (url === '/api/confirmation/queue') return POOL;
    if (url.startsWith('/api/ops/preparation')) return PREPARATION;
    if (url.startsWith('/api/growth/intelligence')) return { findings: [], families: {}, counts: {}, history: [] };
    throw new Error(`unexpected ${url}`);
  });
});
afterEach(cleanup);

const holding = (...keys: string[]) => {
  user.current = { id: 'u1', name: 'سارة', role: 'CONFIRMATION_AGENT', permissions: keys, status: 'ACTIVE' };
};

describe('«مساعدة» on a confirmation card', () => {
  it('is drawn for who holds the desk AND the box', async () => {
    holding('confirmation.work', 'ai.assist');
    render(<ConfirmationMineScreen />);
    await screen.findByText('JO-1');
    expect(screen.getByRole('button', { name: /مساعدة/ })).toBeTruthy();
  });

  it('NEGATIVE: is not drawn without the box — and the rest of the card is (the work stays)', async () => {
    holding('confirmation.work');
    render(<ConfirmationMineScreen />);
    await screen.findByText('JO-1');
    expect(screen.queryByRole('button', { name: /مساعدة/ }), 'زرٌّ لا يُجاب').toBeNull();
    expect(screen.getByRole('button', { name: /إدخال إشكال/ })).toBeTruthy();
  });
});

describe('«رتّب لي الجولة» on the preparation screen', () => {
  it('is drawn with the box', async () => {
    holding('ops.prepare', 'ai.assist');
    render(<PreparationScreen />);
    await screen.findByText('منتجات للتجهيز');
    expect(screen.getByRole('button', { name: 'رتّب لي الجولة' })).toBeTruthy();
  });

  it('NEGATIVE: is not drawn without it — the list below it is the whole screen, and it is there', async () => {
    holding('ops.prepare');
    render(<PreparationScreen />);
    await screen.findByText('منتجات للتجهيز');
    expect(screen.queryByRole('button', { name: 'رتّب لي الجولة' })).toBeNull();
    expect(screen.getByText('كريم')).toBeTruthy();
  });
});

describe('«اسأل الذكاء» on the intelligence centre', () => {
  it('is drawn with ai.use', async () => {
    holding('growth.intelligence', 'ai.use');
    render(<IntelligenceScreen />);
    expect(await screen.findByText('صندوق اسأل الذكاء')).toBeTruthy();
  });

  it('NEGATIVE: is not drawn without ai.use — its door would only answer «ممنوع»', async () => {
    holding('growth.intelligence');
    render(<IntelligenceScreen />);
    await waitFor(() => expect(api).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText('صندوق اسأل الذكاء')).toBeNull();
  });

  it('NEGATIVE: ai.assist is NOT what opens it (a different box for a different helper)', async () => {
    holding('growth.intelligence', 'ai.assist');
    render(<IntelligenceScreen />);
    await waitFor(() => expect(api).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText('صندوق اسأل الذكاء')).toBeNull();
  });
});

describe('the AI order entry is NOT hidden without the box — it says why the model was not asked', () => {
  const PREVIEW = (aiSkipped: string | null) => ({
    parsed: { customerName: 'عبدالله', phone: '0936654998', governorate: 'دمشق', address: 'بانياس', productQuery: 'كريم', quantity: 1, price: null, notes: '', source: '' },
    engine: 'deterministic', matchedProduct: { id: 'prod-a', name: 'كريم', score: 40 }, productMatchConfident: true,
    suggestedPrice: 22, existingCustomer: null, aiSkipped,
  });

  async function parse(aiSkipped: string | null) {
    apiFetch.mockResolvedValue({ ok: true, status: 200, json: async () => PREVIEW(aiSkipped) });
    render(<AiOrderModal isOpen onClose={vi.fn()} onSuccess={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/الاسم:/), { target: { value: 'الاسم: عبدالله' } });
    fireEvent.click(screen.getByRole('button', { name: /تحليل الطلب/ }));
    await screen.findByText(/تأكيد البيانات المستخرجة/);
  }

  it('says the account has no box and the text was read by the rules', async () => {
    await parse('NO_PERMISSION');
    expect(screen.getByText(/ما عنده مفتاح «المساعدون الأذكياء»/)).toBeTruthy();
    expect(screen.queryByText(/نموذج محلي فقط/)).toBeNull();
  });

  it('NEGATIVE: says nothing of the kind when the model was asked, or refused for another reason', async () => {
    await parse(null);
    expect(screen.queryByText(/ما عنده مفتاح «المساعدون الأذكياء»/)).toBeNull();
    cleanup();
    await parse('NOT_LOCAL');
    expect(screen.queryByText(/ما عنده مفتاح «المساعدون الأذكياء»/)).toBeNull();
    expect(screen.getByText(/نموذج محلي فقط/)).toBeTruthy();
  });
});
