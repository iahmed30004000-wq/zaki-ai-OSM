// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { MessageBubble, isEmojiOnly } from './MessageBubble';
import { ThreadView } from './ThreadView';
import { Composer } from './Composer';
import { dayLabel, initials, latestStamp, listTime, mergeMessages, reactionsByTarget, type WaMessage } from './chat-model';

/**
 * THE THREAD DRAWS EVERY KIND META SENDS.
 *
 * Each kind renders as itself: a photo that opens large, a voice note with play and its bar, a video, a file with its download,
 * a place that opens the map, a contact card, a sticker, a button the customer pressed, a reply's quote, reactions under the
 * message they mark, and the ticks of ours. The media addresses are the inbox's own authenticated door, never Meta's.
 */

afterEach(cleanup);

const at = '2026-11-26T10:15:00.000Z';
const msg = (over: Partial<WaMessage>): WaMessage => ({
  id: 'm1',
  direction: 'INBOUND',
  messageType: 'TEXT',
  text: null,
  status: 'RECEIVED',
  createdAt: at,
  updatedAt: at,
  ...over,
});
const media = (over: Partial<NonNullable<WaMessage['media']>> = {}) => ({
  url: '/api/whatsapp/messages/m1/media',
  mimeType: 'image/jpeg',
  fileName: null,
  size: 2048,
  state: 'READY' as const,
  voice: false,
  ...over,
});
const noop = () => {};

