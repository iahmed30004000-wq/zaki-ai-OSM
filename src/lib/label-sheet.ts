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
 *   THE PAPER DECIDES HOW BIG. The tier says what is shown; how large it is
 *   drawn follows the millimetres themselves, continuously — see fitFor().
 *   Four steps of one size each used to print A4 like A5 (small text in a
 *   big blank) and put a 100 mm wide label in the A4 step.
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
 * What a label of this size can hold.
 *
 *   tiny      < 70 mm either way — barcode, COD, name, phone, one line of place
 *   compact   < 95 wide or < 110 tall (100×100, 150×100) — adds logo, QR, two item lines
 *   standard  the rest (100×150, A6, 100×200) — everything
 *   large     BOTH sides at least 140 (A5, A4) — everything, more lines
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

/** What each tier SHOWS. How big it is drawn is fitFor()'s, not the tier's. */
const TIER = {
  tiny: { qr: false, items: 0, note: 0, place: 1 },
  compact: { qr: true, items: 2, note: 1, place: 2 },
  standard: { qr: true, items: 4, note: 2, place: 3 },
  large: { qr: true, items: 8, note: 3, place: 3 },
} as const;

/**
 * The type sizes of one label at fit 1, in points. The stylesheet below is
 * written from these numbers and fitFor() measures with the same ones, so
 * what is measured is what is printed.
 */
const PT = {
  body: 8.5,
  brand: 10,
  courier: 7.5,
  courierRef: 9,
  name: 12.5,
  phones: 10.5,
  codLabel: 8,
  codAmount: 13,
  caption: 7,
  foot: 7,
  tag: 6.5,
} as const;
const PT_MM = 25.4 / 72;
/** The label's line height, and the name's. */
const LINE = 1.35;
const NAME_LINE = 1.2;
/** Millimetres at fit 1: the gap between rows, the paddings inside the rows. */
const MM = { gap: 1.4, headPad: 1.2, headRule: 0.5, codPad: 1.2, captionTop: 0.4, footPad: 0.8, footRule: 0.2, bodyPad: 1, bodyRule: 0.2 } as const;
/** The dashed outline of a label, one CSS pixel each side. */
const OUTLINE_MM = 25.4 / 96;
/** At most this many item lines, however tall the paper. */
const MAX_ITEMS = 12;

/** One line of text this size, in millimetres, at fit `s`. */
const lineMm = (pt: number, s: number, line = LINE) => pt * PT_MM * line * s;
const r2 = (n: number) => Math.round(n * 100) / 100;

export interface LabelFit {
  tier: Tier;
  /** The one number everything is drawn at: the stylesheet's `--s`. */
  fit: number;
  /** Millimetres; the QR is 0 when the tier leaves it off. */
  qr: number;
  bar: number;
  pad: number;
  items: number;
  note: number;
  place: number;
  /** The height inside the padding and outline. */
  usableMm: number;
  /**
   * What the rows that never give way take — header, COD, codes, footer, the
   * gaps between rows, and the name and phone line of the recipient — so a
   * test can hold that they fit the paper.
   */
  reservedMm: number;
  /** reservedMm plus every line the label may print: place, items, note. */
  fullMm: number;
}

/**
 * HOW BIG, FROM THE MILLIMETRES.
 *
 *   fit = min(width / 100, height / 150), held between 0.7 and 2.2
 *
 * 100×150 is the reference the type sizes were set on. The smaller of the
 * two ratios decides, because the label is a column: a wide label is not
 * taller for being wide. Below 0.7 the type stops being readable on a
 * thermal head; the upper bound is above anything the picker offers (A4 is
 * 1.98), so the ceiling never shrinks a real page.
 *
 * The QR (22 mm at fit 1), the barcode height (14) and the padding (3.5)
 * follow the same number. A taller-than-reference label — 100×200 — gets
 * the height it has over 150 as more item lines, up to twelve.
 */
