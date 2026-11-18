'use client';

import React, { useEffect, useState } from 'react';
import { Card, CardHeader, CardContent } from '@/components/ui/Card';
import { HealthChip } from '@/components/ui/HealthChip';
import { Money } from '@/components/ui/Money';
import { apiJson } from '@/lib/api-client';
import type { ProductGrade } from '@/lib/product-grade';

/**
 * «أداء المبيعات» — WHAT THIS PRODUCT SOLD, FROM THE SERVER'S OWN COUNT.
 *
 * The card read `analytics.revenue`, `analytics.netProfit`, `analytics.totalOrders` and `analytics.deliveredOrders` —
 * four keys `GET /api/products/[id]` has never sent — and drew four empty figures about a product with 305 orders,
 * 124 of them delivered. It reads the one door that already counts sales per product, the one the products list's
 * grade is built from (`/api/products/grades`), so the two screens cannot say different things about one product:
 * confirmed, delivered, returned, refused, the revenue of what was delivered, and — only for who may see what goods cost —
 * the cost of those goods, with the verdict and the sentence under it.
 *
 * NOT ONE FIGURE IS WORKED OUT HERE. «صافي الربح» is gone from the card on purpose: it was never sent, and a subtraction
 * of revenue and cost in the browser is the kind of money arithmetic this system keeps on the server. The margin is in the
 * verdict's sentence, where `product-grade.ts` writes it from the same two numbers.
 */

interface GradeAnswer {
  window: { start: string | null; end: string | null; days: number | null };
  salesVisible: boolean;
  costVisible: boolean;
  grades: ProductGrade[];
}

export function ProductPerformance({ productId }: { productId: string }) {
  const [answer, setAnswer] = useState<GradeAnswer | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    // Another product: nothing of the last one stays on the card while this one is read.
    setAnswer(null);
    setFailed(null);
    apiJson<GradeAnswer>(`/api/products/grades?ids=${encodeURIComponent(productId)}`)
      .then((a) => alive && setAnswer(a))
      .catch((e) => alive && setFailed(e instanceof Error ? e.message : 'تعذّرت قراءة الأداء'));
    return () => {
      alive = false;
    };
  }, [productId]);

  const grade = answer?.grades.find((g) => g.productId === productId) ?? null;
  const sales = grade?.sales ?? null;

  const days = answer?.window.days;
  const subtitle = days ? `الطلبات الموصّلة — آخر ${days} يوماً` : 'الطلبات الموصّلة';

  return (
    <Card>
      <CardHeader title="أداء المبيعات" subtitle={subtitle} />
      <CardContent className="text-note space-y-2">
        {failed && <p className="text-[var(--sys-muted-foreground)]">{failed}</p>}
        {!failed && !answer && <p className="text-[var(--sys-muted-foreground)]">جارٍ القراءة…</p>}
        {answer && !answer.salesVisible && (
          <p className="text-[var(--sys-muted-foreground)]">أرقام المبيعات لا تظهر إلا لمن معه صلاحية «التقارير».</p>
        )}
        {answer && answer.salesVisible && !sales && (
          <p className="text-[var(--sys-muted-foreground)]">لا بيانات عن هذا المنتج.</p>
        )}
        {sales && (
          <>
            <div className="grid grid-cols-2 gap-2 text-center">
              <div className="bg-[var(--sys-surface)] p-2.5 rounded-lg">
                <span className="text-[var(--sys-primary)] block">الإيراد</span>
                <Money value={sales.deliveredRevenue} className="font-black text-[var(--sys-primary)]" />
              </div>
              {sales.deliveredCogs !== null && (
                <div className="bg-[var(--sys-surface)] p-2.5 rounded-lg">
                  <span className="text-[var(--sys-muted)] block">تكلفة البضاعة</span>
                  <Money value={sales.deliveredCogs} className="font-bold text-[var(--sys-heading)]" />
                </div>
              )}
              <div className="bg-[var(--sys-success-soft)] p-2.5 rounded-lg">
                <span className="text-[var(--sys-success)] block">موصّل</span>
                <span className="font-bold text-[var(--sys-success)]">{sales.delivered}</span>
              </div>
              <div className="bg-[var(--sys-surface)] p-2.5 rounded-lg">
                <span className="text-[var(--sys-muted)] block">مؤكَّد</span>
                <span className="font-bold text-[var(--sys-heading)]">{sales.confirmed}</span>
              </div>
              <div className="bg-[var(--sys-destructive-soft)] p-2.5 rounded-lg">
                <span className="text-[var(--sys-destructive)] block">راجع</span>
                <span className="font-bold text-[var(--sys-destructive)]">{sales.returned}</span>
              </div>
              <div className="bg-[var(--sys-surface)] p-2.5 rounded-lg">
                <span className="text-[var(--sys-muted)] block">مرفوض بالهاتف</span>
                <span className="font-bold text-[var(--sys-heading)]">{sales.refused}</span>
              </div>
            </div>
            {grade && (
              <div className="space-y-1 pt-1">
                <HealthChip health={{ tone: grade.tone, label: grade.label, why: grade.why }} />
                <p className="leading-relaxed text-[var(--sys-muted-foreground)]">{grade.why}</p>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
