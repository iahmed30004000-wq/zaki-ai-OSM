import { describe, expect, it } from 'vitest';
import { barcodeSvg, renderLabelSheet, PRINT_CHUNK, type DesignShow, type LabelView, type SheetOptions, type SheetSize } from './label-sheet';
import { LABEL_SIZES } from './labels';
import { PRODUCT_SHAPES, SHAPE_INFO, unitWord } from './product-shapes';
import { WAYBILL_DESIGNS, cleanOfferName, designCss, designOrder, type ParcelLine, type WaybillDesign } from './waybill-designs';

/**
 * THE READY WAYBILL DESIGNS (27/11) — the owner's rules, held on the renderer's own page: the count is big and in the
 * product's word; nothing is hidden from the packer (what does not fit goes to a second label of the same order); the
 * courier's parts are always on the first label; black ink only; no request leaves the page; every string is escaped;
 * and the extra labels count and stamp nothing.
 */

const line = (name: string, qty: number, over: Partial<ParcelLine> = {}): ParcelLine => ({ name, qty, shape: 'bottle', ...over });
const one = (qty: number, over: Partial<ParcelLine> = {}) => [line('ماء-الكمأة', qty, { main: true, ...over })];
const ten = Array.from({ length: 10 }, (_, i) => line(`منتج-رقم-${i + 1}-`, 1, { shape: PRODUCT_SHAPES[i % 9], ...(i === 0 ? { main: true } : {}) }));

const view = (lines: ParcelLine[], over: Partial<LabelView> = {}, offer: string | null = null, n = 1): LabelView => ({
  orderId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  courier: 'شركة-التوصيل',
  ref: `SY-REF-${n}`,
  courierCode: `JO70000001${String(n).padStart(2, '0')}`,
  name: 'زبون-تجربة',
  phones: ['0911111111', '0922222222'],
  place: 'محافظة-تجربة — شارع-تجربة، بناء-تجربة',
  items: lines.map((l) => ({ name: l.name, qty: l.qty })),
  note: 'ملاحظة-تجربة',
  cod: '32.500 JOD',
  qrSvg: '<svg data-qr="1" viewBox="0 0 29 29"></svg>',
  parcel: { lines, offer },
  ...over,
});

const store = { name: 'متجر-تجربة', logoUrl: null, supportPhone: '0933333333' };
const opts = (design: WaybillDesign, over: Partial<SheetOptions> = {}): SheetOptions => ({
  store, mode: 'print', token: 't', stampUrl: '/api/ops/labels/printed', design, ...over,
});

const WIDE = { width: 150, height: 100 };
const TALL = { width: 100, height: 150 };
const SQUARE = { width: 100, height: 100 };
const ORIENTATIONS: [string, SheetSize][] = [['عرضي', WIDE], ['طولي', TALL], ['مربّع', SQUARE]];
const OFFERED: SheetSize[] = LABEL_SIZES.map((s) => ({ width: s.width, height: s.height }));
const SMALL: SheetSize[] = [{ width: 80, height: 60 }, { width: 75, height: 50 }, { width: 60, height: 40 }, { width: 40, height: 40 }, { width: 120, height: 40 }, { width: 40, height: 300 }];

const ALL: DesignShow = { storeName: true, courierName: true, ref: true, items: true, note: true, qr: true, supportPhone: true };

/** The labels of the page, in order, apart from the page around them. */
const sections = (html: string) => html.match(/<section [\s\S]*?<\/section>/g) ?? [];
const parts = (html: string) => {
  const all = sections(html);
  return { main: all.filter((s) => s.includes('data-order=')), more: all.filter((s) => s.includes('wb-more')), all: all.join('') };
};
const draw = (design: WaybillDesign, size: SheetSize, label: LabelView, over: Partial<SheetOptions> = {}) =>
  parts(renderLabelSheet([label], size, opts(design, over)));
