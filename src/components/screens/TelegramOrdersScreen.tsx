'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { RiArrowGoBackLine, RiEqualizer2Line, RiRefreshLine } from '@remixicon/react';
import { Button } from '@/components/ui/Button';
import { PageHeader } from '@/components/ui/PageHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { Rows, type Column } from '@/components/ui/Rows';
import { Tabs } from '@/components/ui/Tabs';
import { ListToolbar } from '@/components/ui/ListToolbar';
import { Pager } from '@/components/ui/Pager';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { StatusChip } from '@/components/ui/StatusChip';
import { useToast } from '@/components/ui/Toast';
import { useConfirm } from '@/components/ui/Confirm';
import { OrderLink } from '@/components/orders/OrderLink';
import { useApp } from '@/context/AppContext';
import { userCan } from '@/lib/can';
import { apiJson } from '@/lib/api-client';
import { arDateTime } from '@/lib/format';
import { usePagedList, type PagedRead, type Paging } from '@/hooks/usePagedList';
import { reviewReason, reviewReasonText, type ReasonField } from '@/lib/telegram/review-reasons';
import type { MessageColumns } from '@/lib/telegram/labeled-order';

/**
 * «طلبات تلجرام» — THE MESSAGES, IN THE ORDER OF HIS LABELS.
 *
 * The owner, 28/10: «أريده يسحب الطلبات بهذه الصيغة»: nine labels, one per line. The columns are what the labels say,
 * read on the server by the same reader the door uses: تاريخ الطلب · العميل · الهاتف · العنوان · المنتج · العرض ·
 * السعر × الكمية, then الحالة. «رقم الطلب» is dropped by the reader and has no column. Then:
 *
 *   · a message that is not in the format is set aside under «متجاهلة» with «الرسالة مش بصيغة الطلب»; one that claims
 *     the format and is wrong waits under «للمراجعة», and the reason names the field — whose cell is marked;
 *   · the tabs say how many are in each, counted under the same store scope as the list, and «للمراجعة» opens first;
 *   · «إعادة المعالجة» is offered only where pressing it can change the answer; a reason in the text itself says
 *     «صحّح الرسالة وابعتها من جديد» instead. «تجاهل» asks first, and «إعادة المعالجة» takes it back;
 *   · the message as it arrived is folded under «نص الرسالة», closed until asked for;
 *   · the offer's text is tied to a real offer: once the order exists the cell shows «مربوط بالعرض: …», and the phone is
 *     drawn as the seller wrote it (every form is accepted; a number that fails the store's rule waits here, named).
 *
 * The bot's status asks Telegram twice, so it is read when the screen opens and on «تحديث» — never on a tab, a search or
 * a page.
 */

interface Message {
  id: string;
  chatId: string;
  threadId: number | null;
  threadName: string | null;
  senderName: string | null;
  text: string | null;
  processingStatus: string;
  reviewReason: string | null;
  pageName: string | null;
  createdAt: string;
  source: { chatTitle: string | null; topicName: string | null } | null;
  order: { id: string; orderNumber: string; offer: { name: string } | null } | null;
  reading: MessageColumns;
  twin: { id: string; orderNumber: string } | null;
}

interface Facts {
  review: number;
  orders: number;
  ignored: number;
  all: number;
}

type Tab = keyof Facts;
type Field = ReasonField;

/** Module-level, so the hook's loader keeps one identity — see `usePagedList`. */
const read = (body: unknown): PagedRead<Message, Facts> => {
  const b = body as { messages: Message[]; pagination: Paging; facts: Facts };
  return { rows: b.messages, pagination: b.pagination, extra: b.facts };
};

const TABS: { key: Tab; label: string }[] = [
  { key: 'review', label: 'للمراجعة' },
  { key: 'orders', label: 'صارت طلبات' },
  { key: 'ignored', label: 'متجاهلة' },
  { key: 'all', label: 'الكل' },
];

/** A message's state, in one word and one tone. */
const STATE: Record<string, { label: string; tone: 'neutral' | 'good' | 'warn' | 'bad' }> = {
  PROCESSED: { label: 'صار طلب', tone: 'good' },
  NEEDS_REVIEW: { label: 'للمراجعة', tone: 'warn' },
  FAILED: { label: 'فشل', tone: 'bad' },
  IGNORED: { label: 'متجاهلة', tone: 'neutral' },
  PENDING: { label: 'قيد المعالجة', tone: 'neutral' },
};

