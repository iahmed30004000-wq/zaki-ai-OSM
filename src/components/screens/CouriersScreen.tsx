'use client';

import React, { useCallback, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useConfirm } from '@/components/ui/Confirm';
import { apiJson } from '@/lib/api-client';
import { CourierCredentials } from '@/components/settings/CourierCredentials';
import { CourierWebhook } from '@/components/settings/CourierWebhook';
import { CourierFees } from '@/components/settings/CourierFees';
import { ContactButtons } from '@/components/orders/ContactButtons';
import { COURIER_PLATFORMS } from '@/lib/couriers';
import { ScreenTitle } from '@/components/shell/ScreenTitle';
import { Modal } from '@/components/ui/Modal';
import { Tabs } from '@/components/ui/Tabs';
import { RiAddCircleLine, RiCheckLine, RiCloseLine, RiDeleteBinLine, RiEBike2Line, RiLoader4Line, RiPencilLine, RiTruckLine, RiWallet3Line } from '@remixicon/react';
import { EmptyState } from '@/components/ui/EmptyState';
import { useToast } from '@/components/ui/Toast';
import { Rows } from '@/components/ui/Rows';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';

/**
 * /settings/couriers — THE SHIPPING COMPANIES AND WHAT THEY CHARGE, ON ONE
 * SCREEN.
 *
 * These were two entries in the menu. «شركات الشحن» listed the companies and
 * «أجور التوصيل» priced them, each opening with a link to the other, because
 * neither is usable alone: a courier with no fee rows cannot ship, and a fee
 * row without a courier is not a thing that exists — `DeliveryFee` has
 * carried `deliveryProviderId` from the beginning.
 *
 * WHY THIS IS NOT ONE LONG PAGE. The fees are a row per region — fourteen in
 * Syria — so putting every courier's table on one screen is four tables and
 * fifty-six rows to find the one number somebody came to change. Instead the
 * list stays a list, and a courier opens BESIDE it: its fees, and its
 * platform account, for that one company. The coverage chip is the door —
 * «٨ من ١٢ محافظة» is both the answer and the way in.
 *
 * AND THE PANEL IS WHY THE ACCOUNT WORKS AGAIN. «الحساب والتكامل» was a
 * button that set a piece of state nothing read: the credentials and webhook
 * panels were imported here and rendered nowhere, so the only way to give a
 * courier its API login was to not have one. They are a tab now.
 */

interface Courier {
  id: string;
  name: string;
  code: string;
  kind?: 'COMPANY' | 'AGENT';
  phone: string | null;
  email: string | null;
  isActive: boolean;
  /** null = every store in the company, which is what they all were. */
  storeId?: string | null;
  store?: { name: string } | null;
  /** Which platform it ships on; null = worked by hand. */
  adapterCode?: string | null;
  /** Regions in the current country this courier has a fee for. */
  pricedRegions?: number;
}

