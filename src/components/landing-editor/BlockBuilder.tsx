'use client';

import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Eye, EyeOff, Trash2, Plus, Minus, Upload, Loader2, GripVertical,
  Monitor, Smartphone, X, LayoutTemplate, AlertTriangle, Wrench,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { cssString } from '@/lib/fonts/css-string';
import { LookControls } from '@/components/landing/blocks/LookControls';
import { useInlineEdit } from '@/components/landing/blocks/useInlineEdit';
import { Input } from '@/components/ui/Input';
import {
  type LandingSection, type SectionType,
  SECTION_LABEL, SECTION_HINT, SINGLETON, LOCKED_SECTIONS, newSection,
} from '@/lib/landing-sections';
import {
  type LandingTheme, type FontValue, DEFAULT_THEME, MOODS, FONTS, paletteFor, paletteVars, isValidHex,
} from '@/lib/landing-theme';
import { PageBlocks } from '@/components/landing/blocks/PageBlocks';
import { FormPlaceholder } from '@/components/landing/blocks/FormPlaceholder';
import { BLOCK_CSS_WITH_DEV_FONTS, fontHref, specimenHref } from '@/components/landing/blocks/styles';
import { FontUploader, type StoreFontRow } from '@/components/landing/blocks/FontUploader';
import { SelectionBar } from './SelectionBar';
import { Advanced } from './Advanced';
import { AiCopyPanel } from './AiCopyPanel';
import { AfterOrderPanel, type AfterOrderContext } from './AfterOrderPanel';
import { PaneToggle, editPaneClass, previewPaneClass, type EditorPane } from './EditorPanes';
import { PAGE_TEMPLATES, buildTemplate } from '@/lib/page-templates';
import { useConfirm } from '@/components/ui/Confirm';
import { sanitizeRich } from '@/lib/rich-text';
import {
  COUNTDOWN_SOURCES, COUNTDOWN_SOURCE_LABEL, VISITOR_TIMER_FIX, VISITOR_TIMER_WARNING,
} from '@/lib/countdown';
// `@/lib/reviews` and NOT `@/lib/product-reviews`: this is a client
// component, and the service half of that pair imports Prisma.
import { MANUAL_SOURCES, REVIEW_SOURCE_LABEL } from '@/lib/reviews';
import type { SellingFamily } from '@/lib/selling-blocks';
import { lookForType } from '@/lib/block-look';
// Where the form's fields come from — a link to the store's «الدفع» for whoever may open it, words for anybody else.
import { StoreCheckoutNote } from './StoreCheckoutNote';

/**
 * The block builder.
 *
 * Left: the theme, then the blocks in page order. Right: the page itself,
 * rendered by the SAME component the public page uses — not an approximation
 * of it. A preview that is drawn by different code is a preview that can be
 * wrong, and the one moment you find out is after publishing.
 */

interface Props {
  theme: LandingTheme;
  sections: LandingSection[];
  onTheme: (t: LandingTheme) => void;
  onSections: (s: LandingSection[]) => void;
  /** Uploads images and returns their URLs. */
  onUpload: (files: FileList) => Promise<string[]>;
  product: { name: string; price: number } | null;
  /**
   * The id of the product this page sells, when it sells one.
   *
   * `product` above is the name and the price, which is what the preview
   * needs to DRAW the page. This is what the copy assistant needs to ask
   * about it — and the two are separate because the shop's home page has
   * the first and not the second: it sells the whole shelf, so there is no
   * product to write a brief about and the assistant is simply not offered.
   */
  productId?: string | null;
  /** This page's id, so «بعد الطلب» can say how many products it suggests and link to them. */
  pageId?: string | null;
  /** The page's store identity, as the published footer shows it. */
  store?: { name: string; logo: string | null; phone: string | null } | null;
  currency: string;
  offers: { id: string; name: string; quantity: number; freeQuantity: number; price: number; compareAtPrice?: number | null; isDefault?: boolean }[];
  /** The store's family (عيادة · عطّار · ترند): the preview wears it, as the published page does. */
  family?: SellingFamily | null;
}

/**
 * THE EDITOR'S TWO COLUMNS WHEN THE PAGE IS DRAWN WHOLE.
 *
 * The preview has no scroller of its own: it is as tall as the page and the WINDOW scrolls it. What is
 * kept within reach while it does is the controls, so they are pinned under the system's bar (measured, in
 * `--sys-header-h`, 72px until it has measured) and scroll inside themselves when they are taller than the
 * screen. Desk only: below 1024px the two panes are one at a time (EditorPanes.tsx) and the controls pane
 * is simply the page. `align-self: start` is what lets a grid item stick at all — stretched to the row it
 * would have nowhere to move.
 *
 * AND THE FLOATING BUTTON IS DRAWN WHERE ITS BLOCK SITS. On the published page it is fixed to the bottom of
 * the screen. Here a fixed bar would centre itself on the whole window — over the controls — because the
 * preview is no longer a box of its own to float in. In the flow it is still the same bar, the same look,
 * and still the block you click to restyle it; and it stays on screen when the form is in view, which the
 * visitor's copy slides away to avoid.
 */
const EDITOR_LAYOUT_CSS = `
@media (min-width: 1024px) {
  [data-editor-controls] {
    position: sticky;
    top: calc(var(--sys-header-h, 72px) + 12px);
    align-self: start;
    max-height: calc(100dvh - var(--sys-header-h, 72px) - 64px);
    overflow-y: auto;
    padding: 2px;
  }
}
.lp-root .lp-sticky-bar,
.lp-root .lp-sticky-bar[data-away] {
  position: static;
  margin: 12px auto;
  transform: none;
  opacity: 1;
  pointer-events: auto;
}
.lp-root.lp-root:has(.lp-sticky) .lp-form-section:where(:not([data-look-pad] *)) { padding-bottom: 30px; }
.lp-root.lp-root:has(.lp-sticky) [data-family='brand'] .lp-form-section:where(:not([data-look-pad] *)) { padding-bottom: 38px; }
.lp-root.lp-root:has(.lp-sticky) .lp-footer { padding-bottom: 28px; }
@media (max-width: 767.98px) {
  .lp-root [data-block-bar] {
    bottom: calc(var(--sys-mobile-nav-h, 0px) + env(safe-area-inset-bottom) + 8px) !important;
  }
}
`;

/** A palette the seller can start from instead of hunting for a hex. */
const SWATCHES = [
  '#b8256e', '#e11d48', '#ea580c', '#f59e0b',
  '#16a34a', '#0d9488', '#2563eb', '#4f46e5',
  '#7c3aed', '#0f172a', '#8b5a2b', '#be123c',
];

