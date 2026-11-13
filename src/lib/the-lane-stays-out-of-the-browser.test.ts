import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * THE REPORTS LANE NEVER REACHES A BROWSER BUNDLE.
 *
 * `heavy-lane.ts` imports `node:async_hooks` (an `AsyncLocalStorage`). A browser chunk cannot take a Node built-in: the production
 * build of the first version of the lane FAILED on it — «the chunking context does not support external modules (request:
 * node:async_hooks)» for /confirmation/mine/page — because `ConfirmationMineScreen` (a client screen) imports `confirmation-queue.ts`,
 * which imports `db.ts`, which imported the lane. No unit test sees that: only the production build does, and it takes twenty minutes.
 * So the same walk the bundler makes is made here, in milliseconds, over the source: from every `'use client'` file, through every
 * value import (a `import type` is erased and does not count), and the lane must not be on any path.
 *
 * `db.ts` reads the lane's marker from `globalThis` by the key in `heavy-lane-key.ts` — a module with no import — for exactly this.
 */

type Read = (file: string) => string | null;

const SPEC = /^\s*(?:import|export)\s+(type\s+)?([^;]*?)\s+from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/gm;

/** The value imports of one file, as written (a type-only import, whole or every name, is erased by the compiler). */
export function valueImports(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(SPEC)) {
    if (m[1]) continue;
    const spec = m[3] ?? m[4] ?? m[5];
    if (!spec) continue;
    const names = m[2]?.trim();
    if (names && /^\{[^}]*\}$/.test(names)) {
      const all = names.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean);
      if (all.length > 0 && all.every((n) => n.startsWith('type '))) continue;
    }
    out.push(spec);
  }
  return out;
}

/** The first chain from a client root to a file that matches `isTarget` (or imports a Node built-in `builtin`), or null. */
export function chainToTarget(opts: {
  roots: string[];
  read: Read;
  resolveSpec: (from: string, spec: string) => string | null;
  isTarget: (file: string, text: string) => boolean;
}): string[] | null {
  const parent = new Map<string, string | null>();
  const queue: string[] = [];
  for (const r of opts.roots) {
    parent.set(r, null);
    queue.push(r);
  }
  while (queue.length > 0) {
    const file = queue.shift()!;
    const text = opts.read(file);
    if (text === null) continue;
    if (opts.isTarget(file, text)) {
      const chain: string[] = [];
      for (let f: string | null | undefined = file; f; f = parent.get(f)) chain.unshift(f);
      return chain;
    }
    for (const spec of valueImports(text)) {
      const next = opts.resolveSpec(file, spec);
      if (next && !parent.has(next)) {
        parent.set(next, file);
        queue.push(next);
      }
    }
  }
  return null;
}

describe('the walk itself (a fake tree)', () => {
  const tree: Record<string, string> = {
    '/c.tsx': "'use client';\nimport { a } from './a';",
    '/a.ts': "import { db } from './db';\nimport type { T } from './lane';",
    '/db.ts': "import { lane } from './lane';",
    '/lane.ts': "import { AsyncLocalStorage } from 'node:async_hooks';",
    '/typesonly.ts': "import { type A, type B } from './lane';\nimport type { C } from './lane';",
  };
  const read: Read = (f) => tree[f] ?? null;
  const resolveSpec = (from: string, spec: string) => (spec.startsWith('.') ? '/' + spec.replace('./', '') + (spec.endsWith('.tsx') ? '' : '.ts') : null);
  const isTarget = (_f: string, text: string) => /node:async_hooks/.test(text);

  it('finds a Node built-in behind a client file — through a plain import', () => {
    expect(chainToTarget({ roots: ['/c.tsx'], read, resolveSpec, isTarget })).toEqual(['/c.tsx', '/a.ts', '/db.ts', '/lane.ts']);
  });

  it('and does not follow an import that the compiler erases (a type import, whole or every name)', () => {
    expect(chainToTarget({ roots: ['/typesonly.ts'], read, resolveSpec, isTarget })).toBeNull();
    expect(valueImports("import type { A } from './x';\nimport { type B, type C } from './y';")).toEqual([]);
    expect(valueImports("import { type B, c } from './y';\nexport * from './z';\nimport('./w');")).toEqual(['./y', './z', './w']);
  });
});

describe('the real source', () => {
  const SRC = resolve(__dirname, '..');

  const isFile = (p: string) => existsSync(p) && statSync(p).isFile();
  const resolveSpec = (from: string, spec: string): string | null => {
    let base: string;
    if (spec.startsWith('@/')) base = join(SRC, spec.slice(2));
    else if (spec.startsWith('.')) base = resolve(dirname(from), spec);
    else return null;
    for (const ext of ['', '.ts', '.tsx', '.js', '.jsx']) if (isFile(base + ext)) return base + ext;
    for (const ext of ['.ts', '.tsx', '.js']) if (isFile(join(base, 'index' + ext))) return join(base, 'index' + ext);
    return null;
  };
  const read: Read = (f) => (isFile(f) ? readFileSync(f, 'utf8') : null);

  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) sourceFiles(p, out);
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(p);
    }
    return out;
  }
  const clientRoots = sourceFiles(SRC).filter((f) => /^\s*['"]use client['"]/.test((read(f) ?? '').slice(0, 400)));

  it('has client files to walk from (the guard is not an empty loop)', () => {
    expect(clientRoots.length).toBeGreaterThan(100);
  });

  it('no client file reaches the lane, by any chain of value imports', () => {
    const chain = chainToTarget({
      roots: clientRoots,
      read,
      resolveSpec,
      isTarget: (file) => /[\\/]lib[\\/]heavy-lane\.ts$/.test(file),
    });
    expect(chain?.map((f) => f.replace(SRC, 'src')), 'a client bundle would take node:async_hooks').toBeUndefined();
  });

  it('no client file reaches ANY module that imports node:async_hooks (the lane is the only one today)', () => {
    const chain = chainToTarget({
      roots: clientRoots,
      read,
      resolveSpec,
      isTarget: (_f, text) => /from\s+['"]node:async_hooks['"]|require\(['"]node:async_hooks['"]\)/.test(text),
    });
    expect(chain?.map((f) => f.replace(SRC, 'src'))).toBeUndefined();
  });

  it('db.ts imports nothing from the lane — it reads the marker by a key', () => {
    const db = read(join(SRC, 'lib', 'db.ts'))!;
    expect(db).not.toMatch(/from\s+['"]\.\/heavy-lane['"]/);
    expect(db).toMatch(/from\s+'\.\/heavy-lane-key'/);
    const key = read(join(SRC, 'lib', 'heavy-lane-key.ts'))!;
    expect(valueImports(key), 'the key module has no import').toEqual([]);
    expect(key).toMatch(/export const LANE_KEY = '__osmReportsLane' as const;/);
  });

  it('and the lane keeps its storage under that same key', () => {
    const lane = read(join(SRC, 'lib', 'heavy-lane.ts'))!;
    expect(lane).toMatch(/shared\[LANE_KEY\] \?\?= new AsyncLocalStorage/);
  });
});
