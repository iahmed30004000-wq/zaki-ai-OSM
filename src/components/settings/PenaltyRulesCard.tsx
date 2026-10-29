'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { apiJson } from '@/lib/api-client';
import { ROLE_LABELS } from '@/types/auth';
import { RiAddCircleLine, RiLoader4Line, RiShieldKeyholeLine } from '@remixicon/react';
import { useToast } from '@/components/ui/Toast';
import { Money } from '@/components/ui/Money';
import { useCan } from '@/hooks/useCan';

/**
 * THE RULES THAT PROPOSE A DEDUCTION.
 *
 * None of them applies one — that is always a person, on the deductions
 * screen, with their name on the decision.
 *
 * Grace and a cap are asked for on the same line as the price, not hidden
 * behind "advanced". A rule with no grace charges somebody every day
 * traffic exists, and a deduction that happens daily stops being a signal.
 * A rule with no cap can eat a salary over one illness. Both are mistakes
 * nobody notices until payday, which is the worst moment to notice one.
 */

interface Kind {
  key: string;
  ar: string;
  unitAr: string;
  sourceAr: string;
}
interface Rule {
  id: string;
  kind: string;
  role: string | null;
  perUnit: number;
  grace: number;
  periodCap: number | null;
  currencyCode: string;
  isActive: boolean;
}

const FIELD =
  'h-10 rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] px-2 text-xs text-[var(--sys-foreground)] outline-none focus:border-[var(--sys-primary)]';

