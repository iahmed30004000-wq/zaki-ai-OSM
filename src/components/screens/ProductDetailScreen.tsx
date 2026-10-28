'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useParams } from 'next/navigation';
import { Card, CardHeader, CardContent } from '@/components/ui/Card';
import { useConfirm, useTell } from '@/components/ui/Confirm';
import { Button } from '@/components/ui/Button';
import { ProductThumb } from '@/components/ui/ProductThumb';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { useApp } from '@/context/AppContext';
import { arDate } from '@/lib/format';
import Link from 'next/link';
import { ProductOffers } from '@/components/products/ProductOffers';
import { ProductStock } from '@/components/products/ProductStock';
import { ProductAttributes } from '@/components/products/ProductAttributes';
import { ProductHeadline } from '@/components/products/ProductHeadline';
import { ProductPerformance } from '@/components/products/ProductPerformance';
import { ProductRecentOrders } from '@/components/products/ProductRecentOrders';
import { RiArrowDownSLine, RiArrowRightLine, RiArrowUpSLine, RiBuilding4Line, RiDeleteBinLine, RiImageAddLine, RiStarLine, RiPencilLine } from '@remixicon/react';
import { Money } from '@/components/ui/Money';
import { Rows } from '@/components/ui/Rows';
import { EmptyState } from '@/components/ui/EmptyState';
import { productStatusAr, productStatusTone } from '@/lib/product-status';
import { ProductEditDialog } from '@/components/products/ProductEditDialog';
import { userCan } from '@/lib/can';

