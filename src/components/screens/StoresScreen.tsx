'use client';

import { plainNumber } from '@/lib/format';
import React, { useCallback, useEffect, useState } from 'react';
import { useConfirm } from '@/components/ui/Confirm';
import { STORE_TYPE_LABEL } from '@/lib/store-types';
import { publicAddress } from '@/lib/public-address';
import { RiAlertLine, RiCheckLine, RiEqualizer2Line, RiExternalLinkLine, RiInformationLine, RiLinksLine, RiLoader4Line, RiStore2Line } from '@remixicon/react';
import { Button } from '@/components/ui/Button';
import { PanelHeader } from '@/components/store-admin/PanelHeader';
import { storeTabHref } from '@/lib/store-admin';
import { useToast } from '@/components/ui/Toast';
import { apiJson } from '@/lib/api-client';
import { catalogModeAr } from '@/lib/catalog-mode';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';

/**
 * المتجر — EVERY SHOP, ONE CARD EACH.
 *
 * The first entry of the storefront group: which shops exist, which are
 * open, which sell anything. A card carries the shop's own face (logo,
 * name, open/closed, address), its template, how many products are really
 * shown, how many published pages are still hidden, and the shop's health
 * (logo · policy pages · domain · one shown product) — and the two moves
 * a seller makes from here: manage this shop, open it.
 *
 * Open/close, tagline and about moved HERE from StorefrontSettings: one
 * editor, so the two can never disagree. The settings panel keeps a single
 * link to this screen.
 */

interface ShopHealth {
  hasLogo: boolean;
  policyPages: boolean;
  domainOk: boolean;
  hasShownProduct: boolean;
}

interface Shop {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
  type: 'SINGLE_PRODUCT' | 'MULTI_PRODUCT';
  status: string;
  live: boolean;
  tagline: string | null;
  about: string | null;
  domain: string | null;
  domainVerifiedAt: string | null;
  currency: string;
  countryId: string;
  path: string;
  current: boolean;
  template: string | null;
  shownProducts: number;
  hiddenPublishedPages: number;
  health: ShopHealth;
  frontPage: PageOption | null;
  pages: PageOption[];
}

interface PageOption {
  id: string;
  name: string;
  slug: string;
  isPublished: boolean;
  domain: string | null;
  product: { name: string } | null;
}

function addressOf(shop: Shop, origin: string) {
  return publicAddress(origin, {
    kind: 'store', slug: shop.slug, domain: shop.domain, domainVerifiedAt: shop.domainVerifiedAt,
  });
}

