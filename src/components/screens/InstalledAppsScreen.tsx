'use client';

import React, { useCallback, useState } from 'react';
import Link from 'next/link';
import { apiJson } from '@/lib/api-client';
import { arDateTime } from '@/lib/format';
import { RiAlertLine, RiCheckboxCircleLine, RiCloseCircleLine, RiLoader4Line, RiShieldCheckLine, RiTimerLine } from '@remixicon/react';
import { PageHeader } from '@/components/ui/PageHeader';
import { SystemTokensPanel } from '@/components/apps/SystemTokensPanel';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { useApp } from '@/context/AppContext';
import { userCan } from '@/lib/can';

/**
 * /apps/installed — what is connected, and whether it is hearing us.
 *
 * The second half is the point. A webhook that fails quietly is an
 * integration that stopped quietly: the seller believes the two systems are
 * in step and the developer cannot find out they are not. This screen says
 * what was sent, whether it arrived, and what came back when it did not.
 */

interface Delivery {
  id: string;
  appCode: string;
  event: string;
  url: string;
  status: 'PENDING' | 'OK' | 'FAILED';
  attempts: number;
  responseCode: number | null;
  error: string | null;
  nextAttemptAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
  payload: string;
}

interface Shelf {
  builtIn: { code: string; name: string; summary: string; settingsPath: string; installed: boolean; enabled: boolean; configured: boolean }[];
  external: { id: string; code: string; name: string; webhookUrl: string | null; events: string[]; installed: boolean; enabled: boolean }[];
}

