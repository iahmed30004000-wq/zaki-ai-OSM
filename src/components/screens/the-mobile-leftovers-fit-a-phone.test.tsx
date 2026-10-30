// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

/**
 * WHAT THE FOUR MOBILE PULL REQUESTS LEFT BEHIND — THE ONES THAT NEED NO DESIGN DECISION.
 *
 * M6, M8–M9 and M7 each ended with a list of "out of scope" lines. The ones taken here are layout, wording and empty
 * states whose answer was already written in the audit: a raw status code on a supervisor's list (ORD-18), a footer that
 * could not wrap (ORD-19), a customer line that is one bidirectional run (ORD-23), a dialog whose buttons were under
 * 44px (FIN-28), a row of six fixed-width fields (FIN-29), the fairness explanation and the period list (FIN-20),
 * the label-size fields (OPS-BATCH-2), the tab strip (OPS-SH-6), the title block of a dialog, the search box that
 * raised the keyboard on a phone (OPS-RET-3) and a supervisor being told to «start confirming» (RV122).
 *
 * THE RULE THAT SHAPES EVERY CASE: THE DESK DOES NOT MOVE.
 * Every group ends in a DESK case that holds the old arrangement. The one change that reaches the desk on purpose is a
 * WORD that was wrong for everybody (the raw status code, ORD-18) — and the group says so in its name.
 *
 * jsdom has no layout: what is held here is the arrangement the layout depends on (which box, which class, which text).
 */

const { apiJson, phone, user } = vi.hoisted(() => ({
  apiJson: vi.fn(),
  phone: { value: true },
  user: { current: null as unknown },
}));

vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a) }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => phone.value }));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ locale: 'ar', isRtl: true, currentUser: user.current }),
  useAppOptional: () => ({ locale: 'ar', isRtl: true, currentUser: user.current }),
}));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/',
}));
vi.mock('next/link', () => ({
  default: ({ children, href, className }: { children: React.ReactNode; href: string; className?: string }) => (
    <a href={href} className={className}>{children}</a>
  ),
}));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => <h1>العنوان</h1> }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), done: vi.fn(), success: vi.fn(), show: vi.fn() }) }));
vi.mock('@/components/orders/OrderLink', () => ({
  OrderLink: ({ number }: { number: string }) => <span>{number}</span>,
}));
vi.mock('@/components/orders/CustomerHistory', () => ({ CustomerHistoryOffer: () => <i data-testid="history" /> }));
vi.mock('@/components/orders/useOrderPatch', () => ({ useOrderPatch: () => vi.fn() }));
vi.mock('@/hooks/useRegions', () => ({ useRegions: () => ({ regions: [], countryName: '' }) }));
vi.mock('@/hooks/useLiveRefresh', async () => {
  const react = await import('react');
  return { useLiveRefresh: (load: () => void) => react.useEffect(() => { void load(); }, [load]) };
});
vi.mock('@/components/confirmation/PullPanel', () => ({
  PullPanel: () => null,
  useQueue: () => ({
    data: {
      orders: [
        { id: 'o1', orderNumber: 'ORD-1', confirmationStatus: 'IN_PROGRESS', postponeCount: 0, customer: { fullName: 'سعاد', city: 'عمّان' } },
        { id: 'o2', orderNumber: 'ORD-2', confirmationStatus: 'NEW', postponeCount: 1, customer: { fullName: 'منى', city: 'إربد' } },
        { id: 'o3', orderNumber: 'ORD-3', confirmationStatus: 'SOMETHING_NEW', postponeCount: 0, customer: { fullName: 'هدى', city: 'السلط' } },
      ],
    },
  }),
}));

import { ConfirmationQueueScreen } from './ConfirmationQueueScreen';
import { ConfirmationIssuesScreen } from './ConfirmationIssuesScreen';
import { PenaltiesScreen } from './PenaltiesScreen';
import { PenaltyRulesCard } from '@/components/settings/PenaltyRulesCard';
import { FairnessPanel, type FairnessData } from './commission/FairnessPanel';
import { PeriodProgress } from './commission/PeriodProgress';
import { LabelSizePicker, forgetLabelSize } from '@/components/labels/LabelSize';
import { ListToolbar } from '@/components/ui/ListToolbar';
import { Tabs } from '@/components/ui/Tabs';
import { Modal } from '@/components/ui/Modal';
import { MissionCard } from '@/components/dashboard/MissionCard';
import { missionFor, missionSentence, WATCH_ONLY_CTA } from '@/lib/mission-card';
import { CONFIRMATION_STATUS_AR } from '@/lib/confirmation-workflow';
import { WORK_KINDS, type WorkItem, type WorkKey } from '@/lib/my-work';

