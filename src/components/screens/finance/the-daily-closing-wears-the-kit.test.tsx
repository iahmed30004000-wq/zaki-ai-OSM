// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * «الإغلاق اليومي» ON THE KIT (R13d, 18/11).
 *
 * The screen moved onto the shared frame, card and button. Money screens carry a stricter rule than any other: the
 * look may change, nothing a person counts, approves or is told may. So this file holds the parts a careless
 * restyle breaks without noticing:
 *
 *   the day is ONE native date field in the frame's toolbar row (a span picker would ask a different question);
 *   «اعتماد» keeps the screen's own busy flag — the kit button must not run a second one, so a double press still
 *     sends ONE approval, and the press waits for the server exactly as before;
 *   the count dialog: «إلغاء» never submits the form (the kit button sets no default type), the save sends the same
 *     body, a difference still demands its written reason before anything is sent;
 *   a blocked day still cannot be counted, and each press is drawn only for the key that asks for it;
 *   rows and the nested boxes are plain cards: a theme's ornament lands on the page, never on every row.
 *
 * jsdom has no layout; the phone case holds what the 375px layout depends on (no fixed width, the toolbar wraps).
 */

const { apiJson, user, phone } = vi.hoisted(() => ({
  apiJson: vi.fn(),
  user: { current: null as unknown },
  phone: { value: false },
}));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a) }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/finance/closing',
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ locale: 'ar', isRtl: true, t: { cancel: 'تراجع' }, currentUser: user.current }),
}));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), done: vi.fn(), show: vi.fn() }) }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => phone.value }));

import { ClosingScreen } from './ClosingScreen';
import { routeLabel } from '@/lib/route-registry';
import { CARD_CLASS } from '@/lib/theme-shape';

const OPEN = {
  walletId: 'w1', walletName: 'الصندوق', currencyCode: 'JOD', minorUnit: 3, bookBalance: 100, blockedBy: null,
  closing: { id: 'c1', status: 'OPEN', bookBalance: 100, actualBalance: 90, difference: -10, explanation: 'سلفة نقدية', recordedById: 'x' },
};
const BLOCKED = {
  walletId: 'w2', walletName: 'البنك', currencyCode: 'JOD', minorUnit: 3, bookBalance: 50, closing: null,
  blockedBy: { id: 'b1', date: '2026-11-10T00:00:00.000Z', difference: 5 },
};
const FRESH = { walletId: 'w3', walletName: 'جديدة', currencyCode: 'JOD', minorUnit: 3, bookBalance: 20, closing: null, blockedBy: null };

const ALL = ['finance.cashbox_view', 'finance.cashbox', 'finance.closing_approve'];
const as = (...permissions: string[]) => {
  user.current = { id: 'u1', status: 'ACTIVE', role: 'COMPANY_ADMIN', permissions };
};

beforeEach(() => {
  vi.clearAllMocks();
  phone.value = false;
  as(...ALL);
  apiJson.mockImplementation(async (_url: string, init?: { method?: string }) => (init?.method ? {} : { rows: [OPEN, BLOCKED, FRESH] }));
});
afterEach(cleanup);

const draw = async () => {
  const view = render(<ClosingScreen />);
  await screen.findByText('الصندوق');
  return view;
};
const writes = () => apiJson.mock.calls.filter(([, init]) => init?.method);

describe('the frame: the registry name, and the day in the toolbar row', () => {
  it('one heading, read from the registry', async () => {
    await draw();
    const h1 = screen.getAllByRole('heading', { level: 1 });
    expect(h1).toHaveLength(1);
    expect(h1[0].textContent).toContain(routeLabel('/finance/closing'));
  });

  it('the day is ONE native date field, capped at today, sitting in the frame’s toolbar row (not in a card of its own)', async () => {
    await draw();
    const day = screen.getByLabelText('يوم الإغلاق') as HTMLInputElement;
    expect(day.getAttribute('type')).toBe('date');
    expect(day.getAttribute('max')).toBe(new Date().toISOString().slice(0, 10));
    const row = day.closest('div');
    expect(row?.className).toContain('flex-wrap');
    expect(row?.className).not.toContain(CARD_CLASS);
    expect(document.querySelectorAll('input[type="date"]')).toHaveLength(1);
  });

  it('changing the day asks the server for that day, and nothing else', async () => {
    await draw();
    fireEvent.change(screen.getByLabelText('يوم الإغلاق'), { target: { value: '2026-11-01' } });
    await waitFor(() => expect(apiJson).toHaveBeenLastCalledWith('/api/finance/closing?date=2026-11-01'));
    expect(writes()).toHaveLength(0);
  });
});

describe('«اعتماد» — the screen’s own flag, one approval per press', () => {
  it('a double press sends ONE approval with the closing’s id, and the button waits for the server', async () => {
    let release: (v: unknown) => void = () => {};
    apiJson.mockImplementation((_url: string, init?: { method?: string }) =>
      init?.method ? new Promise((r) => (release = r)) : Promise.resolve({ rows: [OPEN, BLOCKED, FRESH] })
    );
    await draw();
    const approve = screen.getByRole('button', { name: 'اعتماد' });
    fireEvent.click(approve);
    fireEvent.click(approve);
    expect(writes()).toEqual([['/api/finance/closing', { method: 'PATCH', body: JSON.stringify({ closingId: 'c1' }) }]]);
    await waitFor(() => expect((screen.getByRole('button', { name: 'اعتماد' }) as HTMLButtonElement).disabled).toBe(true));
    // NEGATIVE: the kit's own busy state is NOT running beside the screen's — the press returns nothing to the button.
    expect(screen.getByRole('button', { name: 'اعتماد' }).getAttribute('aria-busy')).toBeNull();
    release({});
    expect(await screen.findByText('اعتُمد إغلاق الصندوق')).toBeTruthy();
  });

  it('it is a framed button, not the main fill and never the destructive one; it keeps its rule as a hover title', async () => {
    await draw();
    const approve = screen.getByRole('button', { name: 'اعتماد' });
    expect(approve.className).toContain('bg-[var(--sys-card)]');
    expect(approve.className).not.toContain('bg-[var(--sys-destructive)]');
    expect(approve.className).toContain('h-11 md:h-8');
    expect(approve.getAttribute('title')).toBe('يعتمده شخص غير من سجّل الحركات أو الجرد');
  });
});

