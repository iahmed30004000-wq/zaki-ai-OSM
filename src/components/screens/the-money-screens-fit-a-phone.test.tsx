// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

/**
 * THE MONEY SCREENS, IN A HAND — WHAT IS LEFT OF THE FINANCE AUDIT (M6).
 *
 * M1–M5 mended the parts every screen shares (16px fields, the sheet, 44px contact buttons, the card that wraps and
 * says what is wide, the bar on the bottom edge). What was left were the money screens' OWN arrangements, which a
 * shared part cannot reach: FIN-01 · 02 · 04 · 06 · 07 · 10 · 11 · 12 · 13 · 14 · 15 · 16 · 17 · 18 · 19 · 20 · 22 · 23
 * (and the `wide` flag on the notes of FIN-09).
 *
 * THE RULE THAT SHAPES EVERY CHANGE: THE DESK DOES NOT MOVE.
 * Each of these screens now asks `useIsPhone()` and draws a different SET of controls below `md`, or the same classes
 * the desk always drew. So every group below ends in a DESK case that holds the old arrangement exactly (the old
 * class, the old order, the old text), and the phone cases hold what changed. Nothing here adds a stylesheet byte:
 * the phone layouts are written in classes the product already ships (measured on the whole tree, before and after).
 *
 * Nothing here computes money. Which step is next on a statement only decides which button is the main one; whether
 * a press is allowed is still asked of `settlement-gates`, exactly as on the desk.
 *
 * jsdom has no layout: the wrapping, the heights and the stacking were measured in a real browser at 375px (see the
 * pull request). What is held here is what the layout depends on.
 */

const { apiJson, apiFetch, user, phone } = vi.hoisted(() => ({
  apiJson: vi.fn(),
  apiFetch: vi.fn(),
  user: { current: null as unknown },
  phone: { value: true },
}));

vi.mock('@/lib/api-client', () => ({
  apiJson: (...a: unknown[]) => apiJson(...a),
  apiFetch: (...a: unknown[]) => apiFetch(...a),
}));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/',
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ locale: 'ar', isRtl: true, t: { cancel: 'تراجع' }, currentUser: user.current }),
}));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => <h1>العنوان</h1> }));
vi.mock('@/components/ui/Confirm', () => ({
  useConfirm: () => vi.fn(async () => true),
  useAsk: () => vi.fn(async () => null),
  useTell: () => vi.fn(),
}));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), done: vi.fn(), show: vi.fn() }) }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => phone.value }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/hooks/useRegions', () => ({ useRegions: () => ({ regions: [] }) }));
vi.mock('@/hooks/useProducts', () => ({ useProducts: () => ({ products: [] }) }));
vi.mock('@/components/screens/commission/PeriodProgress', () => ({ PeriodProgress: () => null }));
vi.mock('@/components/screens/commission/FairnessPanel', () => ({ FairnessPanel: () => null }));
vi.mock('@/components/screens/commission/PayoutDialog', () => ({ PayoutDialog: () => null }));
vi.mock('@/components/screens/finance/ManualStatementDialog', () => ({ ManualStatementDialog: () => null }));
vi.mock('@/components/screens/tracking/CollectDialog', () => ({ CollectDialog: () => null }));
vi.mock('@/components/scan/ScanButton', () => ({ ScanButton: () => null }));
vi.mock('@/hooks/useLiveRefresh', () => ({
  useLiveRefresh: (load: () => unknown) => {
    const latest = React.useRef(load);
    latest.current = load;
    React.useEffect(() => {
      void latest.current();
    }, []);
  },
}));

import { WalletsScreen } from './finance/WalletsScreen';
import { CollectionScreen } from './finance/CollectionScreen';
import { MatchingScreen } from './finance/MatchingScreen';
import { ManualMatching } from './finance/ManualMatching';
import { DifferenceActions } from './finance/DifferenceActions';
import { ClosingScreen } from './finance/ClosingScreen';
import { TransfersScreen } from './finance/TransfersScreen';
import { CommissionSettingsScreen } from './CommissionSettingsScreen';
import { FinanceProfitScreen } from './FinanceProfitScreen';
import { AgentCustodyScreen } from './AgentCustodyScreen';
import { UserSalary } from './users/UserSalary';
import { approvalRefusal } from '@/lib/settlement-gates';
import { RESOLUTIONS, RESOLUTION_MEANING } from '@/lib/settlement-difference';

const MONEY_KEYS = [
  'finance.cashbox_view',
  'finance.cashbox',
  'finance.wallets_manage',
  'finance.closing_approve',
  'settlement.approve',
  'settlement.review',
  'ops.track',
  'commission.view',
  'commission.manage',
  'finance.create',
];

