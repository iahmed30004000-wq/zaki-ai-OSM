/**
 * ═══════════════════════════════════════════════════════════════════════
 * A THEME IS A SHAPE TOO — AND THE SHAPE IS THE FRAME, NEVER THE FIGURE.
 *
 * Twelve palettes made the product twelve colours. The owner's reference
 * screens are not eleven colours: a card under «إسلامي» wears a pointed
 * arch, one under «سايبربنك» has a cut corner and a hard edge, one under
 * «فخامة» a thin gold hairline. That is what makes a theme read as a
 * theme instead of as a filter.
 *
 * ── AND THE LINE THE OWNER DREW HIMSELF ──
 *
 * «ولا رسمة ورا رقم أو مبلغ.» So nothing here goes behind the content:
 *
 *   • the RADIUS and the BORDER are the card's own edge — they cannot sit
 *     under a figure, because they are the frame around it;
 *   • the CROWN is drawn on the top edge, outside the padding;
 *   • the MARK is a small faint glyph in the card's top-left corner — the
 *     corner furthest from the heading in RTL — at 7% of a colour that is
 *     already the card's border. It is a background, so it is behind
 *     everything, catches no click and is announced to nobody;
 *   • the FRIEZE (the two Islamic themes only) is a band of eight-point stars
 *     and lozenges along the top edge, eight pixels tall — a BACKGROUND in
 *     the card's own top padding (a card's header is 16px from the edge, a
 *     full-bleed table's first row 12px), so it is beneath everything and
 *     beside no figure. The crown is painted over it, which makes a doorway
 *     of the middle.
 *
 * Illustrations — the sunset, the mountains, the planet — stay in the
 * three places decoration is allowed and on the welcome card. Those are
 * `theme-decoration.ts`, and they are a different thing from this.
 *
 * ⚠️ AND THE ARRANGEMENT IS NOT A THEME'S BUSINESS. The owner ruled on it:
 * «الترتيب بيضل لصاحبه، والثيم للشكل بس.» Somebody arranges their
 * dashboard, then changes theme — and if the theme re-ordered it, the
 * theme would have eaten their work. A theme moves surfaces, now shapes,
 * and never the order of anything.
 *
 * ── AND IT COSTS THE STYLESHEET NOTHING ──
 *
 * Written into the document by `SystemFrame` beside the one palette that
 * person chose, for the same reason: see `SHEET_THEMES` in
 * system-themes.ts. Eleven shapes in the first-load sheet would be weight
 * on everybody for the one they picked. The owner's «ضمن سقف ورقة
 * الأنماط» is met by the sheet not growing at all.
 * ═══════════════════════════════════════════════════════════════════════
 */
import type { SystemTheme } from './system-themes';

/** The class a themed card carries, so one rule can find all of them. */
export const CARD_CLASS = 'zk-card';

type Crown = 'none' | 'arch' | 'notch';

/** A tile that repeats along the card's top edge: the inside of an SVG at `w`×`h`. Geometry only. */
interface Frieze {
  body: string;
  w: number;
  h: number;
}

interface Shape {
  /** The card's corner. The product's own is `0.5rem` (`rounded-lg`). */
  radius: string;
  /** Its edge. A gold theme earns a hairline; a neon one earns a hard line. */
  border: string;
  crown: Crown;
  /**
   * The corner glyph, as the inside of an SVG at a 24×24 viewBox.
   *
   * Geometry only — a crescent, a star, a ring, a shield outline. Not one
   * of these is anybody's mark, character or likeness, and that is a
   * blocker in the brief rather than a preference.
   */
  mark: string;
  /** A band along the top edge, drawn in the theme's own accent. Absent for every theme but the two Islamic ones. */
  frieze?: Frieze;
}

/**
 * A KHATAM FRIEZE — AN EIGHT-POINT STAR AND A LOZENGE, ALTERNATING, STRUNG ON A HAIRLINE.
 *
 * The oldest border in the family of patterns the two Islamic themes borrow from, drawn as plain geometry: one polygon, one
 * four-point diamond and a line, on a 24×8 tile that repeats along the top edge. Eight pixels is the whole height, so it sits inside
 * the padding a card's first line already has — `CardHeader` is `py-4`, and the first row of a card with no padding is `py-3` — and
 * never reaches a word or a figure.
 */
const KHATAM: Frieze = {
  w: 24,
  h: 8,
  body:
    '<path d="M0 4h24" stroke="currentColor" stroke-width="0.5"/>' +
    '<polygon points="6.00,0.40 6.65,2.43 8.55,1.45 7.57,3.35 9.60,4.00 7.57,4.65 8.55,6.55 6.65,5.57 6.00,7.60 5.35,5.57 3.45,6.55 4.43,4.65 2.40,4.00 4.43,3.35 3.45,1.45 5.35,2.43" fill="currentColor"/>' +
    '<path d="M18 0.9L21.2 4 18 7.1 14.8 4z" fill="currentColor"/>',
};

