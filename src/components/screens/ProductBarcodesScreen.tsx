'use client';

import React, { useCallback, useMemo, useState } from 'react';
import { PageShell } from '@/components/ui/PageShell';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { useCan } from '@/hooks/useCan';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { apiJson } from '@/lib/api-client';
import { copyText } from '@/lib/clipboard';
import { routeLabel } from '@/lib/route-registry';
import { productVerifyLink } from '@/lib/product-verify-design';
import { ProductVerifyEditor, type PageRow, type ProductRow } from '@/components/settings/ProductVerifyEditor';
import { RiFileCopyLine, RiPencilLine, RiSearchLine } from '@remixicon/react';

/**
 * «باركود المنتجات» — EACH PRODUCT ITS OWN BARCODE AND ITS OWN PAGE (25/11, the owner: «لكل منتج باركود خاص فيه
 * وصفحة خاصة فيه»), right beside «رموز الأصالة» in «الإدارة».
 *
 * A list of the company's products, each with the state of its page (none · on · off). «صمّم الصفحة» opens the editor
 * with the page itself beside it (`ProductVerifyEditor`). The product's barcode is a QR of its short link `/v/<slug>`;
 * the piece codes of «رموز الأصالة» are what that page checks — a code tagged to this product, or to none.
 *
 * Reads on `settings.view`; every write asks `settings.edit` (`useCan` decides only what is drawn — the API decides).
 */
export function ProductBarcodesScreen() {
  const toast = useToast();
  const canEdit = useCan('settings.edit');
  const [products, setProducts] = useState<ProductRow[] | null>(null);
  const [pages, setPages] = useState<PageRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await apiJson<{ products: ProductRow[]; pages: PageRow[] }>('/api/settings/product-verify-pages');
      setProducts(d.products ?? []);
      setPages(d.pages ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر التحميل');
    }
  }, []);
  // While the editor is open the list is not refreshed under it: a poll would reset a half-typed form.
  useLiveRefresh(load, { enabled: !open });

  const byProduct = useMemo(() => new Map(pages.map((p) => [p.productId, p])), [pages]);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    const list = products ?? [];
    return s ? list.filter((p) => `${p.name} ${p.nameEn ?? ''} ${p.sku}`.toLowerCase().includes(s)) : list;
  }, [products, q]);

  const product = open ? (products ?? []).find((p) => p.id === open) : undefined;

  const copy = async (slug: string) => {
    const link = productVerifyLink(window.location.origin, slug);
    if (await copyText(link)) toast.done('تم نسخ الرابط');
    else toast.failed('تعذر النسخ — الرابط: ' + link);
  };

  return (
    <PageShell
      title={routeLabel('/settings/product-barcodes')}
      description="لكل منتج باركود خاص فيه وصفحة تحقق بتصمّمها إنت — والقطعة بتنفحص برمزها عليها."
      width={product ? 'full' : 'medium'}
    >
      {product ? (
        <ProductVerifyEditor
          key={`${product.id}:${byProduct.get(product.id)?.id ?? 'new'}`}
          product={product}
          page={byProduct.get(product.id) ?? null}
          canEdit={canEdit}
          onBack={() => setOpen(null)}
          onSaved={(saved) => setPages((list) => [saved, ...list.filter((p) => p.id !== saved.id)])}
          onDeleted={() => {
            setPages((list) => list.filter((p) => p.productId !== product.id));
            setOpen(null);
          }}
        />
      ) : (
        <div className="space-y-4" dir="rtl">
          {error && <p className="text-sm text-[var(--sys-destructive)]">{error}</p>}
          <label className="flex items-center gap-2 rounded-lg border border-[var(--sys-border-input)] px-3">
            <RiSearchLine className="h-4 w-4 text-[var(--sys-muted-foreground)]" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="دوّر على منتج بالاسم أو الرمز"
              aria-label="بحث عن منتج"
              className="h-11 md:h-10 flex-1 text-sm"
              style={{ border: 0, outline: 'none', background: 'transparent', minWidth: 0 }}
            />
          </label>

          {products && shown.length === 0 && (
            <p className="rounded-lg border border-[var(--sys-border)] p-3 text-note text-[var(--sys-muted-foreground)]">
              {products.length === 0 ? 'ما في منتجات بعد.' : 'ما في منتج بهالاسم.'}
            </p>
          )}

          <div className="space-y-2">
            {shown.map((p) => {
              const page = byProduct.get(p.id);
              return (
                <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--sys-border)] p-2.5 text-note">
                  <div className="flex items-center gap-3" style={{ minWidth: 0, flex: '1 1 14rem' }}>
                    {p.image ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={p.image} alt="" style={{ width: 44, height: 44, borderRadius: 10, objectFit: 'cover', flex: 'none' }} />
                    ) : (
                      <span style={{ width: 44, height: 44, borderRadius: 10, flex: 'none', background: 'var(--sys-surface)' }} />
                    )}
                    <div className="flex flex-col gap-0.5" style={{ minWidth: 0 }}>
                      <span className="font-semibold text-[var(--sys-foreground)]">{p.name}</span>
                      <span className="text-[var(--sys-muted-foreground)]">
                        {page ? (
                          <>
                            {page.active ? 'الصفحة شغالة' : 'الصفحة موقوفة'} · <span dir="ltr">/v/{page.slug}</span>
                          </>
                        ) : (
                          'بلا صفحة بعد'
                        )}
                      </span>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {page && (
                      <Button variant="quiet" size="sm" onClick={() => void copy(page.slug)}>
                        <RiFileCopyLine className="h-4 w-4" /> نسخ الرابط
                      </Button>
                    )}
                    <Button variant={page ? 'quiet' : 'primary'} size="sm" onClick={() => setOpen(p.id)}>
                      <RiPencilLine className="h-4 w-4" /> صمّم الصفحة
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </PageShell>
  );
}
