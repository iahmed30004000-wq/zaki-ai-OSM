'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Input';
import { screenApi as crmApi } from '@/lib/screen-api';
import { findMediaUrls, inlineMedia, toDataUrl } from '@/lib/preview-media';
import { buildBehaviorScript, BEHAVIOR_CSS } from '@/lib/landing-dynamic';
import { BlockBuilder } from '@/components/landing-editor/BlockBuilder';
import { HtmlPromptButtons } from '@/components/landing/HtmlPromptButtons';
import { type LandingTheme, DEFAULT_THEME } from '@/lib/landing-theme';
import {
  type LandingSection, parseSections, ensureForm, starterSections, LOCKED_SECTIONS,
} from '@/lib/landing-sections';
import { useHistory } from '@/lib/use-history';
import { RiArchiveLine, RiArrowGoBackLine, RiBookOpenLine, RiArrowGoForwardLine, RiArrowRightLine, RiCodeSLine, RiComputerLine, RiCursorLine, RiEarthLine, RiEyeLine, RiFullscreenExitLine, RiFullscreenLine, RiGiftLine, RiImageLine, RiInputMethodLine, RiLoader4Line, RiPaletteLine, RiPlayListAddLine, RiRefreshLine, RiSaveLine, RiSmartphoneLine, RiTabletLine, RiUpload2Line } from '@remixicon/react';
import { PageHeader } from '@/components/ui/PageHeader';
import { useConfirm } from '@/components/ui/Confirm';
import { publicAddress } from '@/lib/public-address';
import { publishQuestion } from '@/lib/landing-publish';
import type { SellingFamily } from '@/lib/selling-blocks';

/**
 * CUSTOM LANDING PAGE EDITOR — Phase 1
 *
 *   Header:  Back | page name | RiSaveLine Draft | Preview | Publish
 *   LEFT:    Insert toolbar (product/image/button/order form/offers/recommendations)
 *   CENTER:  HTML tab | CSS tab  +  live preview (desktop/tablet/mobile)
 *   RIGHT:   Page settings (width/background/direction/font)
 *
 * Isolation model:
 *  - The live preview iframe uses sandbox="" (NO allow-scripts, NO
 *    allow-same-origin) → the rendered HTML/CSS cannot execute scripts,
 *    cannot touch the dashboard DOM, cookies, localStorage or parent window.
 *  - HTML is sanitized AGAIN on the server at save time (defense in depth).
 *  - Dynamic variables ({{product.name}}...) are a fixed whitelist, resolved
 *    server-side from the DB on the public page — never in the editor.
 */

type Tab = 'html' | 'css';
type Device = 'desktop' | 'tablet' | 'mobile';

const DEVICE_WIDTHS: Record<Device, string> = {
  desktop: '100%',
  tablet: '768px',
  mobile: '390px',
};

// ── Insert snippets (data-zaki-* placeholders — rendered by the public
//    pipeline later; inert in Phase 1 by design) ──
const INSERT_SNIPPETS: { label: string; icon: any; snippet: string }[] = [
  { label: 'المنتج', icon: RiArchiveLine, snippet: '<div data-zaki-product>\n  <h2 class="product-title">{{product.name}}</h2>\n  <img class="product-image" src="{{product.image}}" alt="{{product.name}}">\n  <p class="product-desc">{{product.description}}</p>\n</div>' },
  { label: 'صورة', icon: RiImageLine, snippet: '<img src="https://example.com/image.webp" alt="" class="lp-img">' },
  { label: 'زر الطلب', icon: RiCursorLine, snippet: '<button data-zaki-order class="lp-btn">اطلب الآن</button>' },
  { label: 'نموذج الطلب', icon: RiPlayListAddLine, snippet: '<div data-zaki-order-form></div>' },
  { label: 'العروض', icon: RiGiftLine, snippet: '<div data-zaki-offers></div>' },
  { label: 'منتجات مقترحة', icon: RiArchiveLine, snippet: '<div data-zaki-recommendations></div>' },
];

const VARIABLES = [
  { label: 'اسم المنتج', value: '{{product.name}}' },
  { label: 'اسم المنتج (EN)', value: '{{product.nameEn}}' },
  { label: 'صورة المنتج', value: '{{product.image}}' },
  { label: 'وصف المنتج', value: '{{product.description}}' },
  { label: 'سعر المنتج', value: '{{product.price}}' },
];

const STARTER_HTML = `<div class="zaki-page-wrap hero">
  <span class="tag">عرض خاص</span>
  <h1 class="product-title">{{product.name}}</h1>
  <img class="product-image" src="{{product.image}}" alt="{{product.name}}">
  <p class="product-desc">{{product.description}}</p>
  <div data-zaki-order-form></div>
  <a href="#zaki-order-form" class="lp-btn">اطلب الآن</a>
</div>`;

const STARTER_CSS = `.hero {
  text-align: center;
  padding: 48px 20px;
}
.tag {
  display: inline-block;
  background: #b8256e;
  color: #fff;
  font-size: 12px;
  font-weight: 700;
  padding: 6px 14px;
  border-radius: 99px;
}
.product-title {
  font-size: 42px;
  font-weight: 800;
  margin: 16px 0;
}
.product-image {
  max-width: 100%;
  border-radius: 16px;
}
.product-desc {
  color: #555;
  font-size: 16px;
  line-height: 1.8;
}
.lp-btn {
  display: inline-block;
  background: #b8256e;
  color: #fff;
  font-weight: 700;
  padding: 14px 40px;
  border-radius: 12px;
  text-decoration: none;
  margin-top: 16px;
}`;

/** Client-side quick sanitize for PREVIEW ONLY (the iframe runs with
 *  sandbox="allow-scripts" WITHOUT allow-same-origin — opaque origin: user
 *  markup can never touch the dashboard even in preview. Server sanitizes
 *  again at save). */
