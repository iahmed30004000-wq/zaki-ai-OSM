// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@/lib/guard-source';

/**
 * A PRODUCT'S PAGE ON THE KIT (the owner's plan of 17/11, request R12b).
 *
 * The page and six of its parts (the headline, the stock card, the fixed-cost box, the attributes, the sales card, the latest
 * orders) moved onto the kit's `PageShell` / `Button` / `IconButton` / `Card plain` / `Checkbox`. What must NOT move with the look,
 * and is held here:
 *
 *   the ONE heading — the product's own name, the same tag and the same classes it had;
 *   every press still there, under the same name, reaching the same handler with the same arguments;
 *   every write posting the same body to the same door (the pictures, the fixed cost, the attributes);
 *   every stock, cost and price line byte for byte;
 *   no raw button left but the two whole-picture presses, and nothing fixed wider than a 375px phone.
 *
 * jsdom, not a browser: every account behind the login has a second factor only the owner completes.
 */

const { ask, toast } = vi.hoisted(() => ({
  ask: vi.fn(async () => true),
  toast: { done: vi.fn(), warn: vi.fn(), failed: vi.fn() },
}));
vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'p-1' }) }));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
const as = vi.hoisted(() => ({
  user: { value: { id: 'u1', role: 'COMPANY_ADMIN', permissions: [] as string[] } },
}));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ currentUser: as.user.value, locale: 'ar', t: {} }) }));
vi.mock('@/components/ui/Confirm', () => ({ useConfirm: () => ask, useTell: () => vi.fn() }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => toast }));
// Not in this request's zone (R12a owns the dialog, R12e the offers, #332 the variants): markers that say they are mounted.
vi.mock('@/components/products/ProductEditDialog', () => ({
  ProductEditDialog: ({ open, product }: { open: boolean; product: { name: string } }) =>
    open ? <div data-testid="edit-dialog">{product.name}</div> : null,
}));
vi.mock('@/components/products/ProductOffers', () => ({ ProductOffers: () => <div data-testid="offers" /> }));
vi.mock('@/components/products/ProductVariants', () => ({ ProductVariants: () => <div data-testid="variants" /> }));

import { ProductDetailScreen } from './ProductDetailScreen';
import { ProductAttributes } from '@/components/products/ProductAttributes';
import { FixedCostEditor } from '@/components/products/FixedCostEditor';

const FILES = [
  'src/components/screens/ProductDetailScreen.tsx',
  'src/components/products/ProductHeadline.tsx',
  'src/components/products/ProductAttributes.tsx',
  'src/components/products/ProductPerformance.tsx',
  'src/components/products/ProductRecentOrders.tsx',
  'src/components/products/ProductStock.tsx',
  'src/components/products/FixedCostEditor.tsx',
];
const raw = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n');
const read = (rel: string) => stripComments(raw(rel));

const ALL = ['products.view', 'products.edit', 'products.upload_images', 'insights.view', 'products.change_cost'];
const img = (n: number) => ({ id: `img${n}`, url: `/uploads/${n}.jpg`, isPrimary: n === 1, altText: null });
const PRODUCT = {
  id: 'p-1', name: 'كريم ليلي', sku: 'NIGHT-7', status: 'ACTIVE', sourceType: 'PURCHASED', description: 'وصف قصير',
  basePrice: 25, images: [img(1), img(2), img(3)], batches: [],
  attributes: JSON.stringify({ skin: ['جافة'] }),
  category: {
    id: 'c1', name: 'العناية',
    attributeSchema: JSON.stringify([{ key: 'skin', label: 'نوع البشرة', kind: 'multi', options: ['جافة', 'دهنية'] }]),
  },
};
const STOCK = {
  onHand: 12, reserved: 2, available: 10, averageCost: 3.5, nextOutCost: 3, stockValue: 42, fixedCost: null,
  batchAverageCost: 3.5, batchCount: 3, currencyCode: 'JOD', sourceType: 'PURCHASED',
};

let asked: Array<{ url: string; method: string; body: unknown }>;
const answer = (body: unknown, ok = true) =>
  ({ ok, status: ok ? 200 : 400, headers: new Headers({ 'content-type': 'application/json' }), json: async () => body }) as unknown as Response;

