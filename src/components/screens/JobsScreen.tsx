'use client';

import React, { useCallback, useState } from 'react';
import { apiJson } from '@/lib/api-client';
import { Button } from '@/components/ui/Button';
import { ScreenTitle } from '@/components/shell/ScreenTitle';
import { RiAlertLine, RiArrowGoBackLine, RiCheckboxCircleLine, RiCloseCircleLine, RiLoader4Line, RiPlayLine, RiTimerLine } from '@remixicon/react';
import { Rows } from '@/components/ui/Rows';
import { EmptyState } from '@/components/ui/EmptyState';
import { arDateTime } from '@/lib/format';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { useCan } from '@/hooks/useCan';

/**
 * /admin/jobs — is anything quietly not running?
 *
 * That is the whole point of the screen. A job with nothing to do and a job
 * that stopped firing produce the same silence, so what is shown is the last
 * SUCCESS against the job's own interval: red when it has missed its window,
 * and louder still after three failures in a row.
 */

interface JobRow {
  name: string;
  description: string;
  everySeconds: number;
  /** The schedule in words, written by the server that owns it. */
  schedule: string;
  last: {
    status: string;
    startedAt: string;
    finishedAt: string | null;
    processed: number;
    detail: string | null;
    error: string | null;
  } | null;
  lastSuccessAt: string | null;
  overdue: boolean;
  consecutiveFailures: number;
  alerting: boolean;
  /** It stopped trying. Only a person starts it again. */
  parked: boolean;
}

interface RunRow {
  id: string;
  jobName: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  processed: number;
  detail: string | null;
  error: string | null;
}

function ago(iso: string | null): string {
  if (!iso) return 'لم تعمل بعد';
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'الآن';
  if (minutes < 60) return `قبل ${minutes} دقيقة`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `قبل ${hours} ساعة`;
  return `قبل ${Math.floor(hours / 24)} يوم`;
}

