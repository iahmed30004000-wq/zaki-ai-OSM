'use client';

import { plainNumber } from '@/lib/format';
import React, { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardHeader, CardContent, KpiCard } from '@/components/ui/Card';
import { useConfirm, useTell } from '@/components/ui/Confirm';
import { Button } from '@/components/ui/Button';
import { Input, Textarea, Select } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Badge } from '@/components/ui/Badge';
import { ProductThumb } from '@/components/ui/ProductThumb';
import { useApp } from '@/context/AppContext';
import { userCan } from '@/lib/can';
import { useCreateIntent } from '@/hooks/useCreateIntent';
import { productName } from '@/lib/product-name';
import Link from 'next/link';
import { RiAddCircleLine, RiArchiveLine, RiArrowRightUpLine, RiCloseLine, RiDeleteBinLine, RiFolderTransferLine, RiFoldersLine, RiImageAddLine, RiMedalLine, RiPencilLine, RiSearchLine, RiStarLine, RiTruckLine, RiWallet3Line } from '@remixicon/react';
import { Money } from '@/components/ui/Money';
import { CategoryPicker } from '@/components/products/CategoryPicker';
import { PageHeader } from '@/components/ui/PageHeader';
import { AdvancedGroup } from '@/components/ui/AdvancedGroup';
import { EmptyState } from '@/components/ui/EmptyState';
import { Rows } from '@/components/ui/Rows';
import { HealthChip } from '@/components/ui/HealthChip';
import type { CatalogueReadiness, ProductGrade } from '@/lib/product-grade';
import { PRODUCT_STATUS_AR, productStatusAr, productStatusTone } from '@/lib/product-status';
import { ProductEditDialog } from '@/components/products/ProductEditDialog';
import { CategoriseDialog, type CategoriseResult } from '@/components/products/CategoriseDialog';
import { apiJson } from '@/lib/api-client';
import type { ProductStatsAnswer as ProductStats } from '@/lib/product-stats';

/** A count as a reader reads it — Latin digits, thousands separated. */
const count = (n: number) => plainNumber(n);

/**
 * What the grades route answers with, so the screen never guesses a shape.
 */
interface GradeAnswer {
  window: { start: string | null; end: string | null; days: number | null };
  minSample: number;
  salesVisible: boolean;
  costVisible: boolean;
  grades: ProductGrade[];
  readiness: CatalogueReadiness;
}

