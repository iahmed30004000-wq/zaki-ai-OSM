'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { Card, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { RiCheckLine, RiEarthLine, RiLoader4Line, RiPhoneLine } from '@remixicon/react';

/**
 * WHAT BELONGS TO THE EMPLOYEE, ON THE EMPLOYEE'S PAGE.
 *
 * The countries and stores a person may enter, and their phone, were set
 * once in the creation form and could never be changed afterwards — the
 * access API existed with no screen calling it. They live here now, beside
 * the role and the permissions they work with.
 */

interface CountryRow {
  id: string;
  name: string;
  stores: { id: string; name: string }[];
}

/** The countries and stores this person may enter. Needs geo.manage (the API refuses otherwise). */
export function UserGeoAccessSection({ userId, canEdit }: { userId: string; canEdit: boolean }) {
  const [countries, setCountries] = useState<CountryRow[] | null>(null);
  const [picked, setPicked] = useState<{ countryIds: Set<string>; storeIds: Set<string> }>({ countryIds: new Set(), storeIds: new Set() });
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [c, a] = await Promise.all([fetch('/api/geo/countries'), fetch(`/api/users/${userId}/geo-access`)]);
        if (!c.ok || !a.ok) throw new Error();
        const cj = await c.json();
        const aj = await a.json();
        setCountries((cj.countries ?? []).map((x: CountryRow) => ({ id: x.id, name: x.name, stores: x.stores ?? [] })));
        const next = { countryIds: new Set<string>(aj.countryIds ?? []), storeIds: new Set<string>(aj.storeIds ?? []) };
        setPicked(next);
        setSaved(key(next));
      } catch {
        setCountries([]);
        setMsg({ ok: false, text: 'تعذّر تحميل البلدان والمتاجر.' });
      }
    })();
  }, [userId]);

  const dirty = useMemo(() => key(picked) !== saved, [picked, saved]);

  function toggleCountry(c: CountryRow) {
    setPicked((p) => {
      const countryIds = new Set(p.countryIds);
      const storeIds = new Set(p.storeIds);
      if (countryIds.has(c.id)) {
        countryIds.delete(c.id);
        // A store is reached through its country — without it, its stores go too.
        for (const s of c.stores) storeIds.delete(s.id);
      } else {
        countryIds.add(c.id);
      }
      return { countryIds, storeIds };
    });
  }

  function toggleStore(c: CountryRow, storeId: string) {
    setPicked((p) => {
      const countryIds = new Set(p.countryIds);
      const storeIds = new Set(p.storeIds);
      if (storeIds.has(storeId)) storeIds.delete(storeId);
      else {
        storeIds.add(storeId);
        countryIds.add(c.id);
      }
      return { countryIds, storeIds };
    });
  }

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/users/${userId}/geo-access`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ countryIds: [...picked.countryIds], storeIds: [...picked.storeIds] }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'تعذّر الحفظ');
      setSaved(key(picked));
      setMsg({ ok: true, text: 'حُفظ الوصول. يسري من الطلب التالي لهذا الموظف.' });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'تعذّر الحفظ' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardContent className="p-5">
        <h3 className="mb-1 flex items-center gap-1.5 text-note font-black text-[var(--sys-foreground)]">
          <RiEarthLine className="h-4 w-4" /> البلدان والمتاجر
        </h3>
        <p className="mb-3 text-note leading-relaxed text-[var(--sys-muted-foreground)]">
          البلد وحده يفتح كل متاجره؛ اختيار متاجر بعينها يحصره فيها. ومن يملك صلاحية إدارة البلدان والمتاجر
          يدخل الكل مهما اخترت هنا.
        </p>

        {countries === null ? (
          <div className="flex h-16 items-center justify-center text-[var(--sys-muted-foreground)]"><RiLoader4Line className="h-4 w-4 animate-spin" /></div>
        ) : (
          <div className="space-y-2">
            {countries.map((c) => {
              const on = picked.countryIds.has(c.id);
              const allStores = on && !c.stores.some((s) => picked.storeIds.has(s.id));
              return (
                <div key={c.id} className={`rounded-lg border p-2.5 ${on ? 'border-[var(--sys-success-soft)] bg-[var(--sys-success-soft)]' : 'border-[var(--sys-border)]'}`}>
                  {/* The ids carry the person, the country and the store: two employees' pages never share a box. */}
                  <Checkbox
                    id={`geo-${userId}-country-${c.id}`}
                    checked={on}
                    disabled={!canEdit}
                    onChange={() => toggleCountry(c)}
                    label={
                      <span className="flex items-center gap-2 font-bold">
                        {c.name}
                        {allStores && c.stores.length > 0 && (
                          <span className="rounded-full bg-[var(--sys-success-soft)] px-2 py-0.5 text-note font-semibold text-[var(--sys-success)]">كل متاجره</span>
                        )}
                      </span>
                    }
                  />
                  {c.stores.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 ps-6">
                      {c.stores.map((s) => (
                        <Checkbox
                          key={s.id}
                          id={`geo-${userId}-store-${s.id}`}
                          checked={picked.storeIds.has(s.id)}
                          disabled={!canEdit}
                          onChange={() => toggleStore(c, s.id)}
                          label={s.name}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {canEdit && (
          <div className="mt-3 flex items-center gap-2">
            <Button size="sm" onClick={save} disabled={busy || !dirty}>
              {busy ? <RiLoader4Line className="h-4 w-4 animate-spin" /> : <RiCheckLine className="h-4 w-4" />}
              احفظ الوصول
            </Button>
            {msg && <span className={`text-note font-medium ${msg.ok ? 'text-[var(--sys-success)]' : 'text-[var(--sys-destructive)]'}`}>{msg.text}</span>}
          </div>
        )}
        {!canEdit && msg && <p className="mt-2 text-note text-[var(--sys-destructive)]">{msg.text}</p>}
      </CardContent>
    </Card>
  );
}

/** The employee's phone, correctable after the account exists. */
export function UserPhoneField({ userId, initial, canEdit }: { userId: string; initial: string | null; canEdit: boolean }) {
  const [phone, setPhone] = useState(initial ?? '');
  const [saved, setSaved] = useState(initial ?? '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/users/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'updateContact', phone: phone.trim() }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'تعذّر الحفظ');
      setSaved(phone.trim());
      setMsg({ ok: true, text: 'حُفظ.' });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'تعذّر الحفظ' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg bg-[var(--sys-surface)] px-3 py-2.5">
      <p className="flex items-center gap-1 text-note text-[var(--sys-muted)]"><RiPhoneLine className="h-4 w-4" /> الهاتف</p>
      {canEdit ? (
        <div className="mt-1 flex items-center gap-1.5">
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            dir="ltr"
            placeholder="—"
            aria-label="هاتف الموظف"
            className="h-11 md:h-8 min-w-0 flex-1 rounded-md border border-[var(--sys-border-input)] bg-[var(--sys-card)] px-2 text-note font-bold text-[var(--sys-heading)] outline-none focus:border-[var(--sys-primary)]"
          />
          <Button size="sm" variant="secondary" onClick={save} disabled={busy || phone.trim() === saved.trim()}>
            {busy ? <RiLoader4Line className="h-4 w-4 animate-spin" /> : 'حفظ'}
          </Button>
        </div>
      ) : (
        <p className="font-bold text-[var(--sys-heading)]" dir="ltr">{saved || '—'}</p>
      )}
      {msg && <p className={`mt-1 text-note font-medium ${msg.ok ? 'text-[var(--sys-success)]' : 'text-[var(--sys-destructive)]'}`}>{msg.text}</p>}
    </div>
  );
}

function key(p: { countryIds: Set<string>; storeIds: Set<string> }): string {
  return `${[...p.countryIds].sort().join(',')}|${[...p.storeIds].sort().join(',')}`;
}
