// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «تُرسَل من صفحات ذكي» ON THE CONVERSION'S LINE, AND THE OWNER'S «صفحات ذكي» CARD (2026-11-21)
 *
 *  · A conversion's line counts the orders Zaki Pages sends itself apart from the late ones: «تُرسَل من صفحات ذكي N»,
 *    and «متأخّر» only for what is really late. An older server (no `fromPages`) draws the line exactly as before.
 *  · The «صفحات ذكي» card draws nothing unless the door answers (the owner); its secret field is empty when it opens
 *    and after a save, and a save sends the secret once.
 * ═══════════════════════════════════════════════════════════════════════
 */

vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ currentUser: { id: 'u1', role: 'STAFF', status: 'ACTIVE', permissions: ['settings.view', 'settings.tracking'] } }),
}));

import { CustomConversionsCard } from './CustomConversionsCard';
import { PagesLinkCard } from './PagesLinkCard';
import { ConfirmProvider } from '@/components/ui/Confirm';
import { ToastProvider } from '@/components/ui/Toast';

const PIXEL = {
  id: 'p1', platform: 'META', name: 'Main', pixelId: '123456789012345', enabled: true, scope: 'GLOBAL', createdAt: '',
  storeId: null, countryId: null, orderEvent: 'Purchase', sendViewContent: true, sendInitiateCheckout: false,
  capiTokenHint: '9f3a', capiTestCode: null, capiDatasetId: null,
};
const conversion = (stats: Record<string, unknown>) => ({
  id: 'c1', name: 'تأكيد', eventName: 'OrderConfirmed', trigger: 'order.confirmed', valueSource: 'ORDER_TOTAL', enabled: true,
  pixel: { id: 'p1', name: 'Main', pixelId: '123456789012345', capiTokenHint: '9f3a' },
  stats: { sent: 4, pending: 0, failed: 0, skipped: 0, matchQuality: null, ...stats },
});
const OPTIONS = { triggers: [{ value: 'order.confirmed', label: 'تأكّد الطلب', hint: 'ت', suggested: 'OrderConfirmed' }], valueSources: [{ value: 'ORDER_TOTAL', label: 'قيمة الطلب' }] };
const LINK = { configured: true, url: 'https://pages.example.test/webhooks/oms', secretSet: true, enabled: true, deliveries: { pending: 1, ok: 5, failed: 0 }, lastFailure: null };

const state = { conversions: [] as unknown[], linkStatus: 200 };
let calls: { url: string; init?: RequestInit }[] = [];

beforeEach(() => {
  state.conversions = [];
  state.linkStatus = 200;
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === '/api/settings/tracking-pixels') return { ok: true, status: 200, json: async () => ({ pixels: [PIXEL] }) };
      if (url === '/api/settings/conversions') return { ok: true, status: 200, json: async () => ({ conversions: state.conversions, options: OPTIONS }) };
      if (url === '/api/settings/pages-link') {
        const ok = state.linkStatus === 200;
        return { ok, status: state.linkStatus, json: async () => (ok ? LINK : { error: 'x' }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    })
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const wrap = (node: React.ReactNode) => render(<ToastProvider><ConfirmProvider>{node}</ConfirmProvider></ToastProvider>);

describe('the conversion’s line', () => {
  it('«تُرسَل من صفحات ذكي 3», and «متأخّر» only for the really late one', async () => {
    state.conversions = [conversion({ skipped: 4, fromPages: 3 })];
    wrap(<CustomConversionsCard />);
    const line = await screen.findByTestId('cc-from-pages');
    expect(line.textContent).toBe('تُرسَل من صفحات ذكي 3');
    expect(screen.getByText('متأخّر 1')).toBeTruthy();
  });

  it('every skipped one sent by Pages: no «متأخّر» at all', async () => {
    state.conversions = [conversion({ skipped: 2, fromPages: 2 })];
    wrap(<CustomConversionsCard />);
    await screen.findByTestId('cc-from-pages');
    expect(screen.queryByText(/متأخّر/)).toBeNull();
  });

  it('NEGATIVE: none from Pages — the line is as before (an older server sends no `fromPages`)', async () => {
    state.conversions = [conversion({ skipped: 2 })];
    wrap(<CustomConversionsCard />);
    await screen.findByText('متأخّر 2');
    expect(screen.queryByTestId('cc-from-pages')).toBeNull();
  });
});

describe('the «صفحات ذكي» card', () => {
  it('draws nothing for anybody the door refuses', async () => {
    state.linkStatus = 403;
    const { container } = wrap(<PagesLinkCard />);
    await act(async () => {});
    expect(calls.some((c) => c.url === '/api/settings/pages-link')).toBe(true);
    expect(container.textContent).toBe('');
  });

  it('for the owner: the address, an EMPTY secret field, the delivery counts — and a save sends the secret once, then empties it', async () => {
    wrap(<PagesLinkCard />);
    await screen.findByText('صفحات ذكي');
    const secret = document.querySelector('input[type="password"]') as HTMLInputElement;
    expect(secret.value).toBe('');
    expect(screen.getByDisplayValue(LINK.url)).toBeTruthy();
    expect(screen.getByText('بالانتظار 1')).toBeTruthy();
    fireEvent.change(secret, { target: { value: 'pages-shared-secret-0123456789' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    });
    const sent = calls.filter((c) => c.url === '/api/settings/pages-link' && c.init?.method === 'PUT');
    expect(sent).toHaveLength(1);
    expect(JSON.parse(String(sent[0].init?.body))).toEqual({ url: LINK.url, secret: 'pages-shared-secret-0123456789' });
    expect((document.querySelector('input[type="password"]') as HTMLInputElement).value).toBe('');
  });
});
