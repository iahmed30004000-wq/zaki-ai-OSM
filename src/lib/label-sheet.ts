import { code128Bars, encodableCode128 } from './labels';
import { STORE_LOGO_PREFIX } from './store-logo';

/**
 * THE PRINTED SHEET OF WAYBILLS, AS A STRING.
 *
 * Pure, so it can be measured and tested. The page it produces is
 * standalone — not the application with the rest hidden — so what makes it
 * fast or slow, legible or not, is what it contains.
 *
 * Four rules decide the layout, each learned from a waybill that failed:
 *
 *   THE SCANNABLE PARTS ARE NEVER CLIPPED. The COD, the courier barcode and
 *   the QR sit in fixed rows; the recipient block and the contents are the
 *   rows that give way. The old layout was one flex column under
 *   overflow:hidden with the codes last, so a long address or a few more
 *   items clipped the barcode first — and at A5 and A4 the QR was cut off by
 *   11 and 27 mm on every label.
 *
 *   A BARCODE HAS QUIET ZONES. Ten modules of white each side, drawn into
 *   the symbol itself, so no neighbouring element can crowd them.
 *
 *   SIZE DECIDES WHAT FITS. A 40 mm label cannot hold what a 150 mm one can;
 *   rather than clip at random, each size tier says what it drops, in order
 *   of what a driver needs least.
 *
 *   THE CODES FOLLOW THE PAPER; THE TYPE HAS A FLOOR. The barcode, the QR
 *   and the padding follow the millimetres. The type starts at a floor a
 *   thermal head prints legibly, drops lines before it shrinks, and grows
 *   into whatever room the label's own text leaves — see fitFor(). On 2/11
 *   the type followed the paper's ratio to 100×150 too, and a 100×100
 *   sticker came out at 6 pt round an empty middle: «مو واضحة ابدا».
 *
 *   PRINTING — NOT OPENING — COMMITS THE LABEL. The page reports which orders
 *   went to the printer on `beforeprint`, which catches the print button,
 *   the print runs and Ctrl+P alike. Opening the page, reloading it, or
 *   saving a PDF commits nothing: a label that exists only on screen seals
 *   no order and blocks no cancellation.
 */

export interface LabelItem {
  name: string;
  qty: number;
  /** An upsell accepted after ordering — marked, so the packer does not miss it. */
  addOn?: boolean;
}

export interface LabelView {
  /** Sent back when the label is printed; never shown. */
  orderId: string;
  courier: string;
  /** Our reference — the QR. */
  ref: string;
  /** The courier's tracking number, or our reference when there is none yet. */
  courierCode: string;
  name: string;
  /** Primary first; the alternative number when there is one. */
  phones: string[];
  /** placeLine(): the governorate once, then the rest of the address. */
  place: string;
  items: LabelItem[];
  /** The customer's own note — the only note that belongs on a courier's document. */
  note?: string | null;
  /** Already formatted with the currency's decimals. */
  cod: string;
  /** Pre-rendered QR svg (async library, so the caller makes it). */
  qrSvg: string;
}

export interface SheetStore {
  name: string;
  /** Only a first-party URL is drawn; see storeLogoForPrint(). */
  logoUrl?: string | null;
  supportPhone?: string | null;
}

export interface SheetSize {
  /** Label size in millimetres. */
  width: number;
  height: number;
  /** Paper size; omitted means the paper IS the label (a thermal roll). */
  sheetWidth?: number;
  sheetHeight?: number;
}

export interface SheetOptions {
  store: SheetStore;
  /** 'print' commits labels when printed; 'pdf' never does. */
  mode: 'print' | 'pdf';
  /** The batch token, echoed back when printing is reported. */
  token: string;
  /** Where printing is reported. */
  stampUrl: string;
  /** Orders that were asked for and are not on this sheet, and why. */
  skipped?: { orderNumber: string; reason: string }[];
  /**
   * Orders that ARE on this sheet only because the owner's key (`ops.labels_any`) printed them past the rule, and which rule.
   * Said above the labels, never on paper, so whoever prints knows these are copies that commit nothing.
   */
  outsideTheRule?: { orderNumber: string; reason: string }[];
  /** A file-name-like title; Chromium suggests it when saving a PDF. */
  title?: string;
}

/**
 * Labels per print run when the batch is large. A print preview of two
 * hundred pages is rasterised in one blocking pass; fifty is a run a
 * thermal printer finishes before anybody wonders whether it hung.
 */
export const PRINT_CHUNK = 50;

export type Tier = 'tiny' | 'compact' | 'standard' | 'large';

/**
 * What a label of this size can hold at most.
 *
 *   tiny      < 70 mm either way — barcode, COD, name, phone, one line of place
 *   compact   < 95 wide or < 110 tall (100×100, 150×100) — adds logo, QR, the item lines
 *   standard  the rest (100×150, A6, 100×200) — everything
 *   large     BOTH sides at least 140 (A5, A4) — everything, more note lines
 *
 * Large is decided by the SHORT side. It used to be «more than 110 wide or
 * more than 160 tall», so a 100 mm wide label 200 tall counted as A4.
 */
export function tierFor(size: SheetSize): Tier {
  const { width: w, height: h } = size;
  if (w < 70 || h < 70) return 'tiny';
  if (w < 95 || h < 110) return 'compact';
  if (Math.min(w, h) >= 140) return 'large';
  return 'standard';
}