const waiting = (m: Message) => m.processingStatus === 'NEEDS_REVIEW' || m.processingStatus === 'FAILED';

/** Why the row waits (or was set aside), in Arabic — the stored reason, or for a failure that wrote none, the failure itself. */
const reasonOf = (m: Message) => {
  if (m.processingStatus === 'IGNORED') return m.reviewReason === 'NOT_IN_FORMAT' ? reviewReasonText(m.reviewReason) : '';
  return waiting(m) ? reviewReasonText(m.reviewReason ?? (m.processingStatus === 'FAILED' ? 'PROCESSING_ERROR' : null)) : '';
};

/** The cell the reason is about, so the eye lands on it. */
const failingField = (m: Message): Field | null =>
  m.processingStatus === 'NEEDS_REVIEW' ? reviewReason(m.reviewReason)?.field ?? null : null;

/** «إعادة المعالجة» where pressing it may change the answer: not for a reason that lives in the text, which never changes. */
const mayRetry = (m: Message) =>
  m.processingStatus === 'FAILED' ||
  m.processingStatus === 'PENDING' ||
  m.processingStatus === 'IGNORED' ||
  (m.processingStatus === 'NEEDS_REVIEW' && reviewReason(m.reviewReason)?.retry === true);

const mayIgnore = (m: Message) => !m.order && ['NEEDS_REVIEW', 'FAILED', 'PENDING'].includes(m.processingStatus);

export function TelegramOrdersScreen() {
  const { currentUser } = useApp();
  if (!userCan(currentUser, 'telegram.view')) {
    return <div className="p-8 text-center text-[var(--sys-muted-foreground)]">ما عندك صلاحية تشوف طلبات تلجرام</div>;
  }
  return <TelegramOrdersList canManage={userCan(currentUser, 'telegram.manage')} />;
}

