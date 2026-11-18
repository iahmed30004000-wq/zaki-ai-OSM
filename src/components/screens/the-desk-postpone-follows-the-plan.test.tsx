// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * REQUEST C2b (18/11): THE DESK'S POSTPONE DIALOG FOLLOWS THE PLAN.
 *
 * Under «إثبات المكالمات وجدول المحاولات» the confirmation door refuses a postponement whose reason is «لا يرد» (409 `NO_ANSWER_NOT_A_POSTPONE`), and the
 * dialog knows how not to offer it (`planOn`, built by C2). «طلباتي» is the only caller of the dialog and it handed nothing: the reason was offered and every
 * pick of it was refused. The desk now hands the plan state it already reads — `cadenceOn` from the server, the very switch the door asks (`cadenceSince`).
 * Plan off (or a server that does not say it): `planOn` is false, and the dialog draws exactly what it drew with the prop left out.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { apiJson, dialogProps } = vi.hoisted(() => ({
  apiJson: vi.fn(),
  dialogProps: [] as Record<string, unknown>[],
}));

vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a), apiFetch: vi.fn() }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/' }));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({
    locale: 'ar',
    t: {},
    currentUser: { id: 'u1', name: 'سارة', role: 'CONFIRMATION_AGENT', permissions: ['confirmation.work', 'confirmation.pull', 'orders.contact_log'], status: 'ACTIVE' },
  }),
}));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => false }));
vi.mock('@/hooks/useLiveRefresh', () => ({
  useLiveRefresh: (load: () => Promise<unknown>) => {
    const latest = React.useRef(load);
    latest.current = load;
    React.useEffect(() => {
      void latest.current();
    }, []);
  },
}));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), done: vi.fn(), warn: vi.fn() }) }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/hooks/useRegions', () => ({ useRegions: () => ({ regions: [], countryName: '', currency: null }) }));
vi.mock('@/components/orders/OrderDetailModal', () => ({ OrderDetailModal: () => null }));
vi.mock('@/components/orders/CreateOrderModal', () => ({ CreateOrderModal: () => null }));
vi.mock('@/components/orders/CustomerHistory', () => ({ CustomerHistoryButton: () => null, CustomerHistoryOffer: () => null }));
vi.mock('@/components/screens/confirmation/ActionDialogs', () => ({
  ChangeRequestDialog: () => null,
  IssueDialog: () => null,
  PostponeDialog: (p: Record<string, unknown>) => {
    dialogProps.push(p);
    return <div role="dialog" aria-label="تأجيل الطلب" />;
  },
  RejectDialog: () => null,
}));
vi.mock('@/components/screens/confirmation/AssistantDialog', () => ({ AssistantDialog: () => null }));
vi.mock('@/components/screens/ConfirmationPostponedScreen', () => ({ ConfirmationPostponedScreen: () => <div /> }));

import { ConfirmationMineScreen } from './ConfirmationMineScreen';

const ROW = {
  id: 'o-1',
  orderNumber: 'SY-26-1001',
  merchantRef: null,
  confirmationStatus: 'IN_PROGRESS',
  state: 'IN_PROGRESS',
  previousOrders: 0,
  version: 4,
  totalAmount: 45,
  currency: 'SYP',
  claimedAt: null,
  firstActionAt: null,
  postponedUntil: null,
  postponePreferredTime: null,
  postponeCount: 0,
  noAnswerCount: 1,
  source: 'LANDING_PAGE',
  regionId: 'r1',
  region: { name: 'دمشق' },
  moderatorId: null,
  moderator: null,
  createdBy: null,
  channel: null,
  customer: { id: 'c1', fullName: 'نور', phone: '0952554562', rawPhone: '0952554562', city: 'دمشق', address: 'شارع' },
  items: [],
  _count: { contactAttempts: 1, notes: 0 },
  risk: null,
};

/** What the desk's answer says about the plan: `cadenceOn: true`, `cadenceOn: false`, or no key at all (the server's answer with the plan off). */
let plan: 'on' | 'off-key' | 'absent' = 'absent';

