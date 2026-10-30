// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

/**
 * THE STOCK AND PRODUCTION SCREENS ON A PHONE — M7 of the phone audit
 * (OPS-INV-1..4 · OPS-MFG-1..6 · OPS-SH-4).
 *
 * «أرصدة المخزون» · «تشغيلات الإنتاج» · the batch-cost dialog. Every claim is made on a phone AND on a desk: a phone is
 * `useIsPhone` (each screen draws ONE layout), and the desk is the same render with the hook answering `false` — which
 * must be exactly what was there before.
 *
 * jsdom has no layout; the measures (44px, the wrapping, the footer under the keyboard) are in the pull request.
 */

const { apiJson, user, phone } = vi.hoisted(() => ({
  apiJson: vi.fn(),
  user: { current: null as unknown },
  phone: { value: true },
}));

vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a), apiFetch: vi.fn() }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/inventory/balances',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ children, href, className }: { children: React.ReactNode; href: string; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ t: { cancel: 'إلغاء' }, locale: 'ar', currentUser: user.current }),
}));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => phone.value }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), done: vi.fn() }) }));
vi.mock('@/components/inventory/OpeningStockCount', () => ({ OpeningStockCountBanner: () => null }));
vi.mock('@/components/ui/ProductPicker', () => ({ ProductPicker: () => <div data-picker /> }));

import { InventoryBalancesScreen } from './InventoryBalancesScreen';
import { ManufacturingScreen } from './ManufacturingScreen';
import { BatchCostDialog } from '@/components/production/BatchCostDialog';

const WAIT = { timeout: 8000 };
vi.setConfig({ testTimeout: 15000 });

