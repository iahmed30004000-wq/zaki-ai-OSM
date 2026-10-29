'use client';

import React, { useState } from 'react';
import { apiJson } from '@/lib/api-client';
import { ScreenTitle } from '@/components/shell/ScreenTitle';
import { RiInboxUnarchiveLine, RiLoader4Line } from '@remixicon/react';
import { Rows } from '@/components/ui/Rows';
import { EmptyState } from '@/components/ui/EmptyState';
import { Pager } from '@/components/ui/Pager';
import { ListToolbar, withChosen, type ToolbarFilter } from '@/components/ui/ListToolbar';
import { arDate } from '@/lib/format';
import { usePagedList, type PagedRead, type Paging } from '@/hooks/usePagedList';
import { KINDS, KIND_AR, TIMES, TIMES_AR, WHENS, whenLabel } from '@/lib/postponed-filters';
import type { PostponedFacts } from '@/lib/postponed-list';
import { OrderLink } from '@/components/orders/OrderLink';
import { CustomerHistoryOffer } from '@/components/orders/CustomerHistory';
import { POSTPONE_REASONS } from '@/lib/postpone-reasons';

/**
 * /confirmation/postponed — order, customer, due date, days remaining,
 * preferred time, reason and postpone count. Only rows the server marks
 * actionable (due within the lead days) can be worked on.
 *
 * Read in pages of 25, with a search box and four dropdowns that are always on
 * the screen: the moment, the kind, how often, and — for a supervisor — whose
 * hands. «الطلبات المؤجلة — اعملو صفحات + فلاتر + بحث». The kit is shared with
 * the other lists (`usePagedList`, `ListToolbar`, `Pager`); what is this
 * screen's own is the words and the numbers beside them, which the server
 * counts (`facts`) so that «متأخر (3)» is a promise that three rows will appear.
 */

interface Row {
  id: string;
  orderNumber: string;
  totalAmount: number;
  currency: string;
  dueAt: string | null;
  daysRemaining: number | null;
  postponePreferredTime: string | null;
  postponeCount: number;
  followUpReason: string | null;
  actionable: boolean;
  customer: { id?: string; fullName: string; phone: string; city: string };
  claimer: { id: string; name: string } | null;
}

interface Extra {
  leadDays: number;
  facts: PostponedFacts;
}

/** Module-level, so the hook's loader keeps one identity — see `usePagedList`. */
const read = (body: unknown): PagedRead<Row, Extra> => {
  const b = body as { orders: Row[]; pagination: Paging; leadDays: number; facts: PostponedFacts };
  return { rows: b.orders, pagination: b.pagination, extra: { leadDays: b.leadDays, facts: b.facts } };
};

/**
 * `embedded` — drawn as a tab of another screen («طلباتي» for an agent, «المتابعة» for a
 * supervisor), which already has its own heading: a second `<h1>` with the route's name
 * under the first is two titles for one page.
 */
