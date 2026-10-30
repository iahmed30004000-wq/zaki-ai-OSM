'use client';

import React, { useState, useEffect } from 'react';
import { onTheWire } from '@/lib/typed-box';
import { Card, CardHeader, CardContent, KpiCard } from '@/components/ui/Card';
import { Money } from '@/components/ui/Money';
import { Button } from '@/components/ui/Button';
import { Input, Select, Textarea } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Badge } from '@/components/ui/Badge';
import { useApp } from '@/context/AppContext';
import { routeLabel } from '@/lib/route-registry';
// The one Arabic date format the rest of the product uses. This screen drew
// its own with `format(..., 'MMM d, yyyy')`, printing «Sep 29, 2026» down an
// Arabic column in an Arabic table.
import { arDate } from '@/lib/format';
import { apiJson } from '@/lib/api-client';
import { userCan } from '@/lib/can';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { ZERO_SUMMARY, type ProfitSummary } from '@/lib/profit-summary';
import { RiAddCircleLine, RiArrowRightDownLine, RiArrowUpCircleLine, RiFileList3Line, RiMoneyDollarCircleLine } from '@remixicon/react';
import { PageHeader } from '@/components/ui/PageHeader';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { Rows } from '@/components/ui/Rows';
import { useIsPhone } from '@/hooks/useIsPhone';
import { EmptyState } from '@/components/ui/EmptyState';
// `Record<SpendDirection, ...>` below is the exhaustiveness guard: a new
// direction added to the rule fails this file at compile time rather than
// rendering an undefined chip.
import {
  categoryLabel,
  EXPENSE_CATEGORY_AR,
  EXPENSE_FORM_HINT,
  EXPENSE_FORM_LABEL,
  EXPENSE_FORM_ORDER,
  type ExpenseCategory,
  type ExpenseTypeGrade,
  type SpendDirection,
} from '@/lib/expense-grade';
import type { Trust } from '@/lib/cod-vitals';

/**
 * ─── WHERE THE MONEY GOES, BY KIND OF SPENDING ───
 *
 * «المصاريف لازم Score لنوع المصروف». The ledger below this lists rows and
 * nothing added them up per type, so the one question an owner has about
 * spending had no answer anywhere in this product.
 *
 * WHAT THIS IS NOT, AND THE REFUSAL IS THE POINT. It is not a «worth it»
 * score. «Worth it» is a ratio of what a kind of spending RETURNED to what
 * it cost, and no expense row in this database links to anything it bought:
 * `referenceId` is the only candidate field and it is documented as «batchId
 * or orderId», which ties an expense to a production batch at best and to
 * nothing at all for marketing. A score built on an assumed return would
 * rank assumptions — which is exactly how this product's intelligence layer
 * came to grade every customer the same and had to be abandoned.
 *
 * WHAT IT IS: two numbers and a direction, all three derived. The share of
 * all spending, the share of DELIVERED revenue, and — the only graded part —
 * whether this type's bite grew or shrank against the SAME type last month.
 * A comparison against yourself needs no invented threshold; a comparison
 * against an ideal needs one nobody has.
 */
const DIRECTION_AR: Record<SpendDirection, { label: string; cls: string }> = {
  // A bigger bite out of revenue is the «quiet bleed» the note is about.
  GROWING: { label: 'نصيبه يكبر', cls: 'bg-[var(--sys-destructive-soft)] text-[var(--sys-destructive)] border-[var(--sys-destructive-border)]' },
  SHRINKING: { label: 'نصيبه يصغر', cls: 'bg-[var(--sys-success-soft)] text-[var(--sys-success)] border-[var(--sys-success)]/30' },
  STEADY: { label: 'ثابت', cls: 'bg-[var(--sys-surface)] text-[var(--sys-muted-foreground)] border-[var(--sys-border)]' },
  // Not «grew» — it did not exist before. A different thing to look into,
  // and it gets its own word rather than an infinite growth percentage.
  NEW: { label: 'بند جديد', cls: 'bg-[var(--sys-warning-soft)] text-[var(--sys-warning)] border-[var(--sys-warning)]/30' },
  UNKNOWN: { label: 'لا يكفي', cls: 'bg-[var(--sys-surface)] text-[var(--sys-muted-foreground)] border-[var(--sys-border)]' },
};

