'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { SkinGallery, type SkinCard } from '@/components/store/SkinGallery';
import { LayoutPanel } from '@/components/store/LayoutPanel';
import { ContrastNotes } from '@/components/store/ContrastNotes';
import type { SampleProduct } from '@/components/store/SkinPreview';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Input';
import { apiJson } from '@/lib/api-client';
import { DEFAULT_THEME, FONTS, MOODS, isValidHex } from '@/lib/landing-theme';
import {
  CHECKOUT_FIELDS, DEFAULT_STORE_THEME, MANDATORY_CHECKOUT_FIELDS,
  checkoutOrder, hiddenCheckoutFields, type CheckoutField, type StoreTheme,
} from '@/lib/store-theme';
import { DEFAULT_SUBMIT as DEFAULT_SUBMIT_WORDS, DEFAULT_THANKS as DEFAULT_THANKS_LINE } from '@/lib/checkout-words';
import { orderAfterDrag, reorderWithinGroup } from '@/lib/nav-arrangement';
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type Announcements,
} from '@dnd-kit/core';
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { RiArrowGoBackLine, RiBankCardLine, RiCheckLine, RiDownload2Line, RiDraggable, RiExternalLinkLine, RiImageLine, RiLayoutBottomLine, RiLayoutGridLine, RiLayoutTopLine, RiLoader4Line, RiPaletteLine, RiShoppingBagLine, RiTreeLine, RiUpload2Line } from '@remixicon/react';
import { PanelHeader } from '@/components/store-admin/PanelHeader';
import { TemplateGallery } from '@/components/ui/TemplateGallery';
import { useStoreCurrency } from '@/context/StoreCurrency';
import { uploadStoreImages } from '@/lib/store-image-upload';
import { Advanced } from '@/components/landing-editor/Advanced';
import { PaneToggle, editPaneClass, previewPaneClass, type EditorPane } from '@/components/landing-editor/EditorPanes';
import { StoreThemePreview } from '@/components/landing-editor/StoreThemePreview';
import { UndoBar } from '@/components/landing-editor/UndoBar';
import { useHistory, useUndoKeys } from '@/lib/use-history';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';

/**
 * THE STORE'S TEMPLATE — one panel of «الواجهة», beside the home page.
 *
 * Everything about how the shop LOOKS lives here, and nothing about how the
 * system runs. Two things are deliberately absent:
 *
 *  - The LOGO and the FAVICON. They are the store's identity, not its
 *    template: the waybill prints the logo and the picker shows it, so they
 *    belong to the store itself. This screen shows what is set and links to
 *    the one editor. A copy of the control here would be the same field in
 *    two places.
 *  - The CART BAR tab, on a Single Product store. Not greyed out — absent.
 *    There is no cart, so there is no setting, and a disabled tab would be
 *    telling the seller about something that does not exist in their shop.
 *  - The HOME PAGE's ARRANGEMENT. The owner, 15/10 01:33: «التصميم» and
 *    «القوالب» both edited it. The tab that did so here is «صورة الغلاف»
 *    now — the one home-page value that is part of the LOOK — and the
 *    blocks are ordered in «الصفحة الرئيسية», the panel beside this one.
 *
 * No colour is written into a component. The eight named colours are CSS
 * custom properties (storeThemeVars); one left unset is derived from the
 * accent, so a seller who picks one colour gets a whole shop.
 */

/** What `GET /api/store/templates` answers with, for the ten. */
interface ShopTemplates {
  skins: SkinCard[];
  installed: string | null;
  sample: SampleProduct[];
  storeName: string;
}

const SWATCHES = [
  '#b8256e', '#e11d48', '#ea580c', '#f59e0b',
  '#16a34a', '#0d9488', '#2563eb', '#4f46e5',
  '#7c3aed', '#0f172a', '#8b5a2b', '#be123c',
];

type TabKey = 'gallery' | 'general' | 'layout' | 'chrome' | 'product' | 'checkout' | 'cart' | 'home';

const TABS: { key: TabKey; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { key: 'gallery', label: 'معرض القوالب', icon: RiLayoutGridLine },
  { key: 'general', label: 'عام', icon: RiPaletteLine },
  { key: 'layout', label: 'الترتيب', icon: RiLayoutGridLine },
  { key: 'chrome', label: 'الترويسة والتذييل', icon: RiLayoutTopLine },
  { key: 'product', label: 'إعدادات المنتج', icon: RiShoppingBagLine },
  { key: 'checkout', label: 'الدفع', icon: RiBankCardLine },
  { key: 'cart', label: 'شريط السلة السفلي', icon: RiLayoutBottomLine },
  { key: 'home', label: 'صورة الغلاف', icon: RiImageLine },
];

const COLOR_FIELDS: { key: keyof NonNullable<StoreTheme['colors']>; label: string; hint: string }[] = [
  // Named by the job each does. «أساسي» used to be the first of these and
  // it wrote a variable nothing read — three rows under the accent picker,
  // which is the control that actually sets the colour of the actions.
  { key: 'background', label: 'الصفحة', hint: 'ورق الصفحة' },
  { key: 'surface1', label: 'البطاقة', hint: 'سطح البطاقة فوق الصفحة' },
  { key: 'surface2', label: 'سطح ثالث', hint: 'شريط الفرز وورقة الفلاتر' },
  { key: 'textPrimary', label: 'النص', hint: 'العناوين والنص الغامق' },
  { key: 'textSecondary', label: 'نص خافت', hint: 'الشروح والملاحظات' },
  { key: 'border', label: 'الحدود', hint: 'الخطوط والفواصل' },
  { key: 'accentTint', label: 'أساسي فاتح', hint: 'خلفية الشارات والصفوف المختارة' },
  { key: 'accentContrast', label: 'نص الزر', hint: 'ما يُكتب فوق اللون الأساسي' },
  { key: 'price', label: 'السعر', hint: 'رقم السعر على البطاقة' },
  { key: 'priceCompare', label: 'قبل الخصم', hint: 'السعر المشطوب بجانبه' },
  { key: 'offerBadge', label: 'شارة العرض', hint: 'شارة نسبة الخصم على المنتج' },
  { key: 'success', label: 'نجاح', hint: 'محصَّل · تم' },
  { key: 'warning', label: 'تحذير', hint: 'يحتاج انتباه' },
  { key: 'danger', label: 'خطر', hint: 'متأخر · خسارة' },
];

const CHECKOUT_LABEL: Record<CheckoutField, string> = {
  name: 'الاسم',
  phone: 'الهاتف',
  altPhone: 'هاتف بديل',
  region: 'المحافظة',
  address: 'العنوان',
  note: 'ملاحظة',
};

interface StoreInfo {
  id: string;
  name: string;
  type: string;
  logo: string | null;
  favicon: string | null;
  cartBarApplies: boolean;
}

const LABEL = 'mb-1.5 block text-xs font-medium text-[var(--sys-heading)]';
const HINT = 'mt-1 block text-xs leading-relaxed text-[var(--sys-muted-foreground)]';
const CARD = 'rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] p-4';

