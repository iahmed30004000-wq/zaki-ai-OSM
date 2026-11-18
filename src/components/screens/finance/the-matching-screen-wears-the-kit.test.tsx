// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import { routeLabel } from '@/lib/route-registry';
import { CARD_CLASS } from '@/lib/theme-shape';
import { PARKED } from '@/lib/settlement-difference';

/**
 * «المطابقة» ON THE KIT (R13c1, plan 17/11) — ONE LOOK, AND NOT ONE FIGURE, PRESS OR REQUEST MOVED.
 *
 * A money screen: it may look different, and nothing it prints or asks may change. This file holds
 *   the frame — `PageShell` with the menu's own name, on both halves (with a statement / «يدوي — بلا كشف»), the two tabs kept;
 *   the surfaces — the statement card is the kit's card; the five queues and the three folds are its plain card (no theme ornament
 *     on rows), and a fold is still a native `<details>` (closed, and kept by the screen across a reload);
 *   the captions — the caption size everywhere, except the two lines of the delivery-fee cell (their figures sit on them: R13's money-line rule);
 *   the presses — «تشغيل المطابقة» keeps the screen's own busy flag (the kit runs nothing: one request on a double press), the kit's
 *     buttons that must not submit say `type="button"`, the search's own submit still submits, and «بلا بتّ فقط» is the kit's box;
 *   the figures — every text with a digit, frozen from the screen as it was on main before this request (18/11), desk and phone;
 *   the phone — no fixed width wider than the phone; «تشغيل المطابقة» and «بحث بكل الكشوف» take the row; the card's row wraps.
 */

const { api, phone, perms } = vi.hoisted(() => ({ api: vi.fn(), phone: { value: false }, perms: { current: [] as string[] } }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => phone.value }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/finance/matching',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ currentUser: { id: 'u1', status: 'ACTIVE', role: 'ACCOUNTANT', permissions: perms.current } }),
}));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/components/ui/NextStep', () => ({ NextStepButton: () => null }));
vi.mock('@/components/screens/finance/ManualMatching', () => ({ ManualMatching: () => <p>النصف اليدوي</p> }));
vi.mock('@/components/orders/OrderNotesPeek', () => ({ OrderNotesPeek: () => null }));

import { MatchingScreen } from './MatchingScreen';

const delivered = { phrase: 'تم توصيلها', outcome: 'DELIVERED', known: true, label: 'تقول الشركة: سُلِّم' };
const returned = { phrase: 'تم إرجاعها', outcome: 'RETURNED', known: true, label: 'تقول الشركة: رجع' };
const OK = { allowed: true, why: null };
const base = {
  matchedBy: 'BARCODE', expectedFee: '3', statementFee: '3', feeDifference: '0', resolution: null, resolutionNote: null, resolutionKind: null,
  orderOutcome: null, followUp: null, expectedAmount: null, difference: null, note: null, order: null, claim: null, decisions: null, wordGroup: null,
};
const lineOf = (n: number) => ({
  merchantRef: `2000${n}`, barcode: `B${String(n).padStart(6, '0')}`, amount: '12.5', collected: '15.25', fee: '2.75', status: 'تم توصيلها',
  rawRow: `B${n} | 2000${n} | كاش`, receiverName: `زبون ${n}`, receiverPhone: `+963 9${String(n).padStart(8, '0')}`,
  receiverAddress: `شارع ${n}`, receiverCity: 'حماة', receiverArea: 'حماة',
});
const order = (id: string, n: string, s = 'DELIVERED') => ({ id, orderNumber: n, merchantRef: `M-${n}`, shippingStatus: s });
const ROWS = () => [
  { ...base, id: 'k1', result: 'MATCHED', statementAmount: '12.5', expectedAmount: '12.5', difference: '0', courierWord: delivered, statementLine: lineOf(1), order: order('o1', 'ORD-1') },
  { ...base, id: 'd1', result: 'MISMATCHED', statementAmount: '10.75', expectedAmount: '12.5', difference: '-1.75', statementFee: '4', expectedFee: '3', feeDifference: '1', courierWord: returned, wordGroup: 'W:RET', decisions: { ACCEPTED_COURIER: OK, OURS_STANDS: OK, UNDER_REVIEW: OK }, statementLine: lineOf(2), order: order('o2', 'ORD-2') },
  { ...base, id: 'd2', result: 'MISMATCHED', statementAmount: '0', expectedAmount: '20', difference: '-20', courierWord: returned, wordGroup: 'W:RET', decisions: { ACCEPTED_COURIER: OK, OURS_STANDS: OK, UNDER_REVIEW: OK }, statementLine: lineOf(3), order: order('o3', 'ORD-3') },
  { ...base, id: 'm1', result: 'MISSING_IN_SYSTEM', matchedBy: null, statementAmount: '12.5', statementFee: null, courierWord: delivered, statementLine: lineOf(5) },
  { ...base, id: 'x1', result: 'EXCLUDED', statementAmount: '0', courierWord: returned, statementLine: lineOf(7), order: order('o7', 'ORD-7', 'RETURNED') },
  { ...base, id: 'u1', result: 'MISSING_IN_STATEMENT', statementAmount: null, expectedAmount: '15', courierWord: null, statementLine: null, order: order('o8', 'ORD-8'), orderOutcome: { key: 'DELIVERED_WAITING', label: 'تم التسليم — بانتظار التحصيل' } },
];
const PEOPLE = {
  people: [{ personId: 'a', name: 'موظفة أ', role: null, differences: 15, accepted: 4, open: 11, acceptedValue: 7.5, settledOrders: 182, rate: 0.082, exchanges: 2, why: 'سبب' }],
  minSettledOrders: 20,
  unattributed: { settledOrders: 0, differences: 4 },
};
const statementRow = (over: Record<string, unknown> = {}) => ({
  id: 's1', reference: 'ST-1', status: 'MATCHED', approvedAt: null, matchingClosedAt: null, currencyCode: 'JOD', counts: { lines: 6, receipts: 1, matches: 6, openLines: 3 }, ...over,
});