describe('each kind is drawn as itself', () => {
  it('text, with the words as sent', () => {
    render(<MessageBubble message={msg({ text: 'مرحبا، بدي أسأل عن المقاس' })} onOpenImage={noop} />);
    expect(screen.getByText('مرحبا، بدي أسأل عن المقاس')).toBeTruthy();
  });

  it('a photo: a thumbnail from our own door, its caption, and a press opens it large', () => {
    const open = vi.fn();
    render(<MessageBubble message={msg({ messageType: 'IMAGE', text: 'هذا اللون', media: media() })} onOpenImage={open} />);
    const img = screen.getByRole('img', { name: 'هذا اللون' }) as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('/api/whatsapp/messages/m1/media');
    expect(screen.getAllByText('هذا اللون').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('link', { name: 'فتح الصورة' }));
    expect(open).toHaveBeenCalledWith('/api/whatsapp/messages/m1/media', 'هذا اللون');
  });

  it('a voice note: a play press, a seek bar and a speed press; the sound is not fetched before play', () => {
    const { container } = render(<MessageBubble message={msg({ messageType: 'AUDIO', media: media({ mimeType: 'audio/ogg', voice: true }) })} onOpenImage={noop} />);
    expect(screen.getByRole('button', { name: 'تشغيل الرسالة الصوتية' })).toBeTruthy();
    expect(screen.getByRole('slider', { name: 'موضع التشغيل' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /سرعة التشغيل/ })).toBeTruthy();
    const audio = container.querySelector('audio')!;
    expect(audio.getAttribute('src')).toBe('/api/whatsapp/messages/m1/media');
    expect(audio.getAttribute('preload')).toBe('none');
  });

  it('a video plays in place, with controls', () => {
    const { container } = render(<MessageBubble message={msg({ messageType: 'VIDEO', media: media({ mimeType: 'video/mp4' }) })} onOpenImage={noop} />);
    const v = container.querySelector('video')!;
    expect(v.hasAttribute('controls')).toBe(true);
    expect(v.getAttribute('src')).toBe('/api/whatsapp/messages/m1/media');
  });

  it('a file: its name, type and size, and a download press', () => {
    render(<MessageBubble message={msg({ messageType: 'DOCUMENT', media: media({ mimeType: 'application/pdf', fileName: 'فاتورة.pdf', size: 3 * 1024 * 1024 }) })} onOpenImage={noop} />);
    expect(screen.getByText('فاتورة.pdf')).toBeTruthy();
    expect(screen.getByText('PDF · 3.0 م.ب')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'تنزيل الملف' }).getAttribute('href')).toBe('/api/whatsapp/messages/m1/media?download=1');
  });

  it('a place opens the map in a new tab', () => {
    render(<MessageBubble message={msg({ messageType: 'LOCATION', location: { latitude: 31.95, longitude: 35.91, name: 'دوار الداخلية', address: null } })} onOpenImage={noop} />);
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('https://www.google.com/maps?q=31.95,35.91');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(screen.getByText('دوار الداخلية')).toBeTruthy();
  });

  it('a contact card: the name and its numbers', () => {
    render(<MessageBubble message={msg({ messageType: 'CONTACTS', contacts: [{ name: 'أبو أحمد', phones: ['+962 79 111 2222'] }] })} onOpenImage={noop} />);
    expect(screen.getByText('أبو أحمد')).toBeTruthy();
    expect(screen.getByText('+962 79 111 2222')).toBeTruthy();
  });

  it('a sticker is drawn bare, without a bubble', () => {
    render(<MessageBubble message={msg({ messageType: 'STICKER', media: media({ mimeType: 'image/webp' }) })} onOpenImage={noop} />);
    // Sized inline (128 px), not by a utility: the shared stylesheet is on a budget.
    expect((screen.getByRole('img', { name: 'ملصق' }) as HTMLImageElement).style.width).toBe('128px');
  });

  it('a button the customer pressed says so', () => {
    render(<MessageBubble message={msg({ messageType: 'INTERACTIVE', text: 'نعم أكّد الطلب' })} onOpenImage={noop} />);
    expect(screen.getByText('رد على زر')).toBeTruthy();
    expect(screen.getByText('نعم أكّد الطلب')).toBeTruthy();
  });

  it('an unsupported message is named, not left blank', () => {
    render(<MessageBubble message={msg({ messageType: 'UNSUPPORTED' })} onOpenImage={noop} />);
    expect(screen.getByText(/رسالة لا يعرضها واتساب للأعمال/)).toBeTruthy();
  });

  it('a file larger than we keep says so instead of a broken picture', () => {
    render(<MessageBubble message={msg({ messageType: 'IMAGE', media: media({ state: 'TOO_LARGE' }) })} onOpenImage={noop} />);
    expect(screen.getByText('الملف أكبر من الحد الذي نحفظه')).toBeTruthy();
  });

  it('a reply quotes the message it answers', () => {
    render(<MessageBubble message={msg({ text: 'نعم', replyTo: { id: 'm0', direction: 'OUTBOUND', messageType: 'TEXT', text: 'بتأكد الطلب؟' } })} onOpenImage={noop} />);
    expect(screen.getByText('أنت')).toBeTruthy();
    expect(screen.getByText('بتأكد الطلب؟')).toBeTruthy();
  });

  it('a few emojis alone are drawn large', () => {
    expect(isEmojiOnly('😂😂')).toBe(true);
    expect(isEmojiOnly('❤️')).toBe(true);
    expect(isEmojiOnly('تمام 👍')).toBe(false);
    expect(isEmojiOnly('😀😀😀😀')).toBe(false);
  });
});

describe('our messages carry their ticks', () => {
  it.each([
    ['SENT', 'أُرسلت'],
    ['DELIVERED', 'وصلت'],
    ['READ', 'قُرئت'],
    ['FAILED', 'لم تُرسل: Re-engagement message'],
  ])('%s', (status, name) => {
    render(<MessageBubble message={msg({ direction: 'OUTBOUND', text: 'أهلا', status, statusError: status === 'FAILED' ? 'Re-engagement message' : null })} onOpenImage={noop} />);
    expect(screen.getByRole('img', { name })).toBeTruthy();
  });

  it('a read tick is in WhatsApp’s blue, a delivered one is not', () => {
    render(<MessageBubble message={msg({ direction: 'OUTBOUND', text: 'x', status: 'READ' })} onOpenImage={noop} />);
    expect(screen.getByRole('img', { name: 'قُرئت' }).getAttribute('class')).toContain('wa-tick-read');
    cleanup();
    render(<MessageBubble message={msg({ direction: 'OUTBOUND', text: 'x', status: 'DELIVERED' })} onOpenImage={noop} />);
    expect(screen.getByRole('img', { name: 'وصلت' }).getAttribute('class')).not.toContain('wa-tick-read');
  });

  it('a line the order bot wrote carries its name; one a person wrote does not', () => {
    render(<MessageBubble message={msg({ direction: 'OUTBOUND', text: 'أهلين', status: 'SENT', byBot: true })} onOpenImage={noop} botName="سارة" />);
    expect(screen.getByText('سارة')).toBeTruthy();
    cleanup();
    render(<MessageBubble message={msg({ direction: 'OUTBOUND', text: 'أهلين', status: 'SENT' })} onOpenImage={noop} botName="سارة" />);
    expect(screen.queryByText('سارة')).toBeNull();
  });
});

