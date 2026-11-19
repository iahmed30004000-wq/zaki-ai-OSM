'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { RiAddCircleLine, RiArchiveLine } from '@remixicon/react';
import { apiJson } from '@/lib/api-client';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { Input } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';
import { useAsk } from '@/components/ui/Confirm';
import { useToast } from '@/components/ui/Toast';

/**
 * «المخازن» UNDER ONE COUNTRY of /settings/geo (warehouse plan, request W0b).
 *
 * A warehouse is a place of ONE country (`src/lib/warehouses.ts`): it may
 * hold the goods of any store of that country. Defining one moves no unit —
 * every store's stock stays where it is until that store's opening placement
 * («توزيع الرصيد على المخازن»), and the empty state says so before the first
 * one is made.
 *
 * Everybody who may open the geo screen sees the list; only `geo.manage`
 * (`mayManage`) gets the controls. That is UX only: the doors ask the key
 * again, and the keepers' names reach only `geo.manage` holders anyway.
 *
 * No arithmetic and no rule here: who may be a keeper (people who reach the
 * country) is the server's answer (`candidates`), and every refusal is the
 * server's own sentence, shown under the row it belongs to.
 */

interface Person {
  id: string;
  name: string;
}
interface WarehouseRow {
  id: string;
  name: string;
  isActive: boolean;
  /** Only for geo.manage holders — the door leaves it out for anybody else. */
  keepers?: Person[];
}

