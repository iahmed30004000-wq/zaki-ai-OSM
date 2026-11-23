'use client';

import React, { useCallback, useEffect, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiJson } from '@/lib/api-client';
import { useApp } from '@/context/AppContext';
import { userCan } from '@/lib/can';
import type { Blocker } from '@/lib/geo-removal';
import { currencyLabel } from '@/lib/currencies';
import { workHoursError } from '@/lib/work-hours';
import { CurrencyPicker, currencyChoiceReady, type CurrencyChoice } from '@/components/ui/CurrencyPicker';
import { StorefrontSettings } from '@/components/settings/StorefrontSettings';
import { StoreIdentityCard } from '@/components/settings/StoreIdentityCard';
import { WarehousesCard } from '@/components/geo/WarehousesCard';
import { storeTypeLabel } from '@/lib/store-types';
import { RiAddCircleLine, RiCloseLine, RiDeleteBinLine, RiEarthLine, RiLoader4Line, RiStore2Line } from '@remixicon/react';
import { PageShell } from '@/components/ui/PageShell';
import { routeLabel } from '@/lib/route-registry';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Card } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { Input } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';
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
  /** «منصّة تجريب» — see `BenchSwitch`. */
  isTest?: boolean;
  _count?: { orders: number };
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

/**
 * THE LONG SENTENCES UNDER A STORE'S BOXES FOLD AWAY (F6, the owner 23/11: «زر لاخفاء واظهار كل هالحكي»).
 *
 * One button for the page. What folds is the explanation only — under «السعر المُعلن يشمل التوصيل» and under «منصّة تجريب».
 * The boxes, the buttons, the reason a store may not be deleted, the warning about a store's orders and every error stay.
 * Shown by default, and on the server: this browser's choice is read after mount, so a storage that throws or is empty
 * changes nothing. Nothing about a customer is stored — one character.
 */
const EXPLAIN_KEY = 'salesflow.geoExplain';

function readExplain(): boolean {
  try {
    return window.localStorage.getItem(EXPLAIN_KEY) !== '0';
  } catch {
    return true;
  }
}

