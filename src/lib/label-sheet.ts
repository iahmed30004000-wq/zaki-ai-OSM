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
 *   compact   < 95 wide or < 110 tall (100×100) — adds logo, QR, two item lines
 *   standard  up to 110×160 (100×150, A6) — everything
 *   large     A5 and A4 — everything, set larger
 */
export function tierFor(size: SheetSize): Tier {
  const { width: w, height: h } = size;
  if (w < 70 || h < 70) return 'tiny';
  if (w < 95 || h < 110) return 'compact';
  if (w <= 110 && h <= 160) return 'standard';
  return 'large';
}

const TIER = {
  tiny: { scale: 0.78, qr: 0, bar: 10, items: 0, note: 0, place: 1, pad: 2 },
  compact: { scale: 0.9, qr: 18, bar: 12, items: 2, note: 1, place: 2, pad: 2.5 },
  standard: { scale: 1, qr: 22, bar: 14, items: 4, note: 2, place: 3, pad: 3.5 },
  large: { scale: 1.3, qr: 30, bar: 18, items: 8, note: 3, place: 3, pad: 6 },
} as const;

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

function labelHtml(l: LabelView, tier: Tier, store: SheetStore): string {
  const t = TIER[tier];
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
  const tier = tierFor(size);
  const t = TIER[tier];
  const pdf = opts.mode === 'pdf';

  const sheets: string[] = [];
  for (let p = 0; p < pages; p++) {
    const chunk = labels.slice(p * perPage, (p + 1) * perPage);
    const run = Math.floor((p * perPage) / PRINT_CHUNK);
    sheets.push(
      `<div class="page" data-run="${run}">${chunk.map((l) => labelHtml(l, tier, opts.store)).join('')}</div>`
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
  .label { --s: ${t.scale}; --qr: ${t.qr}mm;
           width: ${size.width}mm; height: ${size.height}mm; padding: ${t.pad}mm; overflow: hidden;
           display: grid; gap: calc(1.4mm * var(--s));
           /* Header, COD, codes and footer always take their full height.
              The recipient block and the contents give way — never the
              barcode. */
           grid-template-rows: auto minmax(0, max-content) minmax(0, 1fr) auto auto auto;
           border: 1px dashed #c3c9d2; font-size: calc(8.5pt * var(--s)); line-height: 1.35; }

  .head { display: flex; justify-content: space-between; align-items: center; gap: 2mm;
          padding-bottom: calc(1.2mm * var(--s)); border-bottom: 0.5mm solid #000; }
  .brand { display: flex; align-items: center; gap: 1.5mm; min-width: 0; }
  .brand strong { font-size: calc(10pt * var(--s)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .logo { height: calc(7mm * var(--s)); max-width: calc(22mm * var(--s)); object-fit: contain; }
  .courier { display: flex; flex-direction: column; align-items: flex-end; flex-shrink: 0;
             font-size: calc(7.5pt * var(--s)); }
  .courier b { font-size: calc(9pt * var(--s)); letter-spacing: .3px; }

  .who { overflow: hidden; }
  .who p { margin: 0; }
  .name { font-size: calc(12.5pt * var(--s)); font-weight: bold; line-height: 1.2;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .phones { font-size: calc(10.5pt * var(--s)); font-weight: bold; letter-spacing: .4px; text-align: right; }
  .place { display: -webkit-box; -webkit-box-orient: vertical; overflow: hidden; }

  .body { overflow: hidden; border-top: 0.2mm solid #d0d5dd; padding-top: calc(1mm * var(--s)); }
  .items { margin: 0; padding: 0; list-style: none; }
  .items li { display: flex; align-items: baseline; gap: 1.5mm; }
  .items .iname { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .items .qty { flex-shrink: 0; }
  .items .more { opacity: .75; }
  .tag { flex-shrink: 0; border: 0.25mm solid #000; border-radius: 0.8mm; padding: 0 1mm;
         font-size: calc(6.5pt * var(--s)); font-weight: bold; }
  .count { margin: 0; font-weight: bold; }
  .note { margin: calc(0.8mm * var(--s)) 0 0; display: -webkit-box; -webkit-box-orient: vertical; overflow: hidden; }

  /* The number the driver collects: black, so it cannot be missed. */
  .cod { display: flex; justify-content: space-between; align-items: center; gap: 2mm;
         background: #000; color: #fff; border-radius: 1mm;
         padding: calc(1.2mm * var(--s)) calc(2.2mm * var(--s)); font-size: calc(8pt * var(--s)); }
  .cod strong { font-size: calc(13pt * var(--s)); letter-spacing: .3px; white-space: nowrap; }

  .codes { display: flex; align-items: flex-end; gap: calc(2.5mm * var(--s)); }
  figure { margin: 0; text-align: center; }
  .barcode { flex: 1; min-width: 0; }
  .qr { flex-shrink: 0; width: var(--qr); }
  .qr svg { display: block; width: var(--qr); height: var(--qr); }
  figcaption { font-size: calc(7pt * var(--s)); letter-spacing: 1px; margin-top: 0.4mm;
               white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  .foot { font-size: calc(7pt * var(--s)); text-align: center; border-top: 0.2mm solid #d0d5dd;
          padding-top: calc(0.8mm * var(--s)); }

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