/**
 * WHAT THE AMOUNT BOX PUTS ON THE WIRE: its characters, or nothing at all.
 *
 * The same reader `ManufacturingScreen` and `ProductsScreen` send their
 * money boxes with, for the same defect. This screen's box was
 *
 *     const [amount, setAmount] = useState(100);
 *     onChange={(e) => setAmount(parseFloat(e.target.value) || 0)}
 *
 * — two faults sitting on top of each other, both about money LEAVING:
 *
 *   · THE 100 EXISTS NOWHERE ON THE SERVER. `Expense.amount` is `Float`
 *     with no default; the seed writes no expense at all; the door invents
 *     nothing. It was a browser-only number, and the dialog opened with it
 *     already filled in — so typing a title, choosing a wallet and pressing
 *     «احفظ المصروف» recorded an expense of 100 that nobody entered, and
 *     expenses subtract from net profit.
 *   · A CLEARED BOX WAS A TYPED ZERO. `parseFloat('') || 0` is `0`, the box
 *     redrew as `0`, and the door's own refusal was unreachable from the
 *     only screen that uses it — the browser answered the door's question
 *     before the door could.
 *
 * `undefined` is the third answer and `JSON.stringify` DROPS an `undefined`
 * property, so an EMPTY BOX IS ABSENT ON THE WIRE and the door decides what
 * absent means. And what is sent for a filled box is the CHARACTERS, not a
 * number this component re-derived: `numeric-input.ts` is stricter than
 * `Number()`, so handing it the characters is the only way its refusal can
 * be about what a person actually typed.
 */

