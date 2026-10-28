import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  LOCAL_STORAGE_DIR,
  STORAGE_PROVIDER,
  detectImageType,
  isSafeStorageKey,
} from './storage';

/**
 * THE PAPER BEHIND A COLLECTION.
 *
 * A courier hands over money and the amount goes into a wallet. Until now
 * the only record of WHY that figure is that figure was the number itself
 * and an optional sentence — so a receipt for 1,240 and a receipt for 1,420
 * look equally true a month later, and the only way to settle it is to ring
 * the courier.
 *
 * So the photo of the handover slip, or the bank's transfer PDF, is kept
 * with the row. The owner asked for it in those words: «حط رفع ملف صورة او
 * ملف عشان اتحقق من التحصيل».
 *
 * ── WHY THIS IS A MODULE AND NOT TEN LINES IN THE ROUTE ──
 *
 * Four of the five rules below are the kind that look like one line and are
 * not: what counts as an image, what the file is named when it comes back
 * out, where it is allowed to be written, and whether a PDF may be opened
 * in the tab or must be downloaded. Each one has a way of being wrong that
 * a route-level `if` hides. They are here so they can be TESTED without a
 * database, a request or a logged-in user.
 *
 * WHAT IS REUSED RATHER THAN REWRITTEN: `detectImageType` already sniffs
 * jpeg, png and webp by their magic bytes in `storage.ts`, and
 * `isSafeStorageKey` already decides whether a key escapes the uploads
 * root. Writing a second copy of either is how two answers to one question
 * start. Only the PDF is new here, because nothing else in this product
 * accepts one.
 */

/**
 * FOUR MEGABYTES, AND THE REASON IS THE TRANSPORT, NOT THE DISK.
 *
 * The proof travels in the same JSON body as the receipt — base64, the way
 * the courier's statement already arrives on the route next door — so the
 * receipt and its paper are ONE transaction. A receipt written and a proof
 * that then fails to upload is exactly the state this feature exists to
 * prevent. Base64 costs a third, so 4 MB of photo is about 5.6 MB of body.
 *
 * A phone camera will exceed this; the dialog is where that gets shrunk, so
 * the refusal says the size in megabytes rather than in bytes.
 */
export const MAX_PROOF_BYTES = 4 * 1024 * 1024;

/**
 * NO SVG, AND THAT IS DELIBERATE. An SVG is a document that can carry
 * script, and it would be served from this product's own origin — so it is
 * not «an image» for the purpose of a thing anyone will click. A proof is a
 * photograph or a bank's PDF.
 */
export const ALLOWED_PROOF_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;
export type ProofMime = (typeof ALLOWED_PROOF_MIMES)[number];

const EXT: Record<ProofMime, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

/**
 * WHAT THE FILE ACTUALLY IS — read from the first bytes, never from the
 * name and never from what the browser claimed.
 *
 * A `.jpg` that is really a zip would otherwise be stored and handed back
 * with `Content-Type: image/jpeg`, and the browser would be the one left to
 * work out what it had been given.
 */
export function sniffProof(buffer: Buffer): ProofMime | null {
  const image = detectImageType(buffer);
  if (image && (ALLOWED_PROOF_MIMES as readonly string[]).includes(image)) {
    return image as ProofMime;
  }
  // `%PDF-` at the very start. A viewer will tolerate leading rubbish; a
  // record of a payment should not, because tolerating it is how a file
  // that is two things at once gets in.
  if (buffer.length >= 5 && buffer.toString('ascii', 0, 5) === '%PDF-') return 'application/pdf';
  return null;
}

export interface ProofFacts {
  mime: ProofMime;
  /** SHA-256 of the bytes as stored — a proof swapped later stops matching. */
  hash: string;
  sizeBytes: number;
  /** What the owner called it, or the file's own name if they called it nothing. */
  name: string;
}

/**
 * The hash is the whole reason a stored proof is worth anything.
 *
 * `CourierStatement.fileHash` already does this for the statement file, for
 * the same reason and with the same algorithm: the row remembers the bytes,
 * so a file replaced on disk — by a mistake, a restore or a hand — no
 * longer answers to the row that points at it.
 */