/** At most this many item lines, however tall the paper. */
const MAX_ITEMS = 12;

/**
 * What each tier MAY show. Whether it does is fitFor()'s: a line the paper
 * has no room for at the floor type size is dropped, never shrunk.
 */
const TIER = {
  tiny: { qr: false, items: 0, note: 0, place: 1 },
  compact: { qr: true, items: MAX_ITEMS, note: 1, place: 3 },
  standard: { qr: true, items: MAX_ITEMS, note: 2, place: 3 },
  large: { qr: true, items: MAX_ITEMS, note: 3, place: 3 },
} as const;

/** The floor the type never goes under where the paper can hold it (≥ 50 mm tall, ≥ 60 wide). */
export const FLOOR_PT = { body: 9, name: 13, phones: 12, codAmount: 14 } as const;

/**
 * The type sizes of one label at scale 1, in points — and scale 1 is the
 * FLOOR. «مو واضحة ابدا»: on 2/11 the scale started following the paper's
 * ratio to 100×150, so a 100×100 sticker printed its body at 6 pt and its
 * COD at 9 — under what a 203-dpi thermal head draws legibly. These are
 * the smallest a waybill prints at on any paper of 50 mm or more, every
 * one at least what the pre-2/11 label printed at the same size.
 */
const PT = {
  body: FLOOR_PT.body,
  brand: 10,
  courier: 8,
  courierRef: 9,
  name: FLOOR_PT.name,
  phones: FLOOR_PT.phones,
  codLabel: 8,
  // One point over its floor: the number the driver collects stands out.
  codAmount: FLOOR_PT.codAmount + 1,
  caption: 8,
  foot: 8,
  tag: 7,
} as const;

const PT_MM = 25.4 / 72;
/** The label's line height, and the name's. */
const LINE = 1.35;
const NAME_LINE = 1.2;
/**
 * Millimetres at scale 1: the gap between rows, the paddings inside the rows,
 * the rules. Rules are black and do not scale — a hairline grey rule is
 * what a thermal head drops first.
 */
const MM = {
  gap: 1.4, tightGap: 0.6, headPad: 1.2, headRule: 0.5, codPad: 1.2, tightCodPad: 0.5, codBorder: 0.6, codSide: 2.2,
  captionTop: 0.4, footPad: 0.8, footRule: 0.3, bodyPad: 1, bodyRule: 0.3, noteTop: 0.8,
} as const;
/** The dashed outline of a label, one CSS pixel each side. */
const OUTLINE_MM = 25.4 / 96;
/** The most a label is ever scaled up; A4 sits under it. */
const MAX_SCALE = 2.2;
/**
 * Millimetres of width per unit of scale the type may grow to: a 100 mm
 * label grows to about 1.55 (body 14 pt, name 20, COD 23) and no further —
 * past that a waybill reads as a poster, and the COD and the phones wrap.
 */
const WIDTH_PER_SCALE = 60;

/**
 * How wide one character is, as a share of the type size — set on the
 * generous side, so a line is counted as wrapping a little before it does
 * and the scale never grows into a clipped address. Measured in Chrome on
 * Tahoma: bold Arabic 0.47–0.58 em a character (a short name is the
 * widest), regular 0.44–0.50, phone digits 0.64.
 */
const ADV = { regular: 0.55, bold: 0.6, digits: 0.65 } as const;
/** «المبلغ عند الاستلام» — the label of the COD box: 8.9 em in Tahoma bold, counted as 9.3. */
const COD_LABEL = 'المبلغ عند الاستلام';
const COD_LABEL_EM = 9.3;
/** The same box on a sticker too narrow for both on one line: «المبلغ», 2.9 em, counted as 3.4. */
const COD_SHORT = 'المبلغ';
const COD_SHORT_EM = 3.4;
const NOTE_LEAD = 'ملاحظة: ';

/** One line of text this size, in millimetres, at scale `s`. */
const lineMm = (pt: number, s: number, line = LINE) => pt * PT_MM * line * s;
const charMm = (pt: number, s: number, adv: number) => pt * PT_MM * s * adv;
const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The scale the label printed at BEFORE 2/11, for this paper: four steps by
 * size. Kept only as a floor: no paper prints smaller type than it did then.
 * Every size in PT is at least the pre-2/11 one, so a scale at least this
 * one is type at least that big.
 */
export function legacyScale(size: SheetSize): number {
  const { width: w, height: h } = size;
  if (w < 70 || h < 70) return 0.78;
  if (w < 95 || h < 110) return 0.9;
  if (w <= 110 && h <= 160) return 1;
  return 1.3;
}

/**
 * The scale of the barcode, the QR and the padding — the millimetres
 * themselves, as on 2/11: min(width / 100, height / 150), 0.7 to 2.2. The
 * codes keep exactly the size they print at today; only the TYPE is no
 * longer tied to it.
 */
function codeScale(size: SheetSize): number {
  return r2(Math.min(MAX_SCALE, Math.max(0.7, Math.min(size.width / 100, size.height / 150))));
}