describe('the thread', () => {
  const thread: WaMessage[] = [
    msg({ id: 'a', text: 'أمس', createdAt: '2026-11-25T09:00:00.000Z' }),
    msg({ id: 'b', direction: 'OUTBOUND', text: 'اليوم', status: 'READ', createdAt: '2026-11-26T09:00:00.000Z' }),
    msg({ id: 'r1', messageType: 'REACTION', text: '❤️', reactionToId: 'b', createdAt: '2026-11-26T09:01:00.000Z' }),
  ];

  it('day separators, and a reaction sits under its message instead of being a message', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-26T12:00:00.000Z'));
    render(<ThreadView messages={thread} hasOlder={false} loadingOlder={false} onLoadOlder={noop} />);
    expect(screen.getAllByRole('separator')).toHaveLength(2);
    expect(screen.getByRole('img', { name: 'تفاعل الزبون ❤️' })).toBeTruthy();
    expect(document.querySelectorAll('[data-message-id]')).toHaveLength(2);
    vi.useRealTimers();
  });

  it('«عرض الرسائل الأقدم» when there is more, and it asks', () => {
    const more = vi.fn();
    render(<ThreadView messages={thread} hasOlder loadingOlder={false} onLoadOlder={more} />);
    fireEvent.click(screen.getByRole('button', { name: 'عرض الرسائل الأقدم' }));
    expect(more).toHaveBeenCalled();
  });

  it('a reaction press offers six emojis and sends the chosen one for that message', () => {
    const onReact = vi.fn();
    render(<ThreadView messages={thread} hasOlder={false} loadingOlder={false} onLoadOlder={noop} onReact={onReact} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'تفاعل مع الرسالة' })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'تفاعل 👍' }));
    expect(onReact).toHaveBeenCalledWith('a', '👍');
  });

  it('a photo opens in the lightbox', async () => {
    render(<ThreadView messages={[msg({ id: 'p', messageType: 'IMAGE', text: 'شوف', media: media({ url: '/api/whatsapp/messages/p/media' }) })]} hasOlder={false} loadingOlder={false} onLoadOlder={noop} />);
    fireEvent.click(screen.getByRole('link', { name: 'فتح الصورة' }));
    await screen.findByRole('dialog');
    expect(screen.getByText('تنزيل الصورة')).toBeTruthy();
  });
});

