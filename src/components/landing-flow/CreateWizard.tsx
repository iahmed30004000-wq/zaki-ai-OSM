'use client';

import React, { useMemo, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { TemplateGallery } from '@/components/ui/TemplateGallery';
import { StructureGallery } from '@/components/store/StructureGallery';
import { SlotFields, type SlotCopy } from '@/components/store/SlotFields';
import { TemplatePreview } from '@/components/landing/TemplatePreview';
import { BuildMyLandingPage, type BuiltProposal } from '@/components/landing-editor/BuildMyLandingPage';
import { LANDING_STRUCTURES } from '@/lib/landing-structures';
import { DIALECTS, DIALECT_LABEL, structureToSections, type Dialect } from '@/lib/landing-structure';
import { newSection } from '@/lib/landing-sections';
import { STORE_TEMPLATES } from '@/lib/store-templates';
import { skinToLandingTheme } from '@/lib/store-skin';
import { buildTemplate, PAGE_TEMPLATES } from '@/lib/page-templates';
import type { LandingTheme } from '@/lib/landing-theme';
import { TONES, TONE_LABEL, notesRefusal, type Tone } from '@/lib/landing-copy-brief';
import { DESIGNS, designById, filterDesigns, type DesignCategory } from '@/lib/landing-designs/catalog';
import { screenApi as crmApi } from '@/lib/screen-api';
import { RiAddCircleLine, RiCheckboxBlankLine, RiLoader4Line, RiPaletteLine, RiSparkling2Line } from '@remixicon/react';
import { ProductPicker } from '@/components/ui/ProductPicker';
import { Money } from '@/components/ui/Money';
import { CategoryChips, DesignCardText, DesignSwatchThumb, FullPreviewLink } from './DesignCards';

/**
 * «إنشاء صفحة هبوط» — ONE QUESTION A SCREEN.
 *
 * The owner, 3/11, about his other platform's wizard: «وتتابع الخطوات
 * عجبني ومش معجوق». Its logic, copied: which product → how to start (three
 * big cards) → which design → create the draft and open the editor.
 *
 * NOTHING THE OLD FOUR STEPS HELD WAS REMOVED — it moved to the path it
 * belongs to:
 *
 *   AI: the AI path carries the ten persuasion structures («القصة»), the
 *      «ابنيلي صفحة الهبوط» build, the slot fields with their guides, the
 *      dialect row and the ten store skins, and adds the voice («الأسلوب»)
 *      and the optional notes;
 *   DESIGN: the design path carries the sixty-four designs and, one tab away,
 *      the fifteen ready-made shapes;
 *   BLANK: the blank path is the library's empty page, straight to its name.
 *
 * Every path ends on the same last screen: the name and the address, and
 * a page created as a DRAFT — nobody sees it until it is published from
 * its editor.
 */

export type Way = 'ai' | 'design' | 'blank';
type StepKey = 'product' | 'method' | 'story' | 'design' | 'words' | 'name';

const PATHS: Record<Way, StepKey[]> = {
  ai: ['product', 'method', 'story', 'design', 'words', 'name'],
  design: ['product', 'method', 'design', 'name'],
  blank: ['product', 'method', 'name'],
};

const STEP_LABEL: Record<StepKey, string> = {
  product: 'المنتج',
  method: 'الطريقة',
  story: 'القصة',
  design: 'التصميم',
  words: 'النص',
  name: 'الاسم والرابط',
};

const STEP_QUESTION: Record<StepKey, string> = {
  product: 'لأي منتج هاي الصفحة؟',
  method: 'كيف بدك تبلّش؟',
  story: 'شو القصة اللي بتحكيها الصفحة؟',
  design: 'اختر تصميم',
  words: 'راجع النص',
  name: 'شو اسم الصفحة ورابطها؟',
};

/** What the page wears. One at a time: a design, a store skin, or a ready-made shape. */
type Look = { kind: 'design' | 'skin' | 'shape'; id: string } | null;

/** The library's own theme, which is what a page with no skin is given. */
const BARE_THEME = buildTemplate('blank').theme as LandingTheme;

/** A product's code as an address: lowercase, dashes, or nothing when it cannot be one. */
function slugFrom(sku: unknown): string {
  const s = String(sku ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return /^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])?$/.test(s) ? s : '';
}

