'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { Card, CardContent } from '@/components/ui/Card';
import { Input, Select } from '@/components/ui/Input';
import { ProductPicker } from '@/components/ui/ProductPicker';
import { useProducts } from '@/hooks/useProducts';
import { RiSparkling2Line } from '@remixicon/react';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { HtmlPromptButtons } from '@/components/landing/HtmlPromptButtons';
import { LandingTabs } from '@/components/landing-flow/LandingTabs';
import {
  AnimatedBadge,
  CategoryChips,
  DesignCardText,
  DesignSwatchThumb,
  FullPreviewLink,
} from '@/components/landing-flow/DesignCards';
import {
  DESIGNS,
  MOOD_LABEL,
  categoryLabel,
  designById,
  designPreviewHref,
  filterDesigns,
  similarDesigns,
  type DesignCategory,
  type DesignMood,
} from '@/lib/landing-designs/catalog';
import { designPrompt } from '@/lib/landing-html-prompt';

/**
 * «مكتبة القوالب» — THE SIXTY-FOUR, BROWSED BEFORE ANY PAGE EXISTS.
 *
 * The owner's other platform has a library apart from the wizard: a
 * seller looks through the designs with his own product in them, opens
 * one, and starts a page from it. Same here: «استخدم هالقالب» opens the
 * wizard on its second question with this design already chosen, and
 * «✨ اكتبها بالذكاء الاصطناعي بهالقالب» opens it on the AI path.
 *
 * The look itself is drawn by the full preview, which belongs to the looks
 * builder; this screen only names designs and links to it.
 */

/** The wizard's address, with the design and the product it should start from. */
export function wizardHref(way: 'design' | 'ai', designId: string, productId?: string): string {
  const q = new URLSearchParams({ new: '1', way, design: designId });
  if (productId) q.set('product', productId);
  return `/store/landing-pages?${q.toString()}`;
}

const linkButton =
  'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg px-4 text-sm font-bold md:min-h-9';

