'use client';

import React, { useEffect, useState } from 'react';
import { apiJson } from '@/lib/api-client';
import { ScreenTitle } from '@/components/shell/ScreenTitle';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { Rows } from '@/components/ui/Rows';
import { EmptyState } from '@/components/ui/EmptyState';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { Money } from '@/components/ui/Money';
import { RiFlaskLine, RiLoader4Line } from '@remixicon/react';
import { Button } from '@/components/ui/Button';
import { BenchTestPanel, VerdictChip, type BenchProductTest } from './BenchTestPanel';

/**
 * /growth/bench — منصّة التجريب: جدول النتائج ولوحتها.
 *
 * «منتج تيست — بيئةٌ منعزلة … جدولُ النتائج، لوحةٌ خاصّة، أرقامٌ لا تدخل
 * أيَّ حسبة». Every figure on this screen is refused everywhere else in the
 * product; this is the one place built to read it, and it says so at the
 * top rather than leaving a reader to wonder why these numbers are not in
 * the profit report.
 *
 * ── WHAT IT DOES NOT DO ──
 *
 * It does not rank the products. Fifty niche products tried and four kept
 * is the shape of this work, and a «best» column over products with two
 * orders each would be a league table of noise. It sorts by what was tried
 * most recently, which is the order somebody actually works in, and shows
 * the delivery rate only once a parcel has been decided.
 *
 * And it claims nothing about the future. The DNA panel is counts — «7 of
 * your 9 sellers are for dry skin» — because a count is a fact the owner
 * can check against their own memory and a prediction is a claim this data
 * cannot support. See src/lib/product-dna.ts, which refuses the whole
 * reading below ten sellers rather than describing one product.
 */

/*
 * ── AND THE VERDICT (18/11) ──
 *
 * Each product now carries its test (BenchTestPanel.tsx): a verdict chip by
 * the owner's rules — success / continue / fail / cap — its confirmation
 * rate, and a panel for its rules and its spend by day. The verdict reads
 * confirmations and spend only, never shipping: a bench order stops at
 * confirmation. The delivery columns stay for what already shipped.
 */
interface BenchResult extends BenchProductTest {
  sku: string | null;
  bench: string | null;
  price: number;
  category: string | null;
  triedAt: string;
  orders: number;
  delivered: number;
  returned: number;
  deliveryRate: number | null;
  decided: number;
}

interface Trait {
  field: string;
  label: string;
  value: string;
  shared: number;
  outOf: number;
  line: string;
}

interface Payload {
  currency: string;
  benches: { id: string; name: string }[];
  results: BenchResult[];
  excluded: string | null;
  dna: { sellers: number; minSellers: number; traits: Trait[] | null; whyNot: string | null };
}