export function CouriersScreen() {
  const ask = useConfirm();
  const toast = useToast();
  const [rows, setRows] = useState<Courier[] | null>(null);
  /** Regions in the current country — the denominator of «٨ من ١٢». */
  const [totalRegions, setTotalRegions] = useState(0);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', code: '', phone: '', kind: 'COMPANY' as 'COMPANY' | 'AGENT', adapterCode: 'MANUAL' });
  const [editing, setEditing] = useState<string | null>(null);
  const [edit, setEdit] = useState({ name: '', phone: '' });
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * WHICH COURIER IS OPEN, AND ON WHICH TAB.
   *
   * `?courier=` still opens one straight away — that link was how the old
   * fees screen was reached, and anything already pointing at a courier's
   * fees keeps landing on them.
   */
  const asked = useSearchParams().get('courier');
  const [openId, setOpenId] = useState<string | null>(asked);
  const [tab, setTab] = useState<'fees' | 'account'>('fees');

  const load = useCallback(async () => {
    try {
      const data = await apiJson<{ providers?: Courier[]; deliveryProviders?: Courier[]; totalRegions?: number }>('/api/delivery-providers');
      setRows(data.providers ?? data.deliveryProviders ?? []);
      setTotalRegions(data.totalRegions ?? 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر التحميل');
    }
  }, []);

  useLiveRefresh(load);

  const open = (c: Courier, which: 'fees' | 'account') => {
    setTab(which);
    setOpenId(c.id);
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await apiJson('/api/delivery-providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name.trim(),
          code: form.code.trim().toUpperCase(),
          kind: form.kind,
          phone: form.phone.trim() || undefined,
          adapterCode: form.adapterCode,
        }),
      });
      setForm({ name: '', code: '', phone: '', kind: 'COMPANY', adapterCode: 'MANUAL' });
      setAdding(false);
      await load();
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذر الإضافة');
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (courier: Courier) => {
    setBusy(true);
    try {
      await apiJson(`/api/delivery-providers/${courier.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: !courier.isActive }),
      });
      await load();
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذر التحديث');
    } finally {
      setBusy(false);
    }
  };

  /**
   * Rows from before couriers had a store. They are usable by nobody, and
   * they must not vanish quietly — a courier that disappears off a screen
   * is one somebody re-creates as a duplicate a week later.
   */
  const unplaced = rows?.filter((c) => !c.storeId) ?? [];

  const placeHere = async (c: Courier) => {
    setBusy(true);
    try {
      await apiJson(`/api/delivery-providers/${c.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assignToCurrentStore: true }),
      });
      await load();
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذر الإسناد');
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (c: Courier) => {
    setEditing(c.id);
    setEdit({ name: c.name, phone: c.phone ?? '' });
    setNote(null);
  };

  const saveEdit = async (id: string) => {
    setBusy(true);
    try {
      await apiJson(`/api/delivery-providers/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: edit.name.trim(),
          phone: edit.phone.trim(),
        }),
      });
      setEditing(null);
      await load();
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذر الحفظ');
    } finally {
      setBusy(false);
    }
  };

  /**
   * Delete asks the server, which decides. Anything with history is
   * deactivated instead and says what is holding it — the orders and
   * statements that name it are not ours to rewrite.
   */
  const remove = async (c: Courier) => {
    const ok = await ask({
      title: `حذف «${c.name}»؟`,
      body: 'إن كانت مرتبطة بطلبات أو كشوف فستُعطَّل بدل الحذف، والسجلّات القديمة تبقى كما هي.',
      tone: 'danger',
    });
    if (!ok) return;
    setBusy(true);
    setNote(null);
    try {
      const d = await apiJson<{ deleted?: boolean; deactivated?: boolean; message?: string }>(
        `/api/delivery-providers/${c.id}`,
        { method: 'DELETE' }
      );
      setNote(d.message ?? null);
      await load();
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذر الحذف');
    } finally {
      setBusy(false);
    }
  };

  if (!rows) {
    return (
      <div className="flex items-center justify-center gap-2 text-[var(--sys-muted-foreground)] text-sm py-16">
        <RiLoader4Line className="w-4 h-4 animate-spin" /> جارٍ التحميل…
      </div>
    );
  }

  const opened = rows.find((c) => c.id === openId) ?? null;

  return (
    <div className="max-w-3xl space-y-3">
      <ScreenTitle />

      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-[var(--sys-muted-foreground)]">
          افتح شركةً لتسعير محافظاتها وضبط حسابها.
        </p>
        <button onClick={() => setAdding(true)} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] text-sm font-medium">
          <RiAddCircleLine className="w-4 h-4" /> شركة شحن أو مندوب
        </button>
      </div>

      {error && <p className="text-sm text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] rounded-lg p-3">{error}</p>}

      {adding && (
        <form onSubmit={create} className="bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg p-4 grid gap-3 md:grid-cols-4">
          <Field label="الاسم" value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
          <Field label="الرمز" value={form.code} onChange={(v) => setForm({ ...form, code: v })} dir="ltr" />
          <Field label="الهاتف" value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} dir="ltr" required={false} />
          <label className="block">
            <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">النوع</span>
            <select
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value as 'COMPANY' | 'AGENT' })}
              className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm bg-[var(--sys-card)]"
            >
              <option value="COMPANY">شركة شحن</option>
              <option value="AGENT">مندوب</option>
            </select>
            <span className="block text-xs text-[var(--sys-muted)] mt-1">
              المندوب فوري وتسويته يدوية، وهو الوحيد الذي يمكن سحب الشحنة منه مباشرة.
            </span>
          </label>
          {/* A courier is not a platform. "باشا" is who ships; LogesTechs is
              what they ship ON, and another courier could run on the same
              platform under a different account. An agent has neither. */}
          {form.kind !== 'AGENT' && (
            <label className="block">
              <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">تعمل على منصّة</span>
              <select
                value={form.adapterCode}
                onChange={(e) => setForm({ ...form, adapterCode: e.target.value })}
                className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm bg-[var(--sys-card)]"
              >
                {COURIER_PLATFORMS.map((p) => (
                  <option key={p.code} value={p.code}>{p.name}</option>
                ))}
              </select>
              <span className="block text-xs text-[var(--sys-muted)] mt-1">
                {COURIER_PLATFORMS.find((p) => p.code === form.adapterCode)?.needs}
              </span>
            </label>
          )}

          <div className="flex gap-2 items-end">
            <button type="submit" disabled={busy} className="px-4 py-2 rounded-lg bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] text-sm disabled:opacity-60">حفظ</button>
            <button type="button" onClick={() => setAdding(false)} className="px-4 py-2 rounded-lg border border-[var(--sys-border)] text-sm text-[var(--sys-muted-foreground)]">إلغاء</button>
          </div>
        </form>
      )}

      {/* What the server decided, in its words: deactivated and why, or
          really deleted. Guessing on the client would eventually disagree
          with what actually happened. */}
      {note && (
        <p className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-surface)] px-3 py-2 text-xs text-[var(--sys-foreground)]">
          {note}
        </p>
      )}

      {unplaced.length > 0 && (
        <div className="rounded-lg border border-[var(--sys-warning)] bg-[var(--sys-warning-soft)] p-3 space-y-2">
          <p className="text-xs font-semibold text-[var(--sys-warning)]">
            غير مُسنَدة لأي متجر — لا يمكن استعمالها حتى تُسنَد
          </p>
          {unplaced.map((c) => (
            <div key={c.id} className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-[var(--sys-foreground)]">
                {c.name} <span dir="ltr" className="text-[var(--sys-muted)]">({c.code})</span>
              </span>
              <button
                onClick={() => placeHere(c)}
                disabled={busy}
                className="min-h-11 md:min-h-0 inline-flex items-center rounded-lg border border-[var(--sys-warning)]/40 bg-[var(--sys-card)] px-3 py-1 text-xs text-[var(--sys-warning)] hover:border-[var(--sys-warning)] disabled:opacity-50"
              >
                أسنِدها لهذا المتجر
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg overflow-hidden">
                <Rows
          rows={rows.filter((c) => c.storeId)}
          keyOf={(c) => c.id}
          columns={[
            { key: 'c0', label: "الجهة", primary: true,
              render: (c) => (
                  <>{c.kind === 'AGENT' ? (
                    <RiEBike2Line className="w-4 h-4 text-[var(--sys-primary)]" />
                  ) : (
                    <RiTruckLine className="w-4 h-4 text-[var(--sys-muted-foreground)]" />
                  )}
                  {editing === c.id ? (
                    <input
                      value={edit.name}
                      onChange={(e) => setEdit({ ...edit, name: e.target.value })}
                      className="h-11 md:h-8 w-40 rounded-lg border border-[var(--sys-border-input)] px-2 text-sm"
                    />
                  ) : (
                    c.name
                  )}</>
                ) },
            { key: 'c1', label: "النوع", primary: true,
              render: (c) => (
                  <><span className={`text-xs px-2 py-0.5 rounded-full border ${
                    c.kind === 'AGENT'
                      ? 'bg-[var(--sys-primary-soft)] border-[var(--sys-primary-soft)] text-[var(--sys-primary)]'
                      : 'bg-[var(--sys-surface)] border-[var(--sys-border)] text-[var(--sys-muted-foreground)]'
                  }`}>
                    {c.kind === 'AGENT' ? 'مندوب' : 'شركة شحن'}
                  </span></>
                ) },
            /**
             * CAN IT SHIP? — and the way to fix it if it cannot.
             *
             * A courier's fees are a row per region, and a courier with
             * none cannot be used: the shipment screen refuses it. The list
             * used to say «نشطة» beside a courier that was unusable, and
             * the only way to find out was to try.
             *
             * The chip is now the door, not a link to another screen: it
             * opens this courier's fee table beside the list, so the fact
             * and the fix are one tap apart and nobody loses their place.
             */
            { key: 'fees', label: 'الأجور',
              render: (c) => {
                const priced = c.pricedRegions ?? 0;
                const all = totalRegions;
                const none = priced === 0;
                const partial = all > 0 && priced > 0 && priced < all;
                return (
                  <button
                    onClick={() => open(c, 'fees')}
                    title={`أجور ${c.name}`}
                    className={`tap-safe inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold tabular-nums ${
                      none
                        ? 'border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] text-[var(--sys-destructive)]'
                        : partial
                          ? 'border-[var(--sys-warning)]/50 bg-[var(--sys-warning-soft)] text-[var(--sys-warning)]'
                          : 'border-[var(--sys-success)]/50 bg-[var(--sys-success-soft)] text-[var(--sys-success)]'
                    }`}
                  >
                    {none ? 'بلا أجور — لا تشحن' : `${priced} من ${all} محافظة`}
                  </button>
                );
              } },
            { key: 'c2', label: "الرمز",
              render: (c) => (
                  <><span dir="ltr" className="block">{c.code}</span>
                  {/* Which platform it runs on, under its own code — the two
                      belong together and neither is the other. */}
                  {c.adapterCode && (
                    <span dir="ltr" className="mt-0.5 block text-xs text-[var(--sys-muted)]">
                      {COURIER_PLATFORMS.find((p) => p.code === c.adapterCode)?.name ?? c.adapterCode}
                    </span>
                  )}</>
                ) },
            { key: 'c3', label: "الهاتف",
              render: (c) => (
                  <>{editing === c.id ? (
                    <input
                      value={edit.phone}
                      onChange={(e) => setEdit({ ...edit, phone: e.target.value })}
                      dir="ltr"
                      placeholder="—"
                      className="h-11 md:h-8 w-32 rounded-lg border border-[var(--sys-border-input)] px-2 text-sm"
                    />
                  ) : c.phone ? (
                    <span className="inline-flex flex-wrap items-center gap-2">
                      <span dir="ltr">{c.phone}</span>
                      {/* The same buttons the customer rows use, without the
                          ready-made messages: those are written about an
                          order, and a courier's office does not have one. */}
                      <ContactButtons phone={c.phone} context={{}} compact plain />
                    </span>
                  ) : (
                    '—'
                  )}</>
                ) },
            { key: 'c4', label: "الحالة",
              render: (c) => (
                  <><div className="flex items-center gap-2">
                    <button onClick={() => toggle(c)} disabled={busy} className={`min-h-11 md:min-h-0 inline-flex items-center text-xs px-3 py-1 rounded-lg border ${c.isActive ? 'border-[var(--sys-border)] text-[var(--sys-success)]' : 'border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] text-[var(--sys-destructive)]'}`}>
                      {c.isActive ? 'نشطة' : 'موقوفة'}
                    </button>
                    {/* An agent has no platform account: he is a person with a
                        motorbike, settled by hand. Only a company has a login. */}
                    {c.kind !== 'AGENT' && (
                      <button
                        onClick={() => open(c, 'account')}
                        className="min-h-11 md:min-h-0 inline-flex items-center rounded-lg border border-[var(--sys-border)] px-3 py-1 text-xs text-[var(--sys-foreground)] hover:border-[var(--sys-primary)] hover:text-[var(--sys-primary)]"
                      >
                        الحساب والتكامل
                      </button>
                    )}
                  </div></>
                ) },
          ]}
          empty={
            <EmptyState
              title="لا شركةَ شحنٍ لهذا المتجر بعد"
              why="بلا شركةِ شحنٍ لا يمكن تجهيز شحنة ولا طباعة بوليصة. أضِف واحدةً من النموذج أعلاه."
            />
          }
          actions={(c) => (
            <>{/* Edit and delete sit apart from the account panel: one
                      changes who this courier IS, the other changes how we
                      talk to them. */}
                  <div className="flex items-center justify-end gap-1">
                    {editing === c.id ? (
                      <>
                        <button
                          onClick={() => saveEdit(c.id)}
                          disabled={busy || !edit.name.trim()}
                          aria-label="احفظ" title="احفظ"
                          className="min-h-11 min-w-11 md:min-h-0 md:min-w-0 cursor-pointer rounded-lg p-1.5 text-[var(--sys-success)] hover:bg-[var(--sys-success-soft)] disabled:opacity-40"
                        >
                          <RiCheckLine className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => setEditing(null)}
                          aria-label="ألغِ" title="ألغِ"
                          className="min-h-11 min-w-11 md:min-h-0 md:min-w-0 cursor-pointer rounded-lg p-1.5 text-[var(--sys-muted-foreground)] hover:bg-[var(--sys-surface)]"
                        >
                          <RiCloseLine className="h-4 w-4" />
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          onClick={() => startEdit(c)}
                          aria-label="عدّل" title="عدّل"
                          className="min-h-11 min-w-11 md:min-h-0 md:min-w-0 cursor-pointer rounded-lg p-1.5 text-[var(--sys-muted-foreground)] hover:bg-[var(--sys-primary-soft)] hover:text-[var(--sys-primary)]"
                        >
                          <RiPencilLine className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => remove(c)}
                          disabled={busy}
                          aria-label="احذف" title="احذف"
                          className="min-h-11 min-w-11 md:min-h-0 md:min-w-0 cursor-pointer rounded-lg p-1.5 text-[var(--sys-muted)] hover:bg-[var(--sys-destructive-soft)] hover:text-[var(--sys-destructive)] disabled:opacity-40"
                        >
                          <RiDeleteBinLine className="h-4 w-4" />
                        </button>
                      </>
                    )}
                  </div></>
          )}
        />
      </div>

      {/*
        THE COURIER, BESIDE THE LIST IT WAS FOUND IN.
        `side="end"` and not a page: closing it puts somebody back on the row
        they tapped, which is the whole reason the two screens became one.
      */}
      {opened && (
        <Modal
          isOpen
          onClose={() => setOpenId(null)}
          title={opened.name}
          subtitle={
            opened.kind === 'AGENT'
              ? 'مندوب — تسويته يدوية'
              : `${opened.code} · ${COURIER_PLATFORMS.find((p) => p.code === opened.adapterCode)?.name ?? 'يدوي'}`
          }
          side="end"
          maxWidth="2xl"
        >
          {/*
            AN AGENT HAS NO TAB STRIP, AND STILL HAS FEES.
            He is a person with a motorbike: no platform account, so no
            second tab — and one tab is not a choice, it is a decoration.
            But he is paid per governorate like anybody else, so the fee
            editor is rendered ONCE, below, for both. Two branches each
            rendering their own copy is how one of them quietly loses a
            feature the other keeps.
          */}
          <div className="space-y-4">
            {/*
              WHERE HIS CUSTODY IS — because it is not here, and nothing said so.

              «لما أدخل صفحة كل مندوب، العهدة ما بتظهر إشي». It does not, and it
              should not: custody is derived from his orders and belongs on the
              money side, where the collection that clears it also lives. What
              was missing was any word of it on the page people open first. The
              figure is not repeated here — one owner, one place — only the door.
            */}
            {opened.kind === 'AGENT' && (
              <div className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-surface)] p-3 space-y-2">
                <p className="text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
                  هذه الصفحة تضبط من هو المندوب وكم أجرته. ما بيده الآن — بضاعة لم تُغلق، ومال
                  مؤكَّد حصّله ولم يسلّمه — يُحسب من طلباته لحظةَ فتح شاشة العهدة، ولا يُخزَّن هنا.
                </p>
                <a
                  href="/finance/agents"
                  className="min-h-11 md:min-h-0 inline-flex items-center gap-1.5 rounded-lg border border-[var(--sys-primary)] px-3 py-1.5 text-xs font-medium text-[var(--sys-primary)]"
                >
                  <RiWallet3Line className="w-4 h-4" aria-hidden />
                  افتح عهدة المندوبين
                </a>
              </div>
            )}

            {opened.kind !== 'AGENT' && (
              <Tabs
                tabs={[
                  {
                    key: 'fees',
                    label: 'الأجور',
                    // The regions still unpriced: the number that decides
                    // whether this courier can ship at all.
                    count: Math.max(0, totalRegions - (opened.pricedRegions ?? 0)) || undefined,
                  },
                  { key: 'account', label: 'الحساب والتكامل' },
                ]}
                value={tab}
                onChange={(k) => setTab(k as 'fees' | 'account')}
              />
            )}

            {opened.kind === 'AGENT' || tab === 'fees' ? (
              <CourierFees courierId={opened.id} onChanged={load} />
            ) : (
              <div className="space-y-4">
                <CourierCredentials providerId={opened.id} />
                <CourierWebhook providerId={opened.id} />
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  dir,
  required = true,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  dir?: 'ltr' | 'rtl';
  required?: boolean;
}) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        dir={dir}
        required={required}
        className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] bg-[var(--sys-card)] text-sm"
      />
    </label>
  );
}
