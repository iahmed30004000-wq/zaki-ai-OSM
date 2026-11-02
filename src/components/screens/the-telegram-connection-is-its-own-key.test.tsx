// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * THE SCREENS OF T-09 (3/11): the day's work and the wire are two keys, and each screen draws only what its key opens.
 *
 *   · «طلبات تلجرام» — the row buttons answer to `telegram.manage` as before; the «الإعدادات» link to the connection card
 *     is drawn only for `telegram.connect` (a link to a page that would refuse is not drawn);
 *   · the Telegram card of «الربط» — the webhook button and the group bindings' buttons answer to `telegram.connect`; a
 *     holder of `telegram.manage` alone gets no button the door would refuse.
 */

const { api, screenApi, user } = vi.hoisted(() => ({
  api: vi.fn(),
  screenApi: vi.fn(),
  user: { current: {} as Record<string, unknown> },
}));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a) }));
vi.mock('@/lib/screen-api', () => ({ screenApi: (...a: unknown[]) => screenApi(...a), qs: () => '' }));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ currentUser: user.current, t: {}, locale: 'ar' }) }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ done: vi.fn(), failed: vi.fn(), warn: vi.fn() }) }));
vi.mock('@/components/ui/Confirm', () => ({ useConfirm: () => vi.fn(async () => true) }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/growth/telegram/orders',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/components/settings/TelegramSourcesCard', () => ({
  TelegramSourcesCard: ({ canManage }: { canManage: boolean }) => <p>{canManage ? 'المجموعات: تعديل' : 'المجموعات: قراءة'}</p>,
}));

import { TelegramOrdersScreen } from './TelegramOrdersScreen';
import { TelegramSettingsScreen } from './TelegramSettingsScreen';

const MESSAGE = {
  id: 'm1',
  chatId: '-1001',
  threadId: null,
  threadName: null,
  senderName: 'أبو أحمد',
  text: 'مرحبا',
  processingStatus: 'FAILED',
  reviewReason: null,
  pageName: null,
  createdAt: '2026-11-03T08:00:00.000Z',
  source: { chatTitle: 'طلبات الصفحة', topicName: null },
  order: null,
  reading: { claimed: false },
  twin: null,
};

const DAILY = { id: 'u1', role: 'MODERATOR', status: 'ACTIVE', permissions: ['telegram.view', 'telegram.manage'] };
const CONNECT = { ...DAILY, permissions: ['telegram.view', 'telegram.manage', 'telegram.connect'] };

beforeEach(() => {
  vi.clearAllMocks();
  api.mockImplementation(async (url: string) => {
    if (url === '/api/telegram/status') return { botConfigured: true, botApiOk: true };
    return { messages: [MESSAGE], pagination: { total: 1, page: 1, limit: 25, totalPages: 1 }, facts: { review: 1, orders: 0, ignored: 0, all: 1 } };
  });
  screenApi.mockResolvedValue({
    botConfigured: true, botApiOk: true, webhookSecretConfigured: true, appUrlConfigured: true,
    botUsername: 'zaki_bot', webhookUrl: 'https://x.test/api/webhooks/telegram', telegramWebhookSet: true,
  });
});
afterEach(cleanup);

describe('«طلبات تلجرام»', () => {
  it('the day\'s key keeps «إعادة المعالجة», and draws no link to the connection it cannot open', async () => {
    user.current = DAILY;
    render(<TelegramOrdersScreen />);
    await waitFor(() => expect(screen.getAllByRole('button', { name: /إعادة المعالجة/ }).length).toBeGreaterThan(0));
    expect(screen.queryByRole('link', { name: /الإعدادات/ })).toBeNull();
  });

  it('the connection key draws the link to the Telegram card', async () => {
    user.current = CONNECT;
    render(<TelegramOrdersScreen />);
    const link = await screen.findByRole('link', { name: /الإعدادات/ });
    expect(link.getAttribute('href')).toBe('/settings/links#telegram');
  });
});

describe('the Telegram card of «الربط»', () => {
  it('NEGATIVE: the day\'s key alone gets no webhook button and the bindings read-only', async () => {
    user.current = DAILY;
    render(<TelegramSettingsScreen embedded />);
    await screen.findByText('@zaki_bot');
    expect(screen.queryByRole('button', { name: /تسجيل \/ تحديث الويبهوك/ })).toBeNull();
    expect(screen.getByText('المجموعات: قراءة')).toBeTruthy();
  });

  it('the connection key gets the webhook button and the bindings\' buttons', async () => {
    user.current = CONNECT;
    render(<TelegramSettingsScreen embedded />);
    await screen.findByText('@zaki_bot');
    expect(screen.getByRole('button', { name: /تسجيل \/ تحديث الويبهوك/ })).toBeTruthy();
    expect(screen.getByText('المجموعات: تعديل')).toBeTruthy();
  });

  it('the card prints no secret: the status it shows is booleans and the public address', async () => {
    user.current = CONNECT;
    const { container } = render(<TelegramSettingsScreen embedded />);
    await screen.findByText('@zaki_bot');
    // The screen asks only the status door, which never carries the token (the door's own test proves that side).
    expect(screenApi.mock.calls.map((c) => c[0])).toEqual(['/api/telegram/status']);
    expect(container.textContent).not.toMatch(/\d{6,}:[A-Za-z0-9_-]{20,}/);
  });
});