export function InstalledAppsScreen() {
  const { currentUser } = useApp();
  const [shelf, setShelf] = useState<Shelf | null>(null);
  const [deliveries, setDeliveries] = useState<Delivery[] | null>(null);
  const [totals, setTotals] = useState({ pending: 0, failed: 0, ok: 0 });
  const [filter, setFilter] = useState<'all' | 'FAILED' | 'PENDING'>('all');
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, d] = await Promise.all([
        apiJson<Shelf>('/api/apps'),
        apiJson<{ deliveries: Delivery[]; totals: typeof totals }>(
          `/api/apps/deliveries${filter === 'all' ? '' : `?status=${filter}`}`
        ),
      ]);
      setShelf(s);
      setDeliveries(d.deliveries);
      setTotals(d.totals);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر التحميل');
    }
  }, [filter]);

  useLiveRefresh(load, { key: filter });

  if (!shelf || !deliveries) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-[var(--sys-muted-foreground)]">
        <RiLoader4Line className="h-4 w-4 animate-spin" /> جارٍ التحميل…
      </div>
    );
  }

  const installedBuiltIn = shelf.builtIn.filter((a) => a.installed);
  const installedExternal = shelf.external.filter((a) => a.installed);
  const nothing = installedBuiltIn.length === 0 && installedExternal.length === 0;

  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader title="التطبيقات المثبتة"
          description="ما هو موصول بشركتك الآن، وسجلّ ما أُرسل إليه."
        />

      {error && <p className="rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] p-3 text-sm text-[var(--sys-destructive)]">{error}</p>}

      {nothing ? (
        <p className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] p-6 text-center text-sm text-[var(--sys-muted-foreground)]">
          لا تطبيقات مثبتة.{' '}
          <Link href="/apps/store" className="font-bold text-[var(--sys-primary)] hover:underline">افتح متجر التطبيقات</Link>
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {installedBuiltIn.map((a) => (
            <div key={a.code} className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-bold text-[var(--sys-heading)]">{a.name}</p>
                  <p className="text-xs text-[var(--sys-muted-foreground)]">{a.summary}</p>
                </div>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${
                  a.enabled ? 'bg-[var(--sys-success-soft)] text-[var(--sys-success)]' : 'bg-[var(--sys-surface-strong)] text-[var(--sys-muted-foreground)]'
                }`}>
                  {a.enabled ? 'مفعَّل' : 'موقوف'}
                </span>
              </div>
              <p className={`mt-2 flex items-center gap-1.5 text-xs ${a.configured ? 'text-[var(--sys-success)]' : 'text-[var(--sys-warning)]'}`}>
                {a.configured ? <RiShieldCheckLine className="h-4 w-4" /> : <RiAlertLine className="h-4 w-4" />}
                {a.configured ? 'مهيَّأ' : 'غير مهيَّأ'}
              </p>
              <Link href={a.settingsPath} className="mt-2 inline-block text-xs font-bold text-[var(--sys-primary)] hover:underline">
                الإعدادات ←
              </Link>
            </div>
          ))}

          {installedExternal.map((a) => (
            <div key={a.id} className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-bold text-[var(--sys-heading)]">{a.name}</p>
                  {a.webhookUrl && (
                    <p className="truncate font-mono text-xs text-[var(--sys-muted-foreground)]" dir="ltr">{a.webhookUrl}</p>
                  )}
                </div>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${
                  a.enabled ? 'bg-[var(--sys-success-soft)] text-[var(--sys-success)]' : 'bg-[var(--sys-surface-strong)] text-[var(--sys-muted-foreground)]'
                }`}>
                  {a.enabled ? 'مفعَّل' : 'موقوف'}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                {a.events.map((e) => (
                  <span key={e} className="rounded-full bg-[var(--sys-surface-strong)] px-2 py-0.5 font-mono text-xs text-[var(--sys-foreground)]" dir="ltr">{e}</span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/*
        THE OTHER DIRECTION OF THE SAME QUESTION.
        Above: what WE send out. Here: the keys another system calls US with
        — «الإعدادات ← التطبيقات ← توكنات الأنظمة», where the contract says
        it belongs. One screen, so «ما هو موصول بشركتك» has one answer.
      */}
      {/* Its own key (PR-13): the shelf above opens on «عرض التطبيقات»; the keys other systems call us with are `apps.tokens`. */}
      {userCan(currentUser, 'apps.tokens') && <SystemTokensPanel />}

      <section>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-xs font-bold text-[var(--sys-muted-foreground)]">سجل الإرسال</h2>
          <div className="flex items-center gap-1.5">
            {([
              ['all', `الكل`],
              ['FAILED', `فشل ${totals.failed}`],
              ['PENDING', `بالانتظار ${totals.pending}`],
            ] as const).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setFilter(k)}
                className={`min-h-11 md:min-h-0 inline-flex items-center cursor-pointer rounded-lg border px-2.5 py-1 text-xs font-semibold ${
                  filter === k ? 'border-[var(--sys-primary)] bg-[var(--sys-primary-soft)] text-[var(--sys-primary)]' : 'border-[var(--sys-border)] text-[var(--sys-muted-foreground)]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {deliveries.length === 0 ? (
          <p className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] p-6 text-center text-xs text-[var(--sys-muted-foreground)]">
            لا إرساليات بعد — تظهر هنا عند أول حدث بعد تثبيت تطبيق يستمع إليه.
          </p>
        ) : (
          <ul className="divide-y divide-[var(--sys-border)] rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)]">
            {deliveries.map((d) => (
              <li key={d.id}>
                <button
                  onClick={() => setOpen(open === d.id ? null : d.id)}
                  className="flex w-full cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 p-3 text-start hover:bg-[var(--sys-surface)]"
                >
                  {d.status === 'OK' && <RiCheckboxCircleLine className="h-4 w-4 shrink-0 text-[var(--sys-success)]" />}
                  {d.status === 'FAILED' && <RiCloseCircleLine className="h-4 w-4 shrink-0 text-[var(--sys-destructive)]" />}
                  {d.status === 'PENDING' && <RiTimerLine className="h-4 w-4 shrink-0 text-[var(--sys-warning)]" />}

                  <span className="font-mono text-xs font-bold text-[var(--sys-heading)]" dir="ltr">{d.event}</span>
                  <span className="text-xs text-[var(--sys-muted-foreground)]">{d.appCode}</span>
                  <span className="text-xs text-[var(--sys-muted)]">{arDateTime(d.createdAt)}</span>

                  {d.attempts > 1 && (
                    <span className="text-xs text-[var(--sys-warning)]">{d.attempts} محاولات</span>
                  )}
                  {d.responseCode !== null && (
                    <span className="font-mono text-xs text-[var(--sys-muted-foreground)]" dir="ltr">HTTP {d.responseCode}</span>
                  )}
                  {d.status === 'PENDING' && d.nextAttemptAt && (
                    <span className="text-xs text-[var(--sys-muted)]">المحاولة القادمة {arDateTime(d.nextAttemptAt)}</span>
                  )}
                  {d.error && <span className="ms-auto truncate text-xs text-[var(--sys-destructive)]">{d.error}</span>}
                </button>

                {open === d.id && (
                  <div className="border-t border-[var(--sys-border)] bg-[var(--sys-surface)] p-3">
                    <p className="mb-1 text-xs font-semibold text-[var(--sys-muted-foreground)]" dir="ltr">{d.url}</p>
                    <pre className="overflow-x-auto rounded-lg bg-[var(--sys-heading)] p-3 font-mono text-xs leading-relaxed text-[var(--sys-border-strong)]" dir="ltr">
                      {prettyJson(d.payload)}
                    </pre>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** Readable when it is JSON, verbatim when it is not — never a crash. */
function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
