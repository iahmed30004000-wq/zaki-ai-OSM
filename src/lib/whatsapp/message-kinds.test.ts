import { describe, expect, it } from 'vitest';
import { parseInboundMessage, previewOf } from './message-kinds';

/**
 * EVERY KIND META SENDS IS READ, NOT JUST TEXT.
 *
 * The payloads below are Meta's documented webhook shapes (Cloud API, `messages[]`), trimmed to what is read. Each test pins
 * what is KEPT — and that what is kept is a safe subset: wrong types dropped, names stripped of paths, coordinates finite.
 */

const base = { from: '962790000000', id: 'wamid.X', timestamp: '1764150000' };

describe('parseInboundMessage', () => {
  it('text: the body', () => {
    const p = parseInboundMessage({ ...base, type: 'text', text: { body: 'مرحبا 👋' } });
    expect(p).toMatchObject({ messageType: 'TEXT', text: 'مرحبا 👋', mediaId: null });
  });

  it('image: media id, mime, sha256 and the caption', () => {
    const p = parseInboundMessage({
      ...base,
      type: 'image',
      image: { id: '1234567890', mime_type: 'image/jpeg', sha256: 'abc', caption: 'هذا المقاس؟' },
    });
    expect(p).toMatchObject({ messageType: 'IMAGE', mediaId: '1234567890', mimeType: 'image/jpeg', mediaSha256: 'abc', text: 'هذا المقاس؟', fileName: null });
  });

  it('voice note: audio with voice=true is marked as a voice note, and has no caption', () => {
    const p = parseInboundMessage({ ...base, type: 'audio', audio: { id: '55', mime_type: 'audio/ogg; codecs=opus', voice: true } });
    expect(p).toMatchObject({ messageType: 'AUDIO', mediaId: '55', mimeType: 'audio/ogg; codecs=opus', text: null, meta: { voice: true } });
  });

  it('an audio FILE (voice absent) is not a voice note', () => {
    expect(parseInboundMessage({ ...base, type: 'audio', audio: { id: '56', mime_type: 'audio/mpeg' } }).meta).toBeNull();
  });

  it('video: id, mime and caption', () => {
    expect(parseInboundMessage({ ...base, type: 'video', video: { id: '9', mime_type: 'video/mp4', caption: 'شوف' } })).toMatchObject({
      messageType: 'VIDEO',
      mediaId: '9',
      text: 'شوف',
    });
  });

  it('document: the file name, stripped of any path and control character', () => {
    const p = parseInboundMessage({
      ...base,
      type: 'document',
      document: { id: '77', mime_type: 'application/pdf', filename: '..\\..\\etc/فاتورة\u0007.pdf', caption: 'الفاتورة' },
    });
    expect(p).toMatchObject({ messageType: 'DOCUMENT', mediaId: '77', fileName: 'فاتورة.pdf', text: 'الفاتورة' });
  });

  it('sticker: webp, animated flag, no caption', () => {
    expect(parseInboundMessage({ ...base, type: 'sticker', sticker: { id: '8', mime_type: 'image/webp', animated: true } })).toMatchObject({
      messageType: 'STICKER',
      mediaId: '8',
      meta: { animated: true },
      text: null,
    });
  });

  it('location: coordinates, the place name and address', () => {
    const p = parseInboundMessage({ ...base, type: 'location', location: { latitude: 31.95, longitude: 35.91, name: 'دوار الداخلية', address: 'عمّان' } });
    expect(p).toMatchObject({ messageType: 'LOCATION', latitude: 31.95, longitude: 35.91, text: 'دوار الداخلية', meta: { placeName: 'دوار الداخلية', placeAddress: 'عمّان' } });
  });

  it('location: coordinates out of range are not kept', () => {
    const p = parseInboundMessage({ ...base, type: 'location', location: { latitude: 500, longitude: 'x' } });
    expect(p.latitude).toBeNull();
    expect(p.longitude).toBeNull();
  });

  it('contacts: a name and phone numbers per card, nothing else', () => {
    const p = parseInboundMessage({
      ...base,
      type: 'contacts',
      contacts: [{ name: { formatted_name: 'أبو أحمد' }, phones: [{ phone: '+962 79 111 2222', wa_id: '962791112222' }], emails: [{ email: 'x@y' }] }],
    });
    expect(p.messageType).toBe('CONTACTS');
    expect(p.meta).toEqual({ contacts: [{ name: 'أبو أحمد', phones: ['+962 79 111 2222'] }] });
    expect(p.text).toBe('أبو أحمد');
  });

  it('reaction: the emoji and the message it marks; an empty emoji (removed) keeps no text', () => {
    expect(parseInboundMessage({ ...base, type: 'reaction', reaction: { message_id: 'wamid.T', emoji: '❤️' } })).toMatchObject({
      messageType: 'REACTION',
      text: '❤️',
      reactionToExternalId: 'wamid.T',
    });
    expect(parseInboundMessage({ ...base, type: 'reaction', reaction: { message_id: 'wamid.T', emoji: '' } }).text).toBeNull();
  });

  it('interactive button and list replies, and template quick-reply buttons', () => {
    expect(parseInboundMessage({ ...base, type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'yes', title: 'نعم أكّد' } } })).toMatchObject({
      messageType: 'INTERACTIVE',
      text: 'نعم أكّد',
      meta: { replyId: 'yes' },
    });
    expect(parseInboundMessage({ ...base, type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'r2', title: 'أحمر' } } }).text).toBe('أحمر');
    expect(parseInboundMessage({ ...base, type: 'button', button: { payload: 'CONFIRM', text: 'تأكيد' } })).toMatchObject({
      messageType: 'BUTTON',
      text: 'تأكيد',
      meta: { replyId: 'CONFIRM' },
    });
  });

  it('a reply keeps the id of the message it answers', () => {
    expect(parseInboundMessage({ ...base, type: 'text', text: { body: 'نعم' }, context: { from: 'x', id: 'wamid.ORIG' } }).replyToExternalId).toBe('wamid.ORIG');
  });

  it('anything else is UNSUPPORTED, never thrown on', () => {
    expect(parseInboundMessage({ ...base, type: 'unsupported', errors: [{ code: 131051 }] }).messageType).toBe('UNSUPPORTED');
    expect(parseInboundMessage(null).messageType).toBe('UNSUPPORTED');
    expect(parseInboundMessage({ type: 'image', image: { id: 42, mime_type: '<script>' } })).toMatchObject({ mediaId: null, mimeType: null });
  });
});

describe('previewOf — the list line', () => {
  it('names the kind when there are no words, and leads with it when there is a caption', () => {
    expect(previewOf('TEXT', 'أهلا')).toBe('أهلا');
    expect(previewOf('IMAGE', null)).toBe('صورة');
    expect(previewOf('IMAGE', 'المقاس')).toBe('صورة: المقاس');
    expect(previewOf('AUDIO', null, { voice: true })).toBe('رسالة صوتية');
    expect(previewOf('REACTION', '👍')).toBe('تفاعل 👍');
    expect(previewOf('LOCATION', null)).toBe('موقع');
    expect(previewOf('SOMETHING_NEW', null)).toBe('رسالة غير مدعومة');
  });
});
