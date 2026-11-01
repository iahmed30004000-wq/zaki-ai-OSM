'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiJson } from '@/lib/api-client';
import { useApp } from '@/context/AppContext';
import { userCan } from '@/lib/can';
import type { Blocker } from '@/lib/geo-removal';
import { currencyLabel } from '@/lib/currencies';
import { CurrencyPicker, currencyChoiceReady, type CurrencyChoice } from '@/components/ui/CurrencyPicker';
import { StorefrontSettings } from '@/components/settings/StorefrontSettings';
import { StoreIdentityCard } from '@/components/settings/StoreIdentityCard';
import { storeTypeLabel } from '@/lib/store-types';
import { RiAddCircleLine, RiCloseLine, RiDeleteBinLine, RiEarthLine, RiLoader4Line, RiStore2Line } from '@remixicon/react';
import { PageHeader } from '@/components/ui/PageHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { useToast } from '@/components/ui/Toast';
import { useAsk, useConfirm } from '@/components/ui/Confirm';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';

/**
 * /settings/geo — countries, their stores and their regions in one screen.
 * Everything a store inherits (currency, minor unit, work hours, weekend
 * days, order prefix, negative stock) is set here on the country, never on
 * the store. Countries deactivate and stores pause; a store with nothing
 * entered on it, and a city nothing names, may be deleted — the screen says
 * which, and why not, beside each one (see `geo-removal.ts`).
 */

interface StoreRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  type: string;
  logo?: string | null;
  priceIncludesDelivery?: boolean;
}
interface CountryRow {
  id: string;
  code: string;
  name: string;
  currencyCode: string;
  minorUnit: number;
  workHoursStart: string;
  workHoursEnd: string;
  weekendDays: number[];
  timezone: string;
  orderPrefix: string;
  allowNegativeStock: boolean;
  isActive: boolean;
  stores: StoreRow[];
  _count: { regions: number; orders?: number };
}

const DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

