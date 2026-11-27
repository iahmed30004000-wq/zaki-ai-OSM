import { describe, expect, it } from 'vitest';
import { FLOOR_PT, fitFor, legacyScale, needOf, renderLabelSheet, tierFor, type DesignShow, type LabelView, type SheetSize } from './label-sheet';
import { LABEL_SIZES, isTinyPaper } from './labels';
import { PRODUCT_SHAPES } from './product-shapes';
import { WAYBILL_DESIGNS, designCss, type ParcelLine, type WaybillDesign } from './waybill-designs';

/**
 * THE COURIER'S PARTS ARE NEVER SMALLER THAN TODAY'S (the review of PR 489). Measured, not looked for: the height of the
 * bars and the point size of the name, the phones, the address and the amount are read off the page of both designs,
 * on every paper they are drawn on, and held against what the current waybill gives the same order there.
 *
 *   bars      never shorter than `fitFor(size, …).bar`, the current waybill's;
 *   type      never under the current waybill's floor for that paper: `FLOOR_PT` × max(1, `legacyScale`).
 */

const PT_MM = 25.4 / 72;
/** Sizes are written in millimetres to two decimals: a point size read back is within this of the one meant. */
const ROUNDING_PT = 0.02;

const WIDTHS = [70, 75, 80, 100, 105, 120, 150, 200, 210, 300];
const HEIGHTS = [70, 75, 100, 148, 150, 200, 297, 300];
const PAPERS: SheetSize[] = [
  ...LABEL_SIZES.map((s) => ({ width: s.width, height: s.height })),
  ...WIDTHS.flatMap((width) => HEIGHTS.map((height) => ({ width, height }))),
];

const line = (name: string, qty: number, over: Partial<ParcelLine> = {}): ParcelLine => ({ name, qty, shape: 'bottle', ...over });
const view = (lines: ParcelLine[], over: Partial<LabelView> = {}, offer: string | null = null): LabelView => ({
  orderId: '00000000-0000-4000-8000-000000000001',
  courier: 'شركة التوصيل السريع',
  ref: 'ORD-2026-0000',
  courierCode: '7446100000000',
  name: 'أم محمد',
  phones: ['0900000000'],
  place: 'دمشق — المزة، شارع تجريبي، بناء 1',
  items: lines.map((l) => ({ name: l.name, qty: l.qty })),
  note: 'الاتصال قبل الوصول',
  cod: '25.00 USD',
  qrSvg: '<svg viewBox="0 0 29 29"></svg>',
  parcel: { lines, offer },
  ...over,
});

const HEAVY_ADDRESS = 'ريف دمشق — صحنايا، الشارع العام، مقابل الصيدلية، خلف الجامع الكبير، بناء رقم 12، الطابق الرابع، الباب الأيسر، فوق المخبز';

const ORDERS: [string, LabelView][] = [
  ['خفيف', view([line('ماء الكمأة', 3, { main: true })], {}, 'قطعتين + قطعة هدية')],
  [
    'ثقيل',
    view(
      Array.from({ length: 24 }, (_, i) => line(`منتج تجريبي رقم ${i + 1} باسم طويل للعناية بالبشرة`, 1 + (i % 3), { shape: PRODUCT_SHAPES[i % 9], main: i === 0 })),
      {
        name: 'نور الهدى عبد الكريم الحلبي البيطار',
        phones: ['0900 000 000', '+963900000001'],
        place: HEAVY_ADDRESS,
        note: 'الاتصال قبل الوصول بساعة، والتسليم بعد الظهر فقط لو سمحتم',
        cod: '1,250,000.00 SYP',
      },
      'اشتر 3 واحصل على 2 هدية مجاناً'
    ),
  ],
  ['عشر منتجات', view(Array.from({ length: 10 }, (_, i) => line(`منتج ${i + 1}`, 1, { main: i === 0 })), {}, null)],
];

const store = { name: 'متجر العناية الطبيعية', logoUrl: null, supportPhone: '0911111111' };
const mainOf = (design: WaybillDesign, size: SheetSize, label: LabelView, show?: DesignShow) =>
  renderLabelSheet([label], size, { store, mode: 'print', token: 't', stampUrl: '/x', design, ...(show ? { show } : {}) }).match(
    /<section [^>]*data-order=[\s\S]*?<\/section>/
  )![0];