beforeEach(() => {
  asked = [];
  ask.mockClear();
  Object.values(toast).forEach((f) => f.mockClear());
  as.user.value = { id: 'u1', role: 'COMPANY_ADMIN', permissions: [...ALL] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
      asked.push({ url, method, body });
      if (method !== 'GET') return answer({ ok: true });
      if (url === '/api/products/p-1/stock') return answer(STOCK);
      if (url.startsWith('/api/products/grades')) return answer({ window: { start: null, end: null, days: 30 }, salesVisible: false, costVisible: false, grades: [] });
      if (url.startsWith('/api/products/p-1/orders')) return answer({ total: 0, orders: [], currency: { code: 'JOD', minorUnit: 3 } });
      return answer({ product: PRODUCT, currencyCode: 'JOD' });
    })
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const draw = async () => {
  render(<ProductDetailScreen />);
  await screen.findByRole('heading', { level: 1 });
  await screen.findByText('بالمستودع');
};
const writes = () => asked.filter((a) => a.method !== 'GET');

describe('the frame', () => {
  it('draws ONE heading — the product’s own name, the same tag and classes it had — with the code and the status beside it', async () => {
    await draw();
    const h1 = screen.getAllByRole('heading', { level: 1 });
    expect(h1).toHaveLength(1);
    expect(h1[0].textContent).toBe('كريم ليلي');
    expect(h1[0].className).toBe('text-xl font-bold text-[var(--sys-heading)]');
    const row = h1[0].parentElement as HTMLElement;
    expect(within(row).getByText('NIGHT-7')).toBeTruthy();
    expect(within(row).getByText('نشط')).toBeTruthy();
    expect(read(FILES[0])).toContain('<PageShell');
    expect(read(FILES[0])).toContain('title={product.name}');
  });

  it('the two numbers this page is opened for are in the row under the heading, read from the stock door', async () => {
    await draw();
    const header = screen.getByRole('heading', { level: 1 }).closest('header') as HTMLElement;
    const toolbar = header.nextElementSibling as HTMLElement;
    expect(within(toolbar).getByText('متاح')).toBeTruthy();
    expect(within(toolbar).getByText('10')).toBeTruthy();
    expect(within(toolbar).getByText('من 12')).toBeTruthy();
    expect(within(toolbar).getByText('3.5 JOD')).toBeTruthy();
  });

  it('NEGATIVE: the loading state draws no heading and the spinner alone', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)));
    render(<ProductDetailScreen />);
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(document.querySelector('.animate-spin')).toBeTruthy();
  });
});

