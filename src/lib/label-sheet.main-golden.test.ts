import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderLabelSheet, type LabelView, type SheetOptions, type SheetShow, type SheetSize } from './label-sheet';
import { LABEL_SIZES } from './labels';
import { resolveWaybillPrint, type WaybillPrintDocument } from './waybill-print-settings';

/**
 * «NOTHING CHOSEN = TODAY, BYTE FOR BYTE» — THE WAYBILL (25/11, F15).
 *
 * `label-sheet.main-golden.json` holds the sha256 (base64url) of the page `renderLabelSheet` printed on osm/main
 * (8780e8db, before F15) for 400 seeded scenarios: every paper on offer and random custom ones, one label to a
 * chunked run of 55, Arabic and Latin names, long addresses, notes, twelve-plus items, add-ons, with and without a
 * logo or a support phone, print and PDF, skipped and outside-the-rule lists. The renderer of THIS tree must print
 * the same bytes for every one of them when the store chose nothing — handed no `show`, handed every part shown,
 * and handed what the print door resolves for a store with no entry or an entry that hides nothing.
 *
 * Regenerate only from main's own file: copy `git show osm/main:src/lib/label-sheet.ts` to
 * `src/lib/f15-label-sheet-main.tmp.ts` and run this file with F15_WRITE_GOLDEN=1 (the copy is never committed).
 */

const GOLDEN = join(__dirname, 'label-sheet.main-golden.json');
const SEED = 20261125;
const COUNT = 400;

function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = ['محمد', 'عبد الرحمن محمد الشمري', 'Ahmad Al-Khatib', 'سارة', 'نور الهدى عبد الكريم الحلبي البيطار', 'Jean-Pierre Dubois-Martin'];
const WORDS = ['دمشق', 'حلب', 'شارع', 'بناء', 'طابق', 'قرب', 'الجامع', 'مقابل', 'Street', 'Tower', '12', 'ب'];

type Scenario = { labels: LabelView[]; size: SheetSize; opts: SheetOptions };

function scenarios(): Scenario[] {
  const r = prng(SEED);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const text = (n: number) => Array.from({ length: n }, () => pick(WORDS)).join(' ');
  const out: Scenario[] = [];
  for (let s = 0; s < COUNT; s++) {
    let size: SheetSize;
    if (r() < 0.6) {
      const p = pick(LABEL_SIZES);
      size = { width: p.width, height: p.height, ...(p.sheet ? { sheetWidth: p.sheet.width, sheetHeight: p.sheet.height } : {}) };
    } else {
      size = { width: int(40, 300), height: int(40, 300) };
      if (r() < 0.3) Object.assign(size, { sheetWidth: int(size.width, 500), sheetHeight: int(size.height, 500) });
    }
    const n = s % 97 === 3 ? 55 : int(1, 4);
    const labels: LabelView[] = Array.from({ length: n }, (_, i) => ({
      orderId: `00000000-0000-4000-8000-${String(s * 100 + i).padStart(12, '0')}`,
      courier: pick(['LogesTechs', 'باشا', 'شركة التوصيل السريع']),
      ref: `SY-${int(1, 999999)}`,
      courierCode: r() < 0.5 ? `JO${int(1000000000, 9999999999)}` : `SY-${int(1, 99999)}`,
      name: pick(NAMES),
      phones: r() < 0.4 ? [`09${int(10000000, 99999999)}`, `09${int(10000000, 99999999)}`] : r() < 0.95 ? [`09${int(10000000, 99999999)}`] : [],
      place: text(int(1, r() < 0.2 ? 60 : 12)),
      items: Array.from({ length: r() < 0.1 ? int(13, 16) : int(0, 4) }, (_, k) => ({
        name: `${pick(['منتج', 'كريم', 'Serum', 'زيت'])} ${k + 1}${r() < 0.2 ? ' ' + text(8) : ''}`,
        qty: int(1, 5),
        ...(r() < 0.2 ? { addOn: true } : {}),
      })),
      note: r() < 0.4 ? text(int(1, r() < 0.3 ? 80 : 8)) : null,
      cod: `${int(0, 99999)}.${String(int(0, 999)).padStart(3, '0')} ${pick(['JOD', 'SYP', 'USD'])}`,
      qrSvg: `<svg data-n="${int(1, 1e6)}"></svg>`,
    }));
    const opts: SheetOptions = {
      store: {
        name: pick(['صحة بلس', 'Store & <Co>', 'متجر "الأمل"']),
        logoUrl: pick([null, '/api/public/store-logo/55555555-5555-4555-8555-555555555555/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.webp', '/api/media/companies/c1/products/s1/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.webp']),
        supportPhone: r() < 0.5 ? null : `09${int(10000000, 99999999)}`,
      },
      mode: r() < 0.7 ? 'print' : 'pdf',
      token: `tok.${s}`,
      stampUrl: '/api/ops/labels/printed',
      ...(r() < 0.2 ? { skipped: [{ orderNumber: `ORD-${s}`, reason: 'ملغى' }] } : {}),
      ...(r() < 0.1 ? { outsideTheRule: [{ orderNumber: `ORD-${s}-x`, reason: 'غير مؤكد' }] } : {}),
      ...(r() < 0.5 ? { title: `بوالص-${s}` } : {}),
    };
    out.push({ labels, size, opts });
  }
  return out;
}

