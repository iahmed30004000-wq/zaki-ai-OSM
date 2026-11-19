// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

/**
 * «خصومات الموظفين» ON THE KIT (R16g, 19/11).
 *
 * The screen changed its clothes and nothing else: the frame is `PageShell`, the three tabs are one
 * `Segmented`, the six hand-made buttons are the kit `Button`, the rows and the empty sentence are `Card`.
 * What this file holds is that every press still happens for exactly the people it happened for, sends
 * exactly the body it sent, and that the money printed on a row is the same figure.
 *
 * The keys are read from the screen's own lines: `penalties.view` opens the page (the route registry), and
 * `penalties.decide` is the only `userCan(` on it — it draws every decision button and asks for the people list.
 */
const { api, toast, user } = vi.hoisted(() => ({
  api: vi.fn(),
  toast: { failed: vi.fn(), success: vi.fn() },
  user: { current: null as null | Record<string, unknown> },
}));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a) }));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ currentUser: user.current }) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => toast }));
vi.mock('@/hooks/useLiveRefresh', async () => {
  const react = await import('react');
  return { useLiveRefresh: (load: () => void) => react.useEffect(() => { void load(); }, [load]) };
});

import { PenaltiesScreen } from './PenaltiesScreen';
import { Button } from '@/components/ui/Button';
import { Money } from '@/components/ui/Money';
import { routeLabel } from '@/lib/route-registry';
import { CARD_CLASS } from '@/lib/theme-shape';

const DECIDER = { id: 'u-acc', status: 'ACTIVE', role: 'ACCOUNTANT', permissions: ['penalties.view', 'penalties.decide'] };
const READER = { id: 'u-sup', status: 'ACTIVE', role: 'SUPERVISOR', permissions: ['penalties.view'] };

const KINDS = [
  { key: 'LATE', ar: 'التأخير', unitAr: 'دقيقة', sourceAr: '' },
  { key: 'SHORTFALL', ar: 'فرق تحصيل', unitAr: 'طلب', sourceAr: '' },
];
const row = (over: Record<string, unknown> = {}) => ({
  id: 'p1', kind: 'LATE', occurredOn: '2026-10-18T00:00:00Z', units: 25, chargedUnits: 10, amount: 3, currencyCode: 'JOD',
  status: 'PROPOSED', note: null, decisionNote: null, decidedAt: null, payslipId: null, reversesId: null, settlementMatchId: null,
  user: { id: 'u-a', name: 'موظفة أولى', role: 'FOLLOW_UP_AGENT' }, ...over,
});
let rows: ReturnType<typeof row>[];
const posts = () => api.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'POST');
const bodyOf = (i: number) => JSON.parse(String((posts()[i][1] as RequestInit).body));
const lists = () => api.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith('/api/team/penalties') && !u.includes('people=1'));
const DECISIONS = [/اعتمد الخصم/, /ألغِ/, /حوّل لموظف آخر/, /ارتجاع/];

beforeEach(() => {
  vi.clearAllMocks();
  user.current = DECIDER;
  rows = [row()];
  api.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return { ok: true };
    if (url.includes('people=1')) return { people: [{ id: 'u-a', name: 'موظفة أولى' }, { id: 'u-b', name: 'موظفة ثانية' }] };
    if (url.startsWith('/api/team/penalties')) return { kinds: KINDS, penalties: rows };
    return {};
  });
});
afterEach(cleanup);

describe('the frame', () => {
  it('one heading, named as the menu names it, inside a medium-width frame that may shrink', async () => {
    const { container } = render(<PenaltiesScreen />);
    await screen.findByText('موظفة أولى');
    const h1s = container.querySelectorAll('h1');
    expect(h1s).toHaveLength(1);
    expect(h1s[0].textContent).toContain(routeLabel('/control/penalties'));
    const root = container.firstElementChild as HTMLElement;
    expect(root.classList.contains('max-w-4xl')).toBe(true);
    expect(root.classList.contains('min-w-0')).toBe(true);
  });

  it('a phone: nothing on the screen carries a fixed pixel width', async () => {
    rows = [row({ user: { id: 'u-a', name: 'اسم طويل جداً لموظفة من عائلة طويلة الاسم أيضاً', role: 'X' } })];
    const { container } = render(<PenaltiesScreen />);
    await screen.findByText(/اسم طويل جداً/);
    const fixed = [...container.querySelectorAll('*')].flatMap((el) =>
      // built from pieces: Tailwind reads tests too, and a bracketed width written here would grow the sheet
      [...el.classList].filter((c) => (c.startsWith('w' + '-') || c.startsWith('min-w' + '-')) && (c.includes('px') || /\d{3,}/.test(c)))
    );
    expect(fixed).toEqual([]);
    // the name's line wraps rather than pushing the chip off the edge
    const nameLine = screen.getByText(/اسم طويل جداً/).parentElement!;
    expect(nameLine.classList.contains('flex-wrap')).toBe(true);
  });
});