export function ProductDetailScreen() {
  const params = useParams();
  const productId = params?.id as string;
  const { currentUser } = useApp();
  const canManage = userCan(currentUser, 'products.edit');
  // Each control asks the key its own server route checks: the pictures are `products.upload_images`
  // (api/products/[id]/images), and the stock shortcut lands on screens guarded by inventory and production keys.
  const canImages = userCan(currentUser, 'products.upload_images');
  const canReceiveStock = userCan(currentUser, 'inventory.view') && userCan(currentUser, 'inventory.adjust');
  const canProduce = userCan(currentUser, 'production.view') && userCan(currentUser, 'production.manage');

  const ask = useConfirm();
  const tell = useTell();

  const [product, setProduct] = useState<any>(null);
  const [currencyCode, setCurrencyCode] = useState('USD');
  const [editOpen, setEditOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [uploading, setUploading] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** Whether a first answer has been drawn: after it, a reload happens UNDER the page instead of replacing it. */
  const drawn = useRef(false);

  /*
   * A RELOAD DOES NOT TAKE THE PAGE AWAY.
   *
   * Every action here — an upload, a deleted picture, a new main picture, a saved edit — ends in `loadProduct()`, and it
   * began with `setLoading(true)`, which swaps the whole page for a spinner: the height collapses, the scroll position is
   * lost, and every card below the gallery (stock, offers, attributes, orders) is unmounted and asks its own door again.
   * Deleting a picture jumped you to the top of the page and re-read everything. Only the FIRST read shows the spinner.
   */
  const loadProduct = async () => {
    if (!drawn.current) setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/products/${productId}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setProduct(data.product);
      setCurrencyCode(data.currencyCode || 'USD');
      drawn.current = true;
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (productId) loadProduct();
  }, [productId]);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    setUploading(true);
    try {
      const formData = new FormData();
      files.forEach((f) => formData.append('files', f));
      formData.append('isPrimary', product.images?.length === 0 ? 'true' : 'false');
      const res = await fetch(`/api/products/${productId}/images`, {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error);
      }
      await loadProduct();
    } catch (err: any) {
      void tell({ title: 'تعذر رفع الصورة', body: err.message, tone: 'danger' });
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const setPrimary = async (imageId: string) => {
    await fetch(`/api/products/${productId}/images`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'setPrimary', imageId }),
    });
    loadProduct();
  };

  const deleteImage = async (imageId: string) => {
    if (!(await ask({ title: 'حذف هذه الصورة نهائياً؟', tone: 'danger' }))) return;
    await fetch(`/api/products/${productId}/images/${imageId}`, { method: 'DELETE' });
    loadProduct();
  };

  const moveImage = async (index: number, dir: -1 | 1) => {
    const images = [...product.images];
    const target = index + dir;
    if (target < 0 || target >= images.length) return;
    [images[index], images[target]] = [images[target], images[index]];
    await fetch(`/api/products/${productId}/images`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reorder', order: images.map((i: any) => i.id) }),
    });
    loadProduct();
  };

  if (loading) {
    return (
      <>
        <div className="flex justify-center py-24">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--sys-primary)]"></div>
        </div>
      </>
    );
  }

  if (error || !product) {
    return (
      <>
        <div className="p-6 bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] text-[var(--sys-destructive)] text-sm rounded-lg text-center">
          {error || 'المنتج غير موجود'}
        </div>
      </>
    );
  }

  const images = product.images || [];
  const primary = images.find((i: any) => i.isPrimary) || images[0];

  return (
    <>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <button
              onClick={() => window.history.back()}
              className="text-xs text-[var(--sys-muted-foreground)] hover:text-[var(--sys-destructive)] flex items-center space-x-1 rtl:space-x-reverse mb-1.5 cursor-pointer"
            >
              <RiArrowRightLine className="icon-mirror w-4 h-4" />
              <span>عودة للمنتجات</span>
            </button>
            <h1 className="text-xl font-bold text-[var(--sys-heading)]">{product.name}</h1>
            <div className="flex items-center space-x-2 rtl:space-x-reverse mt-1.5">
              <span className="font-mono text-xs font-bold text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] px-2 py-0.5 rounded-lg">{product.sku}</span>
              <Badge variant={productStatusTone(product.status)}>{productStatusAr(product.status)}</Badge>
              {/* The picture count is said once, in the gallery's own heading — «0 صورة» up here and an empty gallery
                  under it were one fact written twice. */}
            </div>
            {/* The two numbers this page is opened for. They are also in
                the panel far below, from the same endpoint — see
                ProductHeadline for why they are up here as well. */}
            <div className="mt-3">
              <ProductHeadline productId={productId} />
            </div>
          </div>

          {canManage && (
            <div className="flex items-center gap-2">
              {/*
                ── THE BUTTON THIS PAGE NEVER HAD ──

                «التعديل من داخل صفحة المنتج مش شغال» — it was not broken,
                it was absent. The page could change images, attributes
                and offers, and nothing else: not the name, the SKU, the
                price, the status, the category or the type. The list's
                own edit modal sends people HERE «للتعديل والتبديل
                والحذف», so this is where they looked.
              */}
              <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>
                <RiPencilLine className="w-4 h-4 ml-1.5 rtl:ml-0 rtl:mr-1.5" />
                تعديل المنتج
              </Button>
              {/* «رفع صور جديدة» was here AND the gallery asked for the main picture in words: one door for pictures,
                  and it is the gallery's own (the button in its heading, and the empty gallery itself). */}
            </div>
          )}

          {/* The shared form — the same one the list opens, so the two
              screens cannot disagree about what a product is. */}
          <ProductEditDialog
            product={product}
            open={editOpen}
            onClose={() => setEditOpen(false)}
            onSaved={loadProduct}
          />
        </div>

        {/* Gallery + Info */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Gallery */}
          <Card className="lg:col-span-2">
            <CardHeader
              title="معرض صور المنتج"
              subtitle={
                images.length > 0
                  ? `${images.length} صورة — الصورة الرئيسية كبيرة + صور إضافية — اضغط للتكبير`
                  : 'لا صور بعد'
              }
              action={
                canImages && (
                  <>
                    <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={handleUpload} className="hidden" />
                    <Button size="sm" onClick={() => fileInputRef.current?.click()} loading={uploading} className="bg-[var(--sys-destructive)] hover:bg-[var(--sys-destructive)]/85">
                      <RiImageAddLine className="w-4 h-4 ml-1.5 rtl:ml-0 rtl:mr-1.5" />
                      رفع صور
                    </Button>
                  </>
                )
              }
            />
            <CardContent className="space-y-4">
              {/* Primary large */}
              {/*
                  THE HEADER SAYS «اضغط للتكبير», SO IT HAS TO BE PRESSABLE.
                  This was a <div onClick>: no keyboard could reach it, a
                  screen reader announced nothing, and `system.css` gives its
                  0.97 sink to buttons — so the one control the subtitle names
                  was the one control that did not answer a press.
              */}
              {/*
                  AND WITH NO PICTURE THE BIG BOX IS THE UPLOAD: it said «ارفع الصورة الرئيسية» in words and offered
                  nothing to press, while «رفع صور جديدة» sat in another part of the page. Both of them were one request.
              */}
              <button
                type="button"
                disabled={!primary && !canImages}
                aria-label={primary ? 'كبّر الصورة الرئيسية' : canImages ? 'ارفع الصورة الرئيسية' : 'لا توجد صور'}
                className={`relative block w-full h-72 bg-[var(--sys-surface)] rounded-lg overflow-hidden border border-[var(--sys-border)] disabled:cursor-default ${
                  primary ? 'cursor-zoom-in' : 'cursor-pointer'
                }`}
                onClick={() => (primary ? setLightbox(primary.url) : fileInputRef.current?.click())}
              >
                {primary ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={primary.url} alt={primary.altText || product.name} className="w-full h-full object-contain" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-[var(--sys-muted-foreground)] text-sm">
                    {canImages ? 'لا توجد صور — اضغط هنا لرفع الصورة الرئيسية' : 'لا توجد صور'}
                  </div>
                )}
                {primary && (
                  <span className="absolute top-3 left-3 rtl:left-auto rtl:right-3 bg-[var(--sys-destructive)] text-[var(--sys-primary-foreground)] text-xs font-bold px-2 py-1 rounded-lg flex items-center space-x-1 rtl:space-x-reverse">
                    <RiStarLine className="w-4 h-4" />
                    <span>الصورة الرئيسية</span>
                  </span>
                )}
              </button>

              {/*
                  Thumbnails — FROM THE FIRST PICTURE ON. They were drawn only for a SECOND picture, and the buttons to
                  make a picture the main one, move it or delete it live on the thumbnails: so a product with exactly one
                  picture had no way to delete it or to put another in front of it.
              */}
              {images.length > 0 && (
                <div className="grid grid-cols-4 sm:grid-cols-6 gap-2">
                  {images.map((img: any, idx: number) => (
                    <div
                      key={img.id}
                      className={`relative group rounded-lg overflow-hidden border-2 ${
                        img.isPrimary ? 'border-[var(--sys-primary)]' : 'border-[var(--sys-border)]'
                      }`}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      {/* The button wraps the image; the hover overlay below is
                          its SIBLING, so no button ends up inside a button. */}
                      <button
                        type="button"
                        onClick={() => setLightbox(img.url)}
                        aria-label={`كبّر الصورة ${idx + 1}`}
                        className="block w-full cursor-zoom-in"
                      >
                        <img
                          src={img.url}
                          alt={img.altText || product.name}
                          className="w-full h-16 object-cover"
                        />
                      </button>
                      {canImages && (
                        <div className="absolute inset-0 bg-[var(--sys-sidebar)]/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center space-x-1 rtl:space-x-reverse">
                          <button onClick={() => setPrimary(img.id)} aria-label="تعيين كرئيسية" title="تعيين كرئيسية" className="min-h-11 min-w-11 md:min-h-0 md:min-w-0 p-1 bg-[var(--sys-card)]/90 rounded-lg text-[var(--sys-warning)] hover:bg-[var(--sys-card)] cursor-pointer">
                            <RiStarLine className="w-4 h-4" />
                          </button>
                          {idx > 0 && !img.isPrimary && (
                            <button onClick={() => moveImage(idx, -1)} aria-label="تحريك يسار" title="تحريك يسار" className="min-h-11 min-w-11 md:min-h-0 md:min-w-0 p-1 bg-[var(--sys-card)]/90 rounded-lg text-[var(--sys-foreground)] hover:bg-[var(--sys-card)] cursor-pointer">
                              <RiArrowUpSLine className="w-4 h-4 rotate-[-90deg] rtl:rotate-[270deg]" />
                            </button>
                          )}
                          {idx < images.length - 1 && !img.isPrimary && (
                            <button onClick={() => moveImage(idx, 1)} aria-label="تحريك يمين" title="تحريك يمين" className="min-h-11 min-w-11 md:min-h-0 md:min-w-0 p-1 bg-[var(--sys-card)]/90 rounded-lg text-[var(--sys-foreground)] hover:bg-[var(--sys-card)] cursor-pointer">
                              <RiArrowDownSLine className="w-4 h-4 rotate-[-90deg] rtl:rotate-[270deg]" />
                            </button>
                          )}
                          <button onClick={() => deleteImage(img.id)} aria-label="حذف" title="حذف" className="min-h-11 min-w-11 md:min-h-0 md:min-w-0 p-1 bg-[var(--sys-card)]/90 rounded-lg text-[var(--sys-destructive)] hover:bg-[var(--sys-card)] cursor-pointer">
                            <RiDeleteBinLine className="w-4 h-4" />
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Info + Performance */}
          <div className="space-y-6">
            <Card>
              {/*
                ── «معلومات المنتج وبيانات» = THE WORDS, THEN THE NUMBERS ──

                The owner, 21/10: «معلومات المنتج وبيانات = معلومات المنتج
                + المخزون و التكلفة».

                The words — the description and the base price — stay
                here, because they are what a person reads first. The
                NUMBERS are one card, and it is the stock card below,
                which is now headed «معلومات المنتج وبياناته» and already
                holds on-hand, reserved, available, the weighted average
                cost, the next-out cost and the stock value, all from one
                server-side source.

                They were three cards before: these words, a broken
                «المخزون» that read a key the door never sent, and the
                real one. Two of the three said the same thing and one of
                them said nothing.
              */}
              <CardHeader title="وصف المنتج وسعره" />
              <CardContent className="text-xs space-y-2">
                <p className="text-[var(--sys-foreground)]">{product.description || '—'}</p>
                {/* The base price, alone: «متوسط تكلفة الوحدة» was here as well as in the headline above and in the
                    stock card below — three copies of one figure in three spellings («كلفة» / «تكلفة»). */}
                <div className="pt-2 border-t border-[var(--sys-border)] grid grid-cols-1 gap-2 text-center">
                  <div className="bg-[var(--sys-surface)] p-2 rounded-lg">
                    <span className="text-[var(--sys-muted)] block">السعر الأساسي</span>
                    <Money value={product.basePrice} className="font-bold text-[var(--sys-heading)]" />
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* What it sold — from the server's own count (see ProductPerformance for why the old card was blank). */}
            <ProductPerformance productId={productId} />

            {/*
              ── «المخزون» WAS HERE, TWICE OVER ──

              The owner, 21/10: «المخزون اللي فوق شيله لأنّه في واحد تحت».

              He was right twice. This card duplicated «المخزون والتكلفة»
              below it — and it was the BROKEN copy: it read
              `analytics.totalProduced/Sold/Remaining`, which this screen
              asked for and the door never sent, so its three numbers were
              blank on every product that ever existed.

              The card below is the real one: it reads
              `/api/products/[id]/stock`, where on-hand, reserved,
              available and the weighted average cost are computed on the
              SERVER from one source.
            */}
          </div>
        </div>

        {/*
          ── A BOUGHT PRODUCT HAS NO PRODUCTION RUNS ──

          The owner, 21/10: «تشغيلات الإنتاج مش لازم تكون داخل صفحة
          المنتج الجاهز، والعكس صحيح».

          This card was drawn for EVERY product, with no check at all. On
          a PURCHASED one it showed an empty state saying its profit is
          only gross «for lack of a run with a cost» — which is wrong
          advice about a product that is bought, not made: its cost comes
          in through «استلام بضاعة جاهزة», and `ProductStock` below
          already sends it to the right door.
        */}
        {product.sourceType !== 'PURCHASED' && (
        <Card>
          <CardHeader
            title={<span className="flex items-center space-x-2 rtl:space-x-reverse"><RiBuilding4Line className="w-4 h-4 text-[var(--sys-destructive)]" /><span>تشغيلات الإنتاج</span></span>}
            action={<Link href="/manufacturing"><Button size="sm" variant="outline">إدارة التشغيلات</Button></Link>}
          />
          <CardContent className="p-0 overflow-x-auto">
                        <Rows
              rows={(product.batches ?? [])}
              keyOf={(b: any) => b.id}
              columns={[
                { key: 'c0', label: "الرقم", primary: true,
                  render: (b: any) => (b.batchNumber) },
                { key: 'c1', label: "الكمية", primary: true,
                  render: (b: any) => (b.quantityProduced) },
                { key: 'c2', label: "المتبقي",
                  render: (b: any) => (b.quantityRemaining) },
                { key: 'c3', label: "التكلفة الكلية",
                  render: (b: any) => (
                  <><Money value={b.totalProductionCost} /></>
                ) },
                { key: 'c4', label: "تكلفة الوحدة",
                  render: (b: any) => (
                  <><Money value={b.costPerUnit} className="font-black text-[var(--sys-heading)]" /></>
                ) },
                { key: 'c5', label: "التاريخ",
                  render: (b: any) => arDate(b.productionDate) },
              ]}
              empty={
                <EmptyState title="لا تشغيلاتِ إنتاجٍ لهذا المنتج" why="التشغيلة هي ما تُحسب منه كلفةُ الوحدة. بلا واحدةٍ بكلفة، ربحُ هذا المنتج إجماليٌّ لا صافٍ." />
              }
            />
          </CardContent>
        </Card>
        )}

        {/* Stock, cost and the one door that adds more. */}
        <ProductStock productId={productId} canReceive={canReceiveStock} canProduce={canProduce} />

        {/* What kind of thing it is — the answers that become filters. */}
        <Card>
          <CardHeader title="الخصائص" />
          <CardContent>
            <ProductAttributes productId={productId} canManage={!!canManage} />
          </CardContent>
        </Card>

        {/* Offers — edited here, read everywhere. The anchor is where «بعد الطلب» in the page editor sends you. */}
        <div id="offers" style={{ scrollMarginTop: 80 }} />
        <ProductOffers
          productId={productId}
          basePrice={product.basePrice ?? 0}
          currency={currencyCode}
          // Both keys the price box of «تعديل المنتج» needs: the button shows for products.edit only, and
          // api/products/[id] checks products.edit before products.change_price.
          canChangePrice={canManage && userCan(currentUser, 'products.change_price')}
        />

        {/* The latest orders on this product — from its own door (this card read `product.orders`, which was never sent). */}
        <ProductRecentOrders productId={productId} />
      </div>

      {/* Lightbox */}
      <Modal isOpen={!!lightbox} onClose={() => setLightbox(null)} title="معاينة الصورة" maxWidth="4xl">
        {lightbox && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={lightbox} alt="معاينة" className="w-full max-h-[70vh] object-contain rounded-lg" />
        )}
      </Modal>
    </>
  );
}
