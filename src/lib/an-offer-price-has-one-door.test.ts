import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { stripComments } from './guard-source';

/**
 * «العرض ما بصير يكون اكثر من السعر الاساسي» — AND THE RULE IS ONLY AS TRUE AS ITS DOORS ARE FEW.
 *
 * The line an offer must stay under is enforced where an offer is written: `POST /api/offers`, `PATCH
 * /api/offers/[id]`, with the comparison and the sentence in `src/lib/offers.ts`. A route, a job or an import that
 * wrote an offer by itself would write PAST the rule, and nothing would say so — the rule would hold for the offers
 * that happened to come in through the screen and for no others.
 *
 * So the tree is swept for every shape an offer can be written in, and under `src/` only those two places may
 * carry one. Outside `src/`, the scripts that knowingly write offers past the doors are NAMED below, each with its
 * reason, and a new one fails this file until somebody names it too.
 */

const ROOT = process.cwd();
const rel = (p: string) => relative(ROOT, p).split(sep).join('/');

function codeUnder(dir: string, ext: RegExp): string[] {
  const out: string[] = [];
  let names: string[];
  try {
    names = readdirSync(join(ROOT, dir));
  } catch {
    return out;
  }
  for (const name of names) {
    const p = join(ROOT, dir, name);
    if (statSync(p).isDirectory()) out.push(...codeUnder(rel(p), ext));
    else if (ext.test(name) && !/\.test\.tsx?$/.test(name)) out.push(rel(p));
  }
  return out;
}

/**
 * EVERY SHAPE AN OFFER IS WRITTEN IN.
 *
 *   · the client's own verbs on the table — `tx.offer.update(`, `prisma.offer.createMany(` …
 *   · a write NESTED in another row's — a product created with `offers: { create: […] }`, an order with
 *     `offer: { connectOrCreate: … }` — which names no `offer.` verb at all;
 *   · raw SQL on the table, which names no model at all.
 *
 * A delete is not here: it removes a price, it cannot write one above its line.
 */
const OFFER_WRITES: RegExp[] = [
  /\boffer\s*\.\s*(?:create|createMany|update|updateMany|upsert)\s*\(/,
  /\boffers?\s*:\s*\{\s*(?:create|createMany|connectOrCreate|update|updateMany|upsert)\b/,
  /\b(?:INSERT\s+INTO|UPDATE)\s+"?offers"?(?![\w"])/i,
];
const writesAnOffer = (src: string) => {
  const code = stripComments(src);
  return OFFER_WRITES.some((re) => re.test(code));
};

/** The two doors the rule lives at — and the file the rule itself lives in. */
const THE_DOORS = (f: string) => f === 'src/lib/offers.ts' || f.startsWith('src/app/api/offers/');

/**
 * WRITE OFFERS WITHOUT THE DOORS, AND KNOW IT — each with the reason. All four are run by hand, by the owner, and
 * never by a request; and the catalogues they write were measured under the line when this was written (the seed
 * prices each product from its one-piece offer; the sehha tiers top out exactly on it, «قطعتان + قطعة» at 50 for a
 * base of 25). What this list buys is that the NEXT one cannot appear unnamed.
 */
const BYPASS_ON_PURPOSE: Record<string, string> = {
  'prisma/seed.ts': 'البيانات التجريبية: يمسح ويكتب كتالوجاً كاملاً، وسعر القطعة فيه مأخوذ من عرض القطعة الواحدة',
  'scripts/sehha/apply.ts': 'كتالوج صحّة يدويّ يشغّله المالك: يحدّث العروض ويوقف القديم، وأعلاه على الحدّ تماماً',
  'scripts/golden-path.ts': 'المسار الذهبي: ينشئ عرضاً بحسمٍ ليختبر الطلب من أوّله لآخره على قاعدة تجريبية',
  'scripts/migration/run.mjs': 'ترحيل لمرّة واحدة: يكتب عروض الملف القديم كما كانت، قبل أن توجد القاعدة',
};

describe('every offer write in src/ goes through the two doors that hold the line', () => {
  const SRC = codeUnder('src', /\.tsx?$/);
  const writers = SRC.filter((f) => writesAnOffer(readFileSync(join(ROOT, f), 'utf8')));

  it('sweeps a real tree, not an empty one — and finds the doors themselves', () => {
    expect(SRC.length).toBeGreaterThan(500);
    // A detector that found nothing would pass the next test by default.
    expect(writers).toContain('src/app/api/offers/route.ts');
    expect(writers).toContain('src/app/api/offers/[id]/route.ts');
    expect(writers).toContain('src/lib/offers.ts');
  });

  it('and nothing else under src/ writes one', () => {
    const strangers = writers.filter((f) => !THE_DOORS(f));
    expect(
      strangers,
      'ملفٌّ يكتب عرضاً من غير بابَي العروض — فالقاعدة «العرض ما بصير يكون أكثر من السعر الأساسي» ما بتوصله:\n' +
        strangers.join('\n')
    ).toEqual([]);
  });
});

describe('and outside src/, the scripts that write past the doors are named', () => {
  const OUTSIDE = [...codeUnder('scripts', /\.(?:ts|mts|js|mjs|cjs)$/), ...codeUnder('prisma', /\.(?:ts|mts|js|mjs|cjs)$/)];
  const writers = OUTSIDE.filter((f) => writesAnOffer(readFileSync(join(ROOT, f), 'utf8')));

  it('every one of them, and not one more', () => {
    expect(writers.sort()).toEqual(Object.keys(BYPASS_ON_PURPOSE).sort());
  });

  it('and each reason is a sentence a reviewer can check', () => {
    for (const [file, why] of Object.entries(BYPASS_ON_PURPOSE)) {
      expect([...why].length, `${file}: السبب أقصر من أن يُراجَع`).toBeGreaterThan(30);
    }
  });
});

describe('the detector bites — every shape, and none of the prose', () => {
  it.each([
    ['a client verb', 'await tx.offer.update({ where: { id }, data })'],
    ['a client verb across a line break', 'await prisma.offer\n  .upsert ({ where, create, update })'],
    ['many at once', 'await db.offer.createMany({ data: rows })'],
    ['nested in a product', "await db.product.create({ data: { name, offers: { create: [{ sellingPrice: 99 }] } } })"],
    ['nested in an order', 'await tx.order.create({ data: { offer: { connectOrCreate: { where, create } } } })'],
    ['raw SQL', 'await db.$executeRaw`UPDATE "offers" SET "sellingPrice" = ${p} WHERE id = ${id}`'],
    ['raw SQL, unquoted', "await db.$executeRawUnsafe('INSERT INTO offers (id) VALUES ($1)', id)"],
  ])('%s is a write', (_shape, src) => {
    expect(writesAnOffer(src)).toBe(true);
  });

  it.each([
    ['a read', 'await db.offer.findMany({ where: { productId } })'],
    ['a delete', 'await db.offer.delete({ where: { id } })'],
    ['a count through a relation', 'include: { _count: { select: { offers: true } } }'],
    ['another table', 'await db.$executeRaw`UPDATE "offer_events" SET x = 1`'],
    ['a comment that quotes a write', '/* await tx.offer.update({ data }) */\n// db.offer.create({})'],
  ])('NEGATIVE: %s is not', (_shape, src) => {
    expect(writesAnOffer(src)).toBe(false);
  });
});
