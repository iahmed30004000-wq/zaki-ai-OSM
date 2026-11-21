'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadFailed } from '@/components/ui/LoadFailed';
import { DateRange, type DateOption } from '@/components/ui/DateRange';
import { apiJson } from '@/lib/api-client';
import type { LabelledDeskReadiness } from '@/lib/desk-readiness';
import type { FiredPerson, RuleFiredAnswer } from '@/lib/rule-fired';
import { DeskPersonCheck, numbersSentences, type DeskNumbers } from './DeskPersonCheck';

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
  /** Her three numbers and the rule each came from (request Q4c, 21/11); null when the server could not read them. */
  numbers?: DeskNumbers | null;
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

/**
 * «القاعدة اشتغلت عندها كم مرة» (request Q2b, 19/11): beside each row, the day's figures from `GET /api/confirmation/rules/fired`.
 * Every number and the red line are the server's; the screen only names them. Today or yesterday — the store's days.
 */
export const FIRED_DAY_OPTIONS: readonly DateOption[] = ['today', 'yesterday'];
export const FIRED_LABELS: readonly (readonly [keyof FiredPerson, string])[] = [
  ['pulls', 'سحب'],
  ['countedNoAnswer', '«لا يرد» محسوبة'],
  ['earlyNoAnswer', '«لا يرد» بكير'],
  ['idleReturns', 'رجع لأنه ما انلمس'],
  ['noAnswerReturns', 'رجع بعد «لا يرد»'],
  ['autoCloses', 'انسكّر تلقائياً'],
  ['callProofRefusals', 'انرفض «لا يرد» بلا اتصال'],
];
export const NO_REFUSAL_LOG = 'سجل الرفض مش متوفر هلق — أرقام الرفض مش محسوبة.';
export const FIRED_TRUNCATED = 'اليوم فيه أكتر من الحد اللي بينقرا — في أرقام ناقصة.';

export function DeskPeopleTable() {
  const [people, setPeople] = useState<DeskPerson[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [fired, setFired] = useState<RuleFiredAnswer | null>(null);
  const [firedFailed, setFiredFailed] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setFiredFailed(null);
    apiJson<RuleFiredAnswer>(day ? `/api/confirmation/rules/fired?day=${encodeURIComponent(day)}` : '/api/confirmation/rules/fired')
      .then((answer) => {
        if (live) setFired(answer);
      })
      .catch((e) => {
        if (live) setFiredFailed(e instanceof Error ? e.message : 'تعذّر التحميل');
      });
    return () => {
      live = false;
    };
  }, [day]);
  const firedOf = new Map((fired?.people ?? []).map((f) => [f.userId, f]));

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
          <>
            <div className="space-y-1" data-fired-day>
              <DateRange
                value={fired ? { from: fired.day, to: fired.day } : undefined}
                onChange={(r) => setDay(r.from)}
                options={FIRED_DAY_OPTIONS}
                timeZone={fired?.timeZone}
                label="اليوم"
              />
              {firedFailed && (
                <p className="text-note text-[var(--sys-warning)]" data-fired-failed>
                  {`أرقام القواعد ما وصلت: ${firedFailed}`}
                </p>
              )}
              {fired && !fired.refusalLog && (
                <p className="text-note text-[var(--sys-warning)]" data-no-refusal-log>
                  {NO_REFUSAL_LOG}
                </p>
              )}
              {fired?.truncated && (
                <p className="text-note text-[var(--sys-warning)]" data-fired-truncated>
                  {FIRED_TRUNCATED}
                </p>
              )}
            </div>
            <ul className="divide-y divide-[var(--sys-border)]" data-desk-people>
              {people.map((p) => (
                <PersonRow key={p.id} person={p} fired={firedOf.get(p.id)} />
              ))}
            </ul>
          </>
        )}
        {people && people.length > 0 && <DeskPersonCheck people={people.map(({ id, name }) => ({ id, name }))} />}
      </CardContent>
    </Card>
  );
}

function PersonRow({ person, fired }: { person: DeskPerson; fired?: FiredPerson }) {
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
        {person.numbers && (
          <ul className="mt-1 space-y-0.5 text-note text-[var(--sys-muted-foreground)]" data-person-numbers>
            {numbersSentences(person.numbers).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
        {fired && <FiredLine fired={fired} />}
      </div>
      <Link href={`/admin/users/${person.id}`} className="text-sm text-[var(--sys-primary)] hover:underline">
        صفحتها بالموظفين
      </Link>
    </li>
  );
}

/** The day's figures of one person — every number as the server sent it, nothing added up here. */
function FiredLine({ fired }: { fired: FiredPerson }) {
  return (
    <div className="mt-1 space-y-0.5" data-fired={fired.userId}>
      {fired.alarmAr && (
        <p className="text-sm text-[var(--sys-destructive)]" data-alarm>
          {fired.alarmAr}
        </p>
      )}
      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-note text-[var(--sys-muted-foreground)]" data-fired-counters>
        {FIRED_LABELS.map(([key, label]) => (
          <li key={key} data-counter={key}>
            {`${label}: ${fired[key] as number}`}
          </li>
        ))}
      </ul>
      {fired.refusals.length > 0 && (
        <ul className="flex flex-wrap gap-x-3 gap-y-1 text-note text-[var(--sys-warning)]" data-fired-refusals>
          {fired.refusals.map((r) => (
            <li key={r.code} data-refusal={r.code}>{`انرفضت — ${r.labelAr}: ${r.count}`}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
