import { describe, it, expect } from 'vitest';
import {
  barcodeSvg, fitFor, labelsPerPage, legacyScale, needOf, renderLabelSheet, storeLogoForPrint, tierFor,
  FLOOR_PT, LABEL_CSS, PRINT_CHUNK, QUIET_MODULES, type LabelView, type SheetOptions,
} from './label-sheet';
import { code128Bars, LABEL_SIZES } from './labels';

const label = (i: number, over: Partial<LabelView> = {}): LabelView => ({
  orderId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  courier: 'LogesTechs',
  ref: `SY-${10000 + i}`,
  courierCode: `JO${7000000000 + i}`,
  name: 'محمد الشمري',
  phones: ['0791234567'],
  place: 'عمان — شارع المدينة',
  items: [{ name: 'منتج', qty: 2 }],
  note: null,
  cod: '32.500 JOD',
  qrSvg: '<svg class="q"></svg>',
  ...over,
});
const thermal = { width: 100, height: 150 };
const many = (n: number) => Array.from({ length: n }, (_, i) => label(i));
const opts = (over: Partial<SheetOptions> = {}): SheetOptions => ({
  store: { name: 'صحة بلس', logoUrl: null, supportPhone: null },
  mode: 'print',
  token: 'tok.en.value',
  stampUrl: '/api/ops/labels/printed',
  ...over,
});
const sheet = (labels: LabelView[], size = thermal, o: Partial<SheetOptions> = {}) =>
  renderLabelSheet(labels, size, opts(o));

describe('the barcode — one element, the same bars, quiet zones included', () => {
  it('draws every dark bar at the position and width Code 128 gives it, after the quiet zone', () => {
    const value = 'JO7000000123';
    const bars = code128Bars(value);
    const expected: [number, number][] = [];
    let x = QUIET_MODULES;
    bars.forEach((w, i) => {
      if (i % 2 === 0) expected.push([x, w]);
      x += w;
    });
    const d = /d="([^"]+)"/.exec(barcodeSvg(value, 14))![1];
    const drawn = [...d.matchAll(/M(\d+) 0h(\d+)v10h-\d+z/g)].map((m) => [Number(m[1]), Number(m[2])]);
    expect(drawn).toEqual(expected);
  });

  it('leaves ten modules of white on each side', () => {
    const value = 'JO7000000123';
    const total = code128Bars(value).reduce((a, b) => a + b, 0);
    const svg = barcodeSvg(value, 14);
    expect(svg).toContain(`viewBox="0 0 ${total + 2 * QUIET_MODULES} 10"`);
    expect(svg).toContain(`M${QUIET_MODULES} 0h`);
  });

  it('is a single path, never one element per bar', () => {
    const svg = barcodeSvg('JO7000000123', 14);
    expect(svg.match(/<path/g)).toHaveLength(1);
    expect(svg).not.toContain('<rect');
  });
});

describe('size decides what fits', () => {
  it('sorts the offered sizes into tiers', () => {
    expect(tierFor({ width: 60, height: 40 })).toBe('tiny');
    expect(tierFor({ width: 100, height: 100 })).toBe('compact');
    expect(tierFor({ width: 100, height: 150 })).toBe('standard');
    expect(tierFor({ width: 105, height: 148 })).toBe('standard');
    expect(tierFor({ width: 210, height: 148 })).toBe('large');
    expect(tierFor({ width: 210, height: 297 })).toBe('large');
    // Large needs BOTH sides big. 100×200 was «large» (more than 160 tall)
    // with a 100 mm wide label; 150×100 was and stays compact (100 tall).
    expect(tierFor({ width: 100, height: 200 })).toBe('standard');
    expect(tierFor({ width: 150, height: 100 })).toBe('compact');
    expect(tierFor({ width: 140, height: 140 })).toBe('large');
    expect(tierFor({ width: 139, height: 300 })).toBe('standard');
  });

  it('keeps the barcode and the COD on the smallest label, and drops the QR and the item list', () => {
    // 60×40 cannot hold a 9.8 mm barcode, the COD and four lines at the
    // floor: the count line and the header go before the type shrinks.
    const html = sheet([label(0)], { width: 60, height: 40 });
    expect(html).toContain('<figure class="barcode">');
    expect(html).toContain('32.500 JOD');
    expect(html).not.toContain('<figure class="qr">');
    expect(html).not.toContain('<ul class="items">');
    // 70 mm tall has room for the count line.
    expect(sheet([label(0)], { width: 60, height: 70 })).toContain('<p class="count">2 قطع</p>');
  });

  it('puts two landscape A5 on one A4', () => {
    expect(labelsPerPage({ width: 210, height: 148, sheetWidth: 210, sheetHeight: 297 })).toBe(2);
    expect(labelsPerPage({ width: 105, height: 148, sheetWidth: 210, sheetHeight: 297 })).toBe(4);
    expect(labelsPerPage(thermal)).toBe(1);
  });

  it('lays out the scannable rows so they cannot be squeezed out', () => {
    // Header, COD, codes and footer are auto rows; the recipient and the
    // contents are the rows allowed to shrink.
    expect(sheet([label(0)])).toContain('grid-template-rows: auto minmax(0, max-content) minmax(0, 1fr) auto auto auto');
  });
});

