// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

/**
 * «تشغيلات الإنتاج» ON THE KIT (R12d, plan 17/11 — written 18/11).
 *
 * The screen moved onto `PageShell`, `Button`, `IconButton` and `Card plain`. What must NOT have moved with it:
 * every press reaches the same handler with the same row, the save posts the same body, and the frame draws one
 * heading with the menu's name. Every claim below has a negative twin, so a wrong row, a dropped line or a second
 * heading turns it red.
 *
 * jsdom has no layout: «no sideways scroll at 375px» is checked as the classes that make it (the frame's `min-w-0`,
 * the phone's half-width row presses), and said so in the pull request.
 */

const { phone, costing } = vi.hoisted(() => ({
  phone: { value: false },
  costing: { batches: [] as string[] },
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/manufacturing',
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
  useApp: () => ({ t: { cancel: 'إلغاء' }, locale: 'ar', currentUser: null }),
}));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => phone.value }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), done: vi.fn() }) }));
vi.mock('@/components/ui/ProductPicker', () => ({ ProductPicker: () => <div data-picker /> }));
// The dialog is the handler's destination: which batch it was opened WITH is the argument under test.
vi.mock('@/components/production/BatchCostDialog', () => ({
  BatchCostDialog: ({ batch }: { batch: { id: string } }) => {
    costing.batches.push(batch.id);
    return <div data-testid="costing">{batch.id}</div>;
  },
}));

import { ManufacturingScreen } from './ManufacturingScreen';
import { routeLabel } from '@/lib/route-registry';

const WAIT = { timeout: 8000 };
vi.setConfig({ testTimeout: 15000 });

const PRODUCT = { id: 'prod-1', name: 'كريم', sku: 'KR-1', sourceType: 'MANUFACTURED', basePrice: 10 };
const batch = (over: Record<string, unknown> = {}) => ({
  id: 'b1',
  batchNumber: 'RUN-1',
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
const OPENING = batch({ id: 'b2', batchNumber: 'OPEN-1', openingCountId: 'oc1', costPerUnit: 0, totalProductionCost: 0 });

let posted: { url: string; body: unknown }[] = [];
let asked: string[] = [];
const serve = (batches: unknown[]) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      asked.push(String(url));
      if (init?.method === 'POST') {
        posted.push({ url: String(url), body: JSON.parse(init.body as string) });
        return { ok: true, json: async () => ({ batch: { id: 'new' } }) } as any;
      }
      if (String(url).startsWith('/api/products')) return { ok: true, json: async () => ({ products: [PRODUCT] }) } as any;
      return { ok: true, json: async () => ({ batches, currency: 'JOD' }) } as any;
    })
  );

const draw = async (batches: unknown[] = [batch(), OPENING]) => {
  serve(batches);
  render(<ManufacturingScreen />);
  await waitFor(() => expect(document.querySelector('li')).not.toBeNull(), WAIT);
};
const rows = () => [...document.querySelectorAll('li')] as HTMLElement[];
const rowOf = (n: string) => rows().find((r) => r.textContent!.includes(n)) as HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  phone.value = false;
  costing.batches = [];
  posted = [];
  asked = [];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the frame', () => {
  it('draws ONE heading, the name the menu gives the page, and asks the same two doors it always asked', async () => {
    await draw();
    const h1s = screen.getAllByRole('heading', { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0].textContent).toBe('تشغيلات الإنتاج');
    expect(routeLabel('/manufacturing')).toBe('تشغيلات الإنتاج');
    expect([...new Set(asked)].sort()).toEqual(['/api/production', '/api/products']);
  });

  it('is the full width (no cap) and may shrink, so a phone never scrolls sideways', async () => {
    phone.value = true;
    await draw();
    const frame = screen.getByRole('heading', { level: 1 }).closest('div.min-w-0') as HTMLElement;
    expect(frame).not.toBeNull();
    // None of the frame's three caps (narrow · medium · wide) on any ancestor of the heading.
    for (let el: HTMLElement | null = frame; el; el = el.parentElement) {
      expect(el.className, el.tagName).not.toMatch(/max-w-(3xl|4xl|6xl)/);
    }
  });
});