beforeEach(() => {
  vi.clearAllMocks();
  phone.value = true;
  user.current = null;
});
afterEach(() => {
  cleanup();
  delete (window as unknown as { matchMedia?: unknown }).matchMedia;
});

const has = (el: Element | null | undefined, ...classes: string[]) => classes.every((c) => !!el?.classList.contains(c));

/* ═══════════════════ ORD-18 — a status is said in Arabic, for everybody ═══════════════════ */

describe('ORD-18 · «الحالة» في عرض المشرف تُقرأ بالعربية (تصحيح كلمة للجميع)', () => {
  for (const [name, isPhone] of [['PHONE', true], ['DESK', false]] as const) {
    it(`${name}: the status column says the Arabic word the order sheet says, never the code`, () => {
      phone.value = isPhone;
      render(<ConfirmationQueueScreen />);
      expect(screen.getAllByText(CONFIRMATION_STATUS_AR.IN_PROGRESS).length).toBeGreaterThan(0);
      expect(screen.getAllByText(CONFIRMATION_STATUS_AR.NEW).length).toBeGreaterThan(0);
      expect(screen.queryByText('IN_PROGRESS')).toBeNull();
      expect(screen.queryByText('NEW')).toBeNull();
    });
  }

  it('a status the table does not know is said as «غير معروفة», not printed raw', () => {
    render(<ConfirmationQueueScreen />);
    expect(screen.getAllByText('غير معروفة').length).toBeGreaterThan(0);
    expect(screen.queryByText('SOMETHING_NEW')).toBeNull();
  });
});

/* ═══════════════════ ORD-19 · ORD-23 — the issues list ═══════════════════ */

const ISSUE = {
  id: 'i1', reason: 'WRONG_PHONE', note: null, status: 'OPEN', createdAt: '2026-10-20T10:00:00.000Z',
  order: {
    id: 'o1', orderNumber: 'ORD-9', createdAt: '2026-10-19T10:00:00.000Z', source: 'MANUAL', version: 1, quantity: 2,
    regionId: null, region: null, product: { name: 'قميص' }, confirmationStatus: 'NEW',
    customer: { id: 'c1', fullName: 'سعاد', phone: '+96279', rawPhone: '079123', altPhone: null, city: 'عمّان', address: 'شارع الجامعة' },
    moderator: null,
  },
};

describe('ORD-19 · ORD-23 · «الإشكالات»', () => {
  beforeEach(() => {
    user.current = { id: 'u1', status: 'ACTIVE', role: 'COMPANY_ADMIN', permissions: ['confirmation.issues_correct', 'orders.cancel'] };
    apiJson.mockImplementation(async () => ({ issues: [ISSUE] }));
  });

  it('PHONE: the footer with the two actions can wrap instead of running off the card', async () => {
    render(<ConfirmationIssuesScreen />);
    const footer = (await screen.findByRole('button', { name: /صحّح البيانات/ })).closest('footer');
    expect(has(footer, 'flex', 'flex-wrap', 'gap-2')).toBe(true);
  });

  it('PHONE: name, number and city are three boxes — the number is left-to-right, the words follow the page', async () => {
    render(<ConfirmationIssuesScreen />);
    const number = await screen.findByText('079123');
    expect(number.getAttribute('dir')).toBe('ltr');
    const line = number.parentElement!;
    expect(has(line, 'flex', 'flex-wrap')).toBe(true);
    const name = within(line).getByText('سعاد');
    const city = within(line).getByText('عمّان');
    expect(name.getAttribute('dir')).toBe('auto');
    expect(city.getAttribute('dir')).toBe('auto');
    // No «·» typed between facts: the boxes are the separation.
    expect(line.textContent).not.toContain('·');
    expect(within(line).getByTestId('history')).toBeTruthy();
  });

  it('DESK: the line is the one string it always was — name · number · city', async () => {
    phone.value = false;
    render(<ConfirmationIssuesScreen />);
    const number = await screen.findByText('079123');
    const line = number.parentElement!;
    expect(has(line, 'flex')).toBe(false);
    expect(line.textContent).toContain('سعاد · 079123 · عمّان');
  });

  it('a phone with no customer number still draws the box (the stored number stands in, as on the desk)', async () => {
    apiJson.mockImplementation(async () => ({
      issues: [{ ...ISSUE, order: { ...ISSUE.order, customer: { ...ISSUE.order.customer, rawPhone: null } } }],
    }));
    render(<ConfirmationIssuesScreen />);
    expect((await screen.findByText('+96279')).getAttribute('dir')).toBe('ltr');
  });
});