export function PenaltyRulesCard() {
  const toast = useToast();
  // Adding a rule and switching one are «الإعدادات الحسّاسة»: the rules are seen by whoever opens the page.
  const canManage = useCan('settings.manage');
  const [kinds, setKinds] = useState<Kind[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState({
    kind: 'LATE',
    role: '',
    perUnit: '',
    grace: '10',
    periodCap: '',
    currencyCode: '',
  });

  const load = useCallback(async () => {
    try {
      const d = await apiJson<{ kinds: Kind[]; roles: string[]; rules: Rule[] }>('/api/settings/penalty-rules');
      setKinds(d.kinds ?? []);
      setRoles(d.roles ?? []);
      setRules(d.rules ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر التحميل');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!rules) return null;

  const kind = kinds.find((k) => k.key === draft.kind);
  const ready = Number(draft.perUnit) > 0 && /^[A-Za-z]{3}$/.test(draft.currencyCode.trim());

  const add = async () => {
    setBusy(true);
    try {
      await apiJson('/api/settings/penalty-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: draft.kind,
          role: draft.role || null,
          perUnit: Number(draft.perUnit),
          grace: Number(draft.grace || 0),
          periodCap: draft.periodCap ? Number(draft.periodCap) : null,
          currencyCode: draft.currencyCode.trim().toUpperCase(),
        }),
      });
      setDraft({ ...draft, perUnit: '', periodCap: '' });
      await load();
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذر الحفظ');
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (rule: Rule) => {
    setBusy(true);
    try {
      await apiJson('/api/settings/penalty-rules', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: rule.id, isActive: !rule.isActive }),
      });
      await load();
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذر الحفظ');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader
        title="قواعد الخصم"
        subtitle="تقترح فقط — لا خصم يصير مالاً إلا بقرار إنسان على شاشة «خصومات الموظفين»"
      />
      <CardContent className="space-y-3">
        {rules.length === 0 && (
          <p className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-surface)] p-3 text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
            لا قواعد بعد، فلا يُقترح أي خصم على أحد. الصمت ليس خصماً.
          </p>
        )}

        {rules.map((r) => {
          const k = kinds.find((x) => x.key === r.kind);
          return (
            <div
              key={r.id}
              className={`flex flex-wrap items-center gap-2 rounded-lg border p-2.5 text-xs ${
                r.isActive ? 'border-[var(--sys-border)]' : 'border-dashed border-[var(--sys-border)] bg-[var(--sys-surface)]'
              }`}
            >
              <span className="font-semibold text-[var(--sys-heading)]">{k?.ar ?? r.kind}</span>
              <span className="text-[var(--sys-muted-foreground)]">
                {r.role ? (ROLE_LABELS[r.role as keyof typeof ROLE_LABELS]?.ar ?? r.role) : 'كل الأدوار'}
              </span>
              <span className="tabular-nums text-[var(--sys-foreground)]" dir="ltr">
                <Money value={r.perUnit} currency={r.currencyCode} />/{k?.unitAr}
              </span>
              <span className="text-[var(--sys-muted-foreground)]">
                سماح <span className="tabular-nums">{r.grace}</span>
              </span>
              <span className="text-[var(--sys-muted-foreground)]">
                سقف{' '}
                {r.periodCap === null ? (
                  <span className="text-[var(--sys-destructive)]">بلا</span>
                ) : (
                  <span className="tabular-nums">{r.periodCap}</span>
                )}
              </span>
              {canManage && (
              <button
                type="button"
                disabled={busy}
                onClick={() => toggle(r)}
                className="min-h-11 md:min-h-0 inline-flex items-center ms-auto rounded-lg border border-[var(--sys-border)] px-2 py-0.5 text-xs text-[var(--sys-muted-foreground)]"
              >
                {r.isActive ? 'أوقفها' : 'شغّلها'}
              </button>
              )}
            </div>
          );
        })}

        {!canManage && <p className="text-xs text-[var(--sys-muted)]">قراءة فقط — التعديل لمن عنده «الإعدادات الحسّاسة».</p>}
        {canManage && (
        <div className="rounded-lg border border-[var(--sys-border)] p-2.5">
          <div className="flex flex-wrap items-end gap-2">
            <label className="block">
              <span className="mb-0.5 block text-xs text-[var(--sys-muted-foreground)]">النوع</span>
              <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })} className={`${FIELD} w-36`}>
                {kinds.map((k) => (
                  <option key={k.key} value={k.key}>{k.ar}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-0.5 block text-xs text-[var(--sys-muted-foreground)]">الدور</span>
              <select value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value })} className={`${FIELD} w-32`}>
                <option value="">كل الأدوار</option>
                {roles.map((r) => (
                  <option key={r} value={r}>{ROLE_LABELS[r as keyof typeof ROLE_LABELS]?.ar ?? r}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-0.5 block text-xs text-[var(--sys-muted-foreground)]">لكل {kind?.unitAr}</span>
              <input
                type="number"
                min={0}
                step="0.01"
                value={draft.perUnit}
                onChange={(e) => setDraft({ ...draft, perUnit: e.target.value })}
                className={`${FIELD} w-24`}
                dir="ltr"
              />
            </label>
            <label className="block">
              <span className="mb-0.5 block text-xs text-[var(--sys-muted-foreground)]">العملة</span>
              <input
                value={draft.currencyCode}
                onChange={(e) => setDraft({ ...draft, currencyCode: e.target.value })}
                maxLength={3}
                placeholder="SYP"
                className={`${FIELD} w-20`}
                dir="ltr"
              />
            </label>
            <label className="block">
              <span className="mb-0.5 block text-xs text-[var(--sys-muted-foreground)]">سماح ({kind?.unitAr})</span>
              <input
                type="number"
                min={0}
                value={draft.grace}
                onChange={(e) => setDraft({ ...draft, grace: e.target.value })}
                className={`${FIELD} w-24`}
                dir="ltr"
              />
            </label>
            <label className="block">
              <span className="mb-0.5 block text-xs text-[var(--sys-muted-foreground)]">سقف الفترة</span>
              <input
                type="number"
                min={0}
                value={draft.periodCap}
                onChange={(e) => setDraft({ ...draft, periodCap: e.target.value })}
                placeholder="بلا"
                className={`${FIELD} w-24`}
                dir="ltr"
              />
            </label>
            <Button size="sm" onClick={add} disabled={busy || !ready}>
              {busy ? <RiLoader4Line className="h-4 w-4 animate-spin" /> : <RiAddCircleLine className="h-4 w-4" />}
              أضف قاعدة
            </Button>
          </div>

          {kind && <p className="mt-2 text-xs leading-relaxed text-[var(--sys-muted)]">{kind.sourceAr}</p>}
          {!draft.periodCap && (
            <p className="mt-1 flex items-start gap-1 text-xs leading-relaxed text-[var(--sys-warning)]">
              <RiShieldKeyholeLine className="mt-px h-4 w-4 shrink-0" />
              بلا سقف، قاعدةٌ بالدقيقة قد تأكل راتباً كاملاً على مرضٍ واحد.
            </p>
          )}
        </div>
        )}

        {error && <p className="rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] p-2.5 text-xs text-[var(--sys-destructive)]">{error}</p>}
      </CardContent>
    </Card>
  );
}