/** What one label has to say — the parts whose length decides how many lines. */
export interface LabelNeed {
  name: string;
  /** Our reference, printed under the QR. */
  ref?: string;
  phones: string[];
  place: string;
  note?: string | null;
  /** How many item rows the order has. */
  items: number;
  cod: string;
  /** The store has a support number for the footer. */
  foot: boolean;
}

/** What the label shows; the plan the drop order works down. */
interface Show {
  head: boolean;
  /** One-line header (the courier's name and the logo off) and narrower gaps between rows. */
  tight: boolean;
  /** The contents row: the item lines or the count line, and the note. */
  body: boolean;
  /** The COD box says «المبلغ», not «المبلغ عند الاستلام», so the amount keeps its line. */
  codShort: boolean;
  qr: boolean;
  foot: boolean;
  place: number;
  note: number;
  /** Item lines; 0 is the one count line («2 قطع»). */
  items: number;
}

export interface LabelFit {
  tier: Tier;
  /** The scale the TYPE is drawn at: the label's `--s`. Never under 1 where the paper is 50 mm tall or more. */
  fit: number;
  /** The scale of the codes and the padding: today's min(w/100, h/150). */
  codes: number;
  /** Millimetres; the QR is 0 when it is left off. */
  qr: number;
  bar: number;
  pad: number;
  /** Item lines shown — 0 means the count line only. */
  items: number;
  note: number;
  place: number;
  head: boolean;
  /** One-line header and narrow gaps — a short paper. */
  tight: boolean;
  /** The contents row is printed (items or count, note). */
  body: boolean;
  /** The COD box's short label. */
  codShort: boolean;
  foot: boolean;
  /** The type sizes actually printed, in points. */
  pt: { body: number; name: number; phones: number; codAmount: number };
  /**
   * The reference under the QR, in points: the caption size, or less where
   * the QR is narrower than the reference at that size — the QR's width is
   * the codes' and a bigger caption would be cut to «SY-1…».
   */
  qrCaptionPt: number;
  /** The height inside the padding and outline. */
  usableMm: number;
  /**
   * What the rows that never give way take — header, COD, codes, footer, the
   * gaps between rows, and the name and phone line of the recipient — so a
   * test can hold that they fit the paper.
   */
  reservedMm: number;
  /** reservedMm plus every line the label prints: place, items, note. */
  fullMm: number;
}

/** The heaviest label a tier may print: the longest address, a note, every item line. */
function worstNeed(tier: Tier): LabelNeed {
  return {
    name: 'عبد الرحمن محمد الشمري',
    phones: ['0791234567', '0781111111'],
    place: 'ع'.repeat(400),
    note: TIER[tier].note > 0 ? 'ع'.repeat(400) : null,
    items: TIER[tier].items + 1,
    cod: '1,250.000 JOD',
    foot: true,
  };
}

interface Geometry {
  size: SheetSize;
  tier: Tier;
  c: number;
  qr: number;
  bar: number;
  pad: number;
  innerW: number;
  usable: number;
}

const wraps = (chars: number, perChar: number, width: number) => Math.max(1, Math.ceil((chars * perChar) / width));

/** How many lines each wrapping part takes at scale `s`. */
function linesAt(g: Geometry, need: LabelNeed, s: number, codShort = false) {
  const phonesText = need.phones.filter(Boolean).join('  ·  ');
  const codW =
    charMm(PT.codLabel, s, codShort ? COD_SHORT_EM : COD_LABEL_EM) +
    need.cod.length * charMm(PT.codAmount, s, ADV.digits) +
    2 * MM.codSide * s + 2 * MM.codBorder + 2;
  return {
    place: wraps(need.place.length, charMm(PT.body, s, ADV.bold), g.innerW),
    note: need.note ? wraps(NOTE_LEAD.length + need.note.length, charMm(PT.body, s, ADV.regular), g.innerW) : 0,
    phones: phonesText ? wraps(phonesText.length, charMm(PT.phones, s, ADV.digits) + 0.11, g.innerW) : 0,
    cod: codW > g.innerW ? 2 : 1,
    nameFits: need.name.length * charMm(PT.name, s, ADV.bold) <= g.innerW,
  };
}

/** The height of one label, in millimetres, at scale `s` with `show`. */
function heightAt(g: Geometry, need: LabelNeed, s: number, show: Show) {
  const L = linesAt(g, need, s, show.codShort);
  const body = lineMm(PT.body, s);
  const head = !show.head
    ? 0
    : (show.tight
        ? Math.max(lineMm(PT.brand, s), lineMm(PT.courierRef, s))
        : Math.max(lineMm(PT.courier, s) + lineMm(PT.courierRef, s), 7 * s)) +
      MM.headPad * s + MM.headRule;
  const cod =
    (L.cod === 1 ? lineMm(PT.codAmount, s) : lineMm(PT.codAmount, s) + lineMm(PT.codLabel, s)) +
    2 * (show.tight ? MM.tightCodPad : MM.codPad) * s + 2 * MM.codBorder;
  const codes = Math.max(g.bar, show.qr ? g.qr : 0) + lineMm(PT.caption, s) + MM.captionTop;
  const foot = show.foot ? lineMm(PT.foot, s) + MM.footPad * s + MM.footRule : 0;
  // Six rows in the grid, five gaps — an empty row keeps its gap.
  const gaps = 5 * (show.tight ? MM.tightGap : MM.gap) * s;
  const who = lineMm(PT.name, s, NAME_LINE) + L.phones * lineMm(PT.phones, s);
  const reserved = head + cod + codes + foot + gaps + who;

  const place = Math.min(show.place, L.place);
  const note = show.body ? Math.min(show.note, L.note) : 0;
  const itemLines = !show.body
    ? 0
    : show.items === 0
      ? 1
      : Math.min(show.items, need.items) + (need.items > show.items ? 1 : 0);
  const full =
    reserved +
    (place + note + itemLines) * body +
    (note > 0 ? MM.noteTop * s : 0) +
    (show.body ? MM.bodyPad * s + MM.bodyRule : 0);
  return { reserved, full, lines: L };
}