function TelegramOrdersList({ canManage }: { canManage: boolean }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [tab, setTab] = useState<Tab>('review');
  const [search, setSearch] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [bot, setBot] = useState<'on' | 'off' | 'unknown' | null>(null);

  const list = usePagedList<Message, Facts>({
    url: '/api/telegram/messages',
    params: { tab, q: search.trim() || undefined },
    read,
  });

  const readBot = useCallback(
    () =>
      apiJson<{ botConfigured?: boolean; botApiOk?: boolean }>('/api/telegram/status').then(
        (st) => setBot(st.botConfigured && st.botApiOk ? 'on' : 'off'),
        () => setBot('unknown')
      ),
    []
  );

  useEffect(() => {
    void readBot();
  }, [readBot]);

  const refresh = () => {
    void readBot();
    void list.reload();
  };

  const retry = async (m: Message) => {
    setBusyId(m.id);
    try {
      const r = await apiJson<{ status: string; reason?: string }>(`/api/telegram/messages/${m.id}/retry`, { method: 'POST' });
      if (r.status === 'PROCESSED') toast.done('صارت طلب');
      else if (r.status === 'IGNORED') toast.done('ما فيها طلب — انحطّت بالمتجاهلة');
      else toast.failed(reviewReasonText(r.reason) || 'لسا ما صارت طلب');
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'ما زبطت إعادة المعالجة');
    } finally {
      setBusyId(null);
    }
    // Whatever the answer, the row moved or its reason changed: the page in hand is read again.
    await list.reload();
  };

  const ignore = async (m: Message) => {
    const yes = await confirm({
      title: 'تتجاهل هالرسالة؟',
      body: 'بتنحطّ بالمتجاهلة وما بيصير منها طلب. فيك ترجّعها بـ«إعادة المعالجة».',
      confirmLabel: 'تجاهل',
    });
    if (!yes) return;
    setBusyId(m.id);
    try {
      await apiJson(`/api/telegram/messages/${m.id}/ignore`, { method: 'POST' });
      toast.done('انحطّت بالمتجاهلة');
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'ما زبط التجاهل');
    } finally {
      setBusyId(null);
    }
    await list.reload();
  };

  const value = (m: Message, field: Field) => {
    const { price, quantity } = m.reading;
    const text = field === 'priceQuantity' ? (price || quantity ? `${price || '—'} × ${quantity || '—'}` : undefined) : m.reading[field];
    if (!text) return <span className="text-[var(--sys-muted)]">—</span>;
    return failingField(m) === field ? <span className="font-semibold text-[var(--sys-destructive)]">{text}</span> : text;
  };

  const reasonLine = (m: Message, className: string) => {
    const reason = reasonOf(m);
    if (!reason) return null;
    return (
      <p className={className}>
        {reason}
        {m.twin && (
          <>
            {' '}
            <OrderLink id={m.twin.id} number={m.twin.orderNumber} className="font-mono text-[var(--sys-primary)] font-semibold" />
          </>
        )}
      </p>
    );
  };

  const columns: Column<Message>[] = [
    { key: 'orderedAt', label: 'تاريخ الطلب', primary: true,
      render: (m) =>
        m.reading.orderedAt ? (
          <span dir="ltr" className={failingField(m) === 'orderedAt' ? 'tabular-nums font-semibold text-[var(--sys-destructive)]' : 'tabular-nums'}>
            {m.reading.orderedAt}
          </span>
        ) : (
          <span className="text-xs text-[var(--sys-muted-foreground)]">وصلت {arDateTime(m.createdAt)}</span>
        ) },
    { key: 'customer', label: 'العميل', primary: true, render: (m) => value(m, 'customer') },
    { key: 'phone', label: 'الهاتف', render: (m) => <span dir="ltr">{value(m, 'phone')}</span> },
    { key: 'address', label: 'العنوان', render: (m) => value(m, 'address') },
    { key: 'product', label: 'المنتج', render: (m) => value(m, 'product') },
    { key: 'offer', label: 'العرض',
      render: (m) => (
        <div className="space-y-0.5">
          {value(m, 'offer')}
          {/* The offer the text was tied to — the one the order was priced from. */}
          {m.order?.offer && <p className="text-xs font-semibold text-[var(--sys-primary)]">مربوط بالعرض: {m.order.offer.name}</p>}
        </div>
      ) },
    { key: 'priceQuantity', label: 'السعر × الكمية', render: (m) => <span dir="ltr">{value(m, 'priceQuantity')}</span> },
    { key: 'state', label: 'الحالة',
      render: (m) => (
        <div className="space-y-1">
          <StatusChip tone={STATE[m.processingStatus]?.tone ?? 'neutral'}>{STATE[m.processingStatus]?.label ?? 'غير معروفة'}</StatusChip>
          {m.order && <OrderLink id={m.order.id} number={m.order.orderNumber} className="font-mono text-[var(--sys-primary)] font-semibold" />}
          {/* On a phone the reason leads the card instead (`notice`), so it is drawn here for the desk only. */}
          {reasonLine(m, 'hidden md:block text-xs text-[var(--sys-destructive)] mt-0.5')}
        </div>
      ) },
  ];

  const actions = (m: Message) => (
    <div className="flex flex-wrap items-center gap-2">
      {canManage && mayRetry(m) && (
        <Button size="sm" variant="outline" disabled={busyId === m.id} onClick={() => retry(m)}>
          <RiArrowGoBackLine className="icon-mirror w-4 h-4 ml-1" /> إعادة المعالجة
        </Button>
      )}
      {m.processingStatus === 'NEEDS_REVIEW' && !mayRetry(m) && (
        <span className="text-xs text-[var(--sys-muted-foreground)]">صحّح الرسالة وابعتها من جديد</span>
      )}
      {canManage && mayIgnore(m) && (
        <Button size="sm" variant="ghost" disabled={busyId === m.id} onClick={() => ignore(m)}>
          تجاهل
        </Button>
      )}
      {/* The message as it arrived, and where from — folded, closed until asked for, and not remembered. */}
      <details className="w-full rounded-lg border border-[var(--sys-border)]">
        <summary className="min-h-11 md:min-h-0 inline-flex items-center cursor-pointer px-2 py-1.5 text-xs font-semibold text-[var(--sys-muted-foreground)]">
          نص الرسالة
        </summary>
        <div className="border-t border-[var(--sys-surface-strong)] px-2 py-2">
          <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-[var(--sys-heading)]">{m.text || '—'}</p>
          <p className="mt-1 text-xs text-[var(--sys-muted)]">
            من: {m.source?.chatTitle || m.chatId} · {m.threadName || m.source?.topicName || (m.threadId ? `موضوع ${m.threadId}` : 'بلا موضوع')} ·{' '}
            {m.senderName || 'مجهول'} · وصلت {arDateTime(m.createdAt)}
          </p>
          {m.pageName && <p className="mt-1 text-xs text-[var(--sys-muted)]">الصفحة: {m.pageName}</p>}
        </div>
      </details>
    </div>
  );

  const empty = search.trim() ? (
    <EmptyState title="ما في رسائل بهالبحث" why="جرّب اسم أو رقم تاني، أو امسح البحث." action={{ label: 'امسح البحث', onClick: () => setSearch('') }} />
  ) : tab === 'review' ? (
    <EmptyState
      title="ما في رسائل بتستنّى مراجعتك"
      why="كل رسالة وصلت صارت طلب، أو انحطّت بالمتجاهلة."
      action={{ label: 'اعرض الكل', onClick: () => setTab('all') }}
    />
  ) : tab === 'orders' ? (
    <EmptyState title="لسا ما صار طلب من تلجرام" why="الرسالة اللي بتنقرأ كاملة بتصير طلب لحالها وبتطلع هون." />
  ) : tab === 'ignored' ? (
    <EmptyState title="ما في رسائل متجاهلة" why="هون الرسائل اللي مش طلبات: سلام وأسئلة، وكل رسالة انكبس عليها «تجاهل»." />
  ) : (
    <EmptyState
      title="لا رسائل من تلجرام بعد"
      why="الرسائل تصل حين يُضاف البوت إلى المجموعة ويُمنح صلاحية القراءة. لا شيء يُسحب بأثرٍ رجعيّ."
    />
  );

  const { rows, pagination, extra: facts } = list;

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto" dir="rtl">
      <PageHeader
        title="طلبات تلجرام"
        description="الرسالة المكتوبة بصيغة الطلب بتصير طلب لحالها، واللي فيها غلط بتستنّى هون للمراجعة."
        actions={
          <div className="flex items-center gap-2">
            {canManage && (
              <Link href="/settings/links#telegram">
                <Button variant="outline" size="sm"><RiEqualizer2Line className="w-4 h-4 ml-1" /> الإعدادات</Button>
              </Link>
            )}
            <Button variant="ghost" size="sm" onClick={refresh}>
              <RiRefreshLine className="w-4 h-4 ml-1" /> تحديث
            </Button>
          </div>
        }
      >
        {bot && (
          <StatusChip tone={bot === 'on' ? 'good' : bot === 'off' ? 'bad' : 'neutral'}>
            {bot === 'on' ? 'البوت متصل' : bot === 'off' ? 'البوت غير متصل' : 'حالة البوت مش معروفة'}
          </StatusChip>
        )}
      </PageHeader>

      <p className="text-sm text-[var(--sys-muted-foreground)]">
        الرسالة لازم تكون بهالعناوين، سطر لكل معلومة: رقم الطلب (يُتجاهل) · تاريخ الطلب · إسم العميل · رقم الهاتف · عنوان العميل · إسم المنتج · إسم العرض · السعر · الكمية. غير هيك ما بتصير طلب.
      </p>

      <Tabs tabs={TABS.map((t) => ({ ...t, count: facts?.[t.key] }))} value={tab} onChange={(k) => setTab(k as Tab)} />

      <ListToolbar
        search={search}
        onSearch={setSearch}
        placeholder="بحث بالاسم أو الهاتف أو المنتج أو رقم الطلب…"
        filters={[]}
        activeCount={search.trim() ? 1 : 0}
        onReset={() => setSearch('')}
      />

      {list.error && (
        <p className="text-sm text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] rounded-lg p-3">
          {list.error}
        </p>
      )}

      {facts === undefined ? (
        !list.error && <SkeletonRows rows={5} />
      ) : (
        <Rows
          rows={rows}
          keyOf={(m) => m.id}
          columns={columns}
          alert={(m) => (m.processingStatus === 'FAILED' ? 'danger' : m.processingStatus === 'NEEDS_REVIEW' ? 'warn' : null)}
          notice={(m) => reasonLine(m, 'text-xs text-[var(--sys-destructive)]')}
          actions={actions}
          empty={empty}
        />
      )}

      {pagination.total > 0 && (
        <Pager
          page={pagination.page}
          totalPages={pagination.totalPages}
          total={pagination.total}
          shown={rows.length}
          noun="رسالة"
          loading={list.loading}
          onPage={list.goTo}
        />
      )}
    </div>
  );
}