export function ProductsScreen() {
  const { t, locale, currentUser } = useApp();
  /** UX only: the grades' door (`GET /api/products/grades`) asks `insights.view` itself (PR-10). */
  const canInsights = userCan(currentUser, 'insights.view');
  const router = useRouter();
  const ask = useConfirm();
  const tell = useTell();
  const [products, setProducts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  // «+ أنشئ» in Ctrl+K arrives as `?new=product` and opens the form the «إضافة منتج» button opens.
  useCreateIntent({ product: () => setCreateModalOpen(true) });
  /**
   * THE GRADE, FETCHED — NEVER COMPUTED HERE.
   *
   * Not one number in this column is worked out on this side: the delivery
   * rate, the margin, the value of a delivered order and every sentence
   * printed under them arrive from `/api/products/grades`, which reads the
   * orders and calls `product-grade.ts`. A screen that recomputed any of
   * them would be a second answer to the same question, which is how this
   * page came to print two different «متوسط تكلفة الوحدة» a fortnight ago.
   */
  const [gradeData, setGradeData] = useState<GradeAnswer | null>(null);

  /**
   * THE FIGURES ABOVE THE TABLE AND THE UNITS IN ITS «المبيعات» COLUMN — FETCHED, NEVER COMPUTED HERE.
   *
   * The owner, 21/10: «المبيعات في جدول المنتجات فش ارقام؟». The column read `analytics.totalSold`, a counter that is only
   * moved when a delivery draws its units from a production batch: 14 products held 17,664 delivered units and 13 of them
   * showed 0. `GET /api/products/stats` counts what a customer actually took (see `lib/product-stats.ts`), and this screen
   * only prints it.
   *
   * THREE STATES, AND NONE OF THEM IS A ZERO. `undefined` until the first answer is in — the column says «…», because a 0
   * painted over a product with thousands of units is a claim; `null` when it could not be read — «—»; and the answer. The
   * old figure is NOT the fallback: a number that is wrong is worse than a dash. A reload (after a create or a delete) keeps
   * the numbers on screen until the new ones arrive rather than blinking to «…» — and an answer that arrives late never
   * replaces a newer one.
   */
  const [stats, setStats] = useState<ProductStats | null | undefined>(undefined);
  const statsSeq = useRef(0);
  const loadStats = async () => {
    const mine = ++statsSeq.current;
    let answer: ProductStats | null = null;
    try {
      const data = await apiJson<ProductStats>('/api/products/stats');
      // A shape that is not the answer is no answer: the cards and the column read it field by field.
      if (data && data.unitsSold) answer = data;
    } catch {
      // The catalogue must render even when its numbers cannot — a dash says so.
    }
    if (mine === statsSeq.current) setStats(answer);
  };

  /**
   * Whether this viewer was given costs at all — asked of the DATA, not of
   * the permissions. The server decides who may see what a thing cost
   * (src/lib/cost-visibility.ts); a copy of that rule here would be a
   * second answer to the same question, and one of the two would drift.
   */
  const showsCost = products.some((p) => p.analytics?.avgCostPerUnit !== undefined);

  // Create form state
  const [name, setName] = useState('');
  const [sku, setSku] = useState('');
  const [description, setDescription] = useState('');
  /*
   * THE PRICE BOX HOLDS WHAT WAS TYPED, AND THE DOOR DECIDES.
   *
   * These two boxes were `parseFloat(e.target.value) || 0`, so clearing the
   * field to retype a price did not clear it: it set the price to **0**, the
   * box redrew as `0`, and pressing save stored a free product and answered
   * 200. `82ecac3` closed both product doors against that exact value —
   * `readBasePrice` refuses anything that is not a number and 0 is a real
   * price — and the browser was quietly converting the refusable input into
   * the one wrong value the door is obliged to accept.
   *
   * So the state is a string now: an empty box is an empty box, and what
   * reaches `POST`/`PATCH /api/products` is the characters the person typed.
   * `readBasePrice` reads `' 12.5 '`, refuses `''` and `'abc'` with
   * `BASE_PRICE_NOT_A_NUMBER`, and the dialogs already render that sentence.
   * Nothing here does arithmetic on the figure; it is carried, not computed.
   */
  const [basePrice, setBasePrice] = useState('20');
  const [sourceType, setSourceType] = useState<'MANUFACTURED' | 'PURCHASED'>('MANUFACTURED');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [status, setStatus] = useState('ACTIVE');
  const [modalLoading, setModalLoading] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [primaryIndex, setPrimaryIndex] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // RiSearchLine
  const [search, setSearch] = useState('');
  /** Show only the products with no category — the backlog, one click away. */
  const [onlyUnfiled, setOnlyUnfiled] = useState(false);
  const uncategorised = products.filter((p) => !p.categoryId).length;
  /** The dialog that sorts them. */
  const [categoriseOpen, setCategoriseOpen] = useState(false);
  const handleCategorised = (r: CategoriseResult) => {
    setCategoriseOpen(false);
    void loadProducts();
    void tell({
      title: r.filed > 0 ? `رُتِّب ${count(r.filed)} منتجاً` : 'لم يُرتَّب أيّ منتج',
      body:
        [
          r.created.length > 0 ? `أُنشئ: ${r.created.join('، ')}.` : '',
          r.skipped > 0 ? `${count(r.skipped)} لم يُنقَل — صُنِّف قبل الضغط أو لا تملك تعديله.` : '',
        ]
          .filter((line) => line !== '')
          .join('\n') || undefined,
    });
  };

  const filteredProducts = products.filter((p) => {
    if (onlyUnfiled && p.categoryId) return false;
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return (
      (p.name || '').toLowerCase().includes(q) ||
      (p.nameEn || '').toLowerCase().includes(q) ||
      (p.sku || '').toLowerCase().includes(q)
    );
  });

  // Edit modal
  const [editOpen, setEditOpen] = useState(false);
  const [editProduct, setEditProduct] = useState<any>(null);

  /** Open the shared dialog on this product. The form lives inside it. */
  const openEdit = (p: any) => {
    setEditProduct(p);
    setEditOpen(true);
  };

  const handleDelete = async (p: any) => {
    const ok = await ask({
      title: `حذف المنتج «${productName(p, locale)}» نهائياً؟`,
      body: 'ستُحذف صوره أيضاً، ولا يمكن التراجع.',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      const res = await fetch(`/api/products/${p.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) {
        void tell({ title: 'تعذر حذف المنتج', body: data.error || 'فشل الحذف', tone: 'danger' });
        return;
      }
      loadProducts();
    } catch (err: any) {
      void tell({ title: 'تعذر حذف المنتج', body: err.message, tone: 'danger' });
    }
  };

  /**
   * The grade for exactly the products on screen — never for a set the list
   * is not showing, or the number beside a name would belong to another row.
   */
  const loadGrades = async (ids: string[]) => {
    setGradeData(null);
    // Nobody is asked what they may not read: the grade is a smart card (PR-10), and a 403 is not a failure worth a call.
    if (ids.length === 0 || !canInsights) return;
    try {
      const res = await fetch(`/api/products/grades?ids=${ids.join(',')}`);
      // A refusal here is the ordinary case for somebody who may see the
      // catalogue but not the reports — not a failure worth a red box over
      // the list.
      if (!res.ok) return;
      setGradeData(await res.json());
    } catch {
      // Same reasoning: the catalogue must render even when the grade cannot.
    }
  };

  const loadProducts = async () => {
    setLoading(true);
    void loadStats();
    try {
      const res = await fetch('/api/products');
      if (res.ok) {
        const data = await res.json();
        const list: any[] = data.products || [];
        setProducts(list);
        void loadGrades(list.map((p) => p.id));
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const gradeOf = (id: string): ProductGrade | undefined =>
    gradeData?.grades.find((g) => g.productId === id);

  useEffect(() => {
    loadProducts();
  }, []);

  const handleFilesSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    const valid = files.filter((f) =>
      ['image/jpeg', 'image/png', 'image/webp'].includes(f.type) && f.size <= 10 * 1024 * 1024
    );
    setSelectedFiles((prev) => [...prev, ...valid]);
    if (e.target.value) e.target.value = '';
  };

  const removeFile = (idx: number) => {
    setSelectedFiles((prev) => prev.filter((_, i) => i !== idx));
    if (primaryIndex === idx) setPrimaryIndex(0);
    else if (primaryIndex > idx) setPrimaryIndex((p) => p - 1);
  };

  const handleCreateProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    setModalLoading(true);
    setModalError(null);
    try {
      const res = await fetch('/api/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, sku, description, basePrice, status, sourceType, categoryId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      const productId = data.product.id;

      // Upload selected images (first = primary)
      if (selectedFiles.length > 0) {
        const formData = new FormData();
        selectedFiles.forEach((f) => formData.append('files', f));
        formData.append('isPrimary', 'true');
        const uploadRes = await fetch(`/api/products/${productId}/images`, {
          method: 'POST',
          body: formData,
        });
        if (!uploadRes.ok) {
          const upData = await uploadRes.json();
          throw new Error(upData.error || 'فشل رفع الصور');
        }
      }

      setCreateModalOpen(false);
      setName('');
      setSku('');
      setDescription('');
      setSelectedFiles([]);
      setPrimaryIndex(0);
      loadProducts();
    } catch (err: any) {
      setModalError(err.message);
    } finally {
      setModalLoading(false);
    }
  };

  const primaryImageOf = (p: any) => p.images?.find((i: any) => i.isPrimary) || p.images?.[0];

  /** «الأكثر مبيعاً» — the NAME comes from the list this screen already holds; the number from the server. */
  const topSeller = stats?.top ? products.find((p) => p.id === stats.top!.id) : undefined;
  const topSellerLine = topSeller && stats?.top ? `الأكثر: ${productName(topSeller, locale)} (${count(stats.top.units)})` : undefined;

  return (
    <>
      <div className="space-y-6">
        {/* Header */}
        <PageHeader title={t.products}
            description="كتالوج المنتجات مع الصور، تحليل تكاليف التصنيع متعدد التشغيلات والمخزون"
            actions={
              <><div className="flex items-center space-x-2 rtl:space-x-reverse">
            <AdvancedGroup holds="تشغيلات الإنتاج">
            <Link href="/manufacturing">
              <Button variant="outline" size="sm" className="flex items-center space-x-1">
                <RiFoldersLine className="w-4 h-4" />
                <span>تشغيلات الإنتاج</span>
              </Button>
            </Link>
            </AdvancedGroup>
            <Button
              size="sm"
              onClick={() => setCreateModalOpen(true)}
              className="flex items-center space-x-1.5 bg-[var(--sys-destructive)] hover:bg-[var(--sys-destructive)]/85"
            >
              <RiAddCircleLine className="w-4 h-4" />
              <span>إضافة منتج</span>
            </Button>
          </div></>
            }
          />

        {/*
          «بطاقات ذكية في المنتجات زي احصائيات» — THE OWNER, 21/10.

          Four figures about the catalogue, each from the server and each with the sentence that says what it counts: a card a
          reader cannot check is a number nobody trusts. Nothing is drawn until the answer is in, so there is no card of zeros
          to be read in the meantime; and the value of the stock is a card only when the server sent it — it is what the goods
          cost, and a caller who may not see that is not shown a zero in its place.
        */}
        {stats?.totals && (
          <div className={stats.totals.stockValue !== undefined ? 'grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4' : 'grid grid-cols-1 md:grid-cols-3 gap-4'}>
            <KpiCard
              title="المنتجات"
              rule="مجموع المنتجات في كتالوج هذا المتجر ممّا يحقّ لك رؤيته. «نشط» حالته نشط، و«بلا تصنيف» ما إله فئة."
              value={count(stats.totals.products)}
              subtitle={`${count(stats.totals.active)} نشط · ${count(stats.totals.unfiled)} بلا تصنيف`}
              icon={RiFoldersLine}
            />
            <KpiCard
              title="القطع المباعة"
              rule="مجموع القطع اللي استلمها الزبائن فعلاً من الطلبات الموصَّلة — عند التسليم الجزئي ما انقبل منها بس، والهديّة قطعة منها — من أوّل طلب. هو نفس الرقم بعمود «المبيعات»."
              value={count(stats.totals.unitsSold)}
              subtitle={topSellerLine}
              icon={RiTruckLine}
            />
            <KpiCard
              title="القطع في المستودع"
              rule="مجموع اللي بقي بدفعات المنتجات اللي فيها رصيد، لكلّ منتج بهالمتجر. قبل ما ينخصم المحجوز لطلبات ما انشحنت — «المتاح للبيع» بصفحة كل منتج."
              value={count(stats.totals.unitsOnHand)}
              subtitle={`${count(stats.totals.outOfStock)} منتج نافد من المستودع`}
              icon={RiArchiveLine}
            />
            {stats.totals.stockValue !== undefined && (
              <KpiCard
                title="قيمة المخزون"
                rule="لكلّ منتج: ما بقي بكلّ دفعة × تكلفة وحدتها، ثمّ مجموعها على المنتجات. هو نفس رقم «قيمة المخزون» بصفحة المنتج."
                value={<Money value={stats.totals.stockValue} />}
                icon={RiWallet3Line}
              />
            )}
          </div>
        )}

        {/*
          WHAT THE GRADE IS MADE OF, AND WHAT IS MISSING BEFORE IT SPEAKS.

          Measured on this record, the column can grade three products out of
          a hundred and fourteen: three clear the floor of ten confirmed
          orders and the fourth-busiest has eight. A column blank on a
          hundred and eleven rows teaches a reader that the feature is
          broken, so the screen says out loud how many rows are blank and for
          which of four reasons — and beside it the catalogue backlog, which
          is the part anybody can act on today: ninety products with no price
          cannot appear in the store at all.
        */}
        {gradeData && (
          <div className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-surface)] p-4 space-y-2">
            <div className="flex items-center gap-2">
              <RiMedalLine className="w-4 h-4 text-[var(--sys-primary)]" />
              <h3 className="text-xs font-bold text-[var(--sys-heading)]">
                تقدير المنتجات: ممّا يُبنى، وما ينقص قبل أن ينطق
              </h3>
            </div>
            <p className="text-xs font-semibold text-[var(--sys-foreground)] leading-relaxed">
              {gradeData.readiness.why}
            </p>
            {gradeData.salesVisible && (
              <p className="text-xs text-[var(--sys-muted-foreground)] leading-relaxed">
                يُبنى على: {gradeData.readiness.madeOf.join('، ')}
                {gradeData.window.days !== null ? ` — عن طلبات آخر ${gradeData.window.days} يوماً` : ''} وفي المتجر
                المختار وحده، ولا يُعطى رقمٌ لمنتجٍ عيّنتُه أقلّ من {gradeData.minSample} طلباً مؤكَّداً.
                {!gradeData.costVisible && ' وكلفةُ البضاعة لا تُعرَض لهذا الحساب، فبندُ الهامش ساقطٌ من المجموع.'}
              </p>
            )}
            <p className="text-xs text-[var(--sys-muted)] leading-relaxed">
              لا يُستدعى أيُّ نموذجٍ في هذا الرقم. كلُّ جملةٍ هنا قالبٌ حول عددٍ مقروءٍ من السجل، والبندُ الذي لا
              يستطيع السجلُّ قياسَه يسقط من المجموع ويقول لماذا — ولا يُحسَب صفراً.
            </p>
          </div>
        )}

        {/* Products Table with Image Thumbnails */}
        <Card>
          <CardHeader
            title="جدول المنتجات"
            subtitle="الصور، المخزون، التكلفة، المبيعات والأرباح لكل منتج — عدّل أو احذف مباشرة"
          />
          <CardContent className="pt-4">
            {/* RiSearchLine bar */}
            <div className="relative max-w-md mb-4">
              <RiSearchLine className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--sys-muted)]" />
              <input
                type="text"
                placeholder="بحث بالاسم (عربي/إنجليزي) أو SKU..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-11 md:h-auto w-full ps-9 pe-4 md:py-2.5 text-xs bg-[var(--sys-surface)] border border-[var(--sys-border-input)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--sys-primary)]/30 focus:border-[var(--sys-primary)]"
              />
              {search && (
                <button
                  onClick={() => setSearch('')}
                  aria-label="امسح البحث"
                  title="امسح البحث"
                  className="absolute end-3 top-1/2 -translate-y-1/2 text-[var(--sys-muted)] hover:text-[var(--sys-foreground)] cursor-pointer"
                >
                  <RiCloseLine className="w-4 h-4" />
                </button>
              )}
              <span className="absolute -bottom-5 start-1 text-xs text-[var(--sys-muted)]">
                {filteredProducts.length} من أصل {products.length} منتج
              </span>
            </div>

            {/*
              THE BACKLOG, SAID OUT LOUD.
              A category decides who may see a product, how the reports group
              it, and what the assistant can answer about a line of goods —
              and 114 products carried none while the screen said nothing.
              One switch filters to exactly them, so filing is a sitting.
            */}
            {uncategorised > 0 && (
              <div className="mt-6">
                <button
                  type="button"
                  onClick={() => setOnlyUnfiled((v) => !v)}
                  className={`min-h-11 md:min-h-0 inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                    onlyUnfiled
                      ? 'bg-[var(--sys-warning-soft)] border-[var(--sys-warning)] text-[var(--sys-warning)]'
                      : 'border-[var(--sys-border)] text-[var(--sys-muted-foreground)] hover:border-[var(--sys-warning)] hover:text-[var(--sys-warning)]'
                  }`}
                >
                  <RiFoldersLine className="w-4 h-4" aria-hidden />
                  {onlyUnfiled ? 'أظهِر الكلّ' : `${uncategorised} منتجاً بلا تصنيف`}
                </button>
                {/*
                  AND THE SORTING, ONE PRESS AWAY.
                  «انتا صنف افضل» — THE OWNER, 22/10. Each of the products with no
                  category is offered the shelf its name points at, in a dialog
                  where he changes what he disagrees with; nothing is written
                  until he presses «طبّق» there.
                */}
                <button
                  type="button"
                  onClick={() => setCategoriseOpen(true)}
                  className="ms-2 min-h-11 md:min-h-0 inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors border-[var(--sys-border)] text-[var(--sys-muted-foreground)] hover:border-[var(--sys-warning)] hover:text-[var(--sys-warning)]"
                >
                  <RiFolderTransferLine className="w-4 h-4" aria-hidden />
                  رتّبها لي
                </button>
                <span className="ms-2 text-xs text-[var(--sys-muted)]">
                  التصنيف يحدّد من يرى المنتج، وكيف تُجمَّع تقاريره، وما يستطيع المساعد الإجابة عنه.
                </span>
              </div>
            )}
          </CardContent>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Rows
                rows={filteredProducts}
                keyOf={(p) => p.id}
                onRowClick={(p) => router.push(`/products/${p.id}`)}
                columns={[
                  {
                    key: 'image',
                    label: 'الصورة',
                    render: (p) => <ProductThumb src={primaryImageOf(p)?.url} alt={productName(p, locale)} size="md" />,
                  },
                  {
                    key: 'name',
                    label: 'اسم المنتج',
                    primary: true,
                    render: (p) => (
                      <>
                        <span className="block font-bold text-[var(--sys-heading)]">{productName(p, locale)}</span>
                        <span className="text-xs text-[var(--sys-muted)]">
                          {/* The shelf, where the name is — not a column of
                              its own. A category is how a product is FILED,
                              so it reads as part of what it is rather than
                              as another field to scan across. */}
                          {/*
                            AND «بلا تصنيف» WHEN THERE IS NONE.
                            Rendering nothing made 114 unfiled products look
                            exactly like 114 filed ones. A gap you cannot see
                            is a gap nobody closes.
                          */}
                          {p.category?.name ? (
                            <span className="text-[var(--sys-muted-foreground)]">{p.category.name} • </span>
                          ) : (
                            <span className="text-[var(--sys-warning)]">بلا تصنيف • </span>
                          )}
                          {p.images?.length || 0} صورة • {p.offers?.length || 0} عرض
                        </span>
                      </>
                    ),
                  },
                  {
                    key: 'sku',
                    label: 'SKU',
                    primary: true,
                    render: (p) => <span className="font-mono text-[var(--sys-muted-foreground)]">{p.sku}</span>,
                  },
                  {
                    key: 'status',
                    label: 'الحالة',
                    render: (p) => (
                      <Badge variant={productStatusTone(p.status)}>
                        {productStatusAr(p.status)}
                      </Badge>
                    ),
                  },
                  {
                    key: 'stock',
                    label: 'المخزون',
                    align: 'end',
                    render: (p) => (
                      <span className="font-bold tabular-nums text-[var(--sys-success)]">
                        {p.analytics?.totalRemaining ?? 0}
                      </span>
                    ),
                  },
                  /**
                   * THE COST COLUMN ONLY WHEN THE SERVER SENT A COST.
                   *
                   * It used to print `?? 0` for anyone the server withheld
                   * it from — a column of zeros, which is not «you may not
                   * see this» but «these cost nothing», and somebody would
                   * eventually quote it. The server decides (see
                   * cost-visibility.ts); this reads the answer rather than
                   * keeping a second copy of the rule.
                   */
                  ...(showsCost
                    ? [
                        {
                          key: 'cost',
                          label: 'التكلفة/وحدة',
                          align: 'end' as const,
                          render: (p: any) => <Money value={p.analytics?.avgCostPerUnit ?? 0} />,
                        },
                      ]
                    : []),
                  {
                    key: 'sold',
                    label: 'المبيعات (قطعة)',
                    align: 'end',
                    render: (p) => (
                      <span className="font-medium tabular-nums text-[var(--sys-primary)]">
                        {stats === undefined ? '…' : stats === null ? '—' : count(stats.unitsSold[p.id] ?? 0)}
                      </span>
                    ),
                  },
                  /*
                    THE CHIP IS NEVER ALONE. «مقيَّم» on its own is the
                    opaque figure this system refuses everywhere else; the
                    sentence under it carries the counted numbers so the
                    reader can check it by hand, and the readiness line under
                    THAT is a second, independent fact — never added to the
                    first. A product can sell perfectly and still be missing
                    the price that would let the store show it.

                    The total is printed in the primary colour and given no
                    verdict colour of its own, exactly as the employees row
                    prints its own: there is no owner-set bar for a composite
                    out of seventy, and colouring it would be this screen
                    inventing one.
                  */
                  ...(!canInsights ? [] : [{
                    key: 'grade',
                    label: 'التقدير',
                    render: (p: any) => {
                      const g = gradeOf(p.id);
                      if (!g) return <span className="text-xs text-[var(--sys-muted)]">—</span>;
                      return (
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <HealthChip health={{ tone: g.tone, label: g.label, why: g.why }} />
                            {g.score && g.score.total !== null && (
                              <span className="text-xs font-bold tabular-nums text-[var(--sys-primary)]">
                                {g.score.total}
                                <span className="font-normal text-[var(--sys-muted-foreground)]">
                                  {' '}
                                  / {g.score.possible}
                                </span>
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-[var(--sys-muted-foreground)] leading-relaxed">{g.why}</p>
                          {/* Every band that scored, with the fact it read —
                              so the total can be added up by hand. */}
                          {g.score?.bands
                            .filter((b) => b.points !== null)
                            .map((b) => (
                              <p key={b.key} className="text-xs text-[var(--sys-muted)] leading-relaxed">
                                {b.ar}: {b.points} / {b.weight} — {b.why}
                              </p>
                            ))}
                          <span className="inline-flex">
                            <HealthChip
                              health={{
                                tone: g.readiness.tone,
                                label: g.readiness.label,
                                why: g.readiness.why,
                              }}
                            />
                          </span>
                        </div>
                      );
                    },
                  }]),
                ]}
                actions={(p) => (
                  <span className="flex items-center justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
                    <Button size="sm" variant="outline" onClick={() => router.push(`/products/${p.id}`)} className="p-2" title="التفاصيل والصور">
                      <RiArrowRightUpLine className="icon-mirror w-4 h-4" />
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => openEdit(p)}
                      className="p-2 bg-[var(--sys-surface)] text-[var(--sys-primary)] border-[var(--sys-primary-soft)] hover:bg-[var(--sys-surface-strong)]"
                      title="تعديل المنتج"
                    >
                      <RiPencilLine className="w-4 h-4" />
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => handleDelete(p)} className="p-2" title="حذف المنتج">
                      <RiDeleteBinLine className="w-4 h-4" />
                    </Button>
                  </span>
                )}
                empty={
                  loading ? (
                    <p className="py-12 text-center text-xs text-[var(--sys-muted-foreground)]">{t.loading}</p>
                  ) : (
                    <EmptyState
                      title={search ? `لا منتجَ يطابق «${search}»` : 'لا منتجات في هذا المتجر بعد'}
                      why={
                        search
                          ? 'البحث يقرأ الاسم العربيّ والإنجليزيّ وSKU. امسحه لترى الكتالوج كلّه.'
                          : 'بلا منتجٍ لا طلبَ ولا مخزونَ ولا صفحةَ هبوط. ابدأ بواحد.'
                      }
                      action={
                        search
                          ? { label: 'امسح البحث', onClick: () => setSearch('') }
                          : { label: 'أضف أول منتج', onClick: () => setCreateModalOpen(true) }
                      }
                    />
                  )
                }
              />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Create Product Modal with Image Upload */}
      <Modal
        isOpen={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        title="إضافة منتج جديد"
        subtitle="المعلومات الأساسية + صور المنتج (رئيسية + إضافية)"
        maxWidth="2xl"
      >
        <form onSubmit={handleCreateProduct} className="space-y-4">
          {modalError && (
            <div className="p-3 bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] text-[var(--sys-destructive)] text-xs rounded-lg">
              {modalError}
            </div>
          )}

          {/* Basic Information */}
          <div className="border border-[var(--sys-border)] rounded-lg p-4 bg-[var(--sys-surface)] space-y-3">
            <h4 className="text-xs font-bold text-[var(--sys-foreground)]">1. المعلومات الأساسية</h4>
            <Input
              label="اسم المنتج *"
              placeholder="مثال: كريم إزالة الندبات الألماني الأصلي"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Input
                label="SKU *"
                placeholder="SCAR-DE-05"
                value={sku}
                onChange={(e) => setSku(e.target.value.toUpperCase())}
                required
              />
              <Input
                label="السعر الأساسي ($)"
                type="number"
                step="0.01"
                value={basePrice}
                onChange={(e) => setBasePrice(e.target.value)}
                required
              />
              <Select label="حالة المنتج" value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="ACTIVE">{PRODUCT_STATUS_AR.ACTIVE}</option>
                <option value="INACTIVE">{PRODUCT_STATUS_AR.INACTIVE}</option>
                <option value="OUT_OF_STOCK">{PRODUCT_STATUS_AR.OUT_OF_STOCK}</option>
              </Select>
            </div>

            {/* Which door this product's stock comes in through. Both write
                the same ledger; a ready-made good entered as a "production
                run" puts invented manufacturing costs into your cost
                reports, which is why it is asked once, here. */}
            <div>
              <label className="mb-1.5 block text-xs font-medium text-[var(--sys-heading)]">مصدر المنتج *</label>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {([
                  ['MANUFACTURED', 'نصنّعه', 'تشغيلة إنتاج ببنود كلفة — مواد، أجور، تغليف'],
                  ['PURCHASED', 'جاهز نشتريه', 'استلام بضاعة بسعر شراء للقطعة'],
                ] as const).map(([key, title, hint]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setSourceType(key)}
                    className={`cursor-pointer rounded-lg border p-3 text-start transition ${
                      sourceType === key
                        ? 'border-[var(--sys-primary)] bg-[var(--sys-primary-soft)]'
                        : 'border-[var(--sys-border)] bg-[var(--sys-card)] hover:border-[var(--sys-primary)]/40'
                    }`}
                  >
                    <span className={`block text-sm font-bold ${sourceType === key ? 'text-[var(--sys-primary)]' : 'text-[var(--sys-heading)]'}`}>
                      {title}
                    </span>
                    <span className="mt-0.5 block text-xs leading-relaxed text-[var(--sys-muted-foreground)]">{hint}</span>
                  </button>
                ))}
              </div>
            </div>
            <CategoryPicker value={categoryId} onChange={setCategoryId} />

            <Textarea
              label="الوصف"
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          {/* Product Images */}
          <div className="border border-[var(--sys-border)] rounded-lg p-4 bg-[var(--sys-surface)] space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-bold text-[var(--sys-foreground)]">
                2. صور المنتج (الأولى = الصورة الرئيسية)
              </h4>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                multiple
                onChange={handleFilesSelected}
                className="hidden"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
                className="text-xs"
              >
                <RiImageAddLine className="w-4 h-4 ml-1 rtl:ml-0 rtl:mr-1" />
                اختيار صور
              </Button>
            </div>

            {selectedFiles.length === 0 ? (
              <div className="border-2 border-dashed border-[var(--sys-border)] rounded-lg p-6 text-center text-xs text-[var(--sys-muted)]">
                JPG / PNG / WEBP — حتى 10 ميجابايت للصورة
              </div>
            ) : (
              <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
                {selectedFiles.map((file, idx) => (
                  <div
                    key={idx}
                    className={`relative group rounded-lg overflow-hidden border-2 ${
                      primaryIndex === idx ? 'border-[var(--sys-primary)]' : 'border-[var(--sys-border)]'
                    }`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={URL.createObjectURL(file)}
                      alt={file.name}
                      className="w-full h-20 object-cover"
                    />
                    {primaryIndex === idx && (
                      <span className="absolute top-1 left-1 rtl:left-auto rtl:right-1 bg-[var(--sys-destructive)] text-[var(--sys-primary-foreground)] text-xs font-bold px-1.5 py-0.5 rounded-lg flex items-center space-x-0.5">
                        <RiStarLine className="w-4 h-4" />
                        <span>رئيسية</span>
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => removeFile(idx)}
                      aria-label="أزل الصورة"
                      title="أزل الصورة"
                      className="absolute top-1 right-1 rtl:right-auto rtl:left-1 bg-[var(--sys-card)]/90 text-[var(--sys-destructive)] rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                    >
                      <RiCloseLine className="w-4 h-4" />
                    </button>
                    {primaryIndex !== idx && (
                      <button
                        type="button"
                        onClick={() => setPrimaryIndex(idx)}
                        className="min-h-11 md:min-h-0 inline-flex items-center absolute bottom-1 left-1 rtl:left-auto rtl:right-1 bg-[var(--sys-sidebar)]/60 text-[var(--sys-primary-foreground)] text-xs px-1.5 py-0.5 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                      >
                        رئيسية
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Inventory info hint */}
          <div className="p-3 bg-[var(--sys-surface)] border border-[var(--sys-primary-soft)] rounded-lg text-xs text-[var(--sys-primary)]">
            بعد إنشاء المنتج أضف تشغيلات الإنتاج من صفحة <Link href="/manufacturing" className="underline font-semibold">تشغيلات الإنتاج</Link> لحساب تكلفة الوحدة والمخزون تلقائياً.
          </div>

          <div className="flex justify-end space-x-2 rtl:space-x-reverse pt-2">
            <Button type="button" variant="outline" onClick={() => setCreateModalOpen(false)}>
              إلغاء
            </Button>
            <Button type="submit" loading={modalLoading}>
              حفظ المنتج
            </Button>
          </div>
        </form>
      </Modal>

      {/*
        THE ONE EDIT FORM, SHARED WITH THE PRODUCT PAGE.

        It lived here as markup, and the detail page — the place this very
        modal tells people to go — had no edit at all. Lifted out rather
        than copied, so the two screens cannot drift into two different
        ideas of what a product is.
      */}
      {categoriseOpen && (
        <CategoriseDialog
          products={products
            .filter((p) => !p.categoryId)
            .map((p) => ({ id: p.id, label: productName(p, locale), name: p.name, nameEn: p.nameEn, sku: p.sku }))}
          onClose={() => setCategoriseOpen(false)}
          onDone={handleCategorised}
        />
      )}

      <ProductEditDialog
        product={editProduct}
        open={editOpen}
        onClose={() => setEditOpen(false)}
        onSaved={loadProducts}
        locale={locale}
        onManageImages={() => {
          setEditOpen(false);
          router.push(`/products/${editProduct.id}`);
        }}
      />
    </>
  );
}
