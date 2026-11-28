import type { DesignShow, LabelView, SheetSize, SheetStore } from './label-sheet';
import { barcodeSvg, esc, FLOOR_PT, legacyScale } from './label-ink';
import { encodableCode128 } from './labels';
import { SHAPE_INFO, unitWord, type ProductShape } from './product-shapes';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE READY WAYBILL DESIGNS — «أ» AND «ب» (the owner, 27/11).
 *
 * A store picks one in «البوليصة المطبوعة»; a store that picked none prints `label-sheet.ts`'s own label, byte for
 * byte as before, and never reaches this file.
 *
 * His rules, which decide everything here:
 *
 *   THE COUNT IS BIG. One product: a large count in the product's own word («3 عبوات») and a drawing per piece.
 *   Several: a count box on every line, and the parcel's total at the foot (design ب: the total, big, beside them).
 *
 *   NOTHING IS HIDDEN FROM THE PACKER. A name wraps and is never cut. When the paper cannot hold every line, the
 *   order gets a SECOND label (and a third, if it takes one) that lists all of the contents — never «و N أصناف أخرى».
 *
 *   THE COURIER'S PARTS ARE NEVER HIDDEN OR CLIPPED, AND NEVER SMALLER THAN TODAY'S. The name, every phone, the
 *   whole address, the amount and the barcode are on the first label at every size. Their type starts at no less than
 *   the current waybill's floor on that paper, and the bars are never shorter than the ones it draws there. When room
 *   runs out, the contents move to the next labels and the optional parts give way (the support number, the store's
 *   name, the QR, the header, the note — which moves whole — and the big total). Nothing on the first label is shrunk
 *   to make room. Papers under 70 mm either way never reach this file: the doors print the current waybill.
 *
 *   BLACK INK ONLY. Every line, letter and drawing is black on white. Nothing is white on a colour, nothing relies on
 *   a printed background, nothing is grey.
 *
 * ── HOW IT FITS WITHOUT A BROWSER ──
 * The page is a string built on the server, so every block's height is worked out here in millimetres, from a width
 * per character set on the generous side (a line is counted as wrapping a little before it does). The type starts at
 * the size the paper calls for and steps down until the blocks fit; the contents take the room that is left.
 * ═══════════════════════════════════════════════════════════════════════
 */

export const WAYBILL_DESIGNS = ['a', 'b'] as const;
export type WaybillDesign = (typeof WAYBILL_DESIGNS)[number];

/** One line of the parcel, as the new designs list it. */
export interface ParcelLine {
  name: string;
  /** «L · أسود ×2، M · كحلي» — printed under the name. */
  variant?: string | null;
  /** Pieces in the box: paid and free together. */
  qty: number;
  shape: ProductShape;
  /** An upsell accepted after ordering — marked, so the packer does not miss it. */
  addOn?: boolean;
  /** The order's main product: the offer ticket stands beside it, and beside no other. */
  main?: boolean;
}

export interface Parcel {
  lines: ParcelLine[];
  /** The saved offer's name, already cleaned; null prints no ticket. */
  offer?: string | null;
}

/** One order on paper: its label, and the contents labels that follow it when it needs them. */
export interface DesignedOrder {
  main: string;
  more: string[];
}

/**
 * An offer's name as the ticket prints it: the pictures a thermal head cannot draw are taken out (emoji, their
 * joiners and skin tones, flags, keycap marks), and the spaces they leave are closed. Nothing left is no ticket.
 */
export function cleanOfferName(name: string | null | undefined): string | null {
  const v = String(name ?? '')
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return v || null;
}

// ── measures ────────────────────────────────────────────────────────────

const PT_MM = 25.4 / 72;
/** Every line of every text, in the CSS and in the sums. */
const LH = 1.3;
/** The courier-only label's line height (`.wb-tight`): closer lines before smaller type. */
const TIGHT_LH = 1.15;
/** The unit word under a big count never goes under 7 pt. */
const MIN_WORD_MM = (7 * 25.4) / 72;
/** The dashed outline of a label, one CSS pixel each side. */
const OUTLINE_MM = 25.4 / 96;
/** Height kept back from the paper: browsers round line boxes and borders up. */
const SLACK_MM = 1.2;

/**
 * The type sizes at scale 1, in points: `[base, floor]`. For the courier's own (`COURIER_FLOOR`) the floor is the
 * current waybill's instead. A first label never goes under these floors; only a single contents line too tall for a
 * whole label is drawn smaller (`contentsPages`).
 */
const TYPE = {
  brand: [15, 9],
  courier: [10, 8],
  ref: [10.5, 8],
  name: [13.5, 10],
  phone: [18, 12],
  gov: [11.5, 9],
  place: [10, 8],
  note: [8.5, 7.5],
  codLabel: [9, 7],
  amount: [28, 15],
  currency: [10, 7.5],
  pname: [14, 10],
  variant: [10, 7.5],
  row: [10.5, 8],
  rowFew: [12.5, 8.5],
  offer: [10.5, 8],
  foot: [8.5, 7],
  total: [11.5, 8.5],
  caption: [8.5, 7],
  title: [12, 8.5],
} as const;
type TypeKey = keyof typeof TYPE;

/**
 * The floors of the courier's type, in points at the paper's own floor scale: what the current waybill prints at its
 * smallest — name 13, phones 12, address 9, and the amount a point over its 14.
 */
const COURIER_FLOOR = {
  name: FLOOR_PT.name,
  phone: FLOOR_PT.phones,
  gov: FLOOR_PT.body,
  place: FLOOR_PT.body,
  amount: FLOOR_PT.codAmount + 1,
} as const;
type CourierKey = keyof typeof COURIER_FLOOR;
const isCourier = (k: TypeKey): k is CourierKey => k in COURIER_FLOOR;

/**
 * Width of one character as a share of the type size, on the generous side (Tahoma: bold Arabic 0.47–0.58 em,
 * regular 0.44–0.50, digits 0.64; Latin capitals wider still).
 */
