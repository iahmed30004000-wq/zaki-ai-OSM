'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { apiJson } from '@/lib/api-client';
import { storeTypeLabel } from '@/lib/store-types';
import { CurrencyPicker, currencyChoiceReady, type CurrencyChoice } from '@/components/ui/CurrencyPicker';
import { RiAddCircleLine, RiEarthLine, RiLoader4Line, RiStore2Line } from '@remixicon/react';
import { BrandStage } from './BrandStage';
import { Button } from '@/components/ui/Button';

/**
 * Two explicit steps: country, then store. The server decides what is
 * skippable (one country / one store) — this screen only renders what
 * /api/context returns and never assumes access.
 */

interface CountryRow {
  id: string;
  code: string;
  name: string;
  currencyCode: string;
  activeStores: number;
}
interface StoreRow {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
  status: string;
  type: string;
}
interface ContextResponse {
  countries: CountryRow[];
  stores: StoreRow[];
  selection: { countryId: string; storeId: string | null } | null;
  next: 'PICK_COUNTRY' | 'NO_COUNTRY' | 'CREATE_FIRST_STORE' | 'PICK_STORE' | 'READY';
  canAddCountry: boolean;
  canAddStore: boolean;
  skipCountryPicker: boolean;
}


export function EntryPicker() {
  const router = useRouter();
  const params = useSearchParams();
  const changing = params.get('change') === '1';

  const [data, setData] = useState<ContextResponse | null>(null);
  const [step, setStep] = useState<'country' | 'store'>('country');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addCountryOpen, setAddCountryOpen] = useState(false);
  const [addStoreOpen, setAddStoreOpen] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await apiJson<ContextResponse>('/api/context');
      setData(res);
      // Changing context always starts at step 1; otherwise follow the server.
      if (changing) setStep('country');
      else if (res.next === 'READY') router.replace('/');
      else setStep(res.next === 'PICK_STORE' || res.next === 'CREATE_FIRST_STORE' ? 'store' : 'country');
    } catch (e: any) {
      setError(e?.message || 'تعذر تحميل البلدان');
    }
  }, [changing, router]);

  useEffect(() => {
    void load();
  }, [load]);

  const select = async (countryId: string, storeId?: string) => {
    setBusy(true);
    setError(null);
    try {
      await apiJson('/api/context', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // No storeId = the store is cleared; it is never carried across countries.
        body: JSON.stringify(storeId ? { countryId, storeId } : { countryId }),
      });
      if (storeId) {
        router.replace('/');
        router.refresh();
        return;
      }
      const res = await apiJson<ContextResponse>('/api/context');
      setData(res);
      if (res.next === 'READY') {
        router.replace('/');
        router.refresh();
        return;
      }
      setStep('store');
    } catch (e: any) {
      setError(e?.message || 'تعذر اختيار السياق');
    } finally {
      setBusy(false);
    }
  };

  if (!data) {
    return (
      <Screen>
        <div className="flex items-center justify-center gap-2 text-[var(--sys-muted-foreground)] text-sm py-10">
          <RiLoader4Line className="w-4 h-4 animate-spin" /> جارٍ التحميل…
        </div>
        {error && <Error message={error} />}
      </Screen>
    );
  }

  if (step === 'country') {
    return (
      <Screen title="اختر البلد" subtitle="كل متجر يتبع بلداً واحداً، ويرث منه العملة وأجور التوصيل وأيام العمل.">
        {error && <Error message={error} />}
        {data.countries.length === 0 && !data.canAddCountry && (
          <p className="text-sm text-[var(--sys-muted-foreground)] text-center py-6">
            لا توجد بلدان مسندة لحسابك. تواصل مع المدير لإسنادك إلى بلد.
          </p>
        )}
        <ul className="space-y-2">
          {data.countries.map((c) => (
            <li key={c.id}>
              <button
                disabled={busy}
                onClick={() => select(c.id)}
                className="w-full flex items-center gap-3 p-4 rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] hover:border-[var(--sys-primary)] text-right disabled:opacity-60"
              >
                <span className="w-10 h-10 rounded-lg bg-[var(--sys-surface)] border border-[var(--sys-border)] flex items-center justify-center">
                  <RiEarthLine className="w-5 h-5 text-[var(--sys-primary)]" />
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-semibold text-[var(--sys-heading)]">{c.name}</span>
                  <span className="block text-note text-[var(--sys-muted-foreground)]">
                    {c.currencyCode} · {c.activeStores} متجر نشط
                  </span>
                </span>
                <span className="text-note text-[var(--sys-muted)]" dir="ltr">{c.code}</span>
              </button>
            </li>
          ))}
        </ul>

        {data.canAddCountry && (
          <AddCountryForm
            open={addCountryOpen}
            onOpen={() => setAddCountryOpen(true)}
            onDone={async () => {
              setAddCountryOpen(false);
              await load();
            }}
          />
        )}
      </Screen>
    );
  }

  const country = data.countries.find((c) => c.id === data.selection?.countryId);
  return (
    <Screen
      title="اختر المتجر"
      subtitle={country ? `ضمن ${country.name} · ${country.currencyCode}` : undefined}
      onBack={() => setStep('country')}
    >
      {error && <Error message={error} />}
      {data.stores.length === 0 && (
        <p className="text-sm text-[var(--sys-muted-foreground)] text-center py-6">
          لا يوجد متجر في هذا البلد بعد.{data.canAddStore ? ' أنشئ المتجر الأول للمتابعة.' : ' تواصل مع المدير.'}
        </p>
      )}
      <ul className="space-y-2">
        {data.stores.map((s) => (
          <li key={s.id}>
            <button
              disabled={busy}
              onClick={() => data.selection && select(data.selection.countryId, s.id)}
              className="w-full flex items-center gap-3 p-4 rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] hover:border-[var(--sys-primary)] text-right disabled:opacity-60"
            >
              <span className="w-10 h-10 rounded-lg bg-[var(--sys-surface)] border border-[var(--sys-border)] flex items-center justify-center overflow-hidden">
                {s.logo ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={s.logo} alt="" className="w-full h-full object-cover" />
                ) : (
                  <RiStore2Line className="w-5 h-5 text-[var(--sys-primary)]" />
                )}
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-sm font-semibold text-[var(--sys-heading)]">{s.name}</span>
                <span className="block text-note text-[var(--sys-muted-foreground)]">
                  {s.status === 'ACTIVE' ? 'نشط' : 'موقوف'} ·{' '}
                  {storeTypeLabel(s.type)}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>

      {data.canAddStore && data.selection && (
        <AddStoreForm
          countryId={data.selection.countryId}
          open={addStoreOpen}
          onOpen={() => setAddStoreOpen(true)}
          onDone={async () => {
            setAddStoreOpen(false);
            await load();
          }}
        />
      )}
    </Screen>
  );
}

function Screen({
  title,
  subtitle,
  onBack,
  children,
}: {
  title?: string;
  subtitle?: string;
  onBack?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div dir="rtl">
      <BrandStage>
        <div className="space-y-4">
          {title && (
            <div className="text-center">
              <h1 className="text-xl font-bold text-[var(--sys-heading)]">{title}</h1>
              {subtitle && <p className="mt-2 text-sm text-[var(--sys-muted-foreground)]">{subtitle}</p>}
            </div>
          )}
          {children}
          {onBack && (
            <div className="text-center">
              <Button type="button" variant="quiet" size="sm" onClick={onBack}>
                تغيير البلد
              </Button>
            </div>
          )}
        </div>
      </BrandStage>
    </div>
  );
}

function Error({ message }: { message: string }) {
  return (
    <p className="text-sm text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] rounded-lg p-3 text-center">
      {message}
    </p>
  );
}

function AddCountryForm({ open, onOpen, onDone }: { open: boolean; onOpen: () => void; onDone: () => void }) {
  const [form, setForm] = useState({ code: '', name: '' });
  const [currency, setCurrency] = useState<CurrencyChoice>({ code: '', minorUnit: null });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <Button type="button" variant="secondary" onClick={onOpen} className="w-full border-dashed">
        <RiAddCircleLine className="w-4 h-4" /> إضافة بلد
      </Button>
    );
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiJson('/api/geo/countries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: form.code.trim().toUpperCase(),
          name: form.name.trim(),
          currencyCode: currency.code.trim().toUpperCase(),
          // The same control as «البلدان والمتاجر»: a listed currency brings
          // its official decimals, any other asks for them — never a silent 2.
          minorUnit: currency.minorUnit,
        }),
      });
      onDone();
    } catch (e: any) {
      setError(e?.message || 'تعذر إضافة البلد');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg p-4 space-y-3">
      {error && <Error message={error} />}
      <Field label="اسم البلد" value={form.name} onChange={(v) => setForm({ ...form, name: v })} placeholder="سوريا" />
      <Field label="الرمز (ISO)" value={form.code} onChange={(v) => setForm({ ...form, code: v })} placeholder="SY" dir="ltr" />
      <CurrencyPicker value={currency} onChange={setCurrency} />
      <Button type="submit" disabled={busy || !currencyChoiceReady(currency)} className="w-full">
        {busy ? 'جارٍ الحفظ…' : 'إضافة البلد'}
      </Button>
    </form>
  );
}