export function LandingLibraryScreen() {
  const { products } = useProducts();
  const [productId, setProductId] = useState('');
  const [mood, setMood] = useState<DesignMood | ''>('');
  const [category, setCategory] = useState<DesignCategory | ''>('');
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');

  useEffect(() => {
    // A design named in the address opens on arrival — the link a seller
    // copies from a full preview lands on the same design.
    const fromAddress = new URLSearchParams(window.location.search).get('design');
    if (designById(fromAddress)) setOpenId(fromAddress);
  }, []);

  const animated = DESIGNS.filter((d) => d.animated).length;
  /** The chips count what the mood and the search have left, so each number is the grid it opens. */
  const beforeCategory = useMemo(() => filterDesigns(DESIGNS, { mood, query }), [mood, query]);
  const shown = useMemo(() => filterDesigns(beforeCategory, { category }), [beforeCategory, category]);
  const open = designById(openId);

  const moodCount = (m: DesignMood | '') => filterDesigns(DESIGNS, { mood: m }).length;

  /** The one product picker — the same searchable list every screen uses. */
  const productSelect = (
    <div>
      <span className="mb-1.5 block text-xs font-medium text-[var(--sys-heading)]">المعاينة بمنتج</span>
      <ProductPicker
        products={products}
        value={productId}
        onChange={setProductId}
        anyOption={{ value: '', label: '— بدون منتج —' }}
        groupByCategory
      />
    </div>
  );

  return (
    <>
      <div className="p-6 max-w-7xl mx-auto">
        <PageHeader
          title={`${DESIGNS.length} قالب · ${animated} متحرك`}
          description="كل قالب بينعرض بمنتجك: اسمه وصوره وسعره. اختار واحد وابدأ منه صفحتك."
        />
        <LandingTabs current="library" />

        <Card className="mb-4">
          <CardContent className="space-y-3 p-4">
            <div className="grid gap-3 sm:grid-cols-3">
            {productSelect}
            <Select
              label="الأسلوب"
              value={mood}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setMood(e.target.value as DesignMood | '')}
            >
              <option value="">الكل ({moodCount('')})</option>
              <option value="light">{MOOD_LABEL.light} ({moodCount('light')})</option>
              <option value="dark">{MOOD_LABEL.dark} ({moodCount('dark')})</option>
            </Select>
            <Input label="بحث بالاسم" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="مثال: روز غولد" />
            </div>
            <CategoryChips value={category} onChange={setCategory} among={beforeCategory} />
          </CardContent>
        </Card>

        {shown.length === 0 ? (
          <p className="rounded-lg border border-dashed border-[var(--sys-border)] p-6 text-center text-sm text-[var(--sys-muted-foreground)]">
            ما في قالب بهالفلاتر.
          </p>
        ) : (
          <ul aria-label="القوالب" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {shown.map((d) => (
              <li key={d.id} className="flex flex-col gap-1.5 rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] p-2.5">
                <button
                  type="button"
                  onClick={() => setOpenId(d.id)}
                  aria-label={`افتح ${d.name}`}
                  className="flex flex-col gap-1.5 text-start"
                >
                  <DesignSwatchThumb design={d} height={96} />
                  <DesignCardText design={d} />
                </button>
                <FullPreviewLink design={d} productId={productId} />
              </li>
            ))}
          </ul>
        )}
      </div>

      <Modal isOpen={!!open} onClose={() => setOpenId(null)} title={open?.name ?? ''} subtitle={open?.description} maxWidth="4xl">
        {open && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div role="group" aria-label="الجهاز" className="flex gap-1">
                {([
                  ['desktop', 'كمبيوتر'],
                  ['mobile', 'موبايل'],
                ] as const).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={device === key}
                    onClick={() => setDevice(key)}
                    className={`rounded-lg px-3 py-1.5 text-xs font-bold ${
                      device === key
                        ? 'bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)]'
                        : 'border border-[var(--sys-border)] text-[var(--sys-muted-foreground)]'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <FullPreviewLink design={open} productId={productId} />
            </div>

            <div className="flex justify-center overflow-hidden rounded-lg border border-[var(--sys-border)] bg-[var(--sys-surface)]">
              <iframe
                title={`معاينة ${open.name}`}
                src={designPreviewHref(open.id, productId)}
                loading="lazy"
                className="h-[550px] border-0 bg-[var(--sys-card)]"
                style={{ width: device === 'mobile' ? 390 : '100%' }}
              />
            </div>

            <dl className="grid gap-3 text-xs sm:grid-cols-3">
              <div>
                <dt className="text-[var(--sys-muted)]">الخط</dt>
                <dd className="font-semibold text-[var(--sys-heading)]" dir="ltr">{open.font}</dd>
              </div>
              <div>
                <dt className="text-[var(--sys-muted)]">الألوان</dt>
                <dd className="mt-1 flex flex-wrap gap-2">
                  {open.swatches.map((c) => (
                    <span key={c} className="inline-flex items-center gap-1">
                      <span aria-hidden="true" className="block h-4 w-4 rounded-sm border border-[var(--sys-border)]" style={{ background: c }} />
                      <code dir="ltr">{c}</code>
                    </span>
                  ))}
                </dd>
              </div>
              <div>
                <dt className="text-[var(--sys-muted)]">القسم والأسلوب</dt>
                <dd className="flex flex-wrap items-center gap-1.5 font-semibold text-[var(--sys-heading)]">
                  {categoryLabel(open.category)} · {MOOD_LABEL[open.mood]}
                  {open.animated && <AnimatedBadge />}
                </dd>
              </div>
            </dl>

            <div className="max-w-sm">{productSelect}</div>

            <div className="flex flex-wrap gap-2">
              <a
                href={wizardHref('design', open.id, productId)}
                className={`${linkButton} bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)]`}
              >
                استخدم هالقالب
              </a>
              <a
                href={wizardHref('ai', open.id, productId)}
                className={`${linkButton} border border-[var(--sys-primary)] text-[var(--sys-primary)]`}
              >
                <RiSparkling2Line className="h-4 w-4" aria-hidden /> اكتبها بالذكاء الاصطناعي بهالقالب
              </a>
            </div>

            <div className="space-y-2 rounded-lg border border-[var(--sys-border)] p-3">
              <h4 className="text-sm font-bold text-[var(--sys-heading)]">الوصف للذكاء الاصطناعي</h4>
              <p className="text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
                الصقه بأي مساعد ذكاء اصطناعي ليبني هالتصميم بأي مكان، أو ابعته لمصمّم. فيه وصف التصميم وكل شروط النظام.
              </p>
              <HtmlPromptButtons prompt={designPrompt(open)} />
            </div>

            <div className="space-y-2">
              <h4 className="text-sm font-bold text-[var(--sys-heading)]">شوف كمان</h4>
              <ul className="grid gap-2 sm:grid-cols-4">
                {similarDesigns(open.id).map((d) => (
                  <li key={d.id}>
                    <button
                      type="button"
                      onClick={() => setOpenId(d.id)}
                      aria-label={`افتح ${d.name}`}
                      className="flex w-full flex-col gap-1 rounded-lg border border-[var(--sys-border)] p-2 text-start hover:border-[var(--sys-primary)]"
                    >
                      <DesignSwatchThumb design={d} height={56} />
                      <span className="text-xs font-bold text-[var(--sys-heading)]">{d.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
