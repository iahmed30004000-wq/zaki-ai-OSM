// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «التحصيل والكشوف» ON THE KIT (R13b, 18/11) — the screen looks different, nothing on it does.
 *
 * The frame is `PageShell`, the surfaces are `Card` (the page-level import form) and `Card plain` (the list, the notes,
 * the rows inside a dialog), the raw buttons are the kit's `Button`. What this file holds is what must NOT have moved:
 *
 *   1. every press is drawn for exactly the keys it was drawn for — one render per key set the door lets in
 *      (`settlement.upload` only · `settlement.view` only · `settlement.review` only · + `settlement.approve`);
 *   2. the screen's own busy flag still stops a second press while the first is in the air;
 *   3. a button inside a form that must not send is `type="button"` (the kit sets no default type);
 *   4. the one press that deletes is the `danger` one, and a row inside a dialog never wears the theme's decoration;
 *   5. at 375px (jsdom: no layout — what the layout depends on) no fixed width wider than the screen, and the row's
 *      presses wrap.
 *
 * The figures and request bodies were compared old-against-new in a throwaway render test (see the pull request);
 * `money-on-screen` and `kpi-figure` hold the rest, untouched.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { api, fetchApi, who, phone } = vi.hoisted(() => ({
  api: vi.fn(),
  fetchApi: vi.fn(),
  who: { keys: [] as string[] },
  phone: { value: false },
}));
vi.mock('@/lib/api-client', () => ({
  apiJson: (...a: unknown[]) => api(...a),
  apiFetch: (...a: unknown[]) => fetchApi(...a),
}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/finance/collection',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ currentUser: { id: 'u1', status: 'ACTIVE', role: 'CUSTOM', permissions: who.keys } }),
}));
vi.mock('@/components/ui/Confirm', () => ({
  useConfirm: () => vi.fn(async () => true),
  useAsk: () => async () => null,
  useTell: () => vi.fn(),
}));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ show: vi.fn(), push: vi.fn(), failed: vi.fn() }) }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => phone.value }));

import { CollectionScreen } from './CollectionScreen';
import { ShortfallPeopleDialog } from './ShortfallPeopleDialog';
import { AssembleStatementDialog } from './AssembleStatementDialog';
import { routeLabel } from '@/lib/route-registry';
import { CARD_CLASS } from '@/lib/theme-shape';

const as = (...keys: string[]) => {
  who.keys = keys;
};

const noGap = { claimed: 100, received: 100, gap: 0, needsExplanation: false, explained: false, unconvertible: 0 };
const base = {
  fileName: 'x.xlsx', approvedAt: null, matchingClosedAt: null, currencyCode: 'USD', totalAmount: 100,
  createdAt: '2026-10-24T00:00:00Z', receipts: [], gap: noGap,
};
/** A fresh import: nothing collected yet. */
const FRESH = { ...base, id: 's1', reference: 'R-FRESH', status: 'IMPORTED', counts: { lines: 3, receipts: 0, matches: 0 } };
/** Paper in, matched, a gap nobody explained. */
const GAPPED = {
  ...base, id: 's2', reference: 'R-GAP', status: 'MATCHED', counts: { lines: 3, receipts: 1, matches: 3 },
  gap: { claimed: 100, received: 90, gap: 10, needsExplanation: true, explained: false, unconvertible: 0 },
  receipts: [{ id: 'r1', amount: 90, currencyCode: 'USD', receivedAt: '2026-10-24T00:00:00Z', note: null, wallet: 'الصندوق', proof: { name: 'p.png', mime: 'image/png', size: 9 } }],
};
/** The money is in, one line still a question: the matching is open. */
const OPEN = {
  ...base, id: 's3', reference: 'R-OPEN', status: 'APPROVED', approvedAt: '2026-10-25T00:00:00Z',
  counts: { lines: 3, receipts: 1, matches: 3, openLines: 1 },
};
/** A hand-gathered draft, not yet assembled. */
const DRAFT = { ...base, id: 's4', reference: 'R-DRAFT', status: 'IMPORTED', manual: true, draft: true, counts: { lines: 2, receipts: 0, matches: 0 } };

