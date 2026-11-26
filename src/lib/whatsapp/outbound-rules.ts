/**
 * WHAT A STAFF UPLOAD MAY BE — pure, shared by the composer (its `accept=` and an early size check) and the server (which
 * decides: `validateOutboundFile` in `media.ts` sniffs the bytes and applies these same limits).
 */
export type OutboundMediaKind = 'image' | 'document' | 'audio' | 'video';

const MB = 1024 * 1024;

/**
 * Meta's limits per kind (image 5 MB, the rest 16 MB or more), capped at 9 MB for the rest: a staff upload passes through the
 * app's proxy, which buffers request bodies up to 10 MB by default (`proxyClientMaxBodySize`) — a larger body would arrive cut.
 */
export const OUTBOUND_UPLOAD_MAX = 9 * MB;
export const OUTBOUND_LIMITS: Record<OutboundMediaKind, number> = {
  image: 5 * MB,
  audio: OUTBOUND_UPLOAD_MAX,
  video: OUTBOUND_UPLOAD_MAX,
  document: OUTBOUND_UPLOAD_MAX,
};

export const OUTBOUND_MIMES: Record<OutboundMediaKind, readonly string[]> = {
  image: ['image/jpeg', 'image/png'],
  audio: ['audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/amr'],
  video: ['video/mp4', 'video/3gpp'],
  document: [
    'application/pdf',
    'text/plain',
    'application/msword',
    'application/vnd.ms-excel',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ],
};

/** What the composer's two file pickers offer. */
export const ACCEPT_IMAGE = OUTBOUND_MIMES.image.join(',');
export const ACCEPT_FILE = [...OUTBOUND_MIMES.document, ...OUTBOUND_MIMES.audio, ...OUTBOUND_MIMES.video, ...OUTBOUND_MIMES.image].join(',');

export const TOO_BIG_MESSAGE = 'حجم الملف يتجاوز الحد المسموح (9 ميجابايت، والصورة 5)';