/**
 * THE WAYBILL FOLLOWS ITS PAPER.
 *
 * «بدي البوليصة تتكيف تلقائيا ع الحجم الي بحطو». The codes, the QR and the
 * padding follow the millimetres (2/11); the type follows what fits — see
 * «the waybill is read off a thermal head» below.
 */
describe('the waybill follows its paper', () => {
  const SIZES: [string, number, number][] = [
    ['50×75', 50, 75],
    ['75×100', 75, 100],
    ['100×100', 100, 100],
    ['100×150', 100, 150],
    ['150×100', 150, 100],
    ['100×200', 100, 200],
    ['A6', 105, 148],
    ['A5 بالعرض', 210, 148],
    ['A4', 210, 297],
  ];

  it.each(SIZES)('%s: every row that never gives way fits the height inside the padding', (_n, width, height) => {
    const f = fitFor({ width, height });
    expect(f.reservedMm).toBeGreaterThan(0);
    expect(f.reservedMm).toBeLessThanOrEqual(f.usableMm);
    // And with every line it prints — place, items, the note — too.
    expect(f.fullMm).toBeLessThanOrEqual(f.usableMm);
  });

  it('measures what the stylesheet draws — 100×150 reserves about 65 mm of its 142', () => {
    const f = fitFor(thermal);
    expect(f.usableMm).toBeCloseTo(150 - 7 - 2 * (25.4 / 96), 2);
    expect(f.reservedMm).toBeCloseTo(65, 0);
  });

  it('the codes grow with the paper and shrink with it — A4 twice 100×150', () => {
    const a4 = fitFor({ width: 210, height: 297 });
    const a6 = fitFor({ width: 105, height: 148 });
    const square = fitFor({ width: 100, height: 100 });
    expect(a4.qr).toBeGreaterThan(a6.qr);
    expect(a6.qr).toBeGreaterThan(square.qr);
    expect(a4.bar).toBeGreaterThan(a6.bar);
    expect(a6.bar).toBeGreaterThan(square.bar);
    expect(a4.codes / fitFor(thermal).codes).toBeCloseTo(1.98, 2);
  });

  it('the codes are held between 0.7 and 2.2', () => {
    expect(fitFor({ width: 40, height: 40 }).codes).toBe(0.7);
    expect(fitFor({ width: 300, height: 300 }).codes).toBe(2);
    expect(fitFor({ width: 500, height: 500 }).codes).toBe(2.2);
  });

  it('writes the numbers into the sheet — A4', () => {
    const html = sheet([label(0)], { width: 210, height: 297 });
    expect(html).toContain('--c: 1.98; --qr: 43.56mm;');
    expect(html).toContain('padding: 6.93mm;');
    expect(html).toContain('height="27.72mm"');
  });

  it('and the smallest — 50×75 has no QR and a short barcode', () => {
    const html = sheet([label(0)], { width: 50, height: 75 });
    expect(html).toContain('--c: 0.7; --qr: 0mm;');
    expect(html).toContain('height="9.8mm"');
    expect(html).not.toContain('<figure class="qr">');
  });

  it('draws the type from the same numbers it measures with', () => {
    const html = sheet([label(0)]);
    expect(html).toContain('.name { font-size: calc(13pt * var(--s))');
    expect(html).toContain('.cod strong { font-size: calc(15pt * var(--s))');
    expect(html).toContain('gap: calc(1.4mm * var(--s))');
  });

  it('draws the QR graphic at the measured size, not a fixed one', () => {
    // `--qr` carries fitFor's number; the rules that size the QR must read
    // it, or A4 prints a 22 mm QR in a 43 mm slot and 100×100 one that overflows.
    const html = sheet([label(0)], { width: 210, height: 297 });
    expect(html).toContain('.qr svg { display: block; width: var(--qr); height: var(--qr); }');
    expect(html).toContain('.qr { flex-shrink: 0; width: var(--qr); }');
  });

  it('a label taller than the reference shows more item lines, up to twelve', () => {
    const items = Array.from({ length: 14 }, (_, i) => ({ name: `صنف ${i}`, qty: 1 }));
    expect(sheet([label(0, { items })], thermal)).toContain('و2 أصناف أخرى');
    expect(sheet([label(0, { items })], { width: 100, height: 200 })).toContain('و2 أصناف أخرى');
    expect(fitFor({ width: 100, height: 300 }).items).toBe(12);
  });
});

