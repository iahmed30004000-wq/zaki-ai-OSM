'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { arStamp } from '@/lib/format';
import { routeLabel } from '@/lib/route-registry';
import { PageHeader } from '@/components/ui/PageHeader';
import { Rows } from '@/components/ui/Rows';
import { EmptyState } from '@/components/ui/EmptyState';
import { Pager } from '@/components/ui/Pager';
import { DateRange, type Range } from '@/components/ui/DateRange';
import { ListToolbar, withChosen, type ToolbarFilter } from '@/components/ui/ListToolbar';
import { usePagedList, type PagedRead, type Paging } from '@/hooks/usePagedList';
import { useMayOpen } from '@/hooks/useMayOpen';
import { describeAction, entityHref, entityLabel, summariseChange } from '@/lib/audit-view';

/**
 * /control/audit — the trail, read in pages: who did what, to which record, when.
 *
 * It was the newest hundred rows with an English sentence for a heading, the action as a
 * machine code, and the record as a bare uuid. Now it reads in pages of 25 with the kit the
 * other lists share (search, two dropdowns always drawn, a span of days, «إعادة تعيين»), says
 * each action in Arabic (the code stays on the row's tooltip), and an order or a product opens
 * from its row — for whoever may open it; for anyone else the id is just text.
 *
 * Reading only: nothing here writes, and the log itself refuses edits (append-only trigger).
 */

interface Row {
  id: string;
  action: string;
  entity: string;
  entityId: string;
  newData: string | null;
  createdAt: string;
  user: { id: string; name: string; role: string } | null;
  /** The server took the amounts out: this reader has no «عرض الرواتب». */
  payWithheld?: true;
  /** The server took the names, shares and amounts out: this reader has no «الشركاء والسحوبات». */
  partnersWithheld?: true;
}
interface Facts {
  users: { id: string; name: string; count: number }[];
  entities: { entity: string; count: number }[];
}

/** Module-level, so the hook's loader keeps one identity — see `usePagedList`. */
const read = (body: unknown): PagedRead<Row, Facts> => {
  const b = body as { logs: Row[]; pagination: Paging; facts: Facts };
  return { rows: b.logs, pagination: b.pagination, extra: b.facts };
};

const NO_RANGE: Range = { from: '', to: '' };