function ems(text: string, bold: boolean): number {
  let total = 0;
  for (const c of text) {
    if (c === ' ') total += 0.34;
    else if (c >= '0' && c <= '9') total += bold ? 0.66 : 0.62;
    else if (c >= 'A' && c <= 'Z') total += bold ? 0.78 : 0.72;
    else if (c >= 'a' && c <= 'z') total += bold ? 0.66 : 0.58;
    else if (c === 'm' || c === 'W' || c === '@') total += 0.95;
    else total += bold ? 0.61 : 0.55;
  }
  return total;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** A run of text set in one size and weight. */
interface Run {
  text: string;
  size: number;
  bold: boolean;
}

/**
 * Lines these runs take in `width`, filled word by word as a browser fills them; a word longer than a line breaks
 * anywhere (`overflow-wrap: anywhere`), losing a character at each break.
 */
function wrapRuns(runs: Run[], width: number): number {
  const room = Math.max(0.1, width * 0.97);
  let count = 0;
  let used = 0;
  for (const run of runs) {
    for (const word of run.text.split(/\s+/)) {
      if (!word) continue;
      const w = ems(word, run.bold) * run.size;
      const space = 0.34 * run.size;
      if (count > 0 && used + space + w <= room) {
        used += space + w;
        continue;
      }
      const broken = Math.max(1, Math.ceil(w / Math.max(run.size * 0.7, room - run.size * 0.5)));
      count += broken;
      used = broken === 1 ? w : room * 0.9;
    }
  }
  return count;
}

const lines = (text: string, size: number, width: number, bold: boolean): number => wrapRuns([{ text, size, bold }], width);

/** The width a text takes on one line, never more than `max`. */
const widthOf = (text: string, size: number, bold: boolean, max = Infinity) => Math.min(max, ems(text, bold) * size);

/** How many rows `items` of these widths take in a wrapping row. */
function packRows(widths: number[], width: number, gap: number): number {
  let rows = 0;
  let used = 0;
  for (const w of widths) {
    if (rows === 0 || used + gap + w > width) {
      rows += Math.max(1, Math.ceil(w / width));
      used = Math.min(w, width);
    } else used += gap + w;
  }
  return rows;
}

/** A piece of the label: its markup, and the height it takes. */
interface Block {
  html: string;
  h: number;
}

interface Paper {
  width: number;
  height: number;
  orient: 'wide' | 'tall' | 'square';
  pad: number;
  /** Inside the padding and the outline. */
  iw: number;
  ih: number;
  /** The scale the paper calls for, before the label's own text is fitted. */
  base: number;
  /** The scale the current waybill's type never goes under on this paper — the courier's floors follow it. */
  floor: number;
}

function paperOf(size: SheetSize): Paper {
  const { width: w, height: h } = size;
  const orient = h >= w * 1.15 ? 'tall' : w >= h * 1.15 ? 'wide' : 'square';
  const pad = r2(clamp(Math.min(w, h) * 0.027, 1.2, 5));
  const [rw, rh] = orient === 'wide' ? [150, 100] : orient === 'tall' ? [100, 150] : [100, 100];
  return {
    width: w,
    height: h,
    orient,
    pad,
    iw: w - 2 * pad - 2 * OUTLINE_MM,
    ih: h - 2 * pad - 2 * OUTLINE_MM - SLACK_MM,
    base: clamp(Math.min(w / rw, h / rh), 0.72, 2.2),
    floor: Math.max(1, legacyScale(size)),
  };
}

/**
 * The sizes of one attempt: scale `s`, and `m` under 1 only for a contents line no label can hold at the floors
 * (`contentsPages`). `m` never touches the courier's type.
 */
interface Sizes {
  s: number;
  m: number;
  /** A type size in millimetres. */
  of: (k: TypeKey) => number;
  /** The smallest this courier part is printed at on this paper, in millimetres. */
  floorOf: (k: CourierKey) => number;
  /** A length that follows the scale, in millimetres. */
  mm: (v: number) => number;
}

/**
 * `under` is for a text no layout can hold at the floor (see `courierOnly`): the one case where a courier's type goes
 * smaller, because the other choice is to cut it.
 */
function sizesAt(paper: Paper, s: number, m: number, under: { address: number; all: number } = { address: 1, all: 1 }): Sizes {
  const shrink = (k: CourierKey) => under.all * (k === 'gov' || k === 'place' ? under.address : 1);
  const floorOf = (k: CourierKey) => r2(COURIER_FLOOR[k] * paper.floor * PT_MM * shrink(k));
  return {
    s,
    m,
    floorOf,
    of: (k) =>
      isCourier(k)
        ? Math.max(floorOf(k), r2(TYPE[k][0] * s * PT_MM * shrink(k)))
        : r2(Math.max(TYPE[k][1], TYPE[k][0] * s) * PT_MM * m),
    mm: (v) => r2(v * clamp(s, 0.7, 2.2) * m),
  };
}

// ── small pieces ────────────────────────────────────────────────────────

const fs = (v: number) => `font-size:${r2(v)}mm`;

const svgLine = (d: string, size: number, cls: string, stroke = 1.7) =>
  `<svg class="${cls}" viewBox="0 0 24 24" style="width:${r2(size)}mm;height:${r2(size)}mm" aria-hidden="true">` +
  `<path d="${d}" fill="none" stroke="#000" stroke-width="${stroke}" stroke-linejoin="round" stroke-linecap="round"/></svg>`;

const shapeSvg = (shape: ProductShape, size: number) => svgLine((SHAPE_INFO[shape] ?? SHAPE_INFO.generic).path, size, `wb-shape wb-shape-${shape}`);

const GIFT_PATH = 'M3 9h18v4H3zM5 13v8h14v-8M12 9v12M12 9C9 9 6.5 7.8 7 5.5 7.6 3 11 3.5 12 9zM12 9c3 0 5.5-1.2 5-3.5C16.4 3 13 3.5 12 9z';

/** The offer ticket: a double frame (solid inside, dashed outside) and the gift mark. `width` is the room it may take. */
function ticket(name: string, z: Sizes, width: number): Block & { w: number } {
  const size = z.of('offer');
  const icon = size * 1.4;
  const chrome = icon + 1.2 + 2 * 2.2 + 2 * 0.5 + 2 * 1;
  const w = Math.min(width, widthOf(name, size, true) * 1.04 + chrome);
  const n = lines(name, size, Math.max(size * 2, w - chrome), true);
  return {
    html:
      `<div class="wb-ticket" style="${fs(size)};max-width:${r2(width - 2)}mm">${svgLine(GIFT_PATH, icon, 'wb-gift', 1.9)}` +
      `<span>${esc(name)}</span></div>`,
    h: Math.max(icon, n * size * LH) + 2 * 0.5 + 2 * 0.5 + 2 * 1,
    w,
  };
}

const ADD_ON = 'إضافة';

const totalUnits = (list: ParcelLine[]) => list.reduce((s, l) => s + l.qty, 0);

/** The word the whole parcel is counted in: the one shape's, or «قطعة» when the shapes differ. */
const parcelShape = (list: ParcelLine[]): ProductShape =>
  list.length && list.every((l) => l.shape === list[0].shape) ? list[0].shape : 'generic';

const unitsPhrase = (list: ParcelLine[]) => {
  const n = totalUnits(list);
  return `${n} ${unitWord(parcelShape(list), n)}`;
};

const productsPhrase = (n: number) =>
  n === 1 ? 'منتج واحد' : n === 2 ? 'منتجين' : n % 100 >= 3 && n % 100 <= 10 ? `${n} منتجات` : `${n} منتج`;

// ── what one order says ─────────────────────────────────────────────────

interface Order {
  l: LabelView;
  show: DesignShow;
  store: SheetStore;
  list: ParcelLine[];
  offer: string | null;
  /** The index of the line the ticket stands beside. */
  ticketAt: number;
  note: string | null;
}

const EVERY_PART: DesignShow = { storeName: true, courierName: true, ref: true, items: true, note: true, qr: true, supportPhone: true };

function orderOf(l: LabelView, store: SheetStore, show?: DesignShow): Order {
  const s = show ?? EVERY_PART;
  const list: ParcelLine[] = !s.items
    ? []
    : l.parcel?.lines ?? l.items.map((i) => ({ name: i.name, qty: i.qty, shape: 'generic' as const, ...(i.addOn ? { addOn: true } : {}) }));
  const offer = s.offer === false ? null : l.parcel?.offer || null;
  const ticketAt = offer ? list.findIndex((x) => x.main) : -1;
  return {
    l,
    show: s,
    store: s.supportPhone ? store : { ...store, supportPhone: null },
    list,
    offer: ticketAt >= 0 ? offer : null,
    ticketAt,
    note: s.note && l.note?.trim() ? l.note.trim() : null,
  };
}

/** What a level of the layout keeps. Each step down gives up one optional part. */
interface Plan {
  support: boolean;
  noteHere: boolean;
  qr: boolean;
  brand: boolean;
  head: boolean;
  total: boolean;
}

const ALL_PARTS: Plan = { support: true, noteHere: true, qr: true, brand: true, head: true, total: true };
const PLANS: readonly Plan[] = (() => {
  const steps: Partial<Plan>[] = [{}, { support: false }, { brand: false }, { qr: false }, { head: false }, { noteHere: false }, { total: false }];
  let p = ALL_PARTS;
  return steps.map((s) => (p = { ...p, ...s }));
})();

// ── the blocks ──────────────────────────────────────────────────────────

function brandParts(o: Order, p: Plan, z: Sizes, maxW: number) {
  const parts: { html: string; w: number; h: number }[] = [];
  // A cell too narrow for a name worth reading prints none: the store's name is the first thing to give way.
  if (!p.brand || maxW < 14) return parts;
  const logoH = z.mm(7);
  if (o.store.logoUrl) {
    const logoW = Math.min(z.mm(22), maxW);
    parts.push({ html: `<img class="logo wb-logo" src="${esc(o.store.logoUrl)}" alt="" style="height:${logoH}mm;max-width:min(${r2(logoW)}mm,100%)">`, w: logoW, h: logoH });
  }
  if (o.show.storeName && o.store.name) {
    const size = z.of('brand');
    const w = widthOf(o.store.name, size, true, maxW);
    parts.push({ html: `<strong class="wb-brand" style="${fs(size)};max-width:min(${r2(maxW)}mm,100%)">${esc(o.store.name)}</strong>`, w, h: size * LH });
  }
  return parts;
}

function pill(text: string, size: number, maxW: number) {
  const w = Math.min(maxW, widthOf(text, size, true) + 2 * 3 + 1);
  const n = lines(text, size, Math.max(size * 2, w - 7), true);
  return { html: `<span class="wb-pill" style="${fs(size)};max-width:${r2(maxW)}mm">${esc(text)}</span>`, w, h: n * size * LH + 1.4 };
}

function refPart(o: Order, z: Sizes, maxW: number) {
  const size = z.of('ref');
  const w = widthOf(o.l.ref, size, true, maxW) + 0.5;
  return { html: `<b class="wb-ref" dir="ltr" style="${fs(size)};max-width:${r2(maxW)}mm">${esc(o.l.ref)}</b>`, w, h: lines(o.l.ref, size, maxW, true) * size * LH };
}

const supportText = (o: Order) => o.store.supportPhone ?? '';

function supportPart(o: Order, z: Sizes) {
  const size = z.of('foot');
  return {
    html: `<span class="wb-support" style="${fs(size)}">للاستفسار <b dir="ltr">${esc(supportText(o))}</b></span>`,
    w: widthOf(`للاستفسار ${supportText(o)}`, size, true) + 1,
    h: size * LH,
  };
}

/** A wrapping row of parts, spread across the width, closed by a rule. */
function rowOf(cls: string, parts: { html: string; w: number; h: number }[], width: number, ruled: boolean): Block | null {
  if (!parts.length) return null;
  const rows = packRows(parts.map((x) => x.w), width, 2);
  const h = Math.max(...parts.map((x) => x.h)) * rows + (rows - 1) * 0.6;
  return {
    html: `<div class="${cls}">${parts.map((x) => x.html).join('')}</div>`,
    h: h + (ruled ? 0.8 + 0.8 : 0),
  };
}

/** Design أ's header: the store, the courier in its pill, our reference. */
function headA(o: Order, p: Plan, z: Sizes, width: number): Block | null {
  if (!p.head) return null;
  const parts = [];
  const brand = brandParts(o, p, z, width * 0.46);
  if (brand.length) {
    parts.push({
      html: `<span class="wb-brandbox">${brand.map((b) => b.html).join('')}</span>`,
      w: brand.reduce((s, b) => s + b.w, 0) + (brand.length - 1) * 1.5,
      h: Math.max(...brand.map((b) => b.h)),
    });
  }
  if (o.show.courierName && o.l.courier) parts.push(pill(o.l.courier, z.of('courier'), width * 0.6));
  if (o.show.ref) parts.push(refPart(o, z, width));
  return rowOf('wb-head', parts, width, true);
}

const splitPlace = (place: string) => {
  const at = place.indexOf(' — ');
  return at > 0 ? { gov: place.slice(0, at), rest: place.slice(at + 3) } : { gov: place, rest: '' };
};

const PHONE_PATH = 'M6 3h4l2 5-2.5 1.5a11 11 0 0 0 5 5L16 12l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 4 5a2 2 0 0 1 2-2z';
const PIN_PATH = 'M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z';

const mark = (d: string, size: number) =>
  `<svg class="wb-mark" viewBox="0 0 24 24" style="width:${r2(size)}mm;height:${r2(size)}mm" aria-hidden="true"><path d="${d}" fill="#000" fill-rule="evenodd"/></svg>`;

/** A phone's width as a share of its type size, with its letter spacing. */
const phoneEms = (x: string) => ems(x, true) + x.length * 0.03;

/** The width the longest phone needs on one line at the smallest size it may print at. */
const phoneFloorWidth = (o: Order, z: Sizes) => Math.max(0, ...o.l.phones.filter(Boolean).map(phoneEms)) * z.floorOf('phone') * 1.05;

/** Name, every phone, the whole address, and the note when this plan keeps it here. Nothing is clamped. */
function who(o: Order, p: Plan, z: Sizes, width: number, marks = false, lh = LH): Block {
  const nameS = z.of('name');
  const phones = o.l.phones.filter(Boolean);
  // Design أ marks the phone and the address, where the column is wide enough to spare the room.
  const wantMark = r2(z.of('gov'));
  const markS = marks && width >= 45 && width - wantMark - 1.4 >= phoneFloorWidth(o, z) ? wantMark : 0;
  const markW = markS ? markS + 1.4 : 0;
  const textW = width - markW;
  // A phone stays on one line, whole: its size follows the width of a narrow column, but never under its floor.
  const longest = Math.max(1, ...phones.map(phoneEms));
  const phoneS = Math.max(z.floorOf('phone'), r2(Math.min(z.of('phone'), textW / (longest * 1.05))));
  const { gov, rest } = splitPlace(o.l.place);
  const govS = z.of('gov');
  const placeS = z.of('place');
  const placeN = wrapRuns([{ text: gov, size: govS, bold: true }, { text: rest ? `— ${rest}` : '', size: placeS, bold: false }], textW);
  // A «phone» no line can hold (two numbers typed into one box) wraps rather than shrink or run off the paper.
  const tooLong = (x: string) => phoneEms(x) * phoneS > textW;
  const phoneRows = phones.length ? packRows(phones.map((x) => phoneEms(x) * phoneS), textW, 4) : 0;
  const gap = z.mm(0.5);
  let h = lines(o.l.name, nameS, width, true) * nameS * lh + phoneRows * phoneS * Math.min(1.2, lh) + placeN * govS * lh + 2 * gap;
  let note = '';
  if (o.note && p.noteHere) {
    const noteS = z.of('note');
    h += lines(`ملاحظة: ${o.note}`, noteS, width, false) * noteS * LH + gap + 0.9;
    note = `<p class="wb-note" style="${fs(noteS)}"><b>ملاحظة:</b> ${esc(o.note)}</p>`;
  }
  return {
    html:
      `<div class="wb-who" style="gap:${gap}mm">` +
      `<p class="wb-name" dir="auto" style="${fs(nameS)}">${esc(o.l.name)}</p>` +
      (phones.length
        ? `<div class="wb-line">${markS ? mark(PHONE_PATH, markS) : ''}` +
          `<p class="wb-phones" dir="ltr" style="${fs(phoneS)}">${phones.map((x) => `<span${tooLong(x) ? ' class="wb-long"' : ''}>${esc(x)}</span>`).join('')}</p></div>`
        : '') +
      `<div class="wb-line">${markS ? mark(PIN_PATH, markS) : ''}` +
      `<p class="wb-place" style="${fs(govS)}"><b>${esc(gov)}</b>${rest ? `<span style="${fs(placeS)}"> — ${esc(rest)}</span>` : ''}</p></div>` +
      note +
      `</div>`,
    h,
  };
}

/** The formatted amount in two parts, for the two sizes: «32.500» and «JOD». The text itself is never touched. */
function amountParts(cod: string) {
  const at = cod.lastIndexOf(' ');
  return at > 0 ? { amount: cod.slice(0, at), currency: cod.slice(at + 1) } : { amount: cod, currency: '' };
}

const COD_LABEL = 'المبلغ عند الاستلام';
const COD_SHORT = 'المبلغ';
const COD_FRAME = 1.1;

/** The amount the driver collects: a thick black frame. Stacked beside the recipient, or a full-width bar. */
function cod(o: Order, z: Sizes, width: number, shape: 'stack' | 'bar'): Block {
  const { amount, currency } = amountParts(o.l.cod);
  const labelS = z.of('codLabel');
  const curS = z.of('currency');
  const inner = width - 2 * (COD_FRAME + 1);
  const amountEm = ems(amount, true) * 1.04;
  const floor = z.floorOf('amount');
  // The amount follows the width of its box, never under its floor; one no box can hold at the floor wraps.
  const sized = (wanted: number, em: number) => Math.max(floor, r2(Math.min(wanted, inner / em)));
  const strong = (size: number) =>
    `<strong${amountEm * size > inner ? ' class="wb-long"' : ''} dir="ltr" style="${fs(size)}">${esc(amount)}</strong>`;
  const amountLines = (size: number) => Math.max(1, Math.ceil((amountEm * size) / inner));
  if (shape === 'stack') {
    const amountS = sized(z.of('amount'), amountEm);
    return {
      html:
        `<div class="wb-cod wb-cod-stack" style="${fs(labelS)}"><span>${COD_LABEL}</span>` +
        strong(amountS) +
        (currency ? `<em dir="ltr" style="${fs(curS)}">${esc(currency)}</em>` : '') +
        `</div>`,
      h: lines(COD_LABEL, labelS, inner, true) * labelS * LH + amountLines(amountS) * amountS * 1.15 + (currency ? curS * LH : 0) + 2 * (COD_FRAME + 0.8),
    };
  }
  const amountS = sized(z.of('amount') * 0.95, amountEm + ems(currency, true) * (curS / z.of('amount')) + 0.3);
  const need = [widthOf(COD_LABEL, labelS, true), Math.min(inner - 2, amountEm * amountS), currency ? widthOf(currency, curS, true) + 1 : 0].filter(Boolean);
  const rows = packRows(need, inner - 2, 2.5);
  return {
    html:
      `<div class="wb-cod wb-cod-bar" style="${fs(labelS)}"><span>${COD_LABEL}</span>` +
      strong(amountS) +
      (currency ? `<em dir="ltr" style="${fs(curS)}">${esc(currency)}</em>` : '') +
      `</div>`,
    h: amountLines(amountS) * amountS * 1.15 + (rows - 1) * Math.max(labelS, curS) * LH + 2 * (COD_FRAME + 0.5),
  };
}

/** The amount on one thin row with the short word, for the courier-only label: the figure keeps its size. */
function codTight(o: Order, z: Sizes, width: number): Block {
  const { amount, currency } = amountParts(o.l.cod);
  const labelS = z.of('codLabel');
  const curS = z.of('currency');
  const inner = width - 2 * (0.7 + 1);
  const amountEm = ems(amount, true) * 1.04;
  const size = z.floorOf('amount');
  const wide = amountEm * size > inner;
  const rows = packRows(
    [widthOf(COD_SHORT, labelS, true), Math.min(inner, amountEm * size), currency ? widthOf(currency, curS, true) + 1 : 0].filter(Boolean),
    inner - 1,
    2
  );
  return {
    html:
      `<div class="wb-cod wb-cod-bar wb-cod-tight" style="${fs(labelS)}"><span>${COD_SHORT}</span>` +
      `<strong${wide ? ' class="wb-long"' : ''} dir="ltr" style="${fs(size)}">${esc(amount)}</strong>` +
      (currency ? `<em dir="ltr" style="${fs(curS)}">${esc(currency)}</em>` : '') +
      `</div>`,
    h: Math.max(1, Math.ceil((amountEm * size) / inner)) * size * 1.15 + (rows - 1) * Math.max(labelS, curS) * LH + 2 * (0.7 + 0.2),
  };
}

/** The millimetres of the barcode's bars: never less than the current waybill draws on the same paper. */
const barHeight = (paper: Paper) => r2(clamp(14 * Math.min(paper.width / 100, paper.height / 110), 9.8, 31));

const qrSide = (paper: Paper, z: Sizes) => {
  const base = paper.orient === 'tall' ? 21 : 17;
  const c = clamp(Math.min(paper.width / 100, paper.height / (paper.orient === 'tall' ? 150 : 100)), 0.8, 2);
  return r2(base * c * Math.max(0.6, z.m));
};

/** The courier's barcode in its frame — the frame sits outside the symbol, whose own quiet zones stay as they were. */
function barcode(o: Order, paper: Paper, z: Sizes, width: number): Block {
  const code = encodableCode128(o.l.courierCode);
  const bar = barHeight(paper);
  const inner = width - 2 * 0.4 - 2 * 0.4;
  const size = r2(Math.min(z.of('caption'), inner / (code.length * 0.72)));
  const spacing = r2(clamp((inner - code.length * size * 0.72) / code.length, 0, size * 0.28));
  return {
    html:
      `<figure class="wb-bc">${barcodeSvg(o.l.courierCode, bar)}` +
      `<figcaption dir="ltr" style="${fs(size)};letter-spacing:${spacing}mm">${esc(code)}</figcaption></figure>`,
    h: bar + 0.8 + size * LH + 2 * 0.4,
  };
}

function qrFigure(o: Order, paper: Paper, z: Sizes, side: number, caption: boolean): Block {
  const size = r2(Math.min(z.of('caption') * 0.85, side / (Math.max(1, o.l.ref.length) * 0.68)));
  return {
    html:
      `<figure class="wb-qr" style="width:${side}mm">${o.l.qrSvg}` +
      (caption ? `<figcaption dir="ltr" style="${fs(size)}">${esc(o.l.ref)}</figcaption>` : '') +
      `</figure>`,
    h: side + (caption ? size * LH : 0),
  };
}

/**
 * The barcode, and the QR beside it. The QR gives its room back when the barcode would be left narrower than the
 * current waybill leaves it — the courier scans the barcode, the QR is ours.
 */
function codesRow(o: Order, p: Plan, paper: Paper, z: Sizes, width: number): Block {
  const side = qrSide(paper, z);
  const gap = 2;
  const wantQr = p.qr && o.show.qr && width - side - gap >= Math.min(62, width * 0.7);
  const bc = barcode(o, paper, z, wantQr ? width - side - gap : width);
  // Our reference is printed under the QR when the header does not carry it — switched off at the top, or dropped for
  // room — as the current waybill's QR carries it.
  const qr = wantQr ? qrFigure(o, paper, z, side, !(p.head && o.show.ref)) : null;
  return { html: `<div class="wb-codes">${bc.html}${qr?.html ?? ''}</div>`, h: Math.max(bc.h, qr?.h ?? 0) };
}

/** Design أ's foot: the parcel's total, and the store's number. */
function footA(o: Order, p: Plan, z: Sizes, width: number): Block | null {
  const parts = [];
  if (o.list.length && p.total) {
    const size = z.of('total');
    const text = unitsPhrase(o.list);
    parts.push({
      html: `<span class="wb-total" style="${fs(size)}">مجموع الطرد: <b style="${fs(size * 1.25)}">${esc(text)}</b></span>`,
      w: widthOf('مجموع الطرد: ', size, false) + widthOf(text, size * 1.25, true),
      h: size * 1.25 * LH,
    });
  }
  if (supportText(o) && p.support) parts.push(supportPart(o, z));
  return rowOf('wb-foot', parts, width, false);
}

// ── the contents ────────────────────────────────────────────────────────

/** Pieces a drawing each is drawn for; past this it is one drawing and «×N». */
const MAX_DRAWN = 30;

/** A drawing per piece · one drawing and «×N» under the name · the same beside the name, taking no height · none. */
type Shapes = 'all' | 'times' | 'beside' | 'none';

function shapesBlock(line: ParcelLine, mode: Shapes, z: Sizes, width: number, centred: boolean, k = 1): Block | null {
  if (mode === 'none') return { html: '', h: 0 };
  const side = r2(Math.max(4.5, clamp((centred ? 10 : 8) * clamp(z.s, 0.7, 2.2), 4.5, 18) * k) * z.m);
  const gap = r2(side * 0.14);
  if (mode === 'times' || mode === 'beside') {
    const size = r2(z.of('pname') * 1.2 * Math.max(0.8, k));
    return {
      html: `<div class="wb-shapes wb-times" style="gap:${gap}mm">${shapeSvg(line.shape, side)}<b dir="ltr" style="${fs(size)}">×${line.qty}</b></div>`,
      h: Math.max(side, size * LH),
    };
  }
  if (line.qty < 1 || line.qty > MAX_DRAWN) return null;
  const fit = Math.floor((width + gap) / (side + gap));
  // A tall label lays ten out as two fives, so the packer counts them at a glance.
  const perRow = centred && line.qty > 5 ? Math.min(fit, Math.max(5, Math.ceil(line.qty / 4))) : fit;
  if (perRow < 1) return null;
  const rows = Math.ceil(line.qty / perRow);
  if (rows > (centred ? 4 : 3)) return null;
  return {
    html:
      `<div class="wb-shapes" style="gap:${gap}mm;max-width:${r2(perRow * side + (perRow - 1) * gap + 0.2)}mm">` +
      `${shapeSvg(line.shape, side).repeat(line.qty)}</div>`,
    h: rows * side + (rows - 1) * gap,
  };
}

/** One product: the big count, its name, and a drawing per piece. */
function single(o: Order, paper: Paper, z: Sizes, width: number, height: number): Block | null {
  const line = o.list[0];
  const arrangements: ('column' | 'row')[] = paper.orient === 'tall' ? ['column', 'row'] : ['row'];
  const ways: [Shapes, number][] = [['all', 1], ['all', 0.78], ['all', 0.62], ['times', 1], ['times', 0.62], ['beside', 0.62], ['none', 1]];
  for (const [mode, iconK] of ways) {
    for (const arrangement of arrangements) {
      for (const k of [1, 0.82, 0.66]) {
        const column = arrangement === 'column';
        const d = r2(Math.max(11 * z.m, (column ? 29 : 20) * clamp(z.s, 0.7, 2.2) * k * z.m));
        const gap = z.mm(1.2);
        let ticketSide: ReturnType<typeof ticket> | null = null;
        let whatW = column ? width : width - d - 3.5;
        if (o.offer && !column) {
          const t = ticket(o.offer, z, width * 0.44);
          if (whatW - t.w - 2.5 >= 36 * clamp(z.s, 0.7, 1.6)) {
            ticketSide = t;
            whatW -= t.w + 2.5;
          }
        }
        if (whatW < 12) continue;
        const nameS = z.of('pname');
        const variantS = z.of('variant');
        const nameText = line.addOn ? `${line.name} ${ADD_ON}` : line.name;
        const parts: Block[] = [
          {
            html:
              `<p class="wb-pname" style="${fs(nameS)}">${esc(line.name)}` +
              (line.addOn ? ` <span class="wb-tag" style="${fs(variantS)}">${ADD_ON}</span>` : '') +
              `</p>`,
            h: lines(nameText, nameS, whatW, true) * nameS * LH,
          },
        ];
        if (line.variant) {
          parts.push({
            html: `<p class="wb-variant" style="${fs(variantS)}">${esc(line.variant)}</p>`,
            h: lines(line.variant, variantS, whatW, true) * variantS * LH,
          });
        }
        const drawn = shapesBlock(line, mode, z, whatW, column, iconK);
        if (!drawn) continue;
        if (mode === 'beside') {
          const timesW = drawn.h + widthOf(`×${line.qty}`, nameS * 1.2, true) + 2;
          if (line.addOn || timesW + widthOf(line.name, nameS, true) + 3 > whatW) continue;
          parts[0] = { html: `<div class="wb-nameline">${parts[0].html}${drawn.html}</div>`, h: Math.max(parts[0].h, drawn.h) };
        } else if (drawn.html) parts.push(drawn);
        if (o.offer && !ticketSide) parts.push(ticket(o.offer, z, whatW));
        const whatH = parts.reduce((s, x) => s + x.h, 0) + (parts.length - 1) * gap;
        const h = column ? d + gap + whatH : Math.max(d, whatH, ticketSide?.h ?? 0);
        if (h > height) continue;
        const count = String(line.qty);
        const word = unitWord(line.shape, line.qty);
        const numS = r2(Math.min(d * 0.46, (d * 0.78) / ems(count, true)));
        const wordS = r2(Math.max(MIN_WORD_MM * z.m, Math.min(d * 0.15, (d * 0.78) / ems(word, true))));
        return {
          html:
            `<div class="wb-one wb-one-${arrangement}" style="gap:${column ? gap : 3.5}mm">` +
            `<div class="wb-count" style="width:${d}mm;height:${d}mm"><b style="${fs(numS)}">${count}</b><span style="${fs(wordS)}">${word}</span></div>` +
            `<div class="wb-what" style="gap:${gap}mm">${parts.map((x) => x.html).join('')}</div>` +
            (ticketSide ? ticketSide.html : '') +
            `</div>`,
          h,
        };
      }
    }
  }
  return null;
}

/** One line of a list: the count in a box, the drawing, the name (and what each piece is), the ticket on the main one. */
function listRow(line: ParcelLine, offer: string | null, z: Sizes, size: number, width: number): Block {
  const variantS = r2(Math.max(MIN_WORD_MM * z.m, size * 0.86));
  const count = String(line.qty);
  const qtyS = r2(size * 1.18);
  const qtyW = r2(Math.max(size * 2, ems(count, true) * qtyS + 2.2));
  const qtyH = qtyS * 1.15 + 1.2;
  const icon = r2(size * 1.45);
  const gap = 1.4;
  let textW = width - qtyW - icon - 2 * gap;
  const inline = offer ? ticket(offer, z, textW * 0.55) : null;
  const sideways = inline !== null && textW - inline.w - gap >= Math.max(24, textW * 0.45);
  if (sideways) textW -= inline!.w + gap;
  const under = offer && !sideways ? ticket(offer, z, textW) : null;
  const tagW = line.addOn ? widthOf(ADD_ON, variantS, true) + 3.5 : 0;
  // The add-on's tag stands after the name; counted as one more word of its width.
  const nameLines = wrapRuns(
    [{ text: line.name, size, bold: true }, ...(tagW ? [{ text: 'ن'.repeat(Math.ceil(tagW / (size * 0.61))), size, bold: true }] : [])],
    textW
  );
  const textH =
    nameLines * size * LH +
    (line.variant ? lines(line.variant, variantS, textW, true) * variantS * LH : 0) +
    (under ? under.h : 0);
  return {
    html:
      `<div class="wb-row"><span class="wb-qty" style="${fs(qtyS)};width:${qtyW}mm">${count}</span>${shapeSvg(line.shape, icon)}` +
      `<span class="wb-text"><span class="wb-n" style="${fs(size)}">${esc(line.name)}` +
      (line.addOn ? ` <span class="wb-tag" style="${fs(variantS)}">${ADD_ON}</span>` : '') +
      `</span>` +
      (line.variant ? `<small class="wb-variant" style="${fs(variantS)}">${esc(line.variant)}</small>` : '') +
      (under ? under.html : '') +
      `</span>${sideways ? inline!.html : ''}</div>`,
    h: Math.max(qtyH, icon, textH, sideways ? inline!.h : 0) + 2 * 0.5 + 0.3,
  };
}

const COLUMN_GAP = 3.5;
const columnsFor = (paper: Paper, width: number, n: number) =>
  (n > 3 && width >= 95 && paper.orient === 'wide') || (n > 6 && width >= 120) ? [2, 1] : [1];

function listHtml(columns: Block[][]): string {
  return `<div class="wb-list">${columns.map((c) => `<div class="wb-col">${c.map((r) => r.html).join('')}</div>`).join('')}</div>`;
}

/** Every line of the parcel in `width` × `height`, or null when they do not all fit. */
function list(o: Order, paper: Paper, z: Sizes, width: number, height: number): Block | null {
  const few = o.list.length <= 3;
  for (const k of [1, 0.9, 0.8]) {
    // Tighter steps for a long list, never under the rows' floor.
    const size = r2(Math.max(TYPE.row[1] * PT_MM * z.m, z.of(few ? 'rowFew' : 'row') * k));
    for (const cols of columnsFor(paper, width, o.list.length)) {
      const colW = (width - (cols - 1) * COLUMN_GAP) / cols;
      const rows = o.list.map((line, i) => listRow(line, i === o.ticketAt ? o.offer : null, z, size, colW));
      const per = Math.ceil(rows.length / cols);
      const columns = Array.from({ length: cols }, (_, c) => rows.slice(c * per, (c + 1) * per));
      const h = Math.max(...columns.map((c) => c.reduce((s, r) => s + r.h, 0)));
      if (h <= height) return { html: listHtml(columns), h };
    }
  }
  return null;
}

/** What the first label says when the contents are on the labels after it: the count, big, and where the list is. */
function pointer(o: Order, z: Sizes, width: number, height: number, sheets: number): Block | null {
  const one = o.list.length === 1;
  const big = one ? unitsPhrase(o.list) : `${productsPhrase(o.list.length)} · ${unitsPhrase(o.list)}`;
  const where = sheets > 1 ? 'بالأوراق التالية' : 'بالورقة الثانية';
  const small = one ? `التفاصيل ${where}` : `القائمة كاملة ${where}`;
  const bigS = r2(z.of('title') * (one ? 1.6 : 1.15));
  const smallS = z.of('row');
  const inner = width - 2 * 0.6 - 2 * 1.5;
  const tall = lines(big, bigS, inner, true) * bigS * LH + lines(small, smallS, inner, true) * smallS * LH + 2 * 0.6 + 2 * 1.2;
  if (tall <= height) {
    return {
      html: `<div class="wb-over"><b style="${fs(bigS)}">${esc(big)}</b><span style="${fs(smallS)}">${small}</span></div>`,
      h: tall,
    };
  }
  const text = `${unitsPhrase(o.list)} — ${small}`;
  const size = z.of('row');
  const short = lines(text, size, inner, true) * size * LH + 2 * 0.6 + 2 * 0.4;
  if (short > height) return null;
  return { html: `<div class="wb-over wb-over-short"><b style="${fs(size)}">${esc(text)}</b></div>`, h: short };
}

// ── the contents labels ─────────────────────────────────────────────────

const NOTE_TITLE = 'ملاحظة الزبون';

function moreHead(o: Order, z: Sizes, width: number, page: number, of: number, compact: boolean): Block {
  const parts = [];
  const brand = compact ? [] : brandParts(o, ALL_PARTS, z, width * 0.4);
  if (brand.length) {
    parts.push({
      html: `<span class="wb-brandbox">${brand.map((b) => b.html).join('')}</span>`,
      w: brand.reduce((s, b) => s + b.w, 0) + (brand.length - 1) * 1.5,
      h: Math.max(...brand.map((b) => b.h)),
    });
  }
  // What ties this paper to its parcel: the number under the first label's barcode, always, and our reference beside it
  // when the store prints it (a small paper keeps the barcode's number alone).
  const code = encodableCode128(o.l.courierCode);
  const ties = o.show.ref && !compact && o.l.ref !== code ? [o.l.ref, code] : [code];
  for (const [i, tie] of ties.entries()) {
    const size = i === 0 ? z.of('ref') : z.of('caption');
    parts.push({
      html: `<b class="wb-ref" dir="ltr" style="${fs(size)};max-width:${r2(width)}mm">${esc(tie)}</b>`,
      w: widthOf(tie, size, true, width) + 0.5,
      h: lines(tie, size, width, true) * size * LH,
    });
  }
  parts.push(pill(`ورقة ${page} من ${of}`, z.of('courier'), width));
  return rowOf('wb-head', parts, width, true)!;
}

interface MoreBody {
  html: string;
}

/**
 * The contents labels of one order: every line of the parcel (and the note, when the first label had no room for it),
 * on one label when the type can carry it there, else on as many as it takes. A line is never split or dropped.
 */
function contentsPages(o: Order, paper: Paper, withNote: boolean): MoreBody[] {
  const note = withNote && o.note ? o.note : null;
  const start = clamp(paper.base, 0.72, 1.8);
  const scales: [number, number][] = [];
  for (let s = start; s > 0.72; s = r2(s - 0.04)) scales.push([s, 1]);
  scales.push([0.72, 1]);

  // A small paper keeps its room for the lines: no store name, and a short title.
  const compact = paper.ih < 70 || paper.iw < 55;

  const attempt = (s: number, m: number, onePage: boolean): MoreBody[] | null => {
    const z = sizesAt(paper, s, m);
    const width = paper.iw;
    const head = moreHead(o, z, width, 2, 2, compact);
    const gap = z.mm(compact ? 0.7 : 1.2);
    const titleS = compact ? z.of('row') : z.of('title');
    const titleText = o.list.length ? `${compact ? 'المحتويات' : 'محتويات الطرد'} — ${unitsPhrase(o.list)}` : NOTE_TITLE;
    const title = { html: `<p class="wb-title" style="${fs(titleS)}">${esc(titleText)}</p>`, h: lines(titleText, titleS, width, true) * titleS * LH };
    // On the smallest papers the title gives its line to the contents — the first label already says the total.
    const titled = paper.ih >= 45 || !o.list.length;
    const room = paper.ih - head.h - (titled ? title.h + gap : 0) - gap;
    let noteBlock: Block | null = null;
    if (note) {
      const noteS = z.of('row');
      noteBlock = {
        html: `<p class="wb-note wb-note-more" style="${fs(noteS)}"><b>ملاحظة:</b> ${esc(note)}</p>`,
        h: lines(`ملاحظة: ${note}`, noteS, width, false) * noteS * LH + gap + 0.9,
      };
      if (noteBlock.h > room) return null;
    }
    for (const cols of columnsFor(paper, width, o.list.length)) {
      const colW = (width - (cols - 1) * COLUMN_GAP) / cols;
      const size = z.of(o.list.length <= 3 ? 'rowFew' : 'row');
      const rows = o.list.map((line, i) => listRow(line, i === o.ticketAt ? o.offer : null, z, size, colW));
      if (rows.some((r) => r.h > room)) continue;
      // Fill a column, then the next, then a new label; the order of the lines is kept.
      const pages: { columns: Block[][]; tallest: number }[] = [];
      let columns: Block[][] = [[]];
      let used = 0;
      let tallest = 0;
      for (const row of rows) {
        if (used + row.h > room) {
          if (columns.length < cols) columns.push([]);
          else {
            pages.push({ columns, tallest });
            columns = [[]];
            tallest = 0;
          }
          used = 0;
        }
        columns[columns.length - 1].push(row);
        used += row.h;
        tallest = Math.max(tallest, used);
      }
      if (rows.length) pages.push({ columns, tallest });
      // One label with two columns reads better balanced than one long column beside an empty one.
      if (pages.length === 1 && cols === 2) {
        const per = Math.ceil(rows.length / 2);
        const halves = [rows.slice(0, per), rows.slice(per)];
        const h = Math.max(...halves.map((c) => c.reduce((a, r) => a + r.h, 0)));
        if (h <= room) pages[0] = { columns: halves, tallest: h };
      }
      let notePage = -1;
      if (noteBlock) {
        const last = pages[pages.length - 1];
        if (last && last.tallest + noteBlock.h <= room) notePage = pages.length - 1;
        else {
          pages.push({ columns: [], tallest: 0 });
          notePage = pages.length - 1;
        }
      }
      if (onePage && pages.length > 1) continue;
      const total = pages.length + 1;
      return pages.map((page, i) => ({
        html:
          `<section class="label wb wb-more wb-${paper.orient}" style="gap:${gap}mm">` +
          moreHead(o, z, width, i + 2, total, compact).html +
          (titled ? title.html : '') +
          `<div class="wb-sheet">${page.columns.length ? listHtml(page.columns) : ''}${i === notePage ? noteBlock!.html : ''}</div>` +
          `</section>`,
      }));
    }
    return null;
  };

  for (const [s, m] of scales) {
    const done = attempt(s, m, true);
    if (done) return done;
  }
  // More than one label: at a size that reads comfortably — or at the floor, when that saves paper.
  const comfortable = attempt(Math.min(start, 0.9), 1, false);
  const floor = attempt(0.72, 1, false);
  if (comfortable && (!floor || comfortable.length <= floor.length)) return comfortable;
  if (floor) return floor;
  for (let m = 0.95; m >= 0.2; m = r2(m - 0.05)) {
    const done = attempt(0.72, m, false);
    if (done) return done;
  }
  return attempt(0.72, 0.15, false) ?? [];
}

// ── the first label ─────────────────────────────────────────────────────

interface Contents {
  (width: number, height: number): Block | null;
}

/** The room between the fixed blocks goes to the contents; null when the fixed blocks and the contents do not fit. */
function stack(
  blocks: (Block | null)[],
  itemsAt: number,
  contents: Contents | null,
  width: number,
  height: number,
  gap: number
): string | null {
  const fixed = blocks.filter((b): b is Block => b !== null);
  const used = fixed.reduce((s, b) => s + b.h, 0);
  const html = fixed.map((b) => b.html);
  if (!contents) {
    if (used + Math.max(0, fixed.length - 1) * gap > height) return null;
    return html.join('');
  }
  // The contents' own rules and padding, top and bottom.
  const chrome = 2 * 0.5 + 2 * 0.6;
  const room = height - used - fixed.length * gap - chrome;
  if (room <= 0) return null;
  const block = contents(width, room);
  if (!block) return null;
  const at = blocks.slice(0, itemsAt).filter((b) => b !== null).length;
  html.splice(at, 0, `<div class="wb-items">${block.html}</div>`);
  return html.join('');
}

interface Attempt {
  o: Order;
  paper: Paper;
  plan: Plan;
  z: Sizes;
  /** Every line on this label, or a pointer to the labels after it. */
  mode: 'full' | 'over';
  sheets: number;
}

/** The note left this label: say where it went. */
function noteElsewhere(a: Attempt, width: number): Block | null {
  if (!a.o.note || a.plan.noteHere) return null;
  const size = a.z.of('note');
  const text = 'ملاحظة الزبون بالورقة الثانية';
  return { html: `<p class="wb-elsewhere" style="${fs(size)}">${text}</p>`, h: lines(text, size, width, true) * size * LH };
}

function contentsOf(a: Attempt, listAlways: boolean): Contents | null {
  const { o, paper, z, mode, sheets } = a;
  if (!o.list.length) return null;
  if (mode === 'over') return (w, h) => pointer(o, z, w, h, sheets);
  if (o.list.length === 1 && !listAlways) return (w, h) => single(o, paper, z, w, h);
  return (w, h) => list(o, paper, z, w, h);
}

/** Design أ: header, the recipient beside the amount, the contents, the codes, the foot. */
function designA(a: Attempt): string | null {
  const { o, paper, plan, z } = a;
  const W = paper.iw;
  const gap = z.mm(1.3);
  const head = headA(o, plan, z, W);
  let mid: Block;
  let amount: Block | null = null;
  const codW = r2(clamp(W * (paper.orient === 'wide' ? 0.34 : 0.36), Math.min(26, W * 0.42), 80));
  const figure = ems(amountParts(o.l.cod).amount, true);
  const box = codW - 2 * (COD_FRAME + 1);
  // Beside each other only while both keep their size: else the recipient takes the width and the amount a bar of it.
  const cramped =
    figure * z.of('amount') * 0.7 > box || figure * 1.04 * z.floorOf('amount') > box || phoneFloorWidth(o, z) > W - codW - 2.5;
  if (paper.orient === 'tall' || cramped) {
    mid = who(o, plan, z, W, true);
    amount = cod(o, z, W, 'bar');
  } else {
    const person = who(o, plan, z, W - codW - 2.5, true);
    const stacked = cod(o, z, codW, 'stack');
    mid = {
      html: `<div class="wb-mid" style="grid-template-columns:minmax(0,1fr) ${codW}mm">${person.html}${stacked.html}</div>`,
      h: Math.max(person.h, stacked.h),
    };
  }
  const blocks = [head, mid, amount, noteElsewhere(a, W), codesRow(o, plan, paper, z, W), footA(o, plan, z, W)];
  const body = stack(blocks, 4, contentsOf(a, false), W, paper.ih, gap);
  return body === null ? null : `<section class="label wb wb-a wb-${paper.orient}" data-order="${esc(o.l.orderId)}" style="gap:${gap}mm">${body}</section>`;
}

/** The big total of design ب, in the product's word. */
function bigTotal(o: Order, z: Sizes, width: number, k: number): Block & { numS: number; wordS: number } {
  const n = String(totalUnits(o.list));
  const word = unitWord(parcelShape(o.list), totalUnits(o.list));
  const numS = r2(Math.min(46 * PT_MM * clamp(z.s, 0.7, 2.2) * k * z.m, width / ems(n, true)));
  const wordS = r2(Math.max(MIN_WORD_MM * z.m, Math.min(numS * 0.36, width / ems(word, true))));
  return {
    html: `<div class="wb-big"><b style="${fs(numS)}">${n}</b><span style="${fs(wordS)}">${word}</span></div>`,
    h: numS * 0.95 + wordS * LH,
    numS,
    wordS,
  };
}

/** Up to this many drawings stand under the big total. */
const MAX_BESIDE = 12;

/** The drawings under design ب's big total: one per piece when they fit `height`, else one drawing and «×N» of one shape. */
function besideShapes(o: Order, z: Sizes, width: number, height: number): Block | null {
  const n = totalUnits(o.list);
  if (n < 1) return null;
  for (const k of n <= MAX_BESIDE ? [1, 0.8, 0.65] : []) {
    const side = r2(Math.max(4.5, clamp(8 * z.s, 4.5, 16) * k) * z.m);
    const gap = r2(side * 0.12);
    const perRow = Math.max(1, Math.floor((width + gap) / (side + gap)));
    const rows = Math.ceil(n / perRow);
    const h = rows * side + (rows - 1) * gap;
    if (rows > 4 || h > height) continue;
    const html = o.list.map((l) => shapeSvg(l.shape, side).repeat(Math.max(0, l.qty))).join('');
    return { html: `<div class="wb-shapes wb-beside" style="gap:${gap}mm">${html}</div>`, h };
  }
  if (o.list.length !== 1) return null;
  const times = shapesBlock(o.list[0], 'times', z, width, false);
  return times && times.h <= height ? times : null;
}

/** Design ب on a wide label: a framed column holding the store, the total and the QR; the rest beside it. */
function designBSide(a: Attempt): string | null {
  const { o, paper, plan, z } = a;
  const sideW = r2(clamp(paper.iw * 0.25, 32, 70));
  const mainW = paper.iw - sideW - 3;
  const inner = sideW - 2 * 0.8 - 2 * 1.5;
  const sideH = paper.ih + SLACK_MM;
  const frame = 2 * 0.8 + 2 * 1.5;

  const brand = brandParts(o, plan, z, inner);
  const brandBlock: Block | null = brand.length
    ? { html: `<div class="wb-sidebrand">${brand.map((b) => b.html).join('')}</div>`, h: brand.reduce((s, b) => s + b.h, 0) + 1.5 }
    : null;
  const wantQr = plan.qr && o.show.qr;
  const qrS = r2(Math.min(inner, 25 * clamp(z.s, 0.75, 1.8) * z.m));
  let foot: Block | null = null;
  if (wantQr) foot = qrFigure(o, paper, z, qrS, o.show.ref);
  else if (o.show.ref) foot = refPart(o, z, inner);
  const total = o.list.length && plan.total ? bigTotal(o, z, inner, 1) : null;
  // A column with nothing but our reference is width taken from the courier's parts for nothing: the band instead.
  if (!total && !brandBlock && !wantQr) return designBBand(a, 1);
  const fixed = [brandBlock, total, foot].filter((b): b is Block => b !== null);
  const used = fixed.reduce((s, b) => s + b.h, 0) + frame + Math.max(0, fixed.length - 1) * 1.2;
  if (used > sideH) return null;
  const drawn = total ? besideShapes(o, z, inner, sideH - used - 1.2) : null;
  const side =
    `<div class="wb-side" style="width:${sideW}mm">` +
    [brandBlock?.html, total?.html, drawn?.html, foot?.html].filter(Boolean).join('') +
    `</div>`;

  const gap = z.mm(1.1);
  const headParts = [];
  if (plan.head && o.show.courierName && o.l.courier) headParts.push(pill(o.l.courier, z.of('courier'), mainW * 0.7));
  if (plan.support && supportText(o)) headParts.push(supportPart(o, z));
  const blocks = [
    rowOf('wb-head', headParts, mainW, true),
    who(o, plan, z, mainW),
    noteElsewhere(a, mainW),
    cod(o, z, mainW, 'bar'),
    barcode(o, paper, z, mainW),
  ];
  const body = stack(blocks, 3, contentsOf(a, true), mainW, paper.ih, gap);
  if (body === null) return null;
  return (
    `<section class="label wb wb-b wb-sided wb-${paper.orient}" data-order="${esc(o.l.orderId)}">` +
    `${side}<div class="wb-main" style="gap:${gap}mm">${body}</div></section>`
  );
}

/** Design ب on a tall, square or narrow label: the same frame laid across the top. */
function designBBand(a: Attempt, k: number): string | null {
  const { o, paper, plan, z } = a;
  const W = paper.iw;
  const gap = z.mm(1.2);
  const inner = W - 2 * 0.8 - 2 * 1.5;
  const brand = brandParts(o, plan, z, inner * 0.38);
  const wantQr = plan.qr && o.show.qr;
  const qrS = r2(qrSide(paper, z) * 0.95 * k);
  const qr = wantQr ? qrFigure(o, paper, z, qrS, o.show.ref) : null;
  const total = o.list.length && plan.total ? bigTotal(o, z, inner * 0.34, 0.72 * k) : null;
  const refInBand = !qr && o.show.ref ? refPart(o, z, inner * (brand.length ? 0.4 : 0.58)) : null;
  const cells = [
    brand.length
      ? { html: `<div class="wb-bandbrand">${brand.map((b) => b.html).join('')}</div>`, h: brand.reduce((s, b) => s + b.h, 0) }
      : null,
    total,
    qr ?? (refInBand ? { html: refInBand.html, h: refInBand.h } : null),
  ].filter((c): c is Block => c !== null);
  const band: Block | null = cells.length
    ? { html: `<div class="wb-band">${cells.map((c) => c.html).join('')}</div>`, h: Math.max(...cells.map((c) => c.h)) + 2 * 0.8 + 2 * 0.8 }
    : null;
  const headParts = [];
  if (plan.head && o.show.courierName && o.l.courier) headParts.push(pill(o.l.courier, z.of('courier'), W * 0.7));
  if (plan.support && supportText(o)) headParts.push(supportPart(o, z));
  const blocks = [
    band,
    rowOf('wb-head', headParts, W, true),
    who(o, plan, z, W),
    noteElsewhere(a, W),
    cod(o, z, W, 'bar'),
    barcode(o, paper, z, W),
  ];
  const listed = contentsOf(a, true);
  // One product: its line, and under it a drawing per piece (or one drawing and «×N») when the paper has the room.
  const contents: Contents | null =
    listed && a.mode === 'full' && o.list.length === 1
      ? (w, h) => {
          const line = listed(w, h);
          if (!line) return null;
          const drawn = besideShapes(o, z, w, h - line.h - 1);
          return drawn ? { html: line.html + drawn.html, h: line.h + 1 + drawn.h } : line;
        }
      : listed;
  const body = stack(blocks, 4, contents, W, paper.ih, gap);
  return body === null ? null : `<section class="label wb wb-b wb-${paper.orient}" data-order="${esc(o.l.orderId)}" style="gap:${gap}mm">${body}</section>`;
}

const SIDE_MIN_WIDTH = 130;

function draw(design: WaybillDesign, a: Attempt): string | null {
  if (design === 'a') return designA(a);
  // Too narrow for a column and a barcode beside it: the band.
  if (a.paper.orient === 'wide' && a.paper.width >= SIDE_MIN_WIDTH && a.paper.height >= 80) return designBSide(a);
  return designBBand(a, 1) ?? designBBand(a, 0.72);
}

/**
 * ONE ORDER, FITTED TO THE PAPER, each step tried from the paper's own scale down to the floor:
 *
 *   ONE PRODUCT stays on one label as long as it can: optional parts are given up before a second label is made.
 *   SEVERAL: every part and every line; else every part and the list on the labels after it; then optional parts given
 *   up one at a time (PLANS), every line first, then the pointer.
 *
 *   Then the first label carries the courier's parts alone, drawn tight (`courierOnly`). The courier's type stays at or
 *   above today's floor throughout, and is never cut.
 */
export function designOrder(
  design: WaybillDesign,
  label: LabelView,
  size: SheetSize,
  store: SheetStore,
  show?: DesignShow
): DesignedOrder {
  const paper = paperOf(size);
  const o = orderOf(label, store, show);
  const steps: number[] = [];
  for (let s = paper.base; s > 0.72; s = r2(s - 0.03)) steps.push(s);
  steps.push(0.72);

  /** The contents labels this plan would need — worked out only when asked, and once. */
  const memo = new Map<string, MoreBody[]>();
  const sheetsFor = (plan: Plan, mode: 'full' | 'over') => {
    const needList = mode === 'over' && o.list.length > 0;
    const needNote = !plan.noteHere && o.note !== null;
    if (!needList && !needNote) return [];
    const key = `${needList}:${needNote}`;
    let pages = memo.get(key);
    if (!pages) memo.set(key, (pages = contentsPages(needList ? o : { ...o, list: [], offer: null, ticketAt: -1 }, paper, needNote)));
    return pages;
  };
  const tryAt = (plan: Plan, mode: 'full' | 'over', s: number, m: number): DesignedOrder | null => {
    const more = sheetsFor(plan, mode);
    const main = draw(design, { o, paper, plan, z: sizesAt(paper, s, m), mode, sheets: more.length });
    return main === null ? null : { main, more: more.map((p) => p.html) };
  };

  const modes: ('full' | 'over')[] = o.list.length ? ['full', 'over'] : ['full'];
  // Where the note leaves the first label: everything before it keeps the order on one sheet.
  const noteLeaves = PLANS.findIndex((p) => !p.noteHere);
  const kept = PLANS.slice(0, noteLeaves);
  const rest = PLANS.slice(noteLeaves);
  const search: [readonly Plan[], 'full' | 'over'][] =
    o.list.length > 1
      ? [PLANS.slice(0, 2), PLANS.slice(2, noteLeaves), rest].flatMap((g) => modes.map((m) => [g, m] as [readonly Plan[], 'full' | 'over']))
      : [kept, rest].flatMap((g) => modes.map((m) => [g, m] as [readonly Plan[], 'full' | 'over']));
  for (const [group, mode] of search) {
    for (const plan of group) {
      for (const s of steps) {
        const done = tryAt(plan, mode, s, 1);
        if (done) return done;
      }
    }
  }
  const bare: Plan = { ...PLANS[PLANS.length - 1], noteHere: false };
  const more = sheetsFor(bare, o.list.length ? 'over' : 'full');
  return {
    main: courierOnly(design, o, paper, bare, more.length),
    more: more.map((p) => p.html),
  };
}

/** How far under its floor a courier's type may be taken, and in what steps, when nothing else can print it whole. */
const UNDER_STEPS: readonly { address: number; all: number }[] = (() => {
  const steps = [{ address: 1, all: 1 }];
  for (let a = 0.95; a >= 0.7; a = r2(a - 0.05)) steps.push({ address: a, all: 1 });
  for (let all = 0.96; all >= 0.2; all = r2(all - 0.04)) steps.push({ address: 0.7, all });
  return steps;
})();

/**
 * THE FIRST LABEL WITH THE COURIER'S PARTS ALONE, drawn tight — the recipient across the whole width, the amount on a
 * thin row, the barcode, and one line saying the rest is on the next label where it still fits.
 *
 * Reached only when no design fits: a long address on a paper near 70 mm. Everything is tried at the floor first. A text
 * that cannot be printed whole at the floor — in practice hundreds of characters — is then drawn smaller, the address
 * before anything else, because the current waybill's answer, cutting it, is the one thing these designs never do.
 */
function courierOnly(design: WaybillDesign, o: Order, paper: Paper, plan: Plan, sheets: number): string {
  const gap = 0.5;
  let blocks: Block[] = [];
  for (const under of UNDER_STEPS) {
    const z = sizesAt(paper, 0.72, 1, under);
    blocks = [who(o, plan, z, paper.iw, false, TIGHT_LH), codTight(o, z, paper.iw), barcode(o, paper, z, paper.iw)];
    const used = blocks.reduce((s, b) => s + b.h, 0) + (blocks.length - 1) * gap;
    if (used > paper.ih) continue;
    if (sheets) {
      // The packer's line: the count and where the list is; on the tightest label, only that there is more.
      const room = paper.ih - used - gap;
      const size = z.of('note');
      const text = sheets > 1 ? 'الباقي بالأوراق التالية' : 'الباقي بالورقة الثانية';
      const h = lines(text, size, paper.iw, true) * size * TIGHT_LH;
      const where =
        (o.list.length ? pointer(o, z, paper.iw, room, sheets) : null) ??
        (h <= room ? { html: `<p class="wb-elsewhere" style="${fs(size)}">${text}</p>`, h } : null);
      if (where) blocks.splice(1, 0, where);
    }
    break;
  }
  return (
    `<section class="label wb wb-${design} wb-${paper.orient} wb-tight" data-order="${esc(o.l.orderId)}" style="gap:${gap}mm">` +
    `${blocks.map((b) => b.html).join('')}</section>`
  );
}

// ── the stylesheet ──────────────────────────────────────────────────────

/** The store's name is set in our own face, served by this application: the print page asks nobody else for anything. */
const BRAND_FACE = `  @font-face { font-family: "WaybillBrand"; src: url("/fonts/reem-kufi-var.woff2") format("woff2");
               font-weight: 400 700; font-display: block; }`;

/**
 * The new designs' own stylesheet. Black on white and nothing else: no other colour, no transparency, no letter
 * drawn in white, nothing that depends on a background being printed.
 */
export function designCss(size: SheetSize): string {
  const paper = paperOf(size);
  return `${BRAND_FACE}
  .label.wb { width: ${size.width}mm; height: ${size.height}mm; padding: ${paper.pad}mm; overflow: hidden;
              display: flex; flex-direction: column; border: 1px dashed #000; color: #000; background: #fff; line-height: ${LH}; }
  .wb p, .wb figure { margin: 0; }
  /* The dashed edge is the screen's alone — said again here, after the rule that draws it and more specific than the
     sheet's own print rule, so it never reaches the paper. */
  @media print { .label.wb { border-color: transparent; } }
  .wb > *, .wb-main > *, .wb-side > * { flex: 0 0 auto; min-width: 0; }
  .wb .wb-items { flex: 1 1 0; min-height: 0; display: flex; flex-direction: column; justify-content: center;
                  border-top: 0.5mm solid #000; border-bottom: 0.5mm solid #000; padding: 0.6mm 0; }

  .wb-head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 0.6mm 2mm;
             padding-bottom: 0.8mm; border-bottom: 0.8mm solid #000; }
  .wb-brandbox { display: flex; align-items: center; gap: 1.5mm; min-width: 0; }
  .wb-brand { font-family: "WaybillBrand", Tahoma, sans-serif; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .wb-logo { object-fit: contain; }
  .wb-pill { border: 0.5mm solid #000; border-radius: 5mm; padding: 0.2mm 3mm; font-weight: bold; text-align: center; overflow-wrap: anywhere; }
  .wb-ref, .wb-support { overflow-wrap: anywhere; }

  .wb-mid { display: grid; gap: 2.5mm; align-items: stretch; }
  .wb-who { display: flex; flex-direction: column; min-width: 0; overflow-wrap: anywhere; }
  .wb-line { display: flex; align-items: center; gap: 1.4mm; }
  .wb-line > p { flex: 1; min-width: 0; }
  .wb-mark { flex-shrink: 0; }
  .wb-name { font-weight: bold; }
  .wb-phones { direction: ltr; display: flex; flex-wrap: wrap; justify-content: flex-end; column-gap: 4mm; font-weight: bold; line-height: 1.2; }
  .wb-phones span { white-space: nowrap; letter-spacing: 0.03em; }
  .wb-phones span.wb-long { white-space: normal; overflow-wrap: anywhere; min-width: 0; }
  .wb-place b { font-weight: bold; }
  .wb-note { border-top: 0.3mm dashed #000; padding-top: 0.6mm; overflow-wrap: anywhere; }
  .wb-elsewhere { font-weight: bold; }

  .wb-cod { border: ${COD_FRAME}mm solid #000; border-radius: 3.5mm; display: flex; align-items: center; font-weight: bold; text-align: center; }
  .wb-cod-stack { flex-direction: column; justify-content: center; padding: 0.8mm 1mm; }
  .wb-cod-bar { flex-wrap: wrap; justify-content: space-between; column-gap: 2.5mm; padding: 0.5mm 2mm; }
  .wb-cod strong { line-height: 1.15; white-space: nowrap; }
  .wb-cod strong.wb-long { white-space: normal; overflow-wrap: anywhere; min-width: 0; }
  .wb-cod em { font-style: normal; letter-spacing: 0.08em; }

  .wb-tight .wb-who p { line-height: ${TIGHT_LH}; }
  .wb-cod-tight { border-width: 0.7mm; border-radius: 2mm; padding: 0.2mm 1mm; column-gap: 2mm; }

  .wb-codes { display: flex; align-items: center; gap: 2mm; }
  .wb-bc { min-width: 0; border: 0.4mm solid #000; border-radius: 2.5mm; padding: 0.8mm 0.4mm 0; text-align: center; }
  .wb-codes > .wb-bc { flex: 1; }
  .wb-bc svg { display: block; }
  .wb-bc figcaption, .wb-qr figcaption { font-weight: bold; white-space: nowrap; line-height: ${LH}; }
  .wb-qr { flex-shrink: 0; text-align: center; }
  .wb-qr svg { display: block; width: 100%; height: auto; aspect-ratio: 1; }
  .wb-foot { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: 0.6mm 2mm; }
  .wb-total b { font-weight: bold; }

  .wb-one { display: flex; align-items: center; min-width: 0; }
  .wb-one-column { flex-direction: column; text-align: center; }
  .wb-count { flex-shrink: 0; border: 1mm solid #000; border-radius: 50%; display: flex; flex-direction: column;
              align-items: center; justify-content: center; font-weight: bold; }
  .wb-count b { line-height: 0.95; }
  .wb-count span { line-height: 1.2; }
  .wb-what { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: flex-start; overflow-wrap: anywhere; }
  .wb-one-column .wb-what { flex: 0 0 auto; align-items: center; width: 100%; }
  .wb-pname, .wb-variant { font-weight: bold; }
  .wb-shapes { display: flex; flex-wrap: wrap; align-items: center; }
  .wb-nameline { display: flex; align-items: center; gap: 2.5mm; }
  .wb-nameline .wb-shapes { flex-wrap: nowrap; }
  .wb-one-column .wb-shapes { justify-content: center; }
  .wb-shape, .wb-gift { display: block; flex-shrink: 0; }
  .wb-ticket { display: inline-flex; align-items: center; gap: 1.2mm; flex-shrink: 0; border: 0.5mm solid #000; border-radius: 3mm;
               outline: 0.3mm dashed #000; outline-offset: 0.6mm; margin: 1mm; padding: 0.5mm 2.2mm; font-weight: bold; overflow-wrap: anywhere; }
  .wb-tag { border: 0.3mm solid #000; border-radius: 0.8mm; padding: 0 1mm; font-weight: bold; white-space: nowrap; }

  .wb-list { display: flex; align-items: flex-start; gap: ${COLUMN_GAP}mm; }
  .wb-col { flex: 1 1 0; min-width: 0; }
  .wb-row { display: flex; align-items: center; gap: 1.4mm; padding: 0.5mm 0; border-bottom: 0.3mm dashed #000; }
  .wb-qty { flex-shrink: 0; border: 0.6mm solid #000; border-radius: 1.4mm; font-weight: bold; text-align: center; line-height: 1.15; }
  .wb-text { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: flex-start; font-weight: bold; overflow-wrap: anywhere; }
  .wb-over { display: flex; flex-direction: column; align-items: center; text-align: center; border: 0.6mm dashed #000;
             border-radius: 2mm; padding: 1.2mm 1.5mm; font-weight: bold; overflow-wrap: anywhere; }
  .wb-over-short { padding-top: 0.4mm; padding-bottom: 0.4mm; }

  .label.wb.wb-sided { flex-direction: row; gap: 3mm; }
  .wb-side { display: flex; flex-direction: column; align-items: center; justify-content: space-between; gap: 1.2mm;
             border: 0.8mm solid #000; border-radius: 4mm; padding: 1.5mm; text-align: center; }
  .wb .wb-main { flex: 1 1 0; display: flex; flex-direction: column; }
  .wb-sidebrand { display: flex; flex-direction: column; align-items: center; gap: 0.8mm; width: 100%;
                  border-bottom: 0.5mm solid #000; padding-bottom: 0.8mm; }
  .wb-bandbrand { display: flex; flex-direction: column; align-items: center; gap: 0.8mm; min-width: 0; }
  .wb-sidebrand .wb-brand, .wb-bandbrand .wb-brand { max-width: 100%; }
  .wb-big { display: flex; flex-direction: column; align-items: center; font-weight: bold; }
  .wb-big b { line-height: 0.95; }
  .wb-beside { justify-content: center; }
  .wb-band { display: flex; align-items: center; justify-content: space-between; gap: 2mm;
             border: 0.8mm solid #000; border-radius: 4mm; padding: 0.8mm 1.5mm; }

  .wb-title { font-weight: bold; text-align: center; }
  .wb .wb-sheet { flex: 1 1 0; min-height: 0; display: flex; flex-direction: column; gap: 1.2mm; }
`;
}