function writeExplain(on: boolean): void {
  try {
    window.localStorage.setItem(EXPLAIN_KEY, on ? '1' : '0');
  } catch {
    // A browser that refuses storage still folds the page; it only forgets on the next visit.
  }
}

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
  /** The explanations under the store boxes — see `EXPLAIN_KEY`. */
  const [explain, setExplain] = useState(true);
  useEffect(() => setExplain(readExplain()), []);
  const toggleExplain = () => {
    const next = !explain;
    setExplain(next);
    writeExplain(next);
  };

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

  /** True when the server took it; false after the message has been shown. */
  const patchCountry = async (id: string, data: Record<string, unknown>): Promise<boolean> => {
    try {
      await apiJson(`/api/geo/countries/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      await load();
      return true;
    } catch (e: any) {
      toast.failed(e?.message || 'تعذر الحفظ');
      return false;
    }
  };

  /**
   * One half of the working day. There is no night shift, so the day must
   * start before it ends: the screen says so at once, against the half that is
   * stored, and the route says it again (it is the one that decides). Either
   * refusal shows its message and returns false, so the field goes back.
   */
  const saveHours = async (c: CountryRow, half: 'workHoursStart' | 'workHoursEnd', value: string): Promise<boolean> => {
    const reason = workHoursError(
      half === 'workHoursStart' ? value : c.workHoursStart,
      half === 'workHoursEnd' ? value : c.workHoursEnd
    );
    if (reason) {
      toast.failed(reason);
      return false;
    }
    return patchCountry(c.id, { [half]: value });
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
    <PageShell
      title={routeLabel('/settings/geo')}
      description="المتجر يرث كل الإعدادات من بلده."
      width="medium"
      actions={
        <>
          <Button type="button" variant="secondary" aria-expanded={explain} onClick={toggleExplain}>
            {explain ? 'إخفاء الشرح' : 'إظهار الشرح'}
          </Button>
          <Button type="button" onClick={() => setAdding('country')}>
            <RiAddCircleLine className="w-4 h-4" /> بلد جديد
          </Button>
        </>
      }
    >

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
        <Card key={c.id}>
          <header className="flex items-center gap-3 p-4 border-b border-[var(--sys-border)]">
            <span className="w-10 h-10 rounded-lg bg-[var(--sys-surface)] border border-[var(--sys-border)] flex items-center justify-center">
              <RiEarthLine className="w-5 h-5 text-[var(--sys-primary)]" />
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-[var(--sys-heading)]">
                {c.name} <span className="text-note text-[var(--sys-muted)]" dir="ltr">{c.code}</span>
              </p>
              <p className="text-note text-[var(--sys-muted-foreground)]">
                {c.currencyCode} · {c.minorUnit} خانات · {c.stores.length} متجر · {c._count.regions} محافظة
                {!c.isActive && <span className="text-[var(--sys-destructive)]"> · غير مفعّل</span>}
              </p>
            </div>
            <Button
              type="button"
              variant="quiet"
              size="sm"
              aria-expanded={openCountry === c.id}
              onClick={() => setOpenCountry(openCountry === c.id ? null : c.id)}
            >
              {openCountry === c.id ? 'إخفاء' : 'الإعدادات'}
            </Button>
          </header>

          {openCountry === c.id && (
            <div className="p-4 grid gap-3 md:grid-cols-2 border-b border-[var(--sys-border)] bg-[var(--sys-surface)]">
              <CurrencyField
                code={c.currencyCode}
                minorUnit={c.minorUnit}
                orders={c._count.orders ?? 0}
                onSave={(currencyCode, minorUnit) => patchCountry(c.id, { currencyCode, minorUnit })}
              />
              <TimeField label="بداية الدوام" value={c.workHoursStart} onSave={(v) => saveHours(c, 'workHoursStart', v)} />
              <TimeField label="نهاية الدوام" value={c.workHoursEnd} onSave={(v) => saveHours(c, 'workHoursEnd', v)} />
              <div className="md:col-span-2">
                <p className="text-note font-medium text-[var(--sys-foreground)] mb-2">أيام العطلة</p>
                <div className="flex flex-wrap gap-2">
                  {DAYS.map((d, i) => {
                    const on = c.weekendDays.includes(i);
                    return (
                      <Button
                        key={d}
                        type="button"
                        size="sm"
                        variant={on ? 'primary' : 'secondary'}
                        aria-pressed={on}
                        onClick={() =>
                          patchCountry(c.id, {
                            weekendDays: on ? c.weekendDays.filter((x) => x !== i) : [...c.weekendDays, i],
                          })
                        }
                      >
                        {d}
                      </Button>
                    );
                  })}
                </div>
              </div>
              <TextField label="بادئة رقم الطلب" value={c.orderPrefix} dir="ltr" onSave={(v) => patchCountry(c.id, { orderPrefix: v.toUpperCase() })} />
              <TextField label="المنطقة الزمنية" value={c.timezone} dir="ltr" onSave={(v) => patchCountry(c.id, { timezone: v })} />
              <Switch
                id={`negative-stock-${c.id}`}
                checked={c.allowNegativeStock}
                onChange={(next) => patchCountry(c.id, { allowNegativeStock: next })}
                label="السماح بالمخزون السالب (يُطبّق عند إنشاء الشحنة)"
              />
              <Switch
                id={`country-active-${c.id}`}
                checked={c.isActive}
                onChange={(next) => patchCountry(c.id, { isActive: next })}
                label="البلد مفعّل"
              />
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
                  <p className="text-note text-[var(--sys-muted-foreground)]" dir="ltr">
                    /{s.slug} · {storeTypeLabel(s.type)}
                    {s.isTest ? ' · منصّة تجريب' : ''}
                  </p>
                  {/* The policy for Telegram, the systems door and the paste-in dialog WHOLE, and for the sales page wherever no
                      offer says otherwise; until it had a control every store priced as price + delivery. The exceptions are the
                      owner's (1/11: «أحدد إذا شامل ولا لأ بظبط»): the box on the order form, and an unticked offer on the
                      sales page — and only there. */}
                  <Checkbox
                    id={`includes-delivery-${s.id}`}
                    checked={!!s.priceIncludesDelivery}
                    onChange={(next) => patchStore(s.id, { priceIncludesDelivery: next })}
                    label="السعر المُعلن يشمل التوصيل"
                    aria-describedby={explain ? `includes-delivery-${s.id}-said` : undefined}
                  />
                  {explain && (
                    <p id={`includes-delivery-${s.id}-said`} className="max-w-prose text-note leading-relaxed text-[var(--sys-muted-foreground)]">
                      شغّله إذا كل طلباتك توصيلها مجاني: بيشمل طلبات تلجرام وطلبات الأنظمة الخارجية وصفحات البيع. بيغيّر ربحك، لأنو
                      أجرة التوصيل بتنخصم من الإيراد. والاستثناء بإيدك: الطلب اللي بتضيفه يدوي أو بالذكاء أو من شيت (استيراد) بتحدد
                      فيه «شامل» أو لأ بخانة «شامل التوصيل» (مفعّلة افتراضياً). وبصفحة البيع بتفك علامة «السعر شامل التوصيل» عن
                      العرض: ولو كل عروض سلّة الزبون غير مؤشَّرة بتنضاف الأجرة. الطلبات اللي انكتبت قبل ما تغيّره بتضل متل ما هي.
                    </p>
                  )}
                  <BenchSwitch store={s} mayManage={mayManage} onSaved={load} explain={explain} />
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant={storefrontFor === s.id ? 'primary' : 'secondary'}
                  aria-expanded={storefrontFor === s.id}
                  onClick={() => setStorefrontFor((cur) => (cur === s.id ? null : s.id))}
                >
                  الهوية والواجهة
                </Button>
                {/* A paused store keeps its red: until 18/11 the tinted button was the row's only sign that the store is stopped. */}
                <Button
                  type="button"
                  size="sm"
                  variant={s.status === 'ACTIVE' ? 'secondary' : 'danger'}
                  onClick={() => patchStore(s.id, { status: s.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE' })}
                >
                  {s.status === 'ACTIVE' ? 'إيقاف مؤقت' : 'تفعيل'}
                </Button>
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
                <Button type="button" variant="secondary" className="w-full" onClick={() => setAdding(c.id)}>
                  <RiAddCircleLine className="w-4 h-4" /> متجر في {c.name}
                </Button>
              )}
            </li>
          </ul>

          {/* Under each country, open without a click (W0b): a warehouse is a place of the country, not of a store. */}
          <div className="p-3 border-t border-[var(--sys-border)]">
            <WarehousesCard countryId={c.id} countryName={c.name} mayManage={mayManage} />
          </div>
        </Card>
      ))}
    </PageShell>
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
      <p className="text-note text-[var(--sys-muted-foreground)]">
        لا يُحذف — {first}
        {rest > 0 ? ` و${rest} غيرها` : ''}
      </p>
    );
  }
  return (
    <Button type="button" variant="danger" size="sm" onClick={onDelete}>
      <RiDeleteBinLine className="w-4 h-4" /> حذف المتجر — لا شيء مُدخَل عليه
    </Button>
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
    <Card plain padding="sm">
      <p className="text-note font-medium text-[var(--sys-foreground)] mb-2">المحافظات</p>
      {error && <p className="text-note text-[var(--sys-destructive)] mb-2">{error}</p>}
      <div className="flex flex-wrap gap-1.5 mb-3">
        {(regions ?? []).map((r) => {
          const why = usage?.[r.id];
          return (
            <span
              key={r.id}
              title={why && why.length > 0 ? `لا تُحذف — ${why.map((b) => b.text).join(' · ')}` : undefined}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-[var(--sys-surface)] border border-[var(--sys-border)] text-note text-[var(--sys-foreground)]"
            >
              {r.name}
              {why && why.length === 0 && (
                <IconButton type="button" size="sm" label={`حذف المحافظة ${r.name}`} onClick={() => remove(r)}>
                  <RiCloseLine className="w-4 h-4" />
                </IconButton>
              )}
            </span>
          );
        })}
        {regions?.length === 0 && (
          <span className="text-note text-[var(--sys-muted-foreground)]">
            لا محافظاتٍ لهذا البلد — وبلا محافظةٍ لا تُحسب أجرةُ توصيلٍ ولا يُقاس أداءُ منطقة. أضِفها من الحقل أدناه.
          </span>
        )}
      </div>
      {usage && (
        <p className="text-note text-[var(--sys-muted-foreground)] mb-3">
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
        <Button type="submit" variant="secondary">
          إضافة
        </Button>
      </form>
    </Card>
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
    <Card padding="md">
    <form onSubmit={submit} className="grid gap-3 md:grid-cols-4">
      {error && <p className="md:col-span-4 text-sm text-[var(--sys-destructive)]">{error}</p>}
      <Input label="الاسم" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
      <Input label="الرمز (حرفان)" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} dir="ltr" required />

      <CurrencyPicker value={currency} onChange={setCurrency} className="md:col-span-2" />

      <div className="md:col-span-4 flex gap-2">
        <Button type="submit" disabled={busy || !ready}>
          {busy ? 'جارٍ الحفظ…' : 'حفظ'}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          إلغاء
        </Button>
      </div>
    </form>
    </Card>
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
  const [form, setForm] = useState({ name: '', slug: '', type: 'MULTI_PRODUCT', isTest: false });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await apiJson('/api/geo/stores', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ countryId, name: form.name.trim(), slug: form.slug.trim().toLowerCase(), type: form.type, isTest: form.isTest }),
      });
      onDone();
    } catch (e: any) {
      toast.failed(e?.message || 'تعذر إضافة المتجر');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card plain padding="sm">
    <form onSubmit={submit} className="grid gap-3 md:grid-cols-3">
      {error && <p className="md:col-span-3 text-sm text-[var(--sys-destructive)]">{error}</p>}
      {/* What the store takes from its country, said at the moment it is
          created — not left to be discovered on the first order. The wallet
          is the one exception, and the line says where that is chosen. */}
      <div className="md:col-span-3">
        <Card plain padding="sm">
          <p className="text-note text-[var(--sys-foreground)]">
            العملة: <b>{currencyLabel(currencyCode)}</b> · {minorUnit} خانات عشرية — موروثة من البلد ولا تُغيَّر هنا.
            <span className="block mt-0.5 text-[var(--sys-muted-foreground)]">
              عملة المحفظة تُختار منفصلة عند إنشائها من المال ← المحافظ والحركات.
            </span>
          </p>
        </Card>
      </div>
      <Input label="اسم المتجر" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
      <Input label="المعرّف" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} dir="ltr" required />
      {/* New stores are multi-product. Single Product is kept working for
          the shops that already wear it, but it is no longer offered: its
          address shows one landing page, and every new shop is a catalogue. */}
      <p className="rounded-lg bg-[var(--sys-surface)] px-3 py-2 text-note leading-relaxed text-[var(--sys-muted-foreground)]">
        النوع: متعدد المنتجات — صفحة رئيسية بالمنتجات.
      </p>
      <div className="md:col-span-3">
        <BenchBox checked={form.isTest} onChange={(isTest) => setForm({ ...form, isTest })} />
      </div>
      <div className="md:col-span-3 flex gap-2">
        <Button type="submit" disabled={busy}>
          {busy ? 'جارٍ الحفظ…' : 'حفظ'}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          إلغاء
        </Button>
      </div>
    </form>
    </Card>
  );
}

/**
 * «منصّة تجريب» — THE CHECKBOX AND THE ONE SENTENCE UNDER IT, for both forms.
 *
 * A bench is a store whose orders are made and confirmed like any other and
 * judged on the bench screen (/growth/bench); it is never open to visitors.
 * Until this existed nothing in the app could mark a store, and the bench
 * screen told the owner to do it «من البلدان والمتاجر» where there was no
 * such field. A real checkbox with a real label — keyboard and phone as the
 * delivery checkbox beside it.
 */
function BenchBox({
  checked,
  onChange,
  disabled,
  explain = true,
  children,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** False folds the sentence away (the page's «إخفاء الشرح»); the warning and the error in `children` stay. */
  explain?: boolean;
  children?: React.ReactNode;
}) {
  const said = useId();
  const box = useId();
  return (
    <div>
      <Checkbox
        id={box}
        checked={checked}
        disabled={disabled}
        aria-describedby={explain ? said : undefined}
        onChange={(next) => onChange(next)}
        label="منصّة تجريب"
      />
      {explain && (
        <p id={said} className="max-w-prose text-note text-[var(--sys-muted-foreground)]">
          طلباتها بتنعمل وبتتأكد متل أي متجر، وبتنحكم بشاشة منصّة التجريب — وما بتنفتح للزوّار أبداً.
        </p>
      )}
      {children}
    </div>
  );
}

/**
 * The switch on a store that exists. The door decides (an open storefront, or
 * the company's only real store, is refused in words) and the sentence it
 * answers with is shown right here, under the box — not as a toast that is
 * gone before it is read. A store that already holds orders says what the
 * switch will do to them before the press, as a sentence: no dialog.
 */
function BenchSwitch({
  store,
  mayManage,
  onSaved,
  explain,
}: {
  store: StoreRow;
  mayManage: boolean;
  onSaved: () => Promise<void> | void;
  explain: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const orders = store._count?.orders ?? 0;
  const isTest = !!store.isTest;

  const change = async (next: boolean) => {
    // UX only — the door asks again. A disabled box that a script clicks anyway sends nothing.
    if (!mayManage) return;
    setBusy(true);
    setError(null);
    try {
      await apiJson(`/api/geo/stores/${store.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isTest: next }),
      });
      await onSaved();
    } catch (e: any) {
      setError(e?.message || 'تعذّر الحفظ');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2">
      <BenchBox checked={isTest} disabled={!mayManage || busy} onChange={change} explain={explain}>
        {orders > 0 && (
          <p className="max-w-prose text-note text-[var(--sys-muted-foreground)]">
            {isTest
              ? `على المتجر ${orders} طلب: إذا شلت العلامة، بترجع طلباته تنعدّ بأرقام الشركة وبتطلع من شاشة المنصّة.`
              : `على المتجر ${orders} طلب: إذا علّمته منصّة تجريب، بتطلع طلباته من أرقام الشركة وبتنعدّ بشاشة المنصّة.`}
          </p>
        )}
        {error && (
          <p role="alert" className="text-note text-[var(--sys-destructive)]">
            {error}
          </p>
        )}
      </BenchBox>
    </div>
  );
}