/* ═══════════════════ FIN-28 — the penalties dialog ═══════════════════ */

describe('FIN-28 · نافذة سبب الخصم', () => {
  const KINDS = [{ key: 'LATE', ar: 'التأخير', unitAr: 'دقيقة', sourceAr: '' }];
  const ROW = {
    id: 'p1', kind: 'LATE', occurredOn: '2026-10-18T00:00:00Z', units: 5, chargedUnits: 5, amount: 2, currencyCode: 'JOD',
    status: 'PROPOSED', note: null, decisionNote: null, decidedAt: null, payslipId: null, reversesId: null,
    user: { id: 'u-sara', name: 'سارة', role: 'FOLLOW_UP_AGENT' },
  };
  beforeEach(() => {
    user.current = { id: 'u-acc', status: 'ACTIVE', role: 'ACCOUNTANT', permissions: ['penalties.view', 'penalties.decide'] };
    apiJson.mockImplementation(async (url: string) => {
      if (String(url).includes('people=1')) return { people: [] };
      return { kinds: KINDS, penalties: [ROW] };
    });
  });

  it('«تأكيد» and «تراجع» are 44px under a thumb and keep their desk height (the class pair)', async () => {
    render(<PenaltiesScreen />);
    fireEvent.click(await screen.findByRole('button', { name: /ألغِ/ }));
    const dialog = await screen.findByRole('dialog');
    for (const name of ['تأكيد', 'تراجع']) {
      const b = within(dialog).getByRole('button', { name });
      expect(has(b, 'min-h-11', 'md:min-h-0')).toBe(true);
    }
  });

  it('the order is the one it was: «تأكيد» first, «تراجع» second (nothing moved on the desk)', async () => {
    render(<PenaltiesScreen />);
    fireEvent.click(await screen.findByRole('button', { name: /ألغِ/ }));
    const dialog = await screen.findByRole('dialog');
    const names = within(dialog).getAllByRole('button').map((b) => b.textContent);
    expect(names.indexOf('تأكيد')).toBeLessThan(names.indexOf('تراجع'));
  });
});

/* ═══════════════════ FIN-29 — the add-rule row ═══════════════════ */

describe('FIN-29 · صف «أضف قاعدة»', () => {
  beforeEach(() => {
    user.current = { id: 'u1', status: 'ACTIVE', role: 'COMPANY_ADMIN', permissions: ['penalties.rules'] };
    apiJson.mockImplementation(async () => ({
      kinds: [{ key: 'LATE', ar: 'التأخير', unitAr: 'دقيقة', sourceAr: '' }],
      roles: ['FOLLOW_UP_AGENT'],
      rules: [],
    }));
  });
  const fields = (root: HTMLElement) => [...root.querySelectorAll('select, input')] as HTMLElement[];

  it('PHONE: two columns of full-width fields at 44px, and the add button on a row of its own', async () => {
    const { container } = render(<PenaltyRulesCard />);
    const add = await screen.findByRole('button', { name: /أضف قاعدة/ });
    const row = add.parentElement!;
    expect(has(row, 'grid', 'grid-cols-2')).toBe(true);
    expect(has(row, 'flex-wrap')).toBe(false);
    expect(fields(container).length).toBe(6);
    for (const f of fields(container)) expect(has(f, 'h-11', 'w-full')).toBe(true);
    expect(has(add, 'col-span-2', 'w-full')).toBe(true);
  });

  it('DESK: the same wrapping row of fixed widths and 40px fields it always was', async () => {
    phone.value = false;
    const { container } = render(<PenaltyRulesCard />);
    const add = await screen.findByRole('button', { name: /أضف قاعدة/ });
    const row = add.parentElement!;
    expect(has(row, 'flex', 'flex-wrap', 'items-end')).toBe(true);
    expect(has(row, 'grid')).toBe(false);
    const widths = fields(container).map((f) => ['w-36', 'w-32', 'w-24', 'w-20'].find((w) => f.classList.contains(w)));
    expect(widths).toEqual(['w-36', 'w-32', 'w-24', 'w-20', 'w-24', 'w-24']);
    for (const f of fields(container)) expect(has(f, 'h-10')).toBe(true);
    expect(has(add, 'col-span-2')).toBe(false);
  });

  it('a reader who may not manage sees no add row on either size', async () => {
    user.current = { id: 'u2', status: 'ACTIVE', role: 'ACCOUNTANT', permissions: [] };
    render(<PenaltyRulesCard />);
    await screen.findByText(/قراءة فقط/);
    expect(screen.queryByRole('button', { name: /أضف قاعدة/ })).toBeNull();
  });
});