describe('the count', () => {
  it('NEGATIVE: a day blocked by an unexplained difference cannot be counted', async () => {
    await draw();
    const blocked = screen.getAllByRole('button', { name: 'تسجيل الجرد' });
    expect(blocked.map((b) => (b as HTMLButtonElement).disabled)).toEqual([true, false]);
    expect(screen.getByText(/بلا تفسير — فسّره واعتمده قبل إغلاق هذا اليوم/)).toBeTruthy();
  });

  it('NEGATIVE: «إلغاء» closes the dialog and sends nothing (it is not the form’s submit)', async () => {
    await draw();
    fireEvent.click(screen.getAllByRole('button', { name: 'تسجيل الجرد' })[1]);
    const dialog = await screen.findByRole('dialog');
    const cancel = within(dialog).getByRole('button', { name: 'إلغاء' });
    expect(cancel.getAttribute('type')).toBe('button');
    expect(within(dialog).getByRole('button', { name: 'حفظ الجرد' }).getAttribute('type')).toBe('submit');
    fireEvent.click(cancel);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(writes()).toHaveLength(0);
  });

  it('a difference demands its reason first; the save sends the same body as before, the reason trimmed', async () => {
    await draw();
    fireEvent.click(screen.getAllByRole('button', { name: 'تسجيل الجرد' })[1]);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByText('سبب الفرق (إلزامي)')).toBeNull();
    fireEvent.change(dialog.querySelector('input[type="number"]')!, { target: { value: '18.5' } });
    const why = within(dialog).getByText('سبب الفرق (إلزامي)').closest('label')!.querySelector('textarea')!;
    expect(why.required).toBe(true);
    fireEvent.change(why, { target: { value: '  نقص بالعد  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ الجرد' }));
    await screen.findByText('سُجِّل الجرد — يبقى بانتظار اعتماد شخص آخر');
    expect(writes()).toHaveLength(1);
    const [url, init] = writes()[0];
    expect(url).toBe('/api/finance/closing');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      walletId: 'w3',
      date: new Date().toISOString().slice(0, 10),
      actualBalance: 18.5,
      explanation: 'نقص بالعد',
    });
  });
});

describe('the keys, each press only where its key is', () => {
  it('NEGATIVE: who only sees the day gets neither press', async () => {
    as('finance.cashbox_view');
    await draw();
    expect(screen.queryByRole('button', { name: 'اعتماد' })).toBeNull();
    expect(screen.queryByRole('button', { name: /الجرد/ })).toBeNull();
  });
  it('the counter counts and does not approve; the approver approves and does not count', async () => {
    as('finance.cashbox_view', 'finance.cashbox');
    await draw();
    expect(screen.queryByRole('button', { name: 'اعتماد' })).toBeNull();
    expect(screen.getByRole('button', { name: 'تعديل الجرد' })).toBeTruthy();
    cleanup();
    as('finance.cashbox_view', 'finance.closing_approve');
    await draw();
    expect(screen.getByRole('button', { name: 'اعتماد' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /الجرد/ })).toBeNull();
  });
});

describe('surfaces and the phone', () => {
  it('rows and the boxes inside them are plain cards: no theme ornament on a row', async () => {
    await draw();
    expect(document.querySelectorAll(`.${CARD_CLASS}`)).toHaveLength(0);
    const explanation = screen.getByText(/التفسير: سلفة نقدية/);
    expect(explanation.className).toContain('rounded-lg');
  });

  it('PHONE (jsdom, 375px): no fixed width anywhere, the toolbar and each row wrap', async () => {
    phone.value = true;
    const { container } = await draw();
    // A fixed width: an arbitrary one, a three-digit step, or the viewport's. Built from pieces so the stylesheet scanner
    // does not read a class here.
    const wide = new RegExp('(^|\\s)(min-)?' + 'w' + '-(\\[|\\d{3,}|' + 'screen)');
    const fixed = [...container.querySelectorAll('[class]')].filter((n) => wide.test(n.getAttribute('class') ?? ''));
    expect(fixed).toHaveLength(0);
    expect(screen.getByLabelText('يوم الإغلاق').closest('div')?.className).toContain('flex-wrap');
    expect(screen.getByText('الصندوق').closest('div.flex-wrap')).toBeTruthy();
    // On a phone the rule a desk reads from the title is written under the row.
    expect(screen.getByText('يعتمده شخص غير من سجّل الحركات أو الجرد')).toBeTruthy();
  });

  it('the source holds no raw button and no hand-typed title', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/screens/finance/ClosingScreen.tsx'), 'utf8');
    expect(src).not.toMatch(/<button\b/);
    expect(src).toMatch(/<PageShell\s+title=\{routeLabel\('\/finance\/closing'\)\}/);
  });
});
