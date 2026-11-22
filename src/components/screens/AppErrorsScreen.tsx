'use client';
import React, { useCallback, useState } from 'react';
import { apiJson } from '@/lib/api-client';
import { PageShell } from '@/components/ui/PageShell';
import { Card } from '@/components/ui/Card';
import { Rows } from '@/components/ui/Rows';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Input';
import { EmptyState } from '@/components/ui/EmptyState';
import { routeLabel } from '@/lib/route-registry';
import { arDate } from '@/lib/format';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { RiLoader4Line } from '@remixicon/react';

/**
 * /control/app-errors — WHAT WENT WRONG ON THE «ZAKI ORDERS» PHONES (22/11).
 *
 * The app sends its crashes, its frozen screens (ANR, and its own watchdog after four seconds) and the errors it caught;
 * this lists them newest first, with who was signed in, the screen, the version and the phone. No customer data is in
 * any of it (client-error.ts). Read-only: nothing here is deleted.
 */
interface AppError {
  id: string;
  kind: 'CRASH' | 'ANR' | 'ERROR';
  message: string;
  stack: string | null;
  screen: string | null;
  appVersion: string;
  versionCode: number | null;
  device: string | null;
  osVersion: string | null;
  occurredAt: string;
  userName: string | null;
}

const KIND_AR: Record<AppError['kind'], string> = { CRASH: 'انهيار', ANR: 'تعليق', ERROR: 'خطأ' };

export function AppErrorsScreen() {
  const [rows, setRows] = useState<AppError[] | null>(null);
  const [week, setWeek] = useState<Record<string, number>>({});
  const [kind, setKind] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const q = kind ? `?kind=${kind}` : '';
      const data = await apiJson<{ errors: AppError[]; lastWeek: Record<string, number> }>(`/api/client-errors${q}`);
      setRows(data.errors);
      setWeek(data.lastWeek);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر التحميل');
    }
  }, [kind]);

  useLiveRefresh(load, { key: kind });

  return (
    <PageShell
      title={routeLabel('/control/app-errors')}
      width="wide"
      filters={
        <Card padding="md">
          <div className="flex flex-wrap gap-3 items-end">
            <div className="min-w-[220px]">
              <Select
                label="النوع"
                value={kind}
                onChange={(e) => setKind(e.target.value)}
                options={[
                  { value: '', label: 'الكل' },
                  { value: 'CRASH', label: 'انهيار' },
                  { value: 'ANR', label: 'تعليق' },
                  { value: 'ERROR', label: 'خطأ' },
                ]}
              />
            </div>
            <p className="text-note text-[var(--sys-muted-foreground)]">
              آخر 7 أيام: {KIND_AR.CRASH} {week.CRASH ?? 0} · {KIND_AR.ANR} {week.ANR ?? 0} · {KIND_AR.ERROR} {week.ERROR ?? 0}
            </p>
          </div>
        </Card>
      }
    >
      {error && <p className="text-sm text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] rounded-lg p-3">{error}</p>}
      {!rows ? (
        <div className="flex items-center justify-center gap-2 text-[var(--sys-muted-foreground)] text-sm py-16">
          <RiLoader4Line className="w-4 h-4 animate-spin" /> جارٍ التحميل…
        </div>
      ) : (
        <Card plain className="overflow-hidden">
          <Rows
            rows={rows}
            keyOf={(r) => r.id}
            columns={[
              { key: 'c0', label: 'النوع', primary: true, render: (r) => KIND_AR[r.kind] ?? r.kind },
              {
                key: 'c1',
                label: 'الرسالة',
                primary: true,
                render: (r) => (
                  <>
                    <Button type="button" variant="quiet" size="sm" onClick={() => setOpen(open === r.id ? null : r.id)}>
                      {r.message}
                    </Button>
                    {open === r.id && r.stack && (
                      <pre dir="ltr" className="block text-note text-[var(--sys-muted)] mt-1 whitespace-pre-wrap">{r.stack}</pre>
                    )}
                  </>
                ),
              },
              { key: 'c2', label: 'الشاشة', render: (r) => r.screen ?? '—' },
              { key: 'c3', label: 'الموظف', render: (r) => r.userName ?? '—' },
              {
                key: 'c4',
                label: 'النسخة والجهاز',
                render: (r) => (
                  <>
                    {r.appVersion}
                    <span className="block text-note text-[var(--sys-muted)]">
                      {[r.device, r.osVersion].filter(Boolean).join(' · ') || '—'}
                    </span>
                  </>
                ),
              },
              { key: 'c5', label: 'الوقت', align: 'end', render: (r) => arDate(r.occurredAt) },
            ]}
            empty={<EmptyState title="لا أعطال" why="ما وصل أي تقرير عطل من تطبيق «Zaki Orders» بهالفلتر." />}
          />
        </Card>
      )}
    </PageShell>
  );
}
