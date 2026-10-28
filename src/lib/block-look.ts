import type { BlockLook, SectionType } from './landing-sections';
import { FONTS, stackFor } from './landing-theme';

/**
 * ONE INTENTION, THREE SCREEN SIZES — without three designs.
 *
 * The seller says "wide", "roomy", "large". Not 880px, not 64px, not 34px,
 * and never once per device. A phone, a tablet and a desktop are not three
 * layouts to keep in step by hand; they are one intention drawn at three
 * widths, and a second set of numbers per breakpoint is just a second set
 * to forget to update.
 *
 * Every value below is a `clamp()`: a floor for the phone, a ceiling for
 * the desktop, and a viewport-relative middle that moves smoothly between
 * them. So a page laid out on a laptop is already right on a phone — not
 * because somebody checked, but because there was never a separate phone
 * number to get wrong.
 *
 * An empty value means "whatever the page decided". That keeps the theme
 * in charge: a page where every block was set by hand is a page where
 * changing the theme changes nothing.
 */

/** Max width of the block's content. `full` spans the page, gutters aside. */
const WIDTH: Record<BlockLook['width'], string> = {
  narrow: 'min(100%, 34rem)',
  normal: 'min(100%, 48rem)',
  wide: 'min(100%, 64rem)',
  full: '100%',
};

/** Vertical breathing room. Small on a phone, generous on a desktop. */
const SPACE: Record<BlockLook['space'], string> = {
  none: '0',
  tight: 'clamp(8px, 2vw, 16px)',
  normal: 'clamp(20px, 5vw, 48px)',
  roomy: 'clamp(36px, 9vw, 96px)',
};

/** Inside a section block: the padding above and below, and the gap under its heading. Unset = the block's own. */
const INNER_PAD: Partial<Record<BlockLook['space'], { section: string; heading: string }>> = {
  none: { section: '0', heading: '6px' },
  tight: { section: '8px', heading: '10px' },
};

/** Text size, relative to the block's own base — never absolute px. */
const SCALE: Record<NonNullable<BlockLook['text']>['scale'], string> = {
  xs: '0.8em',
  s: '0.9em',
  m: '1em',
  l: '1.18em',
  xl: '1.4em',
};

const WEIGHT: Record<string, string> = {
  normal: '400',
  medium: '600',
  bold: '700',
  black: '800',
};

/** Google's name for each, for the stylesheet the page must load. */
export const GOOGLE_FAMILY: Record<string, string> = Object.fromEntries(
  FONTS.filter((f) => f.google).map((f) => [f.key, f.google!])
);

const ALIGN: Record<BlockLook['align'], string> = {
  start: 'right',
  center: 'center',
  end: 'left',
};

/** A hex colour we are willing to put in a style attribute, or ''. */
function safeColor(v: string | undefined): string {
  return v && /^#[0-9a-fA-F]{3,8}$/.test(v) ? v : '';
}

/** A same-origin image path. An absolute URL here would be a way out. */
function safeImage(v: string | undefined): string {
  return v && /^\/[A-Za-z0-9/_.\-?=&]*$/.test(v) ? v : '';
}

export interface LookStyles {
  /** Goes on the full-bleed wrapper: background, padding. */
  outer: React.CSSProperties;
  /** Goes on the content inside it: width, alignment, type. */
  inner: React.CSSProperties;
  /** True when a dark overlay must sit between the image and the text. */
  overlay: number;
  /**
   * CSS variables the block stylesheet reads: the heading colour and the
   * button's fill, label and size.
   *
   * Through variables rather than more selectors, because a heading and a
   * button want DIFFERENT colours from the body text, and one colour for
   * the whole block turned the words on a green button red.
   */
  vars: Record<string, string>;
}

