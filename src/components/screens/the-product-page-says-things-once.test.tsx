// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React, { useEffect } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@/lib/guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE PRODUCT PAGE — «حسيت في اشياء مكررة + اشياء مش شغالة».
 *
 * The owner, 21/10, on the page of «طاقية إنبات الشعر» (no pictures, three offers):
 *
 *   · the average cost of a unit was drawn THREE times — in the headline, in the description card, in the stock card;
 *   · «0 صورة» in the header and an empty gallery under it were one fact written twice, and «رفع صور جديدة» at the top
 *     sat apart from the gallery that said «ارفع الصورة الرئيسية» in words;
 *   · the pictures' own buttons (main, move, delete) live on the THUMBNAILS, which were drawn only for a second picture — so
 *     a product with exactly one picture could not delete it;
 *   · every action ended in a reload that swapped the whole page for a spinner: the scroll position was lost and every
 *     card below was unmounted and asked its door again.
 *
 * The cards that were blank (أداء المبيعات, أحدث الطلبات) have their own tests; what is held here is the page around them.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { fetchMock, confirmAnswer, mounts } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  confirmAnswer: { value: true },
  mounts: { stock: 0 },
}));

vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'p-1' }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
// A company admin who HOLDS the box: the screen asks the server's question (`userCan`), and the server lets no role
// through by name — only SUPER_ADMIN holds everything.
const as = vi.hoisted(() => ({ user: { value: { id: 'u1', role: 'COMPANY_ADMIN', permissions: ['products.view', 'products.edit', 'products.upload_images', 'insights.view'] as string[] } } }));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ currentUser: as.user.value, locale: 'ar', t: {} }) }));
vi.mock('@/components/ui/Confirm', () => ({
  useConfirm: () => async () => confirmAnswer.value,
  useTell: () => vi.fn(),
}));
// The cards beside the gallery have their own tests; here they are markers that say whether they were mounted.
vi.mock('@/components/products/ProductHeadline', () => ({ ProductHeadline: () => <div data-testid="headline" /> }));
const stockProps = vi.hoisted(() => ({ value: null as null | { canReceive: boolean; canProduce: boolean } }));
vi.mock('@/components/products/ProductStock', () => ({
  ProductStock: (p: { canReceive: boolean; canProduce: boolean }) => {
    stockProps.value = { canReceive: p.canReceive, canProduce: p.canProduce };
    useEffect(() => {
      mounts.stock += 1;
    }, []);
    return <div data-testid="stock" />;
  },
}));
vi.mock('@/components/products/ProductAttributes', () => ({ ProductAttributes: () => <div data-testid="attributes" /> }));
vi.mock('@/components/products/ProductOffers', () => ({ ProductOffers: () => <div data-testid="offers" /> }));
vi.mock('@/components/products/ProductPerformance', () => ({
  ProductPerformance: ({ productId }: { productId: string }) => <div data-testid="performance" data-product={productId} />,
}));
vi.mock('@/components/products/ProductRecentOrders', () => ({
  ProductRecentOrders: ({ productId }: { productId: string }) => <div data-testid="recent-orders" data-product={productId} />,
}));
vi.mock('@/components/products/ProductEditDialog', () => ({ ProductEditDialog: () => null }));

import { ProductDetailScreen } from './ProductDetailScreen';

const image = (n: number, over: Record<string, unknown> = {}) => ({ id: `img${n}`, url: `/uploads/${n}.jpg`, isPrimary: n === 1, altText: null, ...over });
const productWith = (images: unknown[], over: Record<string, unknown> = {}) => ({
  id: 'p-1',
  name: 'طاقية إنبات الشعر',
  sku: 'LEG-23',
  status: 'ACTIVE',
  sourceType: 'PURCHASED',
  description: 'وصف',
  basePrice: 25,
  images,
  batches: [],
  ...over,
});

let current: ReturnType<typeof productWith>;
const respond = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => body });