let statements: Record<string, unknown>[];
let matchGate: Promise<void> | null;
let answerGate: Promise<void> | null;
beforeEach(() => {
  vi.clearAllMocks();
  answerGate = null;
  phone.value = false;
  perms.current = ['settlement.review', 'settlement.view', 'customers.view', 'orders.unlock'];
  statements = [statementRow()];
  matchGate = null;
  const store: Record<string, string> = {};
  vi.stubGlobal('localStorage', { getItem: (k: string) => (k in store ? store[k] : null), setItem: (k: string, v: string) => { store[k] = v; }, removeItem: () => undefined });
  api.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (url === '/api/finance/statements') return { statements };
    if (url === '/api/finance/settlement-differences') return PEOPLE;
    if (url === '/api/finance/statements/s1/match' && init?.method === 'POST') {
      if (matchGate) await matchGate;
      return {};
    }
    if (/\/(decisions|order-action)$/.test(url) && init?.method === 'POST') {
      if (answerGate) await answerGate;
      return { message: 'تم' };
    }
    if (url === '/api/finance/statements/s1') return { statement: { matches: ROWS() } };
    if (url.startsWith('/api/finance/statements/search')) return { q: 'B000002', hits: [], total: 0, limit: 50 };
    return {};
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const FILES = ['MatchingScreen', 'BulkDecide', 'DifferencesByPerson', 'FoldCard', 'StatementTally', 'QueueTools', 'SearchAllStatements', 'NotMentionedActions'];
const source = (name: string) => readFileSync(join(process.cwd(), `src/components/screens/finance/${name}.tsx`), 'utf8');
/** Built from parts, so this file writes no class-like token the stylesheet would pick up. */
const XS = ['text', 'xs'].join('-');

const TITLES = ['مطابق', 'فرق في المبلغ', 'في الكشف وليس عندنا', 'مستبعدة — مرتجع أو مؤجل', 'طلبات لم يذكرها أي كشف'];
const toggle = (title: string) =>
  screen.getAllByText(title).map((el) => el.closest('button')).find((b): b is HTMLButtonElement => !!b && b.hasAttribute('aria-expanded'))!;
const draw = async () => {
  render(<MatchingScreen />);
  await screen.findAllByText('في الكشف وليس عندنا');
  await screen.findByText('الفروق حسب من أكّد الطلب');
};
const openAll = () => {
  for (const t of TITLES) fireEvent.click(toggle(t));
  for (const d of [...document.querySelectorAll('details')]) {
    d.open = true;
    fireEvent(d, new Event('toggle'));
  }
};
/** Every text node that carries a digit, in the order the page draws them. */
const figures = () => {
  const out: string[] = [];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const t = (n.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (/[\d٠-٩]/.test(t)) out.push(t);
  }
  return out;
};

describe('the frame', () => {
  it('— one h1, the menu’s own name read from the registry, on the statement half', async () => {
    await draw();
    const h1 = screen.getAllByRole('heading', { level: 1 });
    expect(h1).toHaveLength(1);
    expect(h1[0].textContent).toBe(routeLabel('/finance/matching'));
  });

  it('— and on the manual half: the two tabs are still there and still switch', async () => {
    perms.current = ['ops.track', 'settlement.review'];
    await draw();
    fireEvent.click(screen.getByRole('tab', { name: 'يدوي — بلا كشف' }));
    await screen.findByText('النصف اليدوي');
    const h1 = screen.getAllByRole('heading', { level: 1 });
    expect(h1).toHaveLength(1);
    expect(h1[0].textContent).toBe(routeLabel('/finance/matching'));
    fireEvent.click(screen.getByRole('tab', { name: 'بكشف من الشركة' }));
    await screen.findByRole('button', { name: 'تشغيل المطابقة' });
    expect(screen.queryByText('النصف اليدوي')).toBeNull();
  });

  it('— a person who cannot follow a parcel sees no tabs, as before', async () => {
    await draw();
    expect(screen.queryByRole('tab')).toBeNull();
  });

  it('— is the kit’s `PageShell` on both returns; the screen draws no header and no outer box of its own', () => {
    const src = source('MatchingScreen');
    expect(src.match(/<PageShell title=\{routeLabel\('\/finance\/matching'\)\} width="wide">/g)).toHaveLength(2);
    expect(src).not.toContain('<PageHeader');
    expect(src).not.toContain('max-w-6xl');
  });
});

describe('the surfaces', () => {
  it('— the statement card is the kit’s card; the queues and the folds are its plain card', async () => {
    await draw();
    const top = screen.getByRole('button', { name: 'تشغيل المطابقة' }).parentElement!;
    expect(top.classList.contains(CARD_CLASS), 'بطاقة الكشف مش بطاقة العدّة').toBe(true);
    expect(top.className).toContain('p-4');
    for (const t of TITLES) {
      const card = toggle(t).parentElement!;
      expect(card.className, t).toContain('bg-[var(--sys-card)]');
      expect(card.classList.contains(CARD_CLASS), `زخرفة الثيم على «${t}»`).toBe(false);
    }
    const folds = [...document.querySelectorAll('details')];
    expect(folds.length, 'الطيّات الثلاث').toBe(3);
    for (const d of folds) {
      expect(d.parentElement!.className).toContain('bg-[var(--sys-card)]');
      expect(d.parentElement!.classList.contains(CARD_CLASS), 'زخرفة الثيم على طيّة').toBe(false);
      expect(d.open, 'الطيّة بتبدأ مسكّرة').toBe(false);
    }
  });

  it('— the closed statement’s sentence sits on a plain card, the words unchanged', async () => {
    statements = [statementRow({ status: 'CLOSED', approvedAt: '2026-11-02T00:00:00Z', matchingClosedAt: '2026-11-03T00:00:00Z' })];
    await draw();
    const p = screen.getByText(/مالُه في المحفظة وتُقرأ نتيجتُه هنا فقط/);
    expect(p.parentElement!.className).toContain('bg-[var(--sys-card)]');
    expect(p.parentElement!.classList.contains(CARD_CLASS)).toBe(false);
  });
});

describe('the captions', () => {
  it('— seven of the eight files write no extra-small size; the screen keeps exactly the two fee lines (a figure sits on them)', () => {
    for (const f of FILES.filter((n) => n !== 'MatchingScreen')) expect(source(f).includes(XS), f).toBe(false);
    const lines = source('MatchingScreen').split(/\r?\n/).filter((l) => l.includes(XS));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('font-medium text-[var(--sys-destructive)]');
    expect(lines[1]).toContain('{num(m.statementFee)}');
  });

  it('— and on the page: the headings, counts, hints, labels and the page footer are the caption size', async () => {
    await draw();
    openAll();
    const NOTE = ['text', 'note'].join('-');
    const card = toggle('فرق في المبلغ').parentElement!;
    const shown = [
      ...toggle('فرق في المبلغ').querySelectorAll('span span'),
      card.querySelector('p')!,
      screen.getByText('الكشف'),
      within(card).getByText('ابحث بهالقسم'),
      ...[...document.querySelectorAll('summary span span')].slice(1, 2),
      ...[...document.querySelectorAll('summary > span')].filter((e) => /عرض|إخفاء/.test(e.textContent ?? '')),
    ];
    expect(shown.length).toBeGreaterThan(6);
    for (const el of shown) {
      if (el.textContent === 'فرق في المبلغ') continue; // the title itself is body size
      expect(el.classList.contains(XS), el.textContent!).toBe(false);
      expect(el.classList.contains(NOTE), el.textContent!).toBe(true);
    }
  });
});

describe('the presses and what they ask', () => {
  it('— «تشغيل المطابقة» keeps the screen’s own flag: grey while it runs, the kit runs nothing, one request on a double press', async () => {
    let release!: () => void;
    matchGate = new Promise<void>((r) => (release = r));
    await draw();
    const run = screen.getByRole('button', { name: 'تشغيل المطابقة' }) as HTMLButtonElement;
    fireEvent.click(run);
    await waitFor(() => expect(run.disabled).toBe(true));
    expect(run.getAttribute('aria-busy'), 'زر العدّة شغّل حالو — الغلاف void راح').toBeNull();
    fireEvent.click(run);
    expect(api.mock.calls.filter((c) => c[0] === '/api/finance/statements/s1/match')).toEqual([['/api/finance/statements/s1/match', { method: 'POST' }]]);
    await act(async () => release());
    await screen.findAllByText('في الكشف وليس عندنا');
  });

  it('— with no receipt it is grey and says why on a phone, as before', async () => {
    phone.value = true;
    statements = [statementRow({ counts: { lines: 6, receipts: 0, matches: 6 } })];
    await draw();
    const run = screen.getByRole('button', { name: 'تشغيل المطابقة' }) as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    expect(run.getAttribute('title')).toBe('سجّل إيصال الاستلام أولاً');
    expect(screen.getByText('سجّل إيصال الاستلام أولاً').tagName).toBe('P');
  });

  it('— every kit button that must not submit says so; the search’s own submit still submits the search', async () => {
    await draw();
    openAll();
    const named = (name: string | RegExp) => screen.getAllByRole('button', { name });
    for (const b of [...named('بحث بكل الكشوف'), ...named('بتّ الأسطر'), ...named(/العناوين/)]) {
      expect(b.getAttribute('type'), b.textContent!).toBe('button');
    }
    fireEvent.click(screen.getByRole('button', { name: 'بحث بكل الكشوف' }));
    const dialog = await screen.findByRole('dialog');
    const go = within(dialog).getByRole('button', { name: 'ابحث' });
    expect(go.getAttribute('type')).toBe('submit');
    fireEvent.change(within(dialog).getByLabelText('البحث'), { target: { value: 'B000002' } });
    await act(async () => {
      fireEvent.click(go);
    });
    await waitFor(() => expect(api.mock.calls.some((c) => c[0] === '/api/finance/statements/search?q=B000002')).toBe(true));
  });

  it('— «بلا بتّ فقط» is the kit’s box (its label names it) and still narrows; «امسح البحث والفلتر» puts it back', async () => {
    await draw();
    fireEvent.click(toggle('فرق في المبلغ'));
    const card = toggle('فرق في المبلغ').parentElement!;
    const box = within(card).getByLabelText(/بلا بتّ فقط \(2\)/) as HTMLInputElement;
    expect(box.type).toBe('checkbox');
    expect(box.className).toContain('accent-[var(--sys-primary)]');
    fireEvent.click(box);
    expect(box.checked).toBe(true);
    const clear = within(card).getByRole('button', { name: 'امسح البحث والفلتر' });
    expect(clear.getAttribute('type')).toBe('button');
    fireEvent.click(clear);
    expect((within(card).getByLabelText(/بلا بتّ فقط/) as HTMLInputElement).checked).toBe(false);
  });

  it('— the pin says its state with aria-pressed and its look follows it (framed while pinned, quiet when not)', async () => {
    await draw();
    fireEvent.click(toggle('فرق في المبلغ'));
    const card = toggle('فرق في المبلغ').parentElement!;
    const pin = within(card).getByRole('button', { name: /العناوين/ });
    expect(pin.getAttribute('aria-pressed')).toBe('true');
    expect(pin.className).toContain('border-[var(--sys-border)]');
    fireEvent.click(pin);
    const unpinned = within(card).getByRole('button', { name: 'ثبّت العناوين' });
    expect(unpinned.getAttribute('aria-pressed')).toBe('false');
    expect(unpinned.className).toContain('border-transparent');
    expect(localStorage.getItem('osm.matching.pinHeader')).toBe('off');
  });

  // 19/11 (the reviewer of #370: the money double-press gaps) — both presses stay shut while their request is in the air.
  it('— «بتّ الأسطر» is grey while its request runs: a second press sends nothing', async () => {
    let release!: () => void;
    answerGate = new Promise<void>((r) => (release = r));
    await draw();
    openAll();
    fireEvent.change(screen.getByLabelText('التفسير'), { target: { value: 'الشركة قالت إنو رجع بدون سبب واضح' } });
    const go = screen.getByRole('button', { name: 'بتّ الأسطر' }) as HTMLButtonElement;
    fireEvent.click(go);
    await waitFor(() => expect(go.disabled).toBe(true));
    fireEvent.click(go);
    expect(api.mock.calls.filter((c) => String(c[0]).endsWith('/decisions'))).toHaveLength(1);
    await act(async () => release());
    await screen.findAllByText('في الكشف وليس عندنا');
  });

  it('— an unmentioned order’s actions are grey while one runs: a second press (the same or another) sends nothing', async () => {
    let release!: () => void;
    answerGate = new Promise<void>((r) => (release = r));
    await draw();
    const unmentioned = toggle('طلبات لم يذكرها أي كشف');
    fireEvent.click(unmentioned);
    const first = within(unmentioned.parentElement!).getAllByRole('button', { name: /انتظر كشفاً لاحقاً/ })[0] as HTMLButtonElement;
    const row = first.parentElement!;
    fireEvent.click(first);
    await waitFor(() => expect(first.disabled).toBe(true));
    const siblings = [...row.querySelectorAll('button')] as HTMLButtonElement[];
    expect(siblings.length).toBeGreaterThan(1);
    for (const b of siblings) {
      expect(b.disabled, b.textContent!).toBe(true);
      fireEvent.click(b);
    }
    expect(api.mock.calls.filter((c) => String(c[0]).endsWith('/order-action'))).toHaveLength(1);
    await act(async () => release());
    await screen.findAllByText('في الكشف وليس عندنا');
  });

  it('— a bulk answer and an order’s action send the bodies they sent', async () => {
    await draw();
    openAll();
    fireEvent.change(screen.getByLabelText('التفسير'), { target: { value: 'الشركة قالت إنو رجع بدون سبب واضح' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'بتّ الأسطر' }));
    });
    await screen.findAllByText('في الكشف وليس عندنا');
    expect(api.mock.calls.find((c) => String(c[0]).endsWith('/decisions'))).toEqual([
      '/api/finance/statements/s1/decisions',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ matchIds: ['d1', 'd2'], resolution: PARKED, note: 'الشركة قالت إنو رجع بدون سبب واضح' }) },
    ]);
    const unmentioned = toggle('طلبات لم يذكرها أي كشف');
    if (unmentioned.getAttribute('aria-expanded') === 'false') fireEvent.click(unmentioned);
    const act1 = within(unmentioned.parentElement!).getAllByRole('button', { name: /انتظر كشفاً لاحقاً/ })[0];
    expect(act1.getAttribute('type')).toBe('button');
    await act(async () => {
      fireEvent.click(act1);
    });
    expect(api.mock.calls.find((c) => String(c[0]).endsWith('/order-action'))).toEqual([
      '/api/finance/statements/s1/matches/u1/order-action',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'WAIT_LATER_STATEMENT' }) },
    ]);
  });
});

