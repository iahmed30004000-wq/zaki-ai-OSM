import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertScratchUrl } from '../../scripts/verify-on-postgres/lib.mjs';

/**
 * DEFINITION OF DONE — the local real-PostgreSQL verification kit (`scripts/verify-on-postgres/`, Confirmation Center v2, planner answer 11).
 *
 * WHAT MUST WORK
 *   1. The gate `assertScratchUrl` lets through a URL that points at this machine AND names a database starting with `scratch_` — and stops the
 *      process (exit 1, a sentence on stderr) for anything else: a remote host, a real database name, a host smuggled into the credentials or a
 *      query parameter, a URL that is not PostgreSQL, a string that is not a URL.
 *   2. No script of the kit takes its database from anywhere but the gate: none READS `process.env.DATABASE_URL` (it only ever assigns it, from
 *      `scratchUrl()`), none loads a `.env` file, and the ones that open a database pass through `assertScratchUrl` / `childEnv` / `scratchUrl`.
 *   3. No script contains a destructive prisma or SQL verb (`migrate dev`, `migrate reset`, `db push`, `--force-reset`, `DROP DATABASE`, `DROP SCHEMA`),
 *      and `TRUNCATE` lives only in the seed, which wipes the throwaway database it has just checked.
 *
 * EDGE CASES: `localhost`, `127.0.0.1` and `[::1]` are all local; `scratch` without the underscore and `SCRATCH_` in capitals are not `scratch_`;
 * `127.0.0.1.evil.example` and `localhost@evil.example` are not local; `?host=` and `?dbname=` could redirect libpq/prisma, so they are refused.
 *
 * BLOCKERS: a customer-data or production write reachable from the kit; a credential literal in a tracked file (no URL below carries one).
 */

const KIT = join(process.cwd(), 'scripts', 'verify-on-postgres');

/** Runs the gate; returns what it said when it stopped the process, null when the URL passed. */
function refusal(url: string): string | null {
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('EXIT');
  }) as never);
  const said: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    said.push(a.map(String).join(' '));
  });
  try {
    assertScratchUrl(url);
    return null;
  } catch (e) {
    if (e instanceof Error && e.message === 'EXIT') {
      expect(exit).toHaveBeenCalledWith(1);
      return said.join('\n');
    }
    throw e;
  }
}

afterEach(() => vi.restoreAllMocks());

describe('the gate lets a scratch database on this machine through', () => {
  it.each([
    'postgresql://127.0.0.1:54329/scratch_zaki',
    'postgresql://localhost:5432/scratch_anything',
    'postgres://[::1]:5432/scratch_x',
    'postgresql://nobody@127.0.0.1:1/scratch_none',
  ])('%s', (url) => {
    expect(refusal(url)).toBeNull();
  });
});

describe('and stops everything else', () => {
  it.each([
    ['a remote host', 'postgresql://db.example.com:5432/scratch_zaki', 'host'],
    ['a real database name on this machine', 'postgresql://127.0.0.1:5432/zaki', 'scratch_'],
    ['the word without its underscore', 'postgresql://127.0.0.1:5432/scratch', 'scratch_'],
    ['the prefix in capitals', 'postgresql://127.0.0.1:5432/SCRATCH_zaki', 'scratch_'],
    ['the prefix in the middle', 'postgresql://127.0.0.1:5432/prod_scratch_zaki', 'scratch_'],
    ['no database at all', 'postgresql://127.0.0.1:5432/', 'scratch_'],
    ['a host that only starts like a local one', 'postgresql://127.0.0.1.evil.example:5432/scratch_zaki', 'host'],
    ['a local name in the credentials, a remote host after it', 'postgresql://localhost@evil.example:5432/scratch_zaki', 'host'],
    ['a host passed as a query parameter', 'postgresql://127.0.0.1:5432/scratch_zaki?host=evil.example', 'query'],
    ['a database passed as a query parameter', 'postgresql://127.0.0.1:5432/scratch_zaki?dbname=zaki', 'query'],
    ['another protocol', 'mysql://127.0.0.1:3306/scratch_zaki', 'PostgreSQL'],
    ['a string that is not a URL', 'not a url', 'عنوان'],
    ['nothing', '', 'عنوان'],
  ])('%s', (_what, url, words) => {
    const said = refusal(url);
    expect(said, `the gate let ${url || '(empty)'} through`).not.toBeNull();
    expect(said).toContain(words);
  });
});