beforeEach(() => {
  vi.clearAllMocks();
  phone.value = true;
  user.current = { id: 'u1', name: 'سارة', status: 'ACTIVE', role: 'COMPANY_ADMIN', permissions: MONEY_KEYS };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The list is drawn twice (a table for the desk, cards for a phone); the cards are what a phone reads. */
const cards = (root: ParentNode = document) => [...root.querySelectorAll('ul > li')] as HTMLElement[];
const labelsOf = (card: HTMLElement) => [...card.querySelectorAll('dt')].map((d) => d.textContent);

/* ═══════════════════════ المحافظ — FIN-01 · 12 · 13 · 14 ═══════════════════════ */

describe('«المحافظ»', () => {
  const WALLET = {
    id: 'w1', name: 'الصندوق', currencyCode: 'JOD', isActive: true, opening: 1000, in: 500, out: 250, balance: 1250,
    movements: 2, country: null, openingCount: null,
  };
  const MOVES = [
    {
      id: 'm1', direction: 'IN', amount: 500, party: 'شركة الشحن', category: 'COURIER_SETTLEMENT', note: 'تحصيل كشف أيلول',
      reversalReason: null, createdAt: '2026-10-20T10:00:00.000Z', createdByName: 'سارة', isReversal: false, wasReversed: false,
    },
    {
      id: 'm2', direction: 'OUT', amount: 250, party: 'مورّد', category: 'EXPENSE', note: null,
      reversalReason: null, createdAt: '2026-10-21T10:00:00.000Z', createdByName: 'هبة', isReversal: false, wasReversed: false,
    },
  ];
  const draw = async (wallet = WALLET) => {
    apiJson.mockImplementation(async (url: string) =>
      String(url).includes('/movements') ? { movements: MOVES } : { wallets: [wallet] }
    );
    const view = render(<WalletsScreen />);
    await screen.findAllByText('شركة الشحن');
    return view;
  };
  const record = () => screen.getByRole('button', { name: /حركة جديدة/ });
  const fold = () => document.querySelector('details[data-advanced-group]') as HTMLElement;

  it('FIN-01: the day’s press comes first and the row wraps, with the upkeep folded on a line of its own', async () => {
    await draw();
    const group = record().parentElement!;
    expect(group.className).toContain('flex-wrap');
    expect(group.className).toContain('w-full');
    expect(fold().className, 'الطيّة لا تأخذ سطرها').toContain('w-full');
    // The press the screen is for is first in the row; the fold that holds rename / stop / delete is after it.
    expect(record().compareDocumentPosition(fold()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Nothing was removed: the three upkeep controls are still in the fold.
    for (const name of ['عدّل الاسم', 'أوقف المحفظة', 'احذف']) expect(within(fold()).getByRole('button', { name })).toBeTruthy();
  });

  it('FIN-01 DESK: the row is the one it always was — the fold, the divider, then the press, and no wrapping', async () => {
    phone.value = false;
    await draw();
    const group = record().parentElement!;
    expect(group.className).toBe('flex items-center gap-1.5');
    expect(group.querySelector('.w-px'), 'الفاصل غاب').not.toBeNull();
    expect(fold().compareDocumentPosition(record()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(fold().className).not.toContain('w-full');
  });

  it('FIN-01: a STOPPED wallet’s way back is beside the press on a phone, before the fold; on the desk it is before the fold too', async () => {
    const stopped = { ...WALLET, isActive: false };
    await draw(stopped);
    const restart = screen.getByRole('button', { name: /أعِد تشغيلها/ });
    expect((record() as HTMLButtonElement).disabled).toBe(true);
    expect(restart.parentElement).toBe(record().parentElement);
    expect(record().compareDocumentPosition(restart) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(restart.compareDocumentPosition(fold()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    cleanup();
    phone.value = false;
    await draw(stopped);
    expect(
      screen.getByRole('button', { name: /أعِد تشغيلها/ }).compareDocumentPosition(fold()) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(record().parentElement!.className).toBe('flex items-center gap-1.5');
  });

  it('FIN-01 NEGATIVE: without the manage key there is no fold and no «أعِد تشغيلها», and the press is still first', async () => {
    user.current = { id: 'u1', status: 'ACTIVE', role: 'COMPANY_ADMIN', permissions: ['finance.cashbox_view', 'finance.cashbox'] };
    await draw({ ...WALLET, isActive: false });
    expect(fold()).toBeNull();
    expect(screen.queryByRole('button', { name: /أعِد تشغيلها/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /محفظة جديدة/ })).toBeNull();
    expect(record()).toBeTruthy();
  });

  it('FIN-12: the sentence takes the line and «محفظة جديدة» sits under it; the desk keeps them side by side', async () => {
    await draw();
    const row = screen.getByRole('button', { name: /محفظة جديدة/ }).parentElement!;
    expect(row.className).toBe('flex flex-col gap-2');
    cleanup();
    phone.value = false;
    await draw();
    expect(screen.getByRole('button', { name: /محفظة جديدة/ }).parentElement!.className).toBe(
      'flex items-center justify-between gap-3'
    );
  });

  it('FIN-13: a wallet card is compact — the balance with separators, and the three figures each under its name', async () => {
    await draw();
    const card = screen.getByRole('button', { name: /الصندوق/ });
    expect(card.textContent).toContain('1,250');
    expect(card.querySelector('.grid-cols-3'), 'لا شبكة للأرقام الثلاثة').not.toBeNull();
    expect(card.className).toContain('p-3');
    expect(card.parentElement!.className).toBe('grid gap-2');
  });

  it('FIN-13 DESK: the card is the old one, down to the dense line', async () => {
    phone.value = false;
    await draw();
    const card = screen.getByRole('button', { name: /الصندوق/ });
    expect(card.textContent).toContain('افتتاحي 1000 · وارد 500 · صادر 250');
    expect(card.className).toContain('p-4');
    expect(card.parentElement!.className).toBe('grid gap-3 sm:grid-cols-2 lg:grid-cols-3');
  });

  it('FIN-14: a movement card is led by the party and ONE signed figure; no empty «صادر» line; the note has the card’s width', async () => {
    await draw();
    const [incoming, outgoing] = cards().filter((c) => c.textContent?.includes('شركة الشحن') || c.textContent?.includes('مورّد'));
    expect(labelsOf(incoming)).toEqual(['التاريخ', 'البند', 'الملاحظة']);
    expect(incoming.textContent).toContain('+');
    expect(incoming.textContent).toContain('500');
    expect(outgoing.textContent).toContain('−');
    expect(labelsOf(outgoing)).not.toContain('وارد');
    expect(labelsOf(outgoing)).not.toContain('صادر');
    const note = [...incoming.querySelectorAll('dl > div')].find((d) => d.textContent?.includes('الملاحظة'))!;
    expect(note.className, 'الملاحظة ليست بعرض البطاقة').toContain('flex-col');
  });

  it('a digit is never taken away: 12.345 stays 12.345 on a phone card (balance, opening, in, out) and on a movement', async () => {
    const odd = { ...WALLET, balance: 12.345, opening: 1.125, in: 12.345, out: 1.125 };
    apiJson.mockImplementation(async (url: string) =>
      String(url).includes('/movements')
        ? { movements: [{ ...MOVES[0], amount: 12.345 }] }
        : { wallets: [odd] }
    );
    render(<WalletsScreen />);
    await screen.findAllByText('شركة الشحن');
    const card = screen.getByRole('button', { name: /الصندوق/ });
    expect(card.textContent).toContain('12.345 JOD');
    expect(card.textContent).toContain('1.125');
    expect(card.textContent).not.toMatch(/12\.35|1\.13/);
    const movement = cards().find((c) => c.textContent?.includes('شركة الشحن'))!;
    expect(movement.textContent).toContain('+12.345');
    expect(movement.textContent).not.toContain('12.35');
  });

  it('and a wallet of whole numbers keeps the currency’s own two decimals, the four figures alike', async () => {
    await draw();
    const card = screen.getByRole('button', { name: /الصندوق/ });
    expect(card.textContent).toContain('1,250.00 JOD');
    expect(card.textContent).toContain('1,000.00');
    expect(card.textContent).toContain('250.00');
  });

  it('FIN-14 DESK: the columns are the old six, in and out apart, the note under the party', async () => {
    phone.value = false;
    await draw();
    const heads = [...document.querySelectorAll('thead th')].map((t) => t.textContent);
    expect(heads).toEqual(['التاريخ', 'الطرف', 'البند', 'وارد', 'صادر', 'سجّلها', '']);
    const first = cards().find((c) => c.textContent?.includes('شركة الشحن'))!;
    expect(labelsOf(first)).toEqual(['البند', 'وارد', 'صادر', 'سجّلها']);
    expect(document.querySelector('tbody tr')!.textContent).toContain('تحصيل كشف أيلول');
  });
});

/* ═══════════════════════ التحصيل والكشوف — FIN-02 · 15 ═══════════════════════ */

describe('«التحصيل والكشوف»', () => {
  const gap = { claimed: 100, received: 0, gap: 100, needsExplanation: false, explained: false, unconvertible: 0 };
  const statement = (over: Record<string, unknown> = {}) => ({
    id: 's1', reference: 'ST-2026-09', fileName: 'x.xlsx', status: 'IMPORTED', approvedAt: null, currencyCode: 'JOD',
    totalAmount: 100, createdAt: '2026-10-24T00:00:00Z', counts: { lines: 3, receipts: 0, matches: 0 }, receipts: [], gap, ...over,
  });
  const draw = async (s = statement()) => {
    apiJson.mockImplementation(async (url: string) => {
      if (String(url).startsWith('/api/finance/statements')) return { statements: [s] };
      if (String(url).startsWith('/api/ops/references')) return { providers: [{ id: 'p1', name: 'أبو علي' }] };
      if (String(url).startsWith('/api/finance/wallets')) return { wallets: [] };
      return {};
    });
    render(<CollectionScreen />);
    await screen.findAllByText('ST-2026-09');
  };
  const foot = () => cards()[0].querySelector('.card-acts') as HTMLElement;
  const isMain = (b: HTMLElement) => b.className.includes('bg-[var(--sys-primary)]');

  it('FIN-02: the NEXT step is the main button; the others are outlined', async () => {
    await draw();
    const [receipt, match] = ['إيصال استلام', 'مطابقة'].map((n) => within(foot()).getByRole('button', { name: n }));
    expect(isMain(receipt)).toBe(true);
    expect(isMain(match)).toBe(false);
    cleanup();
    await draw(statement({ status: 'RECEIPTED', counts: { lines: 3, receipts: 1, matches: 0 }, gap: { ...gap, received: 100, gap: 0 } }));
    expect(isMain(within(foot()).getByRole('button', { name: 'مطابقة' }))).toBe(true);
    expect(isMain(within(foot()).getByRole('button', { name: 'إيصال استلام' }))).toBe(false);
  });

  it('FIN-02: the button that takes the import back is the LAST one and is not drawn like «اعتماد»', async () => {
    await draw();
    const buttons = [...foot().querySelectorAll('button')];
    expect(buttons.at(-1)!.textContent).toBe('إلغاء الاستيراد');
    expect(buttons.at(-1)!.className).toContain('text-[var(--sys-destructive)]');
    expect(isMain(buttons.at(-1)!)).toBe(false);
  });

  it('FIN-02: a grey «مطابقة» says why, in a line a phone can read (not only in a title)', async () => {
    await draw();
    const match = within(foot()).getByRole('button', { name: 'مطابقة' }) as HTMLButtonElement;
    expect(match.disabled).toBe(true);
    expect(within(foot()).getByText('سجّل إيصال الاستلام أولاً')).toBeTruthy();
  });

  it('FIN-02: a grey «اعتماد» prints the server’s own sentence, read from the same function the door uses', async () => {
    const s = statement({
      status: 'MATCHED', counts: { lines: 3, receipts: 1, matches: 3, openLines: 2 }, gap: { ...gap, received: 100, gap: 0 },
    });
    const refusal = approvalRefusal({
      status: s.status, approvedAt: null, receipts: 1, matches: 3, openLines: 2, gap: s.gap, explanation: null,
    });
    expect(refusal, 'الشرط لم يمنع الاعتماد').not.toBeNull();
    await draw(s);
    expect((within(foot()).getByRole('button', { name: 'اعتماد' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(foot()).getByText(refusal!.error)).toBeTruthy();
  });

  it('FIN-02 NEGATIVE: a key the person does not hold draws no «اعتماد» at all', async () => {
    user.current = { id: 'u1', status: 'ACTIVE', role: 'COMPANY_ADMIN', permissions: ['finance.cashbox_view'] };
    await draw(statement({ status: 'MATCHED', counts: { lines: 3, receipts: 1, matches: 3 } }));
    expect(within(foot()).queryByRole('button', { name: 'اعتماد' })).toBeNull();
  });

  it('FIN-02 DESK: the five words are the old text links, «إلغاء الاستيراد» first, with no sentence under them', async () => {
    phone.value = false;
    await draw();
    const buttons = [...foot().querySelectorAll('button')];
    expect(buttons[0].textContent).toBe('إلغاء الاستيراد');
    for (const b of buttons) expect(b.className).toContain('hover:underline');
    expect(foot().textContent).not.toContain('سجّل إيصال الاستلام أولاً');
  });

  it('FIN-15: the import form is a sheet behind ONE button; the list comes first', async () => {
    await draw();
    expect(screen.queryByLabelText('مرجع الكشف')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /استيراد كشف/ }));
    expect(await screen.findByLabelText('مرجع الكشف')).toBeTruthy();
    expect(screen.getByLabelText('شركة الشحن')).toBeTruthy();
    // The picker has a 44px face and says what was chosen.
    expect(screen.getByText('اختر الملف').closest('label')!.className).toContain('min-h-11');
  });

  it('FIN-15: a REFUSED import is printed inside the sheet, where the person is looking, and the sheet stays open', async () => {
    apiJson.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') throw new Error('هذا الكشف مستورد من قبل');
      if (String(url).startsWith('/api/finance/statements')) return { statements: [statement()] };
      if (String(url).startsWith('/api/ops/references')) return { providers: [{ id: 'p1', name: 'أبو علي' }] };
      return { wallets: [] };
    });
    render(<CollectionScreen />);
    await screen.findAllByText('ST-2026-09');
    fireEvent.click(screen.getByRole('button', { name: /استيراد كشف/ }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dialog).getByRole('option', { name: 'أبو علي' })).toBeTruthy());
    fireEvent.change(within(dialog).getByLabelText('شركة الشحن'), { target: { value: 'p1' } });
    fireEvent.change(within(dialog).getByLabelText('مرجع الكشف'), { target: { value: 'ST-2026-10' } });
    const file = new File(['a,b'], 'x.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: async () => 'a,b' });
    fireEvent.change(dialog.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [file] } });
    await waitFor(() => expect((within(dialog).getByRole('button', { name: 'استيراد' }) as HTMLButtonElement).disabled).toBe(false));
    // Nothing refused yet: no sentence in the sheet.
    expect(within(dialog).queryByRole('alert')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'استيراد' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toBe('هذا الكشف مستورد من قبل');
    expect(screen.getByRole('dialog')).toBe(dialog);
  });

  it('FIN-15 NEGATIVE: opening the sheet again does not greet the person with the last refusal', async () => {
    apiJson.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') throw new Error('هذا الكشف مستورد من قبل');
      if (String(url).startsWith('/api/finance/statements')) return { statements: [statement()] };
      if (String(url).startsWith('/api/ops/references')) return { providers: [{ id: 'p1', name: 'أبو علي' }] };
      return { wallets: [] };
    });
    render(<CollectionScreen />);
    await screen.findAllByText('ST-2026-09');
    fireEvent.click(screen.getByRole('button', { name: /استيراد كشف/ }));
    let dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dialog).getByRole('option', { name: 'أبو علي' })).toBeTruthy());
    fireEvent.change(within(dialog).getByLabelText('شركة الشحن'), { target: { value: 'p1' } });
    fireEvent.change(within(dialog).getByLabelText('مرجع الكشف'), { target: { value: 'ST-2026-10' } });
    const file = new File(['a,b'], 'x.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: async () => 'a,b' });
    fireEvent.change(dialog.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [file] } });
    await waitFor(() => expect((within(dialog).getByRole('button', { name: 'استيراد' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(dialog).getByRole('button', { name: 'استيراد' }));
    await within(dialog).findByRole('alert');
    fireEvent.click(within(dialog).getByRole('button', { name: 'إغلاق' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: /استيراد كشف/ }));
    dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('alert')).toBeNull();
  });

  it('FIN-15 DESK: the form is in the page, as it was, and there is no extra button', async () => {
    phone.value = false;
    await draw();
    expect(screen.getByLabelText('مرجع الكشف')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /استيراد كشف/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'استيراد' })).toBeTruthy();
  });
});

/* ═══════════════════════ المطابقة — FIN-11 · 16 and the decision pair (FIN-10) ═══════════════════════ */

describe('«المطابقة»', () => {
  const STATEMENT = {
    id: 's1', reference: 'ST-1', fileName: 'f.xlsx', status: 'IMPORTED', approvedAt: null, draft: false, currencyCode: 'JOD',
    totalAmount: 10, createdAt: '2026-10-24T00:00:00Z', counts: { lines: 1, receipts: 0, matches: 0 }, receipts: [],
    gap: { claimed: 10, received: 0, gap: 10, needsExplanation: false, explained: false, unconvertible: 0 },
  };
  const draw = async (s: Record<string, unknown> = STATEMENT) => {
    user.current = { id: 'u1', status: 'ACTIVE', role: 'COMPANY_ADMIN', permissions: ['settlement.review'] };
    apiJson.mockImplementation(async (url: string) =>
      String(url) === '/api/finance/statements' ? { statements: [s] } : { statement: { matches: [] } }
    );
    render(<MatchingScreen />);
    return screen.findByRole('button', { name: 'تشغيل المطابقة' });
  };

  it('FIN-11: «تشغيل المطابقة» is 44px and the width of the line, and a grey one says why', async () => {
    const run = (await draw()) as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    expect(run.className).toContain('h-11');
    expect(run.className).toContain('md:h-10');
    expect(run.className).toContain('w-full');
    expect(screen.getByText('سجّل إيصال الاستلام أولاً')).toBeTruthy();
  });

  it('FIN-11 NEGATIVE: with a receipt the button is on and no reason is printed', async () => {
    const run = (await draw({ ...STATEMENT, counts: { lines: 1, receipts: 1, matches: 0 } })) as HTMLButtonElement;
    await waitFor(() => expect(run.disabled).toBe(false));
    expect(screen.queryByText('سجّل إيصال الاستلام أولاً')).toBeNull();
    // and not the title's sentence either: a button that works has nothing to explain
    expect(document.body.textContent).not.toContain('إعادة تشغيل المطابقة');
  });

  it('FIN-11 DESK: the old height (md:h-10), no full width and no sentence', async () => {
    phone.value = false;
    const run = await draw();
    expect(run.className).not.toContain('w-full');
    expect(run.className).toContain('md:h-10');
    expect(screen.queryByText('سجّل إيصال الاستلام أولاً')).toBeNull();
  });

  describe('the pair of money decisions (FIN-10)', () => {
    const props = {
      statementId: 's1', matchId: 'm1', orderId: null, orderNumber: null, resolution: null, resolutionNote: null,
      onResolved: () => undefined,
    };
    const pair = () => RESOLUTIONS.map((r) => screen.getAllByRole('button').find((b) => b.getAttribute('title') === RESOLUTION_MEANING[r])!);

    it('each wears its colour AT REST on a phone, and the meaning of each is printed under the pair', () => {
      render(<DifferenceActions {...props} />);
      const [first, second] = pair();
      expect(first.className).toContain('border-[var(--sys-success)] text-[var(--sys-success)]');
      expect(first.className).not.toContain('hover:');
      expect(second.className).toContain('border-[var(--sys-warning)] text-[var(--sys-warning)]');
      for (const r of RESOLUTIONS) expect(document.body.textContent).toContain(RESOLUTION_MEANING[r]);
    });

    it('DESK: grey at rest and coloured only under the pointer, and the meaning only in the title', () => {
      phone.value = false;
      render(<DifferenceActions {...props} />);
      const [first, second] = pair();
      expect(first.className).toContain('hover:border-[var(--sys-success)] hover:text-[var(--sys-success)]');
      expect(first.className).toContain('text-[var(--sys-muted-foreground)]');
      expect(second.className).toContain('hover:text-[var(--sys-warning)]');
      for (const r of RESOLUTIONS) expect(document.body.textContent).not.toContain(RESOLUTION_MEANING[r]);
    });

    it('a pair that cannot be answered (a line no order carries) prints no meanings', () => {
      render(<DifferenceActions {...props} parkOnly />);
      for (const r of RESOLUTIONS) expect(document.body.textContent).not.toContain(RESOLUTION_MEANING[r]);
    });
  });
});

describe('«مطابقة يدوية» — the instruction card (FIN-16)', () => {
  const draw = async () => {
    user.current = { id: 'u1', status: 'ACTIVE', role: 'COMPANY_ADMIN', permissions: ['ops.track', 'finance.cashbox', 'settlement.review'] };
    apiJson.mockImplementation(async (url: string) => {
      const u = new URL(String(url), 'http://x');
      if (u.pathname !== '/api/ops/tracking') return { providers: [], wallets: [], products: [], statements: [] };
      return {
        orders: [],
        pagination: { total: 0, page: 1, limit: 50, totalPages: 1 },
        facts: {
          total: 0,
          tasks: { CANCELLED: 0, CHANGED: 0, FAILED: 0, RETURNING: 0, LATE: 0, NO_BARCODE: 0, COLLECT: 0 },
          lateCount: 0,
          couriers: [],
          regions: [],
          ages: { fresh: 0, few: 0, week: 0, old: 0 },
        },
      };
    });
    render(<ManualMatching />);
    await screen.findByLabelText('جهة الشحن');
  };

  it('keeps a title and a one-line stepper, and the five rules wait in a fold that says what it holds', async () => {
    await draw();
    expect(screen.getByText('1 اختر الجهة · 2 سجّل التسليم أو الرجوع · 3 استلم المال')).toBeTruthy();
    const fold = document.querySelector('details[data-advanced-group]') as HTMLDetailsElement;
    expect(fold.open).toBe(false);
    expect(fold.querySelector('summary')!.textContent).toContain('كيف تعمل؟');
    // Folded, not removed: the paragraphs are in the page for find-in-page and for a reader that opens it.
    expect(fold.querySelectorAll('p')).toHaveLength(5);
    expect(fold.textContent).toContain('«استلمت منه» لنقد بعملة الطلب نفسها');
  });

  it('DESK: the five paragraphs are in the card, unfolded, and there is no stepper', async () => {
    phone.value = false;
    await draw();
    expect(screen.getByText(/1 — اختر الجهة، أو ابحث/)).toBeTruthy();
    expect(screen.getByText(/2 — ما سلّمه وما رجع/)).toBeTruthy();
    expect(screen.getByText(/3 — المال: علّم المسلَّم/)).toBeTruthy();
    expect(document.querySelector('details[data-advanced-group]')).toBeNull();
    expect(screen.queryByText(/1 اختر الجهة ·/)).toBeNull();
  });
});

/* ═══════════════════════ إغلاق اليوم — FIN-07 ═══════════════════════ */

describe('«إغلاق اليوم»', () => {
  const ROW = {
    walletId: 'w1', walletName: 'الصندوق', currencyCode: 'JOD', minorUnit: 3, bookBalance: 4350, blockedBy: null,
    closing: { id: 'c1', status: 'OPEN', bookBalance: 4350, actualBalance: 4350, difference: 0, explanation: null, recordedById: 'someone' },
  };
  const draw = async () => {
    apiJson.mockResolvedValue({ rows: [ROW] });
    render(<ClosingScreen />);
    return screen.findByRole('button', { name: 'اعتماد' });
  };

  it('«اعتماد» is 44px under a finger (and 32px on a desk, as it was), and the rule is written under it', async () => {
    const approve = await draw();
    expect(approve.className).toContain('h-11 md:h-8');
    expect(approve.className).not.toMatch(/(^|\s)h-8(\s|$)/);
    expect(screen.getByText('يعتمده شخص غير من سجّل الحركات أو الجرد')).toBeTruthy();
  });

  it('the counted figure and the difference are money with separators on a phone', async () => {
    await draw();
    expect(document.body.textContent).toContain('4,350');
    expect(document.body.textContent).not.toContain('الجرد 4350');
  });

  it('the books balance and the counted figure share the currency’s decimals on a phone; the desk line is untouched', async () => {
    apiJson.mockResolvedValue({ rows: [{ ...ROW, bookBalance: 4350.5, closing: { ...ROW.closing, bookBalance: 4350.5, actualBalance: 4350.5 } }] });
    render(<ClosingScreen />);
    await screen.findByRole('button', { name: 'اعتماد' });
    expect(document.body.textContent).toContain('رصيد الدفاتر 4,350.500 JOD · الجرد 4,350.500 JOD');
    cleanup();
    phone.value = false;
    apiJson.mockResolvedValue({ rows: [{ ...ROW, bookBalance: 4350.5, closing: { ...ROW.closing, bookBalance: 4350.5, actualBalance: 4350.5 } }] });
    render(<ClosingScreen />);
    await screen.findByRole('button', { name: 'اعتماد' });
    expect(document.body.textContent).toContain('رصيد الدفاتر 4,350.50 JOD · الجرد 4350.5');
  });

  it('DESK: the figures are the raw ones they were, and the rule stays a hover title', async () => {
    phone.value = false;
    const approve = await draw();
    expect(document.body.textContent).toContain('الجرد 4350');
    expect(approve.getAttribute('title')).toBe('يعتمده شخص غير من سجّل الحركات أو الجرد');
    expect(screen.queryByText('يعتمده شخص غير من سجّل الحركات أو الجرد')).toBeNull();
  });

  it('NEGATIVE: whoever cannot approve is told nothing about approving', async () => {
    user.current = { id: 'u1', status: 'ACTIVE', role: 'COMPANY_ADMIN', permissions: ['finance.cashbox_view', 'finance.cashbox'] };
    apiJson.mockResolvedValue({ rows: [ROW] });
    render(<ClosingScreen />);
    await screen.findByText('الصندوق');
    expect(screen.queryByRole('button', { name: 'اعتماد' })).toBeNull();
    expect(screen.queryByText('يعتمده شخص غير من سجّل الحركات أو الجرد')).toBeNull();
  });
});

/* ═══════════════════════ التحويلات — FIN-06 ═══════════════════════ */

describe('«التحويلات»', () => {
  const WALLETS = [
    { id: 'a', name: 'الصندوق', currencyCode: 'JOD', isActive: true, store: { id: 's1', name: 'متجر أ' }, country: { id: 'c', name: 'الأردن' } },
    { id: 'b', name: 'حساب البنك', currencyCode: 'JOD', isActive: true, store: { id: 's1', name: 'متجر أ' }, country: { id: 'c', name: 'الأردن' } },
  ];
  const TRANSFER = {
    id: 't1', createdAt: '2026-10-20T10:00:00Z', kindLabel: 'داخل متجر', from: { name: 'الصندوق', currencyCode: 'JOD', store: null },
    to: { name: 'حساب البنك', currencyCode: 'JOD', store: null }, amountOut: 20, amountIn: 20, exchangeRate: 1, note: 'إيداع نهاية اليوم',
  };
  const RATED = { ...TRANSFER, id: 't2', exchangeRate: 0.71, note: null };
  const draw = async () => {
    apiJson.mockImplementation(async (url: string) =>
      String(url).includes('/transfers') ? { transfers: [TRANSFER, RATED] } : { wallets: WALLETS }
    );
    const view = render(<TransfersScreen />);
    await screen.findAllByText('إيداع نهاية اليوم');
    return view;
  };
  const submit = () => screen.getByRole('button', { name: 'تحويل' });

  it('the button is the width of the line, under the sentence, and nothing is fused to it', async () => {
    await draw();
    expect(submit().parentElement!.className).toBe('flex flex-col gap-2');
    expect(submit().className).toContain('w-full');
  });

  it('DESK: the old right-aligned row and the old button', async () => {
    phone.value = false;
    await draw();
    expect(submit().parentElement!.className).toBe('flex justify-end');
    expect(submit().className).not.toContain('w-full');
  });

  it('a card has no «السعر 1» line: the rate is said under the amount only when it is a rate', async () => {
    await draw();
    const [plain, rated] = cards().filter((c) => c.textContent?.includes('الصندوق'));
    expect(labelsOf(plain)).not.toContain('السعر');
    expect(plain.textContent).not.toContain('السعر 1');
    expect(rated.textContent).toContain('السعر 0.71');
  });

  it('the note is a wide field, and the desk table still has its rate column', async () => {
    await draw();
    const field = [...cards()[0].querySelectorAll('dl > div')].find((d) => d.textContent?.includes('الملاحظة'))!;
    expect(field.className).toContain('flex-col');
    expect([...document.querySelectorAll('thead th')].map((t) => t.textContent)).toContain('السعر');
  });

  it('DESK: the table keeps its rate column and prints the rate on every row, 1 included', async () => {
    phone.value = false;
    await draw();
    const heads = [...document.querySelectorAll('thead th')].map((t) => t.textContent);
    const at = heads.indexOf('السعر');
    expect(at).toBeGreaterThan(-1);
    const rows = [...document.querySelectorAll('tbody tr')];
    expect(rows.map((r) => r.children[at].textContent)).toEqual(['1', '0.71']);
    // and the card says nothing extra about it on a desk: the table is what a desk reads
    expect(cards()[1].textContent).not.toContain('السعر 0.71');
  });
});

/* ═══════════════════════ العمولات — FIN-04 · 19 · 20 ═══════════════════════ */

describe('«العمولات»', () => {
  const TIERED = {
    id: 'r1', name: 'قاعدة الشرائح', appliesToRole: 'MODERATOR', appliesToUserId: null, appliesToUserName: null, type: 'FIXED', value: 0,
    metric: 'DELIVERED_ORDERS', period: 'MONTHLY', minOrders: null, effectiveFrom: '2026-10-01', effectiveTo: null, isActive: true,
    inForce: true, tiers: [{ from: 0, to: 50, value: 0.5, label: null }, { from: 51, to: null, value: 1, label: null }],
  };
  const draw = async () => {
    apiJson.mockImplementation(async (url: string) => {
      if (String(url).startsWith('/api/settings/commission')) return { rules: [TIERED], noRuleInForce: false };
      if (String(url).startsWith('/api/finance/commission')) return { totals: [], currencyCode: 'JOD', fairness: null };
      return {};
    });
    render(<CommissionSettingsScreen />);
    await screen.findAllByText('قاعدة الشرائح');
  };

  it('FIN-20: «قاعدة جديدة» is the first thing under the title, once, and not in the third card’s header', async () => {
    await draw();
    const buttons = screen.getAllByRole('button', { name: /قاعدة جديدة/ });
    expect(buttons).toHaveLength(1);
    expect(buttons[0].className).toContain('w-full');
    expect(screen.getByRole('heading', { name: 'العنوان' }).nextElementSibling).toBe(buttons[0]);
  });

  it('FIN-20 DESK: it is in the header of the rules card, as it was', async () => {
    phone.value = false;
    await draw();
    const button = screen.getByRole('button', { name: /قاعدة جديدة/ });
    expect(button.parentElement!.textContent).toContain('قواعد العمولة');
    expect(button.className).not.toContain('w-full');
  });

  it('FIN-19: the bands are printed on the card, not only in a title', async () => {
    await draw();
    const card = cards().find((c) => c.textContent?.includes('قاعدة الشرائح'))!;
    expect(card.textContent).toContain('2 شرائح');
    expect(card.textContent).toContain('0–50: 0.5');
    expect(card.textContent).toContain('51+: 1');
    const field = [...card.querySelectorAll('dl > div')].find((d) => d.textContent?.includes('القيمة'))!;
    expect(field.className).toContain('flex-col');
  });

  it('FIN-19 DESK: only the count, the bands stay in the title; the field is one line', async () => {
    phone.value = false;
    await draw();
    const card = cards().find((c) => c.textContent?.includes('قاعدة الشرائح'))!;
    expect(card.textContent).not.toContain('0–50: 0.5');
    const field = [...card.querySelectorAll('dl > div')].find((d) => d.textContent?.includes('القيمة'))!;
    expect(field.className).toContain('justify-between');
  });

  const openTiers = async () => {
    await draw();
    fireEvent.click(screen.getByRole('button', { name: /قاعدة جديدة/ }));
    // A rule paid per order has one value; bands need a measure that is counted over a period.
    fireEvent.change(await screen.findByLabelText('تُحتسب على'), { target: { value: 'CONFIRMED_COUNT' } });
    fireEvent.click(await screen.findByRole('button', { name: 'شرائح' }));
  };

  it('FIN-04: each band is a small card — three labelled numbers, then the name and the ×', async () => {
    await openTiers();
    const dialog = screen.getByRole('dialog');
    const spin = within(dialog).getAllByRole('spinbutton');
    // Three number boxes per band, each inside a label that names it, none wider than its cell.
    const band = spin[0].closest('.grid-cols-3') as HTMLElement;
    expect(band, 'لا شبكة بثلاثة أعمدة').not.toBeNull();
    expect(within(band).getAllByRole('spinbutton')).toHaveLength(3);
    for (const input of within(band).getAllByRole('spinbutton')) {
      expect(input.className).toContain('w-full');
      expect(input.className).toContain('min-w-0');
    }
    expect(band.textContent).toContain('من');
    expect(band.textContent).toContain('إلى');
    expect(band.textContent).toContain('القيمة');
    expect(within(dialog).getByRole('textbox', { name: 'اسم الشريحة' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'حذف الشريحة' }).className).toContain('h-11');
    // The five-column grid is the desk's.
    expect(dialog.innerHTML).not.toContain('grid-cols-[1fr_1fr_1fr_1.2fr_auto]');
  });

  it('FIN-04: «+ شريحة» adds a band, and the delete is off while only one is left', async () => {
    await openTiers();
    const dialog = screen.getByRole('dialog');
    expect((within(dialog).getByRole('button', { name: 'حذف الشريحة' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: '+ شريحة' }));
    expect(within(dialog).getAllByRole('button', { name: 'حذف الشريحة' })).toHaveLength(2);
  });

  it('FIN-04 DESK: the five-column row with its header, as before', async () => {
    phone.value = false;
    await openTiers();
    const dialog = screen.getByRole('dialog');
    expect(dialog.innerHTML).toContain('grid-cols-[1fr_1fr_1fr_1.2fr_auto]');
    expect(dialog.textContent).toContain('إلى (فارغ = فما فوق)');
    expect(dialog.textContent).toContain('اسم الشريحة');
  });
});

/* ═══════════════════════ الأرباح — FIN-17 · 18 ═══════════════════════ */

describe('«الأرباح»', () => {
  const SUMMARY = {
    totalRevenue: 1000, totalCOGS: 400, shippingAndCommissions: 100, totalOperationalExpenses: 50, netProfit: 450, profitMargin: 45,
  };
  const PRODUCT = {
    id: 'p1', name: 'كريم تفتيح البشرة الطبيعي 50 مل', ordersCount: 10, deliveredOrders: 8, revenue: 800, netProfit: 300, profitMargin: 37,
  };
  const EXPENSE = {
    id: 'e1', title: 'إيجار المستودع', category: 'OFFICE', amount: 100, expenseDate: '2026-10-10T00:00:00Z', voidedAt: null,
    voidReason: null, notes: 'دفعة شهر تشرين',
  };
  const draw = async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const body = String(url).startsWith('/api/finance/profitability')
          ? { products: [PRODUCT] }
          : { currency: 'JOD', summary: SUMMARY, expenses: [EXPENSE], recentDeliveredOrders: [], spend: null };
        return new Response(JSON.stringify(body), { status: 200 });
      })
    );
    render(<FinanceProfitScreen />);
    await screen.findAllByText('إيجار المستودع');
    await screen.findAllByText(PRODUCT.name);
  };

  it('FIN-17: the equation is a receipt — a label and a signed figure per line, the net last', async () => {
    await draw();
    expect(document.querySelector('[class~="sm:grid-cols-5"]'), 'لا تزال خمس بلاطات').toBeNull();
    const net = screen.getAllByText('الصافي').find((e) => e.tagName === 'SPAN' && e.className.includes('primary-foreground'))!.parentElement!;
    expect(net.className).toContain('bg-[var(--sys-primary)]');
    const lines = [net.previousElementSibling!, net.previousElementSibling!.previousElementSibling!];
    expect(lines.map((l) => l.firstElementChild!.textContent)).toEqual(['مصاريف', 'شحن وعمولات']);
    const revenue = screen.getAllByText('إيراد الموصَّل').map((e) => e.parentElement!).find((p) => p.textContent?.includes('+'))!;
    expect(revenue.textContent).toContain('+');
    expect(revenue.textContent).toContain('1,000');
    expect(net.parentElement!.lastElementChild).toBe(net);
  });

  it('FIN-17 DESK: the five tiles of the grid, as they were', async () => {
    phone.value = false;
    await draw();
    const grid = document.querySelector('[class~="sm:grid-cols-5"]')!;
    expect(grid).not.toBeNull();
    expect(grid.children).toHaveLength(5);
  });

  it('FIN-18: a product is a card — its name is not cut, and orders / delivered / revenue are labelled lines', async () => {
    await draw();
    expect(document.querySelectorAll('.truncate')).toHaveLength(0);
    const card = cards().find((c) => c.textContent?.includes(PRODUCT.name))!;
    expect(labelsOf(card)).toEqual(['طلبات', 'مسلَّم', 'إيراد']);
    expect(card.textContent).toContain('37%');
  });

  it('FIN-18 DESK: the row of loose fragments, the name cut at one line', async () => {
    phone.value = false;
    await draw();
    const name = screen.getByText(PRODUCT.name);
    expect(name.className).toContain('truncate');
    expect(name.closest('li')!.textContent).toContain('طلبات:');
  });

  it('FIN-09: the expense note is a wide field on a card', async () => {
    await draw();
    const card = cards().find((c) => c.textContent?.includes('دفعة شهر تشرين'))!;
    const field = [...card.querySelectorAll('dl > div')].find((d) => d.textContent?.includes('ملاحظات'))!;
    expect(field.className).toContain('flex-col');
  });
});

