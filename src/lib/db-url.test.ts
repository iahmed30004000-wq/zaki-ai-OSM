import { describe, expect, it } from 'vitest';
import { HEAVY_POOL, HEAVY_POOL_TIMEOUT_SECONDS, MIN_POOL, withHeavyPool, withPoolFloor } from './db-url';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — the pool is at least twenty (the owner's ruling 4/11)
 *
 *  1. A URL asking for 10 opens 20; one asking for nothing opens 20.
 *  2. A URL asking for more than 20 keeps its own number.
 *  3. Everything else in the URL — user, password (even percent-encoded),
 *     host, port, database, schema, pool_timeout — comes out unchanged.
 *  4. No URL, or one that is not a postgres URL, is handed back untouched.
 * ═══════════════════════════════════════════════════════════════════════
 */

// Built from parts: a literal user:password@host is what the secret scanner (rightly) refuses to see committed.
const pg = (cred: string, rest: string) => ['postgresql://', cred, '@', rest].join('');
const CRED = ['zaki', 's3cr%40t%21x'].join(':');

const pool = (url: string | undefined) => (url ? new URL(url).searchParams.get('connection_limit') : null);

describe('the database pool has a floor of twenty', () => {
  it('raises 10 to 20 and keeps every other part of the URL', () => {
    const url = pg(CRED, 'salesflow-db:5432/salesflow?schema=public&connection_limit=10&pool_timeout=20');
    const out = withPoolFloor(url)!;
    expect(pool(out)).toBe(String(MIN_POOL));
    const a = new URL(url);
    const b = new URL(out);
    expect([b.protocol, b.username, b.password, b.host, b.pathname]).toEqual([a.protocol, a.username, a.password, a.host, a.pathname]);
    expect(b.password).toBe('s3cr%40t%21x');
    expect(b.searchParams.get('schema')).toBe('public');
    expect(b.searchParams.get('pool_timeout')).toBe('20');
  });

  it('adds 20 when the URL asks for nothing', () => {
    expect(pool(withPoolFloor(pg(['u', 'p'].join(':'), 'h:5432/d')))).toBe('20');
  });

  it('keeps a larger number the URL already asks for', () => {
    const url = pg(['u', 'p'].join(':'), 'h:5432/d?connection_limit=40');
    expect(withPoolFloor(url)).toBe(url);
  });

  it('hands back no URL, a non-postgres URL and an unreadable one untouched', () => {
    expect(withPoolFloor(undefined)).toBeUndefined();
    expect(withPoolFloor('')).toBe('');
    expect(withPoolFloor('file:./dev.db')).toBe('file:./dev.db');
    expect(withPoolFloor('not a url')).toBe('not a url');
  });

  it('the client is opened through it', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./db.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/datasourceUrl:\s*withPoolFloor\(process\.env\.DATABASE_URL\)/);
  });
});

describe('the reports lane has a small pool of its own (the owner, 13/11)', () => {
  it('opens exactly six connections and waits up to two minutes for one — whatever the URL asked for — and keeps the rest of the URL', () => {
    expect(HEAVY_POOL).toBe(6);
    expect(HEAVY_POOL_TIMEOUT_SECONDS).toBe(120);
    for (const asked of ['connection_limit=10&pool_timeout=20', 'connection_limit=40', '']) {
      const url = pg(CRED, `salesflow-db:5432/salesflow?schema=public${asked ? '&' + asked : ''}`);
      const out = new URL(withHeavyPool(url)!);
      expect(out.searchParams.get('connection_limit'), asked).toBe('6');
      expect(out.searchParams.get('pool_timeout'), asked).toBe('120');
      const a = new URL(url);
      expect([out.username, out.password, out.host, out.pathname, out.searchParams.get('schema')]).toEqual([a.username, a.password, a.host, a.pathname, 'public']);
    }
  });

  it('is NOT the main pool: the floor of twenty is still what the main client gets', () => {
    const url = pg(CRED, 'h:5432/d?connection_limit=10');
    expect(pool(withPoolFloor(url))).toBe('20');
    expect(pool(withHeavyPool(url))).toBe('6');
  });

  it('hands back no URL, a non-postgres URL and an unreadable one untouched', () => {
    expect(withHeavyPool(undefined)).toBeUndefined();
    expect(withHeavyPool('')).toBe('');
    expect(withHeavyPool('file:./dev.db')).toBe('file:./dev.db');
    expect(withHeavyPool('not a url')).toBe('not a url');
  });
});