describe('the header’s presses', () => {
  it('«عودة للمنتجات» goes back, for everybody', async () => {
    as.user.value = { id: 'u2', role: 'MODERATOR', permissions: ['products.view'] };
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    await draw();
    fireEvent.click(screen.getByRole('button', { name: 'عودة للمنتجات' }));
    expect(back).toHaveBeenCalledTimes(1);
    back.mockRestore();
  });

  it('«تعديل المنتج» opens the shared dialog on this product', async () => {
    await draw();
    expect(screen.queryByTestId('edit-dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'تعديل المنتج' }));
    expect(screen.getByTestId('edit-dialog').textContent).toBe('كريم ليلي');
  });

  it('NEGATIVE: without «تعديل المنتجات» there is no edit press', async () => {
    as.user.value = { id: 'u2', role: 'MODERATOR', permissions: ['products.view'] };
    await draw();
    expect(screen.queryByRole('button', { name: 'تعديل المنتج' })).toBeNull();
  });
});

describe('the pictures’ presses keep their doors and their bodies', () => {
  it('«تعيين كرئيسية» sends PATCH setPrimary with THAT picture', async () => {
    await draw();
    fireEvent.click(screen.getAllByRole('button', { name: 'تعيين كرئيسية' })[2]);
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({ url: '/api/products/p-1/images', method: 'PATCH', body: { action: 'setPrimary', imageId: 'img3' } });
  });

  it('«تحريك يسار» / «تحريك يمين» send the swapped order — and the main picture has neither', async () => {
    await draw();
    // The main picture (1) has no move; picture 2 can only go right of… picture 3 has only «يسار».
    expect(screen.getAllByRole('button', { name: 'تحريك يسار' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'تحريك يمين' })).toHaveLength(1);
    fireEvent.click(screen.getAllByRole('button', { name: 'تحريك يسار' })[1]);
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body).toEqual({ action: 'reorder', order: ['img1', 'img3', 'img2'] });
    fireEvent.click(screen.getByRole('button', { name: 'تحريك يمين' }));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[1].body).toEqual({ action: 'reorder', order: ['img1', 'img3', 'img2'] });
  });

  it('«حذف» asks first, then sends DELETE to that picture', async () => {
    await draw();
    fireEvent.click(screen.getAllByRole('button', { name: 'حذف' })[1]);
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(ask).toHaveBeenCalledTimes(1);
    expect(writes()[0]).toMatchObject({ url: '/api/products/p-1/images/img2', method: 'DELETE' });
  });

  it('NEGATIVE: a «لا» to the question sends nothing', async () => {
    ask.mockResolvedValueOnce(false);
    await draw();
    fireEvent.click(screen.getAllByRole('button', { name: 'حذف' })[0]);
    await waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    expect(writes()).toHaveLength(0);
  });

  it('«رفع صور» posts the files with isPrimary=false when the product already has pictures', async () => {
    await draw();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.setup().upload(input, new File(['a'], 'a.png', { type: 'image/png' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    const form = writes()[0].body as FormData;
    expect(writes()[0]).toMatchObject({ url: '/api/products/p-1/images', method: 'POST' });
    expect(form.get('isPrimary')).toBe('false');
    expect((form.getAll('files')[0] as File).name).toBe('a.png');
  });

  it('a thumbnail opens the preview of THAT picture', async () => {
    await draw();
    fireEvent.click(screen.getByRole('button', { name: 'كبّر الصورة 2' }));
    expect(await screen.findByAltText('معاينة')).toHaveProperty('src', expect.stringContaining('/uploads/2.jpg'));
  });

  it('NEGATIVE: without «رفع صور المنتجات» none of the four picture presses is drawn', async () => {
    as.user.value = { id: 'u2', role: 'MODERATOR', permissions: ['products.view'] };
    await draw();
    for (const name of ['تعيين كرئيسية', 'تحريك يسار', 'تحريك يمين', 'حذف']) {
      expect(screen.queryAllByRole('button', { name }), name).toHaveLength(0);
    }
  });

  it('every picture press is the kit’s square and never a form’s submit', () => {
    const src = read(FILES[0]);
    const tags = src.match(/<IconButton\b(?:=>|[^>])*>/g) ?? [];
    expect(tags).toHaveLength(4);
    for (const t of tags) expect(t).toMatch(/onClick=\{\(\) => \{ void (setPrimary|moveImage|deleteImage)\(/);
    expect(src).not.toMatch(/<form\b/);
  });
});

describe('the parts keep their writes', () => {
  it('the fixed cost posts { amount } to its own door — one figure, the typed one', async () => {
    const saved = vi.fn();
    render(<FixedCostEditor productId="p-1" fixedCost={null} batchAverage={3.5} money={(n) => `${n}`} canChange onSaved={saved} />);
    fireEvent.change(screen.getByLabelText('التكلفة الثابتة'), { target: { value: '4.25' } });
    fireEvent.click(screen.getByRole('button', { name: 'احفظ' }));
    await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
    expect(writes()).toEqual([{ url: '/api/products/p-1/fixed-cost', method: 'PUT', body: { amount: 4.25 } }]);
  });

  it('the attributes: each answer is a kit tick box with its own id, and the save posts the ticked answers', async () => {
    render(<ProductAttributes productId="p-1" canManage />);
    const dry = (await screen.findByLabelText('جافة')) as HTMLInputElement;
    const oily = screen.getByLabelText('دهنية') as HTMLInputElement;
    expect(dry.id).toBe('attr-skin-0');
    expect(oily.id).toBe('attr-skin-1');
    expect(dry.checked).toBe(true);
    fireEvent.click(oily);
    fireEvent.click(dry);
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الخصائص' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({ url: '/api/products/p-1', method: 'PATCH', body: { attributes: { skin: ['دهنية'] } } });
  });

  it('NEGATIVE: a viewer’s tick boxes are disabled and there is no save', async () => {
    render(<ProductAttributes productId="p-1" canManage={false} />);
    expect(((await screen.findByLabelText('جافة')) as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'حفظ الخصائص' })).toBeNull();
  });
});

describe('what the look did not touch', () => {
  it('no raw button is left but the two whole-picture presses (the big picture and a thumbnail)', () => {
    expect(read(FILES[0]).match(/<button\b/g) ?? []).toHaveLength(2);
    for (const f of FILES.slice(1)) expect(read(f).match(/<button\b/g) ?? [], f).toEqual([]);
    expect(read('src/components/products/ProductAttributes.tsx')).not.toMatch(/type="checkbox"/);
  });

  it('every stock, cost and price line is byte for byte what it was', () => {
    const lines: Array<[string, string]> = [
      ['src/components/screens/ProductDetailScreen.tsx', '                    <Money value={product.basePrice} className="font-bold text-[var(--sys-heading)]" />'],
      ['src/components/screens/ProductDetailScreen.tsx', '                  render: (b: any) => (b.quantityProduced) },'],
      ['src/components/screens/ProductDetailScreen.tsx', '                  render: (b: any) => (b.quantityRemaining) },'],
      ['src/components/screens/ProductDetailScreen.tsx', '                  <><Money value={b.totalProductionCost} /></>'],
      ['src/components/screens/ProductDetailScreen.tsx', '                  <><Money value={b.costPerUnit} className="font-black text-[var(--sys-heading)]" /></>'],
      ['src/components/products/ProductHeadline.tsx', '            <b className="text-sm tabular-nums text-[var(--sys-heading)]">{stock.available}</b>'],
      ['src/components/products/ProductHeadline.tsx', '            <span className="text-' + 'xs text-[var(--sys-muted)]">من {stock.onHand}</span>'],
      ['src/components/products/ProductHeadline.tsx', '            <b className="text-sm tabular-nums text-[var(--sys-heading)]" dir="ltr">{money(stock.averageCost)}</b>'],
      ['src/components/products/ProductStock.tsx', '          <Tile label="بالمستودع" value={String(stock.onHand)} />'],
      ['src/components/products/ProductStock.tsx', '            value={String(stock.reserved)}'],
      ['src/components/products/ProductStock.tsx', '            value={String(stock.available)}'],
      ['src/components/products/ProductStock.tsx', "            <Tile label={stock.fixedCost != null ? 'تكلفة الوحدة (ثابتة)' : 'تكلفة الوحدة (متوسط مرجّح)'} value={money(stock.averageCost)} />"],
      ['src/components/products/ProductStock.tsx', '            <Tile label="تكلفة الدفعة القادمة للخروج" value={money(stock.nextOutCost)} />'],
      ['src/components/products/ProductStock.tsx', '            <Tile label="قيمة المخزون" value={money(stock.stockValue)} />'],
      ['src/components/products/ProductStock.tsx', '      <p className="mt-0.5 text-sm font-black tabular-nums" dir="ltr">{value}</p>'],
      ['src/components/products/FixedCostEditor.tsx', "      await apiJson(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount }) });"],
      ['src/components/products/FixedCostEditor.tsx', '            تكلفة الوحدة الثابتة: <span className="tabular-nums" dir="ltr">{money(fixedCost)}</span>'],
      ['src/components/products/ProductPerformance.tsx', '                <Money value={sales.deliveredRevenue} className="font-black text-[var(--sys-primary)]" />'],
      ['src/components/products/ProductPerformance.tsx', '                  <Money value={sales.deliveredCogs} className="font-bold text-[var(--sys-heading)]" />'],
      ['src/components/products/ProductRecentOrders.tsx', '                  <Money value={o.totalAmount} currency={answer.currency.code} minorUnit={answer.currency.minorUnit} className="font-bold" />'],
    ];
    for (const [f, line] of lines) expect(raw(f).split('\n'), `${f}: ${line.trim()}`).toContain(line);
  });

  it('nothing in the seven files is fixed wider than a 375px phone less its gutters', () => {
    for (const f of FILES) {
      for (const m of read(f).matchAll(/\b(?:min-)?w-\[(\d+)px\]/g)) expect(Number(m[1]), `${f}: ${m[0]}`).toBeLessThanOrEqual(343);
    }
  });
});