export function StoresScreen() {
  const toast = useToast();
  const [shops, setShops] = useState<Shop[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const confirm = useConfirm();

  const load = useCallback(async () => {
    try {
      const json = await apiJson<{ stores: Shop[] }>('/api/growth/stores');
      setShops(json.stores || []);
      setLoadFailed(false);
    } catch {
      setShops((cur) => cur ?? []);
      setLoadFailed(true);
    }
  }, []);

  useLiveRefresh(load);

  /** The shop the header is editing. Its tabs are the one primary action. */
  const current = shops?.find((s) => s.current) ?? null;

  async function patchStore(shop: Shop, body: Record<string, unknown>) {
    setBusy(shop.id);
    try {
      await apiJson(`/api/geo/stores/${shop.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      toast.failed(`${shop.name}: ${e instanceof Error ? e.message : 'تعذر الحفظ'}`);
    } finally {
      await load();
      setBusy(null);
    }
  }

  /**
   * THE FRONT PAGE, FOR SINGLE-PRODUCT SHOPS ONLY.
   *
   * Their address IS one of these pages, so the picker stays on the card
   * — moved here from the old single-product screen, same door
   * (`/api/growth/storefronts`), same rules. Multi-product shops have no
   * front page: their address is the catalogue.
   */
  async function pickFront(shop: Shop, id: string | null) {
    setBusy(shop.id);
    try {
      await apiJson('/api/growth/storefronts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storeId: shop.id, landingPageId: id }),
      });
    } catch (e) {
      toast.failed(`${shop.name}: ${e instanceof Error ? e.message : 'تعذر الحفظ'}`);
    } finally {
      await load();
      setBusy(null);
    }
  }

  async function toggle(shop: Shop) {
    if (shop.live) {
      const ok = await confirm({
        title: `إغلاق متجر «${shop.name}»؟`,
        body: 'الرابط سيتوقف عن العمل فوراً. أي إعلان يشير إليه سيصل إلى صفحة مغلقة.',
        confirmLabel: 'أغلقه',
        cancelLabel: 'إلغاء',
        tone: 'danger',
      });
      if (!ok) return;
    }
    await patchStore(shop, { storefrontEnabled: !shop.live });
  }

  /**
   * A SINGLE-PRODUCT STORE BECOMES A MULTI-PRODUCT ONE.
   *
   * One way, with the seller's explicit word: the shop's address starts
   * showing the catalogue, so adverts must move to /lp/<slug> first. The
   * API clears the front page on the way — a front page on a catalogue
   * shop would be a second answer to what the address opens.
   */
  async function convert(shop: Shop) {
    const ok = await confirm({
      title: `تحويل «${shop.name}» لمتعدد المنتجات؟`,
      body: 'رابط المتجر سيعرض الكتالوج بدل صفحة هبوط واحدة. انقل إعلاناتك إلى /lp/<slug> أولاً — وإلا وصل الزبون إلى واجهة مختلفة عما رآه بالإعلان.',
      confirmLabel: 'حوّله لمتعدد المنتجات',
      cancelLabel: 'إلغاء',
    });
    if (!ok) return;
    await patchStore(shop, { type: 'MULTI_PRODUCT' });
  }

  /**
   * MANAGE THIS SHOP — SWITCHING INTO IT ON THE WAY.
   *
   * A full navigation, not a router push: the selection lives in a cookie
   * that the server reads while rendering, and a client-side transition
   * would arrive at the new screen with the old store still in context.
   */
  async function openFor(shop: Shop, href: string) {
    if (!shop.current) {
      try {
        const res = await fetch('/api/context', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ countryId: shop.countryId, storeId: shop.id }),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          toast.failed(j.error || 'تعذّر التبديل إلى هذا المتجر');
          return;
        }
      } catch {
        toast.failed('تعذّر التبديل إلى هذا المتجر');
        return;
      }
    }
    window.location.href = href;
  }

  async function copyLink(shop: Shop) {
    const { url } = addressOf(shop, window.location.origin);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(shop.id);
      setTimeout(() => setCopied(null), 1800);
    } catch {
      /* the link is printed on the card either way */
    }
  }

  return (
    <div className="space-y-4" dir="rtl">
      {/*
        LEVEL ONE OF TWO. This screen is every shop; the tabs behind «أدِر
        هالمتجر» are one shop. There is nothing deeper, as D5 asks.

        The one primary action is the way INTO the shop you are already
        standing in — the thing somebody who opened «المتجر» came to do.
        Creating a shop is not here and never was: a shop is created in
        «البلدان والمتاجر», and that link is in the empty state.
      */}
      <PanelHeader
        title="المتجر"
        line="كل متاجر الشركة — بطاقة لكل متجر: الفتح والرابط والقالب والمعروض وصحة المتجر."
        primary={
          current ? (
            <a href={storeTabHref('front')}>
              <Button size="sm">
                <RiEqualizer2Line className="h-4 w-4" /> أدِر «{current.name}»
              </Button>
            </a>
          ) : null
        }
        help={
          <>
            <p>
              إدارة متجر تفتح ثلاثة تبويبات: «الواجهة» شكله وصفحته الرئيسية، «المحتوى» كلامه وقوائمه
              وبحثه ولغته، و«العنوان» رابطه ومساراته القديمة.
            </p>
            <p>
              «أدِر» من بطاقةِ متجرٍ آخر يبدّل متجرك الحالي إليه في الطريق — فلا شاشةَ تطلب منك
              التبديل يدوياً ثمّ العودة.
            </p>
          </>
        }
      />

      {loadFailed && (
        <p className="rounded-lg bg-[var(--sys-destructive-soft)] px-3 py-2 text-xs font-medium text-[var(--sys-destructive)]" role="alert">
          تعذّر تحميل المتاجر — أعد تحميل الصفحة.
        </p>
      )}

      {shops === null ? (
        <div className="flex h-40 items-center justify-center text-[var(--sys-muted-foreground)]">
          <RiLoader4Line className="h-4 w-4 animate-spin" />
        </div>
      ) : shops.length === 0 && !loadFailed ? (
        <div className="rounded-lg border border-dashed border-[var(--sys-border-strong)] p-8 text-center">
          <RiStore2Line className="mx-auto h-6 w-6 text-[var(--sys-border-strong)]" />
          <p className="mt-2 text-sm font-semibold text-[var(--sys-foreground)]">لا متاجر بعد</p>
          <p className="mt-1 text-xs text-[var(--sys-muted-foreground)]">
            أنشئ متجراً من «البلدان والمتاجر»، ثم ارجع إلى هنا لإدارته.
          </p>
        </div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {shops.map((s) => (
            <Card
              key={s.id}
              shop={s}
              busy={busy === s.id}
              copied={copied === s.id}
              onToggle={() => void toggle(s)}
              onCopy={() => void copyLink(s)}
              onOpen={(href) => void openFor(s, href)}
              onSave={(body) => void patchStore(s, body)}
              onConvert={() => void convert(s)}
              onPick={(id) => void pickFront(s, id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Card({
  shop, busy, copied, onToggle, onCopy, onOpen, onSave, onConvert, onPick,
}: {
  shop: Shop; busy: boolean; copied: boolean; onToggle: () => void; onCopy: () => void;
  onOpen: (href: string) => void;
  onSave: (body: Record<string, unknown>) => void;
  onConvert: () => void;
  onPick: (id: string | null) => void;
}) {
  const address = addressOf(shop, typeof window === 'undefined' ? '' : window.location.origin);
  const url = address.url;
  const [tagline, setTagline] = useStateShim(shop.tagline);
  const [about, setAbout] = useStateShim(shop.about);
  const dirty = (tagline ?? '') !== (shop.tagline ?? '') || (about ?? '') !== (shop.about ?? '');

  // Which catalogue this shop reads its shelf from — the fact, not the two
  // numbers it is derived from.
  const mode = catalogModeAr(shop.shownProducts, shop.hiddenPublishedPages);

  const health: { ok: boolean; label: string }[] = [
    { ok: shop.health.hasLogo, label: 'الشعار' },
    { ok: shop.health.policyPages, label: 'صفحات السياسات' },
    { ok: !shop.domain || shop.health.domainOk, label: shop.domain ? 'التحقق من النطاق' : 'بلا نطاق خاص' },
    { ok: shop.health.hasShownProduct, label: 'منتج معروض واحد على الأقل' },
  ];

  return (
    <div className={`rounded-lg border bg-[var(--sys-card)] p-3 ${shop.live ? 'border-[var(--sys-success-soft)]' : 'border-[var(--sys-border)]'}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2.5">
          {shop.logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={shop.logo} alt="" className="h-9 w-9 shrink-0 rounded-lg object-cover" />
          ) : (
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--sys-surface-strong)]">
              <RiStore2Line className="h-4 w-4 text-[var(--sys-muted)]" />
            </span>
          )}
          <div className="min-w-0">
            <p className="truncate text-sm font-bold text-[var(--sys-heading)]">{shop.name}</p>
            <p className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-[var(--sys-muted-foreground)]">
              <span className={`rounded-lg px-1.5 py-0.5 font-semibold ${shop.live ? 'bg-[var(--sys-success-soft)] text-[var(--sys-success)]' : 'bg-[var(--sys-surface-strong)] text-[var(--sys-muted-foreground)]'}`}>
                {shop.live ? 'مفتوح' : 'مغلق'}
              </span>
              <span className="rounded-lg bg-[var(--sys-surface-strong)] px-1.5 py-0.5">
                {STORE_TYPE_LABEL[shop.type]}
              </span>
              {shop.template && <span>{shop.template}</span>}
              {shop.domain && <span>{shop.domain}</span>}
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={onToggle}
          disabled={busy}
          role="switch"
          aria-checked={shop.live}
          aria-label={shop.live ? `متجر ${shop.name} مفتوح` : `متجر ${shop.name} مغلق`}
          className={`relative h-6 w-11 shrink-0 rounded-full transition disabled:opacity-50 ${shop.live ? 'bg-[var(--sys-success)]' : 'bg-[var(--sys-border-strong)]'}`}
        >
          <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-[var(--sys-card)] shadow transition-all ${shop.live ? 'start-0.5' : 'start-[1.375rem]'}`} />
        </button>
      </div>

      {/* ── What the shop says about itself — moved here from
          StorefrontSettings, one editor so the two never disagree ── */}
      <div className="mt-2.5 space-y-2 rounded-lg bg-[var(--sys-surface)] p-2.5">
        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-[var(--sys-foreground)]">سطر تعريفي</span>
          <input
            value={tagline ?? ''}
            onChange={(e) => setTagline(e.target.value)}
            placeholder="منتجات العناية الأصلية"
            disabled={busy}
            className="h-11 md:h-10 w-full rounded-lg border border-[var(--sys-border-input)] bg-[var(--sys-card)] px-2 text-xs text-[var(--sys-heading)]"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-[var(--sys-foreground)]">نبذة عن المتجر</span>
          <textarea
            rows={2}
            value={about ?? ''}
            onChange={(e) => setAbout(e.target.value)}
            placeholder="نوصّل لكل المحافظات، والدفع عند الاستلام."
            disabled={busy}
            className="w-full min-w-0 resize-y rounded-lg border border-[var(--sys-border-input)] bg-[var(--sys-card)] px-2 py-1.5 text-xs outline-none focus:border-[var(--sys-primary)]"
          />
        </label>
        {dirty && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onSave({ tagline: (tagline ?? '').trim() || null, about: (about ?? '').trim() || null })}
            className="tap-safe inline-flex items-center gap-1 rounded-lg bg-[var(--sys-primary)] px-2.5 py-1 text-xs font-bold text-[var(--sys-primary-foreground)] hover:bg-[var(--sys-primary)]/90 disabled:opacity-50"
          >
            <RiCheckLine className="h-4 w-4" /> احفظ الوصف
          </button>
        )}
      </div>

      <div className="mt-2.5 grid grid-cols-2 gap-2 border-t border-[var(--sys-surface-strong)] pt-2.5">
        <Num label="منتجات معروضة" value={shop.shownProducts} />
        <Num label="صفحات منشورة مخفية" value={shop.hiddenPublishedPages} />
      </div>

      {/*
        WHICH CATALOGUE THIS SHOP IS ON — SAID, NOT LEFT TO BE WORKED OUT.
        The two numbers above are the inputs to the rule; neither of them is
        the rule's answer, and the answer is what decides what a shopper
        sees. The sentence is built in `catalog-mode.ts`, where it can be
        asked for all three answers with real numbers.
      */}
      {mode.switched ? (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-[var(--sys-muted-foreground)]">
          <RiCheckLine className="h-4 w-4 shrink-0 text-[var(--sys-success)]" />
          {mode.text}
        </p>
      ) : (
        <div className="mt-2 rounded-lg border border-[var(--sys-border)] bg-[var(--sys-surface)] px-3 py-2 text-xs leading-relaxed text-[var(--sys-foreground)]">
          <span className="flex items-center gap-1.5 font-semibold">
            <RiInformationLine className="h-4 w-4 shrink-0 text-[var(--sys-muted)]" />
            {mode.text}
          </span>
          {mode.action && (
            <button
              type="button"
              onClick={() => onOpen('/store/landing-pages')}
              disabled={busy}
              className="tap-safe mt-1.5 flex items-center gap-1 font-bold text-[var(--sys-primary)] underline disabled:opacity-50"
            >
              {mode.action}
            </button>
          )}
        </div>
      )}

      {/* ── Store health: logo · policy pages · domain · one shown product ── */}
      <ul className="mt-2 space-y-1">
        {health.map((h) => (
          <li key={h.label} className="flex items-center gap-1.5 text-xs">
            {h.ok ? (
              <RiCheckLine className="h-4 w-4 shrink-0 text-[var(--sys-success)]" />
            ) : (
              <RiAlertLine className="h-4 w-4 shrink-0 text-[var(--sys-warning)]" />
            )}
            <span className={h.ok ? 'text-[var(--sys-muted-foreground)]' : 'font-semibold text-[var(--sys-warning)]'}>
              {h.label}
            </span>
          </li>
        ))}
      </ul>

      {shop.type === 'SINGLE_PRODUCT' && (
        <div className="mt-2 rounded-lg border border-[var(--sys-warning)]/50 bg-[var(--sys-warning-soft)] px-3 py-2 text-xs leading-relaxed text-[var(--sys-warning)]">
          رابط المتجر بيفتح صفحة هبوط وحدة — الكتالوج لا يظهر هنا.
          <button
            type="button"
            onClick={onConvert}
            disabled={busy}
            className="tap-safe mt-1.5 flex items-center gap-1 font-bold underline disabled:opacity-50"
          >
            <RiEqualizer2Line className="h-4 w-4" /> حوّله لمتعدد المنتجات
          </button>
        </div>
      )}

      {shop.type === 'SINGLE_PRODUCT' && (
        <div className="mt-2 rounded-lg bg-[var(--sys-surface)] p-2.5">
          <label className="mb-1 block text-xs font-semibold text-[var(--sys-foreground)]" htmlFor={`front-${shop.id}`}>
            صفحة الواجهة
          </label>
          {shop.pages.length === 0 ? (
            <p className="text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
              لا صفحاتِ هبوطٍ في هذا المتجر بعد.
            </p>
          ) : (
            <select
              id={`front-${shop.id}`}
              value={shop.frontPage?.id ?? ''}
              disabled={busy}
              onChange={(e) => onPick(e.target.value || null)}
              className="h-11 md:h-10 w-full rounded-lg border border-[var(--sys-border-input)] bg-[var(--sys-card)] px-2 text-xs text-[var(--sys-heading)]"
            >
              <option value="">— لم تُختر بعد —</option>
              {shop.pages.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.product ? ` — ${p.product.name}` : ''}
                  {p.product ? '' : ' (بلا منتج)'}
                  {p.isPublished ? '' : ' (غير منشورة)'}
                  {p.domain ? ' (لها نطاق خاص)' : ''}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        {/* Into the shop's own tabs, switching store on the way. It used
            to open the landing-pages list — one of ten entries, and not the
            one somebody pressing «أدِر» means. */}
        <button
          type="button"
          onClick={() => onOpen(storeTabHref('front'))}
          className="tap-safe inline-flex items-center gap-1 rounded-lg bg-[var(--sys-primary)] px-2.5 py-1 text-xs font-bold text-[var(--sys-primary-foreground)] hover:bg-[var(--sys-primary)]/90"
        >
          <RiEqualizer2Line className="h-4 w-4" /> أدِر هالمتجر
        </button>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 rounded-lg border border-[var(--sys-border)] px-2 py-1 text-xs font-semibold text-[var(--sys-foreground)] hover:border-[var(--sys-primary)] hover:text-[var(--sys-primary)]"
        >
          <RiExternalLinkLine className="icon-mirror h-4 w-4" /> افتح المتجر
        </a>
        <button
          type="button"
          onClick={onCopy}
          className="min-h-11 md:min-h-0 inline-flex items-center gap-1 rounded-lg border border-[var(--sys-border)] px-2 py-1 text-xs font-semibold text-[var(--sys-foreground)] hover:border-[var(--sys-primary)] hover:text-[var(--sys-primary)]"
        >
          {copied ? <RiCheckLine className="h-4 w-4 text-[var(--sys-success)]" /> : <RiLinksLine className="h-4 w-4" />}
          {copied ? 'نُسخ' : 'انسخ الرابط'}
        </button>
      </div>

      {!shop.current && (
        <p className="mt-1 flex items-center gap-1 text-xs text-[var(--sys-muted)]">
          <RiInformationLine className="h-4 w-4 shrink-0" /> الإدارة تبدّل متجرك الحالي إلى «{shop.name}».
        </p>
      )}

      {/* ── The rest of this shop: design, templates, logo — reached
          through the switch, never edited twice. The logo and the icon
          have one editor; this links to it rather than growing fields. ── */}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--sys-surface-strong)] pt-2 text-xs">
        <span className="text-[var(--sys-muted)]">مظهر المتجر:</span>
        <button type="button" onClick={() => onOpen(storeTabHref('front', 'home'))} className="tap-safe flex items-center gap-1 font-semibold text-[var(--sys-primary)] hover:underline">
          الصفحة الرئيسية
        </button>
        <button type="button" onClick={() => onOpen(storeTabHref('front', 'look'))} className="tap-safe flex items-center gap-1 font-semibold text-[var(--sys-primary)] hover:underline">
          القالب والألوان
        </button>
        <a href={`/settings/geo?store=${shop.id}`} className="tap-safe flex items-center gap-1 font-semibold text-[var(--sys-primary)] hover:underline">
          الشعار والأيقونة
        </a>
        {!shop.logo && <span className="text-[var(--sys-warning)]">لا شعار بعد</span>}
      </div>

      <p className="mt-1.5 truncate font-mono text-xs text-[var(--sys-muted)]" dir="ltr" title={url}>{url}</p>
    </div>
  );
}

/**
 * Local draft state that follows the shop it was opened on.
 *
 * `useState(shop.tagline)` alone would freeze the first shop's text into
 * every card the list renders after it. Keyed remount would work too, but
 * the card already keys on `shop.id` — this keeps the draft beside the
 * field that edits it instead.
 */
function useStateShim(initial: string | null) {
  const [value, setValue] = useState(initial ?? '');
  useEffect(() => { setValue(initial ?? ''); }, [initial]);
  return [value, setValue] as const;
}

function Num({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="text-xs text-[var(--sys-muted)]">{label}</p>
      <p className="text-xs font-bold tabular-nums text-[var(--sys-heading)]" dir="ltr">
        {plainNumber(value, 0)}
      </p>
    </div>
  );
}