export function GeoSettingsScreen() {
  const toast = useToast();
  const ask = useAsk();
  const router = useRouter();
  const { currentUser } = useApp();
  /** UX only — the DELETE routes ask the server again. */
  const mayManage = userCan(currentUser, 'geo.manage');
  /** Why each store may NOT be deleted (empty = it may). Null: not asked, or the asking failed. */
  const [blockers, setBlockers] = useState<Record<string, Blocker[]> | null>(null);
  const [countries, setCountries] = useState<CountryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openCountry, setOpenCountry] = useState<string | null>(null);
  const [adding, setAdding] = useState<'country' | string | null>(null);
  const [storefrontFor, setStorefrontFor] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiJson<{ countries: CountryRow[] }>('/api/geo/countries');
      setCountries(res.countries);
    } catch (e: any) {
      setError(e?.message || 'تعذر تحميل البلدان');
    }
    // Only for somebody who may press the button. A failure here costs the
    // delete controls, not the screen: no button is drawn on a guess.
    if (mayManage) {
      try {
        const res = await apiJson<{ stores: Record<string, { blockers: Blocker[] }> }>('/api/geo/stores/usage');
        setBlockers(Object.fromEntries(Object.entries(res.stores).map(([id, s]) => [id, s.blockers])));
      } catch {
        setBlockers(null);
      }
    }
  }, [mayManage]);

  useLiveRefresh(load);

  // ?store=<id> — the storefronts screen's "settings" link opens that
  // store's panel directly instead of dropping the owner at the top.
  useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get('store');
    if (wanted) setStorefrontFor(wanted);
  }, []);

  const patchCountry = async (id: string, data: Record<string, unknown>) => {
    try {
      await apiJson(`/api/geo/countries/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      await load();
    } catch (e: any) {
      toast.failed(e?.message || 'تعذر الحفظ');
    }
  };

  const patchStore = async (id: string, data: Record<string, unknown>) => {
    try {
      await apiJson(`/api/geo/stores/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      await load();
    } catch (e: any) {
      toast.failed(e?.message || 'تعذر الحفظ');
    }
  };

  /**
   * Delete a store: its name typed, then the route's own refusal if anything
   * arrived since the screen drew its button. After it goes, the page is
   * refreshed from the server too — the header's store switcher is drawn
   * there and would otherwise still offer it.
   */
  const deleteStore = async (s: StoreRow) => {
    const typed = await ask({
      title: `حذف المتجر «${s.name}»؟`,
      body: 'يُحذف نهائياً مع هويّته (الشعار والألوان والنصوص) وصفحاته المسوّدة. ما عليه طلب ولا منتج ولا عميل. لا يمكن التراجع.',
      tone: 'danger',
      confirmLabel: 'احذف المتجر',
      input: { label: 'اكتب اسم المتجر للتأكيد', placeholder: s.name, required: true },
    });
    if (typed === null) return;
    try {
      await apiJson(`/api/geo/stores/${s.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: typed }),
      });
      toast.done(`حُذف المتجر «${s.name}»`);
      await load();
      router.refresh();
    } catch (e: any) {
      toast.failed(e?.message || 'تعذّر حذف المتجر');
      // Whatever the refusal says, the screen's own picture of it was old.
      await load();
    }
  };

  if (!countries) {
    return (
      <div className="flex items-center justify-center gap-2 text-[var(--sys-muted-foreground)] text-sm py-16">
        <RiLoader4Line className="w-4 h-4 animate-spin" /> جارٍ التحميل…
      </div>
    );
  }

  return (
    <div className="space-y-4 max-w-4xl">
      <PageHeader title="البلدان والمتاجر"
          description="المتجر يرث كل الإعدادات من بلده."
          actions={
            <><button
          onClick={() => setAdding('country')}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] text-sm font-medium"
        >
          <RiAddCircleLine className="w-4 h-4" /> بلد جديد
        </button></>
          }
        />

      {error && (
        <p className="text-sm text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] rounded-lg p-3">{error}</p>
      )}

      {adding === 'country' && (
        <AddCountry
          onCancel={() => setAdding(null)}
          onDone={async () => {
            setAdding(null);
            await load();
          }}
        />
      )}

      {countries.map((c) => (
        <section key={c.id} className="bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg">
          <header className="flex items-center gap-3 p-4 border-b border-[var(--sys-border)]">
            <span className="w-10 h-10 rounded-lg bg-[var(--sys-surface)] border border-[var(--sys-border)] flex items-center justify-center">
              <RiEarthLine className="w-5 h-5 text-[var(--sys-primary)]" />
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-[var(--sys-heading)]">
                {c.name} <span className="text-xs text-[var(--sys-muted)]" dir="ltr">{c.code}</span>
              </p>
              <p className="text-xs text-[var(--sys-muted-foreground)]">
                {c.currencyCode} · {c.minorUnit} خانات · {c.stores.length} متجر · {c._count.regions} محافظة
                {!c.isActive && <span className="text-[var(--sys-destructive)]"> · غير مفعّل</span>}
              </p>
            </div>
            <button
              onClick={() => setOpenCountry(openCountry === c.id ? null : c.id)}
              className="text-xs text-[var(--sys-muted-foreground)] hover:text-[var(--sys-primary)]"
            >
              {openCountry === c.id ? 'إخفاء' : 'الإعدادات'}
            </button>
          </header>

          {openCountry === c.id && (
            <div className="p-4 grid gap-3 md:grid-cols-2 border-b border-[var(--sys-border)] bg-[var(--sys-surface)]">
              <CurrencyField
                code={c.currencyCode}
                minorUnit={c.minorUnit}
                orders={c._count.orders ?? 0}
                onSave={(currencyCode, minorUnit) => patchCountry(c.id, { currencyCode, minorUnit })}
              />
              <TimeField label="بداية الدوام" value={c.workHoursStart} onSave={(v) => patchCountry(c.id, { workHoursStart: v })} />
              <TimeField label="نهاية الدوام" value={c.workHoursEnd} onSave={(v) => patchCountry(c.id, { workHoursEnd: v })} />
              <div className="md:col-span-2">
                <p className="text-xs font-medium text-[var(--sys-foreground)] mb-2">أيام العطلة</p>
                <div className="flex flex-wrap gap-2">
                  {DAYS.map((d, i) => {
                    const on = c.weekendDays.includes(i);
                    return (
                      <button
                        key={d}
                        onClick={() =>
                          patchCountry(c.id, {
                            weekendDays: on ? c.weekendDays.filter((x) => x !== i) : [...c.weekendDays, i],
                          })
                        }
                        className={`min-h-11 md:min-h-0 inline-flex items-center px-3 py-1.5 rounded-lg text-xs border ${
                          on ? 'bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] border-[var(--sys-primary)]' : 'bg-[var(--sys-card)] text-[var(--sys-foreground)] border-[var(--sys-border)]'
                        }`}
                      >
                        {d}
                      </button>
                    );
                  })}
                </div>
              </div>
              <TextField label="بادئة رقم الطلب" value={c.orderPrefix} dir="ltr" onSave={(v) => patchCountry(c.id, { orderPrefix: v.toUpperCase() })} />
              <TextField label="المنطقة الزمنية" value={c.timezone} dir="ltr" onSave={(v) => patchCountry(c.id, { timezone: v })} />
              <label className="flex items-center gap-2 text-sm text-[var(--sys-foreground)]">
                <input
                  type="checkbox"
                  checked={c.allowNegativeStock}
                  onChange={(e) => patchCountry(c.id, { allowNegativeStock: e.target.checked })}
                />
                السماح بالمخزون السالب (يُطبّق عند إنشاء الشحنة)
              </label>
              <label className="flex items-center gap-2 text-sm text-[var(--sys-foreground)]">
                <input type="checkbox" checked={c.isActive} onChange={(e) => patchCountry(c.id, { isActive: e.target.checked })} />
                البلد مفعّل
              </label>
              <div className="md:col-span-2">
                <Regions countryId={c.id} onChanged={load} />
              </div>
            </div>
          )}

          <ul className="divide-y divide-[var(--sys-border)]">
            {c.stores.map((s) => (
              <React.Fragment key={s.id}>
              <li className="flex flex-wrap items-center gap-3 p-4">
                <span className="w-8 h-8 rounded-lg bg-[var(--sys-surface)] border border-[var(--sys-border)] flex items-center justify-center overflow-hidden">
                  {s.logo ? (
                    <img src={s.logo} alt="" className="h-full w-full object-contain" />
                  ) : (
                    <RiStore2Line className="w-4 h-4 text-[var(--sys-muted-foreground)]" />
                  )}
                </span>
                {/* A floor, not zero: on a flex-wrap row a name that may shrink to nothing is never the item
                    that wraps, so the buttons beside it took the whole line and left it a sliver. */}
                <div className="flex-1 min-w-[150px]">
                  <p className="text-sm font-medium text-[var(--sys-heading)]">{s.name}</p>
                  <p className="text-xs text-[var(--sys-muted-foreground)]" dir="ltr">
                    /{s.slug} · {storeTypeLabel(s.type)}
                  </p>
                  {/* The policy for every order no offer speaks for — Telegram, a sheet row, a price typed by hand — and
                      until it had a control every store priced as price + delivery. An offer's own «السعر شامل التوصيل» (yes OR
                      no) and the box on the order form beat it (the owner, 1/11: «أحدد إذا شامل ولا لأ بظبط»). */}
                  <label className="mt-1 flex items-center gap-1.5 text-xs text-[var(--sys-foreground)]">
                    <input
                      type="checkbox"
                      checked={!!s.priceIncludesDelivery}
                      onChange={(e) => patchStore(s.id, { priceIncludesDelivery: e.target.checked })}
                    />
                    السعر المُعلن يشمل التوصيل
                  </label>
                  <p className="mt-0.5 max-w-prose text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
                    شغّله إذا كل طلباتك توصيلها مجاني: بيشمل طلبات تلجرام والشيتات وصفحات البيع. بيغيّر ربحك، لأنو أجرة التوصيل
                    بتنخصم من الإيراد. وبتقدر تحدد «شامل» أو لأ بالظبط وإنت بتضيف الطلب يدوي (خانة «شامل التوصيل»)، ولكل عرض
                    بصفحة البيع (خانة «السعر شامل التوصيل»): كلمتهم بتغلب هاد الإعداد. الطلبات اللي انكتبت قبل ما تغيّره بتضل متل ما هي.
                  </p>
                </div>
                <button
                  onClick={() => setStorefrontFor((cur) => (cur === s.id ? null : s.id))}
                  className={`min-h-11 md:min-h-0 inline-flex items-center text-xs px-3 py-1.5 rounded-lg border ${
                    storefrontFor === s.id
                      ? 'border-[var(--sys-primary)] text-[var(--sys-primary)] bg-[var(--sys-primary-soft)]'
                      : 'border-[var(--sys-border)] text-[var(--sys-foreground)] hover:border-[var(--sys-primary)] hover:text-[var(--sys-primary)]'
                  }`}
                >
                  الهوية والواجهة
                </button>
                <button
                  onClick={() => patchStore(s.id, { status: s.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE' })}
                  className={`min-h-11 md:min-h-0 inline-flex items-center text-xs px-3 py-1.5 rounded-lg border ${
                    s.status === 'ACTIVE'
                      ? 'border-[var(--sys-border)] text-[var(--sys-muted-foreground)] hover:text-[var(--sys-destructive)]'
                      : 'border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] text-[var(--sys-destructive)]'
                  }`}
                >
                  {s.status === 'ACTIVE' ? 'إيقاف مؤقت' : 'تفعيل'}
                </button>
                {/* On a line of its own under the row. In the name's column it
                    was a strip one word wide on a phone — the two buttons
                    already leave it little — and a third button in the row
                    would have squeezed the name out. */}
                {mayManage && blockers?.[s.id] && (
                  <div className="w-full">
                    <StoreRemoval blockers={blockers[s.id]} onDelete={() => deleteStore(s)} />
                  </div>
                )}
              </li>
              {/* Directly under its own store. It used to render after the
                  LAST store of the country, and nothing ever opened it: the
                  state existed, the button that set it did not, so the
                  storefront's theme, phone, domain — and now its logo —
                  could not be reached from anywhere. */}
              {storefrontFor === s.id && (
                <li className="space-y-3 bg-[var(--sys-surface)] p-4">
                  <StoreIdentityCard store={s as never} onSaved={load} />
                  <StorefrontSettings store={s as never} onSaved={load} />
                </li>
              )}
              </React.Fragment>
            ))}
            <li className="p-3">
              {adding === c.id ? (
                <AddStore
                  countryId={c.id}
                  currencyCode={c.currencyCode}
                  minorUnit={c.minorUnit}
                  onCancel={() => setAdding(null)}
                  onDone={async () => {
                    setAdding(null);
                    await load();
                  }}
                />
              ) : (
                <button
                  onClick={() => setAdding(c.id)}
                  className="min-h-11 min-w-11 md:min-h-0 md:min-w-0 w-full flex items-center justify-center gap-2 p-2 rounded-lg border border-dashed border-[var(--sys-border)] text-sm text-[var(--sys-muted-foreground)] hover:border-[var(--sys-primary)] hover:text-[var(--sys-primary)]"
                >
                  <RiAddCircleLine className="w-4 h-4" /> متجر في {c.name}
                </button>
              )}
            </li>
          </ul>
        </section>
      ))}
    </div>
  );
}

/**
 * UNDER A STORE'S NAME: WHETHER IT MAY GO, AND WHY NOT — BEFORE ANY CLICK.
 *
 * A store with nothing entered on it gets the delete control; one with
 * something gets the reason instead, as a sentence, so the owner never has to
 * press a button to learn it is refused. Nothing at all until the answer
 * arrives: a button drawn on a guess is a button that may be wrong.
 */
const SHOWN = 3;

function StoreRemoval({ blockers, onDelete }: { blockers: Blocker[] | undefined; onDelete: () => void }) {
  if (!blockers) return null;
  if (blockers.length > 0) {
    const first = blockers.slice(0, SHOWN).map((b) => b.text).join(' · ');
    const rest = blockers.length - SHOWN;
    return (
      <p className="text-xs text-[var(--sys-muted-foreground)]">
        لا يُحذف — {first}
        {rest > 0 ? ` و${rest} غيرها` : ''}
      </p>
    );
  }
  return (
    <button
      type="button"
      onClick={onDelete}
      className="min-h-11 md:min-h-0 inline-flex items-center gap-1.5 text-xs text-[var(--sys-destructive)] hover:underline"
    >
      <RiDeleteBinLine className="w-4 h-4" /> حذف المتجر — لا شيء مُدخَل عليه
    </button>
  );
}

function Regions({ countryId, onChanged }: { countryId: string; onChanged?: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [regions, setRegions] = useState<{ id: string; name: string }[] | null>(null);
  /** Why each city may NOT be deleted; empty = it may. Null: this person may only look. */
  const [usage, setUsage] = useState<Record<string, Blocker[]> | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiJson<{ regions: { id: string; name: string }[]; usage?: Record<string, Blocker[]> | null }>(
        `/api/geo/countries/${countryId}/regions`
      );
      setRegions(res.regions);
      setUsage(res.usage ?? null);
    } catch (e: any) {
      setError(e?.message || 'تعذر تحميل المحافظات');
    }
  }, [countryId]);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      await apiJson(`/api/geo/countries/${countryId}/regions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      setName('');
      await load();
    } catch (e: any) {
      toast.failed(e?.message || 'تعذر الإضافة');
    }
  };

  const remove = async (r: { id: string; name: string }) => {
    const sure = await confirm({
      title: `حذف المحافظة «${r.name}»؟`,
      body: 'ما عليها طلب ولا أجرة توصيل، فتُحذف من القائمة نهائياً.',
      tone: 'danger',
      confirmLabel: 'احذف',
    });
    if (!sure) return;
    try {
      await apiJson(`/api/geo/countries/${countryId}/regions/${r.id}`, { method: 'DELETE' });
      toast.done(`حُذفت المحافظة «${r.name}»`);
    } catch (e: any) {
      toast.failed(e?.message || 'تعذّر الحذف');
    }
    // Either way the picture of which cities may go was old, and so is the
    // country's own count of them.
    await load();
    onChanged?.();
  };

  return (
    <div className="bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg p-3">
      <p className="text-xs font-medium text-[var(--sys-foreground)] mb-2">المحافظات</p>
      {error && <p className="text-xs text-[var(--sys-destructive)] mb-2">{error}</p>}
      <div className="flex flex-wrap gap-1.5 mb-3">
        {(regions ?? []).map((r) => {
          const why = usage?.[r.id];
          return (
            <span
              key={r.id}
              title={why && why.length > 0 ? `لا تُحذف — ${why.map((b) => b.text).join(' · ')}` : undefined}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-[var(--sys-surface)] border border-[var(--sys-border)] text-xs text-[var(--sys-foreground)]"
            >
              {r.name}
              {why && why.length === 0 && (
                <button
                  type="button"
                  onClick={() => remove(r)}
                  aria-label={`حذف المحافظة ${r.name}`}
                  className="min-h-11 min-w-11 md:min-h-0 md:min-w-0 inline-flex items-center justify-center text-[var(--sys-muted-foreground)] hover:text-[var(--sys-destructive)]"
                >
                  <RiCloseLine className="w-4 h-4" />
                </button>
              )}
            </span>
          );
        })}
        {regions?.length === 0 && (
          <span className="text-xs text-[var(--sys-muted-foreground)]">
            لا محافظاتٍ لهذا البلد — وبلا محافظةٍ لا تُحسب أجرةُ توصيلٍ ولا يُقاس أداءُ منطقة. أضِفها من الحقل أدناه.
          </span>
        )}
      </div>
      {usage && (
        <p className="text-xs text-[var(--sys-muted-foreground)] mb-3">
          تظهر علامة الحذف على المحافظة التي لا طلب عليها ولا أجرة توصيل — وحدها تُحذف.
        </p>
      )}
      <form onSubmit={add} className="flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="اسم المحافظة"
          className="flex-1 h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm focus:outline-none focus:border-[var(--sys-primary)]"
        />
        <button type="submit" className="px-3 h-11 md:h-10 rounded-lg bg-[var(--sys-heading)] text-[var(--sys-primary-foreground)] text-xs">
          إضافة
        </button>
      </form>
    </div>
  );
}

function AddCountry({ onCancel, onDone }: { onCancel: () => void; onDone: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState({ code: '', name: '' });
  const [currency, setCurrency] = useState<CurrencyChoice>({ code: '', minorUnit: null });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // All are required by the server; the button says so before it does.
  const ready = form.name.trim().length >= 2 && /^[A-Za-z]{2}$/.test(form.code.trim()) && currencyChoiceReady(currency);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    try {
      await apiJson('/api/geo/countries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: form.code.trim().toUpperCase(),
          name: form.name.trim(),
          currencyCode: currency.code.trim().toUpperCase(),
          minorUnit: currency.minorUnit,
        }),
      });
      onDone();
    } catch (e: any) {
      toast.failed(e?.message || 'تعذر إضافة البلد');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg p-4 grid gap-3 md:grid-cols-4">
      {error && <p className="md:col-span-4 text-sm text-[var(--sys-destructive)]">{error}</p>}
      <Input label="الاسم" value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
      <Input label="الرمز (حرفان)" value={form.code} onChange={(v) => setForm({ ...form, code: v })} dir="ltr" />

      <CurrencyPicker value={currency} onChange={setCurrency} className="md:col-span-2" />

      <div className="md:col-span-4 flex gap-2">
        <button
          type="submit"
          disabled={busy || !ready}
          className="px-4 py-2 rounded-lg bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] text-sm disabled:opacity-60"
        >
          {busy ? 'جارٍ الحفظ…' : 'حفظ'}
        </button>
        <button type="button" onClick={onCancel} className="px-4 py-2 rounded-lg border border-[var(--sys-border)] text-sm text-[var(--sys-muted-foreground)]">
          إلغاء
        </button>
      </div>
    </form>
  );
}