beforeEach(() => {
  vi.clearAllMocks();
  phone.value = true;
  user.current = { id: 'u1', name: 'سارة', role: 'COMPANY_ADMIN', permissions: ['inventory.view', 'inventory.adjust'], status: 'ACTIVE' };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const fold = (word: string) =>
  [...document.querySelectorAll('details')].find((d) => d.querySelector('summary')!.textContent!.includes(word)) as HTMLDetailsElement | undefined;

/* ═══════════════════════ أرصدة المخزون ═══════════════════════ */

describe('«أرصدة المخزون»', () => {
  const health = {
    tone: 'ok',
    label: 'متوفر',
    why: 'تكفي مدة جيدة',
    state: 'healthy',
    available: 10,
    perDay: 1.5,
    coverDays: 6.6,
    windowDays: 13,
    score: 80,
    bands: [{ key: 'cover', ar: 'مدة الكفاية', weight: 55, earned: 40, why: 'تكفي' }],
    needsRestock: false,
  };
  const row = (n: number, over: Record<string, unknown> = {}) => ({
    id: `P${n}`,
    name: `منتج ${String(n).padStart(2, '0')}`,
    sku: `SKU-${n}`,
    sourceType: 'PURCHASED',
    produced: 20,
    sold: 10,
    remaining: 10,
    reserved: 1,
    lastUnitCost: 3,
    health,
    ...over,
  });
  const serve = (n: number) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          stockSummary: Array.from({ length: n }, (_, i) => row(i + 1)),
          alerts: [{ state: 'low', tone: 'warn', ar: 'قارب على الانتهاء', count: 2 }],
          ledgerDays: 13,
        }),
      }))
    );
  const draw = async (n = 25) => {
    serve(n);
    render(<InventoryBalancesScreen />);
    await screen.findByText('منتج 01', undefined, WAIT);
  };
  const cardOf = (name: string) => screen.getByText(name).closest('div[class*="space-y-3"]') as HTMLElement;
  const cards = () => screen.queryAllByRole('link', { name: /^منتج \d\d$/ });

  it('PHONE: twenty cards, then «اعرض المزيد (5)» — one press shows the rest, and the button goes', async () => {
    await draw(25);
    expect(cards()).toHaveLength(20);
    fireEvent.click(screen.getByRole('button', { name: 'اعرض المزيد (5)' }));
    expect(cards()).toHaveLength(25);
    expect(screen.queryByRole('button', { name: /اعرض المزيد/ })).toBeNull();
  });

  it('PHONE: a new search starts again at the first page — and a narrow one loses nothing behind the cap', async () => {
    await draw(45);
    fireEvent.click(screen.getByRole('button', { name: 'اعرض المزيد (25)' }));
    expect(cards()).toHaveLength(40);
    // «منتج » still matches all 45, so only the reset can bring the page back to twenty
    fireEvent.change(screen.getByPlaceholderText('ابحث باسم المنتج أو رمزه…'), { target: { value: 'منتج ' } });
    await waitFor(() => expect(cards()).toHaveLength(20));
    expect(screen.getByRole('button', { name: 'اعرض المزيد (25)' })).toBeTruthy();
    // a search that matches six shows six, with no button
    fireEvent.change(screen.getByPlaceholderText('ابحث باسم المنتج أو رمزه…'), { target: { value: 'منتج 4' } });
    await waitFor(() => expect(cards()).toHaveLength(6));
    expect(screen.queryByRole('button', { name: /اعرض المزيد/ })).toBeNull();
  });

  it('DESK: nothing changed — every card at once and no button to ask for more', async () => {
    phone.value = false;
    await draw(25);
    expect(cards()).toHaveLength(25);
    expect(screen.queryByRole('button', { name: /اعرض المزيد/ })).toBeNull();
  });

  it('PHONE: three figures are read at a glance and the rest are one tap down, in a fold that names them', async () => {
    await draw(2);
    const c = cardOf('منتج 01');
    const open = within(c).getByText('متاح').closest('div[class*="grid"]') as HTMLElement;
    expect([...open.children].map((f) => f.firstElementChild!.textContent)).toEqual(['متاح', 'تكفي (يوم)', 'الدرجة']);
    const folded = c.querySelector('details') as HTMLDetailsElement;
    expect(folded.open).toBe(false);
    expect(folded.querySelector('summary')!.textContent).toContain('على الرف · محجوز · يومياً');
    for (const label of ['على الرف', 'محجوز', 'يومياً']) expect(within(folded).getByText(label)).toBeTruthy();
  });

  it('DESK: nothing changed — six figures in the old order, no fold in the card', async () => {
    phone.value = false;
    await draw(2);
    const c = cardOf('منتج 01');
    expect(c.querySelector('details')).toBeNull();
    const grid = within(c).getByText('متاح').closest('div[class*="grid"]') as HTMLElement;
    expect([...grid.children].map((f) => f.firstElementChild!.textContent)).toEqual([
      'على الرف',
      'محجوز',
      'متاح',
      'يومياً',
      'تكفي (يوم)',
      'الدرجة',
    ]);
  });

  it('PHONE: «استلام» is a button across the card; DESK: the word it was', async () => {
    await draw(2);
    const b = within(cardOf('منتج 01')).getByRole('button', { name: 'استلام' });
    expect(b.className).toContain('w-full');
    expect(b.className).not.toContain('hover:underline');
    cleanup();
    phone.value = false;
    await draw(2);
    const d = within(cardOf('منتج 01')).getByRole('button', { name: 'استلام' });
    expect(d.className).toContain('hover:underline');
    expect(d.className).not.toContain('w-full');
  });

  it('PHONE: the card is p-4 and the score disclosure has a 44px target; DESK: p-5', async () => {
    await draw(2);
    const content = cardOf('منتج 01');
    expect(content.className).toContain('p-4');
    expect(within(content).getByRole('button', { name: 'من أين الدرجة؟' }).className).toContain('min-h-11');
    cleanup();
    phone.value = false;
    await draw(2);
    expect(cardOf('منتج 01').className).toContain('p-5');
  });

  it('PHONE: the paragraph that says how the speed is measured is folded; DESK: printed on every visit', async () => {
    await draw(2);
    const f = fold('كيف تُحسب السرعة؟')!;
    expect(f).toBeDefined();
    expect(f.open).toBe(false);
    expect(f.textContent).toContain('سرعة البيع مقيسة على آخر 13 يوماً');
    cleanup();
    phone.value = false;
    await draw(2);
    expect(fold('كيف تُحسب السرعة؟')).toBeUndefined();
    expect(screen.getByText(/سرعة البيع مقيسة على آخر 13 يوماً/)).toBeTruthy();
  });

  it('PHONE: the alert chips are 44px targets', async () => {
    await draw(2);
    const chip = screen.getByRole('button', { name: /قارب على الانتهاء/ });
    expect(chip.className).toContain('min-h-11');
  });

  it('the count dialog: PHONE «رصيد النظام» stands at the height of the box beside it; DESK keeps its padding', async () => {
    await draw(2);
    fireEvent.click(screen.getAllByRole('button', { name: /جرد مخزون/ })[0]);
    const box = within(screen.getByRole('dialog')).getByText('رصيد النظام').nextElementSibling as HTMLElement;
    expect(box.className).toContain('h-11');
    expect(box.className).not.toContain('py-2');
    cleanup();
    phone.value = false;
    await draw(2);
    fireEvent.click(screen.getAllByRole('button', { name: /جرد مخزون/ })[0]);
    const desk = within(screen.getByRole('dialog')).getByText('رصيد النظام').nextElementSibling as HTMLElement;
    expect(desk.className).toContain('py-2');
    expect(desk.className).not.toContain('h-11');
  });
});

