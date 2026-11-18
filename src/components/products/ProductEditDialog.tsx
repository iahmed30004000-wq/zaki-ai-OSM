'use client';

import React, { useEffect, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Input, Select, Textarea } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { CategoryPicker } from '@/components/products/CategoryPicker';
import { ProductThumb } from '@/components/ui/ProductThumb';
import { apiJson } from '@/lib/api-client';
import { PRODUCT_STATUS_AR } from '@/lib/product-status';
import { productName } from '@/lib/product-name';
import { RiPencilLine } from '@remixicon/react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * ONE EDIT FORM, FOR THE TWO PLACES A PRODUCT IS EDITED.
 *
 * The owner, 21/10: «التعديل من داخل صفحة المنتج مش شغال».
 *
 * It was not broken. It was **not there**: the product detail page has
 * never had a form, a modal or a button for the name, the SKU, the price,
 * the status, the description or the category. Its only writes were
 * images, attributes and offers. The list page's edit modal even sends
 * people to the detail page «للتعديل والتبديل والحذف», so that is exactly
 * where they expect to edit — and the one thing they could not do there
 * was edit.
 *
 * This is that modal, lifted out of `ProductsScreen` rather than copied,
 * so the two screens cannot drift into two different ideas of what a
 * product is.
 *
 * ── AND IT GAINED THE FIELD NEITHER SCREEN HAD ──
 *
 * `sourceType` — made here, or bought ready. `PATCH /api/products/[id]`
 * has always accepted it and no screen ever sent it, so a product created
 * with the wrong type could never be corrected. It decides which door its
 * stock comes in through and whether the product page draws production
 * runs at all, so a wrong one is wrong in three places at once.
 * ═══════════════════════════════════════════════════════════════════════
 */

export interface EditableProduct {
  id: string;
  name: string;
  nameEn?: string | null;
  sku: string;
  description?: string | null;
  descriptionEn?: string | null;
  basePrice: number;
  status: string;
  categoryId?: string | null;
  sourceType?: string | null;
  images?: { url: string; isPrimary?: boolean }[];
}

export function ProductEditDialog({
  product,
  open,
  onClose,
  onSaved,
  locale,
  onManageImages,
}: {
  product: EditableProduct | null;
  open: boolean;
  onClose: () => void;
  /** Called after a successful save, so the caller reloads its own view. */
  onSaved: () => void;
  locale?: 'ar' | 'en';
  /**
   * Offered only where images are managed somewhere ELSE. The detail page
   * already has the gallery on it, so it passes nothing and the row is
   * not drawn — a link to the page you are standing on is furniture.
   */
  onManageImages?: () => void;
}) {
  const [form, setForm] = useState({
    name: '', nameEn: '', sku: '', description: '', descriptionEn: '',
    basePrice: '', status: 'ACTIVE', categoryId: null as string | null,
    sourceType: 'MANUFACTURED',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-read whenever a different product is opened, so the form is never
  // the previous one's values under this one's title.
  useEffect(() => {
    if (!product) return;
    setForm({
      name: product.name || '',
      nameEn: product.nameEn || '',
      sku: product.sku || '',
      description: product.description || '',
      descriptionEn: product.descriptionEn || '',
      /*
       * The stored number, whatever it is. `|| 0` here was one of this
       * repository's vacuous fallbacks: the column is NOT NULL with a
       * default, so the only falsy value it can hold is a real zero,
       * which the fallback replaced with zero.
       */
      basePrice: String(product.basePrice),
      status: product.status || 'ACTIVE',
      categoryId: product.categoryId ?? null,
      /*
       * Null reads as «made». That is what the rest of the product does
       * with it — the stock door and the manufacturing picker both treat
       * a null `sourceType` as MANUFACTURED — so the form agrees with
       * them rather than inventing a third reading.
       */
      sourceType: product.sourceType || 'MANUFACTURED',
    });
    setError(null);
  }, [product]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!product) return;
    setSaving(true);
    setError(null);
    try {
      await apiJson(`/api/products/${product.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      onClose();
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذّر الحفظ');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title={`تعديل المنتج: ${product ? productName(product, locale ?? 'ar') : ''}`}
      subtitle="الاسم والرمز والسعر والحالة والفئة والنوع"
      maxWidth="xl"
    >
      <form onSubmit={save} className="space-y-4">
        {error && (
          <div className="p-3 bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] text-[var(--sys-destructive)] text-sm rounded-lg">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Input label="الاسم بالعربية *" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          <Input label="الاسم بالإنجليزية" placeholder="English name" dir="ltr" value={form.nameEn} onChange={(e) => setForm({ ...form, nameEn: e.target.value })} />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Input label="رمز SKU *" value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value.toUpperCase() })} required />
          <Input label="السعر الأساسي" type="number" step="0.01" value={form.basePrice} onChange={(e) => setForm({ ...form, basePrice: e.target.value })} />
          <Select label="الحالة" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
            <option value="ACTIVE">{PRODUCT_STATUS_AR.ACTIVE}</option>
            <option value="INACTIVE">{PRODUCT_STATUS_AR.INACTIVE}</option>
            <option value="OUT_OF_STOCK">{PRODUCT_STATUS_AR.OUT_OF_STOCK}</option>
          </Select>
        </div>

        <Select
          label="نوع المنتج"
          value={form.sourceType}
          onChange={(e) => setForm({ ...form, sourceType: e.target.value })}
        >
          <option value="MANUFACTURED">مصنّع — كلفته من تشغيلة إنتاج</option>
          <option value="PURCHASED">جاهز — كلفته من استلام بضاعة</option>
        </Select>

        <CategoryPicker value={form.categoryId} onChange={(categoryId) => setForm({ ...form, categoryId })} />
        <Textarea label="الوصف بالعربية" rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        <Textarea label="الوصف بالإنجليزية" rows={2} dir="ltr" value={form.descriptionEn} onChange={(e) => setForm({ ...form, descriptionEn: e.target.value })} />

        {product && onManageImages && (
          <Card plain padding="sm" className="flex items-center gap-3">
            <ProductThumb src={product.images?.find((i) => i.isPrimary)?.url || product.images?.[0]?.url} size="md" />
            <div className="text-note text-[var(--sys-primary)]">
              <p className="font-bold">إدارة الصور</p>
              <p>
                {product.images?.length || 0} صورة — للتعديل والتبديل والحذف افتح{' '}
                <Button type="button" variant="quiet" size="sm" onClick={onManageImages} className="underline">
                  صفحة تفاصيل المنتج
                </Button>
              </p>
            </div>
          </Card>
        )}

        <div className="flex justify-end space-x-2 rtl:space-x-reverse pt-1">
          <Button type="button" variant="secondary" onClick={onClose}>
            إلغاء
          </Button>
          <Button type="submit" loading={saving}>
            <RiPencilLine className="w-4 h-4" />
            حفظ التعديلات
          </Button>
        </div>
      </form>
    </Modal>
  );
}
