'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Photos that turn by themselves, and by the visitor's thumb.
 *
 * Built on transform, not on native scrolling: a scroll position in a
 * right-to-left container is negative in one browser and positive in the
 * next, and a slider that jumps the wrong way on half the phones is worse
 * than a gallery. The direction is read from the page, so the next photo is
 * always the one the visitor's language says comes next.
 *
 * It stops turning the moment it is touched, hovered or focused, and never
 * turns for somebody who asked their device for less motion.
 */
/** One slide's own words — a title, a line, and a button with where it goes. */
export interface SlideCaption {
  title: string;
  text: string;
  button: string;
  link: string;
}

const said = (c: SlideCaption | null | undefined): c is SlideCaption =>
  !!c && !!(c.title || c.text || (c.button && c.link));

export function Slider({
  images,
  autoplay,
  seconds,
  captions,
}: {
  images: string[];
  autoplay: boolean;
  seconds: number;
  /**
   * Per slide, in the same order as `images` — only from a block that has
   * `slides`. Absent (every block saved before), and the slider is drawn
   * exactly as it always was: no caption, no extra attribute.
   */
  captions?: (SlideCaption | null)[];
}) {
  const [index, setIndex] = useState(0);
  const [held, setHeld] = useState(false);
  const [rtl, setRtl] = useState(true);
  const [calm, setCalm] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const start = useRef<number | null>(null);
  const count = images.length;

  useEffect(() => {
    if (root.current) setRtl(getComputedStyle(root.current).direction === 'rtl');
    setCalm(
      (typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) ||
        // «الحركة: بدون» on the shop — nothing moves, the slider included.
        !!root.current?.closest('[data-motion="none"]')
    );
  }, []);

  const go = useCallback((to: number) => setIndex(((to % count) + count) % count), [count]);

  useEffect(() => {
    if (!autoplay || held || calm || count < 2) return;
    const t = setInterval(() => setIndex((i) => (i + 1) % count), Math.max(2, seconds) * 1000);
    return () => clearInterval(t);
  }, [autoplay, held, calm, count, seconds]);

  if (count === 0) return null;

  return (
    <div
      ref={root}
      className="lp-slider"
      role="region"
      aria-roledescription="carousel"
      aria-label="صور المنتج"
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
      onPointerDown={(e) => { start.current = e.clientX; setHeld(true); }}
      onPointerUp={(e) => {
        if (start.current === null) return;
        const dx = e.clientX - start.current;
        start.current = null;
        if (Math.abs(dx) < 40) return;
        // In a right-to-left page the next photo lies to the left, so the
        // content is dragged rightwards to reach it.
        const forward = rtl ? dx > 0 : dx < 0;
        go(index + (forward ? 1 : -1));
      }}
    >
      <div
        className="lp-slider-track"
        style={{ transform: `translateX(${(rtl ? 1 : -1) * index * 100}%)` }}
      >
        {images.map((src, i) => (
          <div
            key={i}
            className="lp-slider-slide"
            aria-hidden={i !== index}
            style={said(captions?.[i]) ? { position: 'relative' } : undefined}
          >
            {/* The seller's own uploads; next/image would need every host allow-listed. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={src} alt={captions?.[i]?.title || ''} loading={i === 0 ? 'eager' : 'lazy'} draggable={false} />
            {said(captions?.[i]) && <Caption caption={captions![i]!} active={i === index} />}
          </div>
        ))}
      </div>
      {count > 1 && (
        <div className="lp-slider-dots">
          {images.map((_, i) => (
            <button
              key={i}
              type="button"
              aria-label={`الصورة ${i + 1}`}
              aria-current={i === index}
              onClick={() => go(i)}
              className={i === index ? 'on' : ''}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The words over one slide. Drawn with inline style rather than a rule in
 * the block stylesheet: that sheet is inlined on every page of every shop
 * and held to a budget, and only a slider whose seller wrote words needs
 * these. The button is the page's own button (`lp-cta`).
 */
function Caption({ caption: c, active }: { caption: SlideCaption; active: boolean }) {
  return (
    <div
      style={{
        position: 'absolute',
        insetInline: 0,
        bottom: 0,
        padding: '28px 16px 34px',
        textAlign: 'center',
        color: '#fff',
        background: 'linear-gradient(to top, rgba(0,0,0,.62), rgba(0,0,0,0))',
      }}
    >
      {c.title && <p style={{ margin: 0, fontWeight: 800, fontSize: 'clamp(18px, 4.2vw, 30px)', lineHeight: 1.3 }}>{c.title}</p>}
      {c.text && <p style={{ margin: '6px 0 0', fontSize: 14, lineHeight: 1.6 }}>{c.text}</p>}
      {c.button && c.link && (
        <a className="lp-cta" href={c.link} tabIndex={active ? undefined : -1} style={{ marginTop: 12 }}>
          {c.button}
        </a>
      )}
    </div>
  );
}