beforeEach(() => {
  vi.clearAllMocks();
  dialogProps.length = 0;
  plan = 'absent';
  window.localStorage.clear();
  window.sessionStorage.clear();
  apiJson.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/confirmation/mine')) {
      return {
        leadDays: 2,
        waitingLater: 0,
        noAnswerLimit: plan === 'on' ? 5 : 3,
        dialCode: '963',
        serverNow: new Date().toISOString(),
        work: [ROW],
        noAnswer: [],
        closedToday: [],
        confirmed: { day: '', q: '', page: 1, pageSize: 25, total: 0, pages: 1, rows: [] },
        ...(plan === 'on' ? { cadenceOn: true } : plan === 'off-key' ? { cadenceOn: false } : {}),
      };
    }
    if (url === '/api/confirmation/queue') {
      return { waiting: 5, owned: { total: 1, withoutAttempt: 0 }, caps: { withoutAttempt: 3, total: 10 }, leadDays: 2, canPull: true, refusal: null, autoReleased: 0, orders: null };
    }
    if (url === '/api/settings/messages') return { templates: [] };
    if (url.endsWith('/contact-attempts')) return { attempts: [] };
    return { ok: true };
  });
});
afterEach(() => cleanup());

const openPostpone = async () => {
  render(<ConfirmationMineScreen />);
  await screen.findByText('SY-26-1001');
  fireEvent.click(screen.getByRole('button', { name: /^تأجيل/ }));
  await screen.findByRole('dialog', { name: 'تأجيل الطلب' });
  return dialogProps[dialogProps.length - 1];
};

describe('the desk hands the plan to its postpone dialog', () => {
  it('plan ON (`cadenceOn` from the server): the dialog gets `planOn` true — «لا يرد» is not offered, as the door refuses it', async () => {
    plan = 'on';
    const p = await openPostpone();
    expect(p.planOn).toBe(true);
  });

  it('plan OFF (no `cadenceOn` key, the server’s answer today): `planOn` is false — never true', async () => {
    plan = 'absent';
    const p = await openPostpone();
    expect(p.planOn).toBe(false);
  });

  it('plan OFF spelled out (`cadenceOn: false`): `planOn` is false', async () => {
    plan = 'off-key';
    const p = await openPostpone();
    expect(p.planOn).toBe(false);
  });

  it('every other prop is what the desk handed before C2b (the line adds one prop, changes none)', async () => {
    plan = 'on';
    const p = await openPostpone();
    expect(Object.keys(p).sort()).toEqual(['busy', 'noAnswerLock', 'onClose', 'onSubmit', 'open', 'orderNumber', 'planOn', 'postponeCount']);
    expect(p.orderNumber).toBe('SY-26-1001');
    expect(p.postponeCount).toBe(0);
    expect(p.noAnswerLock).toBeNull();
  });
});

describe('the real dialog: `planOn` false draws exactly what the prop left out drew (plan off = the dialog on main)', () => {
  it('same DOM, «لا يرد» offered in both', async () => {
    const real = await vi.importActual<typeof import('@/components/screens/confirmation/ActionDialogs')>('@/components/screens/confirmation/ActionDialogs');
    const base = { open: true, orderNumber: 'SY-26-1001', postponeCount: 0, noAnswerLock: null, onClose: () => undefined, onSubmit: () => undefined };
    const drawn = (extra: { planOn?: boolean }) => {
      const { unmount } = render(<real.PostponeDialog {...base} {...extra} />);
      const html = document.body.innerHTML.replace(/_r_[0-9a-z]+_|:r[0-9a-z]+:/g, 'ID');
      const offered = [...document.querySelectorAll('option')].map((o) => o.getAttribute('value'));
      unmount();
      return { html, offered };
    };
    const without = drawn({});
    const off = drawn({ planOn: false });
    const on = drawn({ planOn: true });
    expect(off.html).toBe(without.html);
    expect(without.offered).toContain('NO_ANSWER');
    expect(on.offered).not.toContain('NO_ANSWER');
  });
});
