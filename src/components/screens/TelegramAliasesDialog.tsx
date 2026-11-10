'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { apiJson } from '@/lib/api-client';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/ui/EmptyState';
import { StatusChip } from '@/components/ui/StatusChip';
import { useToast } from '@/components/ui/Toast';
import { Money } from '@/components/ui/Money';

/**
 * «أسماء المنتجات (الأب سيل والأسماء القديمة)» — THE STORE'S OWN NAMES FOR ITS PRODUCTS (10/11).
 *
 * Two lists, one per kind:
 *   · «الأب سيل» — the name the site's upsell step writes («كورس طنين: عبوتين إضافيات 🎁»), the product it adds, how many extra
 *     units and for how much (per one «الكمية»). With the base message of the same «رقم الطلب» it makes ONE order;
 *   · «أسماء قديمة» — a product's old name (orders received before the rename of 2026-11-10), and its old offer texts: each only
 *     names which real offer (same quantity, same price) the old text meant.
 *
 * A name is switched off and on, never deleted. «أضف الأسماء الجاهزة» adds the owner's names whose products it finds in this
 * store, and says which it could not. Everyone with `telegram.view` reads the lists; only `telegram.manage` changes them.
 */

interface OfferAlias {
  name: string;
  quantity: number;
  price: number;
}

interface AliasView {
  id: string;
  kind: 'UPSELL' | 'RENAMED';
  incomingName: string;
  productId: string;
  productName: string | null;
  extraUnits: number | null;
  linePrice: number | null;
  offerAliases: OfferAlias[];
  isActive: boolean;
}

interface ListAnswer {
  rows: AliasView[];
  products: Array<{ id: string; name: string }>;
  currency: { currencyCode: string; minorUnit: number };
}

interface Draft {
  id: string | null;
  kind: 'UPSELL' | 'RENAMED';
  incomingName: string;
  productId: string;
  extraUnits: string;
  linePrice: string;
  offers: Array<{ name: string; quantity: string; price: string }>;
}

const KIND_TITLE: Record<Draft['kind'], string> = { UPSELL: 'الأب سيل', RENAMED: 'أسماء قديمة' };

/** A select drawn like the kit's `Input` (the same classes, so the stylesheet does not grow). */
const SELECT =
  'h-11 md:h-10 w-full min-w-0 text-sm bg-[var(--sys-card)] border rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--sys-primary)]/25 focus:border-[var(--sys-primary)] px-3 border-[var(--sys-border-input)]';

const blank = (kind: Draft['kind']): Draft => ({ id: null, kind, incomingName: '', productId: '', extraUnits: kind === 'UPSELL' ? '2' : '', linePrice: '', offers: [] });

const toNumber = (text: string) => {
  const n = Number(text.replace(',', '.').trim());
  return text.trim() === '' || !Number.isFinite(n) ? NaN : n;
};