function SpendByType({
  spend,
  currency,
  onRecord,
}: {
  /** «سجّل مصروفاً» — the header's act, offered where nothing has been recorded yet. */
  onRecord?: () => void;
  spend?: {
    byType: ExpenseTypeGrade[];
    rows: number;
    totalSpend: number;
    deliveredRevenue: number;
    priorDeliveredRevenue: number | null;
    hasPrevious: boolean;
    ledger: Trust;
  };
  currency?: string;
}) {
  if (!spend) return null;

  return (
    <Card>
      <CardHeader
        title="المصاريف حسب النوع — هذا الشهر"
        subtitle="نصيب كل بند من الإيراد المسلَّم، ومقارنته بنصيبه في الشهر الماضي — لا بمبلغه، فالشهر الأكبر بيعاً يصرف أكثر بلا أن ينزف"
      />
      <CardContent className="p-0">
        {spend.byType.length === 0 ? (
          <div className="p-4">
            {/*
              THE HONEST EMPTY STATE, WITH THE COUNT.

              Measured on the live database: ZERO expense rows have ever been
              recorded in this system. Not «no expenses this month» — none,
              ever. Which also means the net profit above subtracts nothing
              for overheads, and this is the one place on the screen that can
              say so to the person who would fix it.
            */}
            <EmptyState
              title="لا مصروف مسجَّل في هذا الشهر"
              why="بلا مصاريف مسجَّلة، صافي الربح أعلاه يطرح صفراً مقابل الرواتب والإيجار والإعلان — فهو إيراد ناقص كلفة البضاعة، لا صافي. سجّل المصروف وقتَ حدوثه ليظهر نصيب كل بند هنا."
              action={onRecord ? { label: 'سجّل أول مصروف', onClick: onRecord } : undefined}
            />
          </div>
        ) : (
          <>
            <ul className="divide-y divide-[var(--sys-border)]">
              {spend.byType.map((g) => (
                <li key={g.category} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-5 py-3">
                  <span className="text-sm font-bold text-[var(--sys-heading)]">{g.label}</span>
                  {/* A type the label map has never heard of is named as it
                      was stored AND flagged, so a typo cannot hide inside a
                      composition that still adds up to a hundred. */}
                  {!g.known && <span className="text-xs text-[var(--sys-warning)]">نوع غير معروف</span>}
                  <span className="text-xs text-[var(--sys-muted)] tabular-nums">{g.rows} مصروف</span>

                  <span className={`rounded-md border px-2 py-0.5 text-xs font-medium ${DIRECTION_AR[g.direction].cls}`} title={g.why}>
                    {DIRECTION_AR[g.direction].label}
                  </span>

                  <span className="ms-auto flex flex-wrap items-baseline gap-x-3 gap-y-1 tabular-nums">
                    {/* The burden carries no verdict of its own. Nobody can
                        say what share of revenue office costs ought to be,
                        and a bar invented per type would be nine verdicts
                        dressed as arithmetic. */}
                    <span className="text-xs text-[var(--sys-muted-foreground)]">
                      {g.burden === null ? '—' : `${g.burden}% من الإيراد`}
                    </span>
                    <span className="text-xs text-[var(--sys-muted-foreground)]">
                      {g.shareOfSpend === null ? '—' : `${g.shareOfSpend}% من المصروف`}
                    </span>
                    <span className="text-sm font-bold text-[var(--sys-heading)]">
                      <Money value={g.amount} currency={currency} />
                    </span>
                  </span>

                  {/* The reason, printed rather than left in a tooltip: a
                      verdict whose figures are hidden is a verdict people
                      argue with instead of acting on. */}
                  <span className="w-full text-xs text-[var(--sys-muted)]">{g.why}</span>
                </li>
              ))}
            </ul>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-[var(--sys-border)] px-5 py-3 text-xs text-[var(--sys-muted-foreground)]">
              <span className="tabular-nums">
                {spend.rows} مصروف · <Money value={spend.totalSpend} currency={currency} /> هذا الشهر
              </span>
              <span className="tabular-nums">
                مقابل إيراد مسلَّم <Money value={spend.deliveredRevenue} currency={currency} />
              </span>
              {!spend.hasPrevious && <span>لا شهر سابق للمقارنة — الاتجاهات تظهر الشهر القادم.</span>}
              {/* Every figure above assumes the ledger is a complete record of
                  what left the shop. The wallet is what ties an expense to
                  money actually leaving, and the schema says why it matters:
                  an expense with no wallet makes the daily closing show a
                  shortfall nobody can explain. */}
              {spend.ledger.level !== 'STATED' && <span>{spend.ledger.ar}</span>}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function FinanceProfitScreen() {
  const { t, currentUser } = useApp();
  const [data, setData] = useState<any>(null);
  // Per-product profit, from the endpoint that had no screen.
  const [profitability, setProfitability] = useState<any[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [expenseModalOpen, setExpenseModalOpen] = useState(false);

  // Expense Form State
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('MARKETING');
  // EMPTY, AND THERE IS NO DEFAULT AMOUNT ANYWHERE — not here, not in
  // `schema.prisma` (`Expense.amount Float`, no `@default`), not in the
  // door, not in the seed. An expense has no default amount: nobody can
  // guess what a thing cost. See `onTheWire` above for the 100 that sat
  // here, and for what a cleared box used to send.
  const [amount, setAmount] = useState('');
  const [expenseDate, setExpenseDate] = useState(new Date().toISOString().split('T')[0]);
  const [notes, setNotes] = useState('');
  const [modalLoading, setModalLoading] = useState(false);

  const loadFinance = async () => {
    setLoading(true);
    try {
      fetch('/api/finance/profitability?limit=20')
        .then((r) => (r.ok ? r.json() : { products: [] }))
        .then((d) => setProfitability(d.products ?? d ?? []))
        .catch(() => setProfitability([]));
      const res = await fetch('/api/finance');
      if (res.ok) {
        const json = await res.json();
        setData(json);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  // A screen left open stays true: it reads again when the person comes back to it (and on first open).
  useLiveRefresh(loadFinance);

  /** The wallet the money leaves, and what the server said if it refused. */
  const [walletId, setWalletId] = useState('');
  const [wallets, setWallets] = useState<{ id: string; name: string; currencyCode: string }[]>([]);
  const [expenseError, setExpenseError] = useState<string | null>(null);

  useEffect(() => {
    if (!expenseModalOpen || wallets.length > 0) return;
    apiJson<{ wallets: { id: string; name: string; currencyCode: string }[] }>('/api/finance/wallets')
      .then((d: { wallets: { id: string; name: string; currencyCode: string }[] }) => setWallets(d.wallets ?? []))
      .catch(() => setWallets([]));
  }, [expenseModalOpen, wallets.length]);

  /*
   * CANCELLING AN EXPENSE (not deleting it). Its money goes back to the wallet it left and it leaves the profit;
   * the row stays on the list, marked «ملغى». The door asks «تعديل المالية», and so does the button.
   */
  const mayCancel = userCan(currentUser, 'finance.update');
  const [cancelling, setCancelling] = useState<any>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);

  const handleCancelExpense = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cancelling) return;
    setCancelBusy(true);
    setCancelError(null);
    try {
      await apiJson('/api/finance', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expenseId: cancelling.id, reason: cancelReason }),
      });
      setCancelling(null);
      setCancelReason('');
      loadFinance();
    } catch (err) {
      setCancelError(err instanceof Error ? err.message : 'تعذّر إلغاء المصروف');
    } finally {
      setCancelBusy(false);
    }
  };

  const handleRecordExpense = async (e: React.FormEvent) => {
    e.preventDefault();
    setModalLoading(true);
    try {
      const res = await fetch('/api/finance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, category, amount: onTheWire(amount), expenseDate, notes, walletId }),
      });
      if (res.ok) {
        setExpenseModalOpen(false);
        setTitle('');
        // CLEARED TOO. It was not, so the amount of the expense just saved
        // stayed in the box for the next one — which is the same defect the
        // 100 was, only with a number that had at least been typed once.
        setAmount('');
        setNotes('');
        setExpenseError(null);
        loadFinance();
      } else {
        // Said out loud. A form that closes on a refusal is a form somebody
        // believes worked, and an expense they never record again.
        const body = await res.json().catch(() => ({}));
        setExpenseError(body.error ?? 'تعذّر تسجيل المصروف');
      }
    } catch (e) {
      setExpenseError(e instanceof Error ? e.message : 'تعذّر تسجيل المصروف');
    } finally {
      setModalLoading(false);
    }
  };

  // The phone reads the equation as a receipt and the product list as cards; the desk keeps the five tiles and the row.
  const phone = useIsPhone();

  // The server's shape, not a second one written here. The hand-written
  // copy was missing `shippingAndCommissions`, and the line that reads it
  // took the whole screen down whenever the server did not answer.
  const summary: ProfitSummary = data?.summary ?? ZERO_SUMMARY;

  return (
    <>
      <div className="space-y-6">
        {/* Header */}
        <PageHeader title={routeLabel('/finance/profit')}
            description="الربح من الموصَّل فقط — ناقص كلفة البضاعة والشحن والعمولات والمصاريف"
            actions={
              <><Button
            size="sm"
            onClick={() => setExpenseModalOpen(true)}
            className="flex items-center space-x-1.5"
          >
            <RiAddCircleLine className="w-4 h-4" />
            <span>سجّل مصروفاً</span>
          </Button></>
            }
          />

        {/* Real Profit KPI Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <KpiCard
            title="إيراد الموصَّل"
            rule="مجموع المحصَّل فعلاً للطلبات اللي انحصّلت، زائد إجمالي الموصَّلة اللي ما انسجّل إلها تحصيل. الموصَّل وحده، بالمدّة المختارة."
            value={<Money value={summary.totalRevenue} currency={data?.currency} />}
            subtitle="الطلبات المسلَّمة فعلاً، لا المؤكدة"
            icon={RiArrowUpCircleLine}
          />
          <KpiCard
            title="صافي الربح"
            rule="إيراد الموصَّل ناقص كلفة البضاعة ناقص أجور التوصيل ناقص العمولات ناقص المصاريف التشغيليّة. ولا ضريبة ولا رسوم — ما في خانة إلهم بهالنظام."
            value={<Money value={summary.netProfit} currency={data?.currency} />}
            subtitle={`هامش ${summary.profitMargin}%`}
            icon={RiMoneyDollarCircleLine}
          />
          <KpiCard
            title="كلفة البضاعة"
            rule="مجموع كلفة القطع المبيعة بالطلبات الموصَّلة، بالكلفة المخزَّنة وقت البيع — مش بالكلفة الحاليّة، حتى ما يتغيّر ربح الشهر الماضي لمّا تتغيّر كلفة اليوم."
            value={<Money value={summary.totalCOGS} currency={data?.currency} />}
            subtitle="من كلفة التشغيلات — تُدخَل من شاشة التصنيع"
            icon={RiFileList3Line}
          />
          <KpiCard
            title="المصاريف التشغيلية"
            rule="مجموع المصاريف المسجَّلة بالمدّة المختارة. إذا الجدول فاضي الرقم صفر — وطرح صفر وتسميته «صافي» هو نفس السكوت بخانة تانية، فالكرت بيسمّي الفراغ."
            value={<Money value={summary.totalOperationalExpenses} currency={data?.currency} />}
            subtitle="إعلانات وشحن ورواتب وما إليها"
            icon={RiArrowRightDownLine}
          />
        </div>

        {/* Financial Flow Equation */}
        <Card>
          <CardHeader
            title="من أين جاء الربح"
            subtitle="كل رقم مطروح من الذي قبله — المجموع هو ما بقي فعلاً"
          />
          <CardContent>
            {phone ? (
              /*
               * A RECEIPT, NOT FIVE TILES.
               * Five full-width tiles repeated the four figures above them at ~650px, and between 640 and 767 the
               * `sm` five-column grid squeezed text-lg figures into 110px tiles that cannot wrap. One label and one
               * signed figure per line, the net last: the same numbers, read, not computed (the server's own sums).
               */
              <div className="space-y-2">
                {(
                  [
                    ['إيراد الموصَّل', '+', summary.totalRevenue, 'text-[var(--sys-success)]'],
                    ['كلفة البضاعة', '−', summary.totalCOGS, 'text-[var(--sys-destructive)]'],
                    ['شحن وعمولات', '−', summary.shippingAndCommissions, 'text-[var(--sys-destructive)]'],
                    ['مصاريف', '−', summary.totalOperationalExpenses, 'text-[var(--sys-destructive)]'],
                  ] as const
                ).map(([label, sign, figure, tone]) => (
                  <div key={label} className="flex items-center justify-between gap-3 bg-[var(--sys-surface)] px-3 py-2 rounded-lg">
                    <span className="text-xs text-[var(--sys-muted)]">{label}</span>
                    <span className={`text-sm font-bold ${tone}`} dir="ltr">
                      {sign}
                      <Money value={figure} currency={data?.currency} />
                    </span>
                  </div>
                ))}
                <div className="flex items-center justify-between gap-3 bg-[var(--sys-primary)] px-3 py-2 rounded-lg">
                  <span className="text-xs font-bold text-[var(--sys-primary-foreground)]/80">الصافي</span>
                  <span className="text-base font-black text-[var(--sys-primary-foreground)]">
                    <Money value={summary.netProfit} currency={data?.currency} />
                  </span>
                </div>
              </div>
            ) : (
            <div className="grid grid-cols-1 sm:grid-cols-5 gap-3 text-center">
              <div className="bg-[var(--sys-surface)] p-3 rounded-lg">
                <span className="text-xs text-[var(--sys-muted)] block">إيراد الموصَّل</span>
                <span className="text-lg font-bold text-[var(--sys-success)] mt-1 block">
                  +<Money value={summary.totalRevenue} currency={data?.currency} />
                </span>
              </div>
              <div className="bg-[var(--sys-surface)] p-3 rounded-lg">
                <span className="text-xs text-[var(--sys-muted)] block">كلفة البضاعة</span>
                <span className="text-lg font-bold text-[var(--sys-destructive)] mt-1 block">
                  −<Money value={summary.totalCOGS} currency={data?.currency} />
                </span>
              </div>
              <div className="bg-[var(--sys-surface)] p-3 rounded-lg">
                <span className="text-xs text-[var(--sys-muted)] block">شحن وعمولات</span>
                <span className="text-lg font-bold text-[var(--sys-destructive)] mt-1 block">
                  {/* Read, not computed. A total assembled in the browser
                      disagrees with the books the moment a rule changes. */}
                  −<Money value={summary.shippingAndCommissions} currency={data?.currency} />
                </span>
              </div>
              <div className="bg-[var(--sys-surface)] p-3 rounded-lg">
                <span className="text-xs text-[var(--sys-muted)] block">مصاريف</span>
                <span className="text-lg font-bold text-[var(--sys-destructive)] mt-1 block">
                  −<Money value={summary.totalOperationalExpenses} currency={data?.currency} />
                </span>
              </div>
              <div className="bg-[var(--sys-primary)] p-3 rounded-lg">
                <span className="text-xs text-[var(--sys-primary-foreground)]/80 block font-bold">الصافي</span>
                <span className="text-xl font-black text-[var(--sys-primary-foreground)] mt-1 block">
                  <Money value={summary.netProfit} currency={data?.currency} />
                </span>
              </div>
            </div>
            )}
          </CardContent>
        </Card>

        <SpendByType spend={data?.spend} currency={data?.currency} onRecord={() => setExpenseModalOpen(true)} />

        {/* Expenses Ledger */}
        <Card>
          <CardHeader
            title="سجل المصاريف"
            subtitle="كل مصروف بتاريخه وبندِه — يُخصم مباشرة من صافي الربح"
          />
          <CardContent className="p-0">
            <div className="overflow-x-auto">
                            <Rows
                rows={(data?.expenses ?? [])}
                keyOf={(e: any) => e.id}
                columns={[
                  { key: 'c0', label: "التاريخ", primary: true,
                    render: (e: any) => (arDate(e.expenseDate)) },
                  { key: 'c1', label: "البند", primary: true,
                    render: (e: any) => (
                  <>
                    {e.title}
                    {e.voidedAt && <> <Badge variant="danger">ملغى</Badge></>}
                  </>
                ) },
                  /* The stored value is an enum — MARKETING, PACKAGING — and
                     this printed it raw: Latin capitals in a right-to-left
                     Arabic table whose own form offers «تسويق وإعلانات» for
                     the very same value. `categoryLabel` is the one place
                     that list now lives, and it falls back to the stored
                     string so a renamed or typo'd type is visible rather
                     than folded into «أخرى». */
                  { key: 'c2', label: "النوع",
                    render: (e: any) => (
                  <><Badge variant="purple">{categoryLabel(e.category)}</Badge></>
                ) },
                  { key: 'c3', label: "المبلغ",
                    render: (e: any) => (
                  <><Money value={e.amount} currency={data?.currency} /></>
                ) },
                  { key: 'c4', label: "ملاحظات", wide: true,
                    render: (e: any) => (e.voidedAt ? `أُلغي: ${e.voidReason ?? '—'}` : e.notes || '—') },
                  { key: 'c5', label: "إجراء",
                    render: (e: any) =>
                      mayCancel && !e.voidedAt ? (
                        <Button type="button" size="sm" variant="outline" onClick={() => { setCancelError(null); setCancelling(e); }}>
                          إلغاء المصروف
                        </Button>
                      ) : null },
                ]}
                empty={
                  <EmptyState title="لا مصاريف مسجَّلة في هذه الفترة" why="المصروف يُخصم مباشرةً من صافي الربح. سجّله وقتَ حدوثه، لا في آخر الشهر." />
                }
              />
            </div>
          </CardContent>
        </Card>

        {/* Which products actually make money. The endpoint behind this was
            built and never connected, so the profit screen could say what the
            shop earned but not what earned it. */}
        <Card>
          <CardHeader title="ربحية المنتجات" subtitle="من الطلبات المسلَّمة — الإيراد ناقص كلفة البضاعة والشحن" />
          <CardContent className="p-0">
            {profitability === null ? (
              <div className="p-4"><SkeletonRows rows={5} /></div>
            ) : profitability.length === 0 ? (
              <p className="p-6 text-sm text-[var(--sys-muted)] text-center">لا مبيعات مسلَّمة بعد.</p>
            ) : phone ? (
              /* The same fields as the row, as the shared card: the name (two lines, not cut to a few words) and the net
                 lead it, and orders / delivered / revenue are labelled lines instead of fragments that wrapped in a
                 different place for every product. */
              <Rows
                rows={profitability}
                keyOf={(p: any) => p.id ?? p.name}
                columns={[
                  { key: 'name', label: 'المنتج', primary: true, render: (p: any) => p.name },
                  {
                    key: 'net',
                    label: 'الصافي',
                    primary: true,
                    render: (p: any) => (
                      <>
                        <Money value={p.netProfit} currency={data?.currency} className="font-bold text-[var(--sys-success)]" />
                        <span className="text-xs text-[var(--sys-muted)] font-normal"> · {p.profitMargin ?? 0}%</span>
                      </>
                    ),
                  },
                  { key: 'orders', label: 'طلبات', render: (p: any) => p.ordersCount },
                  { key: 'delivered', label: 'مسلَّم', render: (p: any) => p.deliveredOrders },
                  {
                    key: 'revenue',
                    label: 'إيراد',
                    render: (p: any) => <Money value={p.revenue} currency={data?.currency} />,
                  },
                ]}
              />
            ) : (
              <ul className="divide-y divide-[var(--sys-border)]">
                {profitability.map((p: any) => (
                  <li key={p.id ?? p.name} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 text-xs">
                    <span className="font-semibold text-[var(--sys-heading)] min-w-[150px] truncate">{p.name}</span>
                    <span className="text-[var(--sys-muted-foreground)]">
                      طلبات: <span className="tabular-nums text-[var(--sys-heading)] font-semibold">{p.ordersCount}</span>
                    </span>
                    <span className="text-[var(--sys-muted-foreground)]">
                      مسلَّم: <span className="tabular-nums text-[var(--sys-heading)] font-semibold">{p.deliveredOrders}</span>
                    </span>
                    <span className="text-[var(--sys-muted-foreground)]">
                      إيراد: <Money value={p.revenue} currency={data?.currency} className="text-[var(--sys-heading)] font-semibold" />
                    </span>
                    <span className="ms-auto tabular-nums font-bold text-[var(--sys-success)]">
                      <Money value={p.netProfit} currency={data?.currency} />
                      <span className="text-xs text-[var(--sys-muted)] font-normal">
                        {' '}صافي · {p.profitMargin ?? 0}%
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Record Expense Modal */}
      <Modal
        isOpen={expenseModalOpen}
        onClose={() => setExpenseModalOpen(false)}
        title="مصروف جديد"
        subtitle="يُخصم مباشرة من صافي ربح هذا المتجر"
      >
        <form onSubmit={handleRecordExpense} className="space-y-4">
          <Input
            label="البند *"
            placeholder="مثلاً: حملة تيك توك رقم 4"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
          />

          <div className="grid grid-cols-2 gap-3">
            <Select
              label="النوع *"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              required
            >
              {/* One list, in expense-grade: the two types the profit already counts on a delivered order say so. */}
              {EXPENSE_FORM_ORDER.map((c) => (
                <option key={c} value={c}>{EXPENSE_FORM_LABEL[c] ?? EXPENSE_CATEGORY_AR[c]}</option>
              ))}
            </Select>

            <Input
              label="المبلغ *"
              type="number"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              required
            />
          </div>

          {EXPENSE_FORM_HINT[category as ExpenseCategory] && (
            <p className="text-xs text-[var(--sys-muted)]">{EXPENSE_FORM_HINT[category as ExpenseCategory]}</p>
          )}

          {/* WHICH WALLET THE MONEY LEFT.
              Required by the server. An expense with no wallet was money
              gone from the company and absent from the wallet ledger, so
              the daily closing showed a shortfall nobody could explain —
              and somebody wrote an explanation for an expense that was
              already recorded here. */}
          <Select
            label="من محفظة *"
            value={walletId}
            onChange={(e) => setWalletId(e.target.value)}
            required
          >
            <option value="">اختر المحفظة…</option>
            {wallets.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name} ({w.currencyCode})
              </option>
            ))}
          </Select>

          {expenseError && (
            <p className="rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] p-2.5 text-xs text-[var(--sys-destructive)]">
              {expenseError}
            </p>
          )}

          <Input
            label="التاريخ *"
            type="date"
            value={expenseDate}
            onChange={(e) => setExpenseDate(e.target.value)}
            required
          />

          <Textarea
            label="ملاحظات"
            placeholder="مثلاً: استهداف دمشق وحلب"
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />

          <div className="flex justify-end space-x-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setExpenseModalOpen(false)}>
              {t.cancel}
            </Button>
            <Button type="submit" loading={modalLoading}>
              احفظ المصروف
            </Button>
          </div>
        </form>
      </Modal>

      {/* Cancel an expense: the money returns to its wallet, the profit stops counting it. */}
      <Modal
        isOpen={!!cancelling}
        onClose={() => setCancelling(null)}
        title="إلغاء مصروف"
        subtitle="يرجع المبلغ إلى محفظته ويخرج المصروف من الربح — ويبقى في السجل مكتوباً «ملغى»"
      >
        <form onSubmit={handleCancelExpense} className="space-y-4">
          <p className="text-sm text-[var(--sys-heading)]">{cancelling?.title}</p>
          <Textarea
            label="سبب الإلغاء *"
            rows={2}
            value={cancelReason}
            onChange={(e) => setCancelReason(e.target.value)}
            required
          />
          {cancelError && (
            <p className="rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] p-2.5 text-xs text-[var(--sys-destructive)]">
              {cancelError}
            </p>
          )}
          <div className="flex justify-end space-x-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setCancelling(null)}>
              {t.cancel}
            </Button>
            <Button type="submit" variant="danger" loading={cancelBusy}>
              ألغِ المصروف
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