describe('every press reaches the same handler with the same row', () => {
  it('«اعرضها وحدها» is a kit button and narrows the list to that door — and only after it is pressed', async () => {
    await draw();
    expect(rowOf('RUN-1')).toBeDefined();
    expect(rowOf('OPEN-1')).toBeDefined();
    const show = screen.getByRole('button', { name: 'اعرضها وحدها' });
    expect(show.className).toContain('md:h-8');
    fireEvent.click(show);
    await waitFor(() => expect(rowOf('RUN-1')).toBeUndefined());
    expect(rowOf('OPEN-1')).toBeDefined();
  });

  it('«بلا كلفة» opens the cost dialog with THAT row, and a costed row has no such press', async () => {
    await draw();
    expect(within(rowOf('RUN-1')).queryByRole('button', { name: 'بلا كلفة' })).toBeNull();
    const none = within(rowOf('OPEN-1')).getByRole('button', { name: 'بلا كلفة' });
    expect(none.getAttribute('title')).toBe('هذه التشغيلة بلا كلفة، فالربح المحسوب منها إجمالي لا صافي');
    expect(screen.queryByTestId('costing')).toBeNull();
    fireEvent.click(none);
    expect(screen.getByTestId('costing').textContent).toBe('b2');
  });

  it('«عدّل الكلفة» opens the cost dialog with its own row, not the first one', async () => {
    await draw();
    fireEvent.click(within(rowOf('OPEN-1')).getByRole('button', { name: 'عدّل الكلفة' }));
    expect(screen.getByTestId('costing').textContent).toBe('b2');
    cleanup();
    await draw();
    fireEvent.click(within(rowOf('RUN-1')).getByRole('button', { name: 'عدّل الكلفة' }));
    expect(screen.getByTestId('costing').textContent).toBe('b1');
  });

  it('PHONE: the row press is a framed half of the row; DESK: a quiet one with no drawn edge', async () => {
    phone.value = true;
    await draw();
    const p = within(rowOf('RUN-1')).getByRole('button', { name: 'عدّل الكلفة' });
    expect(p.className).toContain('flex-1');
    expect(p.className).toContain('border-[var(--sys-border)]');
    cleanup();
    phone.value = false;
    await draw();
    const d = within(rowOf('RUN-1')).getByRole('button', { name: 'عدّل الكلفة' });
    expect(d.className).not.toContain('flex-1');
    expect(d.className).not.toContain('border-[var(--sys-border)]');
  });
});

describe('the new-run form posts the same body', () => {
  const open = async () => {
    serve([]);
    render(<ManufacturingScreen />);
    await waitFor(() => expect(screen.getByText('لا تشغيلاتِ إنتاجٍ بعد')).toBeTruthy(), WAIT);
    fireEvent.click(screen.getByRole('button', { name: /تشغيلة جديدة/ }));
    return screen.getByRole('dialog');
  };
  const addLine = (dialog: HTMLElement, label: string) => {
    const pick = within(dialog).getByRole('option', { name: '+ أضف بنداً…' }).closest('select') as HTMLSelectElement;
    fireEvent.change(pick, { target: { value: label } });
  };

  it('the bin is a named icon button, and it deletes THAT line — the other one is what is sent', async () => {
    const dialog = await open();
    addLine(dialog, 'قالب');
    addLine(dialog, 'شحن المواد الخام');
    fireEvent.change(within(dialog).getByLabelText('مبلغ البند 1'), { target: { value: '15' } });
    fireEvent.change(within(dialog).getByLabelText('مبلغ البند 2'), { target: { value: '30' } });
    const bins = within(dialog).getAllByRole('button', { name: 'حذف البند' });
    expect(bins).toHaveLength(2);
    expect(bins[0].className).toContain('w-11');
    fireEvent.click(bins[0]);
    expect(within(dialog).getAllByRole('button', { name: 'حذف البند' })).toHaveLength(1);

    fireEvent.change(within(dialog).getByLabelText(/الكمية المنتَجة/), { target: { value: '100' } });
    fireEvent.change(within(dialog).getByLabelText('كلفة التصنيع'), { target: { value: '200' } });
    const number = (within(dialog).getByLabelText(/رقم التشغيلة/) as HTMLInputElement).value;
    fireEvent.click(within(dialog).getByRole('button', { name: 'احفظ الدفعة وأضفها للمخزون' }));
    await waitFor(() => expect(posted).toHaveLength(1), WAIT);

    expect(posted[0].url).toBe('/api/production');
    // The characters as typed; the empty boxes ABSENT (not zero); the deleted line gone, the kept one intact.
    expect(posted[0].body).toEqual({
      productId: 'prod-1',
      batchNumber: number,
      quantityProduced: '100',
      manufacturingCost: '200',
      costLines: [{ label: 'شحن المواد الخام', amount: '30' }],
      notes: '',
    });
  });

  it('the cost block and the read-out boxes are dense surfaces — the card fill without the theme’s page ornament', async () => {
    const dialog = await open();
    const block = within(dialog).getByText('تفصيل الكلفة المباشرة').parentElement as HTMLElement;
    expect(block.className).toContain('bg-[var(--sys-card)]');
    expect(block.className).not.toContain('zk-card');
    cleanup();
    await draw();
    const box = screen.getByRole('button', { name: 'اعرضها وحدها' }).closest('p')!.parentElement as HTMLElement;
    expect(box.className).toContain('bg-[var(--sys-card)]');
    expect(box.className).not.toContain('zk-card');
  });
});