export function AuditScreen() {
  const mayOpen = useMayOpen();
  const [search, setSearch] = useState('');
  const [user, setUser] = useState('all');
  const [entity, setEntity] = useState('all');
  const [range, setRange] = useState<Range>(NO_RANGE);

  const list = usePagedList<Row, Facts>({
    url: '/api/audit-logs',
    params: { q: search.trim() || undefined, user, entity, from: range.from || undefined, to: range.to || undefined },
    read,
  });

  const spanChosen = Boolean(range.from || range.to);
  const activeCount = [user, entity].filter((v) => v !== 'all').length + (search.trim() ? 1 : 0) + (spanChosen ? 1 : 0);
  const reset = () => {
    setSearch('');
    setUser('all');
    setEntity('all');
    setRange(NO_RANGE);
  };

  const facts = list.extra;
  const filters: ToolbarFilter[] = [
    {
      key: 'user',
      label: 'مَن',
      value: user,
      onChange: setUser,
      options: withChosen(user, [
        { value: 'all', label: 'كل المستخدمين' },
        ...(facts?.users ?? []).map((u) => ({ value: u.id, label: `${u.name} (${u.count})` })),
      ]),
    },
    {
      key: 'entity',
      label: 'على ماذا',
      value: entity,
      onChange: setEntity,
      options: withChosen(entity, [
        { value: 'all', label: 'كل أنواع السجلات' },
        ...(facts?.entities ?? []).map((e) => ({ value: e.entity, label: `${entityLabel(e.entity)} (${e.count})` })),
      ]),
    },
  ];

  const { rows, pagination } = list;

  return (
    <div className="space-y-4">
      <PageHeader
        title={routeLabel('/control/audit')}
        description="سجلٌّ لا يُمحى: كلُّ تعديلٍ على طلبٍ أو مالٍ أو صلاحيةٍ أو إعداد — مَن فعله ومتى وعلى أيّ سجلّ."
      />

      <ListToolbar
        search={search}
        onSearch={setSearch}
        placeholder="بحث بالإجراء (حذف، تأكيد…) أو نوع السجلّ أو معرّفه…"
        filters={filters}
        activeCount={activeCount}
        onReset={reset}
      />
      <div className="w-56">
        <DateRange value={range} onChange={setRange} label="كل المدة" />
      </div>

      {list.error && (
        <p className="text-sm text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] rounded-lg p-3">
          {list.error}
        </p>
      )}

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Rows
              rows={rows}
              keyOf={(l) => l.id}
              columns={[
                { key: 'when', label: 'الوقت', primary: true, render: (l) => arStamp(l.createdAt) },
                {
                  key: 'who',
                  label: 'مَن',
                  primary: true,
                  render: (l) => (
                    <>
                      {l.user?.name || 'النظام (تلقائي)'}
                      <span className="block text-xs text-[var(--sys-muted)] font-mono">{l.user?.role || 'SYSTEM'}</span>
                    </>
                  ),
                },
                {
                  key: 'action',
                  label: 'الإجراء',
                  render: (l) => (
                    <span title={l.action}>
                      <Badge variant="purple">{describeAction(l.action, l.entity)}</Badge>
                    </span>
                  ),
                },
                { key: 'entity', label: 'السجلّ', render: (l) => entityLabel(l.entity) },
                {
                  key: 'id',
                  label: 'المعرّف',
                  render: (l) => <RecordCell row={l} mayOpen={mayOpen} />,
                },
                {
                  key: 'what',
                  label: 'التفاصيل',
                  render: (l) => (
                    <>
                      {l.newData ? (
                        <span title={l.newData} className="bg-[var(--sys-surface)] px-2 py-0.5 rounded-lg">
                          {summariseChange(l.newData)}
                        </span>
                      ) : (
                        '—'
                      )}
                      {/* Said, so a missing amount does not read as a missing record. */}
                      {l.payWithheld && (
                        <span className="block text-xs text-[var(--sys-muted)]">المبالغ لا تظهر إلا لمن معه صلاحية «عرض الرواتب».</span>
                      )}
                      {l.partnersWithheld && (
                        <span className="block text-xs text-[var(--sys-muted)]">الأسماء والنسب والمبالغ لا تظهر إلا لمن معه صلاحية «الشركاء والسحوبات».</span>
                      )}
                    </>
                  ),
                },
              ]}
              empty={
                activeCount > 0 ? (
                  <EmptyState title="لا أحداث بهذه الاختيارات" why="جرّب كلمة أقصر أو مدة أوسع، أو اضغط «إعادة تعيين» لترى السجلّ كلّه." />
                ) : (
                  <EmptyState
                    title="لا أحداث في السجلّ بعد"
                    why="السجلّ يكتب نفسه: كلُّ تعديلٍ على طلبٍ أو مالٍ أو صلاحية يترك أثراً هنا. فراغُه يعني أنّ لا شيء تغيّر منذ بدء التسجيل."
                  />
                )
              }
            />
          </div>
        </CardContent>
      </Card>

      <Pager
        page={pagination.page}
        totalPages={pagination.totalPages}
        total={pagination.total}
        shown={rows.length}
        noun="حدث"
        loading={list.loading}
        onPage={list.goTo}
      />
    </div>
  );
}

/** The record's id, with «افتح» when it is an order or a product and the reader may open that screen. */
function RecordCell({ row, mayOpen }: { row: Row; mayOpen: (path: string) => boolean }) {
  const href = entityHref(row.entity, row.entityId);
  const door = row.entity === 'Order' ? '/orders' : '/products';
  return (
    <span className="flex items-center gap-2">
      <span className="font-mono text-xs text-[var(--sys-muted)]" dir="ltr" title={row.entityId}>
        {row.entityId.slice(0, 8)}
      </span>
      {href && mayOpen(door) && (
        <Link href={href} className="text-xs font-semibold text-[var(--sys-primary)] hover:underline">
          افتح
        </Link>
      )}
    </span>
  );
}