beforeEach(() => {
  vi.clearAllMocks();
  mounts.stock = 0;
  confirmAnswer.value = true;
  as.user.value = { id: 'u1', role: 'COMPANY_ADMIN', permissions: ['products.view', 'products.edit', 'products.upload_images', 'insights.view'] };
  current = productWith([]);
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'DELETE' || init?.method === 'PATCH' || init?.method === 'POST') return respond({ ok: true });
    return respond({ product: current, currencyCode: 'JOD', analytics: { totalProduced: 0, totalSold: 0, totalRemaining: 0, avgCostPerUnit: 3.5 } });
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const draw = async () => {
  render(<ProductDetailScreen />);
  await screen.findByText('طاقية إنبات الشعر');
};

describe('one figure, said once', () => {
  it('— the average cost of a unit is NOT in this page’s own cards: it is in the headline above and the stock card below, nowhere between', async () => {
    await draw();
    expect(document.body.textContent).not.toContain('متوسط تكلفة الوحدة');
    expect(document.body.textContent).not.toContain('متوسط كلفة الوحدة');
    // …and what is left of that card is the description and the base price.
    expect(screen.getByText('السعر الأساسي')).toBeTruthy();
  });

  it('and the picture count is said once — in the gallery’s own heading — and not as «N صورة» beside the name', async () => {
    current = productWith([image(1), image(2), image(3)]);
    await draw();
    const hits = screen.getAllByText(/3 صورة/);
    expect(hits).toHaveLength(1);
    expect(hits[0].closest('div')?.textContent).toContain('معرض صور المنتج');
    // With none, the heading says so in a word instead of drawing «0 صورة» over an empty box.
    cleanup();
    current = productWith([]);
    await draw();
    expect(document.body.textContent).not.toContain('0 صورة');
    expect(screen.getByText('لا صور بعد')).toBeTruthy();
  });

  it('and there is ONE door for pictures: one file input, one «رفع صور», and no «رفع صور جديدة» at the top', async () => {
    await draw();
    expect(document.querySelectorAll('input[type="file"]')).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'رفع صور' })).toHaveLength(1);
    expect(screen.queryByText('رفع صور جديدة')).toBeNull();
    // and that one is in the gallery's heading, not in the page's
    const gallery = screen.getByText('معرض صور المنتج').closest('div')!.parentElement!;
    expect(within(gallery).getByRole('button', { name: 'رفع صور' })).toBeTruthy();
  });
});