function AddStoreForm({
  countryId,
  open,
  onOpen,
  onDone,
}: {
  countryId: string;
  open: boolean;
  onOpen: () => void;
  onDone: () => void;
}) {
  const [form, setForm] = useState({ name: '', slug: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <Button type="button" variant="secondary" onClick={onOpen} className="w-full border-dashed">
        <RiAddCircleLine className="w-4 h-4" /> إضافة متجر
      </Button>
    );
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiJson('/api/geo/stores', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ countryId, name: form.name.trim(), slug: form.slug.trim().toLowerCase() }),
      });
      onDone();
    } catch (e: any) {
      setError(e?.message || 'تعذر إضافة المتجر');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg p-4 space-y-3">
      {error && <Error message={error} />}
      <Field label="اسم المتجر" value={form.name} onChange={(v) => setForm({ ...form, name: v })} placeholder="متجر دمشق" />
      <Field
        label="المعرّف (بالإنجليزية)"
        value={form.slug}
        onChange={(v) => setForm({ ...form, slug: v })}
        placeholder="damascus"
        dir="ltr"
      />
      <Button type="submit" disabled={busy} className="w-full">
        {busy ? 'جارٍ الحفظ…' : 'إضافة المتجر'}
      </Button>
    </form>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  dir,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  dir?: 'ltr' | 'rtl';
}) {
  return (
    <label className="block">
      <span className="block text-note font-medium text-[var(--sys-foreground)] mb-1">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        dir={dir}
        required
        className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] bg-[var(--sys-card)] text-sm focus:outline-none focus:border-[var(--sys-primary)]"
      />
    </label>
  );
}
