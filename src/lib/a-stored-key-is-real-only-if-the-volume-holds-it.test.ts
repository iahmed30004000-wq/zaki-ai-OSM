import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `storedFileExists` — «A KEY OF OURS» COMES TO «THE VOLUME HOLDS THE FILE».
 *
 * Nothing but `saveProductImage` makes a key (a random uuid in a company's own folder), so a key that names no file was
 * typed by hand, mistyped, or carried over from another install. The wallet's PATCH door asks this before it writes a key
 * onto a wallet. It reads no byte and opens no stream, and a key that is not safe is no key at all — it is not even looked up.
 */

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.unstubAllEnvs();
});

const KEY = 'companies/co-1/products/w-1/0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d.webp';

describe('storedFileExists', () => {
  it('is true for a key whose file is on the volume, asked at its place under the uploads folder', async () => {
    const stat = vi.spyOn(fs.promises, 'stat').mockResolvedValue({ isFile: () => true } as fs.Stats);
    const { storedFileExists, LOCAL_STORAGE_DIR } = await import('./storage');
    expect(await storedFileExists(KEY)).toBe(true);
    expect(stat).toHaveBeenCalledWith(path.resolve(LOCAL_STORAGE_DIR, KEY));
  });

  it('is false for a key whose file is not there', async () => {
    vi.spyOn(fs.promises, 'stat').mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    const { storedFileExists } = await import('./storage');
    expect(await storedFileExists(KEY)).toBe(false);
  });

  it('is false for a folder — a key names a file', async () => {
    vi.spyOn(fs.promises, 'stat').mockResolvedValue({ isFile: () => false } as fs.Stats);
    const { storedFileExists } = await import('./storage');
    expect(await storedFileExists('companies/co-1/products/w-1')).toBe(false);
  });

  it('NEGATIVE: a key that is not safe (dot segments, a backslash, an empty segment) is never looked up', async () => {
    const stat = vi.spyOn(fs.promises, 'stat').mockResolvedValue({ isFile: () => true } as fs.Stats);
    const { storedFileExists } = await import('./storage');
    for (const bad of ['', '../x.webp', 'companies/../../etc/passwd', 'companies/co-1/./x.webp', 'companies\\co-1\\x.webp', 'companies//x.webp', '/etc/passwd']) {
      expect(await storedFileExists(bad), bad).toBe(false);
    }
    expect(stat).not.toHaveBeenCalled();
  });

  it('NEGATIVE: with any storage other than the local volume there is nothing to confirm, so nothing is', async () => {
    vi.stubEnv('STORAGE_PROVIDER', 's3');
    vi.resetModules();
    const stat = vi.spyOn(fs.promises, 'stat').mockResolvedValue({ isFile: () => true } as fs.Stats);
    const { storedFileExists } = await import('./storage');
    expect(await storedFileExists(KEY)).toBe(false);
    expect(stat).not.toHaveBeenCalled();
  });
});