/**
 * What to give up, in order of what a driver needs least, when the paper
 * cannot hold everything at the floor type size: the footer; item lines
 * down to four; the note down to one line; items down to two; the note;
 * items down to one; the third address line; then a one-line header and
 * narrow gaps; the second address line; the item line for the count
 * («2 قطع»); the QR (our reference — the courier scans the barcode); the
 * count line; the header; and last the long words of the COD box. The name, the phones, one address line,
 * the COD and the barcode are never given up.
 */
function* dropOrder(start: Show): Generator<Show> {
  let s = { ...start };
  if (s.foot) yield (s = { ...s, foot: false });
  while (s.items > 4) yield (s = { ...s, items: s.items - 1 });
  while (s.note > 1) yield (s = { ...s, note: s.note - 1 });
  while (s.items > 2) yield (s = { ...s, items: s.items - 1 });
  if (s.note > 0) yield (s = { ...s, note: 0 });
  if (s.items > 1) yield (s = { ...s, items: 1 });
  if (s.place > 2) yield (s = { ...s, place: 2 });
  if (!s.tight) yield (s = { ...s, tight: true });
  if (s.place > 1) yield (s = { ...s, place: 1 });
  if (s.items > 0) yield (s = { ...s, items: 0 });
  if (s.qr) yield (s = { ...s, qr: false });
  if (s.body) yield (s = { ...s, body: false });
  if (s.head) yield (s = { ...s, head: false });
  if (!s.codShort) yield (s = { ...s, codShort: true });
}

/**
 * HOW BIG, FROM WHAT THE LABEL SAYS AND THE PAPER IT IS ON.
 *
 *   1. The codes, the QR and the padding follow the millimetres — today's
 *      min(width / 100, height / 150), unchanged.
 *   2. The type starts at the floor: scale 1, or the pre-2/11 scale where
 *      that was bigger (A5, A4, 100×200).
 *   3. If what this label says does not fit at the floor, lines are dropped
 *      in dropOrder() — the type is not shrunk. Only a paper under 50 mm
 *      tall, which cannot hold a barcode and four lines at 9 pt, goes under
 *      scale 1, and never under what it printed at before 2/11.
 *   4. If it fits with room left, the type grows into the room — up to where
 *      the name, the phones or the COD would start to wrap, or 2.2 — so a
 *      100×100 sticker is not a few small lines round a big blank middle.
 *
 * Without `need`, the heaviest label the tier may print.
 */
export function fitFor(size: SheetSize, need?: LabelNeed): LabelFit {
  const tier = tierFor(size);
  const t = TIER[tier];
  const c = codeScale(size);
  const pad = r2(3.5 * c);
  const g: Geometry = {
    size,
    tier,
    c,
    qr: t.qr ? r2(22 * c) : 0,
    bar: r2(14 * c),
    pad,
    innerW: size.width - 2 * pad - 2 * OUTLINE_MM,
    usable: size.height - 2 * pad - 2 * OUTLINE_MM,
  };
  const asked = need ?? worstNeed(tier);
  // The smallest label prints the first number only (labelHtml).
  const n = tier === 'tiny' ? { ...asked, phones: asked.phones.slice(0, 1) } : asked;
  const floor = Math.max(1, legacyScale(size));

  const want: Show = {
    head: true,
    tight: false,
    body: true,
    codShort: false,
    qr: t.qr,
    foot: n.foot && tier !== 'tiny',
    place: t.place,
    note: n.note ? t.note : 0,
    items: t.items === 0 ? 0 : Math.min(t.items, Math.max(1, n.items)),
  };
  const fits = (s: number, show: Show) => heightAt(g, n, s, show).full <= g.usable;

  let show = want;
  let s = floor;
  if (!fits(s, show)) {
    for (const next of dropOrder(want)) {
      show = next;
      if (fits(s, show)) break;
    }
    // Nothing left to drop: a paper this short goes under the floor, never
    // under what it printed at before 2/11.
    const least = legacyScale(size);
    while (!fits(s, show) && s - 0.01 >= least) s = r2(s - 0.01);
  } else {
    // Grow while it still fits, the name still fits its one line, and up to
    // a size the width carries (a 100 mm label: about 1.55, body 14 pt).
    const nameFitsAtFloor = linesAt(g, n, floor).nameFits;
    const cap = Math.max(floor, Math.min(MAX_SCALE, g.innerW / WIDTH_PER_SCALE));
    while (s + 0.01 <= cap) {
      const next = r2(s + 0.01);
      if (!fits(next, show)) break;
      if (nameFitsAtFloor && !linesAt(g, n, next).nameFits) break;
      s = next;
    }
  }

  const h = heightAt(g, n, s, show);
  return {
    tier,
    fit: s,
    codes: c,
    qr: show.qr ? g.qr : 0,
    bar: g.bar,
    pad,
    items: show.items,
    note: show.note,
    place: show.place,
    head: show.head,
    tight: show.tight,
    body: show.body,
    codShort: show.codShort,
    foot: show.foot,
    qrCaptionPt: show.qr ? qrCaption(g.qr, n.ref ?? '', s, c) : 0,
    pt: {
      body: r2(PT.body * s),
      name: r2(PT.name * s),
      phones: r2(PT.phones * s),
      codAmount: r2(PT.codAmount * s),
    },
    usableMm: g.usable,
    reservedMm: h.reserved,
    fullMm: h.full,
  };
}

