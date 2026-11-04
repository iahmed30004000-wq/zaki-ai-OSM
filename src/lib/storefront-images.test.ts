import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A PICTURE THE SHOP POINTS AT MUST BE A PICTURE THE SERVER HAS.
 *
 * The live shop «صحة بلس» (4/11) drew broken-image icons: rows naming
 * files storage did not have. These hold the three answers the check may
 * give — missing, present, cannot judge — on a real folder, not a mock of
 * `fs`, because the bug was about a real disk.
 */

const root = mkdtempSync(join(tmpdir(), 'sf-img-'));
const storage = { dir: join(root, 'uploads'), provider: 'local' };

vi.mock('./storage', async (orig) => {
  const real = await orig<typeof import('./storage')>();
  return {
    ...real,
    get LOCAL_STORAGE_DIR() { return storage.dir; },
    get STORAGE_PROVIDER() { return storage.provider; },
    // The real guard, against the test's folder.
    isSafeStorageKey: (k: string) => !k.includes('..') && !k.startsWith('/'),
  };
});

const { firstShown, missingStoredImages, storedKeyOf } = await import('./storefront-images');

const CO = '11111111-1111-4111-8111-111111111111';
const PR = '22222222-2222-4222-8222-222222222222';
const HAVE = `33333333-3333-4333-8333-333333333333.webp`;
const GONE = `44444444-4444-4444-8444-444444444444.webp`;
const url = (file: string) => `/api/media/companies/${CO}/products/${PR}/${file}`;

beforeAll(() => {
  mkdirSync(join(storage.dir, 'companies', CO, 'products', PR), { recursive: true });
  writeFileSync(join(storage.dir, 'companies', CO, 'products', PR, HAVE), 'x');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('the shelf asks storage before it hands a picture to a card', () => {
  it('— a file storage does not have is reported missing; one it has is not', async () => {
    const missing = await missingStoredImages([url(HAVE), url(GONE)]);
    expect([...missing]).toEqual([url(GONE)]);
  });

  it('and a link that is not one of our stored files is never judged', async () => {
    const outside = ['https://cdn.example.com/a.webp', '/seed/hoodie.webp', null, undefined, ''];
    expect((await missingStoredImages(outside)).size).toBe(0);
    expect(storedKeyOf('https://cdn.example.com/a.webp')).toBeNull();
  });

  it('and with no uploads folder at all, nothing is dropped — «cannot look» is not «missing»', async () => {
    const was = storage.dir;
    storage.dir = join(root, 'no-such-folder');
    try {
      expect((await missingStoredImages([url(GONE)])).size).toBe(0);
    } finally {
      storage.dir = was;
    }
  });

  it('and storage that is not the local disk is not judged either', async () => {
    storage.provider = 's3';
    try {
      expect((await missingStoredImages([url(GONE)])).size).toBe(0);
    } finally {
      storage.provider = 'local';
    }
  });

  it('and the main picture falls back to the next one the product has, then to none', async () => {
    const missing = await missingStoredImages([url(GONE), url(HAVE)]);
    expect(firstShown([url(GONE), url(HAVE)], missing)).toBe(url(HAVE));
    expect(firstShown([url(GONE), null], missing)).toBeNull();
  });
});