/* ═══════════════════════ تشغيلات الإنتاج ═══════════════════════ */

describe('«تشغيلات الإنتاج»', () => {
  const PRODUCT = { id: 'prod-1', name: 'كريم', sku: 'KR-1', sourceType: 'MANUFACTURED', basePrice: 10 };
  const batch = (over: Record<string, unknown> = {}) => ({
    id: 'b1',
    batchNumber: 'BATCH-2026-001',
    productId: 'prod-1',
    product: PRODUCT,
    quantityProduced: 100,
    quantitySold: 40,
    quantityRemaining: 60,
    manufacturingCost: 200,
    packagingCost: 50,
    rawMaterialCost: 100,
    otherCosts: 0,
    costPerUnit: 3.5,
    totalProductionCost: 350,
    productionDate: '2026-10-01T00:00:00.000Z',
    costLines: [],
    openingCountId: null,
    ...over,
  });
  const serve = (batches: unknown[]) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).startsWith('/api/products')) return { ok: true, json: async () => ({ products: [PRODUCT] }) } as any;
        return { ok: true, json: async () => ({ batches, currency: 'JOD' }) } as any;
      })
    );
  /** A run, plus a row that came in through the opening count — so the read-out has a box to draw. */
  const draw = async () => {
    serve([batch(), batch({ id: 'b2', batchNumber: 'OPEN-1', openingCountId: 'oc1', costPerUnit: 0, totalProductionCost: 0 })]);
    render(<ManufacturingScreen />);
    await waitFor(() => expect(document.querySelector('li')).not.toBeNull(), WAIT);
  };
  const card = () => document.querySelector('li') as HTMLElement;
  const openDialog = async () => {
    await draw();
    fireEvent.click(screen.getByRole('button', { name: /تشغيلة جديدة/ }));
    return screen.getByRole('dialog');
  };

  it('PHONE: the read-out keeps its headline and folds the boxes under it, naming what is inside', async () => {
    await draw();
    const f = fold('التفصيل')!;
    expect(f).toBeDefined();
    expect(f.open).toBe(false);
    expect(f.querySelector('summary')!.textContent).toContain('مصدر الصفوف · التنبيهات');
    expect(within(f).getByRole('button', { name: 'اعرضها وحدها' })).toBeTruthy();
    // the headline is outside the fold, where it is read without a tap
    expect(f.contains(screen.getByText(/^[0-9]+ من 2 /))).toBe(false);
  });

  it('DESK: nothing changed — the boxes are in the card, no fold', async () => {
    phone.value = false;
    await draw();
    expect(fold('التفصيل')).toBeUndefined();
    expect(screen.getByRole('button', { name: 'اعرضها وحدها' })).toBeTruthy();
  });

  it('PHONE: the card keeps what is read at a glance and leaves the sold count, the total cost and the date to the table', async () => {
    await draw();
    for (const gone of ['بِيع', 'الكلفة الكلية', 'التاريخ']) expect(within(card()).queryByText(gone), gone).toBeNull();
    for (const kept of ['متبقٍّ', 'كلفة الوحدة', 'درجة الكلفة', 'من أي باب دخلت']) expect(within(card()).getByText(kept), kept).toBeTruthy();
  });

  it('DESK: nothing changed — every column is on the card', async () => {
    phone.value = false;
    await draw();
    for (const word of ['بِيع', 'الكلفة الكلية', 'التاريخ', 'متبقٍّ', 'كلفة الوحدة', 'درجة الكلفة']) {
      expect(within(card()).getByText(word), word).toBeTruthy();
    }
  });

  it('the grade has the whole width of the card, with its reason, on a phone and a desk alike (it is a sentence, not a figure)', async () => {
    await draw();
    expect(within(card()).getByText('درجة الكلفة').parentElement!.className).toContain('flex-col');
  });

  it('PHONE: «عدّل الكلفة» and «المنتج» are two bordered halves of one row', async () => {
    await draw();
    const edit = within(card()).getByRole('button', { name: 'عدّل الكلفة' });
    const product = within(card()).getByRole('link', { name: 'المنتج' });
    for (const el of [edit, product]) {
      expect(el.className).toContain('flex-1');
      expect(el.className).toContain('border');
    }
  });

  it('DESK: nothing changed — the two are the plain links they were', async () => {
    phone.value = false;
    await draw();
    for (const el of [within(card()).getByRole('button', { name: 'عدّل الكلفة' }), within(card()).getByRole('link', { name: 'المنتج' })]) {
      expect(el.className).not.toContain('flex-1');
      expect(el.className).not.toContain('border');
    }
  });

  it('PHONE: the card sits in a gutter instead of flush against the frame; DESK: flush, with the old scroller', async () => {
    await draw();
    expect(card().closest('ul')!.parentElement!.className).not.toContain('overflow-x-auto');
    expect(card().closest('[class*="p-3"]')).not.toBeNull();
    cleanup();
    phone.value = false;
    await draw();
    expect(card().closest('ul')!.parentElement!.className).toContain('overflow-x-auto');
  });

  it('PHONE: «حفظ» stays at the foot of the dialog, outside the part that scrolls — and still submits the form', async () => {
    const dialog = await openDialog();
    const form = dialog.querySelector('form') as HTMLFormElement;
    const save = within(dialog).getByRole('button', { name: 'احفظ الدفعة وأضفها للمخزون' }) as HTMLButtonElement;
    expect(form.contains(save)).toBe(false);
    expect(dialog.querySelector('[data-modal-body]')!.contains(save)).toBe(false);
    expect(save.getAttribute('form')).toBe(form.id);
    expect(save.form).toBe(form);
  });

  it('DESK: nothing changed — «حفظ» is the end of the form', async () => {
    phone.value = false;
    const dialog = await openDialog();
    const form = dialog.querySelector('form') as HTMLFormElement;
    const save = within(dialog).getByRole('button', { name: 'احفظ الدفعة وأضفها للمخزون' }) as HTMLButtonElement;
    expect(form.contains(save)).toBe(true);
    expect(save.hasAttribute('form')).toBe(false);
  });

  it('PHONE: the product and the run number have a line each; DESK: two columns', async () => {
    const dialog = await openDialog();
    expect(dialog.querySelector('[data-picker]')!.closest('div[class*="grid"]')!.className).toContain('grid-cols-1');
    cleanup();
    phone.value = false;
    const desk = await openDialog();
    expect(desk.querySelector('[data-picker]')!.closest('div[class*="grid"]')!.className).toContain('grid-cols-2');
  });

  it('PHONE: an extra cost line gives its name a line, and the amount and the delete share the next; DESK: one row', async () => {
    const dialog = await openDialog();
    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'قالب' } });
    const name = within(dialog).getByPlaceholderText('مثال: أجرة عامل');
    expect(name.closest('div[class*="w-full"]')).not.toBeNull();
    expect(name.closest('div[class*="flex-wrap"]')).not.toBeNull();
    cleanup();
    phone.value = false;
    const desk = await openDialog();
    fireEvent.change(within(desk).getByRole('combobox'), { target: { value: 'قالب' } });
    const deskName = within(desk).getByPlaceholderText('مثال: أجرة عامل');
    expect(deskName.closest('div[class*="flex-wrap"]')).toBeNull();
    expect(within(desk).getByLabelText('مبلغ البند 1').closest('div[class*="w-32"]')).not.toBeNull();
  });

  it('PHONE: the calculator puts the formula over the unit cost instead of squeezing them side by side', async () => {
    const dialog = await openDialog();
    const box = within(dialog).getByText(/الكلفة الكلية:/).closest('div[class*="rounded-lg"]') as HTMLElement;
    expect(box.className).toContain('flex-col');
    cleanup();
    phone.value = false;
    const desk = await openDialog();
    const deskBox = within(desk).getByText(/الكلفة الكلية:/).closest('div[class*="rounded-lg"]') as HTMLElement;
    expect(deskBox.className).toContain('justify-between');
  });

  it('the notes box shows an Arabic example, on both — there is no English word left on the screen', async () => {
    const dialog = await openDialog();
    expect(within(dialog).getByPlaceholderText(/^مثال: قوارير زجاج عنبري/)).toBeTruthy();
    expect(dialog.querySelector('textarea')!.getAttribute('placeholder')).not.toMatch(/[A-Za-z]/);
  });
});