export function lookStyles(look: BlockLook | undefined): LookStyles {
  const l = look ?? ({} as BlockLook);
  const bg = l.background ?? ({ kind: 'none' } as NonNullable<BlockLook['background']>);
  const t = l.text ?? ({} as NonNullable<BlockLook['text']>);

  const outer: React.CSSProperties = {
    paddingTop: SPACE[l.space ?? 'normal'],
    paddingBottom: SPACE[l.space ?? 'normal'],
  };

  const from = safeColor(bg.from);
  const to = safeColor(bg.to);
  const image = safeImage(bg.image);
  let overlay = 0;

  if (bg.kind === 'solid' && from) {
    outer.background = from;
  } else if (bg.kind === 'gradient' && from) {
    outer.background = `linear-gradient(${bg.angle ?? 160}deg, ${from}, ${to || from})`;
  } else if (bg.kind === 'image' && image) {
    outer.backgroundImage = `url("${image}")`;
    outer.backgroundSize = 'cover';
    outer.backgroundPosition = 'center';
    outer.position = 'relative';
    overlay = Math.min(0.8, Math.max(0, bg.overlay ?? 0.35));
  }

  const inner: React.CSSProperties = {
    maxWidth: WIDTH[l.width ?? 'normal'],
    // NO gutter here. Every block already carries its own — .lp-section is
    // 20px, .lp-hero is 20px, .lp-announce is 16px — and adding one more
    // around them stacked three gutters on a phone: the order form came out
    // 271px wide inside a 375px screen, a quarter of the width thrown away,
    // and the card looked squeezed and off-centre for no reason a seller
    // could see. One gutter, owned by the block, is enough.
    marginInline: 'auto',
    textAlign: ALIGN[l.align ?? 'center'] as React.CSSProperties['textAlign'],
    position: 'relative',
  };
  // A grid of cards (the trust row) lines its items up by justify-items, which text-align does not reach.
  const justify = l.align && l.align !== 'center' ? ALIGN[l.align] : '';

  if (t.scale && t.scale !== 'm') inner.fontSize = SCALE[t.scale];
  if (t.weight) inner.fontWeight = WEIGHT[t.weight];
  if (t.italic) inner.fontStyle = 'italic';
  if (t.font) inner.fontFamily = stackFor(t.font) || undefined;
  const color = safeColor(t.color);
  if (color) inner.color = color;
  // Text over a photograph is white unless the seller chose otherwise —
  // the overlay exists to make exactly that readable.
  else if (overlay > 0) inner.color = '#ffffff';

  const vars: Record<string, string> = {};
  if (justify) vars['--look-justify'] = justify;
  // A heading is its own decision; unset, it simply follows the body.
  const heading = safeColor(t.headingColor);
  if (heading) vars['--look-heading'] = heading;

  const b = l.button ?? ({} as NonNullable<BlockLook['button']>);
  const fill = safeColor(b.fill);
  const labelColor = safeColor(b.label);
  if (fill) vars['--look-btn-bg'] = fill;
  if (labelColor) vars['--look-btn-fg'] = labelColor;
  if (b.size && b.size !== 'm') {
    vars['--look-btn-pad'] = b.size === 's' ? '10px 22px' : '18px 52px';
    vars['--look-btn-size'] = b.size === 's' ? '0.9em' : '1.15em';
  }
  if (b.wide) {
    vars['--look-btn-width'] = '100%';
    vars['--look-btn-display'] = 'block';
  }
  // «التباعد يتحكم بالحشوة الداخلية كمان، بلا = صفر». `outer` above is only the space AROUND the block; a section
  // block keeps its own 30px inside and 18px under its heading, so «بلا» still left a tall white box. «بلا» and
  // «ضيّق» now reach inside too; «عادي» and «واسع» leave the block's own padding exactly as it was.
  const pad = INNER_PAD[l.space ?? 'normal'];
  if (pad) {
    vars['--look-section-pad'] = pad.section;
    vars['--look-h2-gap'] = pad.heading;
  }

  return { outer, inner, overlay, vars };
}

/** Which Google font families a page must load, given its blocks' choices. */
export function fontsUsed(looks: (BlockLook | undefined)[]): string[] {
  const set = new Set<string>();
  for (const l of looks) {
    const f = l?.text?.font;
    if (f && f !== 'system') set.add(f);
  }
  return [...set];
}


/**
 * Has the seller actually chosen anything here?
 *
 * The wrapper exists to carry a choice. A page nobody has styled must
 * render exactly as it did before any of this was built, and the old test
 * for that — "is there a look object?" — stopped working the moment the
 * schema started filling one in with defaults for every block. Every block
 * on every page silently gained a wrapper, and with it a second gutter.
 *
 * So the test is against the VALUES, not the presence of the object.
 */