/**
 * The three that came with the product keep its own shape exactly: this is
 * an addition to nine themes, not a restyle of the product.
 */
const PLAIN: Shape = { radius: '0.5rem', border: '1px', crown: 'none', mark: '' };

export const SHAPES: Record<string, Shape> = {
  ops: PLAIN,
  day: PLAIN,
  calm: PLAIN,

  /**
   * «نظيف» (18/11/2026, R1): the product's own corner and a hairline — no mark, no crown, no frieze. A plain card is the
   * whole point of the palette. Listed so that every palette has its slot; it is `PLAIN` itself, so `shapeCss` writes nothing.
   */
  clean: PLAIN,

  /** Cut corner, hard edge: a panel stamped out of metal. */
  cyber: {
    radius: '0.125rem',
    border: '1px',
    crown: 'notch',
    mark: '<path d="M4 12h5l2-4 2 8 2-4h5" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  },

  /** A pointed arch, and gold. */
  'islamic-epic': {
    radius: '0.75rem',
    border: '1px',
    crown: 'arch',
    mark: '<path d="M16.5 4.5a8 8 0 1 0 0 15 9.5 9.5 0 0 1 0-15z" fill="currentColor"/>',
    frieze: KHATAM,
  },

  /** The same arch, quieter — an eight-point seal instead of a crescent. */
  'islamic-calm': {
    radius: '0.75rem',
    border: '1px',
    crown: 'arch',
    mark: '<path d="M12 3l2.6 4.1L19 5.6l-.6 4.7 4.1 1.7-4.1 1.7.6 4.7-4.4-1.5L12 21l-2.6-4.1-4.4 1.5.6-4.7L1.5 12l4.1-1.7-.6-4.7 4.4 1.5z" fill="currentColor"/>',
    frieze: KHATAM,
  },

  /** A ringed planet. */
  space: {
    radius: '1rem',
    border: '1px',
    crown: 'none',
    mark: '<circle cx="12" cy="11" r="5" fill="currentColor"/><ellipse cx="12" cy="11" rx="10" ry="3.2" fill="none" stroke="currentColor" stroke-width="1.4" transform="rotate(-18 12 11)"/>',
  },

  /** A four-point compass rose. */
  sea: {
    radius: '0.375rem',
    border: '1px',
    crown: 'none',
    mark: '<path d="M12 2l2.2 7.8L22 12l-7.8 2.2L12 22l-2.2-7.8L2 12l7.8-2.2z" fill="currentColor"/>',
  },

  /** A cut corner and a sun that sets in lines. */
  city90: {
    radius: '0.125rem',
    border: '1px',
    crown: 'notch',
    mark: '<circle cx="12" cy="10" r="6" fill="currentColor"/><rect x="5" y="13" width="14" height="1.3" fill="var(--sys-card)"/><rect x="5" y="16" width="14" height="1.6" fill="var(--sys-card)"/>',
  },

  /** Soft art-deco corners, a hairline, and a half-sun of rays — the hotels' own fan. */
  'neon-coast': {
    radius: '0.875rem',
    border: '1px',
    crown: 'none',
    mark: '<path d="M3 19a9 9 0 0 1 18 0" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M12 19V8M12 19L6.4 9.6M12 19l5.6-9.4M12 19L3.6 14.6M12 19l8.4-4.4" fill="none" stroke="currentColor" stroke-width="1.3"/>',
  },

  /**
   * «ليل» wears the OCTAGRAM — the eight-pointed star of the brief, drawn
   * on a 24-grid as pure geometry: two squares, one upright and one turned
   * 45°, their tips at the sixteen points the brief listed. It is the same
   * seal `StarMark` spins, and the shape `KHATAM` strings along the two
   * Islamic themes — one family of stars across the product.
   */
  layl: {
    radius: '0.75rem',
    border: '1px',
    crown: 'none',
    mark:
      '<polygon points="2,7.8 7.8,2 16.2,2 22,7.8 22,16.2 16.2,22 7.8,22 2,16.2" fill="none" stroke="currentColor" stroke-width="1.4"/>' +
      '<path d="M2 7.8L16.2 22M22 7.8L7.8 22M22 16.2L7.8 2M16.2 2L2 16.2" stroke="currentColor" stroke-width="1"/>' +
      '<polygon points="12,8.4 13.6,10.4 16,12 13.6,13.6 12,16 10.4,13.6 8,12 10.4,10.4" fill="currentColor"/>',
  },

  /** A shield, and a heavier edge. */
  epic: {
    radius: '0.25rem',
    border: '2px',
    crown: 'none',
    mark: '<path d="M12 2l8 3v6c0 5-3.4 9.2-8 11-4.6-1.8-8-6-8-11V5z" fill="none" stroke="currentColor" stroke-width="1.8"/>',
  },

  /** A cut gem, and a hairline. */
  lux: {
    radius: '0.75rem',
    border: '1px',
    crown: 'none',
    mark: '<path d="M12 3l6 5-6 13-6-13z" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M6 8h12" stroke="currentColor" stroke-width="1.2"/>',
  },
};

/** The shape of a theme, falling back to the product's own. */
export function shapeOf(key: string): Shape {
  return SHAPES[key] ?? PLAIN;
}

/**
 * A `data:` URL for the corner glyph, in the theme's own border colour.
 *
 * The colour is the BORDER token and not a semantic one, and it is laid at
 * 7% — so the mark cannot be mistaken for «needs attention» and cannot
 * move the contrast of anything drawn over it. `encodeURIComponent` and
 * not base64: an SVG this small is shorter as text, and it stays readable
 * in the markup, which matters for a thing nobody can see.
 */
function tileUrl(color: string, w: number, h: number, opacity: string, body: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" fill="none" ` +
    `color="${color}" opacity="${opacity}">${body}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

function markUrl(theme: SystemTheme, body: string): string {
  return tileUrl(theme.vars['border-strong'], 24, 24, '0.07', body);
}

/**
 * The frieze, in the theme's own ACCENT — the gold of one, the green of the other — and never in a colour that means something:
 * a border colour would vanish on the card's own edge, and a warning colour along every card is a screen that is always warning.
 * At 60%, so it reads as an edge that has been worked and not as a line that has been drawn.
 */
function friezeUrl(theme: SystemTheme, f: Frieze): string {
  return tileUrl(theme.vars.primary, f.w, f.h, '0.6', f.body);
}

/**
 * The whole shape rule for one theme. Empty for a theme whose shape is the
 * product's own, so nothing is written that would change nothing.
 */
export function shapeCss(theme: SystemTheme): string {
  const s = shapeOf(theme.key);
  if (s === PLAIN) return '';
  const sel = `[data-sys-theme='${theme.key}'] .${CARD_CLASS}`;
  const parts: string[] = [];

  // Layers of ONE background, the mark first: nothing here is a pseudo-element over the content.
  const layers: { image: string; repeat: string; position: string; size: string }[] = [];
  if (s.mark) {
    // Top-LEFT: in RTL the heading starts at the right edge, so this is
    // the corner furthest from the words and from any figure beside
    // them. 22px, inset 10px — it touches nothing.
    layers.push({ image: markUrl(theme, s.mark), repeat: 'no-repeat', position: 'left 10px top 10px', size: '22px 22px' });
  }
  if (s.frieze) {
    // On the top edge, repeating along it, `h` tall: inside the padding, under the crown.
    layers.push({ image: friezeUrl(theme, s.frieze), repeat: 'repeat-x', position: 'left 0 top 0', size: `auto ${s.frieze.h}px` });
  }

  parts.push(
    `${sel}{position:relative;border-radius:${s.radius};border-width:${s.border}` +
      (layers.length
        ? `;background-image:${layers.map((l) => l.image).join(',')};` +
          `background-repeat:${layers.map((l) => l.repeat).join(',')};` +
          `background-position:${layers.map((l) => l.position).join(',')};` +
          `background-size:${layers.map((l) => l.size).join(',')}`
        : '') +
      `}`
  );

  if (s.crown === 'arch') {
    // Drawn ON the top edge and outside the padding: a 36px arch centred
    // above the card's own line. `overflow:visible` is not needed — it sits
    // inside the border box, in the 1px the border already occupies.
    parts.push(
      `${sel}::before{content:'';position:absolute;top:-1px;inset-inline-start:50%;` +
        `transform:translateX(50%);width:36px;height:10px;` +
        `border:${s.border} solid var(--sys-border);border-bottom:0;` +
        `border-start-start-radius:18px;border-start-end-radius:18px;` +
        `background:var(--sys-card);pointer-events:none}`
    );
  }

  if (s.crown === 'notch') {
    // One corner cut away rather than rounded — the same edge the palette
    // is: hard. `clip-path` and not a pseudo-element, so nothing is drawn
    // over the content and nothing can intercept a click.
    parts.push(`${sel}{clip-path:polygon(0 0,calc(100% - 14px) 0,100% 14px,100% 100%,0 100%)}`);
  }

  return parts.join('');
}