function AddStore({
  countryId,
  currencyCode,
  minorUnit,
  onCancel,
  onDone,
}: {
  countryId: string;
  currencyCode: string;
  minorUnit: number;
  onCancel: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [form, setForm] = useState({ name: '', slug: '', type: 'MULTI_PRODUCT' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await apiJson('/api/geo/stores', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ countryId, name: form.name.trim(), slug: form.slug.trim().toLowerCase(), type: form.type }),
      });
      onDone();
    } catch (e: any) {
      toast.failed(e?.message || 'تعذر إضافة المتجر');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="grid gap-3 md:grid-cols-3 p-3 bg-[var(--sys-surface)] border border-[var(--sys-border)] rounded-lg">
      {error && <p className="md:col-span-3 text-sm text-[var(--sys-destructive)]">{error}</p>}
      {/* What the store takes from its country, said at the moment it is
          created — not left to be discovered on the first order. The wallet
          is the one exception, and the line says where that is chosen. */}
      <p className="md:col-span-3 rounded-lg bg-[var(--sys-card)] border border-[var(--sys-border)] px-3 py-2 text-xs text-[var(--sys-foreground)]">
        العملة: <b>{currencyLabel(currencyCode)}</b> · {minorUnit} خانات عشرية — موروثة من البلد ولا تُغيَّر هنا.
        <span className="block mt-0.5 text-[var(--sys-muted-foreground)]">
          عملة المحفظة تُختار منفصلة عند إنشائها من المال ← المحافظ والحركات.
        </span>
      </p>
      <Input label="اسم المتجر" value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
      <Input label="المعرّف" value={form.slug} onChange={(v) => setForm({ ...form, slug: v })} dir="ltr" />
      {/* New stores are multi-product. Single Product is kept working for
          the shops that already wear it, but it is no longer offered: its
          address shows one landing page, and every new shop is a catalogue. */}
      <p className="rounded-lg bg-[var(--sys-surface)] px-3 py-2 text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
        النوع: متعدد المنتجات — صفحة رئيسية بالمنتجات.
      </p>
      <div className="md:col-span-3 flex gap-2">
        <button type="submit" disabled={busy} className="px-4 py-2 rounded-lg bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] text-sm disabled:opacity-60">
          {busy ? 'جارٍ الحفظ…' : 'حفظ'}
        </button>
        <button type="button" onClick={onCancel} className="px-4 py-2 rounded-lg border border-[var(--sys-border)] text-sm text-[var(--sys-muted-foreground)]">
          إلغاء
        </button>
      </div>
    </form>
  );
}

