'use client';

import React, { useId, useState, useEffect, useMemo } from 'react';
import { NOT_A_NUMBER, onTheWire, typedNumber } from '@/lib/typed-box';
import Link from 'next/link';
import { Card, CardHeader, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Select, Textarea } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Badge } from '@/components/ui/Badge';
import { useApp } from '@/context/AppContext';
import { useToast } from '@/components/ui/Toast';
import { useMayOpen } from '@/hooks/useMayOpen';
import { useIsPhone } from '@/hooks/useIsPhone';
import { openBalancesStep } from '@/lib/next-step';
import { arDate } from '@/lib/format';
import { BatchCostDialog, type BatchForCost } from '@/components/production/BatchCostDialog';
import {
  RiAddCircleLine,
  RiCalculatorLine,
  RiDeleteBinLine,
  RiInboxArchiveLine,
  RiLightbulbLine,
  RiPriceTag3Line,
} from '@remixicon/react';
import { Money } from '@/components/ui/Money';
import { PageHeader } from '@/components/ui/PageHeader';
import { AdvancedGroup } from '@/components/ui/AdvancedGroup';
import { batchTotal, batchUnitCost } from '@/lib/product-cost';
import { Rows } from '@/components/ui/Rows';
import { EmptyState } from '@/components/ui/EmptyState';
import { Tabs } from '@/components/ui/Tabs';
import { HealthChip } from '@/components/ui/HealthChip';
import { ORIGIN, gradeBatch, readBatches, type BatchOrigin } from '@/lib/batch-grade';
import { ProductPicker } from '@/components/ui/ProductPicker';

/**
 * The costs that keep coming back, offered instead of typed.
 *
 * Every run has a handful of the same lines, and typing them by hand each
 * time produces "اجرة عامل", "أجرة العامل" and "اجور عمال" on three batches
 * of the same product — three labels that no report can add together.
 * "أخرى" is still there for the one the list does not have.
 */
const COST_PRESETS = [
  'أجور عمال',
  'قالب',
  'شحن المواد الخام',
  'كهرباء ومحروقات',
  'إيجار ورشة',
  'ملصقات وطباعة',
  'فحص مخبري',
  'هالك وتالف',
  'نقل داخلي',
  'عمولة وسيط',
];

/**
 * A TYPED NUMBER, OR «NOTHING» — AND A TYPED `0` IS A NUMBER.
 *
 * The same reader `CourierFees.tsx` got in `17cbe93`, for the same defect.
 * Every box on this form was `parseFloat(e.target.value) || 0` (and the
 * quantity `parseInt(…, 10) || 0`), so:
 *
 *   · A CLEARED BOX WAS A TYPED ZERO. `parseFloat('')` is `NaN` and `||`
 *     makes it `0`, the box redrew as `0`, and the batch was saved with a
 *     real zero cost — which `0aea050`'s new door is obliged to accept,
 *     because a run with no packaging cost is a legitimate 0. The refusal
 *     the door now carries was unreachable from this screen.
 *   · `'2,500'` FROM AN ARABIC KEYBOARD WAS 2. `parseFloat` stops at the
 *     comma. `0aea050` measured it: a 2500+500 batch over 1000 units
 *     recorded as 502, a unit cost of 0.502 instead of 3.
 *
 * `undefined` is the third answer, and `JSON.stringify` DROPS an
 * `undefined` property — so an empty box is ABSENT on the wire and the
 * door decides what absent means, not this component.
 *
 * `NOT_A_NUMBER` is the fourth outcome and it is used for the LIVE TOTAL
 * ONLY. What goes on the wire is the CHARACTERS, as `ProductsScreen` sends
 * them since `0aea050`: `'2,500'` must reach `POST /api/production` and be
 * REFUSED by name («الكمية المنتجة: اكتبه رقماً صحيحاً بالأرقام»), not be
 * quietly repaired or quietly truncated here. A browser that pre-rejects it
 * is a second rule for the same number.
 */

/** The number a box holds, or nothing — the symbol is not a figure. */
function numberOnly(v: number | undefined | typeof NOT_A_NUMBER): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

/**
 * WHAT A BOX PUTS ON THE WIRE: its characters, or nothing at all.
 *
 * Not a number. `numeric-input.ts` is the door's reader and it is stricter
 * than `Number()` — it refuses `'0x10'`, `''` and `[]` — so handing it the
 * characters is the only way its refusal can be about what a person typed.
 */

/** The two presses at the foot of a run's card, as two equal bordered targets rather than two bare words. */
const CARD_PRESS = ' flex-1 justify-center rounded-lg border border-[var(--sys-border)] px-3';

