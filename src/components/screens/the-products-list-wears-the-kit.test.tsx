// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@/lib/guard-source';

/**
 * «المنتجات» ON THE KIT (the owner's plan of 17/11, request R12a).
 *
 * The list, its new-product form, the sorting dialog, the shelf picker and the shared edit dialog moved onto the kit's
 * `Button` / `IconButton` / `Segmented` / `Card` and the `PageShell` frame. What must NOT move with the look, and is held here:
 *
 *   the ONE heading, the menu's own name;
 *   every press still there, under the same name, reaching the same handler with the same arguments;
 *   every write posting the same body to the same door (the new product, the delete, the new shelf);
 *   the stock and cost lines of the table byte for byte;
 *   no raw button left in the four files, and nothing fixed wider than a 375px phone.
 *
 * jsdom, not a browser: every account behind the login has a second factor only the owner completes.
 */

const { push, tell, ask } = vi.hoisted(() => ({ push: vi.fn(), tell: vi.fn(), ask: vi.fn(async () => true) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }), useSearchParams: () => new URLSearchParams() }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ t: { products: 'المنتجات', loading: 'جارٍ التحميل…' }, locale: 'ar' }) }));
vi.mock('@/context/StoreCurrency', () => ({ useStoreCurrency: () => ({ code: 'JOD', minorUnit: 3 }) }));
vi.mock('@/components/ui/Confirm', () => ({ useConfirm: () => ask, useTell: () => tell }));
vi.mock('@/components/products/CategoryPicker', () => ({ CategoryPicker: () => <div data-testid="category-picker" /> }));

import { ProductsScreen } from './ProductsScreen';
import { ProductEditDialog } from '@/components/products/ProductEditDialog';

const read = (rel: string) => stripComments(readFileSync(join(process.cwd(), rel), 'utf8'));
const FILES = [
  'src/components/screens/ProductsScreen.tsx',
  'src/components/products/CategoriseDialog.tsx',
  'src/components/products/CategoryPicker.tsx',
  'src/components/products/ProductEditDialog.tsx',
];

const row = (id: string, name: string, sku: string, categoryId: string | null) => ({
  id, name, nameEn: null, sku, basePrice: 10, status: 'ACTIVE', categoryId, description: '', descriptionEn: '',
  category: categoryId ? { id: categoryId, name: 'العناية بالبشرة' } : null,
  images: [], offers: [], analytics: { totalRemaining: 4 },
});
const FILED = row('p1', 'غسول للبشرة', 'SKIN-1', 'cat-skin');
const UNFILED = row('p2', 'محضر الطعام', 'LEG-2', null);

let asked: Array<{ url: string; method: string; body?: unknown }>;

const answer = (body: unknown) =>
  ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => body, text: async () => JSON.stringify(body) }) as any;

beforeEach(() => {
  asked = [];
  push.mockReset();
  tell.mockReset();
  ask.mockClear();
  URL.createObjectURL = vi.fn(() => 'blob:picture');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
      asked.push({ url, method, body });
      if (url.startsWith('/api/products/stats')) return { ok: false, status: 500, json: async () => ({}) } as any;
      if (url === '/api/categories' && method === 'POST') return answer({ category: { id: 'cat-new', name: 'عطور' } });
      if (url === '/api/categories') return answer({ categories: [] });
      if (method === 'POST') return answer({ product: { id: 'p-new' } });
      if (method === 'DELETE') return answer({ ok: true });
      return answer({ products: [FILED, UNFILED] });
    })
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ready = async () => {
  render(<ProductsScreen />);
  await waitFor(() => expect(screen.getAllByText('محضر الطعام').length).toBeGreaterThan(0));
};

describe('the frame', () => {
  it('draws ONE heading, the menu’s own name, with the screen’s sentence under it', async () => {
    await ready();
    const h1 = screen.getAllByRole('heading', { level: 1 });
    expect(h1).toHaveLength(1);
    expect(h1[0].textContent).toBe('المنتجات');
    expect(screen.getByText('كتالوج المنتجات مع الصور، تحليل تكاليف التصنيع متعدد التشغيلات والمخزون')).toBeTruthy();
    expect(read(FILES[0])).toContain("<PageShell title={routeLabel('/products')}");
  });

  it('keeps the header’s two presses: «إضافة منتج» opens the form, «تشغيلات الإنتاج» is still drawn', async () => {
    await ready();
    expect(screen.getByText('تشغيلات الإنتاج')).toBeTruthy();
    expect(screen.queryByText('إضافة منتج جديد')).toBeNull();
    await userEvent.setup().click(screen.getByText('إضافة منتج'));
    expect(await screen.findByText('إضافة منتج جديد')).toBeTruthy();
  });
});

