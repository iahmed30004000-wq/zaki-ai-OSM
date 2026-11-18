// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';

/**
 * «العمولات» ON THE KIT (R13h, 18/11).
 *
 * The screen, its three panels and the estimate card moved onto the shared frame, card, button, icon button, segmented
 * choice and checkbox. A money screen may look different; nothing a person is paid, writes or is told may change. This
 * file holds what a careless restyle breaks without noticing:
 *
 *   inside the two rule forms every kit button that is not the save is `type="button"` (the kit sets no default type,
 *     and a «×» that submits writes a rule nobody finished);
 *   the payout keeps the dialog's own busy flag: a double press sends ONE payout, and the kit's second flag is not running;
 *   every request body is the one the old screen sent — a rule, the end of a rule, a payout, the estimate;
 *   «صرف» and the two rule presses are still drawn only for their keys;
 *   the page-level blocks are cards a theme may decorate, the nested ones are plain;
 *   the two date fields are native single-day fields (decision 6), not a span picker.
 *
 * jsdom has no layout; the phone case holds what the 375px layout depends on (no fixed width, rows become cards).
 */

const { apiJson, user, phone, failed } = vi.hoisted(() => ({
  apiJson: vi.fn(),
  user: { current: null as unknown },
  phone: { value: false },
  failed: vi.fn(),
}));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a) }));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ locale: 'ar', isRtl: true, t: {}, currentUser: user.current }),
}));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed, done: vi.fn(), show: vi.fn() }) }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => phone.value }));
vi.mock('@/hooks/useLiveRefresh', () => ({
  useLiveRefresh: (load: () => unknown) => {
    const latest = React.useRef(load);
    latest.current = load;
    React.useEffect(() => {
      void latest.current();
    }, []);
  },
}));

import { CommissionSettingsScreen } from './CommissionSettingsScreen';
import { PayoutDialog } from './commission/PayoutDialog';
import { AgentCommissionCard } from '@/components/settings/AgentCommissionCard';
import { routeLabel } from '@/lib/route-registry';
import { CARD_CLASS } from '@/lib/theme-shape';
import { AGENT_COMMISSION_DEFAULTS } from '@/lib/agent-commission-settings';

const RULE = {
  id: 'r1', name: 'قاعدة الشهر', appliesToRole: 'MODERATOR', appliesToUserId: null, appliesToUserName: null,
  type: 'PER_ORDER', value: 2, metric: 'ORDER_DELIVERED', period: 'PER_ORDER', tiers: null, minOrders: null,
  effectiveFrom: '2026-10-01', effectiveTo: null, isActive: true, inForce: true,
};
const OWED = { userId: 'u9', name: 'سارة', accrued: 12, payable: 7, paid: 3, reversed: 0 };
const NOTHING_OWED = { userId: 'u8', name: 'منى', accrued: 4, payable: 0, paid: 4, reversed: 0 };

const ALL = ['commission.view', 'commission.manage', 'finance.create', 'settings.view', 'settings.manage'];
const as = (...permissions: string[]) => {
  user.current = { id: 'u1', name: 'موظف', status: 'ACTIVE', role: 'COMPANY_ADMIN', permissions };
};

/** Every GET the screen and its parts make, answered; every write recorded and answered empty. */
function answers(extra: Record<string, unknown> = {}) {
  apiJson.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (init?.method) return {};
    const u = String(url);
    for (const [p, v] of Object.entries(extra)) if (u.startsWith(p)) return v;
    if (u.startsWith('/api/settings/commission')) return { rules: [RULE], noRuleInForce: false };
    if (u.startsWith('/api/finance/commission/progress')) return { rows: [], note: '' };
    if (u.startsWith('/api/finance/commission/payout')) return { owed: [], wallets: [] };
    if (u.startsWith('/api/finance/commission')) return { totals: [OWED, NOTHING_OWED], currencyCode: 'JOD', fairness: null };
    if (u.startsWith('/api/settings/agent-commission')) return { agentCommission: AGENT_COMMISSION_DEFAULTS };
    if (u.startsWith('/api/users')) return { users: [] };
    return {};
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  phone.value = false;
  as(...ALL);
  answers();
});
afterEach(cleanup);

const writes = () => apiJson.mock.calls.filter(([, init]) => (init as { method?: string } | undefined)?.method);
const draw = async () => {
  const view = render(<CommissionSettingsScreen />);
  await screen.findAllByText('قاعدة الشهر');
  return view;
};
/** The kit draws a button's words inside a span; the control is the button around them. */
const press = (name: string | RegExp, root: HTMLElement = document.body) => within(root).getAllByRole('button', { name })[0] as HTMLButtonElement;

