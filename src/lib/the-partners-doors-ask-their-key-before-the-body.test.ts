import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from './guard-source';

/**
 * EVERY PARTNERS DOOR ASKS `finance.partners` BEFORE A BYTE OF THE BODY IS READ (13/11) — read off the source, handler by handler.
 *
 * The behaviour is proved by driving each door with a person who holds every other finance key (`the-partners-are-saved-whole`, the
 * draws door's test, the statement route's test). This is the structural half: in each handler of each partners door the key is asked
 * BEFORE the first read of the request, so a door added beside them cannot read a body first and check afterwards without a test turning
 * red; and the draws door writes only through `recordMovement`, never a row of its own.
 */

const root = process.cwd();
const DOORS = [
  'src/app/api/finance/partners/route.ts',
  'src/app/api/finance/partners/statement/route.ts',
  'src/app/api/finance/partners/draws/route.ts',
];
const source = (rel: string) => stripComments(readFileSync(join(root, rel), 'utf8'));

/** The handlers of a route file, each with its text up to the next one. */
function handlers(src: string): { method: string; body: string }[] {
  const marks = [...src.matchAll(/export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\b/g)];
  return marks.map((m, i) => ({ method: m[1], body: src.slice(m.index!, marks[i + 1]?.index ?? src.length) }));
}

describe('each handler of each partners door asks the key first', () => {
  for (const file of DOORS) {
    const list = handlers(source(file));

    it(`${file} has handlers to check — a sweep over nothing proves nothing`, () => {
      expect(list.length).toBeGreaterThan(0);
    });

    for (const { method, body } of list) {
      it(`${method} ${file}: the context, then the key, and only then the request`, () => {
        const context = body.indexOf('requireContext(');
        const key = body.indexOf("requirePermission('finance.partners')");
        const firstRead = (() => {
          const reads = [/\.json\(/, /\.text\(/, /\.formData\(/, /\.arrayBuffer\(/, /\.blob\(/, /new URL\(\s*req/, /\breq\.body\b/]
            .map((re) => body.search(re))
            .filter((i) => i >= 0);
          return reads.length ? Math.min(...reads) : Number.POSITIVE_INFINITY;
        })();
        expect(context, 'the context is asked').toBeGreaterThanOrEqual(0);
        expect(key, 'the key is asked').toBeGreaterThan(context);
        expect(key, 'the key comes before the request is read').toBeLessThan(firstRead);
      });
    }
  }

  it('the draws door asks the cash box’s key too — cash leaves a wallet — and also before the body', () => {
    const { body } = handlers(source('src/app/api/finance/partners/draws/route.ts'))[0];
    const second = body.indexOf("requirePermission('finance.cashbox')");
    expect(second).toBeGreaterThan(body.indexOf("requirePermission('finance.partners')"));
    expect(second).toBeLessThan(body.indexOf('.json('));
  });

  it('NEGATIVE: a handler that read the body first would be caught — the check itself can see the order', () => {
    const wrong = `export async function POST(req: Request) { const { companyId } = await requireContext(); const b = await req.json(); await requirePermission('finance.partners'); }`;
    const { body } = handlers(wrong)[0];
    expect(body.indexOf("requirePermission('finance.partners')")).toBeGreaterThan(body.indexOf('.json('));
  });
});

describe('what the partners doors write, and how', () => {
  const draws = source('src/app/api/finance/partners/draws/route.ts');

  it('a draw is written through `recordMovement` and no row of its own — not a movement, not an expense', () => {
    expect(draws).toMatch(/recordMovement\(tx,/);
    expect(draws).not.toMatch(/walletMovement\.(create|createMany|update|updateMany|upsert|delete)\(/);
    expect(draws).not.toMatch(/\bexpense\.(create|update|upsert|delete)\(/i);
    expect(draws).toContain("category: 'PARTNER_DRAW'");
    expect(draws).toContain("direction: 'OUT'");
  });

  it('the statement door writes nothing at all', () => {
    const src = source('src/app/api/finance/partners/statement/route.ts');
    expect(src).not.toMatch(/\.(create|update|updateMany|upsert|delete|deleteMany|createMany)\(/);
    expect(src).not.toMatch(/\$(executeRaw|queryRaw)/);
  });

  it('the list door never deletes a partner and writes only partners', () => {
    const src = source('src/app/api/finance/partners/route.ts');
    expect(src).not.toMatch(/\.(delete|deleteMany)\(/);
    // every write is `tx.partner.update(` or `tx.partner.create(` — the one table, inside the one transaction
    expect([...src.matchAll(/\b(\w+)\.(create|update|updateMany|upsert)\(/g)].map((m) => m[1])).toEqual(['partner', 'partner']);
    expect([...src.matchAll(/\btx\.(\w+)\./g)].map((m) => m[1])).toEqual(['partner', 'partner']);
  });

  it('the draws door puts the wallet row under a lock BEFORE it looks for a twin, and the twin before the write', () => {
    const lock = draws.indexOf('FOR UPDATE');
    const twin = draws.indexOf('walletMovement.findFirst(');
    const write = draws.indexOf('recordMovement(tx,');
    expect(lock).toBeGreaterThan(0);
    expect(twin).toBeGreaterThan(lock);
    expect(write).toBeGreaterThan(twin);
  });

  it('and all of it runs inside ONE transaction', () => {
    const tx = draws.indexOf('$transaction(');
    expect(tx).toBeGreaterThan(0);
    expect(draws.indexOf('FOR UPDATE')).toBeGreaterThan(tx);
    expect(draws.indexOf('recordMovement(tx,')).toBeGreaterThan(tx);
  });
});
