'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { apiJson } from '@/lib/api-client';
import { useToast } from '@/components/ui/Toast';
import { useCan } from '@/hooks/useCan';
import { activeSharesTotal, sharesProblem } from '@/lib/partner-statement-core';

/**
 * «الشركاء والنسب» — THE PARTNERS AND THEIR SHARES OF THE NET PROFIT, ON THE SETTINGS SCREEN (13/11).
 *
 * «هلأ احنا ٤ شركاء … الربح لازم يتم توزيعه وفق هاي النسب … السحوبات لازم كمان تكون وفق هاي النسب» (the owner).
 *
 * Seen and saved only by who holds `finance.partners` — the card is not drawn for anybody else, so nobody is offered a press that
 * ends in a refusal; the door asks the key again. Rows of a name and a percent, a box to switch a partner off (a partner is never
 * deleted: he stays in the statement while his draws stand), a button to add one, and a total that is printed as the person types and
 * must read exactly 100 before «حفظ» can be pressed. The refusal printed under the list is the very sentence the door would answer
 * with — it is the same function (`sharesProblem`) — so nothing is learned only after the press.
 *
 * WHEN NOTHING IS SAVED YET, the four the owner named are drawn as EDITABLE rows and are written nowhere until he presses «حفظ»: they
 * live in this form's initial state (`STARTING_ROWS`) and in no other file — no migration, no seed, no line of code writes them.
 */

interface SavedPartner {
  id: string;
  name: string;
  sharePercent: number;
  isActive: boolean;
  sortOrder: number;
}
interface Answer {
  partners: SavedPartner[];
  sharesTotal: number;
}
/** A row as the form holds it: what the boxes contain, as characters. */
interface Row {
  key: string;
  id?: string;
  name: string;
  share: string;
  isActive: boolean;
}

/** «محمد كوري 15% · عبدالله كيوان 15% · محمد كيوان 15% · احمد كيوان 55%» — the owner's own list, as a starting point to edit. */
const STARTING_ROWS = [
  { name: 'محمد كوري', share: '15' },
  { name: 'عبدالله كيوان', share: '15' },
  { name: 'محمد كيوان', share: '15' },
  { name: 'احمد كيوان', share: '55' },
];

const asShareRows = (rows: Row[]) => rows.map((r) => ({ name: r.name, sharePercent: r.share, isActive: r.isActive }));
const snapshot = (rows: Row[]) => JSON.stringify(rows.map((r) => [r.id ?? '', r.name.trim(), r.share.trim(), r.isActive]));

export function PartnersCard() {
  const may = useCan('finance.partners');
  return may ? <PartnersForm /> : null;
}