/* ═══════════════════ FIN-20 — the commission screen's two long panels ═══════════════════ */

describe('FIN-20 · لوحة العدالة', () => {
  const DATA = {
    confirmed: [
      {
        userId: 'a1', userName: 'سارة', rawCount: 7, daysWorked: 6, comparableDays: 1, counted: 3, evenShare: 4, index: 0.75, surplus: -1,
        winDays: 0, score: 40, tone: 'ok', label: 'تحت نصيبه', why: 'سبب مكتوب', bands: [{ key: 'b1', ar: 'بند', earned: 3, weight: 10, why: 'ليش' }],
      },
    ],
    sourced: [],
    calendar: { ready: false, months: 1, daysOfMonthCovered: 6, busiestDayShare: 0.5, why: 'السجل لا يكفي بعد' },
    swaps: { confirmed: { compared: 0, swaps: [] }, sourced: { compared: 0, swaps: [] } },
  } as unknown as FairnessData;
  const EXPLAIN = /الترتيب بعدد الطلبات يكافئ التقويم/;

  it('PHONE: the long explanation sits behind one closed line that says what it is', () => {
    const { container } = render(<FairnessPanel data={DATA} />);
    const details = container.querySelector('details');
    expect(details).not.toBeNull();
    expect(details!.hasAttribute('open')).toBe(false);
    expect(within(details!).getByText('لماذا هذه المقارنة؟')).toBeTruthy();
    expect(has(details!.querySelector('summary'), 'min-h-11')).toBe(true);
    expect(within(details!).getByText(EXPLAIN)).toBeTruthy();
    // The headline and the numbers stay where they were.
    expect(screen.getByText('عدالة العدد — مقابل نصيب اليوم')).toBeTruthy();
    expect(screen.getByText('سارة')).toBeTruthy();
  });

  it('DESK: the explanation is printed whole, in a paragraph, with no fold (nothing moved)', () => {
    phone.value = false;
    const { container } = render(<FairnessPanel data={DATA} />);
    expect(container.querySelector('details')).toBeNull();
    expect(screen.getByText(EXPLAIN).tagName).toBe('P');
  });

  it('the same words are shown on both sizes — folding hides nothing from the reader', () => {
    const phoneText = render(<FairnessPanel data={DATA} />).container.textContent!;
    cleanup();
    phone.value = false;
    const deskText = render(<FairnessPanel data={DATA} />).container.textContent!;
    expect(phoneText.replace('لماذا هذه المقارنة؟', '')).toBe(deskText);
  });

  it('«من أين الدرجة» is a 44px target under a thumb and not on the desk', () => {
    render(<FairnessPanel data={DATA} />);
    expect(has(screen.getByRole('button', { name: /من أين الدرجة/ }), 'min-h-11', 'md:min-h-0')).toBe(true);
  });

  it('nothing to say → nothing drawn (an empty panel is not a state)', () => {
    const { container } = render(<FairnessPanel data={{ ...DATA, confirmed: [] } as FairnessData} />);
    expect(container.textContent).toBe('');
  });
});