export function TelegramAliasesDialog({ canManage, onClose }: { canManage: boolean; onClose: () => void }) {
  const toast = useToast();
  const [list, setList] = useState<ListAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [missing, setMissing] = useState<Array<{ incomingName: string; productName: string; why: string }>>([]);

  const load = useCallback(async () => {
    try {
      setList(await apiJson<ListAnswer>('/api/telegram/upsell-products'));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ما قدرنا نقرأ الأسماء');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const edit = (row: AliasView) =>
    setDraft({
      id: row.id,
      kind: row.kind,
      incomingName: row.incomingName,
      productId: row.productId,
      extraUnits: row.extraUnits == null ? '' : String(row.extraUnits),
      linePrice: row.linePrice == null ? '' : String(row.linePrice),
      offers: row.offerAliases.map((o) => ({ name: o.name, quantity: String(o.quantity), price: String(o.price) })),
    });

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    setFormError(null);
    const body = {
      kind: draft.kind,
      incomingName: draft.incomingName,
      productId: draft.productId,
      extraUnits: draft.kind === 'UPSELL' ? toNumber(draft.extraUnits) : null,
      linePrice: draft.kind === 'UPSELL' ? toNumber(draft.linePrice) : null,
      offerAliases: draft.kind === 'RENAMED' ? draft.offers.map((o) => ({ name: o.name, quantity: toNumber(o.quantity), price: toNumber(o.price) })) : null,
    };
    try {
      await apiJson(draft.id ? `/api/telegram/upsell-products/${draft.id}` : '/api/telegram/upsell-products', {
        method: draft.id ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      toast.done(draft.id ? 'انحفظ التعديل' : 'انضاف الاسم');
      setDraft(null);
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'ما زبط الحفظ');
    }
  };

  const toggle = async (row: AliasView) => {
    try {
      await apiJson(`/api/telegram/upsell-products/${row.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: !row.isActive }),
      });
      toast.done(row.isActive ? 'انطفى الاسم' : 'اشتغل الاسم');
      await load();
    } catch (err) {
      toast.failed(err instanceof Error ? err.message : 'ما زبط');
    }
  };

  const seed = async () => {
    try {
      const r = await apiJson<{ created: string[]; existing: string[]; missing: Array<{ incomingName: string; productName: string; why: string }> }>(
        '/api/telegram/upsell-products/seed',
        { method: 'POST' }
      );
      setMissing(r.missing);
      toast.done(r.created.length ? `انضاف ${r.created.length} اسم` : 'ما في اسم جديد ينضاف');
      await load();
    } catch (err) {
      toast.failed(err instanceof Error ? err.message : 'ما زبطت الإضافة');
    }
  };

  const currency = list?.currency.currencyCode ?? '';

  const section = (kind: Draft['kind']) => {
    const rows = (list?.rows ?? []).filter((r) => r.kind === kind);
    return (
      <section className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-[var(--sys-heading)]">{KIND_TITLE[kind]}</h3>
          {canManage && (
            <Button size="sm" variant="outline" onClick={() => setDraft(blank(kind))}>
              {kind === 'UPSELL' ? '+ أب سيل' : '+ اسم قديم'}
            </Button>
          )}
        </div>
        {rows.length === 0 ? (
          <p className="text-xs text-[var(--sys-muted-foreground)]">ما في أسماء هون لسا.</p>
        ) : (
          <ul className="space-y-2">
            {rows.map((row) => (
              <li key={row.id} className="rounded-lg border border-[var(--sys-border)] p-3 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-[var(--sys-heading)] break-words">{row.incomingName}</span>
                  <StatusChip tone={row.isActive ? 'good' : 'neutral'}>{row.isActive ? 'شغّال' : 'مطفي'}</StatusChip>
                </div>
                <p className="text-xs text-[var(--sys-muted-foreground)]">
                  المنتج: {row.productName ?? '—'}
                  {row.kind === 'UPSELL' && (
                    <>
                      {` · +${row.extraUnits ?? '—'} عبوات بـ`}
                      <Money value={row.linePrice} currency={currency || undefined} minorUnit={list?.currency.minorUnit} />
                    </>
                  )}
                  {row.kind === 'RENAMED' && row.offerAliases.length > 0 && ` · ${row.offerAliases.length} عرض قديم`}
                </p>
                {row.kind === 'RENAMED' &&
                  row.offerAliases.map((o) => (
                    <p key={o.name} className="text-xs text-[var(--sys-muted)]">
                      {o.name} ← {o.quantity} بـ<Money value={o.price} currency={currency || undefined} minorUnit={list?.currency.minorUnit} />
                    </p>
                  ))}
                {canManage && (
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <Button size="sm" variant="outline" onClick={() => edit(row)}>
                      تعديل
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => toggle(row)}>
                      {row.isActive ? 'تعطيل' : 'تفعيل'}
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  };

  const form = draft && (
    <form onSubmit={save} className="space-y-3 rounded-lg border border-[var(--sys-border)] p-3">
      <h3 className="text-sm font-semibold text-[var(--sys-heading)]">
        {draft.id ? 'تعديل' : 'إضافة'} — {KIND_TITLE[draft.kind]}
      </h3>
      <Input label="الاسم الوارد" type="text" value={draft.incomingName} onChange={(e) => setDraft({ ...draft, incomingName: e.target.value })} />
      <div className="w-full min-w-0">
        <label htmlFor="alias-product" className="block text-xs font-medium text-[var(--sys-heading)] mb-1.5">
          المنتج
        </label>
        <select id="alias-product" className={SELECT} value={draft.productId} onChange={(e) => setDraft({ ...draft, productId: e.target.value })}>
          <option value="">اختار المنتج</option>
          {(list?.products ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      {draft.kind === 'UPSELL' ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Input label="عدد العبوات الإضافية" type="text" inputMode="numeric" dir="ltr" value={draft.extraUnits} onChange={(e) => setDraft({ ...draft, extraUnits: e.target.value })} />
          <Input
            label="سعر السطر"
            type="text"
            inputMode="decimal"
            dir="ltr"
            helperText={currency ? `بـ${currency}، لكل «الكمية» وحدة` : undefined}
            value={draft.linePrice}
            onChange={(e) => setDraft({ ...draft, linePrice: e.target.value })}
          />
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-xs font-medium text-[var(--sys-heading)]">العروض القديمة (اسم العرض القديم · الكمية · السعر)</p>
          {draft.offers.map((o, i) => (
            <div key={i} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Input label="اسم العرض القديم" type="text" value={o.name} onChange={(e) => setDraft({ ...draft, offers: draft.offers.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
              <div className="flex items-end gap-2">
                <Input label="الكمية" type="text" inputMode="numeric" dir="ltr" value={o.quantity} onChange={(e) => setDraft({ ...draft, offers: draft.offers.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)) })} />
                <Input label="السعر" type="text" inputMode="decimal" dir="ltr" value={o.price} onChange={(e) => setDraft({ ...draft, offers: draft.offers.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)) })} />
                <Button type="button" size="sm" variant="ghost" onClick={() => setDraft({ ...draft, offers: draft.offers.filter((_, j) => j !== i) })}>
                  شيل
                </Button>
              </div>
            </div>
          ))}
          <Button type="button" size="sm" variant="outline" onClick={() => setDraft({ ...draft, offers: [...draft.offers, { name: '', quantity: '1', price: '' }] })}>
            + عرض قديم
          </Button>
        </div>
      )}
      {formError && (
        <p role="alert" className="rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] p-3 text-sm text-[var(--sys-destructive)]">
          {formError}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit">احفظ</Button>
        <Button type="button" variant="ghost" onClick={() => setDraft(null)}>
          إلغاء
        </Button>
      </div>
    </form>
  );

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="أسماء المنتجات (الأب سيل والأسماء القديمة)"
      subtitle="الأسماء اللي بتجي بالرسائل ومش أسماء الكتالوج: الأب سيل بيندمج مع طلبه، والاسم القديم هو المنتج نفسه"
      maxWidth="2xl"
    >
      <div className="space-y-4">
        {error && (
          <p role="alert" className="rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] p-3 text-sm text-[var(--sys-destructive)]">
            {error}
          </p>
        )}
        {canManage && (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={seed}>
              أضف الأسماء الجاهزة
            </Button>
          </div>
        )}
        {missing.length > 0 && (
          <div className="rounded-lg border border-[var(--sys-border)] p-3 space-y-1">
            <p className="text-xs font-semibold text-[var(--sys-heading)]">ما لقينا منتجها بهالمتجر — زيدها بإيدك:</p>
            {missing.map((m) => (
              <p key={m.incomingName} className="text-xs text-[var(--sys-muted-foreground)]">
                {m.incomingName} ← {m.productName} ({m.why})
              </p>
            ))}
          </div>
        )}
        {form}
        {list === null && !error ? (
          <p className="text-xs text-[var(--sys-muted-foreground)]">عم نقرأ…</p>
        ) : list && list.rows.length === 0 && !draft ? (
          <EmptyState
            title="ما في أسماء لسا"
            why="زيد اسم الأب سيل أو الاسم القديم متل ما بيجي بالرسالة، أو اضغط «أضف الأسماء الجاهزة»."
          />
        ) : null}
        {section('UPSELL')}
        {section('RENAMED')}
      </div>
    </Modal>
  );
}