export function BenchScreen() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [round, setRound] = useState(0);

  useEffect(() => {
    let cancelled = false;
    apiJson<Payload>('/api/growth/bench')
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : 'تعذّر التحميل'));
    return () => {
      cancelled = true;
    };
  }, [round]);
  const open = data?.results.find((p) => p.id === openId) ?? null;

  return (
    <div className="space-y-4">
      {/* The heading and its name come from the route registry — one list
          of screens, so a title cannot drift from the menu entry. What a
          screen adds is the sentence underneath. */}
      <ScreenTitle note="منتجات تُجرَّب على متجرٍ معزول — وأرقامها خارج كل حسبة في النظام" />

      {error && (
        <p className="rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] p-3 text-sm text-[var(--sys-destructive)]">
          {error}
        </p>
      )}

      {!data ? (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-[var(--sys-muted-foreground)]">
          <RiLoader4Line className="h-4 w-4 animate-spin" /> جارٍ التحميل…
        </div>
      ) : data.benches.length === 0 ? (
        /*
         * NO BENCH YET, AND THE WAY TO MAKE ONE IS A SENTENCE RATHER THAN A
         * BUTTON: a bench is a STORE, and creating one belongs to the screen
         * that creates stores. A second «create store» here would be a
         * second door to one thing.
         */
        <EmptyState
          title="لا منصّة تجريب بعد"
          why="المنصّة متجرٌ تضع عليه علامة «منصّة تجريب» من الإعدادات ← البلدان والمتاجر. منتجاتها وطلباتها تبقى خارج كل رقم في التقارير، ولا تُفتَح للزوّار."
        />
      ) : (
        <>
          {/*
            WHY THESE NUMBERS ARE NOT IN THE PROFIT REPORT, said once at the
            top. Without it the first question somebody asks about this
            screen is whether it is double-counting the business.
          */}
          {data.excluded && (
            <p className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-surface)] p-3 text-xs text-[var(--sys-muted-foreground)]">
              <span className="inline-flex items-center gap-1.5 font-semibold text-[var(--sys-heading)]">
                <RiFlaskLine className="h-4 w-4" /> أرقام هذه الشاشة معزولة:{' '}
              </span>
              {data.excluded}
            </p>
          )}

          {/* ── ما يَشترِكُ فيه ما بِعتَه فعلاً ── */}
          <Card>
            <CardHeader
              title="ما يشترك فيه ما بِعتَه فعلاً"
              subtitle="عدٌّ على منتجاتك التي وصلت لعملاء — لا تنبّؤ بما سينجح"
            />
            <CardContent>
              {data.dna.traits === null ? (
                <p className="text-sm text-[var(--sys-muted-foreground)]">{data.dna.whyNot}</p>
              ) : data.dna.traits.length === 0 ? (
                <p className="text-sm text-[var(--sys-muted-foreground)]">
                  {data.dna.sellers} منتجاً لها تاريخ، ولا صفة يشترك فيها نصفها على الأقل — فلا نمط يُقال.
                </p>
              ) : (
                <ul className="flex flex-wrap gap-2">
                  {data.dna.traits.map((t) => (
                    <li
                      key={`${t.field}:${t.value}`}
                      className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-surface)] px-3 py-1.5 text-xs"
                    >
                      <span className="text-[var(--sys-muted-foreground)]">{t.label}: </span>
                      <span className="font-semibold text-[var(--sys-heading)]">{t.value}</span>
                      <span className="ms-1.5 tabular-nums text-[var(--sys-muted)]">
                        {t.shared} من {t.outOf}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {/* ── جدولُ النتائج ── */}
          <Card>
            <CardHeader
              title="جدول النتائج"
              subtitle={`${data.results.length} منتجاً على المنصّة — الأحدث تجريباً أولاً`}
            />
            <CardContent className="p-0">
              <Rows
                rows={data.results}
                keyOf={(p) => p.id}
                empty={
                  <EmptyState
                    title="لا منتج على المنصّة بعد"
                    why="أضِف منتجاً واختر له متجر المنصّة، فيظهر هنا مع ما يحدث له."
                  />
                }
                /*
                  ORANGE, NOT RED, AND ONLY ONCE THE PARCEL WAS DECIDED.
                  A product whose parcels come back is the finding this
                  screen exists for — and «red» is for a cancelled order on
                  the tracking screen. A product tried yesterday with
                  nothing decided is not a failure; it is Tuesday.
                */
                alert={(p) => (p.decided > 0 && p.returned > p.delivered ? 'warn' : null)}
                actions={(p) => (
                  <Button type="button" size="sm" variant="outline" onClick={() => setOpenId(p.id)}>
                    الأرقام والصرف
                  </Button>
                )}
                columns={[
                  {
                    key: 'name',
                    label: 'المنتج',
                    primary: true,
                    render: (p) => (
                      <>
                        <span className="font-medium text-[var(--sys-heading)]">{p.name}</span>
                        {p.category && (
                          <span className="block text-xs text-[var(--sys-muted)]">{p.category}</span>
                        )}
                      </>
                    ),
                  },
                  { key: 'bench', label: 'المنصّة', hideOnPhone: true, render: (p) => p.bench ?? '—' },
                  {
                    key: 'price',
                    label: 'السعر',
                    align: 'end',
                    render: (p) => <Money value={p.price} />,
                  },
                  {
                    key: 'orders',
                    label: 'طلبات',
                    align: 'end',
                    render: (p) => <span className="tabular-nums">{p.orders}</span>,
                  },
                  {
                    key: 'verdict',
                    label: 'الحكم',
                    render: (p) => <VerdictChip verdict={p.verdict} />,
                  },
                  {
                    key: 'confirmed',
                    label: 'نسبة التأكيد',
                    align: 'end',
                    render: (p) =>
                      p.test.confirmationRate === null ? (
                        <span className="text-[var(--sys-muted)]">—</span>
                      ) : (
                        <span className="tabular-nums">
                          {p.test.confirmationRate}%
                          <span className="ms-1 text-xs text-[var(--sys-muted)]">
                            {p.test.confirmed} من {p.test.orders}
                          </span>
                        </span>
                      ),
                  },
                  {
                    key: 'spend',
                    label: 'الصرف',
                    align: 'end',
                    hideOnPhone: true,
                    render: (p) =>
                      p.test.spend === null ? (
                        <span className="text-[var(--sys-muted)]">ما انكتب</span>
                      ) : (
                        <Money value={p.test.spend} currency={p.currency} minorUnit={p.minorUnit} />
                      ),
                  },
                  {
                    key: 'cpo',
                    label: 'تكلفة الطلب',
                    align: 'end',
                    hideOnPhone: true,
                    render: (p) =>
                      p.test.costPerOrder === null ? (
                        <span className="text-[var(--sys-muted)]">—</span>
                      ) : (
                        <Money value={p.test.costPerOrder} currency={p.currency} minorUnit={p.minorUnit} />
                      ),
                  },
                  {
                    key: 'delivered',
                    label: 'وصلت',
                    align: 'end',
                    render: (p) => (
                      <span className="tabular-nums text-[var(--sys-success)]">{p.delivered}</span>
                    ),
                  },
                  {
                    key: 'returned',
                    label: 'رجعت',
                    align: 'end',
                    render: (p) => (
                      <span className="tabular-nums text-[var(--sys-destructive)]">{p.returned}</span>
                    ),
                  },
                  {
                    key: 'rate',
                    label: 'نسبة الوصول',
                    align: 'end',
                    /*
                      NOTHING RATHER THAN «0%» BEFORE THE FIRST VERDICT. A
                      product tried yesterday has no rate, and a zero in
                      this column reads as a product that failed.
                    */
                    render: (p) =>
                      p.deliveryRate === null ? (
                        <span className="text-[var(--sys-muted)]">لم يُحسم بعد</span>
                      ) : (
                        <span className="tabular-nums font-semibold text-[var(--sys-heading)]">
                          {p.deliveryRate}%
                          <span className="ms-1 text-xs font-normal text-[var(--sys-muted)]">
                            من {p.decided}
                          </span>
                        </span>
                      ),
                  },
                ]}
              />
            </CardContent>
          </Card>

          {open && (
            <BenchTestPanel
              key={`${open.id}:${JSON.stringify(open.rules)}`}
              product={open}
              send={(body) =>
                apiJson<{ ok: boolean }>('/api/growth/bench', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(body),
                })
              }
              onClose={() => setOpenId(null)}
              onChanged={() => setRound((n) => n + 1)}
            />
          )}
        </>
      )}
    </div>
  );
}