/* ═══════════════════════ عهدة المندوبين — FIN-22 · 21 ═══════════════════════ */

describe('«عهدة المندوبين»', () => {
  const AGENT = { id: 'ag1', name: 'أبو علي', code: 'AGENT-ALI' };
  const TOTALS = {
    inHandCount: 2, inHandValue: 40, collected: 12345, fees: 6, balance: 12339, awaitingCount: 0, awaitingValue: 0,
    awaitingFees: 0, hasUnconfirmed: false,
  };
  const ORDER = {
    id: 'o1', orderNumber: 'SY-1', customerName: 'زبون', regionName: 'دمشق', shippingStatus: 'DELIVERED',
    shippedAt: '2026-09-01T00:00:00.000Z', deliveredAt: '2026-09-05T00:00:00.000Z', orderValue: 20, collected: null, fee: 2,
  };
  const draw = async () => {
    apiJson.mockImplementation(async (url: string) =>
      String(url) === '/api/finance/agents'
        ? { currencyCode: 'JOD', minorUnit: 3, agents: [{ agent: AGENT, totals: TOTALS }] }
        : { custody: { agent: AGENT, currencyCode: 'JOD', inHand: [], owing: [ORDER], totals: TOTALS } }
    );
    render(<AgentCustodyScreen />);
    await screen.findByText('أبو علي');
  };
  const open = async () => {
    fireEvent.click(screen.getByText('أبو علي'));
    await screen.findByText(/قيمة الطلب/);
  };

  it('FIN-22: an agent is the name and the balance on one line, and three figures each under its name', async () => {
    await draw();
    const row = screen.getByText('أبو علي').closest('button')!;
    expect([...row.querySelectorAll('dt')].map((d) => d.textContent)).toEqual(['بيده', 'حصّل مؤكَّد', 'له']);
    expect(row.querySelector('dl')!.className).toContain('grid-cols-3');
  });

  it('FIN-22 DESK: the loose line of labels and figures, as before', async () => {
    phone.value = false;
    await draw();
    const row = screen.getByText('أبو علي').closest('button')!;
    expect(row.querySelector('dl')).toBeNull();
    expect(row.textContent).toContain('بيده:');
    expect(row.textContent).toContain('حصّل مؤكَّد:');
  });

  it('FIN-22: in an order row the LABEL stays outside the left-to-right span; only the figure is inside it', async () => {
    await draw();
    await open();
    const fee = screen.getByText(/^أجرة/);
    expect(fee.getAttribute('dir')).toBeNull();
    expect(fee.querySelector('[dir="ltr"]')!.textContent).toBe('2.000 JOD');
    const value = screen.getByText(/^قيمة الطلب/);
    expect(value.querySelector('[dir="ltr"]')!.textContent).toBe('20.000 JOD');
    expect(value.closest('[dir="ltr"]')?.textContent ?? '').not.toContain('قيمة الطلب');
  });

  it('FIN-22 DESK: the whole phrase is one left-to-right span, as it was', async () => {
    phone.value = false;
    await draw();
    await open();
    const fee = screen.getByText(/^أجرة/);
    expect(fee.getAttribute('dir')).toBe('ltr');
    expect(fee.textContent).toBe('أجرة 2.000 JOD');
  });

  it('FIN-21: the way back to the list is 44px under a finger and the old size on a desk', async () => {
    await draw();
    await open();
    expect(screen.getByRole('button', { name: /كل المندوبين/ }).className).toContain('min-h-11 md:min-h-0');
  });
});