export function WarehousesCard({ countryId, countryName, mayManage }: { countryId: string; countryName: string; mayManage: boolean }) {
  const toast = useToast();
  const ask = useAsk();
  const [rows, setRows] = useState<WarehouseRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  /** The door's last refusal for each row — read where it happened, not in a toast. */
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [picking, setPicking] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiJson<{ warehouses: WarehouseRow[] }>(`/api/geo/warehouses?countryId=${encodeURIComponent(countryId)}`);
      setRows(res.warehouses);
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error | undefined)?.message || 'تعذّر تحميل المخازن');
    }
  }, [countryId]);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (name.trim().length < 2) return;
    setAddError(null);
    try {
      await apiJson('/api/geo/warehouses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ countryId, name: name.trim() }),
      });
      setName('');
      toast.done(`انضاف المخزن «${name.trim()}»`);
      await load();
    } catch (err) {
      setAddError((err as Error | undefined)?.message || 'تعذّرت الإضافة');
    }
  };

  const patch = async (w: WarehouseRow, data: { name?: string; isActive?: boolean }) => {
    setRowError((cur) => ({ ...cur, [w.id]: '' }));
    try {
      await apiJson(`/api/geo/warehouses/${w.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
    } catch (err) {
      setRowError((cur) => ({ ...cur, [w.id]: (err as Error | undefined)?.message || 'تعذّر الحفظ' }));
    }
    // Either way the picture was old: a refusal means something arrived since it was drawn.
    await load();
  };

  const rename = async (w: WarehouseRow) => {
    const typed = await ask({
      title: `اسم جديد للمخزن «${w.name}»`,
      confirmLabel: 'احفظ الاسم',
      input: { label: 'اسم المخزن', initial: w.name, required: true, maxLength: 60 },
    });
    if (typed === null || typed.trim() === w.name) return;
    await patch(w, { name: typed.trim() });
  };

  return (
    <Card plain padding="sm">
      <p className="text-note font-medium text-[var(--sys-foreground)] mb-2">المخازن</p>
      {loadError && (
        <p role="alert" className="text-note text-[var(--sys-destructive)] mb-2">
          {loadError}
        </p>
      )}

      {rows?.length === 0 && (
        <p className="max-w-prose text-note leading-relaxed text-[var(--sys-muted-foreground)] mb-3">
          ما في مخازن بـ{countryName}. المخزن مكان بتنحط فيه بضاعة أي متجر بهالبلد، وإله أمين أو أكتر. تعريفه ما بيحرّك ولا
          قطعة: رصيد كل متجر بيضل متل ما هو لحد «توزيع الرصيد على المخازن».
        </p>
      )}

      {rows && rows.length > 0 && (
        <ul className="divide-y divide-[var(--sys-border)] mb-3">
          {rows.map((w) => (
            <li key={w.id} className="py-3">
              <div className="flex flex-wrap items-center gap-3">
                <RiArchiveLine className="w-4 h-4 text-[var(--sys-muted-foreground)]" aria-hidden />
                <div className="flex-1 min-w-[150px]">
                  <p className="text-sm font-medium text-[var(--sys-heading)]">
                    {w.name}
                    {!w.isActive && <span className="text-note text-[var(--sys-destructive)]"> · موقوف</span>}
                  </p>
                  {w.keepers && (
                    <p className="text-note text-[var(--sys-muted-foreground)]">
                      {w.keepers.length > 0 ? `الأمناء: ${w.keepers.map((k) => k.name).join('، ')}` : 'بلا أمين'}
                    </p>
                  )}
                </div>
                {mayManage && (
                  <>
                    <Button type="button" size="sm" variant="secondary" onClick={() => rename(w)}>
                      تغيير الاسم
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant={picking === w.id ? 'primary' : 'secondary'}
                      aria-expanded={picking === w.id}
                      onClick={() => setPicking((cur) => (cur === w.id ? null : w.id))}
                    >
                      الأمناء
                    </Button>
                  </>
                )}
              </div>
              {mayManage && (
                <div className="mt-2">
                  <Switch
                    id={`warehouse-active-${w.id}`}
                    checked={w.isActive}
                    onChange={(next) => patch(w, { isActive: next })}
                    label="المخزن شغّال"
                  />
                </div>
              )}
              {rowError[w.id] && (
                <p role="alert" className="mt-1 text-note text-[var(--sys-destructive)]">
                  {rowError[w.id]}
                </p>
              )}
              {mayManage && picking === w.id && (
                <KeepersPicker
                  warehouse={w}
                  onClose={() => setPicking(null)}
                  onSaved={async () => {
                    setPicking(null);
                    await load();
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      )}

      {mayManage && (
        <form onSubmit={add} className="flex flex-wrap items-end gap-2">
          <div className="flex-1 min-w-[150px]">
            <Input
              label={`مخزن جديد بـ${countryName}`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="اسم المخزن"
              maxLength={60}
              error={addError ?? undefined}
            />
          </div>
          <Button type="submit" variant="secondary" disabled={name.trim().length < 2}>
            <RiAddCircleLine className="w-4 h-4" /> إضافة
          </Button>
        </form>
      )}
    </Card>
  );
}

/**
 * WHO KEEPS IT. The list to choose from is the server's: the active people
 * who reach the warehouse's country. A keeper who has since lost the country
 * stays ticked with a note — her row narrows, it never grants — and the owner
 * decides whether to un-tick her. A keeper sees only the warehouses she keeps.
 */
function KeepersPicker({ warehouse, onClose, onSaved }: { warehouse: WarehouseRow; onClose: () => void; onSaved: () => Promise<void> }) {
  const [data, setData] = useState<{ keepers: (Person & { reachesCountry: boolean })[]; candidates: Person[] } | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    apiJson<{ keepers: (Person & { reachesCountry: boolean })[]; candidates: Person[] }>(`/api/geo/warehouses/${warehouse.id}/keepers`)
      .then((res) => {
        if (!live) return;
        setData(res);
        setChosen(new Set(res.keepers.map((k) => k.id)));
      })
      .catch((e: unknown) => live && setError((e as Error | undefined)?.message || 'تعذّر تحميل الأمناء'));
    return () => {
      live = false;
    };
  }, [warehouse.id]);

  const save = async () => {
    setError(null);
    try {
      await apiJson(`/api/geo/warehouses/${warehouse.id}/keepers`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userIds: [...chosen] }),
      });
      await onSaved();
    } catch (e) {
      setError((e as Error | undefined)?.message || 'تعذّر الحفظ');
    }
  };

  // The current keepers first (one may no longer reach the country), then everyone else who may be named.
  const lost = data?.keepers.filter((k) => !k.reachesCountry) ?? [];
  const people: (Person & { lost?: boolean })[] = [...lost.map((k) => ({ ...k, lost: true })), ...(data?.candidates ?? [])];

  return (
    <Card plain padding="sm" className="mt-3">
      <p className="max-w-prose text-note leading-relaxed text-[var(--sys-muted-foreground)] mb-2">
        الأمين بيشوف بس المخازن اللي هو أمينها. اللي بيوصلوا لبلد هالمخزن بس بيطلعوا هون.
      </p>
      {error && (
        <p role="alert" className="text-note text-[var(--sys-destructive)] mb-2">
          {error}
        </p>
      )}
      {data && people.length === 0 && (
        <p className="text-note text-[var(--sys-muted-foreground)] mb-2">ما في حدا بيوصل لهالبلد. أعطِ الموظف البلد من صفحته أول.</p>
      )}
      <div className="grid gap-1">
        {people.map((p) => (
          <Checkbox
            key={p.id}
            id={`keeper-${warehouse.id}-${p.id}`}
            checked={chosen.has(p.id)}
            onChange={(next) =>
              setChosen((cur) => {
                const copy = new Set(cur);
                if (next) copy.add(p.id);
                else copy.delete(p.id);
                return copy;
              })
            }
            label={p.name}
            hint={p.lost ? 'ما عاد بيوصل لبلد هالمخزن' : undefined}
          />
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button type="button" disabled={!data} onClick={save}>
          احفظ الأمناء
        </Button>
        <Button type="button" variant="secondary" onClick={onClose}>
          إلغاء
        </Button>
      </div>
    </Card>
  );
}