export function ManufacturingScreen() {
  const { t } = useApp();
  const toast = useToast();
  const mayOpen = useMayOpen();
  const phone = useIsPhone();
  const formId = useId();
  const [batches, setBatches] = useState<any[]>([]);
  const [products, setProducts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [currency, setCurrency] = useState('');
  const [createModalOpen, setCreateModalOpen] = useState(false);

  // Form State
  const [productId, setProductId] = useState('');
  // A batch entered with no cost prices its stock at zero and every
  // margin built on it is gross. This is where that gets fixed.
  const [costing, setCosting] = useState<BatchForCost | null>(null);
  const [batchNumber, setBatchNumber] = useState('');
  /*
   * EVERY BOX OPENS EMPTY, AND EVERY BOX HOLDS WHAT WAS TYPED.
   *
   * These five were `useState(1000)`, `2500`, `800`, `700` and `0` — five
   * numbers invented in a browser and then saved as though a person had
   * chosen them. They are not even copies of a schema default: nothing on
   * the server says a run makes a thousand units and costs 2500 to make.
   * Pressing «تشغيلة جديدة» and then «احفظ» stored a complete, plausible,
   * entirely fictional batch, and its `costPerUnit` then priced real stock.
   *
   * Where the ONE copy of each default now lives:
   *   · the four buckets — `money.default(0)` in
   *     `src/app/api/production/route.ts`, over a `Float @default(0)` NOT
   *     NULL column. The column cannot say «unknown», so an absent cost IS
   *     zero, and that is stated once, at the door, where it is readable.
   *   · the quantity — `count(1_000_000, 1)` at the same door, with NO
   *     default: a run of nothing is not a run, so an empty box is refused
   *     («الكمية المنتجة مطلوب») rather than defaulted anywhere.
   *   · a cost line's amount — `money` at the same door, no default: a
   *     named line with no amount is refused, not counted as nothing.
   *
   * The state is `string` for the reason `ProductsScreen` is since
   * `0aea050`: an empty box must stay an empty box, and `'2,500'` must
   * reach the door intact.
   */
  const [quantityTyped, setQuantityTyped] = useState('');
  const [manufacturingCost, setManufacturingCost] = useState('');
  const [packagingCost, setPackagingCost] = useState('');
  const [rawMaterialCost, setRawMaterialCost] = useState('');
  const [otherCosts, setOtherCosts] = useState('');
  // Free-form cost lines. Four fixed buckets never matched a real run —
  // they matched whatever fitted into four words — so a batch can name as
  // many costs as the work actually had.
  const [costLines, setCostLines] = useState<{ label: string; amount: string }[]>([]);
  const [notes, setNotes] = useState('');
  const [modalLoading, setModalLoading] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);

  /**
   * THE FIGURE ON SCREEN IS THE FIGURE THAT WILL BE STORED.
   *
   * This used to add the buckets and the lines here and divide to two
   * places, while the server records four — so the unit cost somebody
   * watched while typing could differ from the one written down. The same
   * two functions now, which are pure and import only types.
   *
   * AND THE PREVIEW NEVER INVENTS A FIGURE. The boxes hold characters, so
   * each one is read into «a number», «nothing» or «not a number», and:
   *
   *   · «nothing» is handed to `batchTotal` AS `undefined`. The zero an
   *     absent cost counts as lives inside `batchTotal` — the one function
   *     both sides call — so there is no `?? 0` here to be a second copy
   *     of it.
   *   · «not a number» (`'2,500'`) shows NO total and NO unit cost. The
   *     old code showed 502 for a 3000 batch, which is the number the
   *     operator then believed. A dash and a sentence are honest; a figure
   *     computed from a truncated string is not.
   *   · an unreadable or empty QUANTITY shows no unit cost either.
   *     `batchUnitCost` returns 0 for a quantity of zero, and «تكلفة
   *     الوحدة: 0» over real costs reads as «free», which is the one thing
   *     it cannot mean.
   */
  const typedMfg = typedNumber(manufacturingCost);
  const typedPack = typedNumber(packagingCost);
  const typedRaw = typedNumber(rawMaterialCost);
  const typedOther = typedNumber(otherCosts);
  const typedAmounts = costLines.map((l) => typedNumber(l.amount));
  const typedQuantity = typedNumber(quantityTyped);
  const unreadable = [typedMfg, typedPack, typedRaw, typedOther, typedQuantity, ...typedAmounts].some(
    (v) => v === NOT_A_NUMBER
  );

  const { total: totalProductionCost } = batchTotal({
    manufacturingCost: numberOnly(typedMfg),
    packagingCost: numberOnly(typedPack),
    rawMaterialCost: numberOnly(typedRaw),
    otherCosts: numberOnly(typedOther),
    costLines: typedAmounts
      .filter((a): a is number => typeof a === 'number')
      .map((amount) => ({ amount })),
  });
  const quantityProduced = numberOnly(typedQuantity);
  const costPerUnit =
    !unreadable && quantityProduced !== undefined && quantityProduced > 0
      ? String(batchUnitCost(totalProductionCost, quantityProduced))
      : null;

  // This screen is the door for what you MAKE. A bought product listed here
  // would be entered as a run that never happened, with a cost breakdown
  // nobody can trace to any work — and the server refuses it anyway.
  const manufacturedProducts = products.filter((p: any) => p.sourceType !== 'PURCHASED');

  /**
   * WHICH DOOR EACH ROW CAME IN THROUGH, AND WHAT ITS COST ACTUALLY SAYS.
   *
   * The owner's note: «ليش المنتجات الجاهزة موجودة بتشغيلات الإنتاج». They
   * are here because a batch is the only place units live, so every door
   * that puts stock in opens one — receiving ready goods, the opening count,
   * a recount. Measured on this database: of 110 rows, 17 are runs, 4 are
   * receipts of ready goods and 89 are opening balances. So 93 rows on a
   * screen called «تشغيلات الإنتاج» were not production, unlabelled.
   *
   * Nothing is hidden — a hidden row is stock nobody can find. Each row now
   * says which door it came from, and the door's own link is beside it.
   */
  const graded: any[] = useMemo(
    () =>
      batches.map((b: any) => ({
        ...b,
        grade: gradeBatch({
          batchNumber: b.batchNumber,
          openingCountId: b.openingCountId,
          sourceType: b.product?.sourceType,
          quantityProduced: b.quantityProduced,
          costPerUnit: b.costPerUnit,
          totalProductionCost: b.totalProductionCost,
          manufacturingCost: b.manufacturingCost,
          packagingCost: b.packagingCost,
          rawMaterialCost: b.rawMaterialCost,
          otherCosts: b.otherCosts,
          costLines: b.costLines ?? [],
          // What we sell one for. Zero means this product has no price set,
          // and then the margin band is not scored rather than assumed.
          sellingPrice: b.product?.basePrice ?? null,
        }),
      })),
    [batches]
  );

  const reading = useMemo(() => readBatches(graded.map((g: any) => g.grade)), [graded]);

  const [door, setDoor] = useState<'ALL' | BatchOrigin>('ALL');

  // A filter on a door that no longer has rows is a dead end: the tab it
  // points at is not on the strip any more, so the list reads as empty with
  // nothing highlighted to click back out of. It falls back to «الكل».
  const openDoor: 'ALL' | BatchOrigin =
    door !== 'ALL' && !graded.some((g: any) => g.grade.origin === door) ? 'ALL' : door;

  const visible = useMemo(
    () => (openDoor === 'ALL' ? graded : graded.filter((g: any) => g.grade.origin === openDoor)),
    [graded, openDoor]
  );

  const loadData = async () => {
    setLoading(true);
    try {
      const [bRes, pRes] = await Promise.all([
        fetch('/api/production'),
        fetch('/api/products'),
      ]);
      if (bRes.ok) {
        const bData = await bRes.json();
        setBatches(bData.batches || []);
        // The country's currency, from the server that knows which country
        // this store is in.
        if (bData.currency) setCurrency(bData.currency);
      }
      if (pRes.ok) {
        const pData = await pRes.json();
        setProducts(pData.products || []);
        if (pData.products?.length > 0 && !productId) {
          setProductId(pData.products[0].id);
        }
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleCreateBatch = async (e: React.FormEvent) => {
    e.preventDefault();
    // The picker carries no `required` — the form says so itself.
    if (!productId) { setModalError('اختر المنتج أوّلاً.'); return; }
    setModalLoading(true);
    setModalError(null);
    try {
      const res = await fetch('/api/production', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId,
          batchNumber,
          /*
           * THE CHARACTERS, OR THE FIELD IS NOT THERE.
           *
           * `onTheWire` returns `undefined` for an empty box and
           * `JSON.stringify` drops it, so the key is absent — and the door
           * answers each absence with the rule it declares for that column:
           * «الكمية المنتجة مطلوب» for the quantity, the column's own `0`
           * for a bucket, «المبلغ مطلوب» for a named line.
           *
           * And a non-empty box is sent AS TYPED, so `'2,500'` is refused
           * by name instead of being stored as 2.
           */
          quantityProduced: onTheWire(quantityTyped),
          manufacturingCost: onTheWire(manufacturingCost),
          packagingCost: onTheWire(packagingCost),
          rawMaterialCost: onTheWire(rawMaterialCost),
          otherCosts: onTheWire(otherCosts),
          costLines: costLines
            .filter((l) => l.label.trim())
            .map((l) => ({ label: l.label, amount: onTheWire(l.amount) })),
          notes,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      // It used to close in silence. The units are on the shelf now; the balances are where to see them.
      toast.done(`أُضيفت التشغيلة ${batchNumber}`, 'دخلت المخزون بكلفتها.', openBalancesStep(mayOpen));
      setCreateModalOpen(false);
      setBatchNumber('');
      setNotes('');
      /*
       * AND THE BOXES ARE EMPTIED, which they never were.
       *
       * With the old prefills this was invisible: the form reopened showing
       * 1000/2500/800/700 whether or not anybody had touched them. Leaving
       * the last run's typed costs sitting in the boxes would put them back
       * exactly where the prefills were — a number from somewhere else,
       * ready to be saved as this run's.
       */
      setQuantityTyped('');
      setManufacturingCost('');
      setPackagingCost('');
      setRawMaterialCost('');
      setOtherCosts('');
      setCostLines([]);
      loadData();
    } catch (err: any) {
      setModalError(err.message);
    } finally {
      setModalLoading(false);
    }
  };

  /**
   * «تشغيلة جديدة» — the header's button and the empty list's one, the same act.
   *
   * It was written inline in the header. The empty state now offers the first
   * batch too, and a second copy of «name the batch, then open the form» is how
   * the two would come to number batches differently.
   */
  /** The rows that did not come in through production: one box each, with the way to see them alone. */
  const readingBoxes = reading.byOrigin.filter((o) => o.origin !== 'PRODUCED');
  const readingDetail = (
    <>
      {readingBoxes.map((o) => (
        <div
          key={o.origin}
          className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-surface)] p-3"
        >
          <p className="flex flex-wrap items-center gap-2 text-xs font-bold text-[var(--sys-heading)]">
            <span>{ORIGIN[o.origin].ar}</span>
            <span className="tabular-nums rounded-full bg-[var(--sys-surface-strong)] px-2 py-0.5">
              {o.count}
            </span>
            <button
              type="button"
              onClick={() => setDoor(o.origin)}
              className="inline-flex min-h-11 items-center text-xs font-semibold text-[var(--sys-primary)] hover:underline md:min-h-0"
            >
              اعرضها وحدها
            </button>
            {ORIGIN[o.origin].href && (
              <Link
                href={ORIGIN[o.origin].href as string}
                className="inline-flex min-h-11 items-center text-xs font-semibold text-[var(--sys-primary)] hover:underline md:min-h-0"
              >
                اذهب إلى بابها
              </Link>
            )}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
            {ORIGIN[o.origin].why}
          </p>
        </div>
      ))}

      {reading.mismatched > 0 && (
        <p className="rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] p-3 text-xs leading-relaxed text-[var(--sys-destructive)]">
          {reading.mismatched} دفعة كلفتها المحفوظة تخالف بنودها — عدّل كلفتها لتتفق الأرقام.
        </p>
      )}

      {reading.ungraded > 0 && (
        <p className="text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
          {reading.ungraded} دفعة بلا درجة: لم يُقَس منها إلا وجود الكلفة، فلا بنود كلفة فيها
          ولا سعر بيع للمنتج يُقارن به. درجةٌ مبنيّة على سؤال واحد ليست درجة — فلا تُمنَح.
        </p>
      )}
    </>
  );

  // The two ends of the dialog, drawn once and placed by the layout: at the end of the form on a desk, in the footer of
  // the dialog on a phone (a submit button out there belongs to the form by its id).
  const actionRow = (
    <div className="flex justify-end space-x-2 pt-2">
      <Button type="button" variant="outline" onClick={() => setCreateModalOpen(false)}>
        {t.cancel}
      </Button>
      <Button type="submit" form={phone ? formId : undefined} loading={modalLoading}>
        احفظ الدفعة وأضفها للمخزون
      </Button>
    </div>
  );

  const openNewBatch = () => {
    setBatchNumber(`BATCH-${new Date().getFullYear()}-${String(batches.length + 1).padStart(3, '0')}`);
    setCreateModalOpen(true);
  };

  return (
    <>
      <div className="space-y-6">
        {/* Header */}
        <PageHeader title="تشغيلات الإنتاج"
            description="الباب الذي تدخل منه بضاعة المنتجات التي تصنّعها — كل تشغيلة ببنود كلفتها،
              ومنها تُحسب تكلفة الوحدة التي يقرأها الربح."
            actions={
              <>
          {/* The two doors this screen is next to, said out loud rather than
              left in the sidebar: the product itself, and the other door
              stock comes in through. «ضيف زر يوديني على المنتجات». */}
          <AdvancedGroup holds="المنتجات · استلام بضاعة جاهزة">
          <Link href="/products">
            <Button size="sm" variant="outline" className="flex items-center space-x-1.5">
              <RiPriceTag3Line className="w-4 h-4" />
              <span>المنتجات</span>
            </Button>
          </Link>
          <Link href="/inventory/balances">
            <Button size="sm" variant="outline" className="flex items-center space-x-1.5">
              <RiInboxArchiveLine className="w-4 h-4" />
              <span>استلام بضاعة جاهزة</span>
            </Button>
          </Link>
          </AdvancedGroup>
          <Button
            size="sm"
            onClick={openNewBatch}
            className="flex items-center space-x-1.5"
          >
            <RiAddCircleLine className="w-4 h-4" />
            <span>تشغيلة جديدة</span>
          </Button></>
            }
          />

        {/*
          THE READ OVER THE LIST — «تشغيلات الإنتاج: AI + Score», and there is
          no model behind either half of it.

          Every figure below is a count of the rows on this screen, so the
          owner can check any of them by counting. The alternative — a
          sentence a model wrote about his money — is a sentence he cannot
          check, and this screen decides what stock costs.
        */}
        {reading.headline && (
          <Card>
            <CardHeader
              title={
                <span className="flex items-center gap-2">
                  <RiLightbulbLine className="w-4 h-4 text-[var(--sys-warning)]" />
                  <span>قراءة هذه القائمة</span>
                </span>
              }
              subtitle="عدٌّ محسوب من صفوف هذه الشاشة نفسها — لا تخمين، ولا نموذج يكتبه"
            />
            <CardContent className="space-y-3">
              <p className="text-sm font-semibold leading-relaxed text-[var(--sys-heading)]">
                {reading.headline}
              </p>

              {/* Why a row that is not production is on the production
                  screen — the owner's question, answered per door, with the
                  door's own link so the row can be managed where it belongs. */}
              {/* On a phone the headline stays and the boxes under it are one tap away, in a disclosure that
                  names them — the full read-out was most of the first screen. A desk draws them all. */}
              {phone ? (
                (readingBoxes.length > 0 || reading.mismatched > 0 || reading.ungraded > 0) && (
                  <AdvancedGroup label="التفصيل" holds="مصدر الصفوف · التنبيهات">
                    <div className="w-full space-y-3">{readingDetail}</div>
                  </AdvancedGroup>
                )
              ) : (
                readingDetail
              )}
            </CardContent>
          </Card>
        )}

        {/* Batch List Table */}
        <Card>
          <CardHeader
            title="تشغيلات الإنتاج وحساب التكلفة"
            subtitle="كل تشغيلة بكلفتها وكم بِيع منها وكم بقي — وتكلفة الوحدة محسوبة منها"
          />
          {/* The filter is a filter, not a hiding place: «الكل» is the default
              and every count is on the strip, so nothing is out of sight
              without the reader having chosen to put it there. */}
          {graded.length > 0 && reading.byOrigin.length > 1 && (
            <div className="px-3 pt-1">
              <Tabs
                value={openDoor}
                onChange={(k) => setDoor(k as 'ALL' | BatchOrigin)}
                tabs={[
                  { key: 'ALL', label: 'الكل', count: graded.length },
                  ...reading.byOrigin.map((o) => ({
                    key: o.origin,
                    label: ORIGIN[o.origin].ar,
                    count: o.count,
                  })),
                ]}
              />
            </div>
          )}
          <CardContent className={phone ? 'p-3' : 'p-0'}>
            <div className={phone ? undefined : 'overflow-x-auto'}>
                            <Rows
                rows={visible}
                keyOf={(b) => b.id}
                columns={[
                  { key: 'c0', label: "رقم التشغيلة", primary: true,
                    render: (b) => (b.batchNumber) },
                  { key: 'origin', label: "من أي باب دخلت",
                    render: (b) => (
                  <><span
                          title={ORIGIN[b.grade.origin as BatchOrigin].why}
                          className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${
                            b.grade.origin === 'PRODUCED'
                              ? 'border-[var(--sys-border)] bg-[var(--sys-surface)] text-[var(--sys-foreground)]'
                              : 'border-[var(--sys-warning)]/40 bg-[var(--sys-warning-soft)] text-[var(--sys-warning)]'
                          }`}
                        >
                          {ORIGIN[b.grade.origin as BatchOrigin].ar}
                        </span></>
                ) },
                  { key: 'c1', label: "المنتج", primary: true,
                    render: (b) => (
                  <><span className="font-semibold text-[var(--sys-heading)] block">{b.product?.name}</span>
                        <span className="text-xs text-[var(--sys-muted)] font-mono">{b.product?.sku}</span></>
                ) },
                  { key: 'c2', label: "أُنتج",
                    render: (b) => (
                  <>{b.quantityProduced} قطعة</>
                ) },
                  { key: 'c3', label: "بِيع", hideOnPhone: phone,
                    render: (b) => (
                  <>{b.quantitySold} قطعة</>
                ) },
                  { key: 'c4', label: "متبقٍّ",
                    render: (b) => (
                  <><span className="font-bold text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] px-2 py-0.5 rounded-full">
                          {b.quantityRemaining} قطعة
                        </span></>
                ) },
                  { key: 'c5', label: "الكلفة الكلية", hideOnPhone: phone,
                    render: (b) => (
                  <><Money value={b.totalProductionCost} currency={currency} /></>
                ) },
                  { key: 'c6', label: "كلفة الوحدة",
                    render: (b) => (
                  <>{b.costPerUnit > 0 ? (
                          <span className="font-black text-[var(--sys-heading)] bg-[var(--sys-surface)] px-2.5 py-1 rounded-md text-xs tabular-nums">
                            <Money value={b.costPerUnit} currency={currency} />
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setCosting(b)}
                            title="هذه التشغيلة بلا كلفة، فالربح المحسوب منها إجمالي لا صافي"
                            className="min-h-11 md:min-h-0 inline-flex items-center font-bold text-[var(--sys-warning)] bg-[var(--sys-warning-soft)] border border-[var(--sys-warning)]/40 px-2.5 py-1 rounded-md text-xs hover:border-[var(--sys-warning)]"
                          >
                            بلا كلفة
                          </button>
                        )}</>
                ) },
                  {
                    key: 'grade',
                    label: 'درجة الكلفة',
                    // The reason is a sentence, so the cell is given a width
                    // to wrap inside rather than pushing a ten-column table
                    // sideways.
                    className: 'max-w-xs',
                    // The reason is a sentence: on a card it takes the whole width under its label instead of the
                    // half a figure gets.
                    wide: true,
                    render: (b) => (
                      <>
                        <HealthChip health={b.grade} />
                        {/* The reason is printed, not hidden in a tooltip: a
                            grade nobody can see the arithmetic of is a grade
                            people argue with instead of acting on. */}
                        <span className="mt-1 block text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
                          {b.grade.why}
                        </span>
                        {b.grade.mismatch && (
                          <span className="mt-1 block text-xs font-semibold text-[var(--sys-destructive)]">
                            {b.grade.mismatch}
                          </span>
                        )}
                      </>
                    ),
                  },
                  { key: 'c7', label: "التاريخ", hideOnPhone: phone,
                    render: (b) => arDate(b.productionDate) },
                ]}
                empty={
                  graded.length > 0 ? (
                    <EmptyState
                      title="لا صفوفَ في هذا الباب"
                      why="المرشِّح أعلاه يعرض باباً واحداً. اختَر «الكل» لترى كل ما دخل المخزون."
                    />
                  ) : (
                    <EmptyState
                      title="لا تشغيلاتِ إنتاجٍ بعد"
                      why="التشغيلة هي ما يُحسب منه سعرُ الوحدة. بلا تشغيلةٍ بكلفة، الربحُ المحسوب إجماليٌّ لا صافٍ."
                      action={{ label: 'أضف أول تشغيلة', onClick: openNewBatch }}
                    />
                  )
                }
                actions={(b) => (
                  <><button
                          type="button"
                          onClick={() => setCosting(b)}
                          className={`text-xs text-[var(--sys-primary)] hover:underline whitespace-nowrap${phone ? CARD_PRESS : ''}`}
                        >
                          عدّل الكلفة
                        </button>
                        {/* From a row straight to the product it belongs to.
                            The stock, the weighted-average cost and the type
                            that decided which door this row came through are
                            all on that page — and reaching it used to mean
                            leaving for the sidebar and searching by name. */}
                        {b.productId && (
                          <Link
                            href={`/products/${b.productId}`}
                            className={`text-xs text-[var(--sys-primary)] hover:underline whitespace-nowrap${phone ? CARD_PRESS : ''}`}
                          >
                            المنتج
                          </Link>
                        )}</>
                )}
              />
            </div>
          </CardContent>
        </Card>
      </div>

      {costing && (
        <BatchCostDialog batch={costing} onClose={() => setCosting(null)} onSaved={loadData} />
      )}

      {/* Production Batch Modal with Section 5 Live Formula RiCalculatorLine */}
      <Modal
        isOpen={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        title="تشغيلة إنتاج جديدة"
        subtitle="تكلفة الوحدة تُحسب تلقائياً من كل بنود الكلفة التي تدخلها"
        maxWidth="xl"
        // A phone: the two buttons stay at the foot of the dialog while the form scrolls (the save was the last
        // thing under four boxes, a list of lines and a calculator). A desk: at the end of the form.
        footer={phone ? actionRow : undefined}
      >
        <form id={formId} onSubmit={handleCreateBatch} className="space-y-4">
          {modalError && (
            <div className="p-3 bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] text-[var(--sys-destructive)] text-xs rounded-lg">
              {modalError}
            </div>
          )}

          <div className={phone ? 'grid grid-cols-1 gap-3' : 'grid grid-cols-2 gap-3'}>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-[var(--sys-heading)]">
                المنتج *
              </label>
              {/* The same scroll, and the same answer — see the note on the
                  stock count in InventoryBalancesScreen. */}
              <ProductPicker
                products={manufacturedProducts.map((p) => ({ id: p.id, name: p.name, sku: p.sku }))}
                value={productId}
                onChange={setProductId}
              />
            </div>

            <Input
              label="رقم التشغيلة *"
              value={batchNumber}
              onChange={(e) => setBatchNumber(e.target.value.toUpperCase())}
              required
            />
          </div>

          <Input
            label="الكمية المنتَجة (قطعة) *"
            type="number"
            min="1"
            name="quantityProduced"
            value={quantityTyped}
            onChange={(e) => setQuantityTyped(e.target.value)}
            // No `placeholder="1000"`: printing the old prefill as a hint is
            // the same invented number one layer down, and an operator who
            // reads a greyed-out 1000 in an empty box types nothing.
            placeholder="اكتب العدد"
            required
          />

          {/* Cost Items Grid */}
          <div className="border border-[var(--sys-border)] rounded-lg p-4 bg-[var(--sys-surface)]/60 space-y-3">
            <h4 className="text-xs font-bold text-[var(--sys-foreground)]">
              تفصيل الكلفة المباشرة
            </h4>

            {/* The one sentence that makes an empty box mean something. Before
                it, an empty box and a typed zero were the same request — and
                the boxes were not even empty, they opened holding 2500، 800
                و700. */}
            <p className="text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
              خانة <b>فارغة</b> = هذه التشغيلة ما كلّفت شيئاً من هذا البند، فتُحسب صفراً.
              و<b>صفر مكتوب</b> يُحسب صفراً كذلك. اكتب الرقم بالأرقام الإنجليزية وبنقطة عشرية —
              «2,500» تُرَدّ ولا تُقرأ 2.
            </p>

            <div className="grid grid-cols-2 gap-3">
              <Input
                label="كلفة التصنيع"
                type="number"
                step="0.01"
                name="manufacturingCost"
                value={manufacturingCost}
                onChange={(e) => setManufacturingCost(e.target.value)}
                placeholder="لا شيء"
              />
              <Input
                label="كلفة التغليف"
                type="number"
                step="0.01"
                name="packagingCost"
                value={packagingCost}
                onChange={(e) => setPackagingCost(e.target.value)}
                placeholder="لا شيء"
              />
              <Input
                label="كلفة المواد الخام"
                type="number"
                step="0.01"
                name="rawMaterialCost"
                value={rawMaterialCost}
                onChange={(e) => setRawMaterialCost(e.target.value)}
                placeholder="لا شيء"
              />
              <Input
                label="فحص الجودة / أخرى"
                type="number"
                step="0.01"
                name="otherCosts"
                value={otherCosts}
                onChange={(e) => setOtherCosts(e.target.value)}
                placeholder="لا شيء"
              />
            </div>

            {/* Whatever else this run actually cost. A mould, a day of
                labour, the courier who brought the raw material — each with
                its own name, so the total can be explained a month later. */}
            <div className="mt-4 border-t border-[var(--sys-border)] pt-3">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-xs font-bold text-[var(--sys-foreground)]">بنود كلفة إضافية</p>
                <div className="flex items-center gap-2">
                  <Select
                    className="text-xs"
                    value=""
                    onChange={(e) => {
                      if (!e.target.value) return;
                      setCostLines([
                        // `amount: 0` opened a named line already claiming it
                        // cost nothing — a zero nobody typed, in the list the
                        // batch total is built from. It opens EMPTY, and the
                        // door refuses a named line with no amount.
                        ...costLines,
                        { label: e.target.value === 'أخرى' ? '' : e.target.value, amount: '' },
                      ]);
                    }}
                    disabled={costLines.length >= 30}
                  >
                    <option value="">+ أضف بنداً…</option>
                    {COST_PRESETS.map((label) => (
                      <option key={label} value={label}>{label}</option>
                    ))}
                    <option value="أخرى">أخرى — أكتب الاسم بنفسي</option>
                  </Select>
                </div>
              </div>

              {costLines.length === 0 ? (
                <p className="text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
                  اختياري — أضف أي كلفة لا تناسبها الخانات الأربع أعلاه: قالب، أجرة عامل،
                  شحن مواد، كهرباء. كل بند باسمه ومبلغه، ويدخل في المجموع وفي تكلفة الوحدة.
                </p>
              ) : (
                <div className="space-y-2">
                  {costLines.map((line, i) => (
                    <div key={i} className={phone ? 'flex flex-wrap items-end gap-2' : 'flex items-end gap-2'}>
                      {/* A phone: the name has a line to itself, the amount and the delete share the next. */}
                      <div className={phone ? 'w-full' : 'min-w-0 flex-1'}>
                        <Input
                          label={i === 0 ? 'البند' : undefined}
                          placeholder="مثال: أجرة عامل"
                          value={line.label}
                          onChange={(e) =>
                            setCostLines(costLines.map((l, n) => (n === i ? { ...l, label: e.target.value } : l)))
                          }
                        />
                      </div>
                      <div className={phone ? 'min-w-0 flex-1' : 'w-32 shrink-0'}>
                        <Input
                          label={i === 0 ? 'كم كلّف' : undefined}
                          name={`costLineAmount-${i}`}
                          aria-label={`مبلغ البند ${i + 1}`}
                          type="number"
                          step="0.01"
                          min="0"
                          dir="ltr"
                          value={line.amount}
                          placeholder="كم"
                          onChange={(e) =>
                            setCostLines(
                              costLines.map((l, n) =>
                                n === i ? { ...l, amount: e.target.value } : l
                              )
                            )
                          }
                        />
                      </div>
                      <button
                        type="button"
                        aria-label="حذف البند" title="حذف البند"
                        onClick={() => setCostLines(costLines.filter((_, n) => n !== i))}
                        className="min-h-11 min-w-11 md:min-h-0 md:min-w-0 mb-1 cursor-pointer rounded-lg p-2 text-[var(--sys-destructive)] hover:bg-[var(--sys-destructive-soft)]"
                      >
                        <RiDeleteBinLine className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Section 5 Live Real-time RiCalculatorLine Box */}
          <div className={`p-4 bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] rounded-lg flex ${phone ? 'flex-col gap-2' : 'items-center justify-between'} text-xs`}>
            <div className="flex items-center space-x-2">
              <RiCalculatorLine className="w-5 h-5 text-[var(--sys-destructive)]" />
              <div>
                {/* A total computed from a truncated string is worse than no
                    total: `parseFloat('2,500')` is 2, and the box used to
                    print 502 for a 3000 batch as though it were measured. */}
                <p className="font-bold text-[var(--sys-heading)]">
                  الكلفة الكلية:{' '}
                  {unreadable ? <span>—</span> : <Money value={totalProductionCost} />}
                </p>
                <p className="text-[var(--sys-muted-foreground)]">
                  {unreadable
                    ? 'خانة فيها ما ليس رقماً — صحّحها ليظهر المجموع. (الفاصلة ليست عشرية: اكتب 2500 أو 2500.75)'
                    : `المعادلة: تصنيع (${manufacturingCost || '—'}) + تغليف (${packagingCost || '—'}) + مواد خام (${rawMaterialCost || '—'})`}
                </p>
              </div>
            </div>

            <div className="text-right">
              <span className="text-[var(--sys-muted-foreground)] block">تكلفة الوحدة المحسوبة:</span>
              <span className="text-xl font-black text-[var(--sys-destructive)] block">
                {/* `batchUnitCost` returns 0 for a quantity of zero, and a
                    «0» here over real costs reads as «this unit is free» —
                    the one thing an unfilled quantity box cannot mean. */}
                {costPerUnit === null ? '—' : <Money value={costPerUnit} />}
              </span>
            </div>
          </div>

          <Textarea
            label="ملاحظات الدفعة وفحص الجودة"
            placeholder="مثال: قوارير زجاج عنبري، نجحت في فحص التسريب"
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />

          {!phone && actionRow}
        </form>
      </Modal>
    </>
  );
}