/* ═══════════════════════ الراتب — FIN-23 ═══════════════════════ */

describe('الراتب', () => {
  const WALLET = { id: 'w1', name: 'الصندوق النقدي', currencyCode: 'JOD', country: { minorUnit: 3 } };
  const SLIP = {
    period: { start: '2026-10-01T00:00:00Z', end: '2026-10-31T00:00:00Z', paid: null },
    preview: { salary: 300, currencyCode: 'JOD', penaltyTotal: 0, net: 300, carriedOver: 0, penaltyIds: [], undecided: [], otherCurrency: [], converted: null },
    commission: [],
    wallets: [WALLET],
  };
  const open = async () => {
    apiJson.mockResolvedValue(SLIP);
    render(<UserSalary userId="u9" initial={{ salaryAmount: 300, salaryCurrency: 'JOD' }} canEdit canPay />);
    fireEvent.click(screen.getByRole('button', { name: /اصرف الراتب/ }));
    return screen.findByRole('dialog');
  };

  it('«اصرف» and «تراجع» are 44px under a finger; the wallet box takes the line and the fields are 44px too', async () => {
    const dialog = await open();
    await within(dialog).findByText('الراتب');
    for (const name of ['اصرف', 'تراجع']) {
      expect(within(dialog).getByRole('button', { name }).className).toContain('min-h-11 md:min-h-0');
    }
    const select = within(dialog).getByRole('combobox');
    expect(select.className).toContain('w-full');
    expect(select.className).not.toContain('w-40');
    expect(select.className).toContain('h-11 md:h-10');
    expect(select.closest('label')!.className).toContain('w-full');
  });

  it('DESK: the wallet box is the fixed 160px it was', async () => {
    phone.value = false;
    const dialog = await open();
    await within(dialog).findByText('الراتب');
    const select = within(dialog).getByRole('combobox');
    expect(select.className).toContain('w-40');
    expect(select.className).not.toContain('w-full');
    expect(select.closest('label')!.className).toBe('block');
  });

  it('NEGATIVE: «اصرف» is still off until a wallet is chosen, and the reason is still printed beside it', async () => {
    const dialog = await open();
    await within(dialog).findByText('الراتب');
    expect((within(dialog).getByRole('button', { name: 'اصرف' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(dialog).getByText('اختر المحفظة اللي بيخرج منها المبلغ.')).toBeTruthy();
  });
});