// ───────────────────────── what the scripts are allowed to do ─────────────────────────

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1');
const scripts = readdirSync(KIT)
  .filter((f) => f.endsWith('.mjs'))
  .map((f) => [f, stripComments(readFileSync(join(KIT, f), 'utf8'))] as const);

describe('every script of the kit', () => {
  it('sweeps the real folder, not an empty one', () => {
    const names = scripts.map(([f]) => f);
    for (const must of ['lib.mjs', 'seed.mjs', 'migrate.mjs', 'pull-order.mjs', 'run-app.mjs', 'screenshots.mjs', 'start-db.mjs', 'stop-db.mjs']) {
      expect(names, `${must} is missing from the sweep`).toContain(must);
    }
  });

  it('never READS DATABASE_URL — it only assigns it, from the gate', () => {
    const readers = scripts.filter(([, src]) => /process\.env\.DATABASE_URL(?!\s*=[^=])/.test(src)).map(([f]) => f);
    expect(readers).toEqual([]);
  });

  it('never loads a .env file', () => {
    // `migrate.mjs` WRITES a decoy `.env` into a temporary directory to prove that the process variable wins; no script READS one.
    const loaders = scripts.filter(([, src]) => /dotenv|readFileSync\([^)]*['"`]\.env/.test(src)).map(([f]) => f);
    expect(loaders).toEqual([]);
    expect(scripts.find(([n]) => n === 'migrate.mjs')?.[1] ?? '').not.toMatch(/readFileSync/);
  });

  it('opens a database only through the gate', () => {
    const through = /assertScratchUrl\(|childEnv\(|scratchUrl\(/;
    for (const f of ['seed.mjs', 'migrate.mjs', 'pull-order.mjs', 'scale-retries.mjs', 'run-app.mjs']) {
      const src = scripts.find(([n]) => n === f)?.[1] ?? '';
      expect(src, `${f} reaches a database without the gate`).toMatch(through);
    }
    for (const f of ['seed.mjs', 'pull-order.mjs', 'scale-retries.mjs']) {
      const src = scripts.find(([n]) => n === f)?.[1] ?? '';
      expect(src, `${f} builds a client before the gate`).toMatch(/assertScratchUrl\(/);
      expect(src.indexOf('assertScratchUrl('), `${f} checks the gate after building a client`).toBeLessThan(src.indexOf('new PrismaClient('));
    }
  });

  it('contains no destructive prisma or SQL verb — and TRUNCATE only in the seed', () => {
    const bad = /migrate\s+(?:reset|dev)|['"]migrate['"]\s*,\s*['"](?:reset|dev)['"]|db\s+push|['"]db['"]\s*,\s*['"]push['"]|--force-reset|DROP\s+(?:DATABASE|SCHEMA)/i;
    expect(scripts.filter(([, src]) => bad.test(src)).map(([f]) => f)).toEqual([]);
    expect(scripts.filter(([, src]) => /TRUNCATE/i.test(src)).map(([f]) => f)).toEqual(['seed.mjs']);
  });

  it('talks to the app only on this machine (the session helper refuses any other address)', () => {
    const src = scripts.find(([n]) => n === 'app-session.mjs')?.[1] ?? '';
    expect(src).toMatch(/LOCAL\.has\(url\.hostname\)/);
    for (const f of ['check-app.mjs', 'screenshots.mjs']) {
      expect(scripts.find(([n]) => n === f)?.[1] ?? '', `${f} takes the app's address without the local-only check`).toMatch(/baseUrlFrom\(/);
    }
  });
});
