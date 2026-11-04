import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isStaleBuildError, reloadOnceForStaleBuild, STALE_RELOAD_KEY, STALE_RELOAD_WINDOW_MS } from './stale-build';

/**
 * A FILE FROM THE BUILD BEFORE A DEPLOY: ONE RELOAD, NEVER A LOOP.
 *
 * After a deploy an open tab asks for a file the new build does not have,
 * and the system error screen used to offer only «أعد المحاولة», which asks
 * for the same missing file. It now reloads the page once — and the guard
 * in `sessionStorage` is what keeps it once.
 */

function fakeWindow(stored: Record<string, string> = {}, opts: { refuse?: boolean } = {}) {
  const store = { ...stored };
  const reload = vi.fn();
  const sessionStorage = {
    getItem: (k: string) => {
      if (opts.refuse) throw new Error('SecurityError');
      return k in store ? store[k] : null;
    },
    setItem: (k: string, v: string) => {
      if (opts.refuse) throw new Error('SecurityError');
      store[k] = v;
    },
  } as unknown as Storage;
  return { win: { sessionStorage, location: { reload } as unknown as Location }, reload, store };
}

describe('what counts as a file from the build before', () => {
  it.each([
    [{ name: 'ChunkLoadError', message: 'whatever' }],
    [{ name: 'Error', message: 'Loading chunk 4521 failed.\n(error: https://x/_next/static/chunks/4521.js)' }],
    [{ name: 'Error', message: 'Loading CSS chunk app-layout failed' }],
    [{ name: 'TypeError', message: 'Failed to fetch dynamically imported module: https://x/_next/static/chunks/a.js' }],
  ])('%o', (error) => {
    expect(isStaleBuildError(error)).toBe(true);
  });

  it.each([
    [{ name: 'Error', message: 'تعذّر تحميل الطلب' }],
    [{ name: 'Error', message: 'An error occurred in the Server Components render.' }],
    [{ name: 'TypeError', message: 'Failed to fetch' }],
    [null],
    [undefined],
  ])('and not %o', (error) => {
    expect(isStaleBuildError(error)).toBe(false);
  });
});

describe('the reload happens once', () => {
  const stale = { name: 'ChunkLoadError', message: 'Loading chunk 1 failed.' };

  it('the first stale-file error reloads the page and leaves the mark', () => {
    const { win, reload, store } = fakeWindow();
    expect(reloadOnceForStaleBuild(stale, win, 1_000_000)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(store[STALE_RELOAD_KEY]).toBe('1000000');
  });

  it('a second one, right after the reload, does NOT reload again — the screen is drawn instead', () => {
    const { win, reload } = fakeWindow();
    reloadOnceForStaleBuild(stale, win, 1_000_000);
    expect(reloadOnceForStaleBuild(stale, win, 1_000_000 + 5_000)).toBe(false);
    expect(reloadOnceForStaleBuild(stale, win, 1_000_000 + 60_000)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('the next deploy, long after, gets its own one reload', () => {
    const { win, reload } = fakeWindow({ [STALE_RELOAD_KEY]: '1000000' });
    expect(reloadOnceForStaleBuild(stale, win, 1_000_000 + STALE_RELOAD_WINDOW_MS + 1)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('any other error never reloads', () => {
    const { win, reload, store } = fakeWindow();
    expect(reloadOnceForStaleBuild({ name: 'Error', message: 'boom' }, win)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(store[STALE_RELOAD_KEY]).toBeUndefined();
  });

  it('a storage that refuses means no automatic reload at all — no loop is possible', () => {
    const { win, reload } = fakeWindow({}, { refuse: true });
    expect(reloadOnceForStaleBuild(stale, win)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('and the system error screen is the one that calls it', () => {
    const src = readFileSync(join(process.cwd(), 'src/app/(system)/error.tsx'), 'utf8');
    expect(src).toContain("from '@/lib/stale-build'");
    expect(src).toMatch(/reloadOnceForStaleBuild\(error, window\)/);
  });
});