export function fitFor(size: SheetSize): LabelFit {
  const tier = tierFor(size);
  const t = TIER[tier];
  const s = r2(Math.min(2.2, Math.max(0.7, Math.min(size.width / 100, size.height / 150))));
  const qr = t.qr ? r2(22 * s) : 0;
  const bar = r2(14 * s);
  const pad = r2(3.5 * s);
  const body = lineMm(PT.body, s);

  const extra = t.items > 0 ? Math.max(0, Math.floor((size.height / s - 150) / lineMm(PT.body, 1))) : 0;
  const items = Math.min(MAX_ITEMS, t.items + extra);

  const head = Math.max(lineMm(PT.courier + PT.courierRef, s), 7 * s) + MM.headPad * s + MM.headRule;
  const cod = lineMm(PT.codAmount, s) + 2 * MM.codPad * s;
  const codes = Math.max(bar, qr) + lineMm(PT.caption, s) + MM.captionTop;
  const foot = tier === 'tiny' ? 0 : lineMm(PT.foot, s) + MM.footPad * s + MM.footRule;
  const gaps = 5 * MM.gap * s;
  const who = lineMm(PT.name, s, NAME_LINE) + lineMm(PT.phones, s);
  const reservedMm = head + cod + codes + foot + gaps + who;

  // Items: the lines shown, plus «و٣ أصناف أخرى»; none means the one count line.
  const itemLines = items > 0 ? items + 1 : 1;
  const fullMm =
    reservedMm + (t.place + t.note + itemLines) * body + MM.bodyPad * s + MM.bodyRule;

  return {
    tier,
    fit: s,
    qr,
    bar,
    pad,
    items,
    note: t.note,
    place: t.place,
    usableMm: size.height - 2 * pad - 2 * OUTLINE_MM,
    reservedMm,
    fullMm,
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

function labelHtml(l: LabelView, t: LabelFit, store: SheetStore): string {
  const tier = t.tier;
  const code = encodableCode128(l.courierCode);
  const logo =
    store.logoUrl && tier !== 'tiny' ? `<img class="logo" src="${esc(store.logoUrl)}" alt="">` : '';
  const phones = (tier === 'tiny' ? l.phones.slice(0, 1) : l.phones).filter(Boolean);

  return `<section class="label" data-order="${esc(l.orderId)}">
  <header class="head">
    <div class="brand">${logo}<strong>${esc(store.name)}</strong></div>
    <div class="courier"><span>${esc(l.courier)}</span><b dir="ltr">${esc(l.ref)}</b></div>
  </header>
  <div class="who">
    <p class="name">${esc(l.name)}</p>
    ${phones.length ? `<p class="phones" dir="ltr">${phones.map(esc).join('  ·  ')}</p>` : ''}
    <p class="place" style="-webkit-line-clamp:${t.place}">${esc(l.place)}</p>
  </div>
  <div class="body">
    ${itemsHtml(l.items, t.items)}
    ${l.note && t.note > 0 ? `<p class="note" style="-webkit-line-clamp:${t.note}"><b>ملاحظة:</b> ${esc(l.note)}</p>` : ''}
  </div>
  <div class="cod"><span>المبلغ عند الاستلام</span><strong dir="ltr">${esc(l.cod)}</strong></div>
  <div class="codes">
    <figure class="barcode">${barcodeSvg(l.courierCode, t.bar)}<figcaption dir="ltr">${esc(code)}</figcaption></figure>
    ${t.qr > 0 ? `<figure class="qr">${l.qrSvg}<figcaption dir="ltr">${esc(l.ref)}</figcaption></figure>` : ''}
  </div>
  ${
    store.supportPhone && tier !== 'tiny'
      ? `<footer class="foot">للاستفسار: <span dir="ltr">${esc(store.supportPhone)}</span></footer>`
      : ''
  }
</section>`;
}

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
      `<div class="page" data-run="${run}">${chunk.map((l) => labelHtml(l, t, opts.store)).join('')}</div>`
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

  /* ── one label ── */
  .label { --s: ${t.fit}; --qr: ${t.qr}mm;
           width: ${size.width}mm; height: ${size.height}mm; padding: ${t.pad}mm; overflow: hidden;
           display: grid; gap: calc(${MM.gap}mm * var(--s));
           /* Header, COD, codes and footer always take their full height.
              The recipient block and the contents give way — never the
              barcode. */
           grid-template-rows: auto minmax(0, max-content) minmax(0, 1fr) auto auto auto;
           border: 1px dashed #c3c9d2; font-size: calc(${PT.body}pt * var(--s)); line-height: ${LINE}; }

  .head { display: flex; justify-content: space-between; align-items: center; gap: 2mm;
          padding-bottom: calc(${MM.headPad}mm * var(--s)); border-bottom: ${MM.headRule}mm solid #000; }
  .brand { display: flex; align-items: center; gap: 1.5mm; min-width: 0; }
  .brand strong { font-size: calc(${PT.brand}pt * var(--s)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .logo { height: calc(7mm * var(--s)); max-width: calc(22mm * var(--s)); object-fit: contain; }
  .courier { display: flex; flex-direction: column; align-items: flex-end; flex-shrink: 0;
             font-size: calc(${PT.courier}pt * var(--s)); }
  .courier b { font-size: calc(${PT.courierRef}pt * var(--s)); letter-spacing: .3px; }

  .who { overflow: hidden; }
  .who p { margin: 0; }
  .name { font-size: calc(${PT.name}pt * var(--s)); font-weight: bold; line-height: ${NAME_LINE};
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .phones { font-size: calc(${PT.phones}pt * var(--s)); font-weight: bold; letter-spacing: .4px; text-align: right; }
  .place { display: -webkit-box; -webkit-box-orient: vertical; overflow: hidden; }

  .body { overflow: hidden; border-top: ${MM.bodyRule}mm solid #d0d5dd; padding-top: calc(${MM.bodyPad}mm * var(--s)); }
  .items { margin: 0; padding: 0; list-style: none; }
  .items li { display: flex; align-items: baseline; gap: 1.5mm; }
  .items .iname { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .items .qty { flex-shrink: 0; }
  .items .more { opacity: .75; }
  .tag { flex-shrink: 0; border: 0.25mm solid #000; border-radius: 0.8mm; padding: 0 1mm;
         font-size: calc(${PT.tag}pt * var(--s)); font-weight: bold; }
  .count { margin: 0; font-weight: bold; }
  .note { margin: calc(0.8mm * var(--s)) 0 0; display: -webkit-box; -webkit-box-orient: vertical; overflow: hidden; }

  /* The number the driver collects: black, so it cannot be missed. */
  .cod { display: flex; justify-content: space-between; align-items: center; gap: 2mm;
         background: #000; color: #fff; border-radius: 1mm;
         padding: calc(${MM.codPad}mm * var(--s)) calc(2.2mm * var(--s)); font-size: calc(${PT.codLabel}pt * var(--s)); }
  .cod strong { font-size: calc(${PT.codAmount}pt * var(--s)); letter-spacing: .3px; white-space: nowrap; }

  .codes { display: flex; align-items: flex-end; gap: calc(2.5mm * var(--s)); }
  figure { margin: 0; text-align: center; }
  .barcode { flex: 1; min-width: 0; }
  .qr { flex-shrink: 0; width: var(--qr); }
  .qr svg { display: block; width: var(--qr); height: var(--qr); }
  figcaption { font-size: calc(${PT.caption}pt * var(--s)); letter-spacing: 1px; margin-top: ${MM.captionTop}mm;
               white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  .foot { font-size: calc(${PT.foot}pt * var(--s)); text-align: center; border-top: ${MM.footRule}mm solid #d0d5dd;
          padding-top: calc(${MM.footPad}mm * var(--s)); }

  @media print {
    ${runRules}
    html, body { background: #fff; }
    .bar, .skipped, .outside { display: none; }
    .page { margin: 0; box-shadow: none; break-after: page; }
    .page:last-child { break-after: auto; }
    .label { border-color: transparent; }
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
