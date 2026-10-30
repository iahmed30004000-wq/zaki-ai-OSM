'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Select, Textarea } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { AdvancedGroup } from '@/components/ui/AdvancedGroup';
import { useIsPhone } from '@/hooks/useIsPhone';
import { HealthChip } from '@/components/ui/HealthChip';
import { useApp } from '@/context/AppContext';
import { routeLabel } from '@/lib/route-registry';
import { RiArrowUpDownLine } from '@remixicon/react';
import { PageHeader } from '@/components/ui/PageHeader';
import { OpeningStockCountBanner } from '@/components/inventory/OpeningStockCount';
import { ReceiveDialog } from '@/components/inventory/ReceiveDialog';
import { userCan } from '@/lib/can';
import {
  IDLE_WINDOW_DAYS,
  MIN_DELIVERED_LINES,
  MIN_LEDGER_DAYS,
  byUrgency,
  type StockAlert,
  type StockHealth,
  type StockState,
} from '@/lib/stock-health';
import { ProductPicker } from '@/components/ui/ProductPicker';
import { onTheWire, typedNumber } from '@/lib/typed-box';

/**
 * WHAT IS LEFT — AND WHETHER THAT IS TOO MUCH, TOO LITTLE, OR RIGHT.
 *
 * The owner's note, verbatim: «ارصدة المخزون: تنظيم أكثر — AI + Score.
 * ملاحظات: قارب على الانتهاء يعني، ماشي بطيء… إلخ. يحتاج مخزون. تنبيهات».
 *
 * What was here printed three numbers per product — دخل، خرج، متبقٍّ — and
 * one green-or-red badge decided by `remaining > 50`. Fifty units is six days
 * of stock for the product that sells eight a day and a lifetime's supply for
 * the one that sells none, and the badge called the first «متوفر» in green.
 * Both readings came out of the same number because the number alone cannot
 * answer the question. So every card now says how fast the product leaves,
 * how long what is left will last, and what that makes it.
 *
 * NOT ONE WORD OF THE VERDICT IS DECIDED HERE. `stock-health.ts` holds the
 * rule and `/api/inventory` applies it; this file renders what it is handed
 * and sorts by it. The screen and the route reading two copies of the same
 * threshold is how «قارب على الانتهاء» ends up meaning twenty-one days in one
 * place and thirty in another, with nobody able to say which is the policy.
 *
 * AND THE NUMBERS THAT ARE NOT THERE ARE NOT DRAWN. A product with two
 * delivered lines behind it shows a dash where the daily rate would be, and
 * the chip says «لا يكفي». On this database that is 107 of 114 products — a
 * wall of «we do not know yet», which is exactly the honest picture of a
 * sales record that is thirteen days old, and a far more useful thing to be
 * handed than 107 confident guesses to buy stock against.
 */

interface StockRow {
  id: string;
  name: string;
  sku: string;
  sourceType: 'PURCHASED' | 'MANUFACTURED';
  produced: number;
  sold: number;
  remaining: number;
  /** Held for open orders — the server's own figure, not a subtraction. */
  reserved: number;
  /** The newest costed price, or null when this product has never been costed; absent without `costs.view`. */
  lastUnitCost?: number | null;
  health: StockHealth;
}

/** A measured number, or a dash — never a plausible-looking stand-in. */
function Figure({
  label,
  value,
  hint,
  strong,
}: {
  label: string;
  value: string | number | null;
  hint?: string;
  strong?: boolean;
}) {
  return (
    <div className="rounded-lg bg-[var(--sys-surface)] p-2 text-center" title={hint}>
      <span className="block text-xs text-[var(--sys-muted)]">{label}</span>
      <span
        className={`tabular-nums text-[var(--sys-heading)] ${strong ? 'text-sm font-black' : 'text-sm font-bold'}`}
        dir="ltr"
      >
        {value === null ? '—' : value}
      </span>
    </div>
  );
}

/** A phone draws this many cards, then asks. A hundred and fourteen at 370px each is a page nobody scrolls to its end. */
const PHONE_PAGE = 20;