export function ConfirmationPostponedScreen({ embedded = false }: { embedded?: boolean } = {}) {
  const [search, setSearch] = useState('');
  const [when, setWhen] = useState('all');
  const [kind, setKind] = useState('all');
  const [times, setTimes] = useState('all');
  const [agent, setAgent] = useState('all');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const list = usePagedList<Row, Extra>({
    url: '/api/confirmation/postponed',
    params: { q: search.trim() || undefined, when, kind, times, agent },
    read,
  });

  const activeCount = [when, kind, times, agent].filter((v) => v !== 'all').length + (search.trim() ? 1 : 0);
  const reset = () => {
    setSearch('');
    setWhen('all');
    setKind('all');
    setTimes('all');
    setAgent('all');
  };

  /** Hands it to the pool, still postponed. The list reloads — on the page the reader is on. */
  const toQueue = async (o: Row) => {
    setBusyId(o.id);
    setActionError(null);
    setDone(null);
    try {
      await apiJson('/api/confirmation/postponed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: o.id }),
      });
      setDone(`${o.orderNumber} في الطابور — ما زال مؤجَّلاً، وأوّل من يسحب يراه كذلك`);
      await list.reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'تعذّرت الإعادة إلى الطابور');
    } finally {
      setBusyId(null);
    }
  };

  const { extra, rows, pagination } = list;

  // Nothing to draw until the first answer: the error alone if it failed, the spinner otherwise.
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

  const { leadDays, facts } = extra;
  const filters: ToolbarFilter[] = [
    {
      key: 'when',
      label: 'الموعد',
      value: when,
      onChange: setWhen,
      options: withChosen(when, [
        { value: 'all', label: `كل المواعيد (${facts.total})` },
        ...WHENS.map((w) => ({ value: w, label: `${whenLabel(w, leadDays)} (${facts.whens[w]})` })),
      ]),
    },
    {
      key: 'kind',
      label: 'النوع',
      value: kind,
      onChange: setKind,
      options: withChosen(kind, [
        { value: 'all', label: `كل الأنواع (${facts.total})` },
        ...KINDS.map((k) => ({ value: k, label: `${KIND_AR[k]} (${facts.kinds[k]})` })),
      ]),
    },
    {
      key: 'times',
      label: 'مرات التأجيل',
      value: times,
      onChange: setTimes,
      options: withChosen(times, [
        { value: 'all', label: 'أيّ عدد' },
        ...TIMES.map((t) => ({ value: t, label: `${TIMES_AR[t]} (${facts.times[t]})` })),
      ]),
    },
    // Whose hands is a supervisor's question; an agent's list is her own and the server sends no agents.
    ...(facts.agents
      ? [
          {
            key: 'agent',
            label: 'الموظف',
            value: agent,
            onChange: setAgent,
            options: withChosen(agent, [
              { value: 'all', label: 'كل الموظفين' },
              ...facts.agents.map((a) => ({ value: a.id, label: `${a.name} (${a.count})` })),
            ]),
          },
        ]
      : []),
  ];

  return (
    <div className="max-w-5xl space-y-3">
      {!embedded && <ScreenTitle />}

      <p className="text-sm text-[var(--sys-muted-foreground)]">
        القابل للعمل عليه: المستحق خلال {leadDays} يوم أو المتأخر. الباقي للعرض فقط —
        وما حان موعدُه يمكن إعادتُه إلى الطابور ليسحبه أوّلُ من يفرغ، ويبقى مؤجَّلاً كما هو.
      </p>

      <ListToolbar
        search={search}
        onSearch={setSearch}
        placeholder="بحث برقم الطلب أو المرجع أو اسم العميل أو هاتفه…"
        filters={filters}
        activeCount={activeCount}
        onReset={reset}
      />

      {(actionError || list.error) && (
        <p className="text-sm text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] rounded-lg p-3">
          {actionError ?? list.error}
        </p>
      )}
      {done && (
        <p className="rounded-lg border border-[var(--sys-success)]/40 bg-[var(--sys-success-soft)] p-2.5 text-sm text-[var(--sys-success)]">
          {done}
        </p>
      )}
      <div className="bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg overflow-hidden">
        {/* Eight columns on a 375px screen is every cell wrapped to four
            lines and one row filling the phone. The same definition draws
            a table on a desk and a card in a hand — and the card leads
            with what somebody scans for: the order, and who it is for. */}
        <Rows
          rows={rows}
          keyOf={(o) => o.id}
          alert={(o) => o.daysRemaining !== null && o.daysRemaining < 0}
          columns={[
            {
              key: 'order',
              label: 'الطلب',
              primary: true,
              // A list with no «whose hands» facet is an agent's own: the server
              // scopes it to her claims, behind `confirmation.work`. So without
              // «عرض الطلبات» each number opens the order on her desk instead.
              render: (o) => (
                <OrderLink
                  id={o.id}
                  number={o.orderNumber}
                  opensOnHerDesk={!facts.agents}
                  className="font-medium text-[var(--sys-heading)]"
                />
              ),
            },
            {
              key: 'customer',
              label: 'العميل',
              primary: true,
              render: (o) => (
                <span className="flex flex-wrap items-center gap-2">
                  {o.customer.fullName} · {o.customer.city}
                  {o.customer.id && <CustomerHistoryOffer customerId={o.customer.id} orderId={o.id} />}
                </span>
              ),
            },
            {
              key: 'due',
              label: 'تاريخ الاستحقاق',
              render: (o) => (
                <span dir="ltr">{arDate(o.dueAt)}</span>
              ),
            },
            {
              key: 'left',
              label: 'المتبقي',
              render: (o) =>
                o.daysRemaining === null ? (
                  '—'
                ) : o.daysRemaining < 0 ? (
                  <span className="tabular-nums text-[var(--sys-destructive)]">
                    متأخر {Math.abs(o.daysRemaining)} يوم
                  </span>
                ) : (
                  <span className="tabular-nums">{o.daysRemaining} يوم</span>
                ),
            },
            { key: 'time', label: 'الوقت المفضّل', render: (o) => o.postponePreferredTime ?? '—' },
            { key: 'reason', label: 'السبب', render: (o) => (o.followUpReason ? (POSTPONE_REASONS.find((r) => r.value === o.followUpReason)?.label ?? 'سبب آخر') : '—') },
            {
              key: 'count',
              label: 'مرات التأجيل',
              align: 'end',
              render: (o) => <span className="tabular-nums">{o.postponeCount}</span>,
            },
            /**
             * THE ONE ACTION THIS SCREEN WAS MISSING.
             *
             * A postponed order KEEPS ITS CLAIM, which is right while the date
             * is far off — the agent who spoke to the customer should be the
             * one to ring back — and wrong the moment it comes due: if she is
             * off that day the order sits where nobody else can reach it,
             * because the pool only takes unclaimed orders.
             *
             * It only appears on a row that is `actionable` — the server's own
             * word for «due within the lead days». A button on an order due in
             * three weeks would break the one promise the postpone was made to
             * keep.
             *
             * And it does NOT mark the order new: it stays postponed, with its
             * date and its count, so whoever pulls it next opens it knowing
             * this customer asked for Thursday and has asked twice.
             */
            {
              key: 'queue',
              label: 'إلى الطابور',
              render: (o) =>
                o.actionable ? (
                  <button
                    type="button"
                    onClick={() => void toQueue(o)}
                    disabled={busyId === o.id}
                    title="أعِدْه إلى الطابور ليسحبه أوّل من يفرغ"
                    className="min-h-11 md:min-h-0 inline-flex items-center gap-1.5 rounded-lg border border-[var(--sys-warning)] bg-[var(--sys-warning-soft)] px-2.5 py-1 text-xs font-bold text-[var(--sys-warning)] transition-colors hover:bg-[var(--sys-warning)]/20 disabled:opacity-40"
                  >
                    {busyId === o.id ? (
                      <RiLoader4Line className="h-4 w-4 animate-spin" aria-hidden />
                    ) : (
                      <RiInboxUnarchiveLine className="h-4 w-4" aria-hidden />
                    )}
                    إلى الطابور
                  </button>
                ) : (
                  <span className="text-xs text-[var(--sys-muted)]">—</span>
                ),
            },
            // The agent's own name is on a desk's table; on a card it is
            // one more labelled line between her and the phone number.
            { key: 'agent', label: 'الموظف', hideOnPhone: true, render: (o) => o.claimer?.name ?? '—' },
          ]}
          empty={
            activeCount > 0 ? (
              <EmptyState
                title="لا طلبات بهذه الشروط"
                why="ما من طلبٍ مؤجَّل يطابق البحثَ والفلاتر المختارة معاً."
                action={{ label: 'امسح الفلاتر', onClick: reset }}
              />
            ) : (
              <EmptyState
                title="لا طلبات مؤجلة"
                why="التأجيل يضع الطلب هنا حتى موعده. فراغُ القائمة يعني أنّ لا طلبَ أُجِّل، أو أنّ كلّ ما أُجِّل حلّ موعدُه وعاد إلى الطابور."
              />
            )
          }
        />
      </div>

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