/**
 * THE WAYBILL IS READ OFF A THERMAL HEAD.
 *
 * «مبارح اجت بشكل جديد … مو واضحة ابدا». On 2/11 one number from the
 * millimetres — min(w/100, h/150), from 0.7 — began drawing the TYPE as
 * well as the codes. Every paper squarer than 100×150 went small: the
 * 100×100 sticker printed its body at 6 pt (was 7.65), its COD at 9.1
 * (was 11.7), with the middle of the label empty; A5 fell from 1.3 to 0.99.
 *
 * Now the codes keep 2/11's millimetres, and the type starts at a floor
 * that is never under the pre-2/11 label, drops lines before it shrinks,
 * and grows into the room the label's own text leaves.
 */
const typical = label(1, {
  name: 'أحمد سمير الخطيب',
  phones: ['0933123456'],
  place: 'دمشق — المزة، شارع الجلاء، بناء 12 الطابق الثالث',
  items: [{ name: 'كريم الشعر الطبيعي', qty: 2 }],
  cod: '15.00 USD',
});
const heavy = label(2, {
  phones: ['0933123456', '0944765432'],
  items: Array.from({ length: 6 }, (_, i) => ({ name: `صنف رقم ${i + 1}`, qty: 1, addOn: i === 2 })),
  note: 'اتصل قبل الوصول بساعة، البناء بدون مصعد',
});
const STORE = { name: 'متجر', logoUrl: null, supportPhone: '0999000000' };
/** 2/11's one number — kept for the codes only. */
const codesOf = (w: number, h: number) =>
  Math.round(Math.min(2.2, Math.max(0.7, Math.min(w / 100, h / 150))) * 100) / 100;

