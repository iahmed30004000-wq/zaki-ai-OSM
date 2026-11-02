import { describe, it, expect } from 'vitest';
import {
  barcodeSvg, fitFor, labelsPerPage, renderLabelSheet, storeLogoForPrint, tierFor,
  PRINT_CHUNK, QUIET_MODULES, type LabelView, type SheetOptions,
} from './label-sheet';
import { code128Bars } from './labels';

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
    const html = sheet([label(0)], { width: 60, height: 40 });
    expect(html).toContain('<figure class="barcode">');
    expect(html).toContain('32.500 JOD');
    expect(html).not.toContain('<figure class="qr">');
    expect(html).toContain('<p class="count">2 قطع</p>');
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
 * «بدي البوليصة تتكيف تلقائيا ع الحجم الي بحطو». Four fixed steps printed
 * A4 like A5 — small type in a big blank — and a 100 mm wide label 200
 * tall in the A4 step. Now one number, from the millimetres, draws the
 * type, the QR, the barcode and the padding.
 */
describe('the waybill follows its paper', () => {
  // [name, width, height, expected fit, tier]
  const SIZES: [string, number, number, number | null, string][] = [
    ['50×75', 50, 75, 0.7, 'tiny'],
    ['75×100', 75, 100, 0.7, 'compact'],
    ['100×100', 100, 100, 0.7, 'compact'],
    ['100×150', 100, 150, 1, 'standard'],
    ['150×100', 150, 100, 0.7, 'compact'],
    ['100×200', 100, 200, 1, 'standard'],
    ['A6', 105, 148, 0.99, 'standard'],
    ['A5 بالعرض', 210, 148, 0.99, 'large'],
    ['A4', 210, 297, 1.98, 'large'],
  ];

  it.each(SIZES)('%s: fit, QR, barcode and padding come from the millimetres', (_n, width, height, fit, tier) => {
    const f = fitFor({ width, height });
    expect(f.tier).toBe(tier);
    expect(f.fit).toBe(fit);
    expect(f.qr).toBeCloseTo(tier === 'tiny' ? 0 : 22 * fit!, 1);
    expect(f.bar).toBeCloseTo(14 * fit!, 1);
    expect(f.pad).toBeCloseTo(3.5 * fit!, 1);
  });

  it.each(SIZES)('%s: every row that never gives way fits the height inside the padding', (_n, width, height) => {
    const f = fitFor({ width, height });
    expect(f.reservedMm).toBeGreaterThan(0);
    expect(f.reservedMm).toBeLessThanOrEqual(f.usableMm);
    // And with every line it may print — place, items, the note — too.
    expect(f.fullMm).toBeLessThanOrEqual(f.usableMm);
  });

  it('measures what the stylesheet draws — 100×150 reserves about 65 mm of its 142', () => {
    const f = fitFor(thermal);
    expect(f.usableMm).toBeCloseTo(150 - 7 - 2 * (25.4 / 96), 2);
    expect(f.reservedMm).toBeCloseTo(65.5, 0);
    expect(f.fullMm).toBeCloseTo(107.2, 0);
  });

  it('grows with the paper and shrinks with it — A4 is drawn twice the size of 100×150', () => {
    const a4 = fitFor({ width: 210, height: 297 });
    const a6 = fitFor({ width: 105, height: 148 });
    const square = fitFor({ width: 100, height: 100 });
    expect(a4.fit).toBeGreaterThan(a6.fit);
    expect(a6.fit).toBeGreaterThan(square.fit);
    expect(a4.qr).toBeGreaterThan(a6.qr);
    expect(a6.qr).toBeGreaterThan(square.qr);
    expect(a4.bar).toBeGreaterThan(a6.bar);
    expect(a6.bar).toBeGreaterThan(square.bar);
    expect(a4.fit / fitFor(thermal).fit).toBeCloseTo(1.98, 2);
  });

  it('is held between 0.7 and 2.2 — the smallest label stays readable, the largest bounded', () => {
    expect(fitFor({ width: 40, height: 40 }).fit).toBe(0.7);
    expect(fitFor({ width: 300, height: 300 }).fit).toBe(2);
    expect(fitFor({ width: 500, height: 500 }).fit).toBe(2.2);
  });

  it('writes the numbers into the sheet — A4', () => {
    const html = sheet([label(0)], { width: 210, height: 297 });
    expect(html).toContain('--s: 1.98; --qr: 43.56mm;');
    expect(html).toContain('padding: 6.93mm;');
    expect(html).toContain('height="27.72mm"');
  });

  it('and the smallest — 50×75 has no QR and a short barcode', () => {
    const html = sheet([label(0)], { width: 50, height: 75 });
    expect(html).toContain('--s: 0.7; --qr: 0mm;');
    expect(html).toContain('height="9.8mm"');
    expect(html).not.toContain('<figure class="qr">');
  });

  it('draws the type from the same numbers it measures with', () => {
    const html = sheet([label(0)]);
    expect(html).toContain('.name { font-size: calc(12.5pt * var(--s))');
    expect(html).toContain('.cod strong { font-size: calc(13pt * var(--s))');
    expect(html).toContain('gap: calc(1.4mm * var(--s))');
  });

  it('a label taller than the reference gets the extra height as item lines, up to twelve', () => {
    const items = Array.from({ length: 14 }, (_, i) => ({ name: `صنف ${i}`, qty: 1 }));
    expect(sheet([label(0, { items })], thermal)).toContain('و10 أصناف أخرى');
    expect(sheet([label(0, { items })], { width: 100, height: 200 })).toContain('و2 أصناف أخرى');
    expect(fitFor({ width: 100, height: 300 }).items).toBe(12);
    // The same paper lying on its side is not taller: no extra lines.
    expect(fitFor({ width: 150, height: 100 }).items).toBe(2);
  });
});

describe('what the label says', () => {
  it('lists the add-ons and marks them, so the packer puts them in', () => {
    const html = sheet([label(0, { items: [{ name: 'منتج', qty: 1 }, { name: 'مقشر', qty: 1, addOn: true }] })]);
    expect(html).toContain('مقشر');
    expect(html).toContain('<span class="tag">إضافة</span>');
  });

  it('says how many more when the list is longer than the label', () => {
    const items = Array.from({ length: 7 }, (_, i) => ({ name: `صنف ${i}`, qty: 1 }));
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