/**
 * Bold capitals and digits with .3px spacing, counted generously: 0.68 em
 * and 0.08 mm a character. Never under 2/11's caption (7 pt × the codes),
 * where a long reference is still cut at the QR's edge — the same reference
 * is printed in the header, bold, at 9 pt or more.
 */
function qrCaption(qrMm: number, ref: string, s: number, c: number): number {
  const n = Math.max(1, ref.length);
  const fits = (qrMm - n * 0.08) / (n * 0.68 * PT_MM);
  return r2(Math.max(7 * c, Math.min(PT.caption * s, fits)));
}

/** What a label's own text asks of the paper. */
export function needOf(l: LabelView, store: SheetStore): LabelNeed {
  return {
    name: l.name,
    ref: l.ref,
    phones: l.phones,
    place: l.place,
    note: l.note,
    items: l.items.length,
    cod: l.cod,
    foot: Boolean(store.supportPhone),
  };
}

export function esc(value: string): string {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  );
}

/** Ten modules of white each side — the Code 128 quiet zone. */
export const QUIET_MODULES = 10;

/**
 * A Code 128 barcode as ONE svg path, its quiet zones drawn into the symbol.
 *
 * One path for the whole symbol: the old one-rect-per-bar version put about
 * ten thousand elements into a run of two hundred labels. `crispEdges` keeps
 * bars from being anti-aliased into grey, which a scanner reads as width.
 */
export function barcodeSvg(value: string, heightMm: number): string {
  const bars = code128Bars(value);
  const total = bars.reduce((a, b) => a + b, 0) + QUIET_MODULES * 2;
  let x = QUIET_MODULES;
  let dark = true;
  let d = '';
  for (const w of bars) {
    if (dark) d += `M${x} 0h${w}v10h-${w}z`;
    x += w;
    dark = !dark;
  }
  return (
    `<svg viewBox="0 0 ${total} 10" preserveAspectRatio="none" width="100%" height="${heightMm}mm" ` +
    `shape-rendering="crispEdges" role="img" aria-label="${esc(encodableCode128(value))}">` +
    `<path d="${d}" fill="#000"/></svg>`
  );
}

/** How many labels one sheet holds. A sheet that fits none still gets one per page rather than clipping it. */
export function labelsPerPage(size: SheetSize): number {
  const pageW = size.sheetWidth ?? size.width;
  const pageH = size.sheetHeight ?? size.height;
  const across = Math.max(1, Math.floor(pageW / size.width));
  const down = Math.max(1, Math.floor(pageH / size.height));
  return Math.max(1, across * down);
}

function itemsHtml(items: LabelItem[], max: number): string {
  if (max === 0) {
    const units = items.reduce((s, i) => s + i.qty, 0);
    return `<p class="count">${units} ${units === 1 ? 'قطعة' : 'قطع'}</p>`;
  }
  const shown = items.slice(0, max);
  const more = items.length - shown.length;
  return (
    `<ul class="items">` +
    shown
      .map(
        (i) =>
          `<li><span class="iname">${esc(i.name)}</span>` +
          (i.addOn ? `<span class="tag">إضافة</span>` : '') +
          `<b class="qty">×${i.qty}</b></li>`
      )
      .join('') +
    (more > 0 ? `<li class="more">و${more} ${more === 1 ? 'صنف آخر' : 'أصناف أخرى'}</li>` : '') +
    `</ul>`
  );
}