const mm = (html: string, re: RegExp) => {
  const m = re.exec(html);
  expect(m, String(re)).not.toBeNull();
  return Number(m![1]);
};
/** What the first label actually prints: the bars in millimetres, the courier's type in points. */
function measured(main: string) {
  const place = /class="wb-place" style="font-size:([\d.]+)mm"><b>[^<]*<\/b>(?:<span style="font-size:([\d.]+)mm">)?/.exec(main)!;
  return {
    bar: mm(main, /<figure class="wb-bc"><svg [^>]*height="([\d.]+)mm"/),
    name: mm(main, /class="wb-name" dir="auto" style="font-size:([\d.]+)mm"/) / PT_MM,
    phones: mm(main, /class="wb-phones" dir="ltr" style="font-size:([\d.]+)mm"/) / PT_MM,
    address: Math.min(Number(place[1]), Number(place[2] ?? place[1])) / PT_MM,
    amount: mm(main, /<div class="wb-cod [^>]*>(?:(?!<\/div>)[\s\S])*?<strong[^>]*style="font-size:([\d.]+)mm"/) / PT_MM,
  };
}

describe.each(WAYBILL_DESIGNS)('design «%s» against the current waybill, on every paper it is drawn on', (design) => {
  it('is measured on every paper that is not tiny', () => {
    for (const p of PAPERS) expect(tierFor(p), `${p.width}×${p.height}`).not.toBe('tiny');
    expect(PAPERS.length).toBeGreaterThan(80);
  });

  it.each(ORDERS)('«%s»: the bars are never shorter than today’s, and the courier’s type never under today’s floor', (_n, label) => {
    const short: string[] = [];
    for (const size of PAPERS) {
      const got = measured(mainOf(design, size, label));
      const k = Math.max(1, legacyScale(size));
      const today = fitFor(size, needOf(label, store)).bar;
      const at = `${size.width}×${size.height}`;
      if (got.bar < today) short.push(`${at} bars ${got.bar} < ${today}`);
      for (const [part, floor] of [['name', FLOOR_PT.name], ['phones', FLOOR_PT.phones], ['address', FLOOR_PT.body], ['amount', FLOOR_PT.codAmount]] as const) {
        if (got[part] < floor * k - ROUNDING_PT) short.push(`${at} ${part} ${got[part].toFixed(2)}pt < ${(floor * k).toFixed(2)}pt`);
      }
    }
    expect(short).toEqual([]);
  });

  it.each(ORDERS)('«%s»: nothing else on a first label is shrunk to make room — every size is 6.9 pt or more', (_n, label) => {
    const small: string[] = [];
    for (const size of PAPERS) {
      // The caption under the QR follows the QR's width, as the current waybill's does; it is read apart.
      const main = mainOf(design, size, label).replace(/<figure class="wb-qr"[\s\S]*?<\/figure>/g, '');
      const least = Math.min(...[...main.matchAll(/font-size:([\d.]+)mm/g)].map((m) => Number(m[1]) / PT_MM));
      if (least < 6.9) small.push(`${size.width}×${size.height}: ${least.toFixed(2)}pt`);
    }
    expect(small).toEqual([]);
  });

  it('the review’s paper, 100×70, with the heavy order', () => {
    const size = { width: 100, height: 70 };
    const got = measured(mainOf(design, size, ORDERS[1][1]));
    expect(got.bar).toBeGreaterThanOrEqual(9.8);
    expect(got.name).toBeGreaterThanOrEqual(13 - ROUNDING_PT);
    expect(got.phones).toBeGreaterThanOrEqual(12 - ROUNDING_PT);
    expect(got.address).toBeGreaterThanOrEqual(9 - ROUNDING_PT);
  });

  it('the same with every optional part switched off', () => {
    const show: DesignShow = { storeName: false, courierName: false, ref: false, items: false, note: false, qr: false, supportPhone: false, offer: false };
    for (const size of PAPERS) {
      const got = measured(mainOf(design, size, ORDERS[1][1], show));
      const k = Math.max(1, legacyScale(size));
      expect(got.bar, `${size.width}×${size.height}`).toBeGreaterThanOrEqual(fitFor(size, needOf(ORDERS[1][1], store)).bar);
      expect(got.name, `${size.width}×${size.height}`).toBeGreaterThanOrEqual(13 * k - ROUNDING_PT);
      expect(got.address, `${size.width}×${size.height}`).toBeGreaterThanOrEqual(9 * k - ROUNDING_PT);
    }
  });

  it('an address no layout can hold is printed whole, smaller than the floor — never cut — and the bars stay', () => {
    const size = { width: 70, height: 70 };
    const place = `دمشق — ${'شارع طويل جداً مقابل الصيدلية '.repeat(20)}آخر-العنوان`;
    const main = mainOf(design, size, view([line('منتج', 1, { main: true })], { place }));
    expect(main).toContain('آخر-العنوان');
    const got = measured(main);
    expect(got.address).toBeLessThan(9);
    expect(got.bar).toBeGreaterThanOrEqual(9.8);
  });

  it('two numbers typed into one phone box wrap at the floor size rather than shrink or run off', () => {
    const phones = ['0900000000 / 0911111111 / 0922222222'];
    const main = mainOf(design, { width: 70, height: 100 }, view([line('منتج', 1, { main: true })], { phones }));
    expect(main).toContain(`<span class="wb-long">${phones[0]}</span>`);
    expect(measured(main).phones).toBeGreaterThanOrEqual(12 - ROUNDING_PT);
  });

  it('the dashed edge of a label is the screen’s alone: a print rule of the design wins over the rule that draws it', () => {
    const css = designCss({ width: 100, height: 150 });
    const draws = css.indexOf('border: 1px dashed #000');
    const clears = css.search(/@media print \{ \.label\.wb \{ border-color: transparent; \} \}/);
    expect(draws).toBeGreaterThan(-1);
    // Same specificity (`.label.wb`), later in the sheet: it wins on paper.
    expect(clears).toBeGreaterThan(draws);
    expect(css.slice(0, draws)).toContain('.label.wb {');
  });
});

describe('the tiny paper rule', () => {
  it('the settings card’s rule is the renderer’s «tiny», size for size', () => {
    for (let w = 40; w <= 130; w += 1) {
      for (let h = 40; h <= 130; h += 1) expect(isTinyPaper(w, h), `${w}×${h}`).toBe(tierFor({ width: w, height: h }) === 'tiny');
    }
  });
});