export interface WizardStart {
  way?: Way;
  design?: string;
  productId?: string;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  products: any[];
  /** From the library: «استخدم هالقالب» starts on the second question with the design chosen. */
  start?: WizardStart | null;
}

export function CreateWizard({ isOpen, onClose, products, start }: Props) {
  const startDesign = designById(start?.design)?.id ?? '';
  const startProduct = start?.productId ?? '';
  const startWay: Way | null = start?.way ?? (startDesign ? 'design' : null);

  const [productId, setProductId] = useState(startProduct);
  const [way, setWay] = useState<Way | null>(startWay === 'ai' && !startProduct ? 'ai' : startWay);
  const [step, setStep] = useState<StepKey>(
    start ? (startWay === 'ai' && !startProduct ? 'product' : 'method') : 'product'
  );

  // The AI path's own questions.
  const [tone, setTone] = useState<Tone | null>(null);
  const [notes, setNotes] = useState('');
  /**
   * Formal Arabic by default, and deliberately: `copyIn` falls back to
   * whatever dialect HAS text, so one pass in الفصحى المبسّطة serves every
   * visitor. The chips switch it for a seller who wants a dialect.
   */
  const [dialect, setDialect] = useState<Dialect>('msa');
  const [structure, setStructure] = useState('');
  const [copy, setCopy] = useState<SlotCopy>({});
  const [accent, setAccent] = useState('');
  const [builtNote, setBuiltNote] = useState<string | null>(null);
  const [wroteNote, setWroteNote] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);

  // The look.
  const [look, setLook] = useState<Look>(startDesign ? { kind: 'design', id: startDesign } : null);
  const [lookTab, setLookTab] = useState<'designs' | 'skins' | 'shapes'>('designs');
  const [category, setCategory] = useState<DesignCategory | ''>('');

  // The last question.
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const path: StepKey[] = way ? PATHS[way] : ['product', 'method'];
  const at = path.indexOf(step);

  const product = products.find((p: any) => p.id === productId) ?? null;
  const chosenProduct = product
    ? { name: product.name, price: Number(product.basePrice ?? 0), currency: product.currency || '' }
    : null;
  const chosenStructure = LANDING_STRUCTURES.find((s) => s.id === structure) ?? null;


  const previewSections = useMemo(
    () => (chosenStructure ? structureToSections(chosenStructure, copy, dialect, newSection) : []),
    [chosenStructure, copy, dialect]
  );
  const skinThemes = useMemo(
    () =>
      Object.fromEntries(
        STORE_TEMPLATES.map((t) => [t.id, { ...BARE_THEME, ...skinToLandingTheme(t) } as LandingTheme])
      ),
    []
  );

  const notesProblem = notesRefusal(notes);

  /** Walking to a step. Entering the last one fills its two fields from the product, once. */
  const goTo = (next: StepKey) => {
    if (next === 'name' && product) {
      if (!name.trim()) setName(product.name ?? '');
      if (!slug.trim()) setSlug(slugFrom(product.sku));
    }
    setStep(next);
  };
  const forward = () => {
    const next = path[at + 1];
    if (next) goTo(next);
  };
  const back = () => {
    const prev = path[at - 1];
    if (prev) setStep(prev);
  };

  /**
   * A NEW WAY KEEPS ONLY THE LOOK IT CAN WEAR. A store skin dresses a
   * structure, so it means nothing to the design path; a ready-made shape
   * carries its own words, so it means nothing to the AI path.
   */
  const chooseWay = (next: Way) => {
    setWay(next);
    setLookTab('designs');
    if (look && ((next === 'ai' && look.kind === 'shape') || (next === 'design' && look.kind === 'skin'))) {
      setLook(null);
    }
  };

  /** May this step be left forwards? Each answer names the one thing it waits for. */
  const canLeave = (): boolean => {
    switch (step) {
      case 'product':
        return Boolean(productId);
      case 'method':
        if (!way) return false;
        if (way === 'ai') return Boolean(productId) && !notesProblem;
        return true;
      case 'story':
        return Boolean(structure);
      case 'design':
        return way === 'design' ? look !== null : true;
      default:
        return true;
    }
  };

  /**
   * ASK FOR THE WORDS. It writes nothing anywhere — the answer lands in the
   * same `copy` a seller types into, merged into THIS dialect only, so a
   * headline the seller wrote is kept and a Levantine pass never lands
   * under a field labelled «الفصحى».
   *
   * A `writing` FLAG OF ITS OWN, where the old dialog let `Button` answer
   * «is this running»: the press that starts it — «اكتب الصفحة بالذكاء
   * الاصطناعي» on the design step — leaves the screen it is on, so there
   * is no button left to show the wait. The refusal is caught and printed,
   * and the fields stay open for the seller's own words.
   */
  const writeCopy = async () => {
    if (!chosenStructure || !productId) return;
    setWroteNote(null);
    setWriteError(null);
    setWriting(true);
    try {
      const data: { copy?: Record<string, string>; note?: string } = await crmApi('/api/ai/landing-copy', {
        method: 'POST',
        body: JSON.stringify({
          structureId: chosenStructure.id,
          productId,
          dialect,
          ...(tone ? { tone } : {}),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        }),
      });
      setCopy((prev) => {
        const next = { ...prev };
        for (const [slotKey, text] of Object.entries(data.copy ?? {})) {
          next[slotKey] = { ...next[slotKey], [dialect]: text };
        }
        return next;
      });
      setWroteNote(data.note ?? null);
    } catch (e) {
      setWriteError(e instanceof Error ? e.message : 'تعذّر التوليد');
    } finally {
      setWriting(false);
    }
  };

  /** «اكتب الصفحة بالذكاء الاصطناعي»: to the words, and the writing starts there. */
  const writeAndGo = () => {
    goTo('words');
    void writeCopy();
  };

  /**
   * «ابنيلي صفحة الهبوط» CAME BACK — AND NOTHING IS SAVED BY IT. The story it
   * chose becomes the chosen story, the photograph's colour the accent, and
   * the name and line it read off the box the structure's first two slots.
   */
  const applyProposal = (proposal: BuiltProposal) => {
    setStructure(proposal.structure);
    setAccent(proposal.accent);
    const chosen = LANDING_STRUCTURES.find((x) => x.id === proposal.structure);
    const headline = chosen?.slots[0]?.key;
    const second = chosen?.slots[1]?.key;
    const nameAr = proposal.fields.nameAr?.trim();
    const tagline = proposal.fields.tagline?.trim();
    setCopy((prev) => {
      const next = { ...prev };
      if (headline && nameAr) next[headline] = { ...next[headline], [dialect]: nameAr };
      if (second && tagline) next[second] = { ...next[second], [dialect]: tagline };
      return next;
    });
    setBuiltNote(
      `اخترنا «${chosen?.name ?? proposal.structure}»، و${
        proposal.accent ? 'لون العالم من الصورة' : 'ألوان المكتبة'
      }، و${proposal.promises.length} وعد داخل الصفحة. كلّه بيتغيّر.`
    );
  };

  /** ONE STARTING POINT IS SENT, NEVER TWO — the route refuses copy beside a shape. */
  const startPayload = (): Record<string, unknown> => {
    if (way === 'ai') {
      return {
        structure,
        copy,
        dialect,
        ...(look?.kind === 'skin' ? { skin: look.id } : {}),
        ...(look?.kind === 'design' ? { design: look.id } : {}),
        ...(accent ? { accent } : {}),
      };
    }
    if (way === 'design') {
      if (look?.kind === 'shape') return { template: look.id };
      return { template: 'classic', ...(look?.kind === 'design' ? { design: look.id } : {}) };
    }
    return { template: 'blank' };
  };

  const create = async () => {
    setFormError(null);
    setSaving(true);
    try {
      const data = await crmApi('/api/landing-pages', {
        method: 'POST',
        body: JSON.stringify({
          name,
          slug: slug.toLowerCase().trim(),
          productId: productId || null,
          ...startPayload(),
        }),
      });
      onClose();
      window.location.href = `/store/landing-pages/${data.landingPage.id}/editor`;
    } catch (e: any) {
      setFormError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const lookName = (): string => {
    if (way === 'blank') return 'صفحة فاضية';
    if (!look) return 'ألوان المكتبة';
    if (look.kind === 'design') return designById(look.id)?.name ?? look.id;
    if (look.kind === 'skin') return STORE_TEMPLATES.find((t) => t.id === look.id)?.name ?? look.id;
    return PAGE_TEMPLATES.find((t) => t.key === look.id)?.label ?? look.id;
  };

  const shownDesigns = filterDesigns(DESIGNS, { category });

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="إنشاء صفحة هبوط"
      subtitle={`الخطوة ${at + 1} من ${path.length} — ${STEP_LABEL[step]}`}
      maxWidth="4xl"
    >
      <div className="space-y-4">
        {/* The steps of THIS path, done ones reachable backwards by a tap. */}
        <ol className="flex flex-wrap items-center gap-1.5">
          {path.map((k, i) => {
            const done = i < at;
            const on = i === at;
            return (
              <li key={k}>
                <button
                  type="button"
                  onClick={() => { if (done) setStep(k); }}
                  disabled={i > at}
                  aria-current={on ? 'step' : undefined}
                  className={`tap-safe inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 text-xs font-bold md:min-h-9 ${
                    on
                      ? 'bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)]'
                      : done
                        ? 'border border-[var(--sys-primary)] text-[var(--sys-primary)]'
                        : 'border border-[var(--sys-border)] text-[var(--sys-muted)]'
                  }`}
                >
                  <span className="tabular-nums" dir="ltr">{i + 1}</span>
                  {STEP_LABEL[k]}
                </button>
              </li>
            );
          })}
        </ol>

        <h3 className="text-base font-bold text-[var(--sys-heading)]">{STEP_QUESTION[step]}</h3>

        {step === 'product' && (
          <div className="space-y-2">
            {/*
              THE ONE PRODUCT PICKER — searchable by name or code, under the
              catalogue's categories, drawn by the theme rather than the
              browser. The chosen product's price is printed under it.
            */}
            <ProductPicker
              products={products}
              value={productId}
              onChange={setProductId}
              anyOption={{ value: '', label: '— اختر منتجًا —' }}
              groupByCategory
            />
            {product && (
              <p className="text-xs text-[var(--sys-muted-foreground)]">
                السعر: <Money value={product.basePrice} />
              </p>
            )}
            {/* A page may sell nothing — `productId` is optional on the page. Such a
                page has nothing for the AI to write about and no design to fill
                with a product, so it goes straight to its name, blank. */}
            <button
              type="button"
              onClick={() => { setProductId(''); setWay('blank'); setLook(null); goTo('name'); }}
              className="text-xs font-semibold text-[var(--sys-primary)] hover:underline"
            >
              ابدأ صفحة فاضية بدون منتج
            </button>
          </div>
        )}

        {step === 'method' && (
          <div className="space-y-3">
            <div role="radiogroup" aria-label="الطريقة" className="grid gap-2 sm:grid-cols-3">
              {([
                ['ai', RiSparkling2Line, 'اكتبها بالذكاء الاصطناعي', 'عنوان ومميزات وخطوات وأسئلة، مكتوبة عن منتجك'],
                ['design', RiPaletteLine, 'استخدم تصميم', 'تصميم من الأربعة وستين، وإنت بتعدّل النص بالمحرّر'],
                ['blank', RiCheckboxBlankLine, 'صفحة فاضية', 'من الصفر بالمحرّر'],
              ] as const).map(([key, Icon, label, hint]) => {
                const off = key === 'ai' && !productId;
                return (
                  <label
                    key={key}
                    className={`flex cursor-pointer flex-col gap-1 rounded-lg border p-3 ${
                      way === key
                        ? 'border-[var(--sys-primary)] bg-[var(--sys-primary)]/5'
                        : 'border-[var(--sys-border)] hover:border-[var(--sys-primary)]'
                    } ${off ? 'cursor-not-allowed opacity-60' : ''}`}
                  >
                    <span className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="lp-way"
                        value={key}
                        checked={way === key}
                        disabled={off}
                        onChange={() => chooseWay(key)}
                      />
                      <Icon className="h-4 w-4 text-[var(--sys-primary)]" aria-hidden />
                      <span className="text-sm font-bold text-[var(--sys-heading)]">{label}</span>
                    </span>
                    <span className="text-xs leading-relaxed text-[var(--sys-muted-foreground)]">{hint}</span>
                    {off && (
                      <span className="text-xs text-[var(--sys-warning)]">
                        الذكاء الاصطناعي بيكتب عن منتج — ارجع واختار منتج.
                      </span>
                    )}
                  </label>
                );
              })}
            </div>

            {way === 'ai' && (
              <div className="space-y-3 rounded-lg border border-[var(--sys-border)] bg-[var(--sys-surface)] p-3">
                <Textarea
                  label="ملاحظات للذكاء الاصطناعي (اختياري)"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="مثال: ركّز إنه بيدوم سنة"
                  rows={2}
                  helperText="عن المنتج بس — ما تكتب اسم زبون ولا رقم ولا عنوان."
                />
                {notesProblem && (
                  <p className="text-xs text-[var(--sys-destructive)]">{notesProblem}</p>
                )}
                <fieldset>
                  <legend className="text-xs font-semibold text-[var(--sys-foreground)]">الأسلوب</legend>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {TONES.map((t) => (
                      <label
                        key={t}
                        className={`inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-full px-3 text-xs font-bold md:min-h-8 ${
                          tone === t
                            ? 'bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)]'
                            : 'border border-[var(--sys-border)] text-[var(--sys-muted-foreground)]'
                        }`}
                      >
                        <input
                          type="radio"
                          name="lp-tone"
                          value={t}
                          checked={tone === t}
                          onChange={() => setTone(t)}
                          className="sr-only"
                        />
                        {TONE_LABEL[t]}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <fieldset>
                  <legend className="text-xs font-semibold text-[var(--sys-foreground)]">اللغة</legend>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {DIALECTS.map((d) => (
                      <label
                        key={d}
                        className={`inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-full px-3 text-xs font-bold md:min-h-8 ${
                          dialect === d
                            ? 'bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)]'
                            : 'border border-[var(--sys-border)] text-[var(--sys-muted-foreground)]'
                        }`}
                      >
                        <input
                          type="radio"
                          name="lp-language"
                          value={d}
                          checked={dialect === d}
                          onChange={() => setDialect(d)}
                          className="sr-only"
                        />
                        {DIALECT_LABEL[d]}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <p className="text-xs font-semibold text-[var(--sys-foreground)]">
                  الذكاء الاصطناعي ما بيخترع تقييمات ولا خصومات ولا أرقام.
                </p>
              </div>
            )}
          </div>
        )}

        {step === 'story' && (
          <div className="space-y-3">
            {/* The one press that picks the story for you, from the product's own
                specs and photograph — a proposal; nothing is saved by it. */}
            <BuildMyLandingPage
              productId={productId}
              productName={product?.name}
              onApply={applyProposal}
              {...(tone ? { tone } : {})}
            />
            {builtNote && (
              <p className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-surface)] p-2.5 text-xs text-[var(--sys-muted-foreground)]">
                {builtNote}
              </p>
            )}
            <p className="text-xs text-[var(--sys-muted-foreground)]">
              أو اختار بإيدك: البنية ترتيب وقصّة وخانات نص، واللون بيجي بالخطوة الجاية.
            </p>
            <div className="max-h-[24rem] overflow-y-auto pe-1">
              <StructureGallery
                structures={LANDING_STRUCTURES}
                value={structure || null}
                onChange={setStructure}
                productName={product?.name}
              />
            </div>
          </div>
        )}

        {step === 'design' && (
          <div className="space-y-3">
            <div role="group" aria-label="نوع الشكل" className="flex flex-wrap gap-1.5">
              {([
                ['designs', `التصاميم (${DESIGNS.length})`],
                way === 'ai'
                  ? (['skins', `مظاهر المتجر (${STORE_TEMPLATES.length})`] as const)
                  : (['shapes', `أشكال جاهزة (${PAGE_TEMPLATES.length})`] as const),
              ] as const).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={lookTab === key}
                  onClick={() => setLookTab(key)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-bold ${
                    lookTab === key
                      ? 'bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)]'
                      : 'border border-[var(--sys-border)] text-[var(--sys-muted-foreground)]'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {lookTab === 'designs' && (
              <>
                <CategoryChips value={category} onChange={setCategory} />
                <div role="radiogroup" aria-label="التصميم" className="grid max-h-[24rem] gap-2 overflow-y-auto pe-1 sm:grid-cols-3">
                  {shownDesigns.map((d) => {
                    const on = look?.kind === 'design' && look.id === d.id;
                    return (
                      <div
                        key={d.id}
                        className={`flex flex-col gap-1.5 rounded-lg border p-2 ${
                          on ? 'border-[var(--sys-primary)] ring-1 ring-[var(--sys-primary)]' : 'border-[var(--sys-border)]'
                        }`}
                      >
                        <label className="flex cursor-pointer flex-col gap-1.5">
                          <DesignSwatchThumb design={d} />
                          <span className="flex items-start gap-2">
                            <input
                              type="radio"
                              name="lp-design"
                              value={d.id}
                              checked={on}
                              onChange={() => setLook({ kind: 'design', id: d.id })}
                              aria-label={d.name}
                              className="mt-1"
                            />
                            <span className="flex-1 space-y-1"><DesignCardText design={d} /></span>
                          </span>
                        </label>
                        <FullPreviewLink design={d} productId={productId} />
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            {lookTab === 'skins' && chosenStructure && (
              <>
                <p className="text-xs text-[var(--sys-muted-foreground)]">
                  «{chosenStructure.name}» بعشرة مظاهر — نفس الترتيب ونفس النص، واللون والخط بس بيتغيّروا.
                </p>
                <div className="grid max-h-[24rem] gap-2 overflow-y-auto pe-1 sm:grid-cols-3">
                  {STORE_TEMPLATES.map((t) => {
                    const picked = look?.kind === 'skin' && look.id === t.id;
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => setLook(picked ? null : { kind: 'skin', id: t.id })}
                        aria-pressed={picked}
                        className={`overflow-hidden rounded-lg border text-start ${
                          picked
                            ? 'border-[var(--sys-primary)] ring-1 ring-[var(--sys-primary)]'
                            : 'border-[var(--sys-border)] hover:border-[var(--sys-primary)]/40'
                        }`}
                      >
                        <TemplatePreview
                          sections={previewSections}
                          theme={skinThemes[t.id]}
                          product={chosenProduct}
                          height={150}
                          zoom={0.3}
                        />
                        <span className="block p-2">
                          <span className="block text-xs font-bold text-[var(--sys-foreground)]">{t.name}</span>
                          <span className="mt-0.5 block text-xs text-[var(--sys-muted)]">{t.suggestedFor}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </>
            )}

            {lookTab === 'shapes' && (
              <>
                <p className="text-xs text-[var(--sys-muted-foreground)]">
                  كل شكل معروض{chosenProduct ? ` وهو بيبيع «${chosenProduct.name}»` : ''} — وكلّه بيتعدّل بعدين.
                </p>
                <div className="max-h-[22rem] overflow-y-auto pe-1">
                  <TemplateGallery
                    value={look?.kind === 'shape' ? look.id : null}
                    onChange={(key) => setLook({ kind: 'shape', id: key })}
                    product={chosenProduct}
                    columns="sm:grid-cols-2"
                  />
                </div>
              </>
            )}

            {way === 'ai' && !look && (
              <p className="text-xs text-[var(--sys-muted)]">بلا تصميم؟ بتنعمل بألوان المكتبة، وبتلوّنها وقت ما بدك.</p>
            )}
          </div>
        )}

        {step === 'words' && chosenStructure && (
          <div className="space-y-2">
            <div className="overflow-hidden rounded-lg border border-[var(--sys-border)]">
              <TemplatePreview
                sections={previewSections}
                theme={look?.kind === 'skin' ? skinThemes[look.id] : BARE_THEME}
                product={chosenProduct}
                height={220}
                zoom={0.42}
              />
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-[var(--sys-muted)]">اللهجة</span>
              {DIALECTS.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setDialect(d)}
                  aria-pressed={dialect === d}
                  className={`rounded-full px-3 py-1 text-xs font-bold ${
                    dialect === d
                      ? 'bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)]'
                      : 'border border-[var(--sys-border)] text-[var(--sys-muted-foreground)]'
                  }`}
                >
                  {DIALECT_LABEL[d]}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="secondary" onClick={() => writeCopy()} disabled={writing}>
                {writing ? <RiLoader4Line className="h-4 w-4 animate-spin" /> : null}
                {writing ? 'عم يكتب…' : 'اكتب النصوص بالذكاء الاصطناعي'}
              </Button>
              {tone && <span className="text-xs text-[var(--sys-muted)]">الأسلوب: {TONE_LABEL[tone]}</span>}
            </div>
            {wroteNote && (
              <p className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-surface)] p-2.5 text-xs text-[var(--sys-muted-foreground)]">
                {wroteNote}
              </p>
            )}
            {writeError && (
              <p className="rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] p-2.5 text-xs text-[var(--sys-destructive)]">
                {writeError} — بتقدر تكتب الخانات بإيدك تحت.
              </p>
            )}
            <div className="max-h-[26rem] overflow-y-auto pe-1">
              <SlotFields
                structure={chosenStructure}
                copy={copy}
                dialect={dialect}
                onChange={(slotKey, d, text) => setCopy((prev) => ({ ...prev, [slotKey]: { ...prev[slotKey], [d]: text } }))}
              />
            </div>
          </div>
        )}

        {step === 'name' && (
          <div className="space-y-3">
            <dl className="grid gap-2 rounded-lg border border-[var(--sys-border)] bg-[var(--sys-surface)] p-3 text-xs sm:grid-cols-3">
              <div>
                <dt className="text-[var(--sys-muted)]">المنتج</dt>
                <dd className="font-semibold text-[var(--sys-heading)]">{product?.name ?? 'بلا منتج'}</dd>
              </div>
              <div>
                <dt className="text-[var(--sys-muted)]">الطريقة</dt>
                <dd className="font-semibold text-[var(--sys-heading)]">
                  {way === 'ai' ? `بالذكاء الاصطناعي · ${chosenStructure?.name ?? ''}` : way === 'design' ? 'تصميم' : 'صفحة فاضية'}
                </dd>
              </div>
              <div>
                <dt className="text-[var(--sys-muted)]">الشكل</dt>
                <dd className="font-semibold text-[var(--sys-heading)]">{lookName()}</dd>
              </div>
            </dl>
            <Input label="اسم الصفحة *" value={name} onChange={(e) => setName(e.target.value)} placeholder="مثال: صفحة Tremella" />
            <Input
              label="الرابط * — بيصير /lp/…"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="tremella"
              dir="ltr"
              helperText="أحرف إنجليزية صغيرة وأرقام وشرطات."
            />
            <p className="text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
              بتنعمل مسودة: ما حدا بيشوفها لحتى تنشرها من المحرّر.
            </p>
          </div>
        )}

        {formError && (
          <div className="rounded-lg bg-[var(--sys-destructive-soft)] px-3 py-2 text-xs text-[var(--sys-destructive)]">{formError}</div>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onClose}>إلغاء</Button>
          {at > 0 && <Button variant="secondary" onClick={back}>السابق</Button>}
          {step === 'name' ? (
            <Button
              onClick={create}
              disabled={saving || name.trim().length < 2 || slug.trim().length < 3 || (way === 'ai' && !structure)}
            >
              {saving ? <RiLoader4Line className="h-4 w-4 animate-spin" /> : <RiAddCircleLine className="h-4 w-4" />} إنشاء
            </Button>
          ) : step === 'design' && way === 'ai' ? (
            <Button onClick={writeAndGo} disabled={!canLeave()}>اكتب الصفحة بالذكاء الاصطناعي</Button>
          ) : (
            <Button onClick={forward} disabled={!canLeave()}>التالي</Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