function quickSanitize(html: string): string {
  return (html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<\/?script\b[^>]*>/gi, '')
    .replace(/<iframe\b[\s\S]*?(<\/iframe\s*>|\/?>)/gi, '')
    .replace(/<object\b[\s\S]*?<\/object\s*>/gi, '')
    .replace(/<embed\b[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
}

/** Phase 2: preview data for the dynamic placeholders — from THIS page's DB
 *  records via authenticated APIs (product/offers/recommendations). No
 *  secrets are embedded in the srcDoc. */
export interface PreviewData {
  product: { name: string; image: string | null; description: string | null; price: number } | null;
  offers: { id: string; name: string; quantity: number; freeQuantity: number; price: number; isDefault?: boolean }[];
  recommendations: { id: string; name: string; price: number; image: string | null }[];
  currency: string;
}

const escHtml = (v: unknown) =>
  String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Client-side mirror of resolveDynamicPlaceholders (server version is used
 *  on the public page — this preview version renders the SAME blocks from
 *  the page's own DB data). */
function resolvePreviewPlaceholders(html: string, data: PreviewData): string {
  let out = html || '';
  const productBlock = data.product
    ? `<div style="text-align:center;padding:16px 0">` +
      (data.product.image ? `<img src="${escHtml(data.product.image)}" alt="${escHtml(data.product.name)}" style="max-width:100%;border-radius:12px;display:block;margin:0 auto 12px">` : '') +
      (data.product.name ? `<h2 style="margin:8px 0;font-size:26px;font-weight:800">${escHtml(data.product.name)}</h2>` : '') +
      (data.product.description ? `<p style="color:#555;line-height:1.8;margin:8px 0">${escHtml(data.product.description)}</p>` : '') +
      (data.product.price != null ? `<p style="font-size:22px;font-weight:800;margin:8px 0">${escHtml(data.product.price)}</p>` : '') +
      `</div>`
    : '';
  const offersBlock = data.offers.length
    ? `<div style="margin:12px 0">` +
      data.offers
        .map(
          (o) =>
            `<button type="button" data-zaki-offer-id="${escHtml(o.id)}"${o.isDefault ? ' data-zaki-selected="1"' : ''} style="border:1px solid #e5e7eb;border-radius:12px;padding:14px;margin:8px 0;display:block;width:100%;cursor:pointer;text-align:start;background:#fff;font:inherit">` +
            `<span style="display:flex;justify-content:space-between;gap:8px;align-items:center"><span style="font-weight:700">${escHtml(o.name)}</span><span style="font-weight:800;color:#b8256e;white-space:nowrap">${escHtml(o.price)} ${escHtml(data.currency)}</span></span>` +
            `<span style="display:block;color:#697586;font-size:13px;margin-top:4px">${escHtml(o.quantity + (o.freeQuantity > 0 ? ` + ${o.freeQuantity} مجانًا` : ''))}</span>` +
            `</button>`
        )
        .join('') +
      `</div>`
    : '';
  const recsBlock = data.recommendations.length
    ? `<div style="margin:12px 0;text-align:center">` +
      data.recommendations
        .map(
          (r) =>
            `<div style="border:1px solid #e5e7eb;border-radius:12px;padding:14px;display:inline-block;width:150px;vertical-align:top;text-align:center;margin:6px">` +
            (r.image ? `<img src="${escHtml(r.image)}" alt="${escHtml(r.name)}" style="width:100%;border-radius:8px">` : '') +
            `<div style="font-weight:600;font-size:14px;margin-top:6px">${escHtml(r.name)}</div>` +
            `<div style="color:#b8256e;font-weight:800">${escHtml(r.price)} ${escHtml(data.currency)}</div></div>`
        )
        .join('') +
      `</div>`
    : '';
  const formAnchor = `<div id="zaki-order-form-anchor" style="padding:8px 0"></div>`;

  // variables resolved from the same page data
  if (data.product) {
    out = out
      .replace(/\{\{\s*product\.name\s*\}\}/g, escHtml(data.product.name))
      .replace(/\{\{\s*product\.nameEn\s*\}\}/g, escHtml(data.product.name))
      .replace(/\{\{\s*product\.image\s*\}\}/g, escHtml(data.product.image))
      .replace(/\{\{\s*product\.description\s*\}\}/g, escHtml(data.product.description))
      .replace(/\{\{\s*product\.price\s*\}\}/g, escHtml(data.product.price));
  }

  out = out
    .replace(/<([a-zA-Z]+)\b[^>]*\bdata-zaki-product\b[^>]*>[\s\S]*?<\/\1>/gi, productBlock)
    .replace(/<([a-zA-Z]+)\b[^>]*\bdata-zaki-product\b[^>]*\/?>/gi, productBlock)
    .replace(/<([a-zA-Z]+)\b[^>]*\bdata-zaki-offers\b[^>]*>[\s\S]*?<\/\1>/gi, offersBlock)
    .replace(/<([a-zA-Z]+)\b[^>]*\bdata-zaki-offers\b[^>]*\/?>/gi, offersBlock)
    .replace(/<([a-zA-Z]+)\b[^>]*\bdata-zaki-recommendations\b[^>]*>[\s\S]*?<\/\1>/gi, recsBlock)
    .replace(/<([a-zA-Z]+)\b[^>]*\bdata-zaki-recommendations\b[^>]*\/?>/gi, recsBlock)
    .replace(/<([a-zA-Z]+)\b[^>]*\bdata-zaki-order-form\b[^>]*>[\s\S]*?<\/\1>/gi, formAnchor)
    .replace(/<([a-zA-Z]+)\b[^>]*\bdata-zaki-order-form\b[^>]*\/?>/gi, formAnchor);

  // preview interaction: behavior layer (position/styling/actions) — same
  // hard-coded logic as the public page, in preview mode (no real orders)
  const previewScript = buildBehaviorScript(true);

  if (/<\/body>/i.test(out)) out = out.replace(/<\/body>/i, previewScript + '</body>');
  else out += previewScript;
  return out;
}

function buildPreviewDoc(
  html: string,
  css: string,
  settings: any,
  data: PreviewData | null,
  media: Map<string, string>
): string {
  const dir = settings?.direction === 'ltr' ? 'ltr' : 'rtl';
  const bg = typeof settings?.background === 'string' ? settings.background : '#ffffff';
  const ff = settings?.fontFamily ? `font-family:${settings.fontFamily};` : '';
  const wrapMax = settings?.width === 'contained' && settings?.maxWidth ? `.zaki-page-wrap{max-width:${settings.maxWidth}px;margin:0 auto;padding:0 16px;}` : '';
  const body = quickSanitize(html);
  const withData = data ? resolvePreviewPlaceholders(body, data) : body;
  // Stored images cannot be fetched from an opaque origin — inline them.
  const resolved = inlineMedia(withData, media);
  return `<!doctype html><html dir="${dir}" lang="ar"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style id="zaki-behavior-preview-style">${BEHAVIOR_CSS}</style>
<style>body{margin:0;background:${bg};${ff}}${wrapMax}</style>
<style>${inlineMedia(css || '', media)}</style>
</head><body>${resolved}</body></html>`;
}

/** How many lines the gutter must number. Used by the toolbar and the pane. */
const lineCount = (text: string) => text.split('\n').length;

export function LandingPageEditorScreen() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const lpId = params?.id ?? null;

  const [lp, setLp] = useState<any>(null);
  // The store's family, so the builder's preview draws the page as it is published.
  const [family, setFamily] = useState<SellingFamily | null>(null);
  const confirm = useConfirm();
  /**
   * WHAT THE SERVER SAYS ABOUT THIS PAGE'S DRAFT.
   *
   * Not derived from `dirty`: that flag knows whether this tab has typed
   * something, and the question here is whether the DATABASE holds edits a
   * visitor has not seen — which survives a reload, and which a second tab
   * may have created. Every save, publish and revert answers with it.
   */
  const [state, setState] = useState<{ hasUnpublished: boolean; canRevert: boolean }>({
    hasUnpublished: false,
    canRevert: false,
  });
  const [reverting, setReverting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);

  const [html, setHtml] = useState('');
  /** The code editor taking over the screen, only when asked. */
  const [full, setFull] = useState(false);
  const [css, setCss] = useState('');
  const [settings, setSettings] = useState<any>({ width: 'full', background: '#ffffff', direction: 'rtl', fontFamily: '' });

  // ── The block builder, the other way to author this page ──
  const [mode, setMode] = useState<'BLOCKS' | 'HTML'>('HTML');
  const [theme, setTheme] = useState<LandingTheme>(DEFAULT_THEME);
  /**
   * The blocks, with a way back.
   *
   * An editor you cannot undo in makes people cautious — you do not try the
   * bolder colour, you do not delete a block to see how the page reads
   * without it. Caution costs more than any missing feature.
   */
  const history = useHistory<LandingSection[]>([]);
  const sections = history.value;
  const setSections = history.set;

  const [tab, setTab] = useState<Tab>('html');
  const [device, setDevice] = useState<Device>('desktop');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);
  const [varOpen, setVarOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [previewData, setPreviewData] = useState<PreviewData | null>(null);
  /** Stored images, read with the dashboard's session, for the opaque iframe. */
  const [media, setMedia] = useState<Map<string, string>>(new Map());
  const htmlRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  /**
   * The address the question names — one rule, shared with the list and the
   * domain screen: a connected domain is the address only once a real
   * lookup has passed, otherwise /lp/<slug>.
   */
  const addressOf = (page: any) =>
    publicAddress(typeof window === 'undefined' ? '' : window.location.origin, {
      kind: 'lp', slug: page.slug, domain: page.domain, domainVerifiedAt: page.domainVerifiedAt,
    }).url;

  const load = useCallback(async () => {
    if (!lpId) return;
    setLoading(true);
    try {
      const data = await crmApi(`/api/landing-pages/${lpId}`);
      const page = data.landingPage;
      setLp(page);
      setFamily(data.family ?? null);
      // The GET hands back the DRAFT overlaid on the live row, so what loads
      // here is what «نشر التعديلات» would publish — the editor and the
      // publish never show each other different pages.
      setState({ hasUnpublished: Boolean(data.hasUnpublished), canRevert: Boolean(data.canRevert) });
      setHtml(page.htmlContent || STARTER_HTML);
      setCss(page.cssContent || STARTER_CSS);
      if (page.pageSettings) {
        try { setSettings({ width: 'full', background: '#ffffff', direction: 'rtl', fontFamily: '', ...JSON.parse(page.pageSettings) }); } catch {}
      }

      // Block builder state. A page with no blocks yet gets a real starter
      // page rather than a blank canvas — including every page that predates
      // the builder, the moment its owner switches over.
      setMode(page.builderMode === 'BLOCKS' ? 'BLOCKS' : 'HTML');
      if (page.theme) {
        try { setTheme({ ...DEFAULT_THEME, ...JSON.parse(page.theme) }); } catch {}
      }
      // Test what was STORED, not what survives ensureForm — that always
      // returns at least a form, so asking it would hide an empty page
      // behind a single lonely block.
      const stored = parseSections(page.sections);
      // Loading is not an edit: it must not become the first undo step.
      // A form or floating button saved as hidden is shown again: the published page re-enables both, and the
      // editor no longer offers a hide for them — one saved hidden would otherwise sit struck through for ever.
      const shown = stored.map((s) => (LOCKED_SECTIONS.includes(s.type) && !s.enabled ? { ...s, enabled: true } : s));
      history.reset(shown.length ? ensureForm(shown) : starterSections());

      setDirty(false);
      // Phase 2 preview data — this page's own DB records (no secrets)
      setPreviewData({
        product: page.product
          ? { name: page.product.name, image: page.product.image, description: (page.product as any).description ?? null, price: page.product.basePrice }
          : null,
        offers: [],
        recommendations: [],
        currency: page.store?.country?.currencyCode || '',
      });
      // The offers belong to the PRODUCT — the same rows the published page
      // prices from. This asked a per-page route that no longer exists, the
      // 404 was swallowed, and the preview never showed an offer while the
      // published page did.
      //
      // And never the offer after the order: the published page withholds it
      // (`liveOfferWhere`), so a preview that let it be picked drew a page
      // that does not exist — the cheap «زيد علبة» price as the first order's.
      if (page.productId) {
        try {
          const off = await crmApi(`/api/offers?productId=${encodeURIComponent(page.productId)}`);
          setPreviewData((pd) => pd ? {
            ...pd,
            offers: (off.offers || [])
              .filter((o: any) => o.status === 'ACTIVE' && !o.postOrderOffer)
              .map((o: any) => ({ id: o.id, name: o.name, quantity: o.quantity, freeQuantity: o.freeQuantity, price: o.sellingPrice, isDefault: o.isDefault })),
          } : pd);
        } catch {}
      }
      try {
        const recs = await crmApi(`/api/landing-pages/${lpId}/recommendations`);
        setPreviewData((pd) => pd ? { ...pd, recommendations: (recs.recommendations || []).map((r: any) => ({ id: r.id, name: r.product?.name || '', price: r.product?.basePrice ?? 0, image: r.product?.image || null })) } : pd);
      } catch {}
    } catch (e: any) {
      setPageError(e.message || 'تعذر تحميل الصفحة');
    } finally {
      setLoading(false);
    }
  }, [lpId]);

  useEffect(() => { load(); }, [load]);

  /**
   * Ctrl+Z / Ctrl+Shift+Z, and Ctrl+S to save.
   *
   * Ignored while the caret is in a field: Ctrl+Z inside a textarea is the
   * browser's own undo for that text, and stealing it would make typing
   * feel broken to get a feature nobody asked to be global.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      const el = document.activeElement as HTMLElement | null;
      const typing =
        el &&
        (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
      const key = e.key.toLowerCase();
      if (key === 's') {
        e.preventDefault();
        void saveDraft();
        return;
      }
      if (typing) return;
      if (key === 'z' && !e.shiftKey) { e.preventDefault(); history.undo(); }
      else if ((key === 'z' && e.shiftKey) || key === 'y') { e.preventDefault(); history.redo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Live preview: debounced rebuild. The iframe is sandbox="allow-scripts"
  // WITHOUT allow-same-origin — opaque origin: scripts (ours + user markup
  // stripped of them) cannot touch the dashboard DOM, cookies or storage.
  const previewDoc = useMemo(
    () => buildPreviewDoc(html, css, settings, previewData, media),
    [html, css, settings, previewData, media]
  );

  /**
   * Read the stored images the preview needs.
   *
   * The iframe has an opaque origin, so it sends no cookies and every
   * /api/media URL comes back 401 — a broken image the seller reads as a
   * failed upload. The dashboard has the session, so it fetches them here
   * and the preview shows them inline. Cached per URL: the preview rebuilds
   * on every keystroke.
   */
  useEffect(() => {
    // Joined with a space, not concatenated: two URLs run together read as
    // ONE impossible path, which is silently fetched and silently fails.
    const wanted = findMediaUrls(
      [
        html,
        previewData?.product?.image ?? '',
        ...(previewData?.recommendations ?? []).map((r) => r.image ?? ''),
        lp?.product?.image ?? '',
      ].join(' '),
      css
    );
    const missing = wanted.filter((u) => !media.has(u));
    if (missing.length === 0) return;
    let live = true;
    void Promise.all(missing.map(async (u) => [u, await toDataUrl(u)] as const)).then((pairs) => {
      if (!live) return;
      const found = pairs.filter((p): p is [string, string] => Boolean(p[1]));
      if (found.length === 0) return;
      setMedia((prev) => new Map([...prev, ...found]));
    });
    return () => { live = false; };
  }, [html, css, previewData, lp, media]);
  useEffect(() => {
    const t = setTimeout(() => setPreviewKey((k) => k + 1), 400);
    return () => clearTimeout(t);
  }, [previewDoc]);

  const insertAtCursor = (snippet: string) => {
    if (tab === 'css') setTab('html');
    // wait a tick if switching tabs — textarea must be mounted
    requestAnimationFrame(() => {
      const el = htmlRef.current;
      if (!el) { setHtml((h) => h + '\n' + snippet); setDirty(true); return; }
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? el.value.length;
      const next = el.value.slice(0, start) + snippet + el.value.slice(end);
      setHtml(next);
      setDirty(true);
      requestAnimationFrame(() => {
        el.focus();
        const pos = start + snippet.length;
        el.setSelectionRange(pos, pos);
      });
    });
  };

  // Both authoring modes are saved on every save. Switching modes must never
  // be the thing that loses the other mode's work: the HTML stays on the row
  // while the blocks are being built, and the blocks stay while the HTML is.
  const contentPayload = () =>
    JSON.stringify({ html, css, settings, builderMode: mode, theme, sections });

  const saveDraft = async () => {
    if (!lpId) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      const d = await crmApi(`/api/landing-pages/${lpId}/content`, {
        method: 'PUT',
        body: contentPayload(),
      });
      // The SERVER says where the write landed. A live page got a draft and
      // «نشر التعديلات» must appear; an unpublished one was written straight
      // through and there is nothing to publish separately.
      setState((prev) => ({ ...prev, hasUnpublished: Boolean(d?.hasUnpublished) }));
      setSaveMsg({
        ok: true,
        text: d?.hasUnpublished ? 'حُفظت المسودة — لم يرها الزوّار بعد' : 'تم الحفظ',
      });
      setDirty(false);
    } catch (e: any) {
      setSaveMsg({ ok: false, text: e.message || 'تعذر الحفظ' });
    } finally {
      setSaving(false);
    }
  };

  const togglePublish = async () => {
    if (!lp) return;
    const publishing = !lp.isPublished;
    /**
     * ASKED BEFORE, NOT REPORTED AFTER.
     *
     * Both directions, and the words differ because the consequences do —
     * see src/lib/landing-publish.ts. The unsaved flag matters only here:
     * publishing writes the editor first, so this press can publish edits
     * the seller had not decided to publish, and the question says so.
     */
    const ok = await confirm(publishQuestion(publishing, addressOf(lp), publishing && dirty));
    if (!ok) return;

    setPublishing(true);
    setSaveMsg(null);
    try {
      // Publishing saves first — the published page must be the latest draft.
      // Unpublishing does NOT: saving a live page puts the draft in front of
      // customers, and when the unpublish is then refused (a store's front
      // page while the store is open) the seller has published by accident.
      if (publishing) {
        await crmApi(`/api/landing-pages/${lpId}/content`, { method: 'PUT', body: contentPayload() });
      }
      await crmApi(`/api/landing-pages/${lpId}`, { method: 'PATCH', body: JSON.stringify({ isPublished: publishing }) });
      setLp({ ...lp, isPublished: publishing });
      if (publishing) {
        setDirty(false);
        // Publishing promoted whatever draft there was and recorded a step
        // back; the editor must stop offering to publish it again.
        setState({ hasUnpublished: false, canRevert: true });
      }
      setSaveMsg({ ok: true, text: !lp.isPublished ? 'تم نشر الصفحة' : 'تم إلغاء النشر' });
    } catch (e: any) {
      setSaveMsg({ ok: false, text: e.message || 'تعذر النشر' });
    } finally {
      setPublishing(false);
    }
  };

  /**
   * PUT THE SAVED DRAFT IN FRONT OF VISITORS.
   *
   * It saves first — the thing published must be what is on the screen, not
   * what was on it at the last press — and the question says so, exactly as
   * the publish toggle's does.
   */
  const publishEdits = async () => {
    if (!lp) return;
    if (!(await confirm(publishQuestion(true, addressOf(lp), dirty)))) return;

    setPublishing(true);
    setSaveMsg(null);
    try {
      if (dirty) {
        await crmApi(`/api/landing-pages/${lpId}/content`, { method: 'PUT', body: contentPayload() });
      }
      const d = await crmApi(`/api/landing-pages/${lpId}/content`, { method: 'POST' });
      setState({ hasUnpublished: Boolean(d.hasUnpublished), canRevert: Boolean(d.canRevert) });
      setDirty(false);
      setSaveMsg({ ok: true, text: d.message || 'نُشرت التعديلات' });
    } catch (e: any) {
      setSaveMsg({ ok: false, text: e.message || 'تعذر نشر التعديلات' });
    } finally {
      setPublishing(false);
    }
  };

  /**
   * ONE STEP BACK.
   *
   * The whole editor is reloaded afterwards rather than patched in place:
   * the page that is live has changed under it, and a screen showing the
   * version that was just withdrawn would publish it again on the next save.
   */
  const revertToPrevious = async () => {
    if (!lp) return;
    const ok = await confirm({
      title: 'الرجوع للنسخة السابقة؟',
      body: 'تعود الصفحة إلى ما كانت عليه قبل آخر نشر، ويصبح ما تسحبه الآن هو خطوة الرجوع التالية — فالضغطة مرّةً أخرى تُعيدك. وما في المحرّر غير محفوظ سيضيع.',
      confirmLabel: 'ارجع',
      tone: 'danger',
    });
    if (!ok) return;

    setReverting(true);
    setSaveMsg(null);
    try {
      const d = await crmApi(`/api/landing-pages/${lpId}/content`, { method: 'PATCH' });
      setDirty(false);
      setSaveMsg({ ok: true, text: d.message || 'رجعت الصفحة للنسخة السابقة' });
      await load();
    } catch (e: any) {
      setSaveMsg({ ok: false, text: e.message || 'تعذر الرجوع' });
    } finally {
      setReverting(false);
    }
  };

  /** Uploads and returns the stored URLs — the one upload path both modes use. */
  const uploadFiles = async (files: FileList): Promise<string[]> => {
    if (!lpId || files.length === 0) return [];
    setUploading(true);
    setSaveMsg(null);
    try {
      const fd = new FormData();
      Array.from(files).slice(0, 5).forEach((f) => fd.append('files', f));
      const res = await fetch(`/api/landing-pages/${lpId}/image`, { method: 'POST', body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return (data.urls as string[]) || [];
    } catch (e: any) {
      setSaveMsg({ ok: false, text: e.message || 'تعذر رفع الصور' });
      return [];
    } finally {
      setUploading(false);
      if (imageInputRef.current) imageInputRef.current.value = '';
    }
  };

  const uploadImages = async (files: FileList) => {
    try {
      const urls = await uploadFiles(files);
      if (urls.length > 0) {
        const imgTag = urls.map((u) => `<img src="${u}" alt="">`).join('\n');
        insertAtCursor(imgTag);
        setSaveMsg({ ok: true, text: `تم رفع ${urls.length} صورة وإدراجها` });
        setDirty(true);
      }
    } catch (e: any) {
      setSaveMsg({ ok: false, text: e.message || 'تعذر رفع الصور' });
    }
  };

  // Tab key inside the editors inserts spaces (editor UX basic)
  const handleTabKey = (e: React.KeyboardEvent<HTMLTextAreaElement>, setter: (f: (v: string) => string) => void) => {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const el = e.currentTarget;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    setter((v) => v.slice(0, start) + '  ' + v.slice(end));
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = start + 2;
    });
  };

  const lineCount = (text: string) => text.split('\n').length;

  if (loading) {
    return (
      <>
        <div className="flex h-[60vh] items-center justify-center text-sm text-[var(--sys-muted-foreground)]">
          <RiLoader4Line className="h-5 w-5 animate-spin" /> جارٍ تحميل المحرر...
        </div>
      </>
    );
  }
  if (pageError || !lp) {
    return (
      <>
        <div className="p-10 text-center text-sm text-[var(--sys-destructive)]">{pageError || 'صفحة الهبوط غير موجودة'}</div>
      </>
    );
  }

  return (
    <>
      <div className="flex flex-col" dir="rtl">
        {/* ─── Header ─── */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--sys-border)] bg-[var(--sys-card)] px-4 py-3">
          <div className="flex items-center gap-3">
            <Button variant="secondary" size="sm" onClick={() => router.push(`/store/landing-pages/${lp.id}`)}>
              <RiArrowRightLine className="icon-mirror h-4 w-4" /> Landing Pages
            </Button>
            <PageHeader title={`/lp/${lp.slug}`}
        />
            <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${lp.isPublished ? 'bg-[var(--sys-success-soft)] text-[var(--sys-success)]' : 'bg-[var(--sys-warning-soft)] text-[var(--sys-warning)]'}`}>
              {lp.isPublished ? 'منشورة' : 'مسودة'}
            </span>
            {dirty && (
              <span className="inline-flex items-center gap-1.5 text-xs text-[var(--sys-warning)]">
                {/* A drawn dot, not the character «●» — that one arrives at
                    whatever size and weight the device's font gives it. */}
                <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--sys-warning)]" aria-hidden />
                تغييرات غير محفوظة
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* Which way this page is authored. Both are kept on the row, so
                switching is a view change, not a loss. */}
            <div className="flex rounded-lg border border-[var(--sys-border)] p-0.5">
              {([['BLOCKS', 'مصمّم البلوكات'], ['HTML', 'HTML']] as const).map(([m, label]) => (
                <button
                  key={m}
                  onClick={() => { setMode(m); setDirty(true); }}
                  className={`min-h-11 md:min-h-0 inline-flex items-center cursor-pointer rounded-md px-2.5 py-1 text-xs font-bold transition ${
                    mode === m ? 'bg-[var(--sys-primary)] text-white' : 'text-[var(--sys-muted-foreground)] hover:text-[var(--sys-primary)]'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            {/* A way back, beside the way forward. Only in the block
                designer: the HTML editor is a textarea, and the browser
                already gives a textarea its own undo. */}
            {mode === 'BLOCKS' && (
              <div className="flex rounded-lg border border-[var(--sys-border)] p-0.5">
                <button aria-label="تراجع"
                  onClick={history.undo}
                  disabled={!history.canUndo}
                  title="تراجع — Ctrl+Z"
                  className="min-h-11 min-w-11 md:min-h-0 md:min-w-0 cursor-pointer rounded-md p-1.5 text-[var(--sys-muted-foreground)] hover:text-[var(--sys-primary)] disabled:cursor-default disabled:opacity-30"
                >
                  <RiArrowGoBackLine className="icon-mirror h-4 w-4" />
                </button>
                <button aria-label="إعادة"
                  onClick={history.redo}
                  disabled={!history.canRedo}
                  title="إعادة — Ctrl+Shift+Z"
                  className="min-h-11 min-w-11 md:min-h-0 md:min-w-0 cursor-pointer rounded-md p-1.5 text-[var(--sys-muted-foreground)] hover:text-[var(--sys-primary)] disabled:cursor-default disabled:opacity-30"
                >
                  <RiArrowGoForwardLine className="icon-mirror h-4 w-4" />
                </button>
              </div>
            )}
            {saveMsg && <span className={`text-xs ${saveMsg.ok ? 'text-[var(--sys-success)]' : 'text-[var(--sys-destructive)]'}`}>{saveMsg.text}</span>}
            {/*
              THE WORD ON THE BUTTON IS NOW TRUE.

              On a published page this saves a DRAFT — nothing a visitor can
              reach changes — and that is why the label can say so. Before
              `contentDraft` existed, the same press put a half-written
              headline in front of every click the advert was paying for.
            */}
            <Button variant="outline" size="sm" onClick={saveDraft} disabled={saving}>
              {saving ? <RiLoader4Line className="h-4 w-4 animate-spin" /> : <RiSaveLine className="h-4 w-4" />}
              {lp.isPublished ? 'حفظ كمسودة' : 'حفظ'}
            </Button>
            {/* A preview, not a visit: opened with the signed preview token, so
                it loads no pixel and counts no view — the published address
                reported the seller's own check to their ad account. The tab
                is opened inside the click so no popup blocker stops it. */}
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                const win = window.open('about:blank', '_blank');
                if (win) win.opener = null;
                try {
                  const data = await crmApi(`/api/landing-pages/${lpId}/preview-token`, { method: 'POST' });
                  if (win) win.location.href = data.previewPath;
                } catch {
                  win?.close();
                }
              }}
            >
              <RiEyeLine className="h-4 w-4" /> معاينة
            </Button>
            {/*
              «نشر التعديلات» — THE ACT A LIVE PAGE ACTUALLY NEEDS.

              The toggle beside it says «إلغاء النشر» for a page that is
              already live, so until this button existed a seller with a saved
              draft had no way to put it in front of anyone: the only press
              that promoted a draft was the one that made an unpublished page
              live, which this page is not.
            */}
            {lp.isPublished && state.hasUnpublished && (
              <Button variant="success" size="sm" onClick={publishEdits} disabled={publishing}>
                {publishing ? <RiLoader4Line className="h-4 w-4 animate-spin" /> : <RiEarthLine className="h-4 w-4" />}
                نشر التعديلات
              </Button>
            )}
            <Button variant={lp.isPublished ? 'outline' : 'success'} size="sm" onClick={togglePublish} disabled={publishing}>
              {publishing ? <RiLoader4Line className="h-4 w-4 animate-spin" /> : <RiEarthLine className="h-4 w-4" />}
              {lp.isPublished ? 'إلغاء النشر' : 'نشر'}
            </Button>
            {/*
              ONE STEP BACK, IN ONE PRESS — and it asks, because a visitor
              feels it. Shown only when there is a step to take: a disabled
              button here would promise a history this page does not keep.
            */}
            {state.canRevert && (
              <Button variant="ghost" size="sm" onClick={revertToPrevious} disabled={reverting}>
                {reverting ? <RiLoader4Line className="h-4 w-4 animate-spin" /> : <RiArchiveLine className="h-4 w-4" />}
                النسخة السابقة
              </Button>
            )}
          </div>
        </div>

        {mode === 'BLOCKS' ? (
          <BlockBuilder
            theme={theme}
            sections={sections}
            onTheme={(t) => { setTheme(t); setDirty(true); }}
            onSections={(s) => { setSections(s); setDirty(true); }}
            onUpload={uploadFiles}
            product={lp.product ? { name: lp.product.name, price: lp.product.basePrice } : null}
            // The copy assistant's brief is about THIS product, so the panel
            // inside the builder is offered only when the page has one. It
            // proposes words for the blocks that are already there and never
            // rearranges them — see AiCopyPanel.
            productId={lp.product?.id ?? lp.productId ?? null}
            pageId={lpId}
            store={lp.store ? { name: lp.store.name, logo: lp.store.logo ?? null, phone: lp.store.supportPhone ?? null } : null}
            currency={previewData?.currency || 'USD'}
            offers={previewData?.offers || []}
            family={family}
          />
        ) : (
        /* ─── 3-column workspace ─── */
        <div className="flex flex-1 flex-col gap-3 bg-[var(--sys-surface)] p-3 lg:grid lg:grid-cols-[1fr_300px] lg:items-start">
          {/* RIGHT COLUMN (second on a phone): the tools, folded away. */}
          <div className="order-2 space-y-3 rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] p-3 lg:order-2">
            <div>
              <p className="mb-1.5 text-xs font-semibold text-[var(--sys-muted-foreground)]">
                اكتب الـHTML بالذكاء الاصطناعي
              </p>
              <p className="mb-2 text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
                هذا البرومبت يشرح كل قيود النظام — ما يُحذف عند الحفظ، وكيف تربط
                الأزرار بنموذج الطلب الحقيقي. الصقه في أي مساعد ذكاء اصطناعي.
              </p>
              <HtmlPromptButtons />
            </div>

            <p className="mb-2 mt-4 text-xs font-semibold text-[var(--sys-muted-foreground)]">إدراج</p>
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-1">
              {INSERT_SNIPPETS.map((item) => (
                <button
                  key={item.label}
                  onClick={() => insertAtCursor(item.snippet)}
                  className="flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--sys-border)] px-2.5 py-2 text-xs font-medium text-[var(--sys-foreground)] transition-colors hover:border-[var(--sys-primary)]/40 hover:bg-[var(--sys-primary-soft)]"
                >
                  <item.icon className="h-3.5 w-3.5 text-[var(--sys-primary)]" /> {item.label}
                </button>
              ))}
            </div>

            <p className="mb-2 mt-4 text-xs font-semibold text-[var(--sys-muted-foreground)]">متغيرات</p>
            <div className="relative">
              <Button variant="outline" size="sm" className="w-full" onClick={() => setVarOpen((v) => !v)}>
                <RiInputMethodLine className="h-4 w-4" /> إدراج متغير
              </Button>
              {varOpen && (
                <div className="absolute z-10 mt-1 w-full rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] py-1 shadow-overlay">
                  {VARIABLES.map((v) => (
                    <button
                      key={v.value}
                      className="min-h-11 md:min-h-0 inline-flex items-center block w-full cursor-pointer px-3 py-1.5 text-right text-xs text-[var(--sys-foreground)] hover:bg-[var(--sys-surface)]"
                      onClick={() => { insertAtCursor(v.value); setVarOpen(false); }}
                    >
                      {v.label} <span className="font-mono text-xs text-[var(--sys-muted)]" dir="ltr">{v.value}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <p className="mb-2 mt-4 text-xs font-semibold text-[var(--sys-muted-foreground)]">الصور</p>
            <input
              ref={imageInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              multiple
              className="hidden"
              onChange={(e) => e.target.files && uploadImages(e.target.files)}
            />
            <Button variant="outline" size="sm" className="w-full" onClick={() => imageInputRef.current?.click()} disabled={uploading}>
              {uploading ? <RiLoader4Line className="h-4 w-4 animate-spin" /> : <RiUpload2Line className="h-4 w-4" />} رفع صورة
            </Button>

            {/* ─── Zaki Actions documentation ─── */}
            <details className="mt-4 rounded-lg border border-[var(--sys-border)] bg-[var(--sys-surface)] p-2.5">
              <summary className="cursor-pointer text-xs font-bold text-[var(--sys-foreground)]"><RiBookOpenLine className="me-1 inline-block h-4 w-4 align-text-bottom" aria-hidden />توثيق Zaki Actions</summary>
              <div className="mt-2 space-y-3 text-xs leading-relaxed text-[var(--sys-muted-foreground)]" dir="ltr">
                <div>
                  <p className="font-bold text-[var(--sys-foreground)]">Actions</p>
                  <pre className="mt-1 whitespace-pre-wrap break-all rounded-lg bg-[var(--sys-heading)] p-2 font-mono text-xs text-[var(--sys-foreground)]">{`<button data-zaki-action="order">
  اطلب الآن
</button>
<button data-zaki-action="scroll-order">…</button>
<button data-zaki-action="offer"
  data-zaki-offer="OFFER_ID">…</button>`}</pre>
                  <p>open/scroll → Trusted OrderForm (لا ينفّذ الطلب مباشرة). offer → يتحقق السيرفر من الـ id ضد عروض الصفحة.</p>
                </div>
                <div>
                  <p className="font-bold text-[var(--sys-foreground)]">Fixed Button</p>
                  <pre className="mt-1 whitespace-pre-wrap break-all rounded-lg bg-[var(--sys-heading)] p-2 font-mono text-xs text-[var(--sys-foreground)]">{`data-zaki-position="fixed-bottom"
  | "fixed-top" | "floating"`}</pre>
                  <p>position فقط — لا لون ولا خط إلا إن طلبتها.</p>
                </div>
                <div>
                  <p className="font-bold text-[var(--sys-foreground)]">Styling (اختياري)</p>
                  <pre className="mt-1 whitespace-pre-wrap break-all rounded-lg bg-[var(--sys-heading)] p-2 font-mono text-xs text-[var(--sys-foreground)]">{`data-zaki-bg="#16a34a"
data-zaki-color="#fff"
data-zaki-font-size="20px"
data-zaki-font-weight="700"
data-zaki-radius="14px"
data-zaki-width="90%"
data-zaki-padding="16px 24px"
data-zaki-shadow="0 8px 30px rgba(0,0,0,.2)"
data-zaki-bottom="20px"
data-zaki-z-index="9999"`}</pre>
                  <p>قيم غير آمنة (javascript:, url(), …) تُتجاهل تلقائيًا.</p>
                </div>
                <div>
                  <p className="font-bold text-[var(--sys-foreground)]">Placeholders</p>
                  <pre className="mt-1 whitespace-pre-wrap break-all rounded-lg bg-[var(--sys-heading)] p-2 font-mono text-xs text-[var(--sys-foreground)]">{`<div data-zaki-product></div>
<div data-zaki-offers></div>
<div data-zaki-recommendations></div>
<div data-zaki-order-form></div>
{{product.name}} {{product.image}}
{{product.description}} {{product.price}}`}</pre>
                  <p>كل القيم من قاعدة البيانات (escaped) — HTML لا يحدد السعر أو المنتج.</p>
                </div>
              </div>
            </details>
            <p className="mt-3 text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
              العناصر المدرجة هي placeholders — تُحوَّل للعناصر الحقيقية في الصفحة المنشورة. نموذج الطلب الموثوق يعمل خارج HTML المخصص دائمًا.
            </p>
          </div>

          {/* The code and the preview, with the whole width to themselves. */}
          <div className="order-1 flex min-w-0 flex-col gap-3 lg:order-1">
            {/* Code editors */}
            <div className="overflow-hidden rounded-lg border border-[var(--sys-border)]">
              <div className="flex items-center gap-1 border-b border-[var(--sys-border)] bg-[var(--sys-heading)] px-2 py-1.5">
                <button
                  onClick={() => setTab('html')}
                  className={`min-h-11 md:min-h-0 inline-flex items-center flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1 text-xs font-semibold ${tab === 'html' ? 'bg-[var(--sys-surface-strong)] text-[var(--sys-heading)]' : 'text-[var(--sys-muted-foreground)] hover:text-[var(--sys-heading)]'}`}
                >
                  <RiCodeSLine className="h-4 w-4" /> HTML
                </button>
                <button
                  onClick={() => setTab('css')}
                  className={`min-h-11 md:min-h-0 inline-flex items-center flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1 text-xs font-semibold ${tab === 'css' ? 'bg-[var(--sys-surface-strong)] text-[var(--sys-heading)]' : 'text-[var(--sys-muted-foreground)] hover:text-[var(--sys-heading)]'}`}
                >
                  <RiPaletteLine className="h-4 w-4" /> CSS
                </button>
                <span className="mr-auto text-xs text-[var(--sys-muted-foreground)]">{tab === 'html' ? `${lineCount(html)} سطر` : `${lineCount(css)} سطر`}</span>
                {/* The editor starts small and grows when asked. A code box
                    that owns the screen by default hides the preview, which
                    is the thing you are actually editing against. */}
                <button
                  onClick={() => setFull((f) => !f)}
                  title={full ? 'تصغير المحرر' : 'ملء الشاشة'}
                  className="min-h-11 min-w-11 md:min-h-0 md:min-w-0 cursor-pointer rounded-lg p-1 text-[var(--sys-muted-foreground)] hover:text-[var(--sys-heading)]"
                >
                  {full ? <RiFullscreenExitLine className="h-4 w-4" /> : <RiFullscreenLine className="h-4 w-4" />}
                </button>
              </div>
              {tab === 'html' ? (
                <CodePane
                  textRef={htmlRef}
                  value={html}
                  onChange={(v) => { setHtml(v); setDirty(true); }}
                  onKeyDown={(e) => handleTabKey(e, setHtml)}
                  full={full}
                />
              ) : (
                <CodePane
                  value={css}
                  onChange={(v) => { setCss(v); setDirty(true); }}
                  onKeyDown={(e) => handleTabKey(e, setCss)}
                  full={full}
                />
              )}
            </div>

            {/* Live preview */}
            <div // White on purpose: this is the PREVIEW of the seller's page, and
              // their page is white. A dashboard token here would be the
              // same mistake as a dashboard colour on their live page.
              className="flex min-h-[420px] flex-1 flex-col overflow-hidden rounded-lg border border-[var(--sys-border)] bg-white">
              <div className="flex items-center justify-between border-b border-[var(--sys-border)] px-3 py-2">
                <span className="text-xs font-semibold text-[var(--sys-foreground)]">معاينة مباشرة</span>
                <div className="flex items-center gap-1">
                  {([
                    ['desktop', RiComputerLine], ['tablet', RiTabletLine], ['mobile', RiSmartphoneLine],
                  ] as [Device, any][]).map(([d, Icon]) => (
                    <button
                      key={d}
                      onClick={() => setDevice(d)}
                      title={d}
                      className={`min-h-11 min-w-11 md:min-h-0 md:min-w-0 cursor-pointer rounded-lg p-1.5 ${device === d ? 'bg-[var(--sys-primary-soft)] text-[var(--sys-primary)]' : 'text-[var(--sys-muted-foreground)] hover:bg-[var(--sys-surface)]'}`}
                    >
                      <Icon className="h-4 w-4" />
                    </button>
                  ))}
                  {/* «تحديث» is the refresh this product draws fifteen other times.
                      The eye is its «معاينة», and it is on the button above. */}
                  <Button variant="ghost" size="sm" onClick={() => setPreviewKey((k) => k + 1)} title="تحديث">
                    <RiRefreshLine className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <div className="flex flex-1 justify-center overflow-auto bg-[var(--sys-surface-strong)] p-3">
                {/* sandbox="allow-scripts" WITHOUT allow-same-origin → opaque
                    origin: preview scripts run but can never touch the
                    dashboard DOM, cookies, localStorage or parent window */}
                <iframe
                  key={previewKey}
                  title="معاينة الصفحة"
                  sandbox="allow-scripts"
                  srcDoc={previewDoc}
                  className="h-full min-h-[400px] rounded-lg border border-[var(--sys-border)] bg-white shadow-raised"
                  style={{ width: DEVICE_WIDTHS[device], maxWidth: '100%' }}
                />
              </div>
            </div>
          </div>

          {/* Page settings — beneath the tools, same column. */}
          <div className="order-3 rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] p-4 lg:order-3">
            <p className="mb-3 text-xs font-semibold text-[var(--sys-muted-foreground)]">إعدادات الصفحة</p>
            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-xs font-semibold text-[var(--sys-foreground)]">عرض الصفحة</label>
                <Select value={settings.width} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => { setSettings({ ...settings, width: e.target.value }); setDirty(true); }} className="text-xs">
                  <option value="full">ملء الشاشة</option>
                  <option value="contained">عرض محدود</option>
                </Select>
              </div>
              {settings.width === 'contained' && (
                <div>
                  <label className="mb-1 block text-xs font-semibold text-[var(--sys-foreground)]">أقصى عرض (px)</label>
                  <Input
                    type="number" min="320" max="1920" dir="ltr"
                    value={settings.maxWidth ?? 960}
                    onChange={(e) => { setSettings({ ...settings, maxWidth: Number(e.target.value) }); setDirty(true); }}
                    className="text-xs"
                  />
                </div>
              )}
              <div>
                <label className="mb-1 block text-xs font-semibold text-[var(--sys-foreground)]">لون الخلفية</label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={settings.background || '#ffffff'}
                    onChange={(e) => { setSettings({ ...settings, background: e.target.value }); setDirty(true); }}
                    className="h-11 md:h-8 w-10 cursor-pointer rounded-lg border border-[var(--sys-border)]"
                  />
                  <Input
                    dir="ltr"
                    value={settings.background || '#ffffff'}
                    onChange={(e) => { setSettings({ ...settings, background: e.target.value }); setDirty(true); }}
                    className="font-mono text-xs"
                  />
                </div>
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-[var(--sys-foreground)]">اتجاه النص</label>
                <Select value={settings.direction} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => { setSettings({ ...settings, direction: e.target.value }); setDirty(true); }} className="text-xs">
                  <option value="rtl">RTL (عربي)</option>
                  <option value="ltr">LTR (إنجليزي)</option>
                </Select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-[var(--sys-foreground)]">الخط الافتراضي</label>
                <Select value={settings.fontFamily || ''} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => { setSettings({ ...settings, fontFamily: e.target.value }); setDirty(true); }} className="text-xs">
                  <option value="">النظام الافتراضي</option>
                  <option value="'Tajawal', sans-serif">Tajawal</option>
                  <option value="system-ui, sans-serif">System UI</option>
                  <option value="Georgia, serif">Georgia</option>
                </Select>
              </div>
              <p className="text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
                الإعدادات تُطبَّق كأنماط أساسية — CSS المخصص لك يتجاوزها دائمًا عند التعارض.
              </p>
            </div>

            {/* ─── Tracking (centralized in Settings) ─── */}
            <div className="mt-6 border-t border-[var(--sys-border)] pt-4">
              <p className="mb-2 text-xs font-semibold text-[var(--sys-muted-foreground)]">التتبع والإعلانات</p>
              <p className="text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
                أكواد التتبع (Meta / TikTok / Snapchat / Google) تُدار في مكان واحد لكل صفحاتك.
              </p>
              <a
                href="/settings/tracking"
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-flex items-center gap-1 rounded-lg bg-[var(--sys-primary)] px-3 py-1.5 text-xs font-bold text-white transition hover:bg-[var(--sys-primary-hover)]"
              >
                إدارة البكسلات من الإعدادات ←
              </a>
            </div>
          </div>
        </div>
        )}
      </div>
    </>
  );
}

/**
 * ONE CODE PANE, used for both HTML and CSS.
 *
 * There were two copies, identical but for which state they wrote to — and
 * both carried the same defect: the line numbers were a separate column
 * that did not scroll with the text, so past the first screenful every
 * number pointed at the wrong line. That is worse than no numbers.
 *
 * It starts SMALL. A code box that owns the page by default hides the live
 * preview, which is the thing you are editing against. It can be dragged
 * taller, and made full screen when the file is long enough to deserve it.
 *
 * "Starts small" had one hole in it, and it was the numbers. The gutter
 * had no height of its own, so it drew every line at full size and the
 * flex row took ITS height: a four-hundred-line page made the pane eight
 * thousand pixels tall inside a seven-hundred-pixel window, and the
 * textarea sat at its correct 160px in the corner of it. Dragging the
 * textarea taller did not help either — only the textarea moved, and the
 * numbers stayed where they were.
 *
 * So the HEIGHT belongs to the pane, and both columns fill it. One box to
 * drag, one height to be wrong about, and the numbers cannot come adrift
 * from the lines they number.
 */
function CodePane({
  value,
  onChange,
  onKeyDown,
  full,
  textRef,
}: {
  value: string;
  onChange: (v: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  full: boolean;
  textRef?: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const gutter = React.useRef<HTMLDivElement>(null);
  const lines = lineCount(value);

  return (
    <div
      dir="ltr"
      // The pane is the thing that resizes, and `overflow-hidden` is what
      // makes a div resizable at all. Full screen turns the handle off:
      // dragging something that is already the height of the window only
      // produces a box taller than the window.
      className={`flex overflow-hidden bg-[var(--sys-heading)] ${full ? '' : 'resize-y'}`}
      style={full ? { height: 'calc(100vh - 14rem)' } : { height: '10rem', minHeight: '6rem' }}
    >
      <div
        ref={gutter}
        className="h-full shrink-0 select-none overflow-hidden border-l border-[var(--sys-border)] bg-[var(--sys-background)] px-2 py-3 text-right font-mono text-xs leading-5 text-[var(--sys-muted-foreground)]"
      >
        {Array.from({ length: lines }, (_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      <textarea
        ref={textRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        // Keep the numbers beside the line they number.
        onScroll={(e) => {
          if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop;
        }}
        spellCheck={false}
        // No handle of its own: two resize handles on one box is two
        // heights that disagree, which is how the numbers came adrift.
        className="h-full w-full resize-none bg-[var(--sys-heading)] p-3 font-mono text-xs leading-5 text-[var(--sys-foreground)] outline-none" 
      />
    </div>
  );
}