/* ═══════════════════════ كلفة التشغيلة ═══════════════════════ */

describe('the batch-cost dialog', () => {
  const BATCH = {
    id: 'b1',
    batchNumber: 'BATCH-2026-001',
    quantityProduced: 100,
    quantitySold: 40,
    manufacturingCost: 200,
    packagingCost: 50,
    rawMaterialCost: 100,
    otherCosts: 0,
    costPerUnit: 3.5,
    totalProductionCost: 350,
    product: { name: 'كريم', sku: 'KR-1' },
    costLines: [{ label: 'قالب', amount: 100 }],
  };
  const open = () => render(<BatchCostDialog batch={BATCH} onClose={() => {}} onSaved={() => {}} />);

  it('PHONE: every field is 44px, the line name has a row to itself and «+ بند» is a 44px target', () => {
    open();
    const dialog = screen.getByRole('dialog');
    for (const input of dialog.querySelectorAll('input')) expect(input.className).toContain('h-11');
    expect(within(dialog).getByPlaceholderText('اسم البند').className).toContain('w-full');
    expect(within(dialog).getByPlaceholderText('اسم البند').parentElement!.className).toContain('flex-wrap');
    expect(within(dialog).getByRole('button', { name: 'بند' }).className).toContain('min-h-11');
  });

  it('DESK: nothing changed — 40px fields, the name and the amount on one row', () => {
    phone.value = false;
    open();
    const dialog = screen.getByRole('dialog');
    for (const input of dialog.querySelectorAll('input')) expect(input.className).toContain('h-10');
    expect(within(dialog).getByPlaceholderText('اسم البند').className).toContain('flex-1');
    expect(within(dialog).getByPlaceholderText('اسم البند').parentElement!.className).not.toContain('flex-wrap');
  });
});