describe('the waybill is read off a thermal head', () => {
  // [paper, width, height, codes, heaviest label's type scale, a typical label's]
  const SIZES: [string, number, number, number, number, number][] = [
    ['100×150', 100, 150, 1, 1, 1.54],
    ['100×100', 100, 100, 0.7, 1, 1.28],
    ['A6', 105, 148, 0.99, 1, 1.62],
    ['A5 بالعرض', 210, 148, 0.99, 1.3, 2.1],
    ['A4', 210, 297, 1.98, 1.83, 2.2],
    ['100×70', 100, 70, 0.7, 1, 1],
    ['75×50', 75, 50, 0.7, 1, 1],
    ['4×6 in', 101.6, 152.4, 1.02, 1, 1.56],
    ['150×100', 150, 100, 0.7, 1, 1.38],
    ['100×200', 100, 200, 1, 1.3, 1.54],
  ];

  it('every preset in the picker is in the table', () => {
    for (const p of LABEL_SIZES) expect(SIZES.some(([, w, h]) => w === p.width && h === p.height)).toBe(true);
  });

  it.each(SIZES)('%s: the codes keep their millimetres, the type its scale', (_n, width, height, codes, worst, typ) => {
    const w = fitFor({ width, height });
    const t = fitFor({ width, height }, needOf(typical, STORE));
    expect(w.codes).toBe(codes);
    expect(w.fit).toBe(worst);
    expect(t.fit).toBe(typ);
  });

  it.each(SIZES)('%s: the barcode, the QR and the padding are 2/11’s, never smaller', (_n, width, height) => {
    const c = codesOf(width, height);
    for (const f of [fitFor({ width, height }), fitFor({ width, height }, needOf(typical, STORE))]) {
      expect(f.bar).toBeCloseTo(14 * c, 1);
      expect(f.pad).toBeCloseTo(3.5 * c, 1);
      if (f.qr > 0) expect(f.qr).toBeCloseTo(22 * c, 1);
    }
  });

  it.each(SIZES)('%s: no type under the pre-2/11 label on the same paper', (_n, width, height) => {
    const old = legacyScale({ width, height });
    for (const l of [typical, heavy]) {
      const f = fitFor({ width, height }, needOf(l, STORE));
      expect(f.pt.body).toBeGreaterThanOrEqual(8.5 * old);
      expect(f.pt.name).toBeGreaterThanOrEqual(12.5 * old);
      expect(f.pt.phones).toBeGreaterThanOrEqual(10.5 * old);
      expect(f.pt.codAmount).toBeGreaterThanOrEqual(13 * old);
    }
  });

  it('no paper 50 mm tall and 60 wide or more prints under the floor — body 9, name 13, phones 12, COD 14', () => {
    // Under 60 mm wide the picker already warns the barcode may not scan.
    for (let width = 60; width <= 300; width += 10) {
      for (let height = 50; height <= 300; height += 10) {
        for (const l of [typical, heavy]) {
          const f = fitFor({ width, height }, needOf(l, STORE));
          expect(f.pt.body, `${width}×${height}`).toBeGreaterThanOrEqual(FLOOR_PT.body);
          expect(f.pt.name).toBeGreaterThanOrEqual(FLOOR_PT.name);
          expect(f.pt.phones).toBeGreaterThanOrEqual(FLOOR_PT.phones);
          expect(f.pt.codAmount).toBeGreaterThanOrEqual(FLOOR_PT.codAmount);
          // …and what it prints fits the paper.
          expect(f.fullMm, `${width}×${height}`).toBeLessThanOrEqual(f.usableMm);
        }
      }
    }
  });

  it('under 50 mm tall it goes under the floor only as far as it fits, never under the pre-2/11 scale', () => {
    for (const size of [{ width: 50, height: 40 }, { width: 100, height: 45 }, { width: 40, height: 40 }]) {
      const f = fitFor(size, needOf(heavy, STORE));
      expect(f.fit).toBeGreaterThanOrEqual(legacyScale(size));
      expect(f.head).toBe(false);
    }
  });

  it('a short paper drops lines, not type — 100×70', () => {
    const f = fitFor({ width: 100, height: 70 }, needOf(heavy, STORE));
    expect(f.fit).toBe(1);
    expect(f.foot).toBe(false);
    expect(f.note).toBe(0);
    expect(f.items).toBeLessThanOrEqual(2);
    expect(f.place).toBeLessThan(3);
    // The QR stays: it is given up after the address lines and the item line.
    expect(f.qr).toBeGreaterThan(0);
    const html = sheet([heavy], { width: 100, height: 70 }, { store: STORE });
    expect(html).not.toContain('class="foot"');
    expect(html).not.toContain('class="note"');
    expect(html).toContain('<figure class="barcode">');
    expect(html).toContain('<figure class="qr">');
  });

  it('a roomy paper grows the type into the room — no big blank middle on 100×100', () => {
    const f = fitFor({ width: 100, height: 100 }, needOf(typical, STORE));
    expect(f.fit).toBeGreaterThan(1.2);
    expect(f.fullMm / f.usableMm).toBeGreaterThan(0.95);
    // 100×150 stops at what its width carries, still far fuller than the
    // two-thirds-empty label 2/11 printed.
    const tall = fitFor({ width: 100, height: 150 }, needOf(typical, STORE));
    expect(tall.fullMm / tall.usableMm).toBeGreaterThan(0.8);
    expect(sheet([typical], { width: 100, height: 100 }, { store: STORE })).toContain(`style="--s: ${f.fit}`);
  });

  it('each label is fitted to its own text — a long list does not shrink the short one beside it', () => {
    const html = sheet([typical, heavy], thermal, { store: STORE });
    const scales = [...html.matchAll(/class="label[^"]*" data-order="[^"]+" style="--s: ([\d.]+)/g)].map((m) => Number(m[1]));
    expect(scales).toHaveLength(2);
    expect(scales[0]).toBeGreaterThan(scales[1]);
    expect(scales[1]).toBeGreaterThanOrEqual(1);
  });

  it('a list longer than the paper prints what fits, at the floor, and says how many more', () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ name: `صنف ${i}`, qty: 1 }));
    const f = fitFor(thermal, needOf(label(0, { items }), STORE));
    expect(f.fit).toBeGreaterThanOrEqual(1);
    expect(f.items).toBe(12);
    expect(sheet([label(0, { items })])).toContain('و18 أصناف أخرى');
  });

  it('the reference under the QR fits the QR — it is not cut to «SY-1…»', () => {
    const f = fitFor({ width: 100, height: 100 }, needOf(typical, STORE));
    // 8 characters at 0.68 em + 0.08 mm each must sit inside the 15.4 mm QR.
    expect(8 * (0.68 * f.qrCaptionPt * (25.4 / 72) + 0.08)).toBeLessThanOrEqual(f.qr);
    expect(f.qrCaptionPt).toBeGreaterThanOrEqual(7 * legacyScale({ width: 100, height: 100 }));
    expect(sheet([typical], { width: 100, height: 100 }, { store: STORE })).toContain(`--qrcap: ${f.qrCaptionPt}pt`);
    expect(LABEL_CSS).toContain('.qr figcaption { font-size: var(--qrcap);');
    // A long reference never goes under 2/11's caption (7 pt × the codes);
    // the header carries it whole.
    const long = fitFor({ width: 100, height: 100 }, needOf(label(3, { ref: 'ORD-2026-0004' }), STORE));
    expect(long.qrCaptionPt).toBeGreaterThanOrEqual(7 * long.codes);
  });
});