export function JobsScreen() {
  // Running a job by hand is «تشغيل المهام المجدولة» — the page opens on «عرض الإعدادات», so the buttons ask their own door's key.
  const canManage = useCan('settings.jobs');
  const [data, setData] = useState<{ jobs: JobRow[]; recent: RunRow[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [allBusy, setAllBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await apiJson<{ jobs: JobRow[]; recent: RunRow[] }>('/api/admin/jobs'));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر التحميل');
    }
  }, []);

  useLiveRefresh(load);

  const overdue = (data?.jobs ?? []).filter((j) => j.overdue);

  return (
    <div className="max-w-5xl space-y-3">
      <ScreenTitle />

      <p className="text-xs text-[var(--sys-muted-foreground)] bg-[var(--sys-surface)] border border-[var(--sys-border)] rounded-lg p-3">
        المهام تعمل في عملية مستقلة عن المتصفح:{' '}
        <code className="font-mono text-xs bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg px-1.5 py-0.5" dir="ltr">
          npx tsx scripts/worker.ts
        </code>
        . إن لم تكن تعمل، ستظهر المهام هنا «متأخرة».
      </p>

      {overdue.length > 0 && (
        <p className="text-sm text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] rounded-lg p-3 flex items-center gap-2">
          <RiAlertLine className="w-4 h-4 shrink-0" />
          {overdue.length} مهمة تجاوزت موعدها — تحقّق من أن المجدول يعمل.
        </p>
      )}

      {error && <p className="text-sm text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] rounded-lg p-3">{error}</p>}
      {done && <p className="text-sm text-[var(--sys-success)] bg-[var(--sys-success-soft)] border border-[var(--sys-success)]/30 rounded-lg p-3">{done}</p>}

      {/*
        ALL OF THEM, IN ORDER.

        The scheduler runs each on its own clock, which is right in normal
        operation and useless after it has been down: twelve jobs each need
        a separate click, and the order matters — claims are released before
        postponed orders are surfaced, commission accrues before penalties
        are proposed. One button runs them in the order they are declared,
        server-side, one at a time, and a failure in one does not stop the
        rest.
      */}
      {canManage && data && data.jobs.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] p-3">
          <p className="text-xs text-[var(--sys-muted-foreground)]">
            بعد توقّف المجدول، تشغيلُها واحدةً واحدةً اثنتا عشرة ضغطة — وبترتيبٍ يهمّ.
          </p>
          <Button
            size="sm"
            variant="outline"
            loading={allBusy}
            onClick={async () => {
              setAllBusy(true);
              setError(null);
              setDone(null);
              try {
                const res = await apiJson<{ ran: { job: string; ok: boolean }[] }>('/api/admin/jobs', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ job: '*' }),
                });
                const failed = res.ran.filter((r) => !r.ok).length;
                setDone(
                  failed === 0
                    ? `شُغّلت ${res.ran.length} مهمة بالترتيب، كلُّها نجحت.`
                    : `شُغّلت ${res.ran.length} مهمة — ${failed} منها لم تنجح. راجع «آخر التشغيلات».`
                );
                await load();
              } catch (e) {
                setError(e instanceof Error ? e.message : 'تعذّر التشغيل');
              } finally {
                setAllBusy(false);
              }
            }}
          >
            <RiPlayLine className="h-4 w-4" />
            شغّلها كلَّها بالترتيب
          </Button>
        </div>
      )}

      {!data ? (
        <div className="flex items-center justify-center gap-2 text-[var(--sys-muted-foreground)] text-sm py-16">
          <RiLoader4Line className="w-4 h-4 animate-spin" /> جارٍ التحميل…
        </div>
      ) : (
        <>
          <div className="space-y-2">
            {data.jobs.map((job) => (
              <div
                key={job.name}
                className={`bg-[var(--sys-card)] border rounded-lg p-4 ${
                  job.parked
                    ? 'border-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)]'
                    : job.alerting
                      ? 'border-[var(--sys-destructive)]'
                      : job.overdue
                        ? 'border-[var(--sys-warning)]/60'
                        : 'border-[var(--sys-border)]'
                }`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-[240px]">
                    <div className="flex items-center gap-2">
                      {job.last?.status === 'FAILED' ? (
                        <RiCloseCircleLine className="w-4 h-4 text-[var(--sys-destructive)]" />
                      ) : job.overdue ? (
                        <RiTimerLine className="w-4 h-4 text-[var(--sys-warning)]" />
                      ) : (
                        <RiCheckboxCircleLine className="w-4 h-4 text-[var(--sys-success)]" />
                      )}
                      <span className="text-sm font-medium text-[var(--sys-heading)]" dir="ltr">{job.name}</span>
                      <span className="text-xs text-[var(--sys-muted)]">{job.schedule}</span>
                    </div>
                    <p className="text-xs text-[var(--sys-muted-foreground)] mt-1">{job.description}</p>
                  </div>

                  <div className="text-xs text-[var(--sys-muted-foreground)] flex-1 min-w-[200px]">
                    <p>
                      آخر نجاح: <span className={job.overdue ? 'text-[var(--sys-destructive)] font-medium' : ''}>{ago(job.lastSuccessAt)}</span>
                    </p>
                    {job.last?.detail && <p className="text-[var(--sys-foreground)] mt-0.5">{job.last.detail}</p>}
                    {job.last?.error && <p className="text-[var(--sys-destructive)] mt-0.5">{job.last.error}</p>}
                    {job.consecutiveFailures > 0 && (
                      <p className="text-[var(--sys-destructive)] mt-0.5">
                        فشلت {job.consecutiveFailures} مرة متتالية
                        {job.alerting && ' — تحتاج تدخّلاً'}
                      </p>
                    )}
                    {/* Parked. Said as a sentence rather than a red border,
                        because the thing a person needs to know is that it
                        has STOPPED — not that it is unwell. */}
                    {job.parked && (
                      <p className="mt-1 rounded-lg bg-[var(--sys-destructive-soft)] px-2 py-1 text-[var(--sys-destructive)]">
                        توقّفت عن المحاولة بعد فشل متكرّر. لن تعمل حتى تُعيد تفعيلها — أصلح السبب
                        أولاً، فإعادة التفعيل بلا إصلاح تعيدها إلى الحائط نفسه.
                      </p>
                    )}
                  </div>

                  {canManage && (
                  <button
                    disabled={running === job.name}
                    onClick={async () => {
                      setRunning(job.name);
                      setError(null);
                      setDone(null);
                      try {
                        const res = await apiJson<{ processed: number; detail?: string }>('/api/admin/jobs', {
                          method: 'POST',
                          body: JSON.stringify({ job: job.name }),
                        });
                        setDone(`${job.name}: ${res.detail ?? res.processed}`);
                      } catch (e) {
                        setError(e instanceof Error ? e.message : 'فشلت المهمة');
                      } finally {
                        setRunning(null);
                        await load();
                      }
                    }}
                    className="h-8 px-3 rounded-lg border border-[var(--sys-border)] text-xs font-medium inline-flex items-center gap-1.5 disabled:opacity-50"
                  >
                    {running === job.name ? <RiLoader4Line className="w-4 h-4 animate-spin" /> : <RiPlayLine className="w-4 h-4" />}
                    شغّلها الآن
                  </button>
                  )}

                  {canManage && job.parked && (
                    <button
                      disabled={running === job.name}
                      onClick={async () => {
                        setRunning(job.name);
                        setError(null);
                        setDone(null);
                        try {
                          await apiJson('/api/admin/jobs', {
                            method: 'POST',
                            body: JSON.stringify({ job: job.name, action: 'unpark' }),
                          });
                          setDone(`${job.name}: أُعيد تفعيلها`);
                        } catch (e) {
                          setError(e instanceof Error ? e.message : 'تعذّر إعادة التفعيل');
                        } finally {
                          setRunning(null);
                          await load();
                        }
                      }}
                      className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] px-3 text-xs font-medium text-[var(--sys-destructive)] disabled:opacity-50"
                    >
                      <RiArrowGoBackLine className="icon-mirror h-4 w-4" />
                      أعد تفعيلها
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg overflow-hidden">
            <h2 className="text-sm font-medium text-[var(--sys-heading)] px-4 py-3 border-b border-[var(--sys-border)]">آخر التشغيلات</h2>
            {data.recent.length === 0 ? (
              <p className="text-sm text-[var(--sys-muted-foreground)] py-8 text-center">لم تعمل أي مهمة بعد.</p>
            ) : (
                            <Rows
                rows={data.recent}
                keyOf={(run) => run.id}
                columns={[
                  { key: 'c0', label: "المهمة", primary: true,
                    render: (run) => (run.jobName) },
                  { key: 'c1', label: "الحالة", primary: true,
                    render: (run) => (
                  <><span
                          className={`text-xs px-2 py-0.5 rounded-full border ${
                            run.status === 'SUCCEEDED'
                              ? 'bg-[var(--sys-success-soft)] border-[var(--sys-success)]/40 text-[var(--sys-success)]'
                              : run.status === 'FAILED'
                                ? 'bg-[var(--sys-destructive-soft)] border-[var(--sys-destructive-border)] text-[var(--sys-destructive)]'
                                : 'bg-[var(--sys-warning-soft)] border-[var(--sys-warning)]/40 text-[var(--sys-warning)]'
                          }`}
                        >
                          {run.status === 'SUCCEEDED' ? 'نجحت' : run.status === 'FAILED' ? 'فشلت' : 'تعمل'}
                        </span></>
                ) },
                  { key: 'c2', label: "البدء",
                    render: (run) => (
                  <>{arDateTime(run.startedAt)}</>
                ) },
                  { key: 'c3', label: "عدد", align: 'end',
                    render: (run) => (run.processed) },
                  { key: 'c4', label: "التفصيل",
                    render: (run) => (run.error ?? run.detail ?? '—') },
                ]}
                empty={
                  <EmptyState
                    title="لا تشغيلاتٍ مسجَّلة"
                    why="المهامُ المجدولة تكتب سطراً هنا في كلّ مرّة تعمل. فراغُ السجلّ يعني أنّ عاملَ المهامّ لم يعمل بعد — أو لا يعمل."
                  />
                }
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}