/*
 * THE FIGURES, FROZEN FROM main (323e5423, 18/11) BEFORE THIS REQUEST: the same fixture, every queue and fold opened, rendered by
 * the screen as it was, printed exactly these texts in this order — on a desk and on a phone.
 */
describe('the figures did not move', () => {
  // A table on a desk and a card per line in a hand: jsdom draws both, so the two lists are the same list.
  const DESK: string[] = [
    'ST-1', '6', '· 3 بلا بتّ', '2 سُلِّمت · 3 رجعت', '2', '1', '0', '1', '0', '3',
    '0', '2', '0', '1', '2', '1', '0', '1', '0', '3',
    '0', '2', '0', '1', '15 فرقاً · 11 بانتظار البتّ', '15', '4', '11', '7.50 JOD', '2',
    '8.2', '4', '1', '1 سطر', 'B000001', '20001', 'ORD-1', '12.50 JOD', '15.25 JOD', '12.50 JOD',
    '0.00 JOD', '3', 'B000001', '20001', 'ORD-1', '12.50 JOD', '15.25 JOD', '12.50 JOD', '0.00 JOD', '3',
    '2 أسطر بكلمة «تم إرجاعها»', '2', '2', '2', '2', '2 سطر', 'B000002', '20002', 'ORD-2', '12.50 JOD',
    '15.25 JOD', '10.75 JOD', '-1.75 JOD', '4', '3', '0900000002', 'شارع 2', 'B2 | 20002 | كاش', 'B000003', '20003',
    'ORD-3', '20.00 JOD', '15.25 JOD', '0.00 JOD', '-20.00 JOD', '3', '0900000003', 'شارع 3', 'B3 | 20003 | كاش', 'B000002',
    '20002', 'ORD-2', '12.50 JOD', '15.25 JOD', '10.75 JOD', '-1.75 JOD', '4', '3', '0900000002', 'شارع 2',
    'B2 | 20002 | كاش', 'B000003', '20003', 'ORD-3', '20.00 JOD', '15.25 JOD', '0.00 JOD', '-20.00 JOD', '3', '0900000003',
    'شارع 3', 'B3 | 20003 | كاش', '1', '1', '1', '1 سطر', 'B000005', '20005', '15.25 JOD', '12.50 JOD',
    '2.75 JOD', '0900000005', 'شارع 5', 'B5 | 20005 | كاش', 'B000005', '20005', '15.25 JOD', '12.50 JOD', '2.75 JOD', '0900000005',
    'شارع 5', 'B5 | 20005 | كاش', '1', '1 سطر', 'B000007', '20007', 'ORD-7', '15.25 JOD', '0.00 JOD', '3.00 JOD',
    '0900000007', 'شارع 7', 'B7 | 20007 | كاش', 'B000007', '20007', 'ORD-7', '15.25 JOD', '0.00 JOD', '3.00 JOD', '0900000007',
    'شارع 7', 'B7 | 20007 | كاش', '1', '1 سطر', 'M-ORD-8', 'ORD-8', '15.00 JOD', 'M-ORD-8', 'ORD-8', '15.00 JOD',
  ];
  const PHONE = DESK;

  it.each([
    [false, DESK],
    [true, PHONE],
  ])('— every queue and fold open (phone: %s)', async (isPhone, expected) => {
    phone.value = isPhone;
    await draw();
    openAll();
    expect(figures()).toEqual(expected);
  });
});

