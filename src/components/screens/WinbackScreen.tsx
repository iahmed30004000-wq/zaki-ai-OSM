'use client';

import React, { useState } from 'react';
import { apiJson } from '@/lib/api-client';
import { ScreenTitle } from '@/components/shell/ScreenTitle';
import { EmptyState } from '@/components/ui/EmptyState';
import { Money } from '@/components/ui/Money';
import { Pager } from '@/components/ui/Pager';
import { ListToolbar, withChosen, type ToolbarFilter } from '@/components/ui/ListToolbar';
import { useToast } from '@/components/ui/Toast';
import { useAsk, useTell } from '@/components/ui/Confirm';
import { WinbackRuleDialog } from '@/components/confirmation/WinbackRuleDialog';
import { REJECTION_REASON_AR } from '@/lib/confirmation-workflow';
import { RiLoader4Line, RiPhoneLine, RiPriceTag3Line, RiSettings3Line } from '@remixicon/react';
import { usePagedList, type PagedRead, type Paging } from '@/hooks/usePagedList';
import { ruleSentence, type WinbackRule } from '@/lib/winback';
import { DEFAULT_VIEW, PERIODS, PERIOD_AR, SHIPPING_KINDS, SHIPPING_KIND_AR, VIEWS, VIEW_AR, type View } from '@/lib/winback-filters';
import type { WinbackFacts } from '@/lib/winback-list';
import { OrderLink } from '@/components/orders/OrderLink';
import { CustomerHistoryOffer } from '@/components/orders/CustomerHistory';

/**
 * /confirmation/winback — the lost orders worth one more call.
 *
 * Rejection reasons stop being true with time or with a price: «السعر مرتفع»,
 * «لقيها أرخص», «غيّر رأيه», and three calls nobody answered. Everything else is
 * left alone — unless the owner says otherwise in the rule — and the screen says
 * why rather than hiding it: a supervisor who remembers rejecting an order and
 * cannot find it here concludes the screen is broken, not that the rule excluded
 * it. So the excluded are a VIEW of their own, each with the sentence that
 * excluded it.
 *
 * «استرجاع الملغى — اعملو صفحات + فلاتر + بحث، والأهم شو القاعدة تبعو لاني ممكن
 * اعدلها». Read in pages of 25; a view, four dropdowns and a search box; and THE
 * RULE, in one sentence at the top of the screen, with «عدّل القاعدة» beside it
 * for whoever may change it. The sentence is built from the rule the server is
 * applying right now, so it can never say fourteen days while the list says ten.
 *
 * Making the offer raises a NEW order into the ordinary pool. There is no
 * second queue and no special screen for the agent: she pulls it like any
 * other, sees the discount on it, and calls. The rejected order stays
 * rejected, so «أين نخسر الطلبات» still counts the loss and this gets a
 * conversion rate of its own.
 *
 * «هل بيعرض الملغي قبل الشحن وبعد ؟ … خليه يجري ع ال 2» (28/10). It did not —
 * a parcel that left was refused whatever became of it. Now a parcel that
 * shipped and came back, once the desk has received it, is on the same list
 * under the same rule; its row is named a return, dated by its receipt, and
 * «الشحن» splits the list in two. The owner's switch turns the second kind off,
 * and then every sentence on this screen is the one it printed before.
 */

interface Row {
  id: string;
  orderNumber: string;
  customer: { id?: string; fullName: string; phone: string };
  product: string | null;
  quantity: number;
  sellingPrice: number;
  discountAmount: number;
  rejectionReason: string | null;
  rejectionNote: string | null;
  rejectedAt: string | null;
  /** «مرتجع بعد الشحن …», in words, for a parcel that left and came back; null for every other order. */
  returnLabel: string | null;
  /** When the desk received it back — the date a return cools from. */
  returnReceivedAt: string | null;
  verdict:
    | { eligible: true; dueAt: string; maxDiscount: number }
    | { eligible: false; code: string; reason: string; dueAt?: string };
}

interface Extra {
  facts: WinbackFacts;
  rule: WinbackRule;
  canEditRule: boolean;
  /** The offer's own box. Absent from an older server: the door itself still asks. */
  canOffer: boolean;
}