beforeEach(() => {
  vi.clearAllMocks();
  phone.value = false;
  as();
  api.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/finance/statements')) return { statements: [FRESH, GAPPED, OPEN, DRAFT] };
    if (url.startsWith('/api/ops/references')) return { providers: [{ id: 'p1', name: 'شركة أ' }] };
    if (url.startsWith('/api/finance/wallets')) return { wallets: [{ id: 'w1', name: 'الصندوق', currencyCode: 'USD' }] };
    return {};
  });
});
afterEach(cleanup);

const draw = async () => {
  render(<CollectionScreen />);
  await screen.findAllByText('R-FRESH');
};
/** The presses of one statement's row, by name, in order. */
const rowOf = (ref: string) => screen.getAllByText(ref)[0].closest('tr') as HTMLElement;
const names = (el: HTMLElement) => within(el).queryAllByRole('button').map((b) => b.textContent!.trim());

describe('1 · every press is drawn for exactly the keys it was drawn for', () => {
  /*
   * The screen gates two presses itself — «اعتماد» and «إغلاق المطابقة» on `settlement.approve` — and draws the rest
   * for anyone the door lets in. These are the lists the screen drew on main before the move; a press that went
   * missing or appeared for a key that does not hold it turns one of them red.
   */
  const WITHOUT_APPROVE = {
    'R-FRESH': ['إلغاء الاستيراد', 'إيصال استلام', 'مطابقة'],
    'R-GAP': ['احذف الإيصال', 'إلغاء الاستيراد', 'إيصال استلام', 'مطابقة', 'تفسير الفرق'],
    'R-OPEN': ['مطابقة'],
    'R-DRAFT': ['حذف المسوّدة', 'تجميع'],
  };
  const WITH_APPROVE = {
    'R-FRESH': ['إلغاء الاستيراد', 'إيصال استلام', 'مطابقة', 'اعتماد'],
    'R-GAP': ['احذف الإيصال', 'إلغاء الاستيراد', 'إيصال استلام', 'مطابقة', 'تفسير الفرق', 'اعتماد'],
    'R-OPEN': ['مطابقة', 'إغلاق المطابقة'],
    'R-DRAFT': ['حذف المسوّدة', 'تجميع'],
  };

  it.each([
    ['settlement.upload only', ['settlement.upload'], WITHOUT_APPROVE],
    ['settlement.view only', ['settlement.view'], WITHOUT_APPROVE],
    ['settlement.review only', ['settlement.review'], WITHOUT_APPROVE],
    ['settlement.view + settlement.approve', ['settlement.view', 'settlement.approve'], WITH_APPROVE],
  ])('%s: the desk rows draw exactly these presses', async (_label, keys, expected) => {
    as(...keys);
    await draw();
    for (const [ref, list] of Object.entries(expected)) expect(names(rowOf(ref)), ref).toEqual(list);
    // Upload is not a key-gated press on this screen: the form is there for every key the door lets in.
    expect(screen.getByRole('button', { name: /^استيراد$/ })).toBeTruthy();
  });

  it('NEGATIVE: «اعتماد» and «إغلاق المطابقة» are drawn for nobody without settlement.approve', async () => {
    as('settlement.upload', 'settlement.view', 'settlement.review');
    await draw();
    expect(screen.queryAllByRole('button', { name: 'اعتماد' })).toHaveLength(0);
    expect(screen.queryAllByRole('button', { name: 'إغلاق المطابقة' })).toHaveLength(0);
  });

  it('the approve press keeps its disabled rule: a gap nobody explained greys it, with the server’s sentence as its title', async () => {
    as('settlement.approve');
    await draw();
    const approve = within(rowOf('R-GAP')).getByRole('button', { name: 'اعتماد' }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    expect(approve.title.length).toBeGreaterThan(0);
    // and a fresh statement's «مطابقة» stays grey until a receipt exists
    expect((within(rowOf('R-FRESH')).getByRole('button', { name: 'مطابقة' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('on a phone the same key sets draw the same presses (the phone order: next step first, the undo last)', async () => {
    phone.value = true;
    as('settlement.view');
    await draw();
    expect(screen.queryAllByRole('button', { name: 'اعتماد' })).toHaveLength(0);
    cleanup();
    as('settlement.view', 'settlement.approve');
    await draw();
    expect(screen.getAllByRole('button', { name: 'اعتماد' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'إغلاق المطابقة' }).length).toBeGreaterThan(0);
  });
});

describe('2 · the screen’s own busy flag still holds a second press', () => {
  it('«مطابقة» pressed twice while the first is in the air sends ONE request', async () => {
    as('settlement.view');
    let release: () => void = () => undefined;
    api.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/match') && init?.method === 'POST') return new Promise<object>((r) => (release = () => r({})));
      if (url.startsWith('/api/finance/statements')) return { statements: [FRESH, GAPPED, OPEN, DRAFT] };
      if (url.startsWith('/api/finance/wallets')) return { wallets: [] };
      return { providers: [] };
    });
    await draw();
    const match = within(rowOf('R-GAP')).getByRole('button', { name: 'مطابقة' }) as HTMLButtonElement;
    fireEvent.click(match);
    await waitFor(() => expect(match.disabled).toBe(true));
    // greyed by the SCREEN's flag, not by the kit button running the promise itself (`void` keeps the press as it was:
    // no spinner over the word, no tick after it)
    expect(match.getAttribute('aria-busy')).toBeNull();
    // the other presses of the same row wait too — the screen's flag, not the button's own
    expect((within(rowOf('R-GAP')).getByRole('button', { name: 'إلغاء الاستيراد' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(match);
    const posts = () => api.mock.calls.filter(([u, i]) => String(u).endsWith('/match') && (i as RequestInit)?.method === 'POST');
    expect(posts()).toHaveLength(1);
    await act(async () => release());
  });
});

describe('3 · a button inside a form that must not send says so', () => {
  it('the receipt dialog: «إلغاء» is type=button and closes without a request; «حفظ الإيصال» is the submit', async () => {
    as('settlement.view');
    await draw();
    fireEvent.click(within(rowOf('R-FRESH')).getByRole('button', { name: 'إيصال استلام' }));
    const dialog = await screen.findByRole('dialog');
    const cancel = within(dialog).getByRole('button', { name: 'إلغاء' });
    expect(cancel.getAttribute('type')).toBe('button');
    expect(within(dialog).getByRole('button', { name: 'حفظ الإيصال' }).getAttribute('type')).toBe('submit');
    const before = api.mock.calls.length;
    fireEvent.click(cancel);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.mock.calls.slice(before).filter(([, i]) => (i as RequestInit)?.method === 'POST')).toHaveLength(0);
  });

  it('the explanation dialog: «إلغاء» is type=button; «حفظ التفسير» is the submit', async () => {
    as('settlement.view');
    await draw();
    fireEvent.click(within(rowOf('R-GAP')).getByRole('button', { name: 'تفسير الفرق' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'إلغاء' }).getAttribute('type')).toBe('button');
    expect(within(dialog).getByRole('button', { name: 'حفظ التفسير' }).getAttribute('type')).toBe('submit');
  });

  it('the assemble dialog: «إلغاء» is type=button and sends nothing; «تجميع» is the submit and stays grey under two letters', async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(
      <AssembleStatementDialog
        statement={{ id: 'd1', reference: '', currencyCode: 'USD', totalAmount: 50, counts: { lines: 2 } }}
        onClose={onClose}
        onSaved={onSaved}
      />
    );
    const dialog = await screen.findByRole('dialog');
    const cancel = within(dialog).getByRole('button', { name: 'إلغاء' });
    expect(cancel.getAttribute('type')).toBe('button');
    fireEvent.click(cancel);
    expect(onClose).toHaveBeenCalled();
    expect(api).not.toHaveBeenCalled();
    const go = within(dialog).getByRole('button', { name: 'تجميع' }) as HTMLButtonElement;
    expect(go.getAttribute('type')).toBe('submit');
    expect(go.disabled).toBe(true);
  });

  it('the import form on a desk: «استيراد» is the submit and stays grey until a company and a file are picked', async () => {
    as('settlement.upload');
    await draw();
    const go = screen.getByRole('button', { name: 'استيراد' }) as HTMLButtonElement;
    expect(go.getAttribute('type')).toBe('submit');
    expect(go.disabled).toBe(true);
  });
});

describe('4 · the deleting press is danger; a row in a dialog wears no theme decoration', () => {
  const DANGER = 'bg-[var(--sys-' + 'destructive)]';

  it('«إلغاء الاستيراد», «حذف المسوّدة» and «احذف الإيصال» are danger on a desk, and no step press is', async () => {
    as('settlement.view', 'settlement.approve');
    await draw();
    for (const name of ['إلغاء الاستيراد', 'حذف المسوّدة', 'احذف الإيصال']) {
      for (const b of screen.getAllByRole('button', { name })) expect(b.className, name).toContain(DANGER);
    }
    for (const name of ['إيصال استلام', 'مطابقة', 'اعتماد', 'تجميع', 'تفسير الفرق', 'إغلاق المطابقة']) {
      for (const b of screen.getAllByRole('button', { name })) expect(b.className, name).not.toContain(DANGER);
    }
  });

  it('the page-level import form is a themed Card; the list and its note are plain', async () => {
    as('settlement.view');
    await draw();
    const form = screen.getByLabelText('مرجع الكشف').closest('form')!;
    expect(form.parentElement!.className.split(' ')).toContain(CARD_CLASS);
    const table = rowOf('R-FRESH').closest('table')!;
    const surface = table.closest('.overflow-hidden') as HTMLElement;
    expect(surface.className.split(' ')).not.toContain(CARD_CLASS);
  });

  it('«من يتحمّل الفرق؟»: each line is a plain card, «اعتمد» is grey until every line has an answer', async () => {
    const onConfirm = vi.fn();
    render(
      <ShortfallPeopleDialog
        sentence="جملة"
        lines={[{ matchId: 'm1', orderNumber: 'ORD-1', amount: 5, currencyCode: 'USD' }]}
        candidates={[{ id: 'p1', name: 'مندوب', role: 'AGENT' }]}
        busy={false}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />
    );
    const dialog = await screen.findByRole('dialog');
    const line = within(dialog).getByText(/ORD-1/).closest('li')!;
    for (const el of line.querySelectorAll('div')) expect(el.className.split(' ')).not.toContain(CARD_CLASS);
    const go = within(dialog).getByRole('button', { name: 'اعتمد' }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    expect(within(dialog).getByRole('button', { name: 'رجوع' }).getAttribute('type')).toBe('button');
    fireEvent.change(within(line).getByRole('combobox'), { target: { value: 'p1' } });
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    expect(onConfirm).toHaveBeenCalledWith({ m1: 'p1' });
  });
});

describe('5 · the frame, and a phone (jsdom — what the layout depends on, not a measured layout)', () => {
  it('the frame is PageShell: one h1 with the registry name, capped at the wide width', async () => {
    as('settlement.view');
    await draw();
    const h1s = screen.getAllByRole('heading', { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0].textContent).toContain(routeLabel('/finance/collection'));
    expect(document.querySelector('.max-w-6xl')).not.toBeNull();
  });

  it('at 375px: no fixed width wider than the screen, the row’s presses wrap, and the list is cards', async () => {
    phone.value = true;
    as('settlement.view', 'settlement.approve');
    await draw();
    for (const el of document.body.querySelectorAll('[class]')) {
      for (const m of el.className.toString().matchAll(/(?:^|\s)(?:min-)?w-\[(\d+)px\]/g)) {
        expect(Number(m[1]), el.className.toString()).toBeLessThanOrEqual(375);
      }
    }
    expect(document.querySelector('.card-acts')).not.toBeNull();
    const group = screen.getAllByRole('button', { name: 'إيصال استلام' })[0].parentElement!;
    expect(group.className).toContain('flex-wrap');
  });
});