describe('the gallery', () => {
  it('— with no picture the big box IS the upload: it says so, and pressing it opens the file chooser', async () => {
    const open = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => undefined);
    await draw();
    const box = screen.getByRole('button', { name: 'ارفع الصورة الرئيسية' });
    expect(box.textContent).toContain('اضغط هنا لرفع الصورة الرئيسية');
    fireEvent.click(box);
    expect(open).toHaveBeenCalledTimes(1);
    open.mockRestore();
  });

  it('and for somebody who may not edit it is only a statement: no upload box, no button, no file input', async () => {
    as.user.value = { id: 'u2', role: 'MODERATOR', permissions: ['products.view'] };
    await draw();
    expect(screen.getByText('لا توجد صور')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'ارفع الصورة الرئيسية' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'رفع صور' })).toBeNull();
    expect(document.querySelectorAll('input[type="file"]')).toHaveLength(0);
    // The box is only a statement for them: disabled, and named for what it says.
    expect((screen.getByRole('button', { name: 'لا توجد صور' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('and with exactly ONE picture there are thumbnails — so there is a way to delete it, and to see that it is the main one', async () => {
    current = productWith([image(1)]);
    await draw();
    expect(screen.getByRole('button', { name: 'كبّر الصورة 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'حذف' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'تعيين كرئيسية' })).toBeTruthy();
  });
});

describe('an action does not take the page away', () => {
  it('— deleting a picture reloads the product UNDER the page: no spinner, and no card below is unmounted and mounted again', async () => {
    current = productWith([image(1), image(2)]);
    await draw();
    // `mounts.stock` is counted in a mount EFFECT, and effects are flushed after the paint: `draw()` has seen the name, not
    // necessarily the effect (RV157/RV93 — it read 0 under a loaded machine). Waited for, not assumed.
    await waitFor(() => expect(mounts.stock).toBe(1));
    const reads = () => fetchMock.mock.calls.filter((c) => !(c[1] as RequestInit | undefined)?.method).length;
    const before = reads();

    // The reload is HELD in the air: with an answer that arrives at once, React batches «loading» and «loaded» into one
    // render and the intermediate page is never drawn — which is how the first version of this claim passed a page that
    // flashed a spinner. So the second read does not return until the claim has looked at the page.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method) return respond({ ok: true });
      await held;
      return respond({ product: current, currencyCode: 'JOD' });
    });

    current = productWith([image(1)]);
    fireEvent.click(screen.getAllByRole('button', { name: 'حذف' })[0]);
    await waitFor(() => expect(reads()).toBeGreaterThan(before));

    // WHILE THE RELOAD IS IN THE AIR the page is still here.
    expect(document.querySelector('.animate-spin'), 'عاد الدوّارُ يحلُّ محلَّ الصفحة').toBeNull();
    expect(screen.getByText('طاقية إنبات الشعر')).toBeTruthy();
    expect(screen.getByTestId('stock'), 'الكرتُ تحتَ المعرضِ اختفى والقراءةُ لم تنتهِ').toBeTruthy();

    release();
    await waitFor(() => expect(screen.queryByText('كبّر الصورة 2')).toBeNull());
    // Let every pending effect run first: «still one mount» must be read AFTER the page has had its chance to remount, not before.
    await act(async () => {});
    expect(mounts.stock, 'الكرتُ تحتَ المعرضِ اندثر وانبنى من جديد').toBe(1);
    expect(document.querySelector('.animate-spin')).toBeNull();
  });

  it('and the FIRST read still shows the spinner — there is nothing yet to keep', () => {
    fetchMock.mockImplementation(() => new Promise(() => undefined));
    render(<ProductDetailScreen />);
    expect(document.querySelector('.animate-spin')).toBeTruthy();
  });
});

describe('the cards that were blank are on the page, for THIS product', () => {
  it('— the performance card and the latest orders are mounted with the page’s own product id', async () => {
    await draw();
    expect(screen.getByTestId('performance').getAttribute('data-product')).toBe('p-1');
    expect(screen.getByTestId('recent-orders').getAttribute('data-product')).toBe('p-1');
  });

  it('PR-10: the performance card is a smart card — not mounted (so not fetched) without insights.view, while the orders stay', async () => {
    as.user.value = { id: 'u7', role: 'MODERATOR', permissions: ['products.view'] };
    await draw();
    expect(screen.queryByTestId('performance')).toBeNull();
    expect(screen.getByTestId('recent-orders').getAttribute('data-product')).toBe('p-1');
  });

  it('and the screen reads neither `analytics` nor `product.orders` any more — the two keys the door never sent', () => {
    const src = stripComments(readFileSync(join(process.cwd(), 'src/components/screens/ProductDetailScreen.tsx'), 'utf8'));
    expect(src).not.toMatch(/analytics/);
    expect(src).not.toMatch(/product\.orders/);
    expect(src).not.toContain('متوسط تكلفة الوحدة');
    expect(src).not.toMatch(/رفع صور جديدة/);
  });
});

/*
 * «في صلاحيات ظاهرة انها منسوبة لكن بالواقع مش موجودة». Each control asks the key its own server route checks — no
 * role is let through by name. The pictures are `products.upload_images` (api/products/[id]/images); the stock
 * shortcut lands on /inventory/balances or /manufacturing, guarded by inventory and production keys.
 */
describe('each control asks the server’s own question', () => {
  it('the pictures follow «رفع صور المنتجات», not «تعديل المنتجات»', async () => {
    as.user.value = { id: 'u3', role: 'COMPANY_ADMIN', permissions: ['products.view', 'products.upload_images'] };
    await draw();
    expect(screen.getByRole('button', { name: 'رفع صور' })).toBeTruthy();
  });

  it('NEGATIVE: editing the product without the pictures box shows no upload', async () => {
    as.user.value = { id: 'u4', role: 'COMPANY_ADMIN', permissions: ['products.view', 'products.edit'] };
    await draw();
    expect(screen.queryByRole('button', { name: 'رفع صور' })).toBeNull();
    expect(document.querySelectorAll('input[type="file"]')).toHaveLength(0);
  });

  it('the stock shortcut follows the stock and production keys', async () => {
    as.user.value = { id: 'u5', role: 'MANAGER', permissions: ['products.view', 'inventory.view', 'inventory.adjust'] };
    await draw();
    expect(stockProps.value).toEqual({ canReceive: true, canProduce: false });
  });

  it('NEGATIVE: «تعديل المنتجات» alone opens neither stock door', async () => {
    as.user.value = { id: 'u6', role: 'COMPANY_ADMIN', permissions: ['products.view', 'products.edit'] };
    await draw();
    expect(stockProps.value).toEqual({ canReceive: false, canProduce: false });
  });
});
