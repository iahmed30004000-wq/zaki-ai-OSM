// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * THE INBOX AND META'S 24-HOUR WINDOW — and the rest of what a conversation now carries.
 *
 *  · window closed: no reply box; the reason in Arabic, and «إرسال القالب المعتمد» when a template is named — which posts to the
 *    conversation's template door and nothing else;
 *  · no template named: the reason and who names it, no press;
 *  · the list shows each conversation's last message with its kind (a photo, a voice note) and the unread count;
 *  · a draft typed in one conversation is still there after visiting another.
 */

const USER = { current: { id: 'u1', role: 'MODERATOR', permissions: ['whatsapp.view', 'whatsapp.send'] } };
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ currentUser: USER.current }) }));
vi.mock('@/components/shell/ScreenGuide', () => ({ GuideButton: () => null }));
vi.mock('@/hooks/useLiveRefresh', () => ({ useLiveRefresh: () => {} }));

type Call = { path: string; init?: RequestInit };
const calls: Call[] = [];
const C1 = { id: 'c1', customerPhone: '962790000001', customerName: 'سارة أحمد', status: 'OPEN', unreadCount: 2, lastMessageAt: new Date().toISOString(), lastMessagePreview: 'رسالة صوتية', lastMessageType: 'AUDIO' };
const C2 = { id: 'c2', customerPhone: '962790000002', customerName: 'ليلى', status: 'OPEN', unreadCount: 0, lastMessageAt: new Date().toISOString(), lastMessagePreview: 'صورة', lastMessageType: 'IMAGE' };
let window1 = { windowOpen: false, templateReady: true };

vi.mock('@/lib/screen-api', async (orig) => {
  const real = await orig<typeof import('@/lib/screen-api')>();
  return {
    ...real,
    screenApi: vi.fn(async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      if (path === '/api/whatsapp/connection') return { status: 'CONNECTED', connection: { id: 'k' } };
      if (path.startsWith('/api/whatsapp/conversations?')) return { conversations: [C1, C2] };
      if (path.endsWith('/template')) {
        return { message: { id: 't1', direction: 'OUTBOUND', messageType: 'TEMPLATE', text: 'قالب «order_follow_up»', status: 'SENT', createdAt: new Date().toISOString() } };
      }
      if (path.endsWith('/read')) return {};
      if (path.startsWith('/api/whatsapp/conversations/c1')) return { conversation: { ...C1, ...window1, unreadCount: 0 }, messages: [], recentOrders: [] };
      if (path.startsWith('/api/whatsapp/conversations/c2')) return { conversation: { ...C2, windowOpen: true }, messages: [], recentOrders: [] };
      return {};
    }),
  };
});

import { WhatsAppInboxScreen } from './WhatsAppInboxScreen';

beforeEach(() => {
  calls.length = 0;
  window1 = { windowOpen: false, templateReady: true };
  window.sessionStorage.clear();
});
afterEach(cleanup);

/** The list row of that conversation (the name also shows in the open thread's head and the customer panel). */
const open = async (name: string) => {
  const all = await screen.findAllByText(name);
  const row = all.map((el) => el.closest('button')).find(Boolean)!;
  fireEvent.click(row);
};

describe('the 24-hour window', () => {
  it('closed with a template named: no reply box, the reason, and the template press posts to its door', async () => {
    render(<WhatsAppInboxScreen />);
    await open('سارة أحمد');
    await screen.findByRole('button', { name: 'إرسال القالب المعتمد' });
    expect(screen.queryByPlaceholderText('اكتب رسالة...')).toBeNull();
    expect(screen.getAllByText(/مرّ أكثر من 24 ساعة/).length).toBeGreaterThan(0);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'إرسال القالب المعتمد' })); });
    const post = calls.find((c) => c.path === '/api/whatsapp/conversations/c1/template');
    expect(post?.init?.method).toBe('POST');
    expect(post?.init?.body).toBeUndefined();
  });

  it('closed with no template named: the reason and who names it, no press', async () => {
    window1 = { windowOpen: false, templateReady: false };
    render(<WhatsAppInboxScreen />);
    await open('سارة أحمد');
    await screen.findByText(/لا قالب مسمّى بعد/);
    expect(screen.queryByRole('button', { name: 'إرسال القالب المعتمد' })).toBeNull();
  });

  it('open: the reply box with its emoji, photo and file presses', async () => {
    window1 = { windowOpen: true, templateReady: false };
    render(<WhatsAppInboxScreen />);
    await open('سارة أحمد');
    await screen.findByPlaceholderText('اكتب رسالة...');
    for (const name of ['إيموجي', 'إرفاق صورة', 'إرفاق ملف', 'إرسال']) expect(screen.getByRole('button', { name })).toBeTruthy();
  });
});

describe('the list', () => {
  it('each row: initials, the last message with its kind, the unread count', async () => {
    render(<WhatsAppInboxScreen />);
    await screen.findByText('سارة أحمد');
    expect(screen.getByText('سأ')).toBeTruthy();
    expect(screen.getByText('رسالة صوتية')).toBeTruthy();
    expect(screen.getByLabelText('2 غير مقروءة')).toBeTruthy();
  });

  it('a draft is kept per conversation', async () => {
    window1 = { windowOpen: true, templateReady: false };
    render(<WhatsAppInboxScreen />);
    await open('سارة أحمد');
    fireEvent.change(await screen.findByPlaceholderText('اكتب رسالة...'), { target: { value: 'مسودة لسارة' } });
    await open('ليلى');
    await waitFor(() => expect((screen.getByPlaceholderText('اكتب رسالة...') as HTMLTextAreaElement).value).toBe(''));
    await open('سارة أحمد');
    await waitFor(() => expect((screen.getByPlaceholderText('اكتب رسالة...') as HTMLTextAreaElement).value).toBe('مسودة لسارة'));
  });
});