describe('the three tabs are one bar', () => {
  it('a named group of three choices in the same order, «بانتظار القرار» chosen at first', async () => {
    render(<PenaltiesScreen />);
    const group = await screen.findByRole('radiogroup', { name: 'حالة الخصم' });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((r) => r.textContent)).toEqual(['بانتظار القرار', 'معتمدة', 'الكل']);
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
    expect(group.classList.contains('w-full')).toBe(true);
    await waitFor(() => expect(lists()).toEqual(['/api/team/penalties?status=PROPOSED']));
  });

  it('each choice asks for the same list it asked for before — «الكل» with no status at all', async () => {
    render(<PenaltiesScreen />);
    const group = await screen.findByRole('radiogroup', { name: 'حالة الخصم' });
    fireEvent.click(within(group).getByRole('radio', { name: 'معتمدة' }));
    await waitFor(() => expect(lists()).toContain('/api/team/penalties?status=APPLIED'));
    fireEvent.click(within(group).getByRole('radio', { name: 'الكل' }));
    await waitFor(() => expect(lists()).toContain('/api/team/penalties'));
    expect(within(group).getByRole('radio', { name: 'الكل' }).getAttribute('aria-checked')).toBe('true');
  });
});

describe('who sees which press (the screen’s one key: penalties.decide)', () => {
  it('a reader with penalties.view only: the rows, no decision button, and the people list is never asked for', async () => {
    user.current = READER;
    rows = [row({ id: 'p1', kind: 'SHORTFALL' }), row({ id: 'p2', status: 'APPLIED' })];
    render(<PenaltiesScreen />);
    await screen.findAllByText('موظفة أولى');
    for (const name of DECISIONS) expect(screen.queryByRole('button', { name })).toBeNull();
    expect(api.mock.calls.some((c) => String(c[0]).includes('people=1'))).toBe(false);
  });

  it('the decider: a proposed shortfall has three presses in the old order; a proposed lateness has two', async () => {
    rows = [row({ id: 'p1', kind: 'SHORTFALL' }), row({ id: 'p2' })];
    render(<PenaltiesScreen />);
    await screen.findAllByText('موظفة أولى');
    const [first, second] = screen.getAllByRole('listitem');
    expect(within(first).getAllByRole('button').map((b) => b.textContent?.trim())).toEqual(['اعتمد الخصم', 'ألغِ', 'حوّل لموظف آخر']);
    expect(within(second).getAllByRole('button').map((b) => b.textContent?.trim())).toEqual(['اعتمد الخصم', 'ألغِ']);
  });

  it('an applied one: «ارتجاع» before a payslip, the sentence after it, nothing on a waived or reversed one', async () => {
    rows = [
      row({ id: 'p1', status: 'APPLIED' }),
      row({ id: 'p2', status: 'APPLIED', payslipId: 'ps1' }),
      row({ id: 'p3', status: 'WAIVED' }),
      row({ id: 'p4', status: 'REVERSED' }),
    ];
    render(<PenaltiesScreen />);
    await screen.findAllByText('موظفة أولى');
    const items = screen.getAllByRole('listitem');
    expect(within(items[0]).getAllByRole('button').map((b) => b.textContent?.trim())).toEqual(['ارتجاع']);
    expect(within(items[1]).queryAllByRole('button')).toHaveLength(0);
    expect(within(items[1]).getByText(/سُوّي مع صرفية/)).toBeTruthy();
    expect(within(items[2]).queryAllByRole('button')).toHaveLength(0);
    expect(within(items[3]).queryAllByRole('button')).toHaveLength(0);
  });
});