function labelHtml(l: LabelView, size: SheetSize, store: SheetStore): string {
  // Each label is fitted to what IT says: a one-item order with a short
  // address grows into the room a twelve-item one needs for its list.
  const t = fitFor(size, needOf(l, store));
  const tier = t.tier;
  const code = encodableCode128(l.courierCode);
  const logo =
    store.logoUrl && tier !== 'tiny' ? `<img class="logo" src="${esc(store.logoUrl)}" alt="">` : '';
  const phones = (tier === 'tiny' ? l.phones.slice(0, 1) : l.phones).filter(Boolean);

  return `<section class="label${t.tight ? ' tight' : ''}" data-order="${esc(l.orderId)}" style="--s: ${t.fit}${t.qr > 0 ? `; --qr: ${t.qr}mm; --qrcap: ${t.qrCaptionPt}pt` : ''}">
  ${
    t.head
      ? `<header class="head">
    <div class="brand">${logo}<strong>${esc(store.name)}</strong></div>
    <div class="courier"><span>${esc(l.courier)}</span><b dir="ltr">${esc(l.ref)}</b></div>
  </header>`
      : ''
  }
  <div class="who">
    <p class="name">${esc(l.name)}</p>
    ${phones.length ? `<p class="phones" dir="ltr">${phones.map(esc).join('  ·  ')}</p>` : ''}
    <p class="place" style="-webkit-line-clamp:${t.place}">${esc(l.place)}</p>
  </div>
  ${
    t.body
      ? `<div class="body">
    ${itemsHtml(l.items, t.items)}
    ${l.note && t.note > 0 ? `<p class="note" style="-webkit-line-clamp:${t.note}"><b>ملاحظة:</b> ${esc(l.note)}</p>` : ''}
  </div>`
      : ''
  }
  <div class="cod"><span>${t.codShort ? COD_SHORT : COD_LABEL}</span><strong dir="ltr">${esc(l.cod)}</strong></div>
  <div class="codes">
    <figure class="barcode">${barcodeSvg(l.courierCode, t.bar)}<figcaption dir="ltr">${esc(code)}</figcaption></figure>
    ${t.qr > 0 ? `<figure class="qr">${l.qrSvg}<figcaption dir="ltr">${esc(l.ref)}</figcaption></figure>` : ''}
  </div>
  ${
    store.supportPhone && t.foot
      ? `<footer class="foot">للاستفسار: <span dir="ltr">${esc(store.supportPhone)}</span></footer>`
      : ''
  }
</section>`;
}

/**
 * The label's own stylesheet — the part that reaches the paper. Kept apart
 * from the page chrome (toolbar, setup line) so a test can read exactly
 * what prints, and hold it to black ink.
 *
 * Ink: every text and rule is #000. A grey rule (#d0d5dd) or a grey text
 * (opacity .75) is dithered by a 203-dpi thermal head into dots that do
 * not read; the name, the phones, the address and the COD are bold.
 *
 * The COD box was white type on a black background. Chrome's print dialog
 * leaves «Background graphics» off by default, and then the amount is
 * white on white — the one number the driver collects. It is now black
 * bold type inside a thick black border: nothing to drop.
 */
export const LABEL_CSS = `  .label { overflow: hidden; display: grid; gap: calc(${MM.gap}mm * var(--s));
           /* Header, COD, codes and footer always take their full height.
              The recipient block and the contents give way — never the
              barcode. Each part names its row, so a label that leaves the
              header off does not slide the recipient into the header's row. */
           grid-template-rows: auto minmax(0, max-content) minmax(0, 1fr) auto auto auto;
           border: 1px dashed #000; color: #000; background: #fff;
           font-size: calc(${PT.body}pt * var(--s)); line-height: ${LINE}; }
  .label > .head { grid-row: 1; } .label > .who { grid-row: 2; } .label > .body { grid-row: 3; }
  .label > .cod { grid-row: 4; } .label > .codes { grid-row: 5; } .label > .foot { grid-row: 6; }

  .head { display: flex; justify-content: space-between; align-items: center; gap: 2mm;
          padding-bottom: calc(${MM.headPad}mm * var(--s)); border-bottom: ${MM.headRule}mm solid #000; }
  .brand { display: flex; align-items: center; gap: 1.5mm; min-width: 0; }
  .brand strong { font-size: calc(${PT.brand}pt * var(--s)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .logo { height: calc(7mm * var(--s)); max-width: calc(22mm * var(--s)); object-fit: contain; }
  .courier { display: flex; flex-direction: column; align-items: flex-end; flex-shrink: 0;
             font-size: calc(${PT.courier}pt * var(--s)); }
  .courier b { font-size: calc(${PT.courierRef}pt * var(--s)); letter-spacing: .3px; }
  /* A short paper: the header on one line, the rows closer together. */
  .label.tight { gap: calc(${MM.tightGap}mm * var(--s)); }
  .tight .logo, .tight .courier span { display: none; }
  .tight .cod { padding-top: calc(${MM.tightCodPad}mm * var(--s)); padding-bottom: calc(${MM.tightCodPad}mm * var(--s)); }

  .who { overflow: hidden; }
  .who p { margin: 0; }
  .name { font-size: calc(${PT.name}pt * var(--s)); font-weight: bold; line-height: ${NAME_LINE};
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .phones { font-size: calc(${PT.phones}pt * var(--s)); font-weight: bold; letter-spacing: .4px; text-align: right; }
  .place { font-weight: bold; display: -webkit-box; -webkit-box-orient: vertical; overflow: hidden; }

  .body { overflow: hidden; border-top: ${MM.bodyRule}mm solid #000; padding-top: calc(${MM.bodyPad}mm * var(--s)); }
  .items { margin: 0; padding: 0; list-style: none; }
  .items li { display: flex; align-items: baseline; gap: 1.5mm; }
  .items .iname { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .items .qty { flex-shrink: 0; }
  .tag { flex-shrink: 0; border: 0.3mm solid #000; border-radius: 0.8mm; padding: 0 1mm;
         font-size: calc(${PT.tag}pt * var(--s)); font-weight: bold; }
  .count { margin: 0; font-weight: bold; }
  .note { margin: calc(${MM.noteTop}mm * var(--s)) 0 0; display: -webkit-box; -webkit-box-orient: vertical; overflow: hidden; }

  /* The number the driver collects: a thick black frame, black bold type. */
  .cod { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; column-gap: 2mm;
         border: ${MM.codBorder}mm solid #000; border-radius: 1mm; background: #fff; color: #000; font-weight: bold;
         padding: calc(${MM.codPad}mm * var(--s)) calc(${MM.codSide}mm * var(--s)); font-size: calc(${PT.codLabel}pt * var(--s)); }
  .cod strong { font-size: calc(${PT.codAmount}pt * var(--s)); letter-spacing: .3px; white-space: nowrap; }

  /* The gap beside the QR follows the codes, not the type: a bigger name
     must not take width from the barcode's bars. */
  .codes { display: flex; align-items: flex-end; gap: calc(2.5mm * var(--c)); }
  figure { margin: 0; text-align: center; }
  .barcode { flex: 1; min-width: 0; }
  .qr { flex-shrink: 0; width: var(--qr); }
  .qr svg { display: block; width: var(--qr); height: var(--qr); }
  .qr figcaption { font-size: var(--qrcap); letter-spacing: .3px; }
  figcaption { font-size: calc(${PT.caption}pt * var(--s)); font-weight: bold; letter-spacing: 1px; margin-top: ${MM.captionTop}mm;
               white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  .foot { font-size: calc(${PT.foot}pt * var(--s)); text-align: center; border-top: ${MM.footRule}mm solid #000;
          padding-top: calc(${MM.footPad}mm * var(--s)); }
`;