export function isPlainLook(look: BlockLook | undefined): boolean {
  if (!look) return true;
  const t = look.text;
  const b = look.button;
  const bg = look.background;
  return (
    (look.width ?? 'normal') === 'normal' &&
    (look.align ?? 'center') === 'center' &&
    (look.space ?? 'normal') === 'normal' &&
    (!bg || bg.kind === 'none') &&
    (!t || (!t.font && (!t.scale || t.scale === 'm') && !t.weight && !t.italic && !t.color && !t.headingColor)) &&
    (!b || (!b.fill && !b.label && (!b.size || b.size === 'm') && !b.wide))
  );
}

/**
 * WHICH PARTS OF THE PANEL MEAN ANYTHING ON WHICH BLOCK.
 *
 * The panel offered «الزر» on a trust row and «لون العناوين» on an announcement bar — controls that changed a value
 * and nothing on the page. A part that is off for a block is still shown (marked, not removed), and pressing it says
 * why instead of pretending.
 *
 *   button    — the block draws a button the look reaches (.lp-cta / .lp-sticky).
 *   heading   — the block has a heading or item titles (h1–h4 or [data-it]).
 *   text      — the block has words the font, weight and italic reach.
 *   textColor — and the text colour too (the floating button's words take theirs from «الزر»).
 *   box       — width, alignment, spacing and background.
 *
 * The thank-you block is all off: its look never reaches the published thank-you screen.
 */
export interface LookParts {
  box: boolean;
  text: boolean;
  textColor: boolean;
  heading: boolean;
  button: boolean;
}

const NO_HEADING: readonly SectionType[] = ['announcement', 'urgency', 'sticky', 'thankyou'];
const HAS_BUTTON: readonly SectionType[] = ['hero', 'sticky'];

export function lookParts(type: SectionType): LookParts {
  if (type === 'thankyou') return { box: false, text: false, textColor: false, heading: false, button: false };
  // The floating button is fixed to the screen: no box around it, and its words' colour is the button's own.
  if (type === 'sticky') return { box: false, text: true, textColor: false, heading: false, button: true };
  return { box: true, text: true, textColor: true, heading: !NO_HEADING.includes(type), button: HAS_BUTTON.includes(type) };
}

/** Why a part does nothing on this block, in the seller's words. */
export function lookPartReason(type: SectionType, part: keyof LookParts): string {
  if (type === 'thankyou') return 'شكل صفحة الشكر ما بيوصل للصفحة المنشورة — بيتغيّر من قسم «بعد الطلب» بالنموذج.';
  if (part === 'button') {
    return type === 'form'
      ? 'زر الطلب بياخد «لون زر التأكيد» من «الدفع» بالمتجر، وإذا ما في لون هناك بياخد اللون الأساسي للصفحة.'
      : 'هالقسم ما فيه زر.';
  }
  if (part === 'heading') return 'هالقسم ما فيه عناوين — لونه من «لون النص».';
  if (part === 'textColor') return 'لون كلمات الزر من تبويب «الزر».';
  return type === 'sticky' ? 'الزر العائم مثبّت أسفل الشاشة — ما إله اتساع ولا خلفية.' : 'هالخيار ما بيأثّر على هالقسم.';
}

/**
 * A look pasted onto a block keeps only the parts that mean something there. «لصق الشكل» wrote a background and a
 * width onto the floating button — values its panel no longer offers to undo.
 */
export function lookForType(type: SectionType, look: BlockLook, defaults: BlockLook): BlockLook {
  const p = lookParts(type);
  return {
    ...look,
    ...(p.box ? {} : { width: defaults.width, align: defaults.align, space: defaults.space, background: defaults.background }),
    text: p.text
      ? { ...look.text, ...(p.textColor ? {} : { color: defaults.text.color }), ...(p.heading ? {} : { headingColor: defaults.text.headingColor }) }
      : defaults.text,
    button: p.button ? look.button : defaults.button,
  };
}