describe('FIN-20 · «الفترة الجارية»', () => {
  const ROW = {
    ruleId: 'r1', ruleName: 'قاعدة اليوم', userId: 'u1', userName: 'سارة', metricLabel: 'مؤكَّد', periodLabel: 'الشهر',
    count: 12, inBand: { label: '10+', value: 1 }, next: { at: 20, value: 2, remaining: 8 }, isTarget: false, goal: 30, minOrders: null,
  };
  beforeEach(() => {
    apiJson.mockResolvedValue({ rows: [ROW], note: 'أرقام تتحرّك' });
  });

  it('PHONE: who and how many on the first line, the rule on the second, where it stands on the third', async () => {
    render(<PeriodProgress />);
    const name = await screen.findByText('سارة');
    const li = name.closest('li')!;
    const [head, rule, standing] = [...li.children] as HTMLElement[];
    expect(head.textContent).toContain('سارة');
    expect(head.textContent).toContain('12');
    expect(head.textContent).toContain('30');
    expect(rule.textContent).toBe('قاعدة اليوم · مؤكَّد · الشهر');
    expect(standing.textContent).toContain('شريحة 10+');
    expect(standing.textContent).toContain('باقي 8 لـ 20');
    expect(has(standing, 'flex-wrap')).toBe(true);
  });

  it('DESK: one wrapping row — name, rule, figure, standing, remaining — in the order it always had', async () => {
    phone.value = false;
    render(<PeriodProgress />);
    const li = (await screen.findByText('سارة')).closest('li')!;
    expect(has(li, 'flex', 'flex-wrap')).toBe(true);
    expect([...li.children].map((c) => c.textContent)).toEqual([
      'سارة',
      'قاعدة اليوم · مؤكَّد · الشهر',
      '12 / 30',
      'شريحة 10+ · 1',
      'باقي 8 لـ 20',
    ]);
  });

  it('a person under the minimum is told so on both sizes, and a person past every band is told that too', async () => {
    apiJson.mockResolvedValue({
      rows: [
        { ...ROW, userId: 'u2', userName: 'منى', count: 2, minOrders: 5, inBand: null, next: null, goal: null },
        { ...ROW, userId: 'u3', userName: 'هدى', count: 1, inBand: null, next: null, goal: null },
      ],
      note: '',
    });
    render(<PeriodProgress />);
    await screen.findByText('منى');
    expect(screen.getByText(/دون الحد الأدنى \(5\)/)).toBeTruthy();
    expect(screen.getByText('لم يبلغ أي شريحة بعد')).toBeTruthy();
  });

  it('no rows → no card', async () => {
    apiJson.mockResolvedValue({ rows: [], note: '' });
    const { container } = render(<PeriodProgress />);
    await waitFor(() => expect(container.textContent).toBe(''));
  });
});

/* ═══════════════════ OPS-BATCH-2 — the label-size fields ═══════════════════ */

describe('OPS-BATCH-2 · حقول مقاس البوليصة', () => {
  beforeEach(() => {
    localStorage.clear();
    forgetLabelSize();
  });

  it('the dropdown is 44px under a thumb and 40px on the desk — one class pair', () => {
    render(<LabelSizePicker compact />);
    expect(has(screen.getByLabelText('مقاس البوليصة'), 'h-11', 'md:h-10')).toBe(true);
  });

  it('the two custom boxes follow the dropdown', () => {
    localStorage.setItem('zaki.labelSize', JSON.stringify({ key: 'custom', custom: { width: 100, height: 100 } }));
    forgetLabelSize();
    render(<LabelSizePicker compact />);
    fireEvent.change(screen.getByLabelText('مقاس البوليصة'), { target: { value: 'custom' } });
    for (const label of ['العرض بالمليمتر', 'الارتفاع بالمليمتر']) {
      expect(has(screen.getByLabelText(label), 'h-11', 'md:h-10')).toBe(true);
    }
  });
});

/* ═══════════════════ OPS-SH-6 · the dialog title · OPS-RET-3 ═══════════════════ */

describe('OPS-SH-6 · شريط التبويب', () => {
  it('each tab is a 44px target under a thumb and the old height on the desk', () => {
    render(<Tabs tabs={[{ key: 'a', label: 'الأول' }, { key: 'b', label: 'الثاني', count: 3 }]} value="a" onChange={() => undefined} />);
    for (const t of screen.getAllByRole('tab')) expect(has(t, 'min-h-11', 'md:min-h-0', 'shrink-0')).toBe(true);
  });
});

describe('the title block of a dialog can shrink', () => {
  it('a long title wraps inside its box instead of pushing the close button out', () => {
    render(
      <Modal isOpen onClose={() => undefined} title="عنوان طويل جداً جداً جداً" subtitle="وصف">
        <p>المتن</p>
      </Modal>
    );
    const title = screen.getByText('عنوان طويل جداً جداً جداً');
    expect(has(title.parentElement, 'min-w-0')).toBe(true);
    expect(screen.getByRole('button', { name: 'إغلاق' })).toBeTruthy();
  });
});

