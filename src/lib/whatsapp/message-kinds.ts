/**
 * EVERY KIND OF WHATSAPP MESSAGE, READ FROM META'S PAYLOAD — pure, no database, no network.
 *
 * Until now only `text` was read and everything else was stored as «[IMAGE]» with nothing in it. This turns one entry of a
 * webhook's `messages[]` into the columns `WhatsAppMessage` keeps (the media id, what Meta said the file is, the caption, the
 * place, the reaction's target, the replied-to message), so the inbox can draw a photo, a voice note, a place or a contact card.
 *
 * WHAT IS KEPT is a SAFE SUBSET, never the payload as it came: strings are cut to a length, numbers must be finite, a contact
 * card keeps a name and its phone numbers and nothing else. A field of the wrong type is dropped, not trusted.
 *
 * Pure on purpose: the server parses with it, and the inbox (a client) reads `KIND_LABEL` from it to name a message kind.
 */

export const MESSAGE_KINDS = [
  'TEXT',
  'IMAGE',
  'AUDIO',
  'VIDEO',
  'DOCUMENT',
  'STICKER',
  'LOCATION',
  'CONTACTS',
  'REACTION',
  'INTERACTIVE',
  'BUTTON',
  'TEMPLATE',
  'UNSUPPORTED',
] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

/** The kinds whose bytes live on Meta's side until fetched. */
export const MEDIA_KINDS = ['IMAGE', 'AUDIO', 'VIDEO', 'DOCUMENT', 'STICKER'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];
export const isMediaKind = (t: string): t is MediaKind => (MEDIA_KINDS as readonly string[]).includes(t);

/** How a kind is named in a list preview when it has no words of its own. */
export const KIND_LABEL: Record<MessageKind, string> = {
  TEXT: 'رسالة',
  IMAGE: 'صورة',
  AUDIO: 'رسالة صوتية',
  VIDEO: 'فيديو',
  DOCUMENT: 'ملف',
  STICKER: 'ملصق',
  LOCATION: 'موقع',
  CONTACTS: 'جهة اتصال',
  REACTION: 'تفاعل',
  INTERACTIVE: 'رد على زر',
  BUTTON: 'رد على زر',
  TEMPLATE: 'قالب',
  UNSUPPORTED: 'رسالة غير مدعومة',
};

export interface ContactCard {
  name: string;
  phones: string[];
}

export interface MessageMeta {
  /** A voice note recorded in WhatsApp (audio.voice), not an audio file sent as one. */
  voice?: boolean;
  /** A place's name and address, when the customer picked a named place. */
  placeName?: string;
  placeAddress?: string;
  contacts?: ContactCard[];
  /** The id of the button or list row pressed (interactive / button replies). */
  replyId?: string;
  animated?: boolean;
}

export interface ParsedInbound {
  messageType: MessageKind;
  text: string | null;
  mediaId: string | null;
  mimeType: string | null;
  fileName: string | null;
  mediaSha256: string | null;
  latitude: number | null;
  longitude: number | null;
  replyToExternalId: string | null;
  reactionToExternalId: string | null;
  meta: MessageMeta | null;
}

const str = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
};
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
/** A mime type as Meta writes it: `audio/ogg; codecs=opus`. Anything else is not kept. */
const mime = (v: unknown): string | null => {
  const s = str(v, 120);
  return s && /^[a-z0-9.+-]+\/[a-z0-9.+-]+(\s*;\s*[a-z0-9=._+-]+)*$/i.test(s) ? s.toLowerCase() : null;
};
/** A file name is a name: no path, no control characters. */
export const cleanFileName = (v: unknown): string | null => {
  const s = str(v, 200);
  if (!s) return null;
  const base = s.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return base || null;
};

const MAX_TEXT = 4096;

const empty = (messageType: MessageKind): ParsedInbound => ({
  messageType,
  text: null,
  mediaId: null,
  mimeType: null,
  fileName: null,
  mediaSha256: null,
  latitude: null,
  longitude: null,
  replyToExternalId: null,
  reactionToExternalId: null,
  meta: null,
});

