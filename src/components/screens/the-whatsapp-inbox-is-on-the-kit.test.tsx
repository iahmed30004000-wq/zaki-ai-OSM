// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@/lib/guard-source';

/**
 * «صندوق الواتساب» ON THE KIT (R10e, 18/11).
 *
 * What it pins:
 *  1. The presses are the kit's: «إرسال» is a primary `IconButton`, «مفتوحة / مغلقة» is one `Segmented`,
 *     closing / reopening and the two «إعادة» presses are `Button`s — and each still reaches the handler it reached.
 *     The conversation row stays a whole-row press, the only hand-written `<button` left.
 *  2. The three panes and the two page-level notices are the kit's `Card`; no hand-drawn surface is left.
 *  3. The title is `PageShell`'s, from the registry, at full width.
 *  4. At a phone's width one pane shows at a time, and the reply box is a row that can shrink.
 *  5. Nothing new is sent, and the phone shows only where it showed before.
 */

const USER: { current: { id: string; role: string; permissions: string[] } } = {
  current: { id: 'u1', role: 'MODERATOR', permissions: ['whatsapp.view', 'whatsapp.send'] },
};
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ currentUser: USER.current }) }));
vi.mock('@/components/shell/ScreenGuide', () => ({ GuideButton: () => null }));
vi.mock('@/hooks/useLiveRefresh', () => ({ useLiveRefresh: () => {} }));

type Call = { path: string; init?: RequestInit };
const calls: Call[] = [];
const CONV = {
  id: 'c1',
  customerPhone: '0900000001',
  customerName: 'زبون تجريبي',
  status: 'OPEN',
  unreadCount: 0,
  lastMessageAt: null,
  lastMessagePreview: 'مرحبا',
};
let convStatus = 'OPEN';
vi.mock('@/lib/screen-api', async (orig) => {
  const real = await orig<typeof import('@/lib/screen-api')>();
  return {
    ...real,
    screenApi: vi.fn(async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      if (path === '/api/whatsapp/connection') return { status: 'CONNECTED', connection: { id: 'k' } };
      if (path.startsWith('/api/whatsapp/conversations?')) return { conversations: [{ ...CONV, status: convStatus }] };
      if (path.endsWith('/messages')) return { message: { id: 'm9', direction: 'OUTBOUND', messageType: 'TEXT', text: 'أهلا', status: 'SENT', createdAt: new Date().toISOString() } };
      if (path.startsWith('/api/whatsapp/conversations/c1') && init?.method === 'PATCH') return {};
      if (path.startsWith('/api/whatsapp/conversations/c1')) {
        return { conversation: { ...CONV, status: convStatus }, messages: [], recentOrders: [] };
      }
      return {};
    }),
  };
});

import { WhatsAppInboxScreen } from './WhatsAppInboxScreen';

const SRC = stripComments(readFileSync(join(process.cwd(), 'src/components/screens/WhatsAppInboxScreen.tsx'), 'utf8'));

beforeEach(() => {
  calls.length = 0;
  convStatus = 'OPEN';
  USER.current = { id: 'u1', role: 'MODERATOR', permissions: ['whatsapp.view', 'whatsapp.send'] };
});
afterEach(cleanup);

async function openInbox() {
  render(<WhatsAppInboxScreen />);
  await screen.findByText('زبون تجريبي');
}
async function openConversation() {
  await openInbox();
  fireEvent.click(screen.getByText('زبون تجريبي').closest('button')!);
  await screen.findByPlaceholderText('اكتب رسالة...');
}
const panes = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('.zk-card')];

describe('1 · the presses are the kit’s, and reach the same handlers', () => {
  it('«مفتوحة / مغلقة» is one radio group with two choices, and choosing «مغلقة» sets the filter', async () => {
    await openInbox();
    const group = screen.getByRole('radiogroup', { name: 'حالة المحادثات' });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((r) => r.textContent)).toEqual(['مفتوحة', 'مغلقة']);
    expect(radios[0].getAttribute('aria-checked')).toBe('true');
    fireEvent.click(radios[1]);
    await waitFor(() => expect(radios[1].getAttribute('aria-checked')).toBe('true'));
    expect(radios[0].getAttribute('aria-checked')).toBe('false');
    // As before R10e the list is asked again by the next poll or by Enter in the search box, now with the closed ones.
    fireEvent.keyDown(screen.getByPlaceholderText('بحث برقم أو اسم...'), { key: 'Enter' });
    await waitFor(() => expect(calls.some((c) => c.path === '/api/whatsapp/conversations?status=CLOSED')).toBe(true));
  });

  it('«إرسال» is a named primary press, and it posts the typed text to the open conversation', async () => {
    await openConversation();
    const send = screen.getByRole('button', { name: 'إرسال' });
    expect(send.className).toContain('bg-[var(--sys-primary)]');
    fireEvent.change(screen.getByPlaceholderText('اكتب رسالة...'), { target: { value: '  أهلا  ' } });
    await act(async () => { fireEvent.click(send); });
    const post = calls.find((c) => c.path === '/api/whatsapp/conversations/c1/messages');
    expect(post?.init?.method).toBe('POST');
    expect(post?.init?.body).toBe(JSON.stringify({ text: 'أهلا' }));
  });

  it('and an empty reply box cannot be sent — the press is off and nothing is posted', async () => {
    await openConversation();
    const send = screen.getByRole('button', { name: 'إرسال' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText('اكتب رسالة...'), { target: { value: '   ' } });
    expect(send.disabled).toBe(true);
    await act(async () => { fireEvent.click(send); });
    expect(calls.some((c) => c.path.endsWith('/messages'))).toBe(false);
  });

  it('«إغلاق المحادثة» is a kit button and closes the open conversation', async () => {
    await openConversation();
    const close = screen.getByRole('button', { name: 'إغلاق المحادثة' });
    expect(close.className).toContain('rounded-lg');
    await act(async () => { fireEvent.click(close); });
    const patch = calls.find((c) => c.init?.method === 'PATCH');
    expect(patch?.path).toBe('/api/whatsapp/conversations/c1');
    expect(patch?.init?.body).toBe(JSON.stringify({ status: 'CLOSED' }));
  });

  it('a closed conversation has no reply box and says why', async () => {
    convStatus = 'CLOSED';
    await openInbox();
    fireEvent.click(screen.getByText('زبون تجريبي').closest('button')!);
    await screen.findByText('المحادثة مغلقة — أعد فتحها للإرسال');
    expect(screen.queryByPlaceholderText('اكتب رسالة...')).toBeNull();
    expect(screen.queryByRole('button', { name: 'إرسال' })).toBeNull();
  });

  it('without the send key there is no reply box at all', async () => {
    USER.current = { ...USER.current, permissions: ['whatsapp.view'] };
    await openInbox();
    fireEvent.click(screen.getByText('زبون تجريبي').closest('button')!);
    await screen.findByText('ليس لديك صلاحية لإرسال الرسائل');
    expect(screen.queryByRole('button', { name: 'إرسال' })).toBeNull();
  });

  it('the way back to the list on a phone is a named press', async () => {
    await openConversation();
    expect(screen.getByRole('button', { name: 'عد إلى المحادثات' }).className).toContain('lg:hidden');
  });
});