describe('black ink only — what a thermal head can print', () => {
  it('the label’s stylesheet has no colour but black and white', () => {
    const colours = LABEL_CSS.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g) ?? [];
    expect(colours.length).toBeGreaterThan(0);
    for (const c of colours) expect(['#000', '#fff']).toContain(c.toLowerCase());
    expect(LABEL_CSS).not.toMatch(/opacity/);
    // The sheet carries it whole.
    expect(sheet([label(0)])).toContain(LABEL_CSS);
  });

  it('the rules are black and thick enough to print', () => {
    expect(LABEL_CSS).toContain('border-top: 0.3mm solid #000; padding-top');
    expect(LABEL_CSS).toContain('border-bottom: 0.5mm solid #000');
    expect(LABEL_CSS).not.toContain('#d0d5dd');
  });

  it('the COD reads without background graphics: a thick black frame, black bold type, no white on black', () => {
    const cod = /\n {2}\.cod \{[^}]*\}/.exec(LABEL_CSS)![0];
    expect(cod).toContain('border: 0.6mm solid #000');
    expect(cod).toContain('color: #000');
    expect(cod).toContain('font-weight: bold');
    expect(cod).not.toMatch(/background:\s*#000/);
    // Nothing anywhere on the label is drawn white on black.
    expect(LABEL_CSS).not.toMatch(/background:\s*#000/);
    expect(LABEL_CSS).not.toMatch(/color:\s*#fff/);
  });

  it('the name, the phones, the address and the COD are bold', () => {
    for (const sel of ['.name', '.phones', '.place', '.cod']) {
      const rule = new RegExp(`\\n {2}\\${sel} \\{[^}]*\\}`).exec(LABEL_CSS)![0];
      expect(rule, sel).toContain('font-weight: bold');
    }
  });

  it('the gap beside the QR follows the codes, so bigger type never thins the bars', () => {
    expect(LABEL_CSS).toContain('.codes { display: flex; align-items: flex-end; gap: calc(2.5mm * var(--c)); }');
  });
});

describe('golden', () => {
  /** The labels' own markup, the QR svg left out (the caller draws it). */
  const labels = (html: string) => html.slice(html.indexOf('<div class="page"'), html.indexOf('<script>')).trim();

  it('100×150', () => {
    expect(labels(sheet([typical, heavy], thermal, { store: STORE }))).toMatchInlineSnapshot(`
      "<div class="page" data-run="0"><section class="label" data-order="00000000-0000-4000-8000-000000000001" style="--s: 1.54; --qr: 22mm; --qrcap: 11.13pt">
        <header class="head">
          <div class="brand"><strong>متجر</strong></div>
          <div class="courier"><span>LogesTechs</span><b dir="ltr">SY-10001</b></div>
        </header>
        <div class="who">
          <p class="name">أحمد سمير الخطيب</p>
          <p class="phones" dir="ltr">0933123456</p>
          <p class="place" style="-webkit-line-clamp:3">دمشق — المزة، شارع الجلاء، بناء 12 الطابق الثالث</p>
        </div>
        <div class="body">
          <ul class="items"><li><span class="iname">كريم الشعر الطبيعي</span><b class="qty">×2</b></li></ul>
          
        </div>
        <div class="cod"><span>المبلغ عند الاستلام</span><strong dir="ltr">15.00 USD</strong></div>
        <div class="codes">
          <figure class="barcode"><svg viewBox="0 0 187 10" preserveAspectRatio="none" width="100%" height="14mm" shape-rendering="crispEdges" role="img" aria-label="JO7000000001"><path d="M10 0h2v10h-2zM13 0h1v10h-1zM16 0h1v10h-1zM21 0h1v10h-1zM23 0h2v10h-2zM26 0h3v10h-3zM32 0h1v10h-1zM36 0h3v10h-3zM40 0h2v10h-2zM43 0h3v10h-3zM47 0h2v10h-2zM50 0h3v10h-3zM54 0h1v10h-1zM57 0h3v10h-3zM61 0h2v10h-2zM65 0h1v10h-1zM68 0h3v10h-3zM72 0h2v10h-2zM76 0h1v10h-1zM79 0h3v10h-3zM83 0h2v10h-2zM87 0h1v10h-1zM90 0h3v10h-3zM94 0h2v10h-2zM98 0h1v10h-1zM101 0h3v10h-3zM105 0h2v10h-2zM109 0h1v10h-1zM112 0h3v10h-3zM116 0h2v10h-2zM120 0h1v10h-1zM123 0h3v10h-3zM127 0h2v10h-2zM131 0h1v10h-1zM134 0h3v10h-3zM138 0h2v10h-2zM142 0h1v10h-1zM145 0h3v10h-3zM150 0h2v10h-2zM153 0h2v10h-2zM156 0h2v10h-2zM161 0h2v10h-2zM164 0h2v10h-2zM169 0h3v10h-3zM173 0h1v10h-1zM175 0h2v10h-2z" fill="#000"/></svg><figcaption dir="ltr">JO7000000001</figcaption></figure>
          <figure class="qr"><svg class="q"></svg><figcaption dir="ltr">SY-10001</figcaption></figure>
        </div>
        <footer class="foot">للاستفسار: <span dir="ltr">0999000000</span></footer>
      </section></div>
      <div class="page" data-run="0"><section class="label" data-order="00000000-0000-4000-8000-000000000002" style="--s: 1.3; --qr: 22mm; --qrcap: 10.4pt">
        <header class="head">
          <div class="brand"><strong>متجر</strong></div>
          <div class="courier"><span>LogesTechs</span><b dir="ltr">SY-10002</b></div>
        </header>
        <div class="who">
          <p class="name">محمد الشمري</p>
          <p class="phones" dir="ltr">0933123456  ·  0944765432</p>
          <p class="place" style="-webkit-line-clamp:3">عمان — شارع المدينة</p>
        </div>
        <div class="body">
          <ul class="items"><li><span class="iname">صنف رقم 1</span><b class="qty">×1</b></li><li><span class="iname">صنف رقم 2</span><b class="qty">×1</b></li><li><span class="iname">صنف رقم 3</span><span class="tag">إضافة</span><b class="qty">×1</b></li><li><span class="iname">صنف رقم 4</span><b class="qty">×1</b></li><li><span class="iname">صنف رقم 5</span><b class="qty">×1</b></li><li><span class="iname">صنف رقم 6</span><b class="qty">×1</b></li></ul>
          <p class="note" style="-webkit-line-clamp:2"><b>ملاحظة:</b> اتصل قبل الوصول بساعة، البناء بدون مصعد</p>
        </div>
        <div class="cod"><span>المبلغ عند الاستلام</span><strong dir="ltr">32.500 JOD</strong></div>
        <div class="codes">
          <figure class="barcode"><svg viewBox="0 0 187 10" preserveAspectRatio="none" width="100%" height="14mm" shape-rendering="crispEdges" role="img" aria-label="JO7000000002"><path d="M10 0h2v10h-2zM13 0h1v10h-1zM16 0h1v10h-1zM21 0h1v10h-1zM23 0h2v10h-2zM26 0h3v10h-3zM32 0h1v10h-1zM36 0h3v10h-3zM40 0h2v10h-2zM43 0h3v10h-3zM47 0h2v10h-2zM50 0h3v10h-3zM54 0h1v10h-1zM57 0h3v10h-3zM61 0h2v10h-2zM65 0h1v10h-1zM68 0h3v10h-3zM72 0h2v10h-2zM76 0h1v10h-1zM79 0h3v10h-3zM83 0h2v10h-2zM87 0h1v10h-1zM90 0h3v10h-3zM94 0h2v10h-2zM98 0h1v10h-1zM101 0h3v10h-3zM105 0h2v10h-2zM109 0h1v10h-1zM112 0h3v10h-3zM116 0h2v10h-2zM120 0h1v10h-1zM123 0h3v10h-3zM127 0h2v10h-2zM131 0h1v10h-1zM134 0h3v10h-3zM138 0h2v10h-2zM142 0h2v10h-2zM146 0h3v10h-3zM151 0h1v10h-1zM153 0h1v10h-1zM155 0h2v10h-2zM160 0h3v10h-3zM164 0h2v10h-2zM169 0h3v10h-3zM173 0h1v10h-1zM175 0h2v10h-2z" fill="#000"/></svg><figcaption dir="ltr">JO7000000002</figcaption></figure>
          <figure class="qr"><svg class="q"></svg><figcaption dir="ltr">SY-10002</figcaption></figure>
        </div>
        <footer class="foot">للاستفسار: <span dir="ltr">0999000000</span></footer>
      </section></div>"
    `);
  });

  it('100×100 — the smallest preset', () => {
    expect(labels(sheet([typical, heavy], { width: 100, height: 100 }, { store: STORE }))).toMatchInlineSnapshot(`
      "<div class="page" data-run="0"><section class="label" data-order="00000000-0000-4000-8000-000000000001" style="--s: 1.28; --qr: 15.4mm; --qrcap: 7.69pt">
        <header class="head">
          <div class="brand"><strong>متجر</strong></div>
          <div class="courier"><span>LogesTechs</span><b dir="ltr">SY-10001</b></div>
        </header>
        <div class="who">
          <p class="name">أحمد سمير الخطيب</p>
          <p class="phones" dir="ltr">0933123456</p>
          <p class="place" style="-webkit-line-clamp:3">دمشق — المزة، شارع الجلاء، بناء 12 الطابق الثالث</p>
        </div>
        <div class="body">
          <ul class="items"><li><span class="iname">كريم الشعر الطبيعي</span><b class="qty">×2</b></li></ul>
          
        </div>
        <div class="cod"><span>المبلغ عند الاستلام</span><strong dir="ltr">15.00 USD</strong></div>
        <div class="codes">
          <figure class="barcode"><svg viewBox="0 0 187 10" preserveAspectRatio="none" width="100%" height="9.8mm" shape-rendering="crispEdges" role="img" aria-label="JO7000000001"><path d="M10 0h2v10h-2zM13 0h1v10h-1zM16 0h1v10h-1zM21 0h1v10h-1zM23 0h2v10h-2zM26 0h3v10h-3zM32 0h1v10h-1zM36 0h3v10h-3zM40 0h2v10h-2zM43 0h3v10h-3zM47 0h2v10h-2zM50 0h3v10h-3zM54 0h1v10h-1zM57 0h3v10h-3zM61 0h2v10h-2zM65 0h1v10h-1zM68 0h3v10h-3zM72 0h2v10h-2zM76 0h1v10h-1zM79 0h3v10h-3zM83 0h2v10h-2zM87 0h1v10h-1zM90 0h3v10h-3zM94 0h2v10h-2zM98 0h1v10h-1zM101 0h3v10h-3zM105 0h2v10h-2zM109 0h1v10h-1zM112 0h3v10h-3zM116 0h2v10h-2zM120 0h1v10h-1zM123 0h3v10h-3zM127 0h2v10h-2zM131 0h1v10h-1zM134 0h3v10h-3zM138 0h2v10h-2zM142 0h1v10h-1zM145 0h3v10h-3zM150 0h2v10h-2zM153 0h2v10h-2zM156 0h2v10h-2zM161 0h2v10h-2zM164 0h2v10h-2zM169 0h3v10h-3zM173 0h1v10h-1zM175 0h2v10h-2z" fill="#000"/></svg><figcaption dir="ltr">JO7000000001</figcaption></figure>
          <figure class="qr"><svg class="q"></svg><figcaption dir="ltr">SY-10001</figcaption></figure>
        </div>
        <footer class="foot">للاستفسار: <span dir="ltr">0999000000</span></footer>
      </section></div>
      <div class="page" data-run="0"><section class="label" data-order="00000000-0000-4000-8000-000000000002" style="--s: 1; --qr: 15.4mm; --qrcap: 7.69pt">
        <header class="head">
          <div class="brand"><strong>متجر</strong></div>
          <div class="courier"><span>LogesTechs</span><b dir="ltr">SY-10002</b></div>
        </header>
        <div class="who">
          <p class="name">محمد الشمري</p>
          <p class="phones" dir="ltr">0933123456  ·  0944765432</p>
          <p class="place" style="-webkit-line-clamp:3">عمان — شارع المدينة</p>
        </div>
        <div class="body">
          <ul class="items"><li><span class="iname">صنف رقم 1</span><b class="qty">×1</b></li><li><span class="iname">صنف رقم 2</span><b class="qty">×1</b></li><li><span class="iname">صنف رقم 3</span><span class="tag">إضافة</span><b class="qty">×1</b></li><li><span class="iname">صنف رقم 4</span><b class="qty">×1</b></li><li class="more">و2 أصناف أخرى</li></ul>
          <p class="note" style="-webkit-line-clamp:1"><b>ملاحظة:</b> اتصل قبل الوصول بساعة، البناء بدون مصعد</p>
        </div>
        <div class="cod"><span>المبلغ عند الاستلام</span><strong dir="ltr">32.500 JOD</strong></div>
        <div class="codes">
          <figure class="barcode"><svg viewBox="0 0 187 10" preserveAspectRatio="none" width="100%" height="9.8mm" shape-rendering="crispEdges" role="img" aria-label="JO7000000002"><path d="M10 0h2v10h-2zM13 0h1v10h-1zM16 0h1v10h-1zM21 0h1v10h-1zM23 0h2v10h-2zM26 0h3v10h-3zM32 0h1v10h-1zM36 0h3v10h-3zM40 0h2v10h-2zM43 0h3v10h-3zM47 0h2v10h-2zM50 0h3v10h-3zM54 0h1v10h-1zM57 0h3v10h-3zM61 0h2v10h-2zM65 0h1v10h-1zM68 0h3v10h-3zM72 0h2v10h-2zM76 0h1v10h-1zM79 0h3v10h-3zM83 0h2v10h-2zM87 0h1v10h-1zM90 0h3v10h-3zM94 0h2v10h-2zM98 0h1v10h-1zM101 0h3v10h-3zM105 0h2v10h-2zM109 0h1v10h-1zM112 0h3v10h-3zM116 0h2v10h-2zM120 0h1v10h-1zM123 0h3v10h-3zM127 0h2v10h-2zM131 0h1v10h-1zM134 0h3v10h-3zM138 0h2v10h-2zM142 0h2v10h-2zM146 0h3v10h-3zM151 0h1v10h-1zM153 0h1v10h-1zM155 0h2v10h-2zM160 0h3v10h-3zM164 0h2v10h-2zM169 0h3v10h-3zM173 0h1v10h-1zM175 0h2v10h-2z" fill="#000"/></svg><figcaption dir="ltr">JO7000000002</figcaption></figure>
          <figure class="qr"><svg class="q"></svg><figcaption dir="ltr">SY-10002</figcaption></figure>
        </div>
        
      </section></div>"
    `);
  });
});

describe('what the label says', () => {
  it('lists the add-ons and marks them, so the packer puts them in', () => {
    const html = sheet([label(0, { items: [{ name: 'منتج', qty: 1 }, { name: 'مقشر', qty: 1, addOn: true }] })]);
    expect(html).toContain('مقشر');
    expect(html).toContain('<span class="tag">إضافة</span>');
  });

  it('says how many more when the list is longer than the label', () => {
    const items = Array.from({ length: 15 }, (_, i) => ({ name: `صنف ${i}`, qty: 1 }));
    expect(sheet([label(0, { items })])).toContain('و3 أصناف أخرى');
  });

  it('prints the customer’s note, and only when there is one', () => {
    expect(sheet([label(0, { note: 'اتصل قبل الوصول' })])).toContain('اتصل قبل الوصول');
    expect(sheet([label(0)])).not.toContain('class="note"');
  });

  it('shows both phone numbers when there are two', () => {
    expect(sheet([label(0, { phones: ['0791234567', '0781111111'] })])).toContain('0781111111');
  });

  it('carries the store’s name, logo and contact number', () => {
    const html = sheet([label(0)], thermal, {
      store: { name: 'صحة بلس', logoUrl: '/api/public/store-logo/s/x.webp', supportPhone: '0999000000' },
    });
    expect(html).toContain('صحة بلس');
    expect(html).toContain('src="/api/public/store-logo/s/x.webp"');
    expect(html).toContain('0999000000');
  });

  it('escapes whatever a customer typed', () => {
    const html = sheet([label(0, { name: '<script>alert(1)</script>', place: '"><img src=x>', note: '<b>x</b>' })]);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('a store logo is drawn only from our own origin', () => {
  it('takes an uploaded logo', () => {
    expect(storeLogoForPrint('/api/public/store-logo/abc/x.webp')).toBe('/api/public/store-logo/abc/x.webp');
    expect(storeLogoForPrint('/api/media/companies/c/products/s/x.webp')).toBe('/api/media/companies/c/products/s/x.webp');
  });

  it('refuses one somebody typed that points elsewhere — the page carries addresses', () => {
    expect(storeLogoForPrint('https://tracker.example/logo.png')).toBeNull();
    expect(storeLogoForPrint('//evil.example/x.png')).toBeNull();
    expect(storeLogoForPrint('')).toBeNull();
    expect(storeLogoForPrint(null)).toBeNull();
  });
});

describe('printing commits; opening does not', () => {
  it('reports what is printed on beforeprint — which catches Ctrl+P too', () => {
    const html = sheet(many(3));
    expect(html).toContain("window.addEventListener('beforeprint'");
    expect(html).toContain('/api/ops/labels/printed');
  });

  it('never opens the print dialog by itself — opening the page commits nothing', () => {
    // The old sheet printed from onload, and the route stamped every order
    // when the page was merely requested.
    const html = sheet(many(3));
    expect(html).not.toContain("addEventListener('load'");
    expect(html).not.toContain('onload=');
  });

  it('reports nothing in PDF mode — saving a file is not printing a label', () => {
    const html = sheet(many(3), thermal, { mode: 'pdf' });
    expect(html).toContain('var PDF = true');
    expect(html).toContain('حفظ PDF');
  });

  it('tags every label with its order, so only the run actually printed is reported', () => {
    const html = sheet(many(3));
    expect(html.match(/data-order="/g)).toHaveLength(3);
  });

  it('names the orders that were left off, and why', () => {
    const html = sheet(many(1), thermal, { skipped: [{ orderNumber: 'SY-0012', reason: 'لم يُؤكَّد' }] });
    expect(html).toContain('SY-0012 (لم يُؤكَّد)');
  });
});

describe('a large batch is printed in runs', () => {
  it('offers every run, and together they cover every label exactly once', () => {
    const html = sheet(many(173));
    const runs = [...html.matchAll(/data-print-run="(\d+)">(\d+)–(\d+)</g)].map((m) => [Number(m[2]), Number(m[3])]);
    expect(runs).toEqual([[1, 50], [51, 100], [101, 150], [151, 173]]);
  });

  it('hides every page outside the chosen run when printing', () => {
    const html = sheet(many(120));
    for (const r of [0, 1, 2]) {
      expect(html).toContain(`body[data-run="${r}"] .page:not([data-run="${r}"]) { display: none; }`);
    }
  });

  it('has no runs in PDF mode — a PDF is one file of everything', () => {
    expect(sheet(many(173), thermal, { mode: 'pdf' })).not.toContain('class="run"');
  });

  it('keeps a small batch to one button', () => {
    expect(sheet(many(PRINT_CHUNK))).not.toContain('class="run"');
  });
});
