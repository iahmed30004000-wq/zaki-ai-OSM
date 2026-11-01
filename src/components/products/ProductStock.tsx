'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, CardHeader, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { apiJson } from '@/lib/api-client';
import { RiArrowLeftRightLine, RiBuilding4Line, RiInboxArchiveLine, RiLoader4Line, RiLockLine, RiStackLine } from '@remixicon/react';
import { moneyText } from '@/lib/money';
import { minorUnitFor } from '@/lib/currencies';
import { FixedCostEditor } from '@/components/products/FixedCostEditor';

/**
 * What this product has, what it cost, and the one door that adds more.
 *
 * Three numbers that used to live on three screens and rarely agreed:
 * what the batches hold, what open orders have spoken for, and what is
 * therefore still sellable. The third is the only one anybody acts on, and
 * it was the one nobody could see.
 *
 * The cost shown is the weighted average of the stock actually on hand.
 * A product does not have one cost — a March run at 3.20 and a June delivery
 * at 4.10 are different money on the same shelf — so the figure says which
 * blend it is rather than picking a batch and hoping.
 */

interface Stock {
  onHand: number;
  reserved: number;
  available: number;
  /** The three cost figures are ABSENT (not zero) for a caller without `costs.view`. */
  averageCost?: number;
  nextOutCost?: number;
  stockValue?: number;
  /** For a caller who may see a cost: the fixed figure an admin set (null: none yet), and what the batches say beside it. */
  fixedCost?: number | null;
  batchAverageCost?: number;
  batchCount: number;
  currencyCode: string;
  sourceType: 'MANUFACTURED' | 'PURCHASED';
}

/**
 * `canReceive` / `canProduce`: the keys the shortcut's two destinations are guarded by — stock received on
 * /inventory/balances (inventory.view + inventory.adjust), a production run on /manufacturing (production.view +
 * production.manage). It asked `products.edit`, which neither screen checks.
 */
export function ProductStock({
  productId,
  canReceive,
  canProduce,
  canChangeCost = false,
}: {
  productId: string;
  canReceive: boolean;
  canProduce: boolean;
  /** `products.change_cost`: the admin who may set the fixed cost. The door asks it again. */
  canChangeCost?: boolean;
}) {
  const [stock, setStock] = useState<Stock | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStock(await apiJson<Stock>(`/api/products/${productId}/stock`));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر تحميل المخزون');
    }
  }, [productId]);

  useEffect(() => { void load(); }, [load]);

  if (error) {
    return (
      <Card>
        <CardContent className="p-4">
          <p className="text-xs text-[var(--sys-destructive)]">{error}</p>
        </CardContent>
      </Card>
    );
  }

  if (!stock) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 p-4 text-xs text-[var(--sys-muted-foreground)]">
          <RiLoader4Line className="h-4 w-4 animate-spin" /> جارٍ تحميل المخزون…
        </CardContent>
      </Card>
    );
  }

  const money = (n: number) =>
    moneyText(Number(n), stock.currencyCode, minorUnitFor(stock.currencyCode) ?? 2);
  const made = stock.sourceType === 'MANUFACTURED';

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <RiStackLine className="h-4 w-4 text-[var(--sys-primary)]" />
            <span>معلومات المنتج وبياناته</span>
            <span className="rounded-full bg-[var(--sys-surface-strong)] px-2 py-0.5 text-xs font-bold text-[var(--sys-foreground)]">
              {made ? 'منتج مصنّع' : 'منتج جاهز'}
            </span>
          </span>
        }
        action={
          (made ? canProduce : canReceive) && (
            // One door, the one that fits this product. Offering both invites
            // a bought good to be entered as a production run, which puts
            // invented manufacturing costs into the cost reports.
            // AND IT ARRIVES AT THIS PRODUCT, not at a list of a hundred.
            // «كمان تحديث المخزون مش موجود» was this: the door existed and
            // opened onto a search box. The balances screen now reads
            // `?product=` and opens that product's dialog directly.
            <Link href={made ? '/manufacturing' : `/inventory/balances?product=${productId}`}>
              <Button size="sm" variant="outline">
                {made ? <RiBuilding4Line className="h-4 w-4" /> : <RiInboxArchiveLine className="h-4 w-4" />}
                {made ? 'تشغيلة إنتاج' : 'إضافة مخزون'}
              </Button>
            </Link>
          )
        }
      />
      <CardContent className="space-y-3">
        <div className="grid grid-cols-3 gap-2">
          <Tile label="بالمستودع" value={String(stock.onHand)} />
          <Tile
            label="محجوز لطلبات"
            value={String(stock.reserved)}
            icon={<RiLockLine className="h-4 w-4" />}
            tone={stock.reserved > 0 ? 'hold' : 'plain'}
          />
          <Tile
            label="متاح للبيع"
            value={String(stock.available)}
            tone={stock.available <= 0 ? 'bad' : 'good'}
          />
        </div>

        {stock.averageCost !== undefined && stock.nextOutCost !== undefined && stock.stockValue !== undefined && (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <Tile label={stock.fixedCost != null ? 'تكلفة الوحدة (ثابتة)' : 'تكلفة الوحدة (متوسط مرجّح)'} value={money(stock.averageCost)} />
            <Tile label="تكلفة الدفعة القادمة للخروج" value={money(stock.nextOutCost)} />
            <Tile label="قيمة المخزون" value={money(stock.stockValue)} />
          </div>
        )}

        {stock.fixedCost !== undefined && stock.batchAverageCost !== undefined && (
          <FixedCostEditor
            productId={productId}
            fixedCost={stock.fixedCost}
            batchAverage={stock.batchAverageCost}
            money={money}
            canChange={canChangeCost}
            onSaved={load}
          />
        )}

        <p className="text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
          {stock.averageCost !== undefined && stock.fixedCost == null &&
            '«متوسط مرجّح» يعني: كل دفعة بوزن ما تبقّى منها فعلاً. 90 قطعة بـ3 و10 بـ8 تكلفتها 3.50 للقطعة — لا 5.50. الدفعات الفارغة خارج الحساب لأنها تقول ماذا كلّف الماضي، لا ماذا تكلّف قطعة اليوم.'}
          {stock.batchCount > 0 && ` المخزون موزّع على ${stock.batchCount} دفعة.`}
        </p>

        <Link
          href="/inventory/movements"
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--sys-primary)] hover:underline"
        >
          <RiArrowLeftRightLine className="icon-mirror h-4 w-4" /> سجل حركات هذا المخزون
        </Link>
      </CardContent>
    </Card>
  );
}

function Tile({
  label, value, icon, tone = 'plain',
}: {
  label: string;
  value: string;
  icon?: React.ReactNode;
  tone?: 'plain' | 'good' | 'bad' | 'hold';
}) {
  const tones = {
    plain: 'border-[var(--sys-border)] bg-[var(--sys-card)] text-[var(--sys-heading)]',
    good: 'border-[var(--sys-success-soft)] bg-[var(--sys-success-soft)] text-[var(--sys-success)]',
    bad: 'border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] text-[var(--sys-destructive)]',
    hold: 'border-[var(--sys-warning)] bg-[var(--sys-warning-soft)] text-[var(--sys-warning)]',
  } as const;

  return (
    <div className={`rounded-lg border p-3 ${tones[tone]}`}>
      <p className="flex items-center gap-1 text-xs font-medium text-[var(--sys-muted-foreground)]">
        {icon} {label}
      </p>
      <p className="mt-0.5 text-sm font-black tabular-nums" dir="ltr">{value}</p>
    </div>
  );
}