export function proofHash(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * ONE SANITISER, BECAUSE THE NAME IS A HEADER BOUNDARY WHOEVER TYPED IT.
 *
 * The result goes into a `Content-Disposition` header. A name holding a
 * quote, a semicolon, a CR or an LF can end the header's value early or
 * start a header of its own, so none of those survive. Path separators go
 * too: a name is a name, never a route to a directory.
 *
 * It runs on the OWNER'S name as well as on the uploaded one. Not because
 * the owner is suspected — because the sanitiser is what keeps the header
 * well-formed, and a rule that applies to one of two inputs is a rule with
 * a way around it. A name typed by hand can hold a stray quote by accident
 * just as easily.
 *
 * Arabic is KEPT — the owner names things in Arabic and «إيصال أرامكس»
 * must come back called that. It is the header's encoding that carries
 * non-ASCII (`filename*=UTF-8''…`), not a transliteration.
 *
 * Returns the empty string when nothing is left, so the CALLER decides
 * what an empty name means. That distinction is the whole reason this is
 * separate: «the owner typed only spaces» and «the owner typed nothing»
 * have to be told apart, and a function that silently substitutes a
 * fallback cannot tell them apart.
 */
function clean(name: string): string {
  return name
    .split(/[\\/]/)
    .pop()!
    // Control characters first, so a CR cannot survive as whitespace.
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/["';]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // A leading dot makes a hidden file on every unix host.
    .replace(/^\.+/, '')
    .slice(0, 80)
    .trim();
}

/** Puts the extension the BYTES deserve on a cleaned name. */
function withExtension(base: string, mime: ProofMime): string {
  const ext = EXT[mime];
  // A PDF uploaded as `slip.jpg` comes back as `slip.pdf`, and a name the
  // owner typed — «إيصال أرامكس» — gets the extension without being asked
  // to know what it is.
  return new RegExp(`\\.${ext}$`, 'i').test(base)
    ? base
    : `${base.replace(/\.[A-Za-z0-9]{1,8}$/, '')}.${ext}`;
}

export function safeProofName(originalName: string, mime: ProofMime): string {
  const base = clean(originalName);
  return base ? withExtension(base, mime) : `إثبات-التحصيل.${EXT[mime]}`;
}

/**
 * THE OWNER NAMES IT — «لازم أنا اسميه».
 *
 * A phone calls its photos `IMG_20261010_143052.jpg`, and a month later
 * that tells nobody which handover it was. So the dialog offers a name,
 * and what the owner types wins.
 *
 * IT IS OFFERED, NOT DEMANDED. A proof uploaded with no name typed keeps
 * the file's own name, because the alternative is a required field between
 * a person and recording money that has already arrived — and a receipt
 * that cannot be saved is worse than a receipt called `IMG_2026…`.
 *
 * The owner's name does NOT reach the storage path. That is still built
 * from the receipt id; this is only what the file is CALLED when it comes
 * back out.
 */
export function proofName(mime: ProofMime, uploadedName: string, chosenName?: string): string {
  const chosen = clean(chosenName ?? '');
  return chosen ? withExtension(chosen, mime) : safeProofName(uploadedName, mime);
}

/**
 * Reads a proof and says what it is, or refuses in Arabic.
 *
 * It throws rather than returning a result object because every caller has
 * the same answer to a bad file — hand the sentence to the person who
 * chose it. The sentences are written for them, not for a log.
 */
export function describeProof(buffer: Buffer, originalName: string, chosenName?: string): ProofFacts {
  if (buffer.length === 0) throw new Error('الملف فارغ');
  if (buffer.length > MAX_PROOF_BYTES) {
    throw new Error(`حجم الملف يتجاوز الحد المسموح (${Math.round(MAX_PROOF_BYTES / 1024 / 1024)} ميجابايت)`);
  }
  const mime = sniffProof(buffer);
  if (!mime) throw new Error('الملف ليس صورة ولا PDF — المسموح: JPG، PNG، WEBP، PDF');

  return {
    mime,
    hash: proofHash(buffer),
    sizeBytes: buffer.length,
    name: proofName(mime, originalName, chosenName),
  };
}

/**
 * WHERE IT LIVES, and the caller never gets to choose.
 *
 * Tenant-namespaced under `companies/{companyId}/` like every upload in
 * this product, and named after the RECEIPT rather than after the file —
 * so the uploaded name, which came from outside, never reaches a path at
 * all. One proof per receipt by construction: a second upload for the same
 * receipt overwrites, which is what replacing a bad photo should do.
 */
export function proofStorageKey(
  companyId: string,
  statementId: string,
  receiptId: string,
  mime: ProofMime
): string {
  return `companies/${companyId}/settlement/${statementId}/receipts/${receiptId}.${EXT[mime]}`;
}

/**
 * WHERE A REPLACEMENT LIVES — a NEW key, so the paper it replaces stays on disk.
 *
 * `proofStorageKey` is one key per receipt, which is right for the first upload and wrong for a change: a
 * proof swapped before approval would overwrite the very file the audit row has to point at. The revision is
 * chosen by the server (never by the caller) and joins the receipt id, so the key is still built only from
 * ids the server holds and the uploaded name still never reaches a path.
 */
export function revisedProofKey(
  companyId: string,
  statementId: string,
  receiptId: string,
  mime: ProofMime,
  revision: string
): string {
  return `companies/${companyId}/settlement/${statementId}/receipts/${receiptId}-${revision}.${EXT[mime]}`;
}

/**
 * Removes a proof's file when its receipt is gone (an import taken back). Best effort by design: the rows
 * are already deleted, and a file nobody references costs disk, while an error here must not undo the cancel.
 */
export async function removeProofFile(storageKey: string): Promise<void> {
  if (STORAGE_PROVIDER !== 'local' || !isSafeStorageKey(storageKey)) return;
  await fs.promises.rm(path.join(LOCAL_STORAGE_DIR, storageKey), { force: true }).catch(() => undefined);
}

export async function writeProofFile(storageKey: string, buffer: Buffer): Promise<void> {
  if (STORAGE_PROVIDER !== 'local') {
    throw new Error(`STORAGE_PROVIDER=${STORAGE_PROVIDER} غير مُهيأ لرفع إثبات التحصيل`);
  }
  // Belt and braces: the key is built here, but a future caller passing its
  // own must not be able to write outside the uploads root.
  if (!isSafeStorageKey(storageKey)) throw new Error('مسار تخزين غير صالح');
  const abs = path.join(LOCAL_STORAGE_DIR, storageKey);
  await fs.promises.mkdir(path.dirname(abs), { recursive: true });
  await fs.promises.writeFile(abs, buffer);
}

/**
 * A PDF IS OPENED IN A VIEWER THAT RUNS SCRIPT, so it is downloaded.
 *
 * A PDF may carry JavaScript, and served inline from this product's own
 * origin the viewer runs it there. The bytes were chosen by whoever handed
 * over the money, which is not nobody. An image cannot do that, and a
 * person checking a collection wants to SEE the slip, so images stay
 * inline.
 *
 * This is not the only thing standing in the way — `nosniff` and the
 * content type come from the row — but it is the one that decides whether
 * somebody else's file gets to execute on our origin.
 */
export function proofDisposition(mime: ProofMime): 'inline' | 'attachment' {
  return mime === 'application/pdf' ? 'attachment' : 'inline';
}

/**
 * The whole header, built in one place so the quoting cannot drift.
 *
 * `filename` carries an ASCII fallback for anything that cannot read the
 * second form; `filename*` carries the real name, percent-encoded as
 * RFC 5987 asks. Without the fallback an Arabic name arrives as mojibake on
 * older clients; without the starred form it arrives as question marks.
 */
export function proofDispositionHeader(mime: ProofMime, name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || `proof.${EXT[mime]}`;
  return `${proofDisposition(mime)}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
