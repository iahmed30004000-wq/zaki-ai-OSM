import type { db } from './db';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «شكل القطعة» — WHAT ONE PIECE OF A PRODUCT LOOKS LIKE, AND WHAT IT IS CALLED (the owner, 27/11).
 *
 * The new waybill designs draw one small picture per piece for the packer, and count in the product's own word:
 * «3 عبوات», «قطّارتين», «زوج». The shape is chosen per product on the product screen.
 *
 * ── THE DOCUMENT ── `Company.settings.productShapes` (no migration; one key of the company's settings document):
 *   { [productId]: ProductShape }
 * A product with no entry (or an entry nobody understands) is the generic «قطعة».
 *
 * Pure: the drawings are path data, so the print page builds a string from them and the screen builds elements — the
 * same drawing in both. Black strokes only.
 * ═══════════════════════════════════════════════════════════════════════
 */

export const PRODUCT_SHAPES_KEY = 'productShapes';

export const PRODUCT_SHAPES = ['bottle', 'jar', 'dropper', 'tube', 'box', 'clothing', 'shoe', 'device', 'generic'] as const;
export type ProductShape = (typeof PRODUCT_SHAPES)[number];

export const GENERIC_SHAPE: ProductShape = 'generic';

export interface ShapeInfo {
  /** The shape's own name, on the product screen. */
  ar: string;
  /** The unit word: one · two · three to ten. */
  one: string;
  two: string;
  few: string;
  /** SVG path data on a 24×24 board, drawn as a black line. */
  path: string;
}

export const SHAPE_INFO: Readonly<Record<ProductShape, ShapeInfo>> = Object.freeze({
  bottle: {
    ar: 'عبوة', one: 'عبوة', two: 'عبوتين', few: 'عبوات',
    path: 'M9 2h6v3.5H9zM8.5 5.5h7V7c2 1.2 3 2.5 3 4.5V20a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-8.5c0-2 1-3.3 3-4.5zM5.5 13h13M5.5 18h13',
  },
  jar: {
    ar: 'مرطبان', one: 'مرطبان', two: 'مرطبانين', few: 'مرطبانات',
    path: 'M6 4h12v4H6zM4.5 8h15v10a3 3 0 0 1-3 3h-9a3 3 0 0 1-3-3zM4.5 12.5h15M4.5 16.5h15',
  },
  dropper: {
    ar: 'قطّارة', one: 'قطّارة', two: 'قطّارتين', few: 'قطّارات',
    path: 'M10 2h4v4h-4zM8 6h8v2H8zM9.5 8v2L7 12.5V20a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-7.5L14.5 10V8M12 13.5c1.3 1.7 2 2.7 2 3.6a2 2 0 0 1-4 0c0-.9.7-1.9 2-3.6z',
  },
  tube: {
    ar: 'أنبوب', one: 'أنبوب', two: 'أنبوبين', few: 'أنابيب',
    path: 'M7 2h10l-1.5 15h-7zM8.5 17h7v2h-7zM9.5 19h5v3h-5z',
  },
  box: {
    ar: 'علبة', one: 'علبة', two: 'علبتين', few: 'علب',
    path: 'M3 7.5 12 3l9 4.5v9L12 21l-9-4.5zM3 7.5 12 12l9-4.5M12 12v9',
  },
  clothing: {
    ar: 'ملابس', one: 'قطعة', two: 'قطعتين', few: 'قطع',
    path: 'M8.5 3 3 6.5l2 4.5 2.5-1V21h9V10l2.5 1 2-4.5L15.5 3c-.5 1.7-1.8 2.6-3.5 2.6S9 4.7 8.5 3z',
  },
  shoe: {
    ar: 'حذاء', one: 'زوج', two: 'زوجين', few: 'أزواج',
    path: 'M3 8l5 .5c1.5 3 3.5 4.5 7 5l4 1.2c1.3.4 2 1.2 2 2.3v1H3zM3 15h18M10 11l1.5-1.5M12.5 13l1.5-1.5',
  },
  device: {
    ar: 'جهاز', one: 'جهاز', two: 'جهازين', few: 'أجهزة',
    path: 'M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4',
  },
  generic: {
    ar: 'قطعة عامة', one: 'قطعة', two: 'قطعتين', few: 'قطع',
    path: 'M12 3l2.7 5.8 6.3.8-4.6 4.3 1.2 6.2L12 17l-5.6 3.1 1.2-6.2L3 9.6l6.3-.8z',
  },
});

export function isProductShape(v: unknown): v is ProductShape {
  return typeof v === 'string' && (PRODUCT_SHAPES as readonly string[]).includes(v);
}

/**
 * The unit word that goes with `n` pieces of this shape: singular for one, the dual for two, the plural for three to
 * ten (and for 103, 204…), and the singular again from eleven up, as Arabic counts.
 */
export function unitWord(shape: ProductShape, n: number): string {
  const info = SHAPE_INFO[shape] ?? SHAPE_INFO.generic;
  if (n === 2) return info.two;
  const tail = n % 100;
  return tail >= 3 && tail <= 10 ? info.few : info.one;
}

/** The stored map, read defensively: only products with a shape this system draws. */
export function readShapeMap(raw: unknown): Record<string, ProductShape> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter((e): e is [string, ProductShape] => isProductShape(e[1])));
}

/** Reads the company's settings document once. A read that throws is «nobody chose»: every product is «قطعة». */
export async function readProductShapes(client: Pick<typeof db, 'company'>, companyId: string): Promise<Record<string, ProductShape>> {
  try {
    const row = await client.company.findUnique({ where: { id: companyId }, select: { settings: true } });
    if (!row?.settings) return {};
    return readShapeMap((JSON.parse(row.settings) as Record<string, unknown>)[PRODUCT_SHAPES_KEY]);
  } catch {
    return {};
  }
}