export function StoreThemeScreen() {
  const [store, setStore] = useState<StoreInfo | null>(null);
  /**
   * THE SHOP'S LOOK, WITH A WAY BACK ONE STEP AT A TIME.
   *
   * There was already a «تراجع» on this screen and it is a different act:
   * it throws away EVERY unsaved change and returns to the draft on the
   * server. A seller who moved four colours and wants the fourth one back
   * had exactly two options — lose all four, or remember what the colour
   * used to be. Both of those are the product failing to keep a note it
   * could have kept.
   *
   * So the two stand side by side, named apart: «تراجع» is one step, and
   * «أرجِع للمحفوظة» is the reset it always was. Nothing was taken away.
   *
   * `history.set` is an edit; `history.reset` is every point where the
   * SERVER decided the value — loading, saving, publishing, reverting. A
   * stack that recorded those would offer a seller an undo back into a
   * value a customer is already being served.
   */
  const history = useHistory<StoreTheme>(DEFAULT_STORE_THEME);
  const theme = history.value;
  const setTheme = (next: StoreTheme | ((t: StoreTheme) => StoreTheme)) =>
    history.set(typeof next === 'function' ? next(history.value) : next);
  useUndoKeys(history);
  const [saved, setSaved] = useState<StoreTheme>(DEFAULT_STORE_THEME);
  const [tab, setTab] = useState<TabKey>('gallery');
  /** Which half of the editor a phone is showing. Ignored from `lg` up. */
  const [pane, setPane] = useState<EditorPane>('edit');
  const [installing, setInstalling] = useState<string | null>(null);
  /**
   * The card being looked at. Selecting is not installing: installing
   * overwrites the shop's draft, and a gallery where a stray tap replaces
   * the design somebody spent an evening on is a gallery nobody browses.
   */
  const [picked, setPicked] = useState<string | null>(null);
  /**
   * The ten shop templates, and the shop's own products to draw them with.
   * Unlike the fifteen page shapes these are NOT a constant this bundle
   * holds: which one is installed and which products exist are both facts
   * about this shop, and only the server knows them.
   */
  const [shop, setShop] = useState<ShopTemplates | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  /**
   * SAVING IS NOT PUBLISHING ANY MORE.
   *
   * `theme` is what every live storefront page paints from, and this
   * editor used to write it on every save — so a seller moving a colour
   * repainted the shop for every customer standing in it, while the home
   * page beside it had had a draft and a deliberate publish since the day
   * it was written. These three say where the shop stands.
   */
  const [unpublished, setUnpublished] = useState(false);
  const [canRevert, setCanRevert] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [uploadingCover, setUploadingCover] = useState(false);
  // The shell already knows it; the theme endpoint does not return one.
  const currency = useStoreCurrency();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // The fifteen templates are a constant this bundle already holds;
      // asking the server to name them was a request whose answer never
      // differs from `PAGE_TEMPLATES`. The install call still goes to the
      // server, which is where the decision about the draft belongs.
      const [data, gallery] = await Promise.all([
        apiJson<{ store: StoreInfo; theme: StoreTheme; hasUnpublished: boolean; canRevert: boolean }>(
          '/api/store/theme'
        ),
        apiJson<ShopTemplates>('/api/store/templates').catch(() => null),
      ]);
      setStore(data.store);
      // Loading is not an edit: it must not become the first undo step.
      history.reset(data.theme);
      setSaved(data.theme);
      setUnpublished(data.hasUnpublished);
      setCanRevert(data.canRevert);
      setShop(gallery);
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'تعذّر تحميل القالب' });
    } finally {
      setLoading(false);
    }
    // A stable callback with no dependencies of its own, so naming it here
    // does not make `load` change on every render.
  }, [history.reset]);

  useLiveRefresh(load);

  // The cart-bar tab is not rendered at all for a shop with no cart.
  const tabs = useMemo(
    () => TABS.filter((t) => t.key !== 'cart' || store?.cartBarApplies !== false),
    [store?.cartBarApplies]
  );

  // A tab that disappears under the seller (switching to a Single Product
  // store while standing on it) must not leave a blank panel.
  useEffect(() => {
    if (!tabs.some((t) => t.key === tab)) setTab('general');
  }, [tabs, tab]);

  const dirty = useMemo(() => JSON.stringify(theme) !== JSON.stringify(saved), [theme, saved]);

  /**
   * The product the fifteen cards are drawn selling, and its currency.
   *
   * `null` when the shop really has none: the cards then draw labelled
   * placeholder frames and `SkinGallery` says why in one line, which is
   * the honest answer and not the same thing as showing «؟» to a shop
   * that has twelve products.
   */
  const previewProduct = useMemo(() => {
    const first = shop?.sample?.[0];
    return first ? { name: first.name, price: first.price, currency: currency?.code ?? '' } : null;
  }, [shop, currency]);

  const set = <K extends keyof StoreTheme>(key: K, value: StoreTheme[K]) =>
    setTheme((t) => ({ ...t, [key]: value }));

  const setPart = <K extends 'colors' | 'fonts' | 'header' | 'footer' | 'product' | 'checkout' | 'cartBar' | 'home'>(
    key: K,
    patch: Partial<NonNullable<StoreTheme[K]>>
  ) => setTheme((t) => ({ ...t, [key]: { ...(t[key] as object), ...patch } } as StoreTheme));

  /**
   * Install a template. It writes the DRAFT — the seller looks at it before
   * any customer does — so this reloads rather than pretending to know what
   * the server decided.
   */
  async function install(source: 'builtin' | 'skin' | 'file', payload: string | unknown) {
    setInstalling(typeof payload === 'string' ? payload : 'file');
    setMsg(null);
    try {
      const body = source === 'file' ? { source, file: payload } : { source, key: payload };
      const res = await apiJson<{ installed: string; theme: StoreTheme; themeApplied: boolean }>(
        '/api/store/templates',
        { method: 'POST', body: JSON.stringify(body) }
      );
      await load();
      // The palette comes back as a PROPOSAL, not something already saved:
      // stores.theme is what every live page renders from, so installing
      // must not repaint the shop. It lands here as an unsaved change the
      // seller saves when they mean it — which is why the message says so.
      setTheme(res.theme);
      setMsg({
        ok: true,
        text: `ثُبِّت «${res.installed}»: الصفحة مسوّدة في «التصميم»، وألوانه معروضة هنا غير محفوظة — اضغط «حفظ» لتطبيقها على المتجر`,
      });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'تعذّر التثبيت' });
    } finally {
      setInstalling(null);
    }
  }

  /**
   * THE COVER IMAGE'S UPLOAD — the home page's own door, reused.
   *
   * It lands as an UNSAVED change, like every other value on this panel:
   * the seller sees it in the preview beside the controls, then presses
   * «احفظ المسوّدة». Writing it straight through would make the picker the
   * one control here that changes the shop without being saved.
   */
  async function uploadCover(file: File) {
    setUploadingCover(true);
    setMsg(null);
    try {
      const [url] = await uploadStoreImages([file]);
      if (!url) {
        setMsg({ ok: false, text: 'تعذّر رفع الصورة' });
        return;
      }
      setPart('home', { coverImage: url });
      setMsg({ ok: true, text: 'رُفعت الصورة — اضغط «احفظ المسوّدة» لتثبيتها' });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'تعذّر رفع الصورة' });
    } finally {
      setUploadingCover(false);
    }
  }

  async function importFile(file: File) {
    try {
      await install('file', JSON.parse(await file.text()));
    } catch {
      setMsg({ ok: false, text: 'الملف ليس ملف قالب صالحاً' });
    }
  }

  async function save() {
    setSaving(true);
    setMsg(null);
    try {
      const res = await apiJson<{ theme: StoreTheme; hasUnpublished: boolean }>('/api/store/theme', {
        method: 'PATCH',
        body: JSON.stringify(theme),
      });
      // The server's own answer, and a clean stack behind it: there is
      // nothing left to take back once the draft is what was saved.
      history.reset(res.theme);
      setSaved(res.theme);
      setUnpublished(res.hasUnpublished);
      // It says what it did. «تم الحفظ» on a screen that used to repaint
      // the shop would let a seller believe the shop had changed.
      setMsg({ ok: true, text: 'حُفظت المسوّدة — لا شيء تغيّر عند الزبون حتى تنشر' });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'تعذّر الحفظ' });
    } finally {
      setSaving(false);
    }
  }

  /** The one act a customer feels, and the only one that asks first. */
  async function publish() {
    if (!confirm('سينتقل شكل المتجر إلى هذه المسوّدة ويراه كل زبون الآن — ومعه كل نماذج الطلب: الحقول اللي بتظهر وترتيبها وإلزامها، وزر التأكيد، ورسالة ما بعد الطلب. متابعة؟')) return;
    setPublishing(true);
    setMsg(null);
    try {
      const res = await apiJson<{ theme: StoreTheme }>('/api/store/theme', { method: 'POST' });
      history.reset(res.theme);
      setSaved(res.theme);
      setUnpublished(false);
      setCanRevert(true);
      setMsg({ ok: true, text: 'نُشر — المتجر يرتدي هذا الشكل الآن' });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'تعذّر النشر' });
    } finally {
      setPublishing(false);
    }
  }

  /**
   * One press, no dialog: «رجوع للنسخة السابقة بضغطة». It is safe to press
   * because pressing it again returns — the thing it undoes becomes the
   * next step back.
   */
  async function revert() {
    setPublishing(true);
    setMsg(null);
    try {
      const res = await apiJson<{ theme: StoreTheme }>('/api/store/theme', { method: 'PUT' });
      history.reset(res.theme);
      setSaved(res.theme);
      setUnpublished(false);
      setMsg({ ok: true, text: 'رجع المتجر إلى الشكل السابق — اضغط مرّة أخرى للعودة' });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'تعذّر الرجوع' });
    } finally {
      setPublishing(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-[var(--sys-muted-foreground)]">
        <RiLoader4Line className="h-4 w-4 animate-spin" /> جارٍ التحميل…
      </div>
    );
  }

  return (
    <div className="space-y-4 pt-4" dir="rtl">
      <PanelHeader
        title="القالب والألوان"
        line={`شكل «${store?.name}»: القالب والألوان والخطوط والترويسة وشكل الدفع.`}
        note={
          msg && (
            <span className={`text-xs ${msg.ok ? 'text-[var(--sys-success)]' : 'text-[var(--sys-destructive)]'}`}>
              {msg.ok && <RiCheckLine className="mb-0.5 ml-1 inline h-4 w-4" />}
              {msg.text}
            </span>
          )
        }
        /* THE ONE ACT A CUSTOMER FEELS. Saving, stepping back and going
           back a version are all beside it, never above it. */
        primary={
          <Button size="sm" disabled={dirty || !unpublished || publishing} onClick={() => void publish()}>
            {publishing && <RiLoader4Line className="h-4 w-4 animate-spin" />} انشر
          </Button>
        }
        secondary={
          <>
            {/* One step back. The button after it is the reset, and the two
                are no longer both called «تراجع». */}
            <UndoBar
              undo={history.undo}
              redo={history.redo}
              canUndo={history.canUndo}
              canRedo={history.canRedo}
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={!dirty || saving}
              onClick={() => history.reset(saved)}
            >
              أرجِع للمحفوظة
            </Button>
            <Button size="sm" variant="secondary" disabled={!dirty || saving} onClick={() => void save()}>
              {saving && <RiLoader4Line className="h-4 w-4 animate-spin" />} احفظ المسوّدة
            </Button>
            {canRevert && (
              <Button size="sm" variant="secondary" disabled={publishing} onClick={() => void revert()}>
                <RiArrowGoBackLine className="h-4 w-4 icon-mirror" /> النسخة السابقة
              </Button>
            )}
          </>
        }
        help={
          <>
            <p>
              الحفظ ليس نشراً: «احفظ المسوّدة» لا يغيّر شيئاً عند الزبون، و«انشر» وحده ينقل المتجر إلى
              هذا الشكل. و«تراجع» خطوةٌ واحدة، و«أرجِع للمحفوظة» يرمي كلّ ما لم يُحفظ.
            </p>
            <p>
              تثبيت قالب يكتب المسوّدة فقط، وألوانه تظهر هنا غير محفوظة — فلا قالبٌ تجرّبه يُعيد دهن
              متجرٍ زبونٌ واقف فيه.
            </p>
            <p>
              القالب ينقل الشكل والأقسام ونصوصها. لا ينقل الصور — كل صورة تخصّ المتجر الذي رُفعت فيه —
              ولا الأسعار ولا البكسلات ولا النطاق. وإعدادات تشغيل النظام مكانها «الإعدادات».
            </p>
          </>
        }
      />

      {/*
        WHERE THE SHOP STANDS, ABOVE EVERYTHING ELSE.
        A seller must never have to guess whether what they are looking at
        is what a customer is looking at.
      */}
      {(dirty || unpublished) && (
        <p className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-surface)] p-2.5 text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
          {dirty
            ? 'تغييرات لم تُحفظ بعد. احفظ المسوّدة ثم انشرها ليراها الزبون.'
            : 'مسوّدة محفوظة لم تُنشر — الزبون ما زال يرى الشكل السابق.'}
        </p>
      )}

      <nav className="flex flex-wrap gap-1 border-b border-[var(--sys-border)]">
        {tabs.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-semibold transition ${
              tab === key
                ? 'border-[var(--sys-primary)] text-[var(--sys-primary)]'
                : 'border-transparent text-[var(--sys-muted-foreground)] hover:text-[var(--sys-foreground)]'
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </nav>

      {/*
        THE CONTROLS AND THE SHOP, SIDE BY SIDE.

        Seven of the eight tabs were forms. A seller changed the price
        colour, saved, published, opened the shop in another tab and found
        out — which makes PUBLISHING the preview, on a live shop, in front
        of customers. The miniature on the right is drawn from the theme in
        their hands, by the same component the gallery's cards use.

        On a phone the two swap with the toggle above: two columns do not
        fit at 390px, and stacking them puts the preview below a panel
        taller than the screen, which is the same as not having one.
      */}
      <PaneToggle pane={pane} onPane={setPane} />

      {/* The page editor's own column pair, to the pixel: a second width
          here would be a second grid template in the stylesheet, which the
          CSS ratchet charges to every page in the product. */}
      <div className="gap-4 lg:grid lg:grid-cols-[1fr_300px] lg:items-start">
        <div className={`space-y-4 ${editPaneClass(pane)}`}>

      {/* ── معرض القوالب ── */}
      {tab === 'gallery' && (
        <div className="space-y-4">
          <div className={CARD}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm font-bold text-[var(--sys-heading)]">قالبك الحالي</p>
                <p className="mt-0.5 text-xs text-[var(--sys-muted-foreground)]">
                  احفظه كملف لتنقله إلى متجر آخر، أو ثبّت ملفاً جاهزاً.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <a href="/api/store/templates?export=1" download>
                  <Button variant="secondary" size="sm">
                    <RiDownload2Line className="h-4 w-4" /> صدّر قالبي
                  </Button>
                </a>
                <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-[var(--sys-border)] px-3 py-1.5 text-xs font-bold text-[var(--sys-foreground)] hover:border-[var(--sys-primary)] hover:text-[var(--sys-primary)]">
                  <RiUpload2Line className="h-4 w-4" /> استورد ملفاً
                  <input
                    type="file"
                    accept="application/json,.json"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = '';
                      if (file) void importFile(file);
                    }}
                  />
                </label>
              </div>
            </div>
          </div>

          {/*
            THE TEN SHOP TEMPLATES, FIRST.

            They dress the whole engine — palette, type, and which
            arrangement each part draws — and the fifteen below order the
            blocks of one page. A seller looking for «how should my shop
            look» means the first; one looking for «what goes on my home
            page» means the second. Two units, one screen, in the order a
            shop is actually built.
          */}
          {shop && shop.skins.length > 0 && (
            <div className={CARD}>
              <p className="text-sm font-bold text-[var(--sys-heading)]">قوالب المتجر</p>
              <p className="mb-3 mt-0.5 text-xs text-[var(--sys-muted-foreground)]">
                كل قالب يغيّر الشكل وحده — لا منتجاً ولا طلباً ولا سعراً ولا رابطاً.
              </p>
              <SkinGallery
                skins={shop.skins}
                installed={shop.installed}
                products={shop.sample}
                storeName={shop.storeName}
                installing={installing}
                onInstall={(key) => void install('skin', key)}
              />
            </div>
          )}

          {/*
            SHOWN, NOT DESCRIBED — and by the renderer that draws the real
            page, so the card cannot promise a shape the shop will not get.
            The same gallery the landing page's create dialog uses: one
            grid, one set of fifteen, no second place to be out of date.
          */}
          <p className="text-sm font-bold text-[var(--sys-heading)]">قوالب الصفحة الرئيسية</p>
          <TemplateGallery
            value={picked}
            onChange={setPicked}
            /*
              THE SHOP'S OWN PRODUCT, AS THE LANDING-PAGE GALLERY ALREADY
              DOES IT.

              This call passed no product, so all fifteen cards advertised
              «منتجك» at a price of nothing, and the shop templates beside
              them drew «؟» — the owner's report of 15/10. `shop.sample` is
              the seller's four real products and has been on the wire from
              `/api/store/templates` the whole time; nothing read it here.
            */
            product={previewProduct}
            action={(key) => (
              <Button
                size="sm"
                variant="secondary"
                disabled={!!installing}
                onClick={() => void install('builtin', key)}
              >
                {installing === key && <RiLoader4Line className="h-4 w-4 animate-spin" />}
                ثبّته كمسوّدة
              </Button>
            )}
          />
          <p className="text-xs leading-relaxed text-[var(--sys-muted)]">
            التثبيت يكتب المسوّدة فقط — تعاينها في «الصفحة الرئيسية» وتنشرها حين ترضى عنها.
          </p>
        </div>
      )}

      {/* ── أ. عام: الخطوط والألوان ── */}
      {tab === 'general' && (
        <div className="space-y-4">
          <div className={CARD}>
            <p className="mb-3 text-sm font-bold text-[var(--sys-heading)]">الهوية</p>
            {/* A LINK, never a second copy of the control. */}
            <a
              href="/settings/geo"
              className="flex items-center justify-between gap-3 rounded-lg border border-[var(--sys-border)] bg-[var(--sys-surface)] px-3 py-2.5 text-xs text-[var(--sys-foreground)] hover:border-[var(--sys-primary)] hover:text-[var(--sys-primary)]"
            >
              <span className="flex items-center gap-2">
                {store?.logo ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={store.logo} alt="" className="h-7 w-7 rounded-lg object-contain" />
                ) : (
                  <RiImageLine className="h-4 w-4" />
                )}
                الشعار والأيقونة المفضّلة ورقم الدعم
                {!store?.logo && <span className="text-[var(--sys-muted)]">— لم يُضبط بعد</span>}
              </span>
              <span className="flex items-center gap-1 font-semibold">
                في «البلدان والمتاجر» <RiExternalLinkLine className="icon-mirror h-4 w-4" />
              </span>
            </a>
            <p className={HINT}>
              تُكتب مرة واحدة مع المتجر نفسه، لأنّ البوليصة تطبع الشعار واختيار المتجر يعرضه. لا تُكرَّر هنا.
            </p>
          </div>

          <div className={CARD}>
            <p className="mb-3 text-sm font-bold text-[var(--sys-heading)]">الخطوط</p>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="block">
                <span className={LABEL}>خط النص</span>
                <Select value={theme.font} onChange={(e) => set('font', e.target.value as StoreTheme['font'])}>
                  {FONTS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                </Select>
                <span className={HINT} style={{ fontFamily: FONTS.find((f) => f.key === theme.font)?.stack }}>
                  نموذج: الدفع عند الاستلام وتوصيل لكل المناطق
                </span>
              </label>
              <label className="block">
                <span className={LABEL}>خط العناوين</span>
                <Select
                  value={theme.fonts?.heading ?? ''}
                  onChange={(e) => setPart('fonts', { heading: e.target.value || undefined })}
                >
                  <option value="">مثل خط النص</option>
                  {FONTS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                </Select>
                <span
                  className={HINT}
                  style={{ fontFamily: FONTS.find((f) => f.key === (theme.fonts?.heading ?? theme.font))?.stack }}
                >
                  نموذج: عرض خاص لفترة محدودة
                </span>
              </label>
              <label className="block">
                <span className={LABEL}>خط القوائم</span>
                <Select
                  value={theme.fonts?.menu ?? ''}
                  onChange={(e) => setPart('fonts', { menu: e.target.value || undefined })}
                >
                  <option value="">مثل خط النص</option>
                  {FONTS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                </Select>
                <span
                  className={HINT}
                  style={{ fontFamily: FONTS.find((f) => f.key === (theme.fonts?.menu ?? theme.font))?.stack }}
                >
                  نموذج: من نحن · الشروط · تواصل معنا
                </span>
              </label>
            </div>
          </div>

          <div className={CARD}>
            <p className="mb-1 text-sm font-bold text-[var(--sys-heading)]">الألوان</p>
            <p className="mb-3 text-xs text-[var(--sys-muted)]">
              كل لون لا تحدّده يُشتق من اللون الأساسي، فلا يخرج لك متجر بثمانية ألوان لا تتفق.
            </p>
            <div className="mb-3 grid grid-cols-6 gap-1.5 sm:grid-cols-12">
              {SWATCHES.map((hex) => (
                <button
                  key={hex}
                  type="button"
                  onClick={() => set('accent', hex)}
                  title={hex}
                  style={{ background: hex }}
                  className={`h-11 md:h-7 rounded-md border-2 transition ${
                    theme.accent.toLowerCase() === hex ? 'scale-105 border-[var(--sys-heading)]' : 'border-transparent'
                  }`}
                />
              ))}
            </div>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <input
                type="color"
                aria-label="اللون الأساسي"
                value={isValidHex(theme.accent) ? theme.accent : DEFAULT_STORE_THEME.accent}
                onChange={(e) => set('accent', e.target.value)}
                className="h-11 md:h-8 w-10 cursor-pointer rounded-lg border border-[var(--sys-border)]"
              />
              <Select
                className="text-xs"
                value={theme.mood}
                onChange={(e) => set('mood', e.target.value as StoreTheme['mood'])}
              >
                {MOODS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
              </Select>
              <Select
                className="text-xs"
                value={theme.corners}
                onChange={(e) => set('corners', e.target.value as StoreTheme['corners'])}
              >
                <option value="soft">زوايا ناعمة</option>
                <option value="sharp">زوايا حادّة</option>
              </Select>
            </div>
            {/*
              FOURTEEN PICKERS, FOLDED.

              The control above decides the shop's colour; these fourteen
              override one derived role each, and most shops never touch
              one. Open, they made the accent the same size as «نص خافت»
              — so the eye had no reason to land on the control that
              actually does the work. Still all here, one tap away.
            */}
            <Advanced label="ألوان متقدّمة" holds="الصفحة · البطاقة · النص · السعر · شارة العرض — كلّ ما لا تحدّده يُشتقّ من الأساسي">
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-2">
              {COLOR_FIELDS.map(({ key, label, hint }) => {
                const value = theme.colors?.[key];
                return (
                  <div key={key} className="rounded-lg border border-[var(--sys-border)] p-2">
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        aria-label={label}
                        value={value && isValidHex(value) ? value : '#ffffff'}
                        onChange={(e) => setPart('colors', { [key]: e.target.value })}
                        className="h-11 md:h-7 w-9 cursor-pointer rounded-lg border border-[var(--sys-border)]"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-semibold text-[var(--sys-foreground)]">{label}</p>
                        <p className="truncate text-xs text-[var(--sys-muted)]">{hint}</p>
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={!value}
                      onClick={() => setPart('colors', { [key]: undefined })}
                      className="mt-1 text-xs text-[var(--sys-muted)] underline disabled:opacity-40"
                    >
                      {value ? 'أعده للمُشتقّ' : 'مُشتقّ من الأساسي'}
                    </button>
                  </div>
                );
              })}
            </div>
            </Advanced>

            {/*
              Under the grid, not beside one picker: a contrast failure is
              a fact about a PAIR, and which of the two to move is the
              seller's call. It names the pair by what a shopper reads and
              offers the nearest colour that works.

              OUTSIDE the fold, deliberately: a pair that fails contrast is
              a fact about the shop a seller must meet whether or not they
              opened the advanced pickers — and the fix button inside it
              reaches exactly those fields.
            */}
            <div className="mt-3">
              <ContrastNotes
                theme={theme}
                onFix={(field, hex) => setPart('colors', { [field]: hex })}
              />
            </div>
          </div>
        </div>
      )}

      {/* ── الترتيب: أيّ نسخة يرسمها كل جزء من المحرّك ── */}
      {tab === 'layout' && (
        <div className={CARD}>
          <p className="text-sm font-bold text-[var(--sys-heading)]">الترتيب</p>
          <p className="mb-4 mt-0.5 text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
            كل قالب يأتي بترتيبه، وهذه الضوابط تغيّره دون مغادرته. ولا نسخة هنا تحذف البحث أو السلة
            أو زر واتساب — هي ترتيب، لا طرح.
          </p>
          <LayoutPanel
            layout={theme.layout}
            cartApplies={store?.cartBarApplies !== false}
            onChange={(slot, variant) =>
              setTheme((t) => ({ ...t, layout: { ...(t.layout ?? {}), [slot]: variant } }))
            }
          />
        </div>
      )}

      {/* ── ب. الترويسة والتذييل ── */}
      {tab === 'chrome' && (
        <div className="space-y-4">
          <div className={CARD}>
            <p className="mb-3 text-sm font-bold text-[var(--sys-heading)]">الترويسة</p>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="block">
                <span className={LABEL}>الارتفاع (بكسل)</span>
                <Input
                  type="number"
                  min={48}
                  max={160}
                  value={theme.header?.height ?? 72}
                  onChange={(e) => setPart('header', { height: Number(e.target.value) })}
                />
              </label>
              <label className="block">
                <span className={LABEL}>لون الترويسة</span>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    aria-label="لون الترويسة"
                    value={theme.header?.background && isValidHex(theme.header.background) ? theme.header.background : '#ffffff'}
                    onChange={(e) => setPart('header', { background: e.target.value })}
                    className="h-11 md:h-10 w-12 cursor-pointer rounded-lg border border-[var(--sys-border)]"
                  />
                  <button
                    type="button"
                    disabled={!theme.header?.background}
                    onClick={() => setPart('header', { background: undefined })}
                    className="text-xs text-[var(--sys-muted)] underline disabled:opacity-40"
                  >
                    مُشتقّ
                  </button>
                </div>
              </label>
              <label className="flex items-center gap-2 self-end pb-2 text-xs text-[var(--sys-foreground)]">
                <input
                  type="checkbox"
                  checked={theme.header?.sticky ?? true}
                  onChange={(e) => setPart('header', { sticky: e.target.checked })}
                  className="h-4 w-4 accent-[var(--sys-primary)]"
                />
                تثبيتها عند التمرير
              </label>
            </div>
            <p className={HINT}>
              الشعار المعروض في الترويسة هو شعار المتجر نفسه — يُضبط من «البلدان والمتاجر».
            </p>

            {/*
              ONLY A SINGLE PRODUCT STORE HAS THIS QUESTION.
              Every other store's pages are shop pages and always wear the
              header. A Single Product store's address renders its landing
              page, and until now it rendered it bare: no logo, no name, no
              header, no footer — everything set on this screen, invisible.
            */}
            {store?.type === 'SINGLE_PRODUCT' && (
              <div className="mt-3 rounded-lg border border-[var(--sys-border)] bg-[var(--sys-surface)] p-3">
                <label className="flex items-start gap-2 text-xs text-[var(--sys-foreground)]">
                  <input
                    type="checkbox"
                    checked={theme.header?.onFrontPage !== false}
                    onChange={(e) => setPart('header', { onFrontPage: e.target.checked })}
                    className="mt-0.5 h-4 w-4 accent-[var(--sys-primary)]"
                  />
                  <span>
                    <span className="font-semibold">أظهرها فوق صفحة الواجهة</span>
                    <span className="mt-0.5 block leading-relaxed text-[var(--sys-muted-foreground)]">
                      عنوانُ هذا المتجر يعرض صفحةَ الهبوط التي اخترتَها. مع هذا الخيار تلبس الصفحةُ
                      ترويسةَ المتجر وشعارَه وقوائمَه وتذييلَه. أطفئه إن كنت تريدها إعلاناً صافياً
                      بلا طريقٍ للخروج منه — وتذييلُ الصفحة الخاصُّ بها، إن وُجد، يبقى هو الظاهر.
                    </span>
                  </span>
                </label>
              </div>
            )}
          </div>

          <div className={CARD}>
            <p className="mb-3 text-sm font-bold text-[var(--sys-heading)]">التذييل</p>
            {/* The links are a MENU — with an order and a visibility flag —
                and they have one editor. They lived here too for one part,
                because the contract named them in this tab and named
                «التذييل» among the five menus. */}
            <a
              href="/store/menus"
              className="flex items-center justify-between gap-2 rounded-lg border border-[var(--sys-border)] bg-[var(--sys-surface)] px-3 py-2.5 text-xs text-[var(--sys-foreground)] hover:border-[var(--sys-primary)] hover:text-[var(--sys-primary)]"
            >
              <span className="flex items-center gap-1.5">
                <RiTreeLine className="h-4 w-4" />
                روابط التذييل
              </span>
              <span className="font-semibold">في «القوائم» ←</span>
            </a>
            <label className="mt-3 block">
              <span className={LABEL}>حقوق النشر</span>
              <Input
                maxLength={160}
                placeholder="© 2026 جميع الحقوق محفوظة"
                value={theme.footer?.copyright ?? ''}
                onChange={(e) => setPart('footer', { copyright: e.target.value })}
              />
            </label>
          </div>
        </div>
      )}

      {/* ── ج. إعدادات المنتج ── */}
      {tab === 'product' && (
        <div className={CARD}>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className={LABEL}>شكل عرض السعر</span>
              <Select
                value={theme.product?.priceStyle ?? 'plain'}
                onChange={(e) => setPart('product', { priceStyle: e.target.value as 'plain' | 'with_compare' })}
              >
                <option value="plain">السعر وحده</option>
                <option value="with_compare">السعر مع سعر مشطوب بجانبه</option>
              </Select>
            </label>
            <label className="block">
              <span className={LABEL}>ترتيب الصور</span>
              <Select
                value={theme.product?.imageOrder ?? 'as_uploaded'}
                onChange={(e) => setPart('product', { imageOrder: e.target.value as 'as_uploaded' | 'newest_first' })}
              >
                <option value="as_uploaded">كما رُفعت</option>
                <option value="newest_first">الأحدث أولاً</option>
              </Select>
            </label>
          </div>
          <label className="mt-3 flex items-center gap-2 text-xs text-[var(--sys-foreground)]">
            <input
              type="checkbox"
              checked={theme.product?.showStock ?? false}
              onChange={(e) => setPart('product', { showStock: e.target.checked })}
              className="h-4 w-4 accent-[var(--sys-primary)]"
            />
            أظهر المخزون المتبقي
          </label>
          <p className={HINT}>رقم منخفض قد يُقنع بالشراء وقد يُخيف — لذلك هو اختيار، ومطفأ افتراضياً.</p>
          <label className="mt-3 flex items-center gap-2 text-xs text-[var(--sys-foreground)]">
            <input
              type="checkbox"
              checked={theme.product?.discountBadge ?? true}
              onChange={(e) => setPart('product', { discountBadge: e.target.checked })}
              className="h-4 w-4 accent-[var(--sys-primary)]"
            />
            أظهر شارة الخصم
          </label>
          {/*
            «تغليف خفي» — the owner's §٩ for «علامة», and a setting rather
            than a sentence: «سطر إعداد بيشغّله المالك، مش ثابت. إذا مطفي
            ما بيطلع لا بالشريط العلوي ولا بـ(ليش تطلب عنّا)».

            Here and not inside the family's own code, because it is a
            fact about how this shop packs a parcel, not about how it
            looks: a template that printed it unconditionally would be
            making the seller a promise they never made. Off by default,
            which is the honest default for a claim.
          */}
          <label className="mt-3 flex items-center gap-2 text-xs text-[var(--sys-foreground)]">
            <input
              type="checkbox"
              checked={theme.discreetPacking === true}
              onChange={(e) => set('discreetPacking', e.target.checked || undefined)}
              className="h-4 w-4 accent-[var(--sys-primary)]"
            />
            تغليف خفي
          </label>
          <p className={HINT}>
            شغّلها إذا كنت فعلاً تغلّف بلا اسم ولا وصف على الكرتونة — بتظهر بشريط الترويسة وبقسم «ليش
            تطلب عنّا». مطفأة افتراضياً.
          </p>
        </div>
      )}

      {/* ── د. إعدادات الدفع ── */}
      {tab === 'checkout' && (
        <div className="space-y-4">
          <div className={CARD}>
            <p className="mb-1 text-sm font-bold text-[var(--sys-heading)]">حقول نموذج الطلب</p>
            <p className="mb-3 text-xs text-[var(--sys-muted)]">
              اسحب الحقل لترتيبه. الاسم والهاتف والمحافظة والعنوان ظاهرة وإلزامية دائماً: بدونها ما بتتسعّر الشحنة ولا بتوصل.
            </p>
            {/* Every change here is a DRAFT change like the rest of this screen — «انشر» puts it in front of visitors. */}
            <CheckoutFields theme={theme} onChange={(patch) => setPart('checkout', patch)} />
          </div>

          <div className={CARD}>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className={LABEL}>نص زر التأكيد</span>
                <Input
                  maxLength={40}
                  placeholder={DEFAULT_SUBMIT_WORDS}
                  value={theme.checkout?.submitText ?? ''}
                  onChange={(e) => setPart('checkout', { submitText: e.target.value })}
                />
                {/* What a blank one really shows — the placeholder is that, and never an example that appears nowhere. */}
                <span className={HINT}>
                  فاضي: صفحات الهبوط والمنتجات بتكتب «{DEFAULT_SUBMIT_WORDS}» (أو نص الصفحة إذا غيّرته)، والسلة بتكتب «أرسل الطلب».
                </span>
              </label>
              <label className="block">
                <span className={LABEL}>لون زر التأكيد</span>
                <div className="flex items-center gap-2">
                  {/* No colour set: the swatch is the shop's primary — which is what the button wears then — never
                      a white that no button shows. */}
                  <input
                    type="color"
                    aria-label="لون زر التأكيد"
                    value={
                      theme.checkout?.buttonColor && isValidHex(theme.checkout.buttonColor)
                        ? theme.checkout.buttonColor
                        : isValidHex(theme.accent)
                          ? theme.accent
                          : DEFAULT_THEME.accent
                    }
                    onChange={(e) => setPart('checkout', { buttonColor: e.target.value })}
                    className="h-11 md:h-10 w-12 cursor-pointer rounded-lg border border-[var(--sys-border)]"
                  />
                  <button
                    type="button"
                    disabled={!theme.checkout?.buttonColor}
                    onClick={() => setPart('checkout', { buttonColor: undefined })}
                    className="text-xs text-[var(--sys-muted)] underline disabled:opacity-40"
                  >
                    مثل اللون الأساسي
                  </button>
                </div>
              </label>
            </div>
            <label className="mt-3 block">
              <span className={LABEL}>رسالة ما بعد الطلب</span>
              <Input
                maxLength={300}
                placeholder={DEFAULT_THANKS_LINE}
                value={theme.checkout?.afterOrderMessage ?? ''}
                onChange={(e) => setPart('checkout', { afterOrderMessage: e.target.value })}
              />
              <span className={HINT}>
                فاضي: النموذج بيكتب «{DEFAULT_THANKS_LINE}» وصفحة الشكر بالسلة «تم استلام طلبك». وصفحة هبوط كاتبة رسالة شكر
                إلها بتضل على رسالتها.
              </span>
            </label>
          </div>
        </div>
      )}

      {/* ── هـ. شريط السلة السفلي — لا يُعرض أصلاً لمتجر Single Product ── */}
      {tab === 'cart' && store?.cartBarApplies && (
        <div className={CARD}>
          <label className="flex items-center gap-2 text-xs text-[var(--sys-foreground)]">
            <input
              type="checkbox"
              checked={theme.cartBar?.enabled ?? true}
              onChange={(e) => setPart('cartBar', { enabled: e.target.checked })}
              className="h-4 w-4 accent-[var(--sys-primary)]"
            />
            أظهر شريط السلة أسفل الشاشة
          </label>
          <label className="mt-3 block max-w-xs">
            <span className={LABEL}>نصّ الشريط</span>
            <Input
              maxLength={40}
              placeholder="أكمل الطلب"
              value={theme.cartBar?.label ?? ''}
              onChange={(e) => setPart('cartBar', { label: e.target.value })}
            />
          </label>
        </div>
      )}

      {/* ── و. الصفحة الرئيسية ── */}
      {/*
        A PICTURE IS PICKED, NOT TYPED.

        The owner, 15/10 01:33: «the cover image is a text field holding a
        path». It was — `/api/public/media/…`, three hundred characters, and
        the only way to fill it correctly was to upload the image somewhere
        else, find its address and paste it. So it stayed empty, and the
        cover never appeared on any shop.

        It uploads through the SAME door the home page's blocks upload
        through (`/api/store/design/image`): one storage pipeline, one MIME
        allowlist, one tenant namespace, one permission. No new route.

        The path is still shown, in small type: a seller who pasted one
        already must be able to see it and clear it.
      */}
      {tab === 'home' && (
        <div className={CARD}>
          <p className={LABEL}>صورة الغلاف</p>
          <div className="flex flex-wrap items-start gap-3">
            {theme.home?.coverImage ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={theme.home.coverImage}
                alt=""
                className="h-24 w-40 rounded-lg border border-[var(--sys-border)] object-cover"
              />
            ) : (
              <span className="flex h-24 w-40 items-center justify-center rounded-lg border border-dashed border-[var(--sys-border-strong)] text-[var(--sys-muted)]">
                <RiImageLine className="h-5 w-5" />
              </span>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <label className="tap-safe inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-lg border border-[var(--sys-border)] px-3 text-xs font-bold text-[var(--sys-foreground)] hover:border-[var(--sys-primary)] hover:text-[var(--sys-primary)] md:min-h-0">
                {uploadingCover ? (
                  <RiLoader4Line className="h-4 w-4 animate-spin" />
                ) : (
                  <RiUpload2Line className="h-4 w-4" />
                )}
                {theme.home?.coverImage ? 'استبدل الصورة' : 'ارفع صورة'}
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  disabled={uploadingCover}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (file) void uploadCover(file);
                  }}
                />
              </label>
              {theme.home?.coverImage && (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={uploadingCover}
                  onClick={() => setPart('home', { coverImage: undefined })}
                >
                  أزلها
                </Button>
              )}
            </div>
          </div>
          {theme.home?.coverImage && (
            <p className="mt-2 truncate font-mono text-xs text-[var(--sys-muted)]" dir="ltr">
              {theme.home.coverImage}
            </p>
          )}
          <p className={HINT}>
            من رفعك أنت. رابط خارجي مرفوض: صورة من موقع لا نتحكم به تسرّب كل زائر إليه.
          </p>
        </div>
      )}

        </div>

        {/* The shop as it is being set, at both widths, from the UNSAVED
            theme — so the seller sees the change before a customer does. */}
        <div className={`${previewPaneClass(pane)} min-h-0 flex-col`}>
          <StoreThemePreview
            theme={theme}
            products={shop?.sample ?? []}
            storeName={store?.name ?? ''}
            unpublished={dirty || unpublished}
          />
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────────── «الدفع»: what the form shows, what it requires, in what order ───────────────────────────── */

type CheckoutPatch = Partial<NonNullable<StoreTheme['checkout']>>;

/** What a screen reader is told before it picks a field up. */
const CHECKOUT_DRAG_HELP = {
  draggable: 'لتغيير ترتيب هذا الحقل: اضغط مسافة لتمسكه، ثم السهم لأعلى أو لأسفل، ثم مسافة لتفلته. اضغط Esc للإلغاء.',
};

/**
 * «انطيني الصلاحية شو الي يظهر بالشيك اوت الي بينطلب والترتيب دراخ اند دروب» — the owner, 28/10.
 *
 * Three answers per field, and all three are the DRAFT's, like every other control on this screen: they reach a
 * visitor when «انشر» is pressed, never before.
 *
 *   · THE ORDER, by drag and drop — the pattern `MenuOrderCard` and the offers list already answer, with the same two
 *     promises: `@dnd-kit` with a keyboard sensor and Arabic announcements (Space to pick a field up, ↑ ↓ to move it,
 *     Space to put it down, Esc to cancel), and a drag that starts ONLY from the grip, which alone refuses the
 *     browser's scroll gesture. The ↑ ↓ buttons stay — the path a thumb, a keyboard and a screen reader reach on the
 *     first day — and both go through the one move (`reorderWithinGroup`), so they cannot disagree.
 *   · «يظهر» — a field taken off every form. Hiding one also clears its «إلزامي»: a hidden field asks nothing, and
 *     the door would refuse every order over a field nobody can see (`requiredCheckoutFields` says the same).
 *   · «إلزامي» — refused at the door when left blank, and said under the field before sending. Not offered while
 *     the field is hidden.
 *
 * The four a parcel needs are shown and required ALWAYS: both boxes ticked and locked, with the reason written above.
 */
function CheckoutFields({ theme, onChange }: { theme: StoreTheme; onChange: (patch: CheckoutPatch) => void }) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const order = checkoutOrder(theme);
  const hidden = new Set(hiddenCheckoutFields(theme));
  const ticked = new Set<CheckoutField>(theme.checkout?.required ?? []);

  const reorder = (next: string[] | null) => {
    if (next) onChange({ fieldOrder: next as CheckoutField[] });
  };
  const show = (field: CheckoutField, on: boolean) => {
    const nextHidden = new Set(hidden);
    if (on) nextHidden.delete(field);
    else nextHidden.add(field);
    const patch: CheckoutPatch = {
      hidden: CHECKOUT_FIELDS.filter((f) => nextHidden.has(f) && !MANDATORY_CHECKOUT_FIELDS.includes(f)),
    };
    if (!on) patch.required = CHECKOUT_FIELDS.filter((f) => ticked.has(f) && f !== field);
    onChange(patch);
  };
  const tick = (field: CheckoutField, on: boolean) => {
    const next = new Set(ticked);
    if (on) next.add(field);
    else next.delete(field);
    onChange({ required: CHECKOUT_FIELDS.filter((f) => next.has(f)) });
  };

  const nameOf = (id: string | number) => CHECKOUT_LABEL[id as CheckoutField] ?? '';
  const announcements: Announcements = {
    onDragStart: ({ active }) => `أمسكتَ «${nameOf(active.id)}».`,
    onDragOver: ({ active, over }) =>
      over && over.id !== active.id ? `«${nameOf(active.id)}» فوق «${nameOf(over.id)}».` : undefined,
    onDragEnd: ({ active, over }) =>
      over && over.id !== active.id
        ? `أُفلت «${nameOf(active.id)}» مكان «${nameOf(over.id)}».`
        : `أُفلت «${nameOf(active.id)}» في مكانه.`,
    onDragCancel: ({ active }) => `أُلغي تحريك «${nameOf(active.id)}».`,
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      // The vertical axis is locked and the row kept inside its list, so a hand that drifts sideways does not lose it.
      modifiers={[restrictToVerticalAxis, restrictToParentElement]}
      onDragEnd={(end) => reorder(orderAfterDrag(order, order, end))}
      accessibility={{ announcements, screenReaderInstructions: CHECKOUT_DRAG_HELP }}
    >
      <SortableContext items={order} strategy={verticalListSortingStrategy}>
        <ul className="space-y-1.5">
          {order.map((field, i) => {
            const mandatory = MANDATORY_CHECKOUT_FIELDS.includes(field);
            const shown = !hidden.has(field);
            return (
              <CheckoutFieldRow
                key={field}
                field={field}
                first={i === 0}
                last={i === order.length - 1}
                mandatory={mandatory}
                shown={shown}
                required={mandatory || (shown && ticked.has(field))}
                onMove={(by) => reorder(reorderWithinGroup(order, order, i, i + by))}
                onShow={(on) => show(field, on)}
                onRequire={(on) => tick(field, on)}
              />
            );
          })}
        </ul>
      </SortableContext>
    </DndContext>
  );
}

/**
 * ONE FIELD: ITS GRIP, ITS NAME, ITS TWO BOXES AND THE TWO ARROWS IT ALWAYS HAD.
 *
 * The grip is the ONLY thing that starts a drag (`useSortable`'s listeners are on it and nowhere else) and it alone
 * carries the no-scroll touch rule, so a thumb anywhere else on the row scrolls the page. The row's look while it is
 * carried is INLINE — lifted, a little transparent, above its neighbours — because the stylesheet is capped to the
 * byte and a drag state is not worth a utility nothing else uses.
 */
function CheckoutFieldRow({
  field, first, last, mandatory, shown, required, onMove, onShow, onRequire,
}: {
  field: CheckoutField;
  first: boolean;
  last: boolean;
  mandatory: boolean;
  shown: boolean;
  required: boolean;
  onMove: (by: -1 | 1) => void;
  onShow: (on: boolean) => void;
  onRequire: (on: boolean) => void;
}) {
  const name = CHECKOUT_LABEL[field];
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: field,
    // The library announces the grip as «sortable» unless told otherwise — one English word in an Arabic sentence.
    attributes: { roleDescription: 'مقبض ترتيب' },
  });
  return (
    <li
      ref={setNodeRef}
      className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--sys-border)] px-2.5 py-1.5"
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        ...(isDragging
          ? { position: 'relative', zIndex: 1, opacity: 0.85, background: 'var(--sys-card)', boxShadow: 'var(--sys-shadow-overlay)' }
          : null),
      }}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        aria-label={`اسحب «${name}» لتغيير ترتيبه`}
        title="اسحب لتغيير الترتيب"
        style={{ touchAction: 'none', cursor: isDragging ? 'grabbing' : 'grab' }}
        className="min-h-11 min-w-11 md:min-h-0 md:min-w-0 rounded-lg p-1.5 text-[var(--sys-muted-foreground)] hover:bg-[var(--sys-primary-soft)] hover:text-[var(--sys-primary)]"
      >
        <RiDraggable className="h-4 w-4" />
      </button>
      <span
        className={
          shown
            ? 'flex-1 text-xs font-medium text-[var(--sys-foreground)]'
            : 'flex-1 text-xs font-medium text-[var(--sys-muted)] line-through'
        }
      >
        {name}
      </span>
      {/* The label is the hit area — a checkbox draws nothing around itself — and the box keeps its own size. */}
      <label className="flex min-h-11 items-center gap-1.5 text-xs text-[var(--sys-muted-foreground)] md:min-h-0">
        <input
          type="checkbox"
          checked={shown}
          disabled={mandatory}
          onChange={(e) => onShow(e.target.checked)}
          aria-label={`«${name}» يظهر بالنموذج`}
          className="h-3.5 w-3.5 accent-[var(--sys-primary)] disabled:opacity-50"
        />
        يظهر{mandatory && ' (دائماً)'}
      </label>
      <label className="flex min-h-11 items-center gap-1.5 text-xs text-[var(--sys-muted-foreground)] md:min-h-0">
        <input
          type="checkbox"
          checked={required}
          disabled={mandatory || !shown}
          onChange={(e) => onRequire(e.target.checked)}
          aria-label={`«${name}» إلزامي`}
          className="h-3.5 w-3.5 accent-[var(--sys-primary)] disabled:opacity-50"
        />
        إلزامي{mandatory && ' (دائماً)'}
      </label>
      <div className="flex gap-0.5">
        <button
          type="button"
          disabled={first}
          onClick={() => onMove(-1)}
          aria-label={`ارفع «${name}»`}
          className="min-h-11 min-w-11 md:min-h-0 md:min-w-0 rounded-lg px-1.5 text-xs text-[var(--sys-muted-foreground)] hover:bg-[var(--sys-surface-strong)] disabled:opacity-30"
        >
          ↑
        </button>
        <button
          type="button"
          disabled={last}
          onClick={() => onMove(1)}
          aria-label={`انزّل «${name}»`}
          className="min-h-11 min-w-11 md:min-h-0 md:min-w-0 rounded-lg px-1.5 text-xs text-[var(--sys-muted-foreground)] hover:bg-[var(--sys-surface-strong)] disabled:opacity-30"
        >
          ↓
        </button>
      </div>
    </li>
  );
}