describe('OPS-RET-3 · المؤشر في خانة البحث', () => {
  const bar = () =>
    render(
      <ListToolbar
        search="" onSearch={() => undefined} placeholder="بحث" filters={[]} activeCount={0} onReset={() => undefined} searchAutoFocus
      />
    );
  const pointer = (fine: boolean) => {
    (window as unknown as { matchMedia: unknown }).matchMedia = (q: string) => ({
      matches: q.includes('pointer: fine') ? fine : false,
      media: q, addEventListener: () => undefined, removeEventListener: () => undefined,
    });
  };

  it('DESK (a mouse): the cursor is in the box when the screen opens', () => {
    pointer(true);
    bar();
    expect(document.activeElement).toBe(screen.getByLabelText('بحث'));
  });

  it('PHONE (a finger): the box is not focused, so the keyboard does not cover the list', () => {
    pointer(false);
    bar();
    expect(document.activeElement).not.toBe(screen.getByLabelText('بحث'));
  });

  it('where nothing can say (no matchMedia), the behaviour is the one it always was: focused', () => {
    bar();
    expect(document.activeElement).toBe(screen.getByLabelText('بحث'));
  });

  it('a screen that never asked for it never gets it', () => {
    pointer(true);
    render(<ListToolbar search="" onSearch={() => undefined} placeholder="بحث" filters={[]} activeCount={0} onReset={() => undefined} />);
    expect(document.activeElement).not.toBe(screen.getByLabelText('بحث'));
  });
});

/* ═══════════════════ RV122 — a supervisor is not told to «start confirming» ═══════════════════ */

describe('RV122 · بطاقة «مهمّتك الجاية» للمشرف (تصحيح كلمة للجميع)', () => {
  const item = (key: WorkKey, count: number): WorkItem => {
    const k = WORK_KINDS.find((x) => x.key === key)!;
    return { key, ar: k.ar, count, href: k.href, icon: k.icon, tone: k.tone };
  };
  const POOL = [item('CONFIRM_POOL', 12)];

  it('with the pull key (or when nobody asks): «ابدأ التأكيد», the sentence it always was', () => {
    expect(missionSentence(missionFor(POOL, () => true)!)).toBe('12 طلب جديد بستنوا تأكيد ← ابدأ التأكيد');
    expect(missionSentence(missionFor(POOL, () => true, (k) => k === 'confirmation.pull')!)).toBe(
      '12 طلب جديد بستنوا تأكيد ← ابدأ التأكيد'
    );
  });

  it('without the pull key: the same count, and a button that says what she can do — «راقب الطابور»', () => {
    const m = missionFor(POOL, () => true, () => false)!;
    expect(missionSentence(m)).toBe(`12 طلب جديد بستنوا تأكيد ← ${WATCH_ONLY_CTA}`);
    expect(WATCH_ONLY_CTA).toBe('راقب الطابور');
    expect(m.href).toBe('/confirmation/queue');
    expect(m.item.count).toBe(12);
  });

  it('only that one kind is reworded — the other missions keep their own button', () => {
    const m = missionFor([item('READY_TO_SHIP', 4)], () => true, () => false)!;
    expect(missionSentence(m)).toBe('4 طلب جاهز للشحن ← ابدأ الشحن');
  });

  it('the card on the dashboard asks the signed-in person’s keys: supervise alone → «راقب الطابور»', () => {
    user.current = { id: 'u1', status: 'ACTIVE', role: 'MODERATOR', permissions: ['confirmation.supervise'] };
    render(<MissionCard items={POOL} />);
    expect(screen.getByRole('link').textContent).toBe(WATCH_ONLY_CTA);
    expect(screen.getByTestId('mission-sentence').textContent).toContain('12 طلب جديد بستنوا تأكيد');
  });

  it('pull (with or without supervise) → «ابدأ التأكيد»; a super admin holds every key → «ابدأ التأكيد»', () => {
    user.current = { id: 'u1', status: 'ACTIVE', role: 'MODERATOR', permissions: ['confirmation.pull', 'confirmation.supervise'] };
    render(<MissionCard items={POOL} />);
    expect(screen.getByRole('link').textContent).toBe('ابدأ التأكيد');
    cleanup();
    user.current = { id: 'u2', status: 'ACTIVE', role: 'SUPER_ADMIN', permissions: [] };
    render(<MissionCard items={POOL} />);
    expect(screen.getByRole('link').textContent).toBe('ابدأ التأكيد');
  });

  it('nobody signed in → the card is not asked to promise a pull (and draws nothing without a door)', () => {
    user.current = null;
    render(<MissionCard items={POOL} />);
    expect(screen.getByRole('link').textContent).toBe(WATCH_ONLY_CTA);
  });
});