describe('the presses send what they sent', () => {
  it('«اعتمد الخصم» posts the id and the action only — and the row is locked while it is in the air', async () => {
    let release!: () => void;
    api.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Promise((r) => { release = () => r({ ok: true }); });
      if (url.includes('people=1')) return { people: [] };
      return { kinds: KINDS, penalties: rows };
    });
    render(<PenaltiesScreen />);
    const apply = (await screen.findByRole('button', { name: /اعتمد الخصم/ })) as HTMLButtonElement;
    fireEvent.click(apply);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0][0]).toBe('/api/team/penalties');
    expect(bodyOf(0)).toEqual({ penaltyId: 'p1', action: 'apply' });
    expect(apply.disabled).toBe(true);
    expect((screen.getByRole('button', { name: /ألغِ/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(apply);
    expect(posts()).toHaveLength(1);
    release();
    await waitFor(() => expect(apply.disabled).toBe(false));
  });

  it('«ألغِ»: no reason, no press; a reason is sent trimmed', async () => {
    render(<PenaltiesScreen />);
    fireEvent.click(await screen.findByRole('button', { name: /ألغِ/ }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'تأكيد' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: '   ' } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: '  تأخير بإذن  ' } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(bodyOf(0)).toEqual({ penaltyId: 'p1', action: 'waive', note: 'تأخير بإذن' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('«ارتجاع» asks for a reason and sends action reverse', async () => {
    rows = [row({ status: 'APPLIED' })];
    render(<PenaltiesScreen />);
    fireEvent.click(await screen.findByRole('button', { name: /ارتجاع/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'خطأ بالقياس' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'تأكيد' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(bodyOf(0)).toEqual({ penaltyId: 'p1', action: 'reverse', note: 'خطأ بالقياس' });
  });

  it('«تراجع» closes the box and sends nothing; reopening starts from an empty reason', async () => {
    render(<PenaltiesScreen />);
    fireEvent.click(await screen.findByRole('button', { name: /ألغِ/ }));
    let dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'شيء' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'تراجع' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(posts()).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: /ألغِ/ }));
    dialog = await screen.findByRole('dialog');
    expect((within(dialog).getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
  });

  it('a refusal is said in a toast and the box stays open', async () => {
    api.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') throw new Error('مرفوض');
      if (url.includes('people=1')) return { people: [] };
      return { kinds: KINDS, penalties: rows };
    });
    render(<PenaltiesScreen />);
    fireEvent.click(await screen.findByRole('button', { name: /ألغِ/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'سبب' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'تأكيد' }));
    await waitFor(() => expect(toast.failed).toHaveBeenCalledWith('مرفوض'));
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});

describe('the kit parts, compared with the kit itself', () => {
  const kitClass = (variant: 'danger' | 'secondary' | 'primary', size: 'sm' | 'md') => {
    const { container, unmount } = render(<Button type="button" variant={variant} size={size}>x</Button>);
    const cls = (container.querySelector('button') as HTMLButtonElement).className;
    unmount();
    return cls;
  };

  it('apply is the kit’s danger button, the other row presses its secondary, all small; every one is type=button', async () => {
    rows = [row({ kind: 'SHORTFALL' })];
    const danger = kitClass('danger', 'sm');
    const secondary = kitClass('secondary', 'sm');
    render(<PenaltiesScreen />);
    const apply = await screen.findByRole('button', { name: /اعتمد الخصم/ });
    expect(apply.className).toBe(danger);
    for (const name of [/ألغِ/, /حوّل لموظف آخر/]) expect(screen.getByRole('button', { name }).className).toBe(secondary);
    for (const b of screen.getAllByRole('button')) expect(b.getAttribute('type')).toBe('button');
  });

  it('in the box: «تأكيد» is the primary, «تراجع» the secondary, both at the dialog size', async () => {
    const primary = kitClass('primary', 'md');
    const secondary = kitClass('secondary', 'md');
    render(<PenaltiesScreen />);
    fireEvent.click(await screen.findByRole('button', { name: /ألغِ/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'سبب' } });
    expect(within(dialog).getByRole('button', { name: 'تأكيد' }).className).toBe(primary);
    expect(within(dialog).getByRole('button', { name: 'تراجع' }).className).toBe(secondary);
  });

  it('a row is a plain card (no theme glyph on every row); the empty sentence is a page card', async () => {
    const { unmount } = render(<PenaltiesScreen />);
    const item = (await screen.findAllByRole('listitem'))[0];
    const card = item.firstElementChild as HTMLElement;
    expect(card.classList.contains('bg-[var(--sys-card)]')).toBe(true);
    expect(card.classList.contains(CARD_CLASS)).toBe(false);
    unmount();

    rows = [];
    render(<PenaltiesScreen />);
    const empty = await screen.findByText('لا خصومات هنا.');
    expect(empty.classList.contains(CARD_CLASS)).toBe(true);
  });
});

describe('the figures on a row are the ones it printed before', () => {
  it('units, charged units, the unit word, and the amount through the same Money', async () => {
    const { container: ref, unmount } = render(<Money value={3} currency="JOD" />);
    const printed = ref.textContent;
    unmount();
    render(<PenaltiesScreen />);
    const item = (await screen.findAllByRole('listitem'))[0];
    expect(item.textContent).toContain('25');
    expect(item.textContent).toContain('دقيقة');
    expect(item.textContent).toContain('المحتسَب');
    expect(item.textContent).toContain('10');
    expect(item.textContent).toContain(printed!);
    expect(item.textContent).toContain('التأخير');
    expect(item.textContent).toContain('2026-10-18');
  });
});