const drawings = (html: string, shape: string) => (html.match(new RegExp(`wb-shape-${shape}"`, 'g')) ?? []).length;
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe.each(WAYBILL_DESIGNS)('design «%s»', (design) => {
  describe('one product', () => {
    it.each(ORIENTATIONS)('%s: one piece — the count, the word, one drawing, one label', (_n, size) => {
      const p = draw(design, size, view(one(1)));
      expect(p.main).toHaveLength(1);
      expect(p.more).toHaveLength(0);
      expect(text(p.all)).toMatch(/\b1 عبوة/);
      expect(drawings(p.all, 'bottle')).toBeGreaterThanOrEqual(1);
      expect(p.all).toContain('ماء-الكمأة');
    });

    it.each(ORIENTATIONS)('%s: ten pieces — «10 عبوات», and a drawing per piece or one with «×10»', (_n, size) => {
      const p = draw(design, size, view(one(10)));
      expect(text(p.all)).toMatch(/\b10 عبوات/);
      // Where design ب's short paper has no room under the line, the line itself is the number and the drawing.
      const inLine = /class="wb-qty"[^>]*>10<\/span><svg class="wb-shape wb-shape-bottle"/.test(p.all);
      expect(drawings(p.all, 'bottle') >= 10 || p.all.includes('×10') || (design === 'b' && inLine)).toBe(true);
    });

    it.each(PRODUCT_SHAPES)('shape «%s»: its own drawing and its own word — one, two, three', (shape) => {
      for (const qty of [1, 2, 3]) {
        const p = draw(design, TALL, view(one(qty, { shape })));
        expect(p.all, `${qty}`).toContain(SHAPE_INFO[shape].path);
        expect(text(p.all), `${qty}`).toContain(`${qty} ${unitWord(shape, qty)}`);
      }
    });

    it.each(ORIENTATIONS)('%s: too many pieces to draw — a number, never 144 drawings', (_n, size) => {
      const p = draw(design, size, view(one(144)));
      expect(text(p.all)).toContain('144 عبوة');
      expect(drawings(p.all, 'bottle')).toBeLessThan(6);
      if (design === 'a') expect(p.all).toContain('×144');
    });

    it('ten pieces on a tall label are drawn one by one', () => {
      const p = draw(design, TALL, view(one(10)));
      expect(p.all).not.toContain('×10');
      expect(drawings(p.all, 'bottle')).toBeGreaterThanOrEqual(10);
    });

    it('the variant prints under the product’s name', () => {
      const p = draw(design, TALL, view(one(3, { variant: 'قياس-42 · بني', shape: 'shoe' })));
      const at = p.all.indexOf('ماء-الكمأة');
      expect(p.all.indexOf('قياس-42 · بني')).toBeGreaterThan(at);
    });
  });

  describe('several products', () => {
    it.each([...ORIENTATIONS, ...OFFERED.map((s) => [`${s.width}×${s.height}`, s] as [string, SheetSize]), ...SMALL.map((s) => [`${s.width}×${s.height}`, s] as [string, SheetSize])])(
      '%s: all ten lines are on the paper, each with its count — never «أصناف أخرى»',
      (_n, size) => {
        const p = draw(design, size, view(ten));
        for (const l of ten) expect(p.all, l.name).toContain(l.name);
        expect((p.all.match(/class="wb-row"/g) ?? [])).toHaveLength(10);
        expect(p.all).not.toContain('أصناف أخرى');
        expect(p.all).not.toContain('صنف آخر');
        expect(text(p.all)).toContain('10 قطع');
        expect(p.main).toHaveLength(1);
      }
    );

    it('one product on an offered paper keeps to one label', () => {
      for (const size of [...OFFERED, WIDE]) expect(draw(design, size, view(one(3), {}, 'عرض')).more, `${size.width}×${size.height}`).toHaveLength(0);
    });

    it('a paper that cannot hold the list says where it is, with the total, and lists it all on the next label', () => {
      const p = draw(design, SQUARE, view(ten));
      expect(p.more.length).toBeGreaterThanOrEqual(1);
      expect(p.main[0]).toContain('بالورقة الثانية');
      expect(text(p.main[0])).toContain('10 قطع');
      expect(p.main[0]).not.toContain('class="wb-row"');
      expect(p.more[0]).toContain('ورقة 2 من 2');
      expect(p.more[0]).toContain('محتويات الطرد');
    });

    it('as many contents labels as it takes, numbered, with every line once', () => {
      const many = Array.from({ length: 40 }, (_, i) => line(`صنف-${i + 1}-طويل الاسم جداً للعناية بالبشرة والشعر`, 2));
      const p = draw(design, SQUARE, view(many));
      expect(p.more.length).toBeGreaterThan(1);
      p.more.forEach((s, i) => expect(s).toContain(`ورقة ${i + 2} من ${p.more.length + 1}`));
      for (let i = 1; i <= 40; i++) expect(p.more.join('').split(`صنف-${i}-`).length - 1, `${i}`).toBe(1);
    });

    it('an add-on stays marked', () => {
      const p = draw(design, TALL, view([line('أساسي', 1, { main: true }), line('الإضافي', 1, { addOn: true })]));
      expect(p.all).toMatch(/الإضافي <span class="wb-tag"[^>]*>إضافة<\/span>/);
      expect(p.all.match(/class="wb-tag"/g)).toHaveLength(1);
    });

    it('a mixed parcel is counted in «قطعة»; a parcel of one shape in its own word', () => {
      expect(text(draw(design, TALL, view([line('أ', 2), line('ب', 1, { shape: 'jar' })])).all)).toContain('3 قطع');
      expect(text(draw(design, TALL, view([line('أ', 2, { shape: 'jar' }), line('ب', 1, { shape: 'jar' })])).all)).toContain('3 مرطبانات');
    });
  });

  describe('the courier’s parts', () => {
    const everything = [...ORIENTATIONS.map(([, s]) => s), ...OFFERED, ...SMALL];
    const hidden: DesignShow = { storeName: false, courierName: false, ref: false, items: false, note: false, qr: false, supportPhone: false, offer: false };
    const long = view(ten, {
      name: 'عبد الرحمن محمد الشمري الحلبي البيطار',
      place: `ريف دمشق — ${'شارع طويل جداً مقابل الصيدلية '.repeat(8)}آخر-العنوان`,
      note: 'ملاحظة طويلة '.repeat(20) + 'آخر-الملاحظة',
    });

    it.each(everything)('$width×$height: name, both phones, the whole address, the amount and the barcode are on the first label', (size) => {
      for (const show of [undefined, hidden]) {
        for (const label of [view(one(3)), long]) {
          const main = draw(design, size, label, show ? { show } : {}).main[0];
          expect(main).toContain(label.name);
          expect(main).toContain('<span>0911111111</span>');
          expect(main).toContain('<span>0922222222</span>');
          expect(text(main)).toContain(label.place.split(' — ')[1]);
          expect(main).toContain('>32.500</strong>');
          expect(main).toContain('>JOD</em>');
          // The very bars the current waybill draws, quiet zones inside the symbol, with the number under them.
          const bars = /<path d="([^"]+)"/.exec(barcodeSvg(label.courierCode, 14))![1];
          expect(main).toContain(`<path d="${bars}" fill="#000"/>`);
          expect(main).toContain(`aria-label="${label.courierCode}"`);
          expect(main).toContain(`>${label.courierCode}</figcaption>`);
        }
      }
    });

    it('nothing of theirs is clamped or cut with an ellipsis', () => {
      const css = designCss(SQUARE);
      expect(css).not.toContain('line-clamp');
      // The one ellipsis is the store's name.
      expect(css.match(/text-overflow/g)).toHaveLength(1);
      expect(css).toMatch(/\.wb-brand \{[^}]*text-overflow: ellipsis/);
    });

    it('a note that leaves the first label is printed whole on the next, and the first says so', () => {
      for (const size of [...everything]) {
        const p = draw(design, size, long);
        expect(p.all, `${size.width}×${size.height}`).toContain('آخر-الملاحظة');
        if (!p.main[0].includes('آخر-الملاحظة')) expect(p.main[0]).toContain('ملاحظة الزبون بالورقة الثانية');
      }
    });

    it('every contents label carries the number under the first label’s barcode', () => {
      for (const show of [undefined, { ...ALL, ref: false }]) {
        for (const s of draw(design, SQUARE, view(ten), show ? { show } : {}).more) expect(s).toContain('JO7000000101');
      }
    });
  });

  describe('the offer ticket', () => {
    const OFFER = 'قطعتين + قطعة هدية';

    it('stands once, beside the main product, with the gift mark', () => {
      const p = draw(design, WIDE, view([line('الأساسي', 3, { main: true }), line('الثاني', 1)], {}, OFFER));
      expect(p.all.match(/class="wb-ticket"/g)).toHaveLength(1);
      expect(p.all).toContain(`<span>${OFFER}</span></div>`);
      expect(p.all).toContain('class="wb-gift"');
      const rows = p.all.split('class="wb-row"').slice(1);
      expect(rows[0]).toContain('wb-ticket');
      expect(rows[1]).not.toContain('wb-ticket');
    });

    it('no offer, no main line, or the switch off — no ticket', () => {
      expect(draw(design, WIDE, view(one(3))).all).not.toContain('wb-ticket');
      expect(draw(design, WIDE, view([line('بلا-أساسي', 3)], {}, OFFER)).all).not.toContain('wb-ticket');
      expect(draw(design, WIDE, view(one(3), {}, OFFER), { show: { ...ALL, offer: false } }).all).not.toContain('wb-ticket');
      expect(draw(design, WIDE, view(one(3), {}, OFFER), { show: ALL }).all).toContain('wb-ticket');
    });

    it('goes with the list to the second label', () => {
      const p = draw(design, SQUARE, view(ten, {}, OFFER));
      expect(p.more.join('')).toContain(OFFER);
    });
  });

  describe('the switches', () => {
    const label = view(one(3), {}, 'عرض-تجربة');
    const MARKS = { storeName: 'متجر-تجربة', courierName: 'شركة-التوصيل', ref: 'SY-REF-1', note: 'ملاحظة-تجربة', qr: 'data-qr="1"', supportPhone: '0933333333', offer: 'عرض-تجربة' };

    it.each(Object.keys(MARKS) as (keyof typeof MARKS)[])('«%s» off: its part is gone, the others stay', (key) => {
      // Design أ's switch is «the number at the top»: off, the QR's caption carries it, as on the current waybill.
      const gone = key === 'ref' && design === 'a' ? '<b class="wb-ref"' : MARKS[key];
      const on = draw(design, TALL, label, { show: ALL }).all;
      expect(on).toContain(gone);
      const off = draw(design, TALL, label, { show: { ...ALL, [key]: false } }).all;
      expect(off).not.toContain(gone);
      for (const [other, stays] of Object.entries(MARKS)) if (other !== key) expect(off, other).toContain(stays);
      if (key === 'ref' && design === 'a') expect(off).toMatch(/<figcaption dir="ltr"[^>]*>SY-REF-1<\/figcaption>/);
    });

    it('the items off: no name, no count, no drawing, no ticket and no second label — even for ten lines', () => {
      const p = draw(design, SQUARE, view(ten, {}, 'عرض-تجربة'), { show: { ...ALL, items: false } });
      expect(p.all).not.toContain('منتج-رقم');
      expect(p.all).not.toContain('wb-items');
      expect(p.all).not.toContain('wb-shape');
      expect(p.all).not.toContain('wb-ticket');
      expect(text(p.all)).not.toContain('قطع');
      expect(p.more).toHaveLength(0);
    });

    it('the logo is drawn when there is one', () => {
      const logoUrl = '/api/media/companies/c1/products/s1/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.webp';
      expect(draw(design, TALL, label, { store: { ...store, logoUrl } }).all).toContain(`src="${logoUrl}"`);
      expect(draw(design, TALL, label).all).not.toContain('<img');
    });
  });

  describe('safety of the page', () => {
    const evil = '<script>alert(1)</script>"&\'';
    const bad = view(
      [line(`اسم${evil}`, 2, { main: true, variant: `نوع${evil}` }), line(`ثاني${evil}`, 1)],
      { name: `ز${evil}`, phones: [`09${evil}`], place: `م${evil} — ش${evil}`, note: `ن${evil}`, cod: `1${evil} ${evil}`, courier: `ك${evil}`, ref: `r${evil}`, orderId: `o${evil}` },
      `ع${evil}`
    );

    it.each([...ORIENTATIONS.map(([, s]) => s), { width: 60, height: 40 }])('$width×$height: every customer and product string is escaped', (size) => {
      const p = draw(design, size, bad, { store: { name: `م${evil}`, logoUrl: null, supportPhone: `0${evil}` } });
      expect(p.all).not.toContain('<script');
      expect(p.all).toContain('&lt;script&gt;alert(1)&lt;/script&gt;&quot;&amp;&#39;');
    });

    it('the page asks nobody else for anything: the one font is our own file', () => {
      const html = renderLabelSheet([view(ten)], SQUARE, opts(design));
      expect([...html.matchAll(/url\(([^)]*)\)/g)].map((m) => m[1])).toEqual(['"/fonts/reem-kufi-var.woff2"']);
      expect(html).not.toMatch(/(src|href)="https?:/);
      expect(html).not.toContain('@import');
    });

    it('black ink only: no other colour, no transparency, no white letters', () => {
      for (const size of [WIDE, TALL, SQUARE]) {
        const css = designCss(size);
        expect(new Set(css.match(/#[0-9a-fA-F]{3,8}\b/g))).toEqual(new Set(['#000', '#fff']));
        expect(css).not.toMatch(/(^|[^-])color:\s*#fff/m);
        expect(css).not.toMatch(/background(-color)?:\s*#000/);
        expect(css).not.toMatch(/opacity|rgba?\(|hsl|gradient|gray|grey/);
        const drawn = draw(design, size, view(ten, {}, 'عرض')).all;
        for (const m of drawn.matchAll(/(?:fill|stroke)="([^"]*)"/g)) expect(['#000', 'none']).toContain(m[1]);
      }
    });
  });

  describe('a second label is paper, not an order', () => {
    it('carries no order id, so printing reports each order once', () => {
      const labels = [view(ten, {}, null, 1), view(one(2), {}, null, 2), view(ten, {}, null, 3)];
      const html = renderLabelSheet(labels, SQUARE, opts(design));
      expect([...html.matchAll(/data-order="([^"]+)"/g)].map((m) => m[1])).toEqual(labels.map((l) => l.orderId));
      expect(parts(html).more.length).toBeGreaterThanOrEqual(2);
      for (const s of parts(html).more) expect(s).not.toContain('data-order');
      // The toolbar counts orders, and says how many extra sheets there are.
      expect(html).toContain('<strong>3 بوليصة</strong>');
      expect(html).toContain(`منها أوراق محتويات إضافية: ${parts(html).more.length}`);
      expect(html).toContain('<title>بوالص الشحن — 3</title>');
    });

    it('follows its own first label, in the same print run', () => {
      const labels = Array.from({ length: 70 }, (_, i) => view(i % 3 === 0 ? ten : one(1), {}, null, i + 1));
      for (const size of [SQUARE, { width: 105, height: 148, sheetWidth: 210, sheetHeight: 297 }, { width: 60, height: 40 }]) {
        const html = renderLabelSheet(labels, size, opts(design));
        const pages = html.slice(0, html.indexOf('<script>')).split('<div class="page" data-run="').slice(1);
        const ids: string[] = [];
        let owner = '';
        const runOf = new Map<string, number>();
        for (const page of pages) {
          const run = Number(page.slice(0, page.indexOf('"')));
          for (const s of sections(page)) {
            const id = /data-order="([^"]+)"/.exec(s)?.[1];
            if (id) {
              owner = id;
              ids.push(id);
              runOf.set(id, run);
            } else {
              // A contents label sits in the run of the order printed just before it.
              expect(runOf.get(owner)).toBe(run);
              expect(s).toContain(labels.find((l) => l.orderId === owner)!.courierCode);
            }
          }
        }
        expect(ids).toEqual(labels.map((l) => l.orderId));
        // The run buttons name orders, and cover each one once.
        const ranges = [...html.matchAll(/class="run" data-print-run="\d+">(\d+)–(\d+)</g)].map((m) => [Number(m[1]), Number(m[2])]);
        expect(ranges[0][0]).toBe(1);
        expect(ranges.at(-1)![1]).toBe(70);
        ranges.slice(1).forEach(([from], i) => expect(from).toBe(ranges[i][1] + 1));
        // No run is longer than a printer is given, unless one order alone is.
        const perRun = new Map<number, number>();
        for (const page of pages) {
          const run = Number(page.slice(0, page.indexOf('"')));
          perRun.set(run, (perRun.get(run) ?? 0) + sections(page).length);
        }
        for (const n of perRun.values()) expect(n).toBeLessThanOrEqual(PRINT_CHUNK);
      }
    });
  });
});

describe('a label with no parcel — a design still lists its items', () => {
  it('takes the names and counts of the items, in «قطعة»', () => {
    const l = view(one(1));
    delete l.parcel;
    const p = draw('a', TALL, { ...l, items: [{ name: 'من-القائمة', qty: 2 }] });
    expect(p.all).toContain('من-القائمة');
    expect(text(p.all)).toContain('2 قطعتين');
  });
});

describe('the offer’s name on paper', () => {
  it('loses its emoji and keeps its words and digits', () => {
    expect(cleanOfferName('🎁 عرض 2+1 🔥🔥 هدية 👨‍👩‍👧 ❤️')).toBe('عرض 2+1 هدية');
    expect(cleanOfferName('3 قطع 🇸🇾 + 1 مجاناً 👍🏽 #1 *')).toBe('3 قطع + 1 مجاناً #1 *');
  });
  it('nothing left is no ticket', () => {
    for (const v of ['🎁🎁', '   ', '', null, undefined]) expect(cleanOfferName(v)).toBeNull();
  });
});

describe('the order it was made for', () => {
  it('designOrder answers one first label and its contents labels', () => {
    const d = designOrder('a', view(ten), SQUARE, store);
    expect(d.main).toContain('data-order=');
    expect(d.more.length).toBeGreaterThanOrEqual(1);
  });
});