function Input({
  label,
  value,
  onChange,
  dir,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  dir?: 'ltr' | 'rtl';
}) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        dir={dir}
        required
        className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] bg-[var(--sys-card)] text-sm focus:outline-none focus:border-[var(--sys-primary)]"
      />
    </label>
  );
}

function TextField({
  label,
  value,
  dir,
  onSave,
}: {
  label: string;
  value: string;
  dir?: 'ltr' | 'rtl';
  onSave: (v: string) => void;
}) {
  const [v, setV] = useState(value);
  return (
    <label className="block">
      <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">{label}</span>
      <input
        value={v}
        dir={dir}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => v !== value && onSave(v)}
        className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] bg-[var(--sys-card)] text-sm focus:outline-none focus:border-[var(--sys-primary)]"
      />
    </label>
  );
}

function TimeField({ label, value, onSave }: { label: string; value: string; onSave: (v: string) => void }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">{label}</span>
      <input
        type="time"
        defaultValue={value}
        onBlur={(e) => e.target.value !== value && onSave(e.target.value)}
        dir="ltr"
        className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] bg-[var(--sys-card)] text-sm focus:outline-none focus:border-[var(--sys-primary)]"
      />
    </label>
  );
}

/**
 * The country's currency and its decimals — correctable until the first
 * order. Picking a currency fills in its official decimals, as creating a
 * country does. After an order exists both are shown and locked: every
 * order, fee and statement is written in them.
 */
