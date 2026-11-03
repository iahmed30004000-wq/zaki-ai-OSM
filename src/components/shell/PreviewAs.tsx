'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { RiEyeLine } from '@remixicon/react';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Input';
import { apiJson } from '@/lib/api-client';

/**
 * «عاين كـ» — THE OWNER SEES WHAT ONE OF HIS PEOPLE SEES (src/lib/preview-mode.ts).
 *
 * Two pieces, both drawn only when the server says so:
 *
 *   · `PreviewPicker` — on the people screen, for the owner alone: pick a person (grouped by role) and press
 *     «عاين». The door (/api/preview) asks again who is really signed in; this card is the courtesy, not the lock.
 *   · `PreviewBanner` — on EVERY page while a preview is on, rendered by the system layout from the session: who is
 *     being looked at, that nothing can be written, and the way back.
 *
 * Both reload the whole page after the press: every screen, menu and list is computed on the server, and a reload is
 * the one way to have all of it computed again as the right person.
 */

interface Person {
  id: string;
  name: string;
  roleName: string;
}

interface PreviewState {
  people: Person[];
  active: { userId: string; name: string; roleName: string } | null;
}

export function PreviewPicker() {
  const [state, setState] = useState<PreviewState | null>(null);
  const [chosen, setChosen] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiJson<PreviewState>('/api/preview')
      .then(setState)
      .catch(() => setState(null));
  }, []);

  /** One group per role, in the order the server listed them. */
  const groups = useMemo(() => {
    const byRole = new Map<string, Person[]>();
    for (const p of state?.people ?? []) {
      if (!byRole.has(p.roleName)) byRole.set(p.roleName, []);
      byRole.get(p.roleName)!.push(p);
    }
    return [...byRole.entries()];
  }, [state]);

  if (!state || state.people.length === 0) return null;

  async function start() {
    if (!chosen) return;
    setError(null);
    try {
      await apiJson('/api/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: chosen }),
      });
      window.location.href = '/';
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ما زبطت المعاينة');
    }
  }

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <RiEyeLine className="h-4 w-4 text-[var(--sys-primary)]" aria-hidden />
            عاين كـ شخص
          </span>
        }
        subtitle="شوف النظام متل ما بتشوفه هي بالزبط — قائمتها وشاشاتها وطلباتها وعدّاداتها — بلا ما تدخل بحسابها. قراءة بس: أي حفظ أو تأكيد بينرفض لحد ما ترجع لحسابك، والمعاينة بتخلص لحالها بعد ساعتين."
      />
      <CardContent>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1">
            <Select label="مين بدك تعاين؟" value={chosen} onChange={(e) => setChosen(e.target.value)}>
              <option value="">— اختر شخص —</option>
              {groups.map(([role, people]) => (
                <optgroup key={role} label={role}>
                  {people.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
          </div>
          <Button onClick={start} disabled={!chosen}>
            <RiEyeLine className="h-4 w-4" />
            عاين
          </Button>
        </div>
        {error && <p className="mt-2 text-xs text-[var(--sys-destructive)]">{error}</p>}
      </CardContent>
    </Card>
  );
}

export function PreviewBanner({ name, roleName }: { name: string; roleName: string }) {
  const [busy, setBusy] = useState(false);

  async function leave() {
    setBusy(true);
    try {
      await apiJson('/api/preview', { method: 'DELETE' });
    } finally {
      // Whatever the answer, a full reload: the next page is computed as whoever the server now says.
      window.location.href = '/admin/users';
    }
  }

  return (
    <div
      role="status"
      dir="rtl"
      // The same height above the phone's bottom bar as the assistant's button (AiDock), so neither covers it.
      style={{ bottom: 'calc(var(--sys-mobile-nav-h) + env(safe-area-inset-bottom) + 0.75rem)' }}
      className="fixed inset-x-0 z-50 mx-auto flex w-fit max-w-full flex-wrap items-center gap-2 rounded-lg border border-[var(--sys-warning)] bg-[var(--sys-card)] px-3 py-2 text-xs font-bold text-[var(--sys-heading)] shadow-raised"
    >
      <RiEyeLine className="h-4 w-4 shrink-0 text-[var(--sys-warning)]" aria-hidden />
      <span>
        عم تعاين كـ {name} ({roleName}) — قراءة بس
      </span>
      <Button size="sm" variant="outline" onClick={leave} disabled={busy}>
        رجوع لحسابي
      </Button>
    </div>
  );
}