/** One entry of `value.messages[]` → the columns kept. Never throws. */
export function parseInboundMessage(msg: any): ParsedInbound {
  const type = typeof msg?.type === 'string' ? msg.type : '';
  let out: ParsedInbound;

  switch (type) {
    case 'text':
      out = { ...empty('TEXT'), text: str(msg.text?.body, MAX_TEXT) };
      break;
    case 'image':
    case 'audio':
    case 'video':
    case 'document':
    case 'sticker': {
      const m = msg[type] ?? {};
      const kind = type.toUpperCase() as MediaKind;
      out = {
        ...empty(kind),
        text: kind === 'AUDIO' || kind === 'STICKER' ? null : str(m.caption, 1024),
        mediaId: str(m.id, 128),
        mimeType: mime(m.mime_type),
        fileName: kind === 'DOCUMENT' ? cleanFileName(m.filename) : null,
        mediaSha256: str(m.sha256, 128),
      };
      const meta: MessageMeta = {};
      if (kind === 'AUDIO' && m.voice === true) meta.voice = true;
      if (kind === 'STICKER' && m.animated === true) meta.animated = true;
      out.meta = Object.keys(meta).length ? meta : null;
      break;
    }
    case 'location': {
      const l = msg.location ?? {};
      const lat = num(l.latitude);
      const lng = num(l.longitude);
      const ok = lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
      const meta: MessageMeta = {};
      const name = str(l.name, 200);
      const address = str(l.address, 300);
      if (name) meta.placeName = name;
      if (address) meta.placeAddress = address;
      out = {
        ...empty('LOCATION'),
        latitude: ok ? lat : null,
        longitude: ok ? lng : null,
        text: name ?? address,
        meta: Object.keys(meta).length ? meta : null,
      };
      break;
    }
    case 'contacts': {
      const list = Array.isArray(msg.contacts) ? msg.contacts.slice(0, 10) : [];
      const contacts: ContactCard[] = list
        .map((c: any) => ({
          name: str(c?.name?.formatted_name, 120) ?? str(c?.name?.first_name, 120) ?? '',
          phones: (Array.isArray(c?.phones) ? c.phones : [])
            .slice(0, 5)
            .map((p: any) => str(p?.phone, 40) ?? str(p?.wa_id, 40))
            .filter((p: string | null): p is string => Boolean(p)),
        }))
        .filter((c: ContactCard) => c.name || c.phones.length);
      out = { ...empty('CONTACTS'), text: contacts.map((c) => c.name).filter(Boolean).join('، ') || null, meta: contacts.length ? { contacts } : null };
      break;
    }
    case 'reaction': {
      const r = msg.reaction ?? {};
      // An empty emoji is Meta's «the reaction was removed».
      out = { ...empty('REACTION'), text: str(r.emoji, 16), reactionToExternalId: str(r.message_id, 256) };
      break;
    }
    case 'interactive': {
      const i = msg.interactive ?? {};
      const reply = i.button_reply ?? i.list_reply ?? {};
      const id = str(reply.id, 256);
      out = { ...empty('INTERACTIVE'), text: str(reply.title, 300), meta: id ? { replyId: id } : null };
      break;
    }
    case 'button': {
      const b = msg.button ?? {};
      const id = str(b.payload, 256);
      out = { ...empty('BUTTON'), text: str(b.text, 300), meta: id ? { replyId: id } : null };
      break;
    }
    default:
      // 'unsupported', 'system', 'order', 'unknown', anything new Meta adds: kept as a row the inbox can name.
      out = empty('UNSUPPORTED');
  }

  const ctx = str(msg?.context?.id, 256);
  if (ctx && out.messageType !== 'REACTION') out.replyToExternalId = ctx;
  return out;
}

/** The list preview: the words when there are any, else the kind's name — with an emoji for a reaction. */
export function previewOf(messageType: string, text: string | null, meta?: MessageMeta | null): string {
  const kind = (MESSAGE_KINDS as readonly string[]).includes(messageType) ? (messageType as MessageKind) : 'UNSUPPORTED';
  if (kind === 'TEXT' || kind === 'TEMPLATE' || kind === 'INTERACTIVE' || kind === 'BUTTON') {
    return (text || KIND_LABEL[kind]).slice(0, 120);
  }
  if (kind === 'REACTION') return `${KIND_LABEL.REACTION} ${text ?? ''}`.trim().slice(0, 120);
  if (kind === 'AUDIO' && meta?.voice) return KIND_LABEL.AUDIO;
  return (text ? `${KIND_LABEL[kind]}: ${text}` : KIND_LABEL[kind]).slice(0, 120);
}
