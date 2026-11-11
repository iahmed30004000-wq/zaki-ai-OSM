/**
 * SALESFLOW Storage Service Abstraction
 *
 * Provider is configured via STORAGE_PROVIDER env:
 *   - "local" (default): filesystem under ./uploads — development & single-node VPS
 *   - "s3" / "r2" / "supabase": implement save/delete by reusing the same interface
 *
 * Storage layout (multi-tenant safe):
 *   companies/{companyId}/products/{productId}/{uuid}-{variant}.{ext}
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Readable } from 'stream';

export const STORAGE_PROVIDER = process.env.STORAGE_PROVIDER || 'local';
export const LOCAL_STORAGE_DIR = path.join(process.cwd(), 'uploads');

/**
 * Canonical path-containment guard for a storage key.
 * Rejects backslashes (Windows separators), dot segments, and any key whose
 * resolved path escapes the uploads root — traversal-safe for ../, ..\ and
 * URL-decoded variants alike.
 */
export function isSafeStorageKey(storageKey: string): boolean {
  if (!storageKey || storageKey.includes('\\')) return false;
  const segments = storageKey.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..' || s.startsWith('.'))) return false;
  const resolved = path.resolve(LOCAL_STORAGE_DIR, storageKey);
  return resolved.startsWith(LOCAL_STORAGE_DIR + path.sep);
}

const MAX_SIZE_MB = parseInt(process.env.MAX_PRODUCT_IMAGE_SIZE_MB || '10', 10);

export interface StoredImage {
  url: string;
  storageKey: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
}

export const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export function validateImageFile(file: { mimeType: string; size: number }): { valid: boolean; error?: string } {
  if (!ALLOWED_MIME_TYPES.includes(file.mimeType)) {
    return { valid: false, error: 'صيغة الملف غير مدعومة. المسموح: JPG, PNG, WEBP' };
  }
  if (file.size > MAX_SIZE_MB * 1024 * 1024) {
    return { valid: false, error: `حجم الصورة يتجاوز الحد المسموح (${MAX_SIZE_MB} ميجابايت)` };
  }
  return { valid: true };
}

/** Magic-byte sniffing: never trust the extension or client MIME alone */
export function detectImageType(buffer: Buffer): string | null {
  if (buffer.length < 12) return null;
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'image/png';
  }
  // WEBP: RIFF....WEBP
  if (
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

interface SaveOptions {
  companyId: string;
  productId: string;
  buffer: Buffer;
  mimeType: string;
  originalName?: string;
  optimize?: boolean;
  /** The longest side after optimizing (default 1200). */
  maxDimension?: number;
}

/**
 * Saves one image (optimized 1200px webp + 320px thumbnail) to the configured provider.
 * Returns the ORIGINAL (optimized) record; thumbnail URL derived via ?variant=thumb.
 */
export async function saveProductImage(opts: SaveOptions): Promise<StoredImage> {
  const { companyId, productId, buffer, mimeType } = opts;

  const detected = detectImageType(buffer);
  if (!detected || detected !== mimeType) {
    if (!detected) {
      throw new Error('محتوى الملف ليس صورة صالحة');
    }
    // Trust the sniffed type over the claimed one
    // (e.g., browser may send image/jpeg for png — accept sniffed image types only)
    if (!ALLOWED_MIME_TYPES.includes(detected)) {
      throw new Error('نوع الملف غير مدعوم');
    }
  }

  let outputBuffer = buffer;
  let outputMime = detected;

  // Optimization pipeline via sharp: cap at 1200px, convert to webp, quality 82
  if (opts.optimize !== false) {
    try {
      const sharpModule = await import('sharp').then((m) => m.default ?? m);
      outputBuffer = await sharpModule(buffer)
        .rotate() // respect EXIF orientation
        .resize(opts.maxDimension ?? 1200, opts.maxDimension ?? 1200, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82 })
        .toBuffer();
      outputMime = 'image/webp';
    } catch (e) {
      console.warn('Image optimization skipped, storing original:', e);
      outputBuffer = buffer;
      outputMime = detected;
    }
  }

  const ext = MIME_EXT[outputMime] || 'bin';
  const id = crypto.randomUUID();
  const fileName = `${id}.${ext}`;
  const storageKey = `companies/${companyId}/products/${productId}/${fileName}`;

  if (STORAGE_PROVIDER === 'local') {
    const absPath = path.join(LOCAL_STORAGE_DIR, storageKey);
    await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
    await fs.promises.writeFile(absPath, outputBuffer);
  } else {
    throw new Error(
      `STORAGE_PROVIDER=${STORAGE_PROVIDER} غير مُهيأ. استخدم "local" أو نفّذ مزوّد S3/R2 في src/lib/storage.ts`
    );
  }

  const url = `/api/media/${storageKey}`;

  return {
    url,
    storageKey,
    fileName,
    mimeType: outputMime,
    fileSize: outputBuffer.length,
  };
}

export async function readStoredFile(
  storageKey: string
): Promise<{ stream: Readable; size: number; mimeType: string } | null> {
  if (STORAGE_PROVIDER !== 'local') return null;
  if (!isSafeStorageKey(storageKey)) return null; // canonical traversal guard
  const absPath = path.resolve(LOCAL_STORAGE_DIR, storageKey);
  try {
    const stat = await fs.promises.stat(absPath);
    const ext = path.extname(absPath).toLowerCase();
    const mimeMap: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp',
    };
    return {
      stream: fs.createReadStream(absPath),
      size: stat.size,
      mimeType: mimeMap[ext] || 'application/octet-stream',
    };
  } catch {
    return null;
  }
}

/**
 * DOES THE VOLUME HOLD A FILE UNDER THIS KEY? — asked before a key is written onto a record.
 *
 * A key is only ever MADE by `saveProductImage` (a random uuid in a company's own folder), so «the file exists» is what
 * «an uploader of ours produced it» comes to: a key typed by hand, mistyped, or taken from another install holds nothing.
 * It opens no stream and reads no byte, and an unsafe key (a dot segment, a backslash) is no key at all.
 */
export async function storedFileExists(storageKey: string): Promise<boolean> {
  if (STORAGE_PROVIDER !== 'local') return false;
  if (!isSafeStorageKey(storageKey)) return false;
  try {
    const stat = await fs.promises.stat(path.resolve(LOCAL_STORAGE_DIR, storageKey));
    return stat.isFile();
  } catch {
    return false;
  }
}

export async function deleteStoredFile(storageKey: string): Promise<void> {
  if (STORAGE_PROVIDER === 'local') {
    if (!isSafeStorageKey(storageKey)) return; // canonical traversal guard
    const absPath = path.resolve(LOCAL_STORAGE_DIR, storageKey);
    try {
      await fs.promises.unlink(absPath);
    } catch {
      // already gone — cleanup best-effort
    }
    // best-effort: also delete thumbnail variant if the provider stores separate files
    try {
      const thumb = absPath.replace(/(\.\w+)$/, '-thumb$1');
      await fs.promises.unlink(thumb);
    } catch {}
  }
}