describe('a row’s three presses keep their names and their work', () => {
  it('«التفاصيل والصور» goes to the product’s page', async () => {
    await ready();
    await userEvent.setup().click(screen.getAllByRole('button', { name: 'التفاصيل والصور' })[0]);
    expect(push).toHaveBeenCalledWith('/products/p1');
  });

  it('«تعديل المنتج» opens the shared dialog on THAT product', async () => {
    await ready();
    await userEvent.setup().click(screen.getAllByRole('button', { name: 'تعديل المنتج' })[1]);
    expect(await screen.findByText('تعديل المنتج: محضر الطعام')).toBeTruthy();
  });

  it('«حذف المنتج» asks first, then sends DELETE to that product’s door and reads the list again', async () => {
    await ready();
    const reads = asked.filter((a) => a.url === '/api/products' && a.method === 'GET').length;
    await userEvent.setup().click(screen.getAllByRole('button', { name: 'حذف المنتج' })[0]);
    await waitFor(() => expect(asked.some((a) => a.method === 'DELETE')).toBe(true));
    expect(ask).toHaveBeenCalledTimes(1);
    expect(asked.filter((a) => a.method === 'DELETE').map((a) => a.url)).toEqual(['/api/products/p1']);
    await waitFor(() => expect(asked.filter((a) => a.url === '/api/products' && a.method === 'GET').length).toBe(reads + 1));
  });

  it('every row has the three, each with a name a screen reader says', async () => {
    await ready();
    for (const name of ['التفاصيل والصور', 'تعديل المنتج', 'حذف المنتج']) {
      expect(screen.getAllByRole('button', { name }).length, name).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('the search and the unfiled', () => {
  it('«امسح البحث» empties the box and gives the whole list back', async () => {
    await ready();
    const user = userEvent.setup();
    const box = screen.getByPlaceholderText(/بحث بالاسم/) as HTMLInputElement;
    expect(screen.queryByRole('button', { name: 'امسح البحث' })).toBeNull();
    await user.type(box, 'غسول');
    expect(screen.queryAllByText('محضر الطعام')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'امسح البحث' }));
    expect(box.value).toBe('');
    expect(screen.getAllByText('محضر الطعام').length).toBeGreaterThan(0);
  });

  it('the «بلا تصنيف» press says it is pressed, and filters to exactly the unfiled', async () => {
    await ready();
    const user = userEvent.setup();
    const toggle = screen.getByText('1 منتجاً بلا تصنيف').closest('button') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    await user.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(toggle.textContent).toContain('أظهِر الكلّ');
    expect(screen.queryAllByText('غسول للبشرة')).toHaveLength(0);
    expect(screen.getAllByText('محضر الطعام').length).toBeGreaterThan(0);
    await user.click(toggle);
    expect(screen.getAllByText('غسول للبشرة').length).toBeGreaterThan(0);
  });
});

describe('the new-product form', () => {
  const open = async () => {
    await ready();
    const user = userEvent.setup();
    await user.click(screen.getByText('إضافة منتج'));
    await screen.findByText('إضافة منتج جديد');
    return user;
  };

  it('asks «مصدر المنتج» as two choices, one true, «نصنّعه» first — and says what the chosen one means', async () => {
    const user = await open();
    const bar = screen.getByRole('radiogroup', { name: 'مصدر المنتج *' });
    const [made, bought] = within(bar).getAllByRole('radio');
    expect(made.textContent).toBe('نصنّعه');
    expect(bought.textContent).toBe('جاهز نشتريه');
    expect(made.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('تشغيلة إنتاج ببنود كلفة — مواد، أجور، تغليف')).toBeTruthy();
    await user.click(bought);
    expect(bought.getAttribute('aria-checked')).toBe('true');
    expect(made.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('استلام بضاعة بسعر شراء للقطعة')).toBeTruthy();
  });

  it('posts the same seven fields it always posted, with the source the bar says', async () => {
    const user = await open();
    await user.click(screen.getByRole('radio', { name: 'جاهز نشتريه' }));
    await user.type(screen.getByPlaceholderText(/كريم إزالة الندبات/), 'عطر');
    await user.type(screen.getByPlaceholderText('SCAR-DE-05'), 'ATR-1');
    await user.click(screen.getByText('حفظ المنتج'));
    await waitFor(() => expect(asked.some((a) => a.url === '/api/products' && a.method === 'POST')).toBe(true));
    const post = asked.find((a) => a.url === '/api/products' && a.method === 'POST')!;
    expect(post.body).toEqual({
      name: 'عطر', sku: 'ATR-1', description: '', basePrice: '20', status: 'ACTIVE', sourceType: 'PURCHASED', categoryId: null,
    });
  });

  it('«إلغاء» closes the form and sends nothing', async () => {
    const user = await open();
    await user.click(screen.getByText('إلغاء'));
    expect(screen.queryByText('إضافة منتج جديد')).toBeNull();
    expect(asked.some((a) => a.method === 'POST')).toBe(false);
  });

  it('the pictures: «رئيسية» moves the main one, «أزل الصورة» takes one away', async () => {
    const user = await open();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, [
      new File(['a'], 'a.png', { type: 'image/png' }),
      new File(['b'], 'b.png', { type: 'image/png' }),
    ]);
    const tile = (alt: string) => screen.getByAltText(alt).parentElement as HTMLElement;
    expect(within(tile('a.png')).queryByRole('button', { name: 'رئيسية' })).toBeNull();
    await user.click(within(tile('b.png')).getByRole('button', { name: 'رئيسية' }));
    expect(within(tile('b.png')).queryByRole('button', { name: 'رئيسية' })).toBeNull();
    expect(within(tile('a.png')).getByRole('button', { name: 'رئيسية' })).toBeTruthy();
    // The SECOND picture is taken away, so a press that removed «the first» instead would be seen.
    await user.click(within(tile('b.png')).getByRole('button', { name: 'أزل الصورة' }));
    expect(screen.queryByAltText('b.png')).toBeNull();
    expect(screen.getByAltText('a.png')).toBeTruthy();
  });
});

describe('the shelf picker', () => {
  it('«جديد» opens the box, «أضف» posts the name and chooses the new shelf, «إلغاء» closes the box', async () => {
    const { CategoryPicker } = await vi.importActual<typeof import('@/components/products/CategoryPicker')>(
      '@/components/products/CategoryPicker'
    );
    const chose = vi.fn();
    render(<CategoryPicker value={null} onChange={chose} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'جديد' }));
    const add = screen.getByRole('button', { name: 'أضف' }) as HTMLButtonElement;
    expect(add.disabled, 'اسم أقصر من حرفين ما بينحفظ').toBe(true);
    await user.type(screen.getByPlaceholderText('اسم التصنيف الجديد'), 'عطور');
    await user.click(add);
    await waitFor(() => expect(chose).toHaveBeenCalledWith('cat-new'));
    const post = asked.find((a) => a.url === '/api/categories' && a.method === 'POST')!;
    expect(post.body).toEqual({ name: 'عطور' });
    await user.click(screen.getByRole('button', { name: 'جديد' }));
    await user.click(screen.getByRole('button', { name: 'إلغاء' }));
    expect(screen.queryByPlaceholderText('اسم التصنيف الجديد')).toBeNull();
  });
});