/** Module-level, so the hook's loader keeps one identity — see `usePagedList`. */
const read = (body: unknown): PagedRead<Row, Extra> => {
  const b = body as { rows: Row[]; pagination: Paging; facts: WinbackFacts; rule: WinbackRule; canEditRule: boolean; canOffer?: boolean };
  return { rows: b.rows, pagination: b.pagination, extra: { facts: b.facts, rule: b.rule, canEditRule: b.canEditRule, canOffer: b.canOffer !== false } };
};

const reasonAr = (code: string | null) => (code ? (REJECTION_REASON_AR[code] ?? code) : 'بلا سبب');
const day = (iso: string | null) => (iso ? new Date(iso).toISOString().slice(0, 10) : '—');

/** `embedded` — a tab of «المتابعة», whose page already carries the title (see `ConfirmationPostponedScreen`). */
export function WinbackScreen({ embedded = false }: { embedded?: boolean } = {}) {
  const toast = useToast();
  const ask = useAsk();
  const tell = useTell();
  const [search, setSearch] = useState('');
  const [view, setView] = useState<View>(DEFAULT_VIEW);
  const [reason, setReason] = useState('all');
  const [product, setProduct] = useState('all');
  const [period, setPeriod] = useState('all');
  const [shipping, setShipping] = useState('all');
  const [offering, setOffering] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const list = usePagedList<Row, Extra>({
    url: '/api/confirmation/winback',
    params: { q: search.trim() || undefined, view, reason, product, period, shipping },
    read,
  });

  const activeCount =
    [reason, product, period, shipping].filter((v) => v !== 'all').length + (search.trim() ? 1 : 0) + (view !== DEFAULT_VIEW ? 1 : 0);
  const reset = () => {
    setSearch('');
    setView(DEFAULT_VIEW);
    setReason('all');
    setProduct('all');
    setPeriod('all');
    setShipping('all');
  };

  async function offer(r: Row) {
    if (!r.verdict.eligible) return;
    const max = r.verdict.maxDiscount;
    const answer = await ask({
      title: `اعرض على ${r.customer.fullName} من جديد؟`,
      body:
        `${r.product ?? '—'} · ${r.quantity} × ${r.sellingPrice}. ` +
        (r.returnLabel ? `${r.returnLabel}، واستلمه المستودع.\n` : `أُلغي بسبب «${reasonAr(r.rejectionReason)}».\n`) +
        `يُنشأ طلبٌ جديد بالخصم ويدخل الطابور العاديّ — والطلب القديم يبقى ${r.returnLabel ? 'مرتجعاً' : 'ملغى'} كما هو.\n` +
        `أقصى خصمٍ مسموح: ${max}${r.discountAmount ? ` (محسومٌ عليه ${r.discountAmount} سابقاً، وهو داخلٌ في الحساب)` : ''}.`,
      confirmLabel: 'اعرضه',
      input: { label: 'قيمة الخصم', placeholder: String(max) },
    });
    if (answer === null) return;
    const discount = Number((answer || '').trim());
    if (!isFinite(discount) || discount < 0 || discount > max) {
      toast.failed(`اكتب رقماً بين صفر و${max}`);
      return;
    }

    setOffering(r.id);
    try {
      const res = await apiJson<{ order: { orderNumber: string } }>('/api/confirmation/winback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: r.id, discount }),
      });
      toast.done(`${res.order.orderNumber} في الطابور — يسحبه أوّلُ من يفرغ`);
      // The reader stays on the page they are on: the order that left it is gone from the list, the rest are where they were.
      await list.reload();
    } catch (e) {
      await tell({
        title: 'تعذّر العرض',
        body: e instanceof Error ? e.message : 'حدث خطأ',
        tone: 'danger',
      });
    } finally {
      setOffering(null);
    }
  }

  const { extra, rows, pagination } = list;

  if (!extra) {
    if (list.error) {
      return <p className="text-sm text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] rounded-lg p-3">{list.error}</p>;
    }
    return (
      <div className="flex items-center justify-center gap-2 text-[var(--sys-muted-foreground)] text-sm py-16">
        <RiLoader4Line className="w-4 h-4 animate-spin" /> جارٍ التحميل…
      </div>
    );
  }

  const { facts, rule, canEditRule, canOffer } = extra;
  const filters: ToolbarFilter[] = [
    {
      key: 'view',
      label: 'الحالة',
      value: view,
      onChange: (v) => setView(v as View),
      options: VIEWS.map((v) => ({ value: v, label: `${VIEW_AR[v]} (${facts.views[v]})` })),
    },
    // Second, beside the view: the owner's own split of the list — «قبل الشحن وبعد».
    {
      key: 'shipping',
      label: 'الشحن',
      value: shipping,
      onChange: setShipping,
      options: [
        { value: 'all', label: 'الكل' },
        ...SHIPPING_KINDS.map((s) => ({ value: s, label: `${SHIPPING_KIND_AR[s]} (${facts.shipping[s]})` })),
      ],
    },
    {
      key: 'reason',
      label: 'سبب الإلغاء',
      value: reason,
      onChange: setReason,
      options: withChosen(reason, [
        { value: 'all', label: 'كل الأسباب' },
        ...facts.reasons.map((g) => ({ value: g.reason, label: `${reasonAr(g.reason)} (${g.count})` })),
      ]),
    },
    {
      key: 'product',
      label: 'المنتج',
      value: product,
      onChange: setProduct,
      options: withChosen(product, [
        { value: 'all', label: 'كل المنتجات' },
        ...facts.products.map((g) => ({ value: g.name, label: `${g.name} (${g.count})` })),
      ]),
    },
    {
      key: 'period',
      label: 'تاريخ الإلغاء',
      value: period,
      onChange: setPeriod,
      options: [
        { value: 'all', label: 'أيّ وقت' },
        ...PERIODS.map((p) => ({ value: p, label: `${PERIOD_AR[p]} (${facts.periods[p]})` })),
      ],
    },
  ];

  // Both kinds while the owner's switch is on; off, the sentence the screen always printed.
  const explain = rule.afterShipping
    ? `طلباتٌ أُلغيت لسببٍ يزول بالوقت أو بالسعر قبل أن تُشحن، أو شُحنت ثمّ رجعت واستلمها المستودع، ومضى على الإلغاء أو الاستلام ${rule.coolingDays} يوماً على الأقلّ. العرضُ يُنشئ طلباً جديداً في الطابور، والقديمُ يبقى كما هو.`
    : `طلباتٌ أُلغيت لسببٍ يزول بالوقت أو بالسعر، ومضى على إلغائها ${rule.coolingDays} يوماً على الأقلّ. العرضُ يُنشئ طلباً جديداً في الطابور، والقديمُ يبقى ملغى.`;

  return (
    <div className="space-y-4">
      {embedded ? (
        // Inside «المتابعة»: the page already has its title, so only the sentence under it stays.
        <p className="text-xs leading-relaxed text-[var(--sys-muted-foreground)]">{explain}</p>
      ) : (
        <ScreenTitle note={explain} />
      )}

      {/* THE RULE, VISIBLE. Otherwise the screen looks arbitrary — and, beside it, the way to change it. */}
      <section className="flex flex-wrap items-start gap-3 rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] p-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-xs font-semibold text-[var(--sys-heading)]">القاعدة</h2>
          <p className="mt-1 text-xs leading-6 text-[var(--sys-muted-foreground)]">{ruleSentence(rule)}</p>
        </div>
        {canEditRule && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="min-h-11 md:min-h-0 inline-flex items-center gap-1.5 rounded-lg border border-[var(--sys-border)] px-3 py-1.5 text-xs font-medium text-[var(--sys-foreground)] hover:border-[var(--sys-primary)] hover:text-[var(--sys-primary)]"
          >
            <RiSettings3Line className="w-4 h-4" aria-hidden />
            عدّل القاعدة
          </button>
        )}
      </section>
      {canEditRule && (
        <WinbackRuleDialog
          rule={rule}
          isOpen={editing}
          onClose={() => setEditing(false)}
          onSaved={async () => {
            toast.done('حُفظت القاعدة — والقائمة تقرأ بها من الآن');
            // A rule moves orders between the views and changes every number beside every option.
            reset();
            await list.reload();
          }}
        />
      )}

      <ListToolbar
        search={search}
        onSearch={setSearch}
        placeholder="بحث برقم الطلب أو اسم العميل أو هاتفه أو المنتج…"
        filters={filters}
        activeCount={activeCount}
        onReset={reset}
      />

      {list.error && (
        <p className="text-sm text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] rounded-lg p-3">
          {list.error}
        </p>
      )}

      {rows.length === 0 ? (
        <div className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)]">
          {activeCount > 0 ? (
            <EmptyState
              title="لا طلبات بهذه الشروط"
              why="ما من طلبٍ ملغى يطابق الحالة والبحثَ والفلاتر المختارة معاً."
              action={{ label: 'امسح الفلاتر', onClick: reset }}
            />
          ) : (
            <EmptyState
              title="لا طلبَ جاهزاً لمحاولةٍ ثانية"
              why={
                rule.afterShipping
                  ? `يُعرض هنا ما أُلغي قبل الشحن بالأسباب التي تحدّدها القاعدة أعلاه، وما شُحن ثمّ رجع واستلمه المستودع — بعد ${rule.coolingDays} يوماً، ولم يُعرض عليه من قبل.`
                  : `يُعرض هنا ما أُلغي بالأسباب التي تحدّدها القاعدة أعلاه، بعد ${rule.coolingDays} يوماً، ولم يُعرض عليه من قبل، ولم يُشحن.`
              }
            />
          )}
        </div>
      ) : (
        rows.map((r) => (
          <article
            key={r.id}
            className="bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg p-4 space-y-3"
          >
            <header className="flex flex-wrap items-center gap-2">
              <OrderLink id={r.id} number={r.orderNumber} className="font-semibold text-[var(--sys-heading)]" />
              <span className="text-xs px-2 py-0.5 rounded-md bg-[var(--sys-warning-soft)] border border-[var(--sys-warning)]/30 text-[var(--sys-warning)]">
                {r.returnLabel ?? reasonAr(r.rejectionReason)}
              </span>
              {/* A return is dated by the desk's receipt — the day its cooling counts from — not by a cancellation it never had. */}
              <span className="mr-auto text-xs text-[var(--sys-muted-foreground)]">
                {r.returnLabel
                  ? r.returnReceivedAt
                    ? `استلمه المستودع ${day(r.returnReceivedAt)}`
                    : 'لم يستلمه المستودع بعد'
                  : `أُلغي ${day(r.rejectedAt)}`}
              </span>
            </header>

            <p className="text-sm text-[var(--sys-heading)]">
              {r.customer.fullName} · <span dir="ltr">{r.customer.phone}</span>
              {r.customer.id && (
                <>
                  {' '}
                  <CustomerHistoryOffer customerId={r.customer.id} orderId={r.id} />
                </>
              )}
            </p>
            <p className="text-xs text-[var(--sys-muted-foreground)]">
              {r.product ?? '—'} · {r.quantity} × <Money value={r.sellingPrice} />
              {r.discountAmount > 0 && (
                <> · محسومٌ سابقاً <Money value={r.discountAmount} /></>
              )}
            </p>
            {r.rejectionNote && (
              <p className="text-xs text-[var(--sys-foreground)] bg-[var(--sys-surface)] rounded-lg px-3 py-2">
                {r.rejectionNote}
              </p>
            )}

            <footer className="flex flex-wrap items-center gap-2 pt-2 border-t border-[var(--sys-border)]">
              {r.verdict.eligible ? (
                <>
                  {canOffer && (
                  <button
                    onClick={() => void offer(r)}
                    disabled={offering === r.id}
                    className="min-h-11 md:min-h-0 inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] text-xs font-medium disabled:opacity-50"
                  >
                    {offering === r.id ? (
                      <RiLoader4Line className="w-4 h-4 animate-spin" />
                    ) : (
                      <RiPhoneLine className="w-4 h-4" aria-hidden />
                    )}
                    اعرضه من جديد
                  </button>
                  )}
                  <span className="inline-flex items-center gap-1 text-xs text-[var(--sys-muted-foreground)]">
                    <RiPriceTag3Line className="w-4 h-4" aria-hidden />
                    أقصى خصم <Money value={r.verdict.maxDiscount} />
                  </span>
                </>
              ) : (
                /* No button, and the sentence that put it here — the rule, taught row by row. */
                <span className="text-xs text-[var(--sys-muted-foreground)]">
                  {r.verdict.reason}
                  {r.verdict.code === 'COOLING' && r.verdict.dueAt ? ` — يصير جاهزاً ${day(r.verdict.dueAt)}` : ''}
                </span>
              )}
            </footer>
          </article>
        ))
      )}

      {pagination.total > 0 && (
        <Pager
          page={pagination.page}
          totalPages={pagination.totalPages}
          total={pagination.total}
          shown={rows.length}
          noun="طلب"
          loading={list.loading}
          onPage={list.goTo}
        />
      )}
    </div>
  );
}