describe('2 · surfaces and the hand-written presses that are left', () => {
  it('the three panes are the kit’s card', async () => {
    const { container } = render(<WhatsAppInboxScreen />);
    await screen.findByText('زبون تجريبي');
    expect(panes(container)).toHaveLength(3);
  });

  it('the source draws no surface by hand, and its one raw `<button` is the conversation row', () => {
    expect(SRC).not.toMatch(/bg-\[var\(--sys-card\)\] rounded-lg border/);
    const raw = SRC.match(/<button[\s>]/g) ?? [];
    expect(raw).toHaveLength(1);
    expect(SRC).toMatch(/<button key=\{c\.id\} onClick=\{\(\) => selectConversation\(c\)\}/);
  });

  it('without the view key the page is the notice card alone, and nothing is asked of the server', () => {
    USER.current = { ...USER.current, permissions: [] };
    const { container } = render(<WhatsAppInboxScreen />);
    expect(screen.getByText('ليس لديك صلاحية لعرض واتساب')).toBeTruthy();
    expect(panes(container)).toHaveLength(1);
    expect(calls).toEqual([]);
  });
});

describe('3 · the title', () => {
  it('is PageShell’s, from the registry, at full width', async () => {
    await openInbox();
    expect(SRC).toMatch(/<PageShell[\s\S]*?title=\{routeLabel\('\/growth\/whatsapp\/inbox'\)\}[\s\S]*?width="full"/);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('صندوق الواتساب');
  });
});

describe('4 · a phone’s width: one pane, and a reply box that fits', () => {
  beforeEach(() => { Object.defineProperty(window, 'innerWidth', { value: 375, configurable: true }); });

  it('the list shows and the conversation hides until one is chosen — then the other way round', async () => {
    const { container } = render(<WhatsAppInboxScreen />);
    await screen.findByText('زبون تجريبي');
    const [list, chat, customer] = panes(container);
    expect(list.className).not.toMatch(/(^|\s)hidden(\s|$)/);
    expect(chat.className).toMatch(/(^|\s)hidden(\s|$)/);
    expect(customer.className).toMatch(/(^|\s)hidden(\s|$)/);
    fireEvent.click(screen.getByText('زبون تجريبي').closest('button')!);
    await screen.findByPlaceholderText('اكتب رسالة...');
    expect(list.className).toMatch(/(^|\s)hidden(\s|$)/);
    expect(chat.className).not.toMatch(/(^|\s)hidden(\s|$)/);
  });

  it('the reply box grows and the press keeps its size; nothing on the screen is set wider than a phone', async () => {
    const { container } = render(<WhatsAppInboxScreen />);
    await screen.findByText('زبون تجريبي');
    fireEvent.click(screen.getByText('زبون تجريبي').closest('button')!);
    const box = await screen.findByPlaceholderText('اكتب رسالة...');
    expect(box.className).toContain('flex-1');
    expect(screen.getByRole('button', { name: 'إرسال' }).className).toContain('shrink-0');
    const wide = [...container.querySelectorAll<HTMLElement>('[class]')]
      .map((el) => el.getAttribute('class')!)
      .filter((c) => /(^|\s)(whitespace-nowrap|min-w-\[(3[89]\d|[4-9]\d\d)px\]|w-\[(3[89]\d|[4-9]\d\d)px\])/.test(c));
    expect(wide).toEqual([]);
  });
});

describe('5 · nothing new is sent, and the phone is where it was', () => {
  it('the screen calls only the inbox’s own addresses', async () => {
    await openConversation();
    for (const c of calls) expect(c.path.startsWith('/api/whatsapp/'), c.path).toBe(true);
  });

  it('the phone number shows in the same two places as before: the conversation head and the customer panel', async () => {
    await openConversation();
    // the head of the conversation and the customer panel: the same two places as before R10e
    expect(screen.getAllByText((_, el) => el?.tagName === 'P' && (el.textContent ?? '').trim() === CONV.customerPhone)).toHaveLength(2);
  });
});