describe('a phone (jsdom: classes, not pixels)', () => {
  it('— no fixed width wider than the phone in any of the eight files', () => {
    for (const f of FILES) {
      for (const m of source(f).matchAll(/(?:^|[\s"'`])(?:min-|max-)?w-\[(\d+)px\]/g)) expect(Number(m[1]), f).toBeLessThanOrEqual(375);
    }
  });

  it('— «تشغيل المطابقة» and «بحث بكل الكشوف» take the row, the card’s row wraps, and the tools above a queue wrap', async () => {
    phone.value = true;
    await draw();
    const run = screen.getByRole('button', { name: 'تشغيل المطابقة' });
    const search = screen.getByRole('button', { name: 'بحث بكل الكشوف' });
    for (const b of [run, search]) {
      expect(b.className).toContain('w-full');
      expect(b.className).toContain('h-11');
    }
    expect(run.parentElement!.className).toContain('flex-wrap');
    fireEvent.click(toggle('فرق في المبلغ'));
    const tools = within(toggle('فرق في المبلغ').parentElement!).getByLabelText('ابحث بهالقسم').closest('label')!.parentElement!;
    expect(tools.className).toContain('flex-wrap');
    // no pin on a phone: it has cards and no headings
    expect(within(toggle('فرق في المبلغ').parentElement!).queryByRole('button', { name: /العناوين/ })).toBeNull();
  });

  it('— on a desk neither is stretched', async () => {
    await draw();
    expect(screen.getByRole('button', { name: 'تشغيل المطابقة' }).className).not.toContain('w-full');
    expect(screen.getByRole('button', { name: 'بحث بكل الكشوف' }).className).not.toContain('w-full');
  });
});