export function InventoryBalancesScreen() {
  const { t, currentUser } = useApp();
  const phone = useIsPhone();
  const [pages, setPages] = useState(1);
  /** UX only: the door (`POST /api/inventory`) asks `inventory.adjust` itself. */
  const canReceive = userCan(currentUser, 'inventory.adjust');
  const [stockSummary, setStockSummary] = useState<StockRow[]>([]);
  const [alerts, setAlerts] = useState<StockAlert[]>([]);
  const [ledgerDays, setLedgerDays] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [adjustModalOpen, setAdjustModalOpen] = useState(false);

  // Stock count. NOT a way to add stock: goods come in through production
  // or receiving, where they carry a cost. This is for when the shelf and
  // the system disagree, and you enter what you COUNTED — never a delta.
  // Typing a difference means doing the subtraction in your head at the one
  // moment you are already unsure of the number.
  const [productId, setProductId] = useState('');
  /*
   * THE BOX HOLDS CHARACTERS, AND AN EMPTY ONE COUNTS NOTHING.
   *
   * This was `useState(0)` read by `parseInt(e.target.value, 10) || 0`, and
   * on this screen the number that invents is a WRITE-OFF. The form opens
   * with the first product already chosen — `loadData` does that — so a
   * balance of 480 sat beside a counted quantity of 0 nobody had typed,
   * `difference` was −480, and the only thing between that and the wire
   * was three characters of reason. 480 units off the shelf, FIFO-costed
   * out of the oldest batch, logged as «عُدّ 0 والنظام 480».
   *
   * The door cannot tell the two apart and should not have to:
   * `countedQuantity: count(1_000_000)` has a minimum of zero because an
   * empty shelf is a real count. Here is the only place where «I counted
   * zero» and «I typed nothing» are still two statements.
   */
  const [countedTyped, setCountedTyped] = useState('');
  const [reason, setReason] = useState('');
  const [modalLoading, setModalLoading] = useState(false);
  const [countError, setCountError] = useState<string | null>(null);
  const [term, setTerm] = useState('');

  /**
   * «استلام» — THE RECEIVING DOOR, ON THE CARD.
   *
   * It was its own screen (`/inventory/receiving`) with a second list of the
   * same products. The dialog it opened is `ReceiveDialog`, unchanged; the
   * only new thing is where it is pressed.
   *
   * ARRIVING FROM ONE PRODUCT, AT THAT PRODUCT: `?product=<id>` opens that
   * product's dialog straight away (the product page's «إضافة مخزون» and the
   * old `/inventory/receiving?product=` address, which redirects here, both
   * carry it). DERIVED from the URL and the list rather than set in an effect,
   * so there is no «have I already done this» flag — a closed dialog is
   * `dismissed` and stays closed while the parameter is still in the address.
   */
  const asked = useSearchParams().get('product');
  const [receiving, setReceiving] = useState<StockRow | null>(null);
  const [receivedDismissed, setReceivedDismissed] = useState(false);
  const [received, setReceived] = useState<string | null>(null);

  /** Which alert the reader pressed. One at a time — a screen, not a query builder. */
  const [only, setOnly] = useState<StockState | 'restock' | null>(null);
  /** Which card has its score opened. A grade whose bands are hidden is a grade. */
  const [openBands, setOpenBands] = useState<string | null>(null);

  const loadData = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/inventory');
      if (res.ok) {
        const data = await res.json();
        setStockSummary(data.stockSummary || []);
        setAlerts(data.alerts || []);
        setLedgerDays(typeof data.ledgerDays === 'number' ? data.ledgerDays : null);
        if (data.stockSummary?.length > 0 && !productId) {
          setProductId(data.stockSummary[0].id);
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

  const handleAdjustStock = async (e: React.FormEvent) => {
    e.preventDefault();
    // The picker carries no `required` — the form says so itself.
    if (!productId) { setCountError('اختر المنتج أوّلاً.'); return; }
    setModalLoading(true);
    setCountError(null);
    try {
      const res = await fetch('/api/inventory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        /*
         * THE CHARACTERS, or nothing at all. `onTheWire` returns
         * `undefined` for an empty box and `JSON.stringify` drops the key,
         * so the door sees an absent field and refuses it by name — rather
         * than a zero this component invented on a person's behalf.
         */
        body: JSON.stringify({
          action: 'recount',
          productId,
          countedQuantity: onTheWire(countedTyped),
          reason,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'تعذر تسجيل الجرد');
      setAdjustModalOpen(false);
      setReason('');
      setCountedTyped('');
      loadData();
    } catch (e: any) {
      setCountError(e.message || 'تعذر تسجيل الجرد');
    } finally {
      setModalLoading(false);
    }
  };

  /**
   * WORST FIRST, always, and the order is not a setting.
   *
   * 114 cards in catalogue order means the one product about to run out is
   * somewhere below the fold with nothing marking it. The comparator lives in
   * `stock-health` so the API could sort the same way if it ever needs to.
   */
  useEffect(() => setPages(1), [term, only]);

  const visible = useMemo(() => {
    const q = term.trim();
    return stockSummary
      .filter((s) => {
        if (only === 'restock' && !s.health.needsRestock) return false;
        if (only !== null && only !== 'restock' && s.health.state !== only) return false;
        if (!q) return true;
        return s.name.includes(q) || (s.sku || '').toUpperCase().includes(q.toUpperCase());
      })
      .slice()
      .sort((a, b) => byUrgency(a.health, b.health));
  }, [stockSummary, term, only]);

  /**
   * THE WINDOW'S SENTENCE, drawn once. A desk prints it under the alerts on every visit; a phone folds it behind
   * «كيف تُحسب السرعة؟» (three or four lines on every visit pushed the search and the first card down), and the
   * fold is a native disclosure that says what is inside.
   */
  const windowNote = (inFold: boolean) => (
    <p className={inFold ? 'w-full text-xs leading-relaxed text-[var(--sys-muted-foreground)]' : 'mt-2.5 text-xs leading-relaxed text-[var(--sys-muted-foreground)]'}>
      {ledgerDays === null || ledgerDays < MIN_LEDGER_DAYS ? (
        <>
          سجل التسليمات لا يعود لأكثر من {ledgerDays ?? 0} يوم، و{MIN_LEDGER_DAYS} أيام هي أقلّ ما
          تُقاس به سرعةُ بيع — فلا معدَّل يومياً على هذه الشاشة بعد.
        </>
      ) : (
        <>
          سرعة البيع مقيسة على آخر {ledgerDays} يوماً — وهو عمق سجل التسليمات نفسه، لا مدّةً
          مختارة. منتجٌ تحت {MIN_DELIVERED_LINES} تسليمات لا يُعطى معدَّلاً، و«راكد» لا تُقال قبل{' '}
          {IDLE_WINDOW_DAYS} يوماً على الرف.
        </>
      )}
    </p>
  );

  /** The cards drawn: all of them on a desk, a page at a time on a phone. */
  const cards = phone ? visible.slice(0, PHONE_PAGE * pages) : visible;

  const linked = useMemo(() => {
    if (receivedDismissed || !asked || !canReceive || stockSummary.length === 0) {
      return { row: null as StockRow | null, message: null as string | null };
    }
    const row = stockSummary.find((s) => s.id === asked) ?? null;
    if (row?.sourceType === 'PURCHASED') return { row, message: null };
    // A made product comes in through a production run; opening this dialog for
    // it would end in the server's WRONG_DOOR after the quantity was typed.
    return {
      row: null,
      message: row
        ? `«${row.name}» منتج مصنّع — تُضاف كميته من «تشغيلات الإنتاج» ببنود كلفتها، لا من هنا.`
        : 'لم يُعثر على هذا المنتج في هذا المتجر.',
    };
  }, [asked, canReceive, stockSummary, receivedDismissed]);
  /** The dialog the reader opened, or the one the link asked for. */
  const receiveFor = receiving ?? linked.row;

  const selected = stockSummary.find((s) => s.id === productId);
  const systemQty = selected?.remaining ?? 0;
  /** No arithmetic on a box that says nothing — `null`, not a zero. */
  const counted = typedNumber(countedTyped);
  const difference = typeof counted === 'number' ? counted - systemQty : null;

  return (
    <>
      <div className="space-y-6">
        <PageHeader
          title={routeLabel('/inventory/balances')}
          description="كم بقي من كل منتج، وكم يخرج منه يومياً، وكم يوماً يكفي ما بقي."
          actions={
            <>
              <Button size="sm" onClick={() => setAdjustModalOpen(true)} className="flex items-center space-x-1.5">
                <RiArrowUpDownLine className="w-4 h-4" />
                <span>جرد مخزون</span>
              </Button>
            </>
          }
        />

        {/* Before anything else, once: the store's stock has never been
            counted. It is not a warning that repeats — the server refuses the
            count after the first movement and this disappears with it. */}
        <OpeningStockCountBanner onCounted={loadData} />

        {received && (
          <p className="text-sm text-[var(--sys-success)] bg-[var(--sys-success-soft)] border border-[var(--sys-success)]/30 rounded-lg p-3">
            {received}
          </p>
        )}
        {linked.message && (
          <p className="text-sm text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] rounded-lg p-3">
            {linked.message}
          </p>
        )}

        {/* THE ALERTS — the owner's «تنبيهات».
            Counted by the server over the whole store, not by this component
            over the list it happens to be showing: an alert row that counts
            the filtered page tells you about your own filter. Each one is a
            filter, so a count is never a dead end. */}
        {alerts.length > 0 && (
          <div className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] p-3">
            <div className="flex flex-wrap items-center gap-2">
              {alerts.map((a) => {
                const active = only === a.state;
                return (
                  <button
                    key={a.state}
                    type="button"
                    onClick={() => setOnly(active ? null : a.state)}
                    aria-pressed={active}
                    className={`inline-flex min-h-11 items-center rounded-lg p-0.5 md:min-h-0 ${active ? 'ring-2 ring-[var(--sys-primary)]' : ''}`}
                  >
                    <HealthChip
                      health={{
                        tone: a.tone,
                        label: `${a.ar} · ${a.count}`,
                        why: active ? 'اضغط لإلغاء التصفية' : `اعرض ${a.count} منتجاً في هذه الحالة فقط`,
                      }}
                    />
                  </button>
                );
              })}
              {only !== null && (
                <button
                  type="button"
                  onClick={() => setOnly(null)}
                  className="inline-flex min-h-11 items-center text-xs font-medium text-[var(--sys-primary)] hover:underline md:min-h-0"
                >
                  اعرض الكل
                </button>
              )}
            </div>

            {/* THE WINDOW, SAID OUT LOUD. Every rate on this screen is units
                divided by this number of days, and a reader who does not know
                it cannot judge any of them. On a young record it is also the
                explanation for most of the screen saying «لا يكفي». */}
            {phone ? (
              <div className="mt-2.5">
                <AdvancedGroup label="كيف تُحسب السرعة؟">{windowNote(true)}</AdvancedGroup>
              </div>
            ) : (
              windowNote(false)
            )}
          </div>
        )}

        {/* 114 cards need a way in, so the search comes before them rather
            than after the scroll. */}
        <div className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] p-3">
          <input
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="ابحث باسم المنتج أو رمزه…"
            className="w-full min-w-0 h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm"
          />
          <p className="mt-1.5 text-xs text-[var(--sys-muted-foreground)]">
            {visible.length} من {stockSummary.length} منتج — الأسوأ أوّلاً
          </p>
        </div>

        {!loading && stockSummary.length > 0 && visible.length === 0 && (
          <p className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] p-4 text-sm text-[var(--sys-muted-foreground)]">
            لا منتجَ يطابق ما اخترته.
          </p>
        )}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {cards.map((s) => {
            const h = s.health;
            const bandsOpen = openBands === s.id;
            const shelfFigure = <Figure label="على الرف" value={s.remaining} hint="ما تحمله دفعات هذا المستودع فعلاً." />;
            const reservedFigure = (
              <Figure label="محجوز" value={s.reserved} hint="موعودٌ به لطلبات مفتوحة — لا يُوعَد به مرّتين." />
            );
            const availableFigure = <Figure label="متاح" value={h.available} strong hint="ما يمكن أن يأخذه طلبٌ جديد." />;
            const perDayFigure = (
              <Figure
                label="يومياً"
                value={h.perDay}
                hint={
                  h.perDay === null
                    ? `لا معدَّل: العيّنة تحت ${MIN_DELIVERED_LINES} تسليمات أو السجل أقصر من ${MIN_LEDGER_DAYS} أيام.`
                    : `${h.perDay} وحدة يومياً، مقيسةً على ${h.windowDays} يوماً من التسليمات.`
                }
              />
            );
            const coverFigure = (
              <Figure
                label="تكفي (يوم)"
                value={h.coverDays === null ? null : Math.round(h.coverDays)}
                hint={
                  h.coverDays === null
                    ? 'لا معدَّلَ يوميّاً تُحسب به مدّةُ الكفاية.'
                    : 'المتاح مقسوماً على المعدَّل اليومي.'
                }
              />
            );
            const scoreFigure = (
              <Figure
                label="الدرجة"
                value={h.score}
                strong
                hint={
                  h.score === null
                    ? 'لا درجة: مدّةُ الكفاية — وهي 55 من 100 — لا تُحسب لهذا المنتج.'
                    : `${h.score} من 100. اضغط «من أين الدرجة؟» لبنودها.`
                }
              />
            );
            return (
              <Card key={s.id}>
                <CardContent className={phone ? 'p-4 space-y-3' : 'p-5 space-y-3'}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <span className="font-mono text-xs font-bold text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] px-2 py-0.5 rounded-lg">
                        {s.sku}
                      </span>
                      <a
                        href={`/products/${s.id}`}
                        className="mt-1 block text-sm font-bold text-[var(--sys-heading)] hover:text-[var(--sys-primary)]"
                      >
                        {s.name}
                      </a>
                      {/* Which door adds to this one — the question you ask
                          the moment you see it is running out. */}
                      <span className="mt-1 inline-block rounded-full bg-[var(--sys-surface-strong)] px-2 py-0.5 text-xs font-semibold text-[var(--sys-foreground)]">
                        {s.sourceType === 'PURCHASED' ? 'جاهز — يُستلم' : 'مصنّع — تشغيلة'}
                      </span>
                    </div>
                    {/* The verdict, in the product's one verdict chip. */}
                    <HealthChip health={h} className="shrink-0" />
                  </div>

                  {/* THE REASON, PRINTED — not a tooltip nobody finds.
                      «قارب على الانتهاء» tells a reader nothing they can act
                      on. «12 متاحة و1.9 تخرج يومياً — تكفي 6 أيام» tells them
                      how many to buy. */}
                  <p className="text-xs leading-relaxed text-[var(--sys-muted-foreground)]">{h.why}</p>

                  {/*
                    A PHONE READS THREE FIGURES AND UNFOLDS THE REST.
                    Six tiles of two lines each were most of a 370px card. What a buyer needs at a glance is what can be
                    sold, how long it lasts and the score; the shelf, the reserved and the daily rate are one tap down,
                    in a disclosure that names them. A desk draws the six, in the order it always has.
                  */}
                  {phone ? (
                    <>
                      <div className="grid grid-cols-3 gap-2 pt-1">
                        {availableFigure}
                        {coverFigure}
                        {scoreFigure}
                      </div>
                      <AdvancedGroup label="باقي الأرقام" holds="على الرف · محجوز · يومياً">
                        <div className="grid w-full grid-cols-3 gap-2">
                          {shelfFigure}
                          {reservedFigure}
                          {perDayFigure}
                        </div>
                      </AdvancedGroup>
                    </>
                  ) : (
                    <div className="grid grid-cols-3 gap-2 pt-1">
                      {shelfFigure}
                      {reservedFigure}
                      {availableFigure}
                      {perDayFigure}
                      {coverFigure}
                      {scoreFigure}
                    </div>
                  )}

                  <div className={phone ? 'flex flex-wrap items-center justify-between gap-2 pt-1' : 'flex items-center justify-between gap-2 pt-1'}>
                    <span className="text-xs text-[var(--sys-muted)]">
                      دخل {s.produced} · خرج {s.sold}
                    </span>
                    {/* Only a product you BUY ready comes in here; a made one
                        has «تشغيلة» on its chip and its own door. On a phone the press is across the card, 44px:
                        the main action of the card was the smallest thing on it. */}
                    {canReceive && s.sourceType === 'PURCHASED' &&
                      (phone ? (
                        <Button size="sm" className="w-full" onClick={() => setReceiving(s)}>
                          استلام
                        </Button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setReceiving(s)}
                          className="text-xs font-medium text-[var(--sys-primary)] hover:underline"
                        >
                          استلام
                        </button>
                      ))}
                    {h.bands.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setOpenBands(bandsOpen ? null : s.id)}
                        aria-expanded={bandsOpen}
                        className="inline-flex min-h-11 items-center text-xs font-medium text-[var(--sys-primary)] hover:underline md:min-h-0"
                      >
                        {bandsOpen ? 'أخفِ البنود' : 'من أين الدرجة؟'}
                      </button>
                    )}
                  </div>

                  {/* A score whose bands are hidden is a number people work
                      around. Each band names the fact it measured, what that
                      fact was, and what it earned out of its fixed weight. */}
                  {bandsOpen && (
                    <ul className="space-y-1.5 rounded-lg bg-[var(--sys-surface)] p-2.5">
                      {h.bands.map((b) => (
                        <li key={b.key} className="text-xs leading-relaxed">
                          <span className="font-semibold text-[var(--sys-heading)]">{b.ar}</span>{' '}
                          <span className="tabular-nums text-[var(--sys-foreground)]" dir="ltr">
                            {Math.round(b.earned)}/{b.weight}
                          </span>
                          <span className="block text-[var(--sys-muted-foreground)]">{b.why}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>

        {phone && visible.length > cards.length && (
          <Button variant="outline" className="w-full" onClick={() => setPages((n) => n + 1)}>
            اعرض المزيد ({visible.length - cards.length})
          </Button>
        )}

        {/* THE MOVEMENTS LOG IS NOT REDRAWN HERE.
            It was — the whole table, eight columns of it — while
            /inventory/movements existed as its own screen. So the same log
            appeared twice under two names, and nobody could tell which was
            the record. This screen answers "how much is left"; that one
            answers "what happened". */}
        <p className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] p-4 text-sm text-[var(--sys-muted-foreground)]">
          تبحث عمّا دخل وما خرج ومن سجّله؟{' '}
          <a href="/inventory/movements" className="font-medium text-[var(--sys-primary)] hover:underline">
            سجل حركات المخزون
          </a>{' '}
          — هذه الشاشة تقول كم بقي، وتلك تقول ماذا حدث.
        </p>
      </div>

      {receiveFor && (
        <ReceiveDialog
          product={receiveFor}
          onClose={() => {
            setReceiving(null);
            // A closed dialog stays closed, even with `?product=` still in the address.
            setReceivedDismissed(true);
          }}
          onSaved={async (message) => {
            setReceiving(null);
            setReceivedDismissed(true);
            setReceived(message);
            loadData();
          }}
        />
      )}

      {/* Stock count. Adding stock is not a count: goods enter through
          production or «استلام» (above), where they carry a cost. */}
      <Modal
        isOpen={adjustModalOpen}
        onClose={() => setAdjustModalOpen(false)}
        title="جرد مخزون"
        subtitle="عندما يختلف الرف عن النظام — تُدخل ما عددته، والفرق يُحسب ويُسجَّل"
      >
        <form onSubmit={handleAdjustStock} className="space-y-4">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-[var(--sys-heading)]">
              المنتج *
            </label>
            {/*
              «لما أضيف منتج … ما بطلع بحث». A `<select>` over a hundred
              products is a scroll, and the list it opens is painted by the
              browser. `LandingPageDetailScreen` measured that and moved to
              the picker; this field and the production run were the two
              left behind.

              The option text used to carry «النظام يقول N». Nothing is lost:
              «رصيد النظام» below shows the same number the moment a product
              is chosen, beside the counted quantity it is there to be
              compared with.
            */}
            <ProductPicker
              products={stockSummary.map((s) => ({ id: s.id, name: s.name, sku: s.sku }))}
              value={productId}
              onChange={(id) => { setProductId(id); setCountedTyped(''); }}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-[var(--sys-heading)]">رصيد النظام</label>
              <div className={`rounded-lg border border-[var(--sys-border)] bg-[var(--sys-surface)] px-3 ${phone ? 'flex h-11 items-center' : 'py-2'} text-sm font-bold tabular-nums text-[var(--sys-muted-foreground)]`} dir="ltr">
                {systemQty}
              </div>
            </div>
            <Input
              label="الكمية المعدودة *"
              type="number"
              min="0"
              dir="ltr"
              value={countedTyped}
              onChange={(e) => setCountedTyped(e.target.value)}
              required
            />
          </div>

          {/* The difference is shown, not typed: it is the number that will
              actually be written, so it should be read before it is. */}
          <div
            className={`rounded-lg border p-3 text-center ${
              difference === null || difference === 0
                ? 'border-[var(--sys-border)] bg-[var(--sys-surface)]'
                : difference > 0
                  ? 'border-[var(--sys-success-soft)] bg-[var(--sys-success-soft)]'
                  : 'border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)]'
            }`}
          >
            <p className="text-xs font-medium text-[var(--sys-muted-foreground)]">الفرق الذي سيُسجَّل</p>
            <p
              className={`mt-0.5 text-lg font-black tabular-nums ${
                difference === null || difference === 0
                  ? 'text-[var(--sys-muted-foreground)]'
                  : difference > 0
                    ? 'text-[var(--sys-success)]'
                    : 'text-[var(--sys-destructive)]'
              }`}
              dir="ltr"
            >
              {difference === null ? '—' : difference > 0 ? `+${difference}` : difference}
            </p>
            <p className="mt-0.5 text-xs text-[var(--sys-muted-foreground)]">
              {difference === null
                ? 'اكتب الكمية المعدودة ليظهر الفرق.'
                : difference === 0
                ? 'الجرد مطابق — لن يُسجَّل شيء.'
                : difference > 0
                  ? 'وُجد أكثر مما يعرفه النظام — يدخل بتكلفة المخزون الحالي لا بصفر.'
                  : 'ناقص عن النظام — يُخصم من أقدم دفعة.'}
            </p>
          </div>

          <Textarea
            label="سبب الفرق *"
            placeholder="مثال: جرد نهاية الشهر، تالف أثناء التخزين، خطأ في تسجيل سابق…"
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required
          />

          {countError && <p className="text-xs text-[var(--sys-destructive)]">{countError}</p>}

          <p className="rounded-lg bg-[var(--sys-surface)] p-2.5 text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
            إضافة بضاعة جديدة لا تتم من هنا: ما تصنعه يدخل من «تشغيلات الإنتاج»
            ببنود كلفته، وما تشتريه جاهزاً من «استلام بضاعة جاهزة» بسعر شرائه.
            البضاعة التي تدخل بلا تكلفة تخفض متوسط التكلفة وتُظهر ربحاً لم يتحقق.
          </p>

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setAdjustModalOpen(false)}>
              {t.cancel}
            </Button>
            <Button type="submit" loading={modalLoading} disabled={difference === null || difference === 0 || reason.trim().length < 3}>
              سجّل الجرد
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