function PartnersForm() {
  const toast = useToast();
  const keys = useRef(0);
  const [saved, setSaved] = useState<SavedPartner[] | null>(null);
  const [failedToLoad, setFailedToLoad] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [fresh, setFresh] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const adopt = useCallback((list: SavedPartner[]) => {
    setSaved(list);
    setError(null);
    if (list.length === 0) {
      setFresh(true);
      setRows(STARTING_ROWS.map((r) => ({ key: `start-${++keys.current}`, ...r, isActive: true })));
    } else {
      setFresh(false);
      setRows(list.map((p) => ({ key: p.id, id: p.id, name: p.name, share: String(p.sharePercent), isActive: p.isActive })));
    }
  }, []);

  useEffect(() => {
    let alive = true;
    apiJson<Answer>('/api/finance/partners')
      .then((answer) => {
        if (alive) adopt(answer.partners);
      })
      .catch(() => {
        if (alive) setFailedToLoad(true);
      });
    return () => {
      alive = false;
    };
  }, [adopt]);

  const change = (key: string, patch: Partial<Row>) => setRows((all) => all.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const add = () => setRows((all) => [...all, { key: `new-${++keys.current}`, name: '', share: '', isActive: true }]);

  const problem = sharesProblem(asShareRows(rows));
  const total = activeSharesTotal(asShareRows(rows));
  const savedRows: Row[] = (saved ?? []).map((p) => ({ key: p.id, id: p.id, name: p.name, share: String(p.sharePercent), isActive: p.isActive }));
  // Nothing saved yet counts as changed: the four on the screen are not the database's until the press.
  const dirty = fresh || snapshot(rows) !== snapshot(savedRows);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (problem || busy) return;
    setBusy(true);
    setError(null);
    try {
      const answer = await apiJson<Answer>('/api/finance/partners', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        // The characters the boxes hold: the door reads them strictly, and refuses what is not a number.
        body: JSON.stringify({
          partners: rows.map((r) => ({ ...(r.id ? { id: r.id } : {}), name: r.name.trim(), sharePercent: r.share.trim(), isActive: r.isActive })),
        }),
      });
      adopt(answer.partners);
      toast.done('انحفظ الشركاء ونسبهم');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذّر الحفظ');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader
        title="الشركاء والنسب"
        subtitle="نسبة كل شريك من صافي الربح. مجموع نسب الشركاء الفعّالين لازم يكون 100 بالضبط، والنسب الحالية بتنطبق على كل التاريخ — ما في نسب قديمة محفوظة."
      />
      <CardContent>
        {failedToLoad ? (
          <p className="text-xs text-[var(--sys-destructive)]">تعذّر تحميل الشركاء — حدّث الصفحة وجرّب من جديد.</p>
        ) : saved === null ? (
          <p className="text-xs text-[var(--sys-muted-foreground)]">جارٍ التحميل…</p>
        ) : (
          <form onSubmit={save} className="space-y-4">
            {fresh && (
              <p className="text-xs text-[var(--sys-warning)]">ما في شركاء محفوظين لسا — هدول الأربعة جاهزين للتعديل، اضغط «حفظ» لما تتأكد منهم.</p>
            )}

            <ul className="divide-y divide-[var(--sys-border)]">
              {rows.map((r) => (
                <li key={r.key} className="flex flex-wrap items-end gap-3 py-3">
                  <div className="min-w-[220px] flex-1">
                    <Input label="الاسم" value={r.name} maxLength={60} onChange={(e) => change(r.key, { name: e.target.value })} />
                  </div>
                  <div className="w-28">
                    <Input
                      label="النسبة (%)"
                      type="number"
                      inputMode="decimal"
                      step="0.01"
                      min="0.01"
                      max="100"
                      dir="ltr"
                      value={r.share}
                      onChange={(e) => change(r.key, { share: e.target.value })}
                    />
                  </div>
                  <label className="flex min-h-11 md:min-h-0 items-center gap-1 text-xs text-[var(--sys-muted-foreground)]">
                    <input
                      type="checkbox"
                      checked={r.isActive}
                      onChange={(e) => change(r.key, { isActive: e.target.checked })}
                      className="h-5 w-5 accent-[var(--sys-primary)]"
                    />
                    فعّال
                  </label>
                </li>
              ))}
            </ul>

            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" size="sm" onClick={add}>
                إضافة شريك
              </Button>
              <span
                className={`text-xs font-medium tabular-nums ${
                  Math.round(total * 100) === 10000 ? 'text-[var(--sys-success)]' : 'text-[var(--sys-destructive)]'
                }`}
              >
                {Math.round(total * 100) === 10000 ? `المجموع ${total} — تمام` : `المجموع ${total} — لازم يكون 100 بالضبط`}
              </span>
            </div>
            <p className="text-xs text-[var(--sys-muted-foreground)]">الشريك ما بينحذف، بينوقّف — وبيضل ظاهر بالكشف طول ما سحوباته قائمة.</p>

            {problem && (
              <p className="rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] p-2.5 text-xs text-[var(--sys-destructive)]">
                {problem.error}
              </p>
            )}
            {error && (
              <p className="rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] p-2.5 text-xs text-[var(--sys-destructive)]">
                {error}
              </p>
            )}

            <div className="flex justify-end">
              <Button type="submit" disabled={!!problem || !dirty} loading={busy}>
                حفظ
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