/*
 * THE THREE TEXT BOXES OF THIS SCREEN ARE THE KIT'S `Input` (R19b, 19/11). Each was a local copy: a label beside a box with the
 * box's classes written out again, and no `htmlFor` — so pressing the words reached nothing. The kit's field draws the same
 * box and ties the label to it.
 */
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
  return <Input label={label} value={v} dir={dir} onChange={(e) => setV(e.target.value)} onBlur={() => v !== value && onSave(v)} />;
}

function TimeField({ label, value, onSave }: { label: string; value: string; onSave: (v: string) => Promise<boolean> }) {
  return (
    <Input
      label={label}
      type="time"
      defaultValue={value}
      onBlur={async (e) => {
        const input = e.target;
        if (input.value === value) return;
        // Refused (the message is already on screen): the field goes back to what is stored.
        if (!(await onSave(input.value))) input.value = value;
      }}
      dir="ltr"
    />
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
      <div className="md:col-span-2">
        <Card plain padding="sm">
          <p className="text-note text-[var(--sys-foreground)]">
            العملة: <b>{currencyLabel(code)}</b> · {minorUnit} خانات عشرية
            <span className="ms-2 text-note text-[var(--sys-muted)]">لا تتغيّر بعد أول طلب — على هذا البلد {orders} طلباً مسجّلاً بها.</span>
          </p>
        </Card>
      </div>
    );
  }
  return (
    <div className="md:col-span-2 flex flex-wrap items-start gap-2">
      <CurrencyPicker value={draft} onChange={setDraft} className="min-w-[260px] flex-1" />
      <Button
        type="button"
        className="mt-5"
        disabled={!changed || !currencyChoiceReady(draft)}
        onClick={() => onSave(draft.code.trim().toUpperCase(), draft.minorUnit as number)}
      >
        حفظ العملة
      </Button>
      <p className="w-full text-note text-[var(--sys-muted)]">تُصحَّح حتى أول طلب في هذا البلد، ثم تُقفل.</p>
    </div>
  );
}
