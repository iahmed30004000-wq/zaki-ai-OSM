import { promises as fs } from 'node:fs';
import path from 'node:path';
import { LOCAL_STORAGE_DIR, STORAGE_PROVIDER, isSafeStorageKey } from './storage';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * A PICTURE THE SHOP POINTS AT MUST BE A PICTURE THE SERVER HAS.
 *
 * Measured on the live shop «صحة بلس» (4/11): two of its product
 * pictures answered 404 from `/api/public/media` — the row still names
 * the file, the file is not in storage. Each drew as the browser's
 * broken-image icon with the product's name printed over it, on the
 * first screen and down the grid. The card already HAS a designed
 * empty state (the product's initial in a wash of the shop's colour); it
 * was never shown, because the card only knew «there is a link», not
 * «the link leads somewhere».
 *
 * So the shelf asks storage before it hands a link to a card. A file that
 * is not there is a product with no picture, and the card draws its
 * designed empty state instead of a broken one. Nothing stored changes:
 * the row keeps its link, and the day the file comes back the picture
 * does too.
 *
 * ── WHAT IT DOES NOT JUDGE ──
 *
 * - A link that is not one of our own stored files (an outside address, a
 *   seed's placeholder): kept as it was. Only our storage can be asked.
 * - Storage that is not the local disk, or a disk with no `uploads`
 *   folder at all (a test run, a machine that never stored anything):
 *   everything is kept. «I cannot look» is not «it is missing», and a
 *   shop must never lose every picture because the check could not run.
 * ═══════════════════════════════════════════════════════════════════════
 */

const STORED = /^\/api\/media\/(companies\/[0-9a-f-]{36}\/products\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(?:webp|jpe?g|png))$/i;

/** The storage key behind one of our own image links, or null for any other link. */
export function storedKeyOf(url: string | null | undefined): string | null {
  if (typeof url !== 'string') return null;
  const key = url.trim().match(STORED)?.[1] ?? null;
  return key && isSafeStorageKey(key) ? key : null;
}

async function exists(abs: string): Promise<boolean> {
  try {
    await fs.access(abs);
    return true;
  } catch {
    return false;
  }
}

/**
 * The links among `urls` that point at a stored file storage does not
 * have. Everything else — present, foreign, or unjudgeable — is absent
 * from the answer, so a caller drops only what is known to be broken.
 */
export async function missingStoredImages(urls: Iterable<string | null | undefined>): Promise<Set<string>> {
  const missing = new Set<string>();
  if (STORAGE_PROVIDER !== 'local') return missing;

  const byKey = new Map<string, string[]>();
  for (const url of urls) {
    const key = storedKeyOf(url);
    if (!key || !url) continue;
    byKey.set(key, [...(byKey.get(key) ?? []), url]);
  }
  if (byKey.size === 0) return missing;
  if (!(await exists(LOCAL_STORAGE_DIR))) return missing;

  await Promise.all(
    [...byKey].map(async ([key, links]) => {
      if (!(await exists(path.resolve(LOCAL_STORAGE_DIR, key)))) for (const l of links) missing.add(l);
    })
  );
  return missing;
}

/** The first of `candidates` that is not known to be missing — or null when none is left. */
export function firstShown(candidates: (string | null | undefined)[], missing: Set<string>): string | null {
  for (const c of candidates) if (typeof c === 'string' && c && !missing.has(c)) return c;
  return null;
}