describe('the composer', () => {
  function Harness(props: Partial<React.ComponentProps<typeof Composer>>) {
    const [v, setV] = React.useState('');
    return <Composer value={v} onChange={setV} onSend={noop} onSendFile={async () => true} sending={false} onRefuse={noop} {...props} />;
  }

  it('the emoji panel loads on first press and inserts at the caret', async () => {
    render(<Harness />);
    const box = screen.getByPlaceholderText('اكتب رسالة...') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'تمام' } });
    fireEvent.click(screen.getByRole('button', { name: 'إيموجي' }));
    // The panel is a lazy chunk: on a loaded machine its first import can take more than the default second.
    const heart = await screen.findByRole('button', { name: 'إدراج 😀' }, { timeout: 8000 });
    await act(async () => { fireEvent.click(heart); });
    await waitFor(() => expect(box.value).toBe('تمام😀'));
  });

  it('Enter sends, Shift+Enter does not', () => {
    const send = vi.fn();
    function H() {
      const [v, setV] = React.useState('أهلا');
      return <Composer value={v} onChange={setV} onSend={send} onSendFile={async () => true} sending={false} onRefuse={noop} />;
    }
    render(<H />);
    const box = screen.getByPlaceholderText('اكتب رسالة...');
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(send).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a picked photo waits above the box; «إرسال» sends it with the typed caption', async () => {
    const sendFile = vi.fn(async () => true);
    const URLx = globalThis.URL as unknown as { createObjectURL?: unknown; revokeObjectURL?: unknown };
    URLx.createObjectURL = () => 'blob:preview';
    URLx.revokeObjectURL = () => {};
    const { container } = render(<Harness onSendFile={sendFile} />);
    const input = container.querySelector('input[type="file"][accept^="image/"]') as HTMLInputElement;
    const file = new File([new Uint8Array([0xff, 0xd8, 0xff])], 'a.jpg', { type: 'image/jpeg' });
    fireEvent.change(input, { target: { files: [file] } });
    expect(await screen.findByText('a.jpg')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('أضف تعليقاً...'), { target: { value: 'المقاس L' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'إرسال' })); });
    expect(sendFile).toHaveBeenCalledWith(file, 'image', 'المقاس L');
  });

  it('a photo over 5 MB is refused before it is sent', () => {
    const refuse = vi.fn();
    const { container } = render(<Harness onRefuse={refuse} />);
    const input = container.querySelector('input[type="file"][accept^="image/"]') as HTMLInputElement;
    const big = new File([new Uint8Array(1)], 'big.jpg', { type: 'image/jpeg' });
    Object.defineProperty(big, 'size', { value: 6 * 1024 * 1024 });
    fireEvent.change(input, { target: { files: [big] } });
    expect(refuse).toHaveBeenCalledWith(expect.stringMatching(/الحد المسموح/));
    expect(screen.queryByText('big.jpg')).toBeNull();
  });
});

describe('chat-model', () => {
  it('initials from a name, or the last two digits of a number', () => {
    expect(initials('سارة أحمد', '0790')).toBe('سأ');
    expect(initials(null, '962790000012')).toBe('12');
  });

  it('a poll merges by id: a moved tick replaces, a new message is added in time order', () => {
    const a = msg({ id: 'a', status: 'SENT', createdAt: '2026-11-26T09:00:00.000Z' });
    const out = mergeMessages([a], [msg({ id: 'a', status: 'READ', createdAt: a.createdAt }), msg({ id: 'b', createdAt: '2026-11-26T08:00:00.000Z' })]);
    expect(out.map((m) => m.id)).toEqual(['b', 'a']);
    expect(out[1].status).toBe('READ');
  });

  it('the newest change is what the next poll asks from', () => {
    expect(latestStamp([msg({ updatedAt: '2026-11-26T09:00:00.000Z' }), msg({ id: 'x', updatedAt: '2026-11-26T10:00:00.000Z' })])).toBe('2026-11-26T10:00:00.000Z');
  });

  it('reactions: one per side, the latest wins, an empty one removes', () => {
    const r = reactionsByTarget([
      msg({ id: '1', messageType: 'REACTION', text: '👍', reactionToId: 't', createdAt: '2026-11-26T09:00:00.000Z' }),
      msg({ id: '2', messageType: 'REACTION', text: '❤️', reactionToId: 't', createdAt: '2026-11-26T09:01:00.000Z' }),
      msg({ id: '3', direction: 'OUTBOUND', messageType: 'REACTION', text: '🙏', reactionToId: 't', createdAt: '2026-11-26T09:02:00.000Z' }),
      msg({ id: '4', direction: 'OUTBOUND', messageType: 'REACTION', text: null, reactionToId: 't', createdAt: '2026-11-26T09:03:00.000Z' }),
    ]);
    expect(r.get('t')).toEqual([{ emoji: '❤️', mine: false }]);
  });

  it('days and list times read as people say them', () => {
    const now = new Date('2026-11-26T12:00:00');
    expect(dayLabel('2026-11-26T08:00:00', now)).toBe('اليوم');
    expect(dayLabel('2026-11-25T08:00:00', now)).toBe('أمس');
    expect(listTime('2026-11-25T08:00:00', now)).toBe('أمس');
    expect(listTime('2026-11-26T08:05:00', now)).toBe('08:05');
  });
});