function CurrencyField({
  code, minorUnit, orders, onSave,
}: {
  code: string;
  minorUnit: number;
  orders: number;
  onSave: (code: string, minorUnit: number) => void;
}) {
  const [draft, setDraft] = useState<CurrencyChoice>({ code, minorUnit });
  useEffect(() => setDraft({ code, minorUnit }), [code, minorUnit]);
  const changed = draft.code.trim().toUpperCase() !== code || draft.minorUnit !== minorUnit;

  if (orders > 0) {
    return (
      <div className="md:col-span-2 rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] px-3 py-2 text-xs text-[var(--sys-foreground)]">
        العملة: <b>{currencyLabel(code)}</b> · {minorUnit} خانات عشرية
        <span className="ms-2 text-xs text-[var(--sys-muted)]">لا تتغيّر بعد أول طلب — على هذا البلد {orders} طلباً مسجّلاً بها.</span>
      </div>
    );
  }
  return (
    <div className="md:col-span-2 flex flex-wrap items-start gap-2">
      <CurrencyPicker value={draft} onChange={setDraft} className="min-w-[260px] flex-1" />
      <button
        type="button"
        disabled={!changed || !currencyChoiceReady(draft)}
        onClick={() => onSave(draft.code.trim().toUpperCase(), draft.minorUnit as number)}
        className="mt-5 h-11 md:h-10 rounded-lg bg-[var(--sys-primary)] px-3 text-xs font-bold text-[var(--sys-primary-foreground)] disabled:opacity-40"
      >
        حفظ العملة
      </button>
      <p className="w-full text-xs text-[var(--sys-muted)]">تُصحَّح حتى أول طلب في هذا البلد، ثم تُقفل.</p>
    </div>
  );
}
