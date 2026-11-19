'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadFailed } from '@/components/ui/LoadFailed';
import { apiJson } from '@/lib/api-client';
import type { LabelledDeskReadiness } from '@/lib/desk-readiness';
import { DeskPersonCheck } from './DeskPersonCheck';

/**
 * «مين مربوطة بالقواعد» — THE RULES PAGE SAYS, FOR EACH PERSON AT THE DESK, WHETHER «اسحبي الطلب أول» BINDS HER (request Q1b, 19/11).
 *
 * Reads `GET /api/confirmation/rules/people` and decides nothing: the server built each person from her effective grants (her role
 * rows, her personal «منع» / «سماح») and answered with the Arabic name of every key. One row per person — her name, her role, bound or
 * not and by which key, the desk's tools she lacks with the key each one misses, and a link to her page in «الموظفين».
 *
 * A list, not a table: each row is a block that stacks on a phone and lies flat from `md`, so thirty people never scroll sideways.
 * Imported by the rules page only — never by the desk («طلباتي»), whose bundle sits at its ceiling.
 */

export interface DeskPerson {
  id: string;
  name: string;
  roleLabel: string;
  readiness: LabelledDeskReadiness;
}

/** Her line beside the name: bound, the owner, exempt (with the key), or not at the desk's work at all. */
export function holdLine(r: LabelledDeskReadiness): string {
  switch (r.hold) {
    case 'BOUND':
      return 'مربوطة';
    case 'OWNER':
      return 'المالك — كل الصلاحيات، ما بتمسكه القاعدة';
    case 'EXEMPT':
      return `مش مربوطة — معها ${r.exemptBy.map((k) => `«${k.label}»`).join(' و')}`;
    default:
      return 'مش مربوطة — ما بتشتغل على طلبات المكتب';
  }
}

export const DECIDES_WITHOUT_WORK = 'بتأكّد وبترفض بلا ما تشتغل على المكتب — ولا قاعدة من قواعده بتمسكها';
export const NOBODY_AT_THE_DESK = 'ما في حدا على مكتب التأكيد بهالمتجر';
export const WHERE_ROLES_ARE_SET = 'مين بيشتغل على المكتب بيتحدد من مفاتيح الأدوار بشاشة «الصلاحيات»، ومن صفحة كل موظفة.';

export function DeskPeopleTable() {
  const [people, setPeople] = useState<DeskPerson[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const load = useCallback(async () => {
    setFailed(null);
    try {
      const answer = await apiJson<{ people: DeskPerson[] }>('/api/confirmation/rules/people');
      setPeople(answer.people);
    } catch (e) {
      setFailed(e instanceof Error ? e.message : 'تعذّر التحميل');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Card>
      <CardHeader
        title="مين مربوطة بالقواعد"
        subtitle="كل موظفة بتوصل لمكتب التأكيد بهالمتجر: إذا «اسحبي الطلب أول» بتمسكها، ولا شو المفتاح اللي معفيها، وشو ناقصها من أدوات المكتب. للقراءة بس."
      />
      <CardContent className="space-y-4">
        {failed ? (
          <LoadFailed message={failed} onRetry={() => void load()} />
        ) : !people ? (
          <p className="text-sm text-[var(--sys-muted-foreground)]">جاري التحميل…</p>
        ) : people.length === 0 ? (
          <EmptyState title={NOBODY_AT_THE_DESK} why={WHERE_ROLES_ARE_SET} action={{ label: 'افتح «الصلاحيات»', href: '/admin/permissions' }} />
        ) : (
          <ul className="divide-y divide-[var(--sys-border)]" data-desk-people>
            {people.map((p) => (
              <PersonRow key={p.id} person={p} />
            ))}
          </ul>
        )}
        {people && people.length > 0 && <DeskPersonCheck people={people.map(({ id, name }) => ({ id, name }))} />}
      </CardContent>
    </Card>
  );
}

function PersonRow({ person }: { person: DeskPerson }) {
  const r = person.readiness;
  const lacking = r.owner ? [] : r.tools.filter((t) => !t.has);
  return (
    <li className="flex flex-col gap-1 py-3 md:flex-row md:items-start md:justify-between" data-person={person.id} data-hold={r.hold}>
      <div className="min-w-0">
        <p className="text-sm font-medium text-[var(--sys-foreground)] break-words">
          {person.name} <span className="text-note text-[var(--sys-muted-foreground)]">· {person.roleLabel}</span>
        </p>
        <p className={`text-sm ${r.hold === 'BOUND' ? 'text-[var(--sys-foreground)]' : 'text-[var(--sys-warning)]'}`} data-hold-line>
          {holdLine(r)}
        </p>
        {r.decidesWithoutWork && (
          <p className="text-note text-[var(--sys-warning)]" data-decides-without-work>
            {DECIDES_WITHOUT_WORK}
          </p>
        )}
        {lacking.length > 0 && (
          <ul className="mt-1 space-y-0.5 text-note text-[var(--sys-muted-foreground)]" data-missing-tools>
            {lacking.map((t) => (
              <li key={t.id}>{`ناقصها ${t.labelAr}: بدها ${t.missing.map((m) => m.label).join(' و')}`}</li>
            ))}
          </ul>
        )}
      </div>
      <Link href={`/admin/users/${person.id}`} className="text-sm text-[var(--sys-primary)] hover:underline">
        صفحتها بالموظفين
      </Link>
    </li>
  );
}