export function renderLabelSheet(labels: LabelView[], size: SheetSize, opts: SheetOptions): string {
  const pageW = size.sheetWidth ?? size.width;
  const pageH = size.sheetHeight ?? size.height;
  const perPage = labelsPerPage(size);
  const pages = Math.ceil(labels.length / perPage);
  const t = fitFor(size);
  const pdf = opts.mode === 'pdf';

  const sheets: string[] = [];
  for (let p = 0; p < pages; p++) {
    const chunk = labels.slice(p * perPage, (p + 1) * perPage);
    const run = Math.floor((p * perPage) / PRINT_CHUNK);
    sheets.push(
      `<div class="page" data-run="${run}">${chunk.map((l) => labelHtml(l, size, opts.store)).join('')}</div>`
    );
  }

  // PDF mode is one file of everything; runs exist only to keep a printer honest.
  const runs = pdf ? 1 : Math.ceil(labels.length / PRINT_CHUNK);
  const chunked = runs > 1;

  const runRules = chunked
    ? Array.from({ length: runs }, (_, r) => `body[data-run="${r}"] .page:not([data-run="${r}"]) { display: none; }`).join(' ')
    : '';

  const runButtons = chunked
    ? Array.from({ length: runs }, (_, r) => {
        const from = r * PRINT_CHUNK + 1;
        const to = Math.min((r + 1) * PRINT_CHUNK, labels.length);
        return `<button type="button" class="run" data-print-run="${r}">${from}–${to}</button>`;
      }).join('')
    : '';

  const skipped = opts.skipped ?? [];
  const outside = opts.outsideTheRule ?? [];
  const title = opts.title ?? `بوالص الشحن — ${labels.length}`;

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  @page { size: ${pageW}mm ${pageH}mm; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: #e9edf2; }
  body { font-family: Tahoma, "Segoe UI", Arial, sans-serif; color: #000; }

  .bar { position: sticky; top: 0; z-index: 1; display: flex; flex-wrap: wrap; align-items: center; gap: 10px;
         padding: 10px 16px; background: #121926; color: #fff; font-size: 14px; }
  .bar button { font: inherit; font-weight: bold; padding: 8px 18px; border: 0; border-radius: 8px;
                background: #fff; color: #121926; cursor: pointer; }
  .bar .primary { margin-inline-start: auto; }
  .bar .muted { opacity: .72; font-size: 12px; }
  .setup { margin: 0; padding: 10px 16px; background: #fff7e6; color: #6b4d12;
           font-size: 13px; line-height: 1.7; border-bottom: 1px solid #e8d9b5; }
  .setup strong { color: #4a350b; }
  @media print { .setup { display: none; } }
  .bar .run { padding: 6px 12px; background: #364152; color: #fff; font-weight: normal; }
  .bar .run.done { background: #00994d; }
  .bar .runs { display: flex; gap: 6px; flex-wrap: wrap; }
  .skipped { background: #fff4e5; color: #7a4b00; font-size: 12px; padding: 8px 16px; }
  .outside { background: #e8f1fb; color: #1d4a7a; font-size: 12px; padding: 8px 16px; }

  .page { width: ${pageW}mm; height: ${pageH}mm; margin: 10px auto; background: #fff;
          display: grid; grid-template-columns: repeat(auto-fill, ${size.width}mm);
          grid-auto-rows: ${size.height}mm; align-content: start; overflow: hidden;
          box-shadow: 0 1px 4px rgba(0,0,0,.12); contain: layout paint; }

  /* ── one label ──
     LABEL_CSS: every colour in it is black or white, and no white is ever
     drawn on black — Chrome prints without background graphics unless it
     is told otherwise, and then white-on-black is white on nothing. */
${LABEL_CSS}
  .label { --s: ${t.fit}; --c: ${t.codes}; --qr: ${t.qr}mm;
           width: ${size.width}mm; height: ${size.height}mm; padding: ${t.pad}mm; }

  @media print {
    ${runRules}
    html, body { background: #fff; }
    .bar, .skipped, .outside { display: none; }
    .page { margin: 0; box-shadow: none; break-after: page; }
    .page:last-child { break-after: auto; }
    .label { border-color: transparent; }
    /* Nothing on the label leans on a background; this only keeps the
       white page white if a printer driver is set to save toner. */
    .label, .label * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    /* A thermal head prints black or nothing: a coloured logo becomes noise. */
    .logo { filter: grayscale(1) contrast(1.15); }
  }
</style></head>
<body>
<div class="bar">
  <strong>${labels.length} بوليصة</strong>
  <span class="muted">${pages} ${pages === 1 ? 'صفحة' : 'صفحات'}</span>
  ${
    pdf
      ? `<span class="muted">اختر «حفظ بصيغة PDF» في نافذة الطباعة — الحفظ لا يعلّم الطلبات مطبوعة.</span>`
      : chunked
        ? `<span class="muted">اطبعها على دفعات:</span><span class="runs">${runButtons}</span>`
        : ''
  }
  <button type="button" class="primary" data-print-run="all">${pdf ? 'حفظ PDF' : chunked ? 'اطبع الكل' : 'اطبع'}</button>
</div>
${
  pdf
    ? ''
    : `
<!--
  THE PART OF THE SETUP THIS PAGE CANNOT DO ITSELF.

  The sheet declares its own @page size, and a browser still prints it onto
  whatever paper the dialog has selected — and a thermal printer still needs
  the roll size set in its driver. Nothing here can reach either.

  So it is said where the person is standing, at the moment they press
  print, instead of in a help page nobody opens. Once, above the button,
  not a dialog they have to dismiss on every batch.
-->
<div class="setup">
  <strong>قبل أن تضغط «اطبع»:</strong>
  في نافذة الطباعة اختر حجم الورق <strong>${pageW}×${pageH} مم</strong> أو «افتراضي»، واضبط الهوامش على
  <strong>بلا</strong> (None) ومقياس الطباعة على <strong>100٪</strong>.
  ${
    pageW <= 110 && pageH <= 160
      ? 'وللطابعة الحرارية: مقاس الرول يُضبط في تعريف الطابعة نفسها — لا تستطيع هذه الصفحة ضبطه.'
      : ''
  }
</div>`
}
${
  skipped.length
    ? `<div class="skipped">لم تُطبع ${skipped.length}: ${skipped
        .map((s) => `${esc(s.orderNumber)} (${esc(s.reason)})`)
        .join('، ')}</div>`
    : ''
}
${
  outside.length
    ? `<div class="outside">طُبعت ${outside.length} بصلاحية «البوالص بكل الأحوال» رغم القاعدة: ${outside
        .map((s) => `${esc(s.orderNumber)} (${esc(s.reason)})`)
        .join('، ')} — نسخ ورقية فقط، ما بتنسجّل مطبوعة وما بتختم الطلب.</div>`
    : ''
}
${sheets.join('\n')}
<script>
  (function () {
    var body = document.body;
    var PDF = ${pdf ? 'true' : 'false'};
    var TOKEN = ${JSON.stringify(opts.token)};
    var STAMP = ${JSON.stringify(opts.stampUrl)};

    /** The orders on the pages about to print: one run, or all of them. */
    function printingOrderIds() {
      var run = body.getAttribute('data-run');
      var pages = document.querySelectorAll(run === null ? '.page' : '.page[data-run="' + run + '"]');
      var ids = [];
      pages.forEach(function (p) {
        p.querySelectorAll('[data-order]').forEach(function (l) { ids.push(l.getAttribute('data-order')); });
      });
      return ids;
    }

    // Printing commits the label; opening, reloading and saving a PDF do not.
    // beforeprint catches the button, the runs and Ctrl+P alike. keepalive
    // lets the report finish while the print dialog holds the page.
    window.addEventListener('beforeprint', function () {
      if (PDF) return;
      var ids = printingOrderIds();
      if (!ids.length) return;
      try {
        fetch(STAMP, {
          method: 'POST',
          keepalive: true,
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ t: TOKEN, orderIds: ids }),
        });
      } catch (e) { /* the label still prints; the next print reports it */ }
    });
    window.addEventListener('afterprint', function () { body.removeAttribute('data-run'); });

    document.querySelectorAll('[data-print-run]').forEach(function (b) {
      b.addEventListener('click', function () {
        var run = b.getAttribute('data-print-run');
        if (run === 'all') body.removeAttribute('data-run'); else body.setAttribute('data-run', run);
        window.print();
        if (run !== 'all') b.classList.add('done');
      });
    });
  })();
</script>
</body></html>`;
}

/**
 * The store logo, only if drawing it asks nobody else for anything.
 *
 * The print page makes no request outside this application — it carries
 * customer names and addresses. A logo uploaded here is served from our own
 * origin; a logo URL somebody typed in pointing elsewhere is left off
 * rather than fetched, and the store name stands alone.
 */
export function storeLogoForPrint(logo: string | null | undefined): string | null {
  const v = String(logo ?? '').trim();
  return v.startsWith(STORE_LOGO_PREFIX) || v.startsWith('/api/media/') ? v : null;
}
