import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fontStorageKey, writeFontFile } from './store-fonts';

/**
 * The font writer joined whatever key it was given onto the uploads folder.
 * Today its one caller builds the key from ids and a slug, so nothing escapes
 * — but every other door that touches that folder asks `isSafeStorageKey`
 * first, and this one is the only writer that did not (SF-RV68).
 */

afterEach(() => vi.restoreAllMocks());

const bytes = Buffer.from('x');

describe('writeFontFile', () => {
  it.each([
    '../outside.woff2',
    'companies/c1/../../outside.woff2',
    'companies\\c1\\x.woff2',
    '/absolute.woff2',
    'companies/c1/.hidden/x.woff2',
    '',
  ])('refuses %j and writes nothing', async (key) => {
    const mk = vi.spyOn(fs.promises, 'mkdir').mockResolvedValue(undefined);
    const wr = vi.spyOn(fs.promises, 'writeFile').mockResolvedValue(undefined);
    await expect(writeFontFile(key, bytes)).rejects.toThrow('مسار تخزين غير صالح');
    expect(mk).not.toHaveBeenCalled();
    expect(wr).not.toHaveBeenCalled();
  });

  it('still writes the key the upload door builds', async () => {
    const mk = vi.spyOn(fs.promises, 'mkdir').mockResolvedValue(undefined);
    const wr = vi.spyOn(fs.promises, 'writeFile').mockResolvedValue(undefined);
    await writeFontFile(fontStorageKey('c1', 's1', 'cairo', 400, false, 'woff2'), bytes);
    expect(mk).toHaveBeenCalledTimes(1);
    expect(wr).toHaveBeenCalledTimes(1);
  });
});