const digest = (html: string) => createHash('sha256').update(html, 'utf8').digest('base64url');
const ALL_SHOWN: SheetShow = { storeName: true, courierName: true, ref: true, items: true, note: true, qr: true, supportPhone: true };

describe('the waybill of a store that chose nothing is main’s, byte for byte', () => {
  it.runIf(process.env.F15_WRITE_GOLDEN === '1')('(writes the golden from main’s own renderer)', async () => {
    // A path in a variable: the copy exists only while the golden is written, and the type checker must not look for it.
    const copy = './f15-label-sheet-main.tmp';
    const main = (await import(/* @vite-ignore */ copy)) as typeof import('./label-sheet');
    const digests = scenarios().map((sc) => digest(main.renderLabelSheet(sc.labels, sc.size, sc.opts)));
    writeFileSync(GOLDEN, JSON.stringify({ source: 'osm/main 8780e8db src/lib/label-sheet.ts', seed: SEED, count: COUNT, digests }, null, 1) + '\n');
  });

  const all = scenarios();
  let golden = { seed: 0, count: 0, digests: [] as string[] };
  try {
    golden = JSON.parse(readFileSync(GOLDEN, 'utf8'));
  } catch {
    /* a missing golden fails the first test below */
  }

  it('the golden is the one these scenarios were drawn for', () => {
    expect(golden.seed).toBe(SEED);
    expect(golden.count).toBe(COUNT);
    expect(golden.digests).toHaveLength(COUNT);
    // Every scenario is a page of its own: no two printed the same bytes.
    expect(new Set(golden.digests).size).toBe(COUNT);
  });

  it('handed no choice — every one of the 400 pages is main’s', () => {
    const differ = all.map((sc, i) => (digest(renderLabelSheet(sc.labels, sc.size, sc.opts)) === golden.digests[i] ? -1 : i)).filter((i) => i >= 0);
    expect(differ).toEqual([]);
  });

  it('handed every part shown — still main’s, byte for byte', () => {
    const differ = all
      .map((sc, i) => (digest(renderLabelSheet(sc.labels, sc.size, { ...sc.opts, show: ALL_SHOWN })) === golden.digests[i] ? -1 : i))
      .filter((i) => i >= 0);
    expect(differ).toEqual([]);
  });

  it('what the print door resolves for no entry, a broken document, or an entry that hides nothing — main’s logo and no `show`', () => {
    const logo = '/api/public/store-logo/55555555-5555-4555-8555-555555555555/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.webp';
    const ids = { companyId: 'c1', storeId: 's1' };
    const docs: (WaybillPrintDocument | null)[] = [
      null,
      { v: 1 as const, stores: {} },
      { v: 1 as const, stores: { s1: { hide: [], logo: 'store' as const } } },
      { v: 1 as const, stores: { s1: { hide: [], logo: 'store' as const, ownLogo: '/api/media/companies/c1/products/s1/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.webp' } } },
      { v: 1 as const, stores: { other: { hide: ['qr' as const], logo: 'none' as const } } },
    ];
    for (const doc of docs) {
      expect(resolveWaybillPrint(doc, ids, logo)).toEqual({ logoUrl: logo });
      expect(resolveWaybillPrint(doc, ids, 'https://elsewhere.example/logo.png')).toEqual({ logoUrl: null });
      expect(resolveWaybillPrint(doc, ids, null)).toEqual({ logoUrl: null });
    }
  });
});