describe('the frame', () => {
  it('one heading, read from the registry, on the kit frame (wide)', async () => {
    const { container } = await draw();
    const h1 = screen.getAllByRole('heading', { level: 1 });
    expect(h1).toHaveLength(1);
    expect(h1[0].textContent).toContain(routeLabel('/settings/commission'));
    expect((container.firstElementChild as HTMLElement).className).toContain('max-w-6xl');
  });

  it('PHONE: «قاعدة جديدة» is the frame’s action under the name, full width, the primary fill', async () => {
    phone.value = true;
    await draw();
    const add = press(/قاعدة جديدة/);
    expect(add.closest('header')).not.toBeNull();
    expect(add.className).toContain('w-full');
    expect(add.className).toContain('bg-[var(--sys-primary)]');
  });

  it('DESK: «قاعدة جديدة» sits in the rules card’s header, a small primary button, and opens the form', async () => {
    await draw();
    const add = press(/قاعدة جديدة/);
    expect(add.closest('header')).toBeNull();
    expect(add.parentElement!.textContent).toContain('قواعد العمولة');
    expect(add.className).toContain('h-11 md:h-8');
    fireEvent.click(add);
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('page-level blocks are cards a theme may decorate; the rule paragraph is a plain one', async () => {
    await draw();
    const rules = screen.getByText('قواعد العمولة').closest(`.${CARD_CLASS}`);
    const month = screen.getByText(/عمولات الشهر الحالي/).closest(`.${CARD_CLASS}`);
    expect(rules).not.toBeNull();
    expect(month).not.toBeNull();
    expect(rules).not.toBe(month);
    const paragraph = screen.getByText(/القاعدة لا تُعدَّل بعد كتابتها/).parentElement!;
    expect(paragraph.className).toContain('bg-[var(--sys-card)]');
    expect(paragraph.className).not.toContain(CARD_CLASS);
  });

  it('the arrangement: the rule paragraph sits right above the rules card, the month’s figures after the rules as before', async () => {
    await draw();
    const paragraph = screen.getByText(/القاعدة لا تُعدَّل بعد كتابتها/).parentElement!;
    const rules = screen.getByText('قواعد العمولة').closest(`.${CARD_CLASS}`)!;
    const month = screen.getByText(/عمولات الشهر الحالي/).closest(`.${CARD_CLASS}`)!;
    expect(paragraph.nextElementSibling).toBe(rules);
    expect(rules.nextElementSibling).toBe(month);
  });
});

describe('«صرف» — drawn for its key and a payable figure, and it opens the payout', () => {
  it('one «صرف», on the row that has something payable, a framed button (never the destructive fill)', async () => {
    await draw();
    const pay = screen.getAllByRole('button', { name: 'صرف' });
    // the rows are drawn twice (a table for the desk, cards for a phone): one row of the two has a payable figure
    expect(pay.length).toBeGreaterThan(0);
    for (const b of pay) {
      expect(b.className).toContain('bg-[var(--sys-card)]');
      expect(b.className).not.toContain('bg-[var(--sys-destructive)]');
    }
    fireEvent.click(pay[0]);
    expect(await screen.findByText('صرف عمولة سارة')).toBeTruthy();
    expect(apiJson).toHaveBeenCalledWith('/api/finance/commission/payout?userId=u9');
  });

  it('NEGATIVE: not for somebody without finance.create', async () => {
    as('commission.view', 'commission.manage');
    await draw();
    expect(screen.queryAllByRole('button', { name: 'صرف' })).toHaveLength(0);
  });
});

describe('the end of a rule', () => {
  it('«إنهاء العمل بها» is a quiet small button; the dialog’s day is a native date field; «إلغاء» sends nothing; «إنهاء» sends the same PATCH', async () => {
    await draw();
    const end = press('إنهاء العمل بها');
    expect(end.className).toContain('bg-transparent');
    expect(end.className).toContain('h-11 md:h-8');
    fireEvent.click(end);
    const dialog = await screen.findByRole('dialog');
    const day = within(dialog).getByLabelText('آخر يوم تسري فيه') as HTMLInputElement;
    expect(day.getAttribute('type')).toBe('date');
    expect(press('إلغاء', dialog).getAttribute('type')).toBe('button');
    fireEvent.click(press('إلغاء', dialog));
    expect(writes()).toHaveLength(0);

    fireEvent.click(press('إنهاء العمل بها'));
    const again = await screen.findByRole('dialog');
    fireEvent.change(within(again).getByLabelText('آخر يوم تسري فيه'), { target: { value: '2026-11-30' } });
    const submit = press('إنهاء', again);
    expect(submit.getAttribute('type')).toBe('submit');
    fireEvent.click(submit);
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual([
      '/api/settings/commission',
      { method: 'PATCH', body: JSON.stringify({ ruleId: 'r1', effectiveTo: '2026-11-30' }) },
    ]);
    expect(await screen.findByText('أُنهي العمل بالقاعدة — ما احتُسب سابقاً باقٍ كما هو')).toBeTruthy();
  });

  it('NEGATIVE: neither rule press is drawn for somebody who can only read the page', async () => {
    as('commission.view');
    await draw();
    expect(screen.queryAllByRole('button', { name: /قاعدة جديدة/ })).toHaveLength(0);
    expect(screen.queryAllByRole('button', { name: 'إنهاء العمل بها' })).toHaveLength(0);
  });
});

describe('a new rule — the form', () => {
  const open = async () => {
    await draw();
    fireEvent.click(press(/قاعدة جديدة/));
    return screen.findByRole('dialog');
  };

  it('the three shapes are one Segmented choice; for a per-order rule the two banded ones are off', async () => {
    const dialog = await open();
    const group = within(dialog).getByRole('radiogroup', { name: 'شكل القاعدة' });
    const options = within(group).getAllByRole('radio') as HTMLButtonElement[];
    expect(options.map((o) => o.textContent)).toEqual(['قيمة واحدة', 'شرائح', 'هدف ومكافأة']);
    expect(options.map((o) => o.getAttribute('type'))).toEqual(['button', 'button', 'button']);
    // the metric starts at «per delivered order»
    expect(options.map((o) => o.disabled)).toEqual([false, true, true]);
    expect(options[0].getAttribute('aria-checked')).toBe('true');
  });

  it('NEGATIVE: no kit button but «حفظ» submits — the shapes, «+ شريحة», the «×» and «إلغاء» send nothing', async () => {
    const dialog = await open();
    fireEvent.change(within(dialog).getByLabelText('تُحتسب على'), { target: { value: 'CONFIRMED_COUNT' } });
    fireEvent.click(within(dialog).getByRole('radio', { name: 'شرائح' }));
    const add = press('+ شريحة', dialog);
    expect(add.getAttribute('type')).toBe('button');
    fireEvent.click(add);
    const remove = within(dialog).getAllByRole('button', { name: 'حذف الشريحة' }) as HTMLButtonElement[];
    expect(remove).toHaveLength(2);
    for (const r of remove) expect(r.getAttribute('type')).toBe('button');
    fireEvent.click(remove[1]);
    expect(within(dialog).getAllByRole('button', { name: 'حذف الشريحة' })).toHaveLength(1);
    // the last band cannot be removed
    expect((within(dialog).getByRole('button', { name: 'حذف الشريحة' }) as HTMLButtonElement).disabled).toBe(true);
    expect(press('إلغاء', dialog).getAttribute('type')).toBe('button');
    expect(writes()).toHaveLength(0);
  });

  it('the save sends the same body, and the start day is a native date field', async () => {
    const dialog = await open();
    const from = within(dialog).getByLabelText('سارية من') as HTMLInputElement;
    expect(from.getAttribute('type')).toBe('date');
    fireEvent.change(within(dialog).getByLabelText('اسم القاعدة'), { target: { value: 'قاعدة جديدة للتجربة' } });
    fireEvent.change(dialog.querySelector('input[step="0.01"]')!, { target: { value: '1.5' } });
    fireEvent.change(from, { target: { value: '2026-12-01' } });
    const save = press('حفظ', dialog);
    expect(save.getAttribute('type')).toBe('submit');
    fireEvent.click(save);
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual([
      '/api/settings/commission',
      {
        method: 'POST',
        body: JSON.stringify({
          name: 'قاعدة جديدة للتجربة',
          appliesToRole: 'MODERATOR',
          appliesToUserId: null,
          metric: 'ORDER_DELIVERED',
          period: 'PER_ORDER',
          type: 'PERCENT',
          value: 1.5,
          tiers: null,
          minOrders: null,
          effectiveFrom: '2026-12-01',
        }),
      },
    ]);
    expect(await screen.findByText('أُضيفت القاعدة')).toBeTruthy();
  });
});

describe('the payout dialog — its own flag, one payout per press', () => {
  const WALLET = { id: 'w1', name: 'الصندوق', currencyCode: 'JOD', country: { minorUnit: 3 } };
  const draw = async () => {
    answers({ '/api/finance/commission/payout': { owed: [{ currencyCode: 'JOD', amount: 7, entries: ['e1', 'e2'] }], wallets: [WALLET] } });
    const onPaid = vi.fn();
    render(<PayoutDialog userId="u9" userName="سارة" onClose={vi.fn()} onPaid={onPaid} />);
    await screen.findByText('2 قيد عمولة');
    return onPaid;
  };

  it('a double press sends ONE payout with the same body; the kit’s own busy state is not running beside the dialog’s', async () => {
    let release: (v: unknown) => void = () => {};
    const onPaid = await draw();
    apiJson.mockImplementation((_url: string, init?: { method?: string }) =>
      init?.method ? new Promise((r) => (release = r)) : Promise.resolve({})
    );
    fireEvent.change(screen.getByPlaceholderText('تحويل بنكي، نقداً باليد…'), { target: { value: ' نقداً ' } });
    const pay = press('صرف');
    fireEvent.click(pay);
    fireEvent.click(pay);
    expect(writes()).toEqual([
      [
        '/api/finance/commission/payout',
        { method: 'POST', body: JSON.stringify({ userId: 'u9', walletId: 'w1', entryIds: ['e1', 'e2'], exchangeRate: 1, note: 'نقداً' }) },
      ],
    ]);
    await waitFor(() => expect(press(/جارٍ الصرف/).disabled).toBe(true));
    expect(press(/جارٍ الصرف/).getAttribute('aria-busy')).toBeNull();
    release({});
    await waitFor(() => expect(onPaid).toHaveBeenCalledTimes(1));
  });

  it('«إلغاء» is a framed button that never pays; «صرف» is the primary fill', async () => {
    await draw();
    const cancel = press('إلغاء');
    expect(cancel.getAttribute('type')).toBe('button');
    expect(cancel.className).toContain('bg-[var(--sys-card)]');
    fireEvent.click(cancel);
    expect(writes()).toHaveLength(0);
    expect(press('صرف').className).toContain('bg-[var(--sys-primary)]');
  });

  it('NEGATIVE: with no wallet chosen «صرف» stays off', async () => {
    answers({ '/api/finance/commission/payout': { owed: [{ currencyCode: 'JOD', amount: 7, entries: ['e1'] }], wallets: [WALLET, { ...WALLET, id: 'w2', name: 'البنك' }] } });
    render(<PayoutDialog userId="u9" userName="سارة" onClose={vi.fn()} onPaid={vi.fn()} />);
    await screen.findByText('1 قيد عمولة');
    expect(press('صرف').disabled).toBe(true);
  });
});

describe('the estimate card', () => {
  it('the quality gate is the kit checkbox with its own id and words; the presses are kit buttons that never submit', async () => {
    render(<AgentCommissionCard />);
    await screen.findByText('حاسبة عمولة الموظفات (تقدير)');
    const gate = screen.getByLabelText('بوابة الجودة') as HTMLInputElement;
    expect(gate.getAttribute('type')).toBe('checkbox');
    expect(gate.id).toBe('agent-commission-quality-gate');
    for (const name of ['حفظ', 'إضافة شريحة']) expect(press(name).getAttribute('type')).toBe('button');
    expect(screen.getAllByRole('button', { name: 'حذف' }).every((b) => b.getAttribute('type') === 'button')).toBe(true);
  });

  it('NEGATIVE: read-only for whoever lacks the sensitive key — the checkbox too', async () => {
    as('commission.view', 'settings.view');
    render(<AgentCommissionCard />);
    await screen.findByText('حاسبة عمولة الموظفات (تقدير)');
    expect((screen.getByLabelText('بوابة الجودة') as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryAllByRole('button', { name: 'حفظ' })).toHaveLength(0);
  });
});

describe('PHONE (375px, jsdom)', () => {
  it('no fixed width wider than a phone; the rows are cards; every press is at least 44px tall', async () => {
    phone.value = true;
    const { container } = await draw();
    // built from pieces: a whole arbitrary-width class written here would be scanned into the stylesheet
    const fixed = new RegExp('^(?:min-)?w-' + '\\[(\\d+)px\\]$');
    const widths = [...container.querySelectorAll('[class]')].flatMap((el) =>
      [...el.classList].map((c) => fixed.exec(c)).filter(Boolean).map((m) => Number(m![1]))
    );
    expect(widths.filter((w) => w > 375)).toEqual([]);
    expect(container.querySelectorAll('ul > li').length).toBeGreaterThan(0);
    for (const b of within(container).getAllByRole('button')) expect(b.className).toMatch(/\bh-11\b|\bmin-h-11\b/);
  });
});

describe('the five files', () => {
  const FILES = [
    'src/components/screens/CommissionSettingsScreen.tsx',
    'src/components/screens/commission/FairnessPanel.tsx',
    'src/components/screens/commission/PayoutDialog.tsx',
    'src/components/screens/commission/PeriodProgress.tsx',
    'src/components/settings/AgentCommissionCard.tsx',
  ];
  it('draw no raw button and no extra-small text, and keep exactly the two native date fields', () => {
    const small = ['text', 'xs'].join('-');
    let dates = 0;
    for (const f of FILES) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).not.toMatch(/<button[\s>]/);
      expect(src.includes(small), f).toBe(false);
      dates += (src.match(/type="date"/g) ?? []).length;
    }
    expect(dates).toBe(2);
  });
});
