import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { stripComments } from '../guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE MEDIA BUYER'S DOORS CANNOT WRITE — BY CONSTRUCTION, NOT BY PROMISE.
 *
 * The owner's rule (2026-10-26): «بدنا حل جذري… ما بدنا نخرب ع حالنا». The
 * media buyer edits ads in its own system and only READS here. A scope
 * named «read» is a label; this file is the proof.
 *
 * It walks the CALL GRAPH from the two routes the media buyer calls —
 * every function they call, every function those call, across files — and
 * fails if any of it reaches a Prisma write: create, update, upsert,
 * delete (and their -Many forms), `$executeRaw`, or `$transaction`.
 *
 * ONE ALLOWED WRITE, AND IT IS NAMED: `requireSystemToken` stamps
 * `SystemToken.lastUsedAt` at most once a minute. That is the guard's own
 * bookkeeping on the key, it never touches an order or a product, and it
 * stays exactly where it already was.
 *
 * Why a walk and not a list of files: `products/route.ts` imports
 * `reservation.ts`, which DOES write — it holds the stock reservations.
 * What matters is that the function the door calls (`availableStock`)
 * reads, and that a future edit making it write fails here.
 * ═══════════════════════════════════════════════════════════════════════
 */

const ROOT = process.cwd();
const rel = (p: string) => relative(ROOT, p).split(sep).join('/');

const ENTRY_ROUTES = [
  'src/app/api/v1/orders/attribution/route.ts',
  'src/app/api/v1/products/route.ts',
  // The daily spend read (PR-A): a SELECT over `ad_spend_days` — the pull that FILLS the table is the job's, not this door's.
  'src/app/api/v1/ad-spend/route.ts',
];

/** The named exception — see the header. */
const ALLOWED = new Set(['src/lib/v1/system-token.ts#requireSystemToken']);
/** The client itself is not a function the doors call. */
const SKIP_FILES = new Set(['src/lib/db.ts']);

const WRITE =
  /\b(?:db|tx|client|prisma)\s*\.\s*\w+\s*\.\s*(?:create|createMany|createManyAndReturn|update|updateMany|upsert|delete|deleteMany)\s*\(|\$executeRaw|\$executeRawUnsafe|\$transaction/;

const cache = new Map<string, string>();
function source(file: string): string {
  if (!cache.has(file)) cache.set(file, stripComments(readFileSync(join(ROOT, file), 'utf8')));
  return cache.get(file)!;
}

/** `@/lib/x` or `./x` from `fromFile` → a repo-relative .ts path, or null for a package. */
function resolve(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = join(ROOT, 'src', spec.slice(2));
  else if (spec.startsWith('.')) base = join(ROOT, dirname(fromFile), spec);
  else return null;
  for (const cand of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(cand)) return rel(cand);
  }
  return null;
}

/** name → file, for every VALUE import of a file (type-only imports are skipped). */
function importsOf(file: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of source(file).matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+'([^']+)'/g)) {
    if (m[1]) continue;
    const target = resolve(m[3], file);
    if (!target) continue;
    for (const part of m[2].split(',')) {
      const p = part.trim();
      if (!p || p.startsWith('type ')) continue;
      const [orig, alias] = p.split(/\s+as\s+/);
      out.set((alias ?? orig).trim(), `${target}#${orig.trim()}`);
    }
  }
  return out;
}

/** The text of `function NAME(...) {...}` or `const NAME = ...` in a file, brace-matched. */
function bodyOf(file: string, name: string): string | null {
  const src = source(file);
  const m = new RegExp(`(?:function\\s+${name}\\s*[<(]|(?:const|let)\\s+${name}\\s*[:=])`).exec(src);
  if (!m) return null;
  const open = src.indexOf('{', m.index);
  const semi = src.indexOf(';', m.index);
  // A `const X = value;` with no block before its semicolon is its own body.
  if (open === -1 || (semi !== -1 && semi < open && !/function|=>/.test(src.slice(m.index, semi)))) {
    return src.slice(m.index, semi === -1 ? undefined : semi);
  }
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(m.index, i + 1);
  }
  return src.slice(m.index);
}

/** Walks every function reachable from the routes' handlers. */
function walk() {
  const visited = new Set<string>();
  const writes: string[] = [];
  const queue: { file: string; body: string; id: string }[] = [];

  for (const route of ENTRY_ROUTES) {
    // The handler is the whole route file: everything in it runs on a call.
    queue.push({ file: route, body: source(route), id: `${route}#GET` });
  }

  while (queue.length) {
    const { file, body, id } = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    if (ALLOWED.has(id)) continue;
    if (WRITE.test(body)) writes.push(id);

    const imports = importsOf(file);
    for (const call of body.matchAll(/(?<![.\w])([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = call[1];
      const imported = imports.get(name);
      if (imported) {
        const [target, orig] = imported.split('#');
        if (SKIP_FILES.has(target)) continue;
        const b = bodyOf(target, orig);
        if (b) queue.push({ file: target, body: b, id: imported });
        continue;
      }
      const local = bodyOf(file, name);
      if (local && `${file}#${name}` !== id) queue.push({ file, body: local, id: `${file}#${name}` });
    }
  }
  return { visited: [...visited].sort(), writes };
}

describe('the media buyer’s doors cannot write', () => {
  const { visited, writes } = walk();

  it('the walk reached the real work — a sweep over nothing proves nothing', () => {
    for (const must of [
      'src/lib/v1/attribution.ts#readAttributionPage',
      'src/lib/v1/product-figures.ts#productFigures',
      'src/lib/product-cost.ts#productCosts',
      'src/lib/reservation.ts#availableStock',
      'src/lib/reservation.ts#reservedElsewhere',
      'src/lib/stock-ledger.ts#deliveredPerProduct',
      'src/lib/offers.ts#activeOffersFor',
      'src/lib/v1/system-token.ts#requireSystemToken',
    ]) {
      expect(visited, must).toContain(must);
    }
    expect(visited.length).toBeGreaterThanOrEqual(20);
  });

  it('and not one function on it writes to the database', () => {
    expect(writes, `دالّةٌ على طريق الميديا باير تكتب في قاعدة البيانات:\n${writes.join('\n')}`).toEqual([]);
  });

  it('and the detector does see a write when there is one', () => {
    for (const w of [
      'await db.order.update({ where: { id } })',
      'tx.product.deleteMany({})',
      'db.$executeRaw`UPDATE orders`',
      'await db.$transaction(async (t) => {})',
      'db.systemToken.upsert({})',
    ]) {
      expect(WRITE.test(w), w).toBe(true);
    }
    for (const r of ['db.order.findMany({})', 'map.delete(key)', 'hash.update(token)', 'db.order.aggregate({})']) {
      expect(WRITE.test(r), r).toBe(false);
    }
  });

  it('and both doors answer GET only', () => {
    for (const route of ENTRY_ROUTES) {
      const handlers = [...source(route).matchAll(/export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\b/g)].map(
        (m) => m[1]
      );
      expect(handlers, route).toEqual(['GET']);
    }
  });
});