describe('the edit dialog', () => {
  it('«صفحة تفاصيل المنتج» calls the screen’s hand-off, and «إلغاء» closes without a write', async () => {
    const manage = vi.fn();
    const close = vi.fn();
    render(
      <ProductEditDialog product={FILED} open onClose={close} onSaved={() => {}} locale="ar" onManageImages={manage} />
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'صفحة تفاصيل المنتج' }));
    expect(manage).toHaveBeenCalledTimes(1);
    await user.click(screen.getByText('إلغاء'));
    expect(close).toHaveBeenCalledTimes(1);
    expect(asked.some((a) => a.method !== 'GET')).toBe(false);
  });
});

describe('what the look did not touch', () => {
  it('no raw button is left in the four files', () => {
    for (const f of FILES) expect(read(f).match(/<button\b/g) ?? [], f).toEqual([]);
  });

  it('the table’s stock and cost lines are byte for byte what they were', () => {
    const src = readFileSync(join(process.cwd(), FILES[0]), 'utf8');
    expect(src).toContain('                        {p.analytics?.totalRemaining ?? 0}');
    expect(src).toContain('                              <Money value={p.analytics?.avgCostPerUnit ?? 0} />');
    expect(src).toContain(
      "{p.analytics?.fixedCost === null && <span className=\"text-" + "xs text-[var(--sys-muted)]\">متوسط · غير ثابتة</span>}"
    );
  });

  it('nothing in the four files is fixed wider than a 375px phone less its gutters', () => {
    for (const f of FILES) {
      for (const m of read(f).matchAll(/\bw-\[(\d+)px\]/g)) expect(Number(m[1]), `${f}: ${m[0]}`).toBeLessThanOrEqual(343);
    }
  });
});