export function BlockBuilder(props: Props) {
  const { theme, sections, onTheme, onSections } = props;
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');

  /**
   * A look copied off one block, waiting to be put on another.
   *
   * Kept in memory and not saved: it is a clipboard, and a clipboard that
   * survives a reload is a clipboard nobody remembers filling.
   */
  const [copiedLook, setCopiedLook] = useState<LandingSection['look'] | null>(null);
  // Which block it was copied from: that block says «نُسخ» and does not offer to paste onto itself.
  const [copiedFromId, setCopiedFromId] = useState<string | null>(null);

  /**
   * How large the page is drawn, NOT how large it is.
   *
   * A seller checking their spacing wants to see the whole page at once;
   * one reading their own small print wants it bigger. Neither is a change
   * to the page, so this is a transform on the canvas and touches nothing
   * that gets saved.
   */
  const [zoom, setZoom] = useState(1);

  /** Whether the template list is open. Never saved — it is a menu. */
  const [pickingTemplate, setPickingTemplate] = useState(false);

  /**
   * WHICH HALF OF THE EDITOR A PHONE IS SHOWING.
   *
   * Ignored from `lg` up, where both halves are on the screen at once and
   * the toggle is not drawn. See `EditorPanes.tsx` for why a stacked editor
   * is not the same thing as a side-by-side one.
   */
  const [pane, setPane] = useState<EditorPane>('edit');

  const confirm = useConfirm();

  const palette = useMemo(() => paletteFor(theme), [theme]);
  // The page's own faces, in full, exactly as the published page asks for
  // them — a preview whose headings synthesise their bold is not a preview.
  const fontLink = useMemo(
    () => fontHref(theme.font, ...sections.map((b) => b.look?.text?.font)),
    [theme.font, sections]
  );
  // And the whole library at one weight, for the picker's specimen list. A
  // list of twenty names in the fallback face is worse than no list; every
  // weight of twenty families to draw twenty words is worse than that.
  const specimenLink = useMemo(() => specimenHref(...FONTS.map((f) => f.key)), []);

  // The store's own uploaded faces. Fetched rather than passed in, because
  // the uploader below can add one without the page being rebuilt — and a
  // font you just uploaded that does not appear until a reload reads as
  // an upload that failed.
  const [storeFonts, setStoreFonts] = useState<StoreFontRow[]>([]);
  const storeFontCss = useMemo(() => {
    if (storeFonts.length === 0) return '';
    const faces = storeFonts
      .map(
        (f) =>
          `@font-face{font-family:${cssString(f.family)};src:url(${cssString(f.url)}) format(${cssString(f.format)});font-weight:${f.weight};font-style:${f.italic ? 'italic' : 'normal'};font-display:swap;}`
      )
      .join('\n');
    // Same variable mapping the published page emits, so `u:<key>` resolves
    // identically in the preview and in the page it is previewing.
    const seen = new Set<string>();
    const vars = storeFonts
      .filter((f) => !seen.has(f.key) && seen.add(f.key))
      .map((f) => `--store-uf-${f.key}: ${cssString(f.family)}, system-ui, sans-serif;`)
      .join(' ');
    return `${faces}
.lp-root, .zaki-font-panel { ${vars} }`;
  }, [storeFonts]);

  // One list for the pickers: the library, then whatever this store uploaded.
  const fontChoices = useMemo(() => {
    const uploaded = new Map<string, { key: FontValue; label: string; stack: string; note: string }>();
    for (const f of storeFonts) {
      if (uploaded.has(f.key)) continue;
      uploaded.set(f.key, {
        key: `u:${f.key}` as FontValue,
        label: f.label,
        stack: `"${f.family}", system-ui, sans-serif`,
        note: 'خطّك',
      });
    }
    return [
      ...FONTS.map((f) => ({ key: f.key as FontValue, label: f.label, stack: f.stack, note: f.note })),
      ...uploaded.values(),
    ];
  }, [storeFonts]);


  const patch = (id: string, fields: Record<string, unknown>) =>
    onSections(sections.map((s) => (s.id === id ? ({ ...s, ...fields } as LandingSection) : s)));

  /**
   * Reordering by dragging, with the keyboard as an equal.
   *
   * The arrows are gone: nudging a block from the bottom to the top was
   * eleven clicks, and each one re-rendered the page under the cursor so
   * the next arrow had moved. Dragging says what you mean in one gesture.
   *
   * `moveTo` is a LIFT AND INSERT, not a swap. Swapping neighbours is fine
   * for one step and wrong for a drag: dropping block 8 onto position 2
   * should slide 2–7 down, not trade 8 with 2 and scramble the middle.
   */
  const moveTo = (from: number, to: number) => {
    if (from === to || to < 0 || to >= sections.length) return;
    const next = [...sections];
    const [lifted] = next.splice(from, 1);
    next.splice(to, 0, lifted);
    onSections(next);
  };

  /** Which row is under the cursor right now, for the drop line. */
  /** Each block's row in the side list, so a click on the page can reach it. */
  const rowRefs = useRef<Record<string, HTMLLIElement | null>>({});
  /*
   * Where the clicked block stood before its bar moved.
   *
   * The block's bar sits IN the page now, so selecting a block further down removed the old bar above it and the
   * clicked block jumped up by the bar's height, out from under the cursor. The block is put back where it was.
   */
  const anchorRef = useRef<{ id: string; top: number } | null>(null);
  const selectBlock = (id: string) => {
    const el = canvas?.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(id)}"]`);
    anchorRef.current = el ? { id, top: el.getBoundingClientRect().top } : null;
    setOpenId(id);
  };
  /**
   * The preview surface, held in STATE rather than a ref.
   *
   * A ref's `.current` is read while rendering, and on the first render it
   * is still null — attaching it does not cause another render, so the hook
   * below would have run once against nothing and never again. A callback
   * ref that sets state re-runs it the moment the element exists.
   */
  const [canvas, setCanvas] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const a = anchorRef.current;
    anchorRef.current = null;
    if (!a || a.id !== openId) return;
    const el = canvas?.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(a.id)}"]`);
    if (!el) return;
    const moved = el.getBoundingClientRect().top - a.top;
    // The WINDOW is what scrolls now: the preview has no scroller of its own.
    if (moved) window.scrollBy(0, moved);
  }, [openId, canvas]);

  /** The block whose look the bar above the page is editing. */
  const openBlock = sections.find((b) => b.id === openId) ?? null;

  /**
   * Typing on the page instead of in the panel beside it.
   *
   * Only inside the selected block, and only on the texts the seller
   * writes — a price read from the catalogue is not his to type over.
   */
  /**
   * Writes a typed value back, by PATH.
   *
   * Most texts are a field — "headline". The ones inside a list are not:
   * the third benefit's title is `items.2.title`, and naming only the
   * field would have left every repeated text uneditable, which is most of
   * the words on a real page.
   *
   * Immutably, one level at a time, so React sees the change.
   */
  const commitText = useCallback(
    (id: string, path: string, value: string) => {
      const keys = path.split('.');
      if (keys.length === 1) return patch(id, { [path]: value });

      const block = sections.find((b) => b.id === id) as Record<string, unknown> | undefined;
      if (!block) return;

      const write = (node: unknown, depth: number): unknown => {
        const key = keys[depth];
        const last = depth === keys.length - 1;
        if (Array.isArray(node)) {
          const i = Number(key);
          if (!Number.isInteger(i) || i < 0 || i >= node.length) return node;
          const copy = [...node];
          copy[i] = last ? value : write(copy[i], depth + 1);
          return copy;
        }
        if (node && typeof node === 'object') {
          const o = node as Record<string, unknown>;
          return { ...o, [key]: last ? value : write(o[key], depth + 1) };
        }
        return node;
      };

      patch(id, { [keys[0]]: write(block[keys[0]], 1) });
    },
    // `patch` closes over `sections`, so this must follow them — a stale
    // one would write the edit onto the list as it was before the last one.
    [sections] // eslint-disable-line react-hooks/exhaustive-deps
  );
  useInlineEdit(canvas, openId, commitText);

  /**
   * Reading a field back after the toolbar has changed its markup.
   *
   * The toolbar edits the DOM directly — that is what a selection toolbar
   * is — so React has no idea anything happened, and this commits the
   * field's current markup by the same path a blur takes.
   *
   * It is HANDED the element. Looking it up here meant asking which field
   * was selected just after the toolbar had cleared the selection, and the
   * answer was "none": bold happened to survive because the node still had
   * focus, and a colour applied after a re-render was committed nowhere.
   */
  const commitSelection = useCallback(
    (node: HTMLElement) => {
      const field = node.dataset.edit;
      if (field && openId) commitText(openId, field, sanitizeRich(node.innerHTML));
    },
    [openId, commitText]
  );

  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  const available = (Object.keys(SECTION_LABEL) as SectionType[]).filter(
    (t) => !(SINGLETON.includes(t) && sections.some((s) => s.type === t))
  );

  return (
    <div className="grid grid-cols-1 gap-3 p-3 lg:grid-cols-[340px_1fr]" dir="rtl">
      {/* Loaded for the panel, not for the page: the picker's names are
          drawn in their own faces and the preview must not be the only
          place a font appears. */}
      {specimenLink && <link rel="stylesheet" href={specimenLink} />}
      {/* Above the words the seller just highlighted, not docked in a
          panel they would have to look away to find. */}
      <SelectionBar root={canvas} fonts={fontChoices} onChange={commitSelection} />
      <style dangerouslySetInnerHTML={{ __html: EDITOR_LAYOUT_CSS }} />
      {/* Declared at the top so the PANEL can draw its specimens in them
          too, not only the preview below. */}
      {storeFontCss && <style dangerouslySetInnerHTML={{ __html: storeFontCss }} />}
      {/*
        ONE TAP BETWEEN THE CONTROLS AND THE PAGE, ON A PHONE ONLY.

        `lg:hidden` lives on the toggle itself, and a hidden grid item takes
        no cell — so the two-column arrangement above 1024px is exactly what
        it was before this existed.
      */}
      <PaneToggle pane={pane} onPane={setPane} />
      {/* ─── Controls ─── */}
      <div data-editor-controls className={`space-y-3 ${editPaneClass(pane)}`}>
        {/*
          FIRST, not buried.

          It sat at the bottom of the identity panel — 1184px down, past
          the colour, the mood, the font, the corners, the page background
          and the font uploader. Which is backwards: you pick a template
          and THEN adjust what it gave you, so a seller starting a page had
          to scroll past every decision the template was about to make for
          them before finding the thing that makes them.
        */}
        <div className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] p-3">
          {/*
            A blank builder is a worse problem than a badly designed page:
            a seller who does not know which blocks a page needs picks
            three, publishes, and wonders why it does not sell.

            Offered as a BUTTON and not as an empty state. The first
            version showed these only when the page had no blocks — and a
            page never has none, because it always keeps its form and a new
            page is created from the starter set. A panel that can never
            appear is worse than no panel: it looks finished.

            Replacing a page is destructive, so it asks first, and says how
            much it is about to throw away.
          */}
          <button
            type="button"
            onClick={() => setPickingTemplate((v) => !v)}
            className="mb-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-[var(--sys-border-strong)] px-2 py-1.5 text-xs font-semibold text-[var(--sys-muted-foreground)] transition hover:border-[var(--sys-primary)] hover:text-[var(--sys-primary)]"
          >
            <LayoutTemplate className="h-3.5 w-3.5" />
            {pickingTemplate ? 'إغلاق القوالب' : 'ابدأ من قالب جاهز'}
          </button>

          {pickingTemplate && (
            <div className="mb-3 max-h-80 space-y-1.5 overflow-y-auto rounded-lg bg-[var(--sys-surface)] p-2">
              <p className="text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
                القالب يستبدل أقسام الصفحة الحالية. النصوص والصور التي كتبتها ستُفقد.
              </p>
              {PAGE_TEMPLATES.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={async () => {
                    const built = buildTemplate(t.key);
                    const ok = await confirm({
                      title: `استبدال الصفحة بـ«${t.label}»؟`,
                      body:
                        sections.length > 0
                          ? `سيُحذف ${sections.length} قسماً بما فيها من نصوص وصور، ويحل محلها ${built.sections.length} قسماً جديداً بلون وخط القالب.`
                          : undefined,
                      confirmLabel: 'استبدل',
                      cancelLabel: 'إلغاء',
                      tone: 'danger',
                    });
                    if (!ok) return;
                    // The theme as well as the blocks: a template that only
                    // changed the order would be the same page five times,
                    // which is the version of this feature nobody uses.
                    onTheme(built.theme);
                    onSections(built.sections);
                    setPickingTemplate(false);
                    setOpenId(null);
                  }}
                  className="flex w-full items-start gap-2 rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] px-2.5 py-2 text-start transition hover:border-[var(--sys-primary)] hover:bg-[var(--sys-primary-soft)]"
                >
                  {/* Its own colour, so fifteen rows are scannable without
                      reading fifteen names. */}
                  <span
                    className="mt-0.5 h-7 w-1.5 shrink-0 rounded-full"
                    style={{ background: t.swatch }}
                  />
                  <span className="min-w-0">
                    <span className="block text-xs font-semibold text-[var(--sys-heading)]">{t.label}</span>
                    <span className="block text-xs leading-relaxed text-[var(--sys-muted)]">{t.hint}</span>
                    <span className="mt-0.5 block text-xs text-[var(--sys-border-strong)]">{t.bricks.length} أقسام</span>
                  </span>
                </button>
              ))}
            </div>
          )}

        </div>

        {/* Theme */}
        <div className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] p-4">
          <p className="mb-3 text-xs font-bold text-[var(--sys-muted-foreground)]">الهوية</p>

          <label className="mb-1.5 block text-xs font-semibold text-[var(--sys-heading)]">اللون الأساسي</label>
          <div className="mb-2 grid grid-cols-6 gap-1.5">
            {SWATCHES.map((hex) => (
              <button
                key={hex}
                type="button"
                onClick={() => onTheme({ ...theme, accent: hex })}
                title={hex}
                style={{ background: hex }}
                className={`h-11 md:h-7 rounded-md border-2 transition ${
                  theme.accent.toLowerCase() === hex ? 'border-[var(--sys-heading)] scale-105' : 'border-transparent'
                }`}
              />
            ))}
          </div>
          <div className="mb-4 flex items-center gap-2">
            <input
              type="color"
              value={isValidHex(theme.accent) ? theme.accent : DEFAULT_THEME.accent}
              onChange={(e) => onTheme({ ...theme, accent: e.target.value })}
              className="h-11 w-11 md:h-8 md:w-10 cursor-pointer rounded-sm border border-[var(--sys-border-input)]"
            />
            <Input
              dir="ltr"
              value={theme.accent}
              onChange={(e) => onTheme({ ...theme, accent: e.target.value })}
              className="font-mono text-xs"
            />
          </div>
          <p className="-mt-3 mb-4 text-xs leading-relaxed text-[var(--sys-muted)]">
            كل باقي الألوان — الأزرار، السعر، الشارات، الحدود — تُشتق من هذا اللون، فلا يمكن أن تتنافر. ما عدا زر
            تأكيد الطلب: إذا المتجر اختار له لون بتبويب «الدفع»، بياخد هاللون.
          </p>

          <label className="mb-1.5 block text-xs font-semibold text-[var(--sys-heading)]">الطابع</label>
          <div className="mb-4 grid grid-cols-2 gap-1.5">
            {MOODS.map((m) => (
              <button
                key={m.key}
                type="button"
                onClick={() => onTheme({ ...theme, mood: m.key })}
                className={`rounded-lg border px-2 py-1.5 text-start text-xs transition ${
                  theme.mood === m.key
                    ? 'border-[var(--sys-primary)] bg-[var(--sys-primary-soft)] font-bold text-[var(--sys-primary)]'
                    : 'border-[var(--sys-border)] text-[var(--sys-heading)] hover:border-[var(--sys-primary)]/40'
                }`}
              >
                {m.label}
                <span className="block text-xs font-normal text-[var(--sys-muted)]">{m.hint}</span>
              </button>
            ))}
          </div>

          <label className="mb-1.5 block text-xs font-semibold text-[var(--sys-heading)]">الخط</label>
          {/*
            A specimen list, not a list of names: every face is drawn in
            itself, because "لاله زار" tells a seller nothing and the shape
            of the letters tells them everything. Thirteen of them scroll
            rather than push the rest of the panel off the screen.
          */}
          <div className="mb-4 max-h-56 space-y-1 overflow-y-auto pe-1">
            {fontChoices.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => onTheme({ ...theme, font: f.key })}
                className={`flex w-full items-baseline justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-start transition ${
                  theme.font === f.key
                    ? 'border-[var(--sys-primary)] bg-[var(--sys-primary-soft)] text-[var(--sys-primary)]'
                    : 'border-[var(--sys-border)] text-[var(--sys-heading)] hover:border-[var(--sys-primary)]/40'
                }`}
              >
                <span className="text-base leading-tight" style={{ fontFamily: f.stack }}>
                  {f.label}
                </span>
                <span className="shrink-0 text-xs text-[var(--sys-muted)]">{f.note}</span>
              </button>
            ))}
          </div>

          {/*
            THE THREE A SELLER SETS ONCE, OR NEVER.

            The colour, the mood and the typeface are the decisions somebody
            makes on every page; their own uploaded font, the corner style
            and a photograph behind the whole page are decisions a brand
            makes once. Keeping all six open meant the first three were the
            same size as the last three, and the panel ran 1184px before a
            seller reached the blocks the page is actually made of.

            Nothing is gone — the row says what is inside.
          */}
          <Advanced holds="خطّك · الزوايا · خلفية الصفحة">
          {/* The seller's own typefaces, beneath the library — a brand that
              bought a font should not have to settle for the nearest free
              one. Uploading is per store, like everything a store owns. */}
          <div className="mb-4">
            <FontUploader onChanged={setStoreFonts} />
          </div>

          <label className="mb-1.5 block text-xs font-semibold text-[var(--sys-heading)]">الزوايا</label>
          <div className="grid grid-cols-2 gap-1.5">
            {([['soft', 'ناعمة'], ['sharp', 'حادّة']] as const).map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => onTheme({ ...theme, corners: k })}
                className={`rounded-lg border px-2 py-1.5 text-xs transition ${
                  theme.corners === k
                    ? 'border-[var(--sys-primary)] bg-[var(--sys-primary-soft)] font-bold text-[var(--sys-primary)]'
                    : 'border-[var(--sys-border)] text-[var(--sys-heading)] hover:border-[var(--sys-primary)]/40'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/*
            The page's own backdrop. It belongs to the theme and not to a
            block, because a seller who wants a textured page means the
            page — setting the same photograph on nine blocks and keeping
            them in step is not a feature, it is a chore.
          */}
          <div className="mt-4 border-t border-[var(--sys-surface)] pt-3">
            <ImageField
              label="خلفية الصفحة كلها"
              value={theme.pageImage ?? ''}
              onChange={(v) => onTheme({ ...theme, pageImage: v })}
              onUpload={props.onUpload}
            />
            {theme.pageImage ? (
              <div className="mt-2">
                <label className="mb-1 flex items-center justify-between text-xs font-semibold text-[var(--sys-muted-foreground)]">
                  <span>تغطية الصورة</span>
                  <span className="tabular-nums">{Math.round((theme.pageVeil ?? 0.82) * 100)}%</span>
                </label>
                <input
                  type="range"
                  min={0}
                  max={0.95}
                  step={0.05}
                  value={theme.pageVeil ?? 0.82}
                  onChange={(e) => onTheme({ ...theme, pageVeil: Number(e.target.value) })}
                  className="w-full accent-[var(--sys-primary)]"
                />
                {/* Not decoration. Body text straight on a photograph is
                    unreadable exactly as often as the photograph is busy,
                    and the seller is looking at the picture, not the text. */}
                <p className="mt-1 text-xs leading-relaxed text-[var(--sys-muted)]">
                  كل ما زادت، صار النص أوضح والصورة أخفت. تحت 50٪ غالباً بتصير القراءة صعبة.
                </p>
              </div>
            ) : null}
          </div>
          </Advanced>
        </div>

        {/*
          THE WORDS, PROPOSED — FROM INSIDE THE EDITOR.

          Offered only for a page that sells a product: the shop's home page
          has a shelf rather than a product, so there is nothing to write a
          brief about and no button that would answer the press.
        */}
        {props.productId && (
          <AiCopyPanel productId={props.productId} sections={sections} onSections={onSections} />
        )}

        {/* Sections */}
        <div className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] p-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-xs font-bold text-[var(--sys-muted-foreground)]">أقسام الصفحة</p>
            <span className="text-xs text-[var(--sys-muted)]">{sections.length}</span>
          </div>

          <ul className="space-y-1.5">
            {sections.map((s, i) => (
              <li
                key={s.id}
                ref={(el) => { rowRefs.current[s.id] = el; }}
                onDragOver={(e) => {
                  if (dragFrom === null) return;
                  e.preventDefault();
                  setDragOver(i);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragFrom !== null) moveTo(dragFrom, i);
                  setDragFrom(null);
                  setDragOver(null);
                }}
                className={`rounded-lg border transition-colors ${
                  dragFrom === i
                    ? 'border-[var(--sys-primary)] opacity-40'
                    : dragOver === i && dragFrom !== null
                      ? 'border-[var(--sys-primary)] bg-[var(--sys-primary-soft)]'
                      : 'border-[var(--sys-border)]'
                }`}
              >
                <div className="flex items-center gap-1 px-2 py-1.5">
                  {/* The handle, not the whole row: a row that drags from
                      anywhere cannot also have buttons you click. */}
                  <button
                    type="button"
                    draggable
                    onDragStart={(e) => {
                      setDragFrom(i);
                      e.dataTransfer.effectAllowed = 'move';
                      // Firefox refuses to start a drag without payload.
                      e.dataTransfer.setData('text/plain', s.id);
                    }}
                    onDragEnd={() => {
                      setDragFrom(null);
                      setDragOver(null);
                    }}
                    onKeyDown={(e) => {
                      // The keyboard is not a lesser way to do this.
                      if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        moveTo(i, i - 1);
                      } else if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        moveTo(i, i + 1);
                      }
                    }}
                    title="اسحب لترتيب البلوك — أو الأسهم من لوحة المفاتيح"
                    aria-label={`رتّب ${SECTION_LABEL[s.type]}`}
                    className="cursor-grab active:cursor-grabbing p-0.5 text-[var(--sys-muted)] hover:text-[var(--sys-primary)] focus:outline-none focus:text-[var(--sys-primary)]"
                  >
                    <GripVertical className="h-4 w-4" />
                  </button>

                  <button
                    type="button"
                    onClick={() => setOpenId(openId === s.id ? null : s.id)}
                    className="flex-1 cursor-pointer text-start"
                  >
                    <span className={`text-xs font-bold ${s.enabled ? 'text-[var(--sys-heading)]' : 'text-[var(--sys-muted)] line-through'}`}>
                      {SECTION_LABEL[s.type]}
                    </span>
                    <span className="block text-xs text-[var(--sys-muted)]">{SECTION_HINT[s.type]}</span>
                  </button>

                  {/*
                    The same rules and the same icons as the bar on the block. The list let the form and the floating
                    button be «hidden» (and the floating button deleted) while the public page re-enables both, and its
                    eye showed the state where the bar's shows the action. Now: the icon is the action, and a block the
                    page is never without says so instead of pretending.
                  */}
                  {LOCKED_SECTIONS.includes(s.type) ? (
                    <span title="قسم أساسي — ما بينخفى ولا بينحذف" className="flex items-center gap-0.5 text-[var(--sys-muted)]">
                      <button type="button" disabled aria-label="قسم أساسي — ما بينخفى" className="p-1 opacity-40">
                        <EyeOff className="h-3.5 w-3.5" />
                      </button>
                      <button type="button" disabled aria-label="قسم أساسي — ما بينحذف" className="p-1 opacity-40">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => patch(s.id, { enabled: !s.enabled })}
                        title={s.enabled ? 'إخفاء' : 'إظهار'}
                        aria-label={s.enabled ? 'إخفاء' : 'إظهار'}
                        className="cursor-pointer p-1 text-[var(--sys-muted-foreground)] hover:text-[var(--sys-primary)]"
                      >
                        {s.enabled ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          onSections(sections.filter((x) => x.id !== s.id));
                          if (openId === s.id) setOpenId(null);
                        }}
                        title="حذف"
                        aria-label="احذف هذا القسم"
                        className="cursor-pointer p-1 text-[var(--sys-muted)] hover:text-[var(--sys-destructive)]"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </>
                  )}
                </div>

                {openId === s.id && (
                  <div className="space-y-2 border-t border-[var(--sys-border)] bg-[var(--sys-surface)] p-3">
                    <SectionFields section={s} patch={(f) => patch(s.id, f)} onUpload={props.onUpload} ctx={{ productId: props.productId, pageId: props.pageId, storePhone: props.store?.phone ?? null, currency: props.currency }} />

                  </div>
                )}
              </li>
            ))}
          </ul>

          <div className="relative mt-3">
            <Button variant="outline" size="sm" className="w-full" onClick={() => setAdding((v) => !v)}>
              <Plus className="h-3.5 w-3.5" /> إضافة قسم
            </Button>
            {adding && (
              <div className="absolute bottom-full z-20 mb-1 max-h-72 w-full overflow-auto rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] py-1 shadow-raised">
                {available.length === 0 && (
                  <p className="px-3 py-2 text-xs text-[var(--sys-muted)]">كل الأقسام مضافة.</p>
                )}
                {available.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => {
                      const s = newSection(t);
                      onSections([...sections, s]);
                      setOpenId(s.id);
                      setAdding(false);
                    }}
                    className="block w-full cursor-pointer px-3 py-1.5 text-start hover:bg-[var(--sys-surface)]"
                  >
                    <span className="text-xs font-semibold text-[var(--sys-heading)]">{SECTION_LABEL[t]}</span>
                    <span className="block text-xs text-[var(--sys-muted)]">{SECTION_HINT[t]}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ─── Live preview, drawn by the public renderer ─── */}
      <div
        className={`${previewPaneClass(pane)} min-h-[500px] flex-col rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)]`}
        /*
          THE PAGE IS DRAWN IN FULL, AND THE WINDOW IS WHAT SCROLLS.

          This pane used to be a fixed-height box with a scroller inside it. Measured at 1900×818: the box was
          722px, began 233px down, and so ended 137px BELOW the window; the scroller inside it was 676px high and the
          page inside THAT was stretched to the same 652px by the flex row it sat in and clipped there (1088px of
          page, 652px shown, nothing to scroll) — so the wheel did nothing, and the order form was cut off.
          A page shown whole has no scroller to get wrong: one scroll, the window's.

          `clip`, not `hidden`, for the rounded corners: hidden makes this a scroll container, and the toolbar's
          and the block bar's `sticky` would then hold to THIS box instead of the window.
        */
        style={{ overflow: 'clip' }}
      >
        {/* Pinned under the system's bar for as long as any of the page is on the screen, so the zoom and the
            phone/desk switch are in reach at every depth. `--sys-header-h` is the bar's measured height. */}
        <div
          className="flex items-center justify-between border-b border-[var(--sys-border)] bg-[var(--sys-card)] px-3 py-2"
          style={{ position: 'sticky', top: 'var(--sys-header-h, 72px)', zIndex: 31 }}
        >
          <span className="text-xs font-semibold text-[var(--sys-heading)]">معاينة مباشرة</span>
          <div className="flex items-center gap-1">
            {/* How large the page is DRAWN, not how large it is. Checking
                the spacing of a long page means seeing the whole of it;
                reading your own small print means the opposite. Neither is
                a change to the page. */}
            <button
              type="button"
              title="تصغير المعاينة"
              disabled={zoom <= 0.5}
              onClick={() => setZoom((z) => Math.max(0.5, Math.round((z - 0.1) * 10) / 10))}
              className="cursor-pointer rounded-sm p-1.5 text-[var(--sys-muted-foreground)] hover:bg-[var(--sys-surface)] disabled:opacity-40"
            >
              <Minus className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              title="حجم طبيعي"
              onClick={() => setZoom(1)}
              className="min-w-[2.75rem] cursor-pointer rounded-sm px-1 py-1 text-xs font-semibold tabular-nums text-[var(--sys-muted-foreground)] hover:bg-[var(--sys-surface)]"
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              type="button"
              title="تكبير المعاينة"
              disabled={zoom >= 1.5}
              onClick={() => setZoom((z) => Math.min(1.5, Math.round((z + 0.1) * 10) / 10))}
              className="cursor-pointer rounded-sm p-1.5 text-[var(--sys-muted-foreground)] hover:bg-[var(--sys-surface)] disabled:opacity-40"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
            <span className="mx-1 h-4 w-px bg-[var(--sys-border)]" />
            {([['desktop', Monitor], ['mobile', Smartphone]] as const).map(([d, Icon]) => (
              <button
                key={d}
                type="button"
                onClick={() => setDevice(d)}
                className={`cursor-pointer rounded-sm p-1.5 ${
                  device === d ? 'bg-[var(--sys-primary-soft)] text-[var(--sys-primary)]' : 'text-[var(--sys-muted-foreground)] hover:bg-[var(--sys-surface)]'
                }`}
              >
                <Icon className="h-4 w-4" />
              </button>
            ))}
          </div>
        </div>

        {/*
          No scroller and no transform here any more.

          The floating button is `position: fixed`, and a fixed element resolves against the nearest TRANSFORMED
          ancestor. The old scroller carried a transform so that the button floated over the pane; with the page
          drawn whole there is no pane-sized box to float over, and a transform on a box as tall as the page would
          park the button at the bottom of all of it. So the button is drawn where its block sits instead — see
          EDITOR_LAYOUT_CSS — and the visitor's page, which has no editor around it, is untouched.
        */}
        <div className="flex items-start justify-center bg-[var(--sys-surface)] p-3">
          <div
            ref={setCanvas}
            className="lp-root rounded-lg border border-[var(--sys-border)] shadow-raised"
            dir="rtl"
            style={{
              ...(paletteVars(palette) as React.CSSProperties),
              // `clip`, not `hidden`: hidden makes the canvas a scroll container, and the block panel's
              // `position: sticky` then stuck to the canvas (which never scrolls) instead of to the preview.
              overflow: 'clip',
              width: device === 'mobile' ? 390 : '100%',
              maxWidth: '100%',
              // `zoom` and not `transform: scale`: scale leaves the element
              // claiming its old size, so the scroller keeps the space a
              // shrunk page no longer uses and clips a magnified one.
              zoom,
            }}
          >
            {/* The preview loads the same families the published page
                will. Without this a chosen font fell back to the system
                stack HERE and looked like the picker doing nothing. */}
            {fontLink && <link rel="stylesheet" href={fontLink} />}
            <style dangerouslySetInnerHTML={{ __html: BLOCK_CSS_WITH_DEV_FONTS }} />
            {/* The family wrapper the published page puts around its blocks (LandingPageView) — without it the
                preview drew every page in the family-less shape and the published one looked different. */}
            <div className={props.family ? 'lp-family' : undefined} data-family={props.family ?? undefined}>
            <PageBlocks
              sections={sections}
              /**
               * Touch the block on the page to edit it.
               *
               * Hunting for a row in a list of eighteen, to change the thing
               * already under the cursor, is the step this removes. Passed
               * only here: the published page gets the same renderer with
               * no selection, so it carries no outlines and no listeners.
               */
              selection={{
                activeId: openId,
                label: (s) => SECTION_LABEL[s.type],
                // Just select it. This used to also scroll the side list to
                // that block's row — and since the controls moved onto the
                // block, all that scroll did was yank the page away from the
                // thing just clicked.
                onSelect: selectBlock,
                onMove: (id, by) => {
                  const i = sections.findIndex((x) => x.id === id);
                  if (i >= 0) moveTo(i, i + by);
                },
                onToggle: (id) => {
                  const b = sections.find((x) => x.id === id);
                  if (b) patch(id, { enabled: !b.enabled });
                },
                onRemove: (id) => onSections(sections.filter((x) => x.id !== id)),
                /**
                 * The look controls ride in the block's own bar.
                 *
                 * A strip pinned to the top of the editor scrolled out of
                 * sight the moment the page did — so styling a block
                 * halfway down meant scrolling back up to reach it. Here it
                 * is attached to what it changes and cannot go missing.
                 */
                toolbar: (b) => (
                  <LookControls
                    look={b.look}
                    type={b.type}
                    fonts={fontChoices}
                    onChange={(look) => patch(b.id, { look })}
                    onUpload={async (file) => {
                      // The builder's uploader takes a FileList; a
                      // background is one picture, so wrap it rather than
                      // growing a second uploader beside it.
                      const dt = new DataTransfer();
                      dt.items.add(file);
                      const urls = await props.onUpload(dt.files);
                      return urls[0] ?? null;
                    }}
                  />
                ),
                onEdit: (id) => {
                  setOpenId(id);
                  // On a phone the fields are the other pane: «تعديل» opens it, or the pencil did nothing visible.
                  setPane('edit');
                  requestAnimationFrame(() =>
                    rowRefs.current[id]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
                  );
                },
                /**
                 * Copy a look, paste it onto the next block.
                 *
                 * Matching two blocks by hand is eight controls set twice
                 * and a third block that never quite matches. This is the
                 * same look object, so they cannot drift.
                 */
                onCopyLook: (id) => {
                  const b = sections.find((x) => x.id === id);
                  if (b) {
                    setCopiedLook(b.look);
                    setCopiedFromId(id);
                  }
                },
                onPasteLook: (id) => {
                  const b = sections.find((x) => x.id === id);
                  // Only the parts that mean something on THIS block — a background pasted onto the floating button
                  // was a value its panel no longer offers to undo.
                  if (copiedLook && b) patch(id, { look: lookForType(b.type, copiedLook, newSection(b.type).look!) });
                },
                hasCopiedLook: Boolean(copiedLook),
                copiedFromId,
                zoom,
                canDuplicate: (b) => !SINGLETON.includes(b.type),
                onDuplicate: (id) => {
                  const i = sections.findIndex((x) => x.id === id);
                  if (i < 0) return;
                  /**
                   * A copy directly below, carrying everything — content AND
                   * look. Placing it at the end would mean dragging it back
                   * past everything, which is the work this saves.
                   *
                   * A fresh id, because two blocks sharing one would edit and
                   * delete as a pair without saying so.
                   */
                  const copy = {
                    ...structuredClone(sections[i]),
                    id: `${sections[i].type}-${Date.now().toString(36)}`,
                  } as LandingSection;
                  const next = [...sections];
                  next.splice(i + 1, 0, copy);
                  onSections(next);
                  setOpenId(copy.id);
                },
              }}
              ctx={{
                palette,
                productName: props.product?.name || 'اسم المنتج',
                price: props.product?.price ?? 0,
                currency: props.currency,
                stock: 7, // a plausible figure so the block can be judged
                offers: props.offers,
                form: <FormPlaceholder />,
                building: true,
                store: props.store ?? null,
                family: props.family ?? undefined,
              }}
            />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────
// Per-block fields
// ─────────────────────────────────────────────────────

function SectionFields({
  section: s, patch, onUpload, ctx = {},
}: {
  section: LandingSection;
  patch: (fields: Record<string, unknown>) => void;
  onUpload: (files: FileList) => Promise<string[]>;
  ctx?: AfterOrderContext;
}) {
  switch (s.type) {
    case 'announcement':
      return <Field label="النص" value={s.text} onChange={(v) => patch({ text: v })} />;

    case 'hero':
      return (
        <div className="space-y-2.5">
          <ImageField
            label="صورة الواجهة"
            value={s.image}
            onChange={(v) => patch({ image: v })}
            onUpload={onUpload}
          />
          <Field label="العنوان" value={s.headline} onChange={(v) => patch({ headline: v })} placeholder="فارغ = اسم المنتج" />
          <Field label="سطر الوصف" value={s.subheadline} onChange={(v) => patch({ subheadline: v })} area />
          <Field label="نص الزر" value={s.ctaText} onChange={(v) => patch({ ctaText: v })} />
          <Check label="إظهار السعر" checked={s.showPrice} onChange={(v) => patch({ showPrice: v })} />
        </div>
      );

    case 'benefits':
      return (
        <div className="space-y-2.5">
          <Field label="العنوان" value={s.title} onChange={(v) => patch({ title: v })} />
          <Repeater
            items={s.items}
            max={8}
            blank={{ title: '', text: '' }}
            onChange={(items) => patch({ items })}
            render={(item, set) => (
              <>
                <Field label="الميزة" value={item.title} onChange={(v) => set({ ...item, title: v })} />
                <Field label="شرح" value={item.text} onChange={(v) => set({ ...item, text: v })} />
              </>
            )}
          />
        </div>
      );

    case 'gallery':
      return (
        <div className="space-y-2.5">
          <Field label="العنوان" value={s.title} onChange={(v) => patch({ title: v })} />
          <GalleryField images={s.images} onChange={(images) => patch({ images })} onUpload={onUpload} />
          <div className="space-y-1">
            <span className="block text-xs font-semibold text-[var(--sys-heading)]">شكل الصور</span>
            <div className="flex gap-1 rounded-md bg-[var(--sys-surface-strong)] p-0.5">
              {([
                ['grid', 'شبكة مربعة'],
                ['stack', 'متتالية كاملة'],
              ] as const).map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => patch({ layout: v })}
                  className={`flex-1 rounded-sm px-2 py-1.5 text-xs font-bold transition ${
                    s.layout === v ? 'bg-[var(--sys-card)] text-[var(--sys-heading)] shadow-raised' : 'text-[var(--sys-muted-foreground)] hover:text-[var(--sys-heading)]'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      );

    /**
     * THE ARRANGEMENT, AND NOTHING THAT IS ALREADY KNOWN.
     *
     * No list of pages to tick: what is in the shop is what the shop has,
     * read at render time. A list ticked here would be a second place
     * deciding it, wrong the first time a page was unpublished.
     *
     * Every control is the real thing — a select, a radio row, a
     * checkbox — because a number typed into a box is a number that can
     * say 97 columns.
     */
    case 'catalog':
      return (
        <div className="space-y-2.5">
          <Field label="العنوان" value={s.title} onChange={(v) => patch({ title: v })} placeholder="اختياري" />

          <div className="space-y-1">
            <span className="block text-xs font-semibold text-[var(--sys-heading)]">ماذا يُعرض</span>
            <div className="flex gap-1 rounded-md bg-[var(--sys-surface-strong)] p-0.5">
              {([
                ['pages', 'صفحات الهبوط'],
                ['products', 'المنتجات'],
                ['both', 'كلاهما'],
              ] as const).map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => patch({ source: v })}
                  className={`flex-1 rounded-sm px-2 py-1.5 text-xs font-bold transition ${
                    s.source === v ? 'bg-[var(--sys-card)] text-[var(--sys-heading)] shadow-raised' : 'text-[var(--sys-muted-foreground)] hover:text-[var(--sys-heading)]'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <label className="flex items-center justify-between gap-2 text-xs font-semibold text-[var(--sys-heading)]">
            أعمدة على الشاشة الكبيرة
            <select
              value={s.columns}
              onChange={(e) => patch({ columns: Number(e.target.value) })}
              className="h-11 md:h-8 rounded-md border border-[var(--sys-border-input)] bg-[var(--sys-card)] px-2 text-xs"
            >
              {[2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          {/* The phone always shows two. Saying so stops the seller
              choosing four and calling the result a bug. */}
          <p className="text-xs leading-relaxed text-[var(--sys-muted)]">على الهاتف عمودان دائماً — ثلاثة أو أربعة لا تُقرأ على شاشة صغيرة.</p>

          <label className="flex items-center justify-between gap-2 text-xs font-semibold text-[var(--sys-heading)]">
            حجم البطاقة
            <select
              value={s.cardSize}
              onChange={(e) => patch({ cardSize: e.target.value as 'sm' | 'md' | 'lg' })}
              className="h-11 md:h-8 rounded-md border border-[var(--sys-border-input)] bg-[var(--sys-card)] px-2 text-xs"
            >
              <option value="sm">صغير</option>
              <option value="md">متوسط</option>
              <option value="lg">كبير</option>
            </select>
          </label>

          <label className="flex items-center justify-between gap-2 text-xs font-semibold text-[var(--sys-heading)]">
            أكثر عدد يُعرض
            <select
              value={s.limit}
              onChange={(e) => patch({ limit: Number(e.target.value) })}
              className="h-11 md:h-8 rounded-md border border-[var(--sys-border-input)] bg-[var(--sys-card)] px-2 text-xs"
            >
              <option value={0}>الكل</option>
              {[4, 6, 8, 12, 16, 24].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>

          <Check label="أظهر السعر" checked={s.showPrice} onChange={(v) => patch({ showPrice: v })} />
          <Check label="أظهر شريط التصنيفات" checked={s.showCategories} onChange={(v) => patch({ showCategories: v })} />
          {/* The chips are drawn only where there is something to filter;
              a shop whose products carry no category shows none. */}
          <p className="text-xs leading-relaxed text-[var(--sys-muted)]">
            شريط التصنيفات يظهر فقط إن كانت لمنتجات هذا المتجر تصنيفات.
          </p>
        </div>
      );

    case 'slider':
      return (
        <div className="space-y-2.5">
          <Field label="العنوان" value={s.title} onChange={(v) => patch({ title: v })} placeholder="اختياري" />
          <GalleryField images={s.images} onChange={(images) => patch({ images: images.slice(0, 10) })} onUpload={onUpload} />
          <Check label="تتقلّب وحدها" checked={s.autoplay} onChange={(v) => patch({ autoplay: v })} />
          {s.autoplay && (
            <label className="flex items-center justify-between gap-2 text-xs font-semibold text-[var(--sys-heading)]">
              ثوانٍ لكل صورة
              <select
                value={s.seconds}
                onChange={(e) => patch({ seconds: Number(e.target.value) })}
                className="h-11 md:h-8 rounded-md border border-[var(--sys-border-input)] bg-[var(--sys-card)] px-2 text-xs"
              >
                {[2, 3, 4, 5, 6, 8, 10].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
          )}
          <p className="text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
            حتى 10 صور. تتوقف حين يلمسها الزائر، ولا تتقلّب أبداً لمن طلب من جهازه حركة أقل.
          </p>
        </div>
      );

    case 'thankyou':
      return (
        <div className="space-y-2.5">
          <Field label="العنوان" value={s.title} onChange={(v) => patch({ title: v })} />
          <Field label="الرسالة" value={s.message} onChange={(v) => patch({ message: v })} area rows={4} />
          <p className="text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
            تظهر مكان النموذج بعد إرسال الطلب. رقم الطلب وعروض ما بعد الطلب تظهر تحتها تلقائياً —
            لا تكتبها هنا.
          </p>
        </div>
      );

    case 'text':
      return (
        <div className="space-y-2.5">
          <Field label="العنوان" value={s.title} onChange={(v) => patch({ title: v })} />
          <Field label="النص" value={s.body} onChange={(v) => patch({ body: v })} area rows={6} />
        </div>
      );

    case 'offers':
      return (
        <div className="space-y-2.5">
          <Field label="العنوان" value={s.title} onChange={(v) => patch({ title: v })} />
          <p className="text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
            العروض نفسها تُدار من تبويب «العروض» في الصفحة — الأسعار تأتي من هناك،
            ولا تُكتب هنا، حتى لا يكون للسعر مصدران.
          </p>
        </div>
      );

    case 'reviews':
      return (
        <div className="space-y-2.5">
          <Field label="العنوان" value={s.title} onChange={(v) => patch({ title: v })} />
          {/*
            THE SELLER'S OWN ITEMS, AND THE SENTENCE THAT SAYS WHAT THEY ARE.
            Owner decision D8: these are transcribed, nobody here can check
            them, and «مشتري مؤكَّد» belongs to a rating that came off a
            delivered order. There is no field below that could claim it.
          */}
          <p className="text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
            هذه آراء بتنقلها بيدك، فما بتحمل شارة «مشتري مؤكَّد» — الشارة لتقييم جاء من طلب
            تمّ تسليمه. الإثبات أدناه خاص ولا يُعرض للزوّار أبداً.
          </p>
          <Repeater
            items={s.items}
            max={12}
            blank={{ name: '', text: '', stars: 5, source: 'other', proofImage: '', addedBy: '', addedAt: '' }}
            onChange={(items) => patch({ items })}
            render={(item, set) => (
              <>
                <Field label="الاسم" value={item.name} onChange={(v) => set({ ...item, name: v })} />
                <Field label="الرأي" value={item.text} onChange={(v) => set({ ...item, text: v })} area />
                <div>
                  <label className="mb-1 block text-xs font-semibold text-[var(--sys-muted-foreground)]">من وين جاء</label>
                  <select
                    value={item.source}
                    onChange={(e) => set({ ...item, source: e.target.value as typeof item.source })}
                    className="h-11 w-full rounded-md border border-[var(--sys-border-input)] bg-[var(--sys-card)] px-2 text-xs md:h-8"
                  >
                    {MANUAL_SOURCES.map((src) => (
                      <option key={src} value={src}>{REVIEW_SOURCE_LABEL[src]}</option>
                    ))}
                  </select>
                </div>
                <Field
                  label="إثبات خاص (رابط صورة) — لا يُعرض للزوّار"
                  value={item.proofImage}
                  onChange={(v) => set({ ...item, proofImage: v })}
                />
                {item.addedBy && (
                  <p className="text-xs text-[var(--sys-muted-foreground)]">
                    أضافه {item.addedBy}{item.addedAt ? ` — ${item.addedAt}` : ''}
                  </p>
                )}
                <div>
                  <label className="mb-1 block text-xs font-semibold text-[var(--sys-muted-foreground)]">النجوم</label>
                  <div className="flex gap-1">
                    {[1, 2, 3, 4, 5].map((n) => (
                      <button
                        key={n}
                        type="button"
                        onClick={() => set({ ...item, stars: n })}
                        className={`h-6 w-6 cursor-pointer rounded-sm text-xs ${
                          n <= item.stars ? 'bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)]' : 'bg-[var(--sys-card)] text-[var(--sys-muted)] border border-[var(--sys-border)]'
                        }`}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}
          />
        </div>
      );

    /**
     * «منتجنا / البدائل». There is no field for a competitor's name, and
     * that absence is the rule: «ما في تشهير بعلامة منافسة بالاسم» cannot
     * be broken from a panel that offers nowhere to write one.
     */
    case 'comparison':
      return (
        <div className="space-y-2.5">
          <Field label="العنوان" value={s.title} onChange={(v) => patch({ title: v })} />
          <div className="grid grid-cols-2 gap-2">
            <Field label="عمودك" value={s.oursLabel} onChange={(v) => patch({ oursLabel: v })} />
            <Field label="العمود الآخر" value={s.theirsLabel} onChange={(v) => patch({ theirsLabel: v })} />
          </div>
          <Repeater
            items={s.rows}
            max={6}
            blank={{ aspect: '', ours: '', theirs: '' }}
            onChange={(rows) => patch({ rows })}
            render={(row, set) => (
              <>
                <Field label="الفرق" value={row.aspect} onChange={(v) => set({ ...row, aspect: v })} />
                <Field label="عندنا" value={row.ours} onChange={(v) => set({ ...row, ours: v })} />
                <Field label="عند البدائل" value={row.theirs} onChange={(v) => set({ ...row, theirs: v })} />
              </>
            )}
          />
        </div>
      );

    case 'timeline':
      return (
        <div className="space-y-2.5">
          <Field label="العنوان" value={s.title} onChange={(v) => patch({ title: v })} />
          <Repeater
            items={s.points}
            max={5}
            blank={{ when: '', what: '' }}
            onChange={(points) => patch({ points })}
            render={(point, set) => (
              <>
                <Field label="متى" value={point.when} onChange={(v) => set({ ...point, when: v })} />
                <Field label="ماذا يحدث" value={point.what} onChange={(v) => set({ ...point, what: v })} area />
              </>
            )}
          />
        </div>
      );

    /** Three at most — «ثلاث ضغطات كحد أقصى» is the whole design. */
    case 'quiz':
      return (
        <div className="space-y-2.5">
          <Field label="العنوان" value={s.title} onChange={(v) => patch({ title: v })} />
          <Repeater
            items={s.questions}
            max={3}
            blank={{ ask: '', options: ['', ''] }}
            onChange={(questions) => patch({ questions })}
            render={(q, set) => (
              <>
                <Field label="السؤال" value={q.ask} onChange={(v) => set({ ...q, ask: v })} />
                <Field
                  label="الخيارات، مفصولة بفاصلة"
                  value={q.options.join('، ')}
                  onChange={(v) => set({ ...q, options: v.split('،').map((x) => x.trim()).filter(Boolean).slice(0, 4) })}
                />
              </>
            )}
          />
          <Field label="ماذا تقول بعد الإجابة" value={s.result} onChange={(v) => patch({ result: v })} area />
        </div>
      );

    case 'objections':
      return (
        <div className="space-y-2.5">
          <Field label="العنوان" value={s.title} onChange={(v) => patch({ title: v })} />
          <Repeater
            items={s.items}
            max={6}
            blank={{ doubt: '', answer: '' }}
            onChange={(items) => patch({ items })}
            render={(item, set) => (
              <>
                <Field label="الاعتراض" value={item.doubt} onChange={(v) => set({ ...item, doubt: v })} />
                <Field label="الجواب" value={item.answer} onChange={(v) => set({ ...item, answer: v })} area />
              </>
            )}
          />
          <Field label="الضمان" value={s.guarantee} onChange={(v) => patch({ guarantee: v })} area />
        </div>
      );

    /** No percentage field: a number here is a claim, and numbers come
        from the facts engine. */
    case 'mechanism':
      return (
        <div className="space-y-2.5">
          <Field label="العنوان" value={s.title} onChange={(v) => patch({ title: v })} />
          <Repeater
            items={s.steps}
            max={5}
            blank={{ title: '', text: '' }}
            onChange={(steps) => patch({ steps })}
            render={(step, set) => (
              <>
                <Field label="الخطوة" value={step.title} onChange={(v) => set({ ...step, title: v })} />
                <Field label="الشرح" value={step.text} onChange={(v) => set({ ...step, text: v })} area />
              </>
            )}
          />
          <Repeater
            items={s.ingredients}
            max={8}
            blank={{ name: '', does: '' }}
            onChange={(ingredients) => patch({ ingredients })}
            render={(ing, set) => (
              <>
                <Field label="المكوّن" value={ing.name} onChange={(v) => set({ ...ing, name: v })} />
                <Field label="ماذا يفعل" value={ing.does} onChange={(v) => set({ ...ing, does: v })} />
              </>
            )}
          />
        </div>
      );

    case 'faq':
      return (
        <div className="space-y-2.5">
          <Field label="العنوان" value={s.title} onChange={(v) => patch({ title: v })} />
          <Repeater
            items={s.items}
            max={12}
            blank={{ q: '', a: '' }}
            onChange={(items) => patch({ items })}
            render={(item, set) => (
              <>
                <Field label="السؤال" value={item.q} onChange={(v) => set({ ...item, q: v })} />
                <Field label="الجواب" value={item.a} onChange={(v) => set({ ...item, a: v })} area />
              </>
            )}
          />
        </div>
      );

    case 'urgency':
      return (
        <div className="space-y-2.5">
          <Field label="الملاحظة" value={s.text} onChange={(v) => patch({ text: v })} placeholder="العرض ساري اليوم فقط" />

          {/*
            WHERE THE COUNTDOWN'S ENDING COMES FROM — owner decision D8.
            The two sources are offered side by side, and the per-visitor
            one carries the warning the brief wrote, in red, with the fix
            beside it. Said here and not in a help page: the seller is
            choosing it at this moment, and a warning they have to go
            looking for is a warning nobody reads.
          */}
          <div>
            <label className="mb-1 block text-xs font-semibold text-[var(--sys-muted-foreground)]">مصدر العدّاد</label>
            <div className="flex flex-col gap-1">
              {COUNTDOWN_SOURCES.map((src) => (
                <label key={src} className="flex cursor-pointer items-center gap-2 text-xs font-medium text-[var(--sys-heading)]">
                  <input
                    type="radio"
                    name={`countdown-${s.id}`}
                    checked={s.countdown === src}
                    onChange={() => patch({ countdown: src })}
                    className="h-3.5 w-3.5 cursor-pointer accent-[var(--sys-primary)]"
                  />
                  {COUNTDOWN_SOURCE_LABEL[src]}
                </label>
              ))}
            </div>
          </div>

          {s.countdown === 'visitor' ? (
            <>
              <div>
                <label className="mb-1 block text-xs font-semibold text-[var(--sys-muted-foreground)]">عدّاد (دقائق، 0 = بلا عدّاد)</label>
                <Input
                  type="number" min="0" max="1440" dir="ltr"
                  value={s.minutes}
                  onChange={(e) => patch({ minutes: Math.max(0, Math.min(1440, Number(e.target.value) || 0)) })}
                  className="text-xs"
                />
              </div>
              {s.minutes > 0 && (
                <div className="space-y-1 rounded-md border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] p-2">
                  {/* The brief drew these two with emoji. The marks come
                      from the icon set instead — an emoji is a colour
                      glyph on a phone and a thin outline on a desk, which
                      `one-icon-family.test.ts` refuses. The WORDS are the
                      brief's, unchanged. */}
                  <p className="flex items-start gap-1.5 text-xs font-bold text-[var(--sys-destructive)]">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                    {VISITOR_TIMER_WARNING}
                  </p>
                  <button
                    type="button"
                    onClick={() => patch({ countdown: 'offer' })}
                    className="flex min-h-11 cursor-pointer items-center gap-1.5 text-xs font-semibold text-[var(--sys-primary)] underline md:min-h-0"
                  >
                    <Wrench className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    {VISITOR_TIMER_FIX}
                  </button>
                </div>
              )}
            </>
          ) : (
            <p className="text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
              العدّاد بيقرأ تاريخ انتهاء العرض من المنتج — نفس التاريخ الذي يوقف السعر. إذا ما في
              عرض له تاريخ انتهاء، الحفظ بيرفض ويقول لك.
            </p>
          )}
          <Check
            label="إظهار المخزون المتبقي الحقيقي"
            checked={s.showRealStock}
            onChange={(v) => patch({ showRealStock: v })}
          />
          <p className="text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
            الرقم يُقرأ من المخزون الفعلي ولا يظهر إلا إذا كان منخفضاً حقاً — لا يوجد حقل
            لكتابة «بقي 3» بينما المخزون مئة.
          </p>
        </div>
      );

    case 'form':
      return (
        <div className="space-y-2.5">
          <Field label="العنوان" value={s.title} onChange={(v) => patch({ title: v })} />
          <Field label="سطر تحته" value={s.subtitle} onChange={(v) => patch({ subtitle: v })} />
          <Field label="نص زر التأكيد (السعر بيطلع بعده)" value={s.submitLabel} onChange={(v) => patch({ submitLabel: v })} placeholder="تأكيد الطلب" />
          <StoreCheckoutNote />
          <div className="space-y-1">
            <span className="block text-xs font-semibold text-[var(--sys-heading)]">شكل النموذج</span>
            <div className="flex gap-1 rounded-md bg-[var(--sys-surface-strong)] p-0.5">
              {([
                ['card', 'بطاقة'],
                ['compact', 'مضغوط'],
              ] as const).map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => patch({ formStyle: v })}
                  className={`flex-1 rounded-sm px-2 py-1.5 text-xs font-bold transition ${
                    s.formStyle === v ? 'bg-[var(--sys-card)] text-[var(--sys-heading)] shadow-raised' : 'text-[var(--sys-muted-foreground)] hover:text-[var(--sys-heading)]'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1">
            <span className="block text-xs font-semibold text-[var(--sys-heading)]">اختيار العرض داخل النموذج</span>
            <div className="flex gap-1 rounded-md bg-[var(--sys-surface-strong)] p-0.5">
              {([
                ['cards', 'بطاقات'],
                ['radio', 'اختيار بدوائر'],
                ['select', 'قائمة منسدلة'],
              ] as const).map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => patch({ offerStyle: v })}
                  className={`flex-1 rounded-sm px-2 py-1.5 text-xs font-bold transition ${
                    s.offerStyle === v ? 'bg-[var(--sys-card)] text-[var(--sys-heading)] shadow-raised' : 'text-[var(--sys-muted-foreground)] hover:text-[var(--sys-heading)]'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <AfterOrderPanel section={s} patch={patch} ctx={ctx} />
        </div>
      );

    case 'trust':
      return (
        <div className="space-y-2.5">
          {/* An empty repeater is not an empty row, and a seller who is not
              told that will type three sentences the shop already knows. */}
          <p className="rounded-lg bg-[var(--sys-surface)] p-2 text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
            اتركه فاضي وبيعرض الحقائق لحاله: <b>الدفع عند الاستلام</b> دايماً، و<b>مدّة
            التوصيل</b> من تسليماتك الحقيقيّة إذا صارت كافية، و<b>الإرجاع</b> إذا كتبت
            ضماناً بقسم الاعتراضات أو نشرت سياسة الإرجاع. إذا كتبت أسطرك، كلامك يغلب.
          </p>
          <Repeater
            items={s.items}
            max={4}
            blank={{ title: '', text: '' }}
            onChange={(items) => patch({ items })}
            render={(item, set) => (
              <>
                <Field label="الضمان" value={item.title} onChange={(v) => set({ ...item, title: v })} />
                <Field label="سطر صغير" value={item.text} onChange={(v) => set({ ...item, text: v })} />
              </>
            )}
          />
        </div>
      );

    case 'footer':
      return (
        <div className="space-y-2.5">
          {/* The logo and the phone are the store's, set once — not a
              copy per page that drifts from the waybill and the shop. */}
          <p className="rounded-lg bg-[var(--sys-surface)] p-2 text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
            الشعار ورقم التواصل من <b>هوية المتجر</b> — تُعدَّل مرة واحدة من{' '}
            <a href="/settings/geo" target="_blank" rel="noopener noreferrer" className="font-bold text-[var(--sys-primary)] hover:underline">
              «البلدان والمتاجر»
            </a>{' '}
            وتظهر في كل صفحات المتجر.
          </p>
          <Field label="نص التذييل" value={s.text} onChange={(v) => patch({ text: v })} placeholder="جميع الحقوق محفوظة" />

          <div>
            <label className="mb-1 block text-xs font-semibold text-[var(--sys-muted-foreground)]">أعمدة الروابط</label>
            <Repeater
              items={s.columns}
              max={4}
              blank={{ title: '', links: [{ label: '', url: '' }] }}
              onChange={(columns) => patch({ columns })}
              render={(col, set) => (
                <>
                  <Field label="عنوان العمود" value={col.title} onChange={(v) => set({ ...col, title: v })} />
                  <Repeater
                    items={col.links}
                    max={8}
                    blank={{ label: '', url: '' }}
                    onChange={(links) => set({ ...col, links })}
                    render={(link, setLink) => (
                      <>
                        <Field label="اسم الرابط" value={link.label} onChange={(v) => setLink({ ...link, label: v })} />
                        <LinkField value={link.url} onChange={(v) => setLink({ ...link, url: v })} />
                      </>
                    )}
                  />
                </>
              )}
            />
          </div>
        </div>
      );

    case 'sticky':
      return (
        <div className="space-y-2.5">
          <Field label="نص الزر" value={s.text} onChange={(v) => patch({ text: v })} />
          <Check label="إظهار السعر على الزر" checked={s.showPrice} onChange={(v) => patch({ showPrice: v })} />
          <div className="space-y-1">
            <span className="block text-xs font-semibold text-[var(--sys-heading)]">حركة الزر</span>
            <div className="flex gap-1 rounded-md bg-[var(--sys-surface-strong)] p-0.5">
              {([
                ['none', 'بلا حركة'],
                ['bounce', 'فوق وتحت'],
                ['sway', 'يمين وشمال'],
              ] as const).map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => patch({ motion: v })}
                  className={`flex-1 rounded-sm px-2 py-1.5 text-xs font-bold transition ${
                    s.motion === v ? 'bg-[var(--sys-card)] text-[var(--sys-heading)] shadow-raised' : 'text-[var(--sys-muted-foreground)] hover:text-[var(--sys-heading)]'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          {s.motion !== 'none' && (
            <div className="space-y-1">
              <span className="block text-xs font-semibold text-[var(--sys-heading)]">سرعة الحركة</span>
              <div className="flex gap-1 rounded-md bg-[var(--sys-surface-strong)] p-0.5">
                {([
                  ['slow', 'بطيئة'],
                  ['normal', 'عادية'],
                  ['fast', 'سريعة'],
                ] as const).map(([v, label]) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => patch({ motionSpeed: v })}
                    className={`flex-1 rounded-sm px-2 py-1.5 text-xs font-bold transition ${
                      s.motionSpeed === v ? 'bg-[var(--sys-card)] text-[var(--sys-heading)] shadow-raised' : 'text-[var(--sys-muted-foreground)] hover:text-[var(--sys-heading)]'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}
          <p className="text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
            يلاحق الزائر أسفل الشاشة، وبالضغط عليه ينزل مباشرة إلى تعبئة البيانات.
            موقعه في الترتيب لا يغيّر شيئاً — هو مثبّت على الشاشة لا على الصفحة.
            وما في «إخفاء» له ولا للنموذج: الطلب لازم يضلّ على بُعد ضغطة من أي
            موضع تمرير. الكلمة والحركة من هون، ولونه وحجمه من «الزر — لونه وحجمه» تحت.
            وإذا للمتجر رقم واتساب، بيوقف جنبه زرّ تواصل.
          </p>
        </div>
      );
  }
}

/**
 * A URL field that says what is wrong while it is being typed.
 *
 * The same rule the schema enforces, shown before the save fails: an http(s)
 * address, a path on this site, or a phone/mail link. `javascript:` is the
 * one that turns a footer link into a script on a public page.
 */
function LinkField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const ok = value === '' || /^https?:\/\//i.test(value) || /^\/[^/]/.test(value) || /^(mailto|tel):/i.test(value);
  return (
    <div>
      <label className="mb-1 block text-xs font-semibold text-[var(--sys-muted-foreground)]">الرابط</label>
      <Input
        dir="ltr"
        value={value}
        placeholder="https://… أو /page"
        onChange={(e) => onChange(e.target.value)}
        className={`text-xs ${ok ? '' : 'border-[var(--sys-destructive-border)]'}`}
      />
      {!ok && <p className="mt-1 text-xs text-[var(--sys-destructive)]">رابط غير صالح — يبدأ بـ https:// أو /</p>}
    </div>
  );
}

function Field({
  label, value, onChange, area, rows = 3, placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  area?: boolean;
  rows?: number;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs font-semibold text-[var(--sys-muted-foreground)]">{label}</label>
      {area ? (
        <textarea
          value={value}
          rows={rows}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className="w-full resize-y rounded-lg border border-[var(--sys-border-input)] bg-[var(--sys-card)] px-2.5 py-1.5 text-xs text-[var(--sys-heading)] outline-none focus:border-[var(--sys-primary)]"
        />
      ) : (
        <Input value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className="text-xs" />
      )}
    </div>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-[var(--sys-heading)]">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 cursor-pointer accent-[var(--sys-primary)]"
      />
      {label}
    </label>
  );
}

function ImageField({
  label, value, onChange, onUpload,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onUpload: (files: FileList) => Promise<string[]>;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function pick(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    try {
      const urls = await onUpload(files);
      if (urls[0]) onChange(urls[0]);
    } finally {
      setBusy(false);
      if (ref.current) ref.current.value = '';
    }
  }

  return (
    <div>
      <label className="mb-1 block text-xs font-semibold text-[var(--sys-muted-foreground)]">{label}</label>
      {value ? (
        <div className="relative mb-1.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={value} alt="" className="h-28 w-full rounded-lg border border-[var(--sys-border)] object-cover" />
          <button
            type="button"
            onClick={() => onChange('')}
            className="absolute left-1.5 top-1.5 cursor-pointer rounded-full bg-[var(--sys-card)]/90 p-1 text-[var(--sys-muted-foreground)] hover:text-[var(--sys-destructive)]"
            title="إزالة"
            aria-label="أزل هذه الصورة"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ) : null}
      <input
        ref={ref}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={(e) => pick(e.target.files)}
      />
      <Button variant="outline" size="sm" className="w-full" onClick={() => ref.current?.click()} disabled={busy}>
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
        {value ? 'تغيير الصورة' : 'رفع صورة'}
      </Button>
    </div>
  );
}

function GalleryField({
  images, onChange, onUpload,
}: {
  images: string[];
  onChange: (v: string[]) => void;
  onUpload: (files: FileList) => Promise<string[]>;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function add(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    try {
      const urls = await onUpload(files);
      if (urls.length) onChange([...images, ...urls].slice(0, 12));
    } finally {
      setBusy(false);
      if (ref.current) ref.current.value = '';
    }
  }

  return (
    <div>
      {images.length > 0 && (
        <div className="mb-1.5 grid grid-cols-3 gap-1.5">
          {images.map((src, i) => (
            <div key={i} className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={src} alt="" className="aspect-square w-full rounded-md border border-[var(--sys-border)] object-cover" />
              <button
                type="button"
                onClick={() => onChange(images.filter((_, n) => n !== i))}
                className="absolute left-0.5 top-0.5 cursor-pointer rounded-full bg-[var(--sys-card)]/90 p-0.5 text-[var(--sys-muted-foreground)] hover:text-[var(--sys-destructive)]"
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </div>
          ))}
        </div>
      )}
      <input
        ref={ref}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple
        className="hidden"
        onChange={(e) => add(e.target.files)}
      />
      <Button variant="outline" size="sm" className="w-full" onClick={() => ref.current?.click()} disabled={busy}>
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />} إضافة صور
      </Button>
    </div>
  );
}

/** A list of small records with add/remove, used by benefits, reviews, faq, trust. */
function Repeater<T>({
  items, max, blank, onChange, render,
}: {
  items: T[];
  max: number;
  blank: T;
  onChange: (items: T[]) => void;
  render: (item: T, set: (v: T) => void) => React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      {items.map((item, i) => (
        <div key={i} className="relative space-y-2 rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] p-2.5">
          <button
            type="button"
            onClick={() => onChange(items.filter((_, n) => n !== i))}
            className="absolute left-1.5 top-1.5 cursor-pointer text-[var(--sys-muted)] hover:text-[var(--sys-destructive)]"
            title="حذف"
            aria-label="احذف هذا العنصر"
          >
            <Trash2 className="h-3 w-3" />
          </button>
          {render(item, (v) => onChange(items.map((x, n) => (n === i ? v : x))))}
        </div>
      ))}
      {items.length < max && (
        <Button variant="ghost" size="sm" className="w-full" onClick={() => onChange([...items, blank])}>
          <Plus className="h-3 w-3" /> إضافة
        </Button>
      )}
    </div>
  );
}
