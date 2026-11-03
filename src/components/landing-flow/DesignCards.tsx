'use client';

import React from 'react';
import {
  DESIGNS,
  DESIGN_CATEGORIES,
  MOOD_LABEL,
  categoryLabel,
  designPreviewHref,
  type DesignCategory,
  type LandingDesign,
} from '@/lib/landing-designs/catalog';

/**
 * ONE DESIGN, AS A CARD — the same card in the wizard and in the library.
 *
 * The thumbnail is the design's own four colours, not a picture: the looks
 * are drawn by the looks builder, and a card that showed a picture of
 * something else would be a promise the page then breaks. The full preview
 * is one press away, in a new tab, drawn with the seller's product.
 */
export function DesignSwatchThumb({ design, height = 72 }: { design: LandingDesign; height?: number }) {
  const [accent, second, paper, surface] = design.swatches;
  return (
    <span
      aria-hidden="true"
      className="relative block overflow-hidden rounded-md"
      style={{ height, background: `linear-gradient(135deg, ${paper}, ${surface})` }}
    >
      <span className="absolute block h-2.5 rounded-full" style={{ background: accent, width: '55%', insetInlineStart: 12, top: 12 }} />
      <span className="absolute block h-1.5 rounded-full" style={{ background: second, width: '35%', insetInlineStart: 12, top: 28, opacity: 0.7 }} />
      <span className="absolute bottom-3 end-3 block h-5 w-12 rounded-md" style={{ background: accent }} />
    </span>
  );
}

function SwatchDots({ design }: { design: LandingDesign }) {
  return (
    <span className="flex items-center gap-1" aria-hidden="true">
      {design.swatches.map((c, i) => (
        <span key={i} className="block h-3 w-3 rounded-full border border-[var(--sys-border)]" style={{ background: c }} />
      ))}
    </span>
  );
}

export function AnimatedBadge() {
  return (
    <span className="rounded-full bg-[var(--sys-primary)] px-2 py-0.5 text-xs font-bold text-[var(--sys-primary-foreground)]">
      متحرك
    </span>
  );
}

/** «معاينة كاملة ↗» — always a new tab, always with the product when there is one. */
export function FullPreviewLink({ design, productId }: { design: LandingDesign; productId?: string | null }) {
  return (
    <a
      href={designPreviewHref(design.id, productId)}
      target="_blank"
      rel="noopener noreferrer"
      className="text-xs font-semibold text-[var(--sys-primary)] hover:underline"
    >
      معاينة كاملة ↗
    </a>
  );
}

/** The card's words: name, line, category and mood. */
export function DesignCardText({ design }: { design: LandingDesign }) {
  return (
    <>
      <span className="flex items-center justify-between gap-2">
        <span className="text-sm font-bold text-[var(--sys-heading)]">{design.name}</span>
        {design.animated && <AnimatedBadge />}
      </span>
      <span className="block text-xs leading-relaxed text-[var(--sys-muted-foreground)]">{design.description}</span>
      <span className="flex items-center justify-between gap-2">
        <span className="text-xs text-[var(--sys-muted)]">
          {categoryLabel(design.category)} · {MOOD_LABEL[design.mood]}
        </span>
        <SwatchDots design={design} />
      </span>
    </>
  );
}

/**
 * THE CATEGORY CHIPS, EACH WITH ITS COUNT — «الكل 64 · كل المنتجات 5 …».
 *
 * The counts are of the list the chips filter, so a mood or a search
 * already applied is reflected in every number rather than only in the
 * grid under them.
 */
export function CategoryChips({
  value,
  onChange,
  among = DESIGNS,
}: {
  value: DesignCategory | '';
  onChange: (c: DesignCategory | '') => void;
  among?: readonly LandingDesign[];
}) {
  const count = (c: DesignCategory | '') => (c ? among.filter((d) => d.category === c).length : among.length);
  const chips: { id: DesignCategory | ''; label: string }[] = [{ id: '', label: 'الكل' }, ...DESIGN_CATEGORIES];
  return (
    <div role="group" aria-label="القسم" className="flex flex-wrap gap-1.5">
      {chips.map((c) => {
        const on = value === c.id;
        return (
          <button
            key={c.id || 'all'}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(c.id)}
            className={`tap-safe inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 text-xs font-bold md:min-h-9 ${
              on
                ? 'bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)]'
                : 'border border-[var(--sys-border)] text-[var(--sys-muted-foreground)] hover:border-[var(--sys-primary)]'
            }`}
          >
            {c.label}
            <span className="tabular-nums" dir="ltr">{count(c.id)}</span>
          </button>
        );
      })}
    </div>
  );
}
