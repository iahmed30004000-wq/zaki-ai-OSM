// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * The tracking panel: every platform on one panel, Google a real one, and
 * the scope of each pixel visible and changeable.
 *
 * The three tabs this replaced are asserted GONE — the settings copy of the
 * landing-page numbers, the custom-script box that never ran, the webhook
 * card, the purchase settings and the Google boxes nothing read — because
 * the failure worth catching is one of them coming back.
 */

const { can } = vi.hoisted(() => ({ can: { edit: true } }));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ currentUser: { id: 'u1' } }) }));
vi.mock('@/lib/can', () => ({ userCan: (_u: unknown, key: string) => key === 'settings.tracking' && can.edit }));

import { TrackingPixelsSection } from '@/components/settings/TrackingPixelsSection';

const pixelsFixture = [
  { id: 'p1', platform: 'META', name: 'Main', pixelId: '123456789012345', enabled: true, scope: 'GLOBAL', createdAt: '' },
  { id: 'p2', platform: 'META', name: 'Second', pixelId: '222222222222222', enabled: false, scope: 'LANDING_PAGES', createdAt: '' },
  { id: 'p3', platform: 'TIKTOK', name: 'TT', pixelId: 'TIKTOK123456', enabled: true, scope: 'PUBLIC', createdAt: '' },
  { id: 'p4', platform: 'GOOGLE', name: 'GA', pixelId: 'G-ABC1234567', enabled: true, scope: 'GLOBAL', createdAt: '' },
];

let calls: { url: string; init?: RequestInit }[] = [];

function mockFetch() {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === '/api/settings/tracking-pixels' && (!init || !init.method || init.method === 'GET')) {
        return { ok: true, status: 200, json: async () => ({ pixels: pixelsFixture }) };
      }
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    })
  );
}

beforeEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  can.edit = true;
  mockFetch();
});

const rows = () => screen.queryAllByTestId('pixel-row');

describe('one panel, four platforms', () => {
  it('shows Meta first, with both of its pixels', async () => {
    render(<TrackingPixelsSection />);
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(screen.getByText('123456789012345')).toBeTruthy();
    expect(screen.getByText('222222222222222')).toBeTruthy();
  });

  it('offers Google as a platform of its own, with its tag listed', async () => {
    render(<TrackingPixelsSection />);
    await waitFor(() => expect(rows()).toHaveLength(2));
    fireEvent.click(screen.getByTestId('platform-GOOGLE'));
    expect(rows()).toHaveLength(1);
    expect(screen.getByText('G-ABC1234567')).toBeTruthy();
  });

  it('none of the removed tabs or boxes is on the screen', async () => {
    const { container } = render(<TrackingPixelsSection />);
    await waitFor(() => expect(rows()).toHaveLength(2));
    const text = container.textContent ?? '';
    for (const gone of ['تحليلات جافا سكريبت', 'وحدات بكسل', 'أداء صفحات الهبوط', 'إعدادات الشراء', 'Google analytics', 'Webhook']) {
      expect(text).not.toContain(gone);
    }
    // And it never reads the old settings blob.
    expect(calls.some((c) => c.url === '/api/settings')).toBe(false);
  });
});

describe('scope — where each pixel runs', () => {
  it('shows each pixel\'s scope, a PUBLIC row reading as "every selling page"', async () => {
    render(<TrackingPixelsSection />);
    await waitFor(() => expect(rows()).toHaveLength(2));
    const selects = screen.getAllByLabelText('أين يعمل') as HTMLSelectElement[];
    expect(selects[0].value).toBe('GLOBAL');
    expect(selects[1].value).toBe('LANDING_PAGES');
    fireEvent.click(screen.getByTestId('platform-TIKTOK'));
    expect((screen.getAllByLabelText('أين يعمل')[0] as HTMLSelectElement).value).toBe('GLOBAL');
  });

  it('changing it saves that pixel\'s scope', async () => {
    render(<TrackingPixelsSection />);
    await waitFor(() => expect(rows()).toHaveLength(2));
    fireEvent.change(screen.getAllByLabelText('أين يعمل')[0], { target: { value: 'LANDING_PAGES' } });
    await waitFor(() => expect(calls.some((c) => c.url === '/api/settings/tracking-pixels/p1')).toBe(true));
    const patch = calls.find((c) => c.url === '/api/settings/tracking-pixels/p1')!;
    expect(patch.init?.method).toBe('PATCH');
    expect(JSON.parse(String(patch.init?.body))).toEqual({ scope: 'LANDING_PAGES' });
  });
});

describe('adding', () => {
  it('refuses a malformed id before it reaches the server', async () => {
    render(<TrackingPixelsSection />);
    await waitFor(() => expect(rows()).toHaveLength(2));
    fireEvent.click(screen.getByTestId('platform-GOOGLE'));
    fireEvent.change(screen.getByLabelText('رقم بكسل Google'), { target: { value: 'GTM-ABC123' } });
    fireEvent.submit(screen.getByLabelText('رقم بكسل Google').closest('form')!);
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('G-XXXXXXXXXX'));
    expect(calls.some((c) => c.init?.method === 'POST')).toBe(false);
  });

  it('adds a Google tag with the chosen scope', async () => {
    render(<TrackingPixelsSection />);
    await waitFor(() => expect(rows()).toHaveLength(2));
    fireEvent.click(screen.getByTestId('platform-GOOGLE'));
    fireEvent.change(screen.getByLabelText('رقم بكسل Google'), { target: { value: 'aw-123456789' } });
    const form = screen.getByLabelText('رقم بكسل Google').closest('form')!;
    fireEvent.change(form.querySelector('select')!, { target: { value: 'LANDING_PAGES' } });
    fireEvent.submit(form);
    await waitFor(() => expect(calls.some((c) => c.init?.method === 'POST')).toBe(true));
    const body = JSON.parse(String(calls.find((c) => c.init?.method === 'POST')!.init?.body));
    expect(body).toMatchObject({ platform: 'GOOGLE', pixelId: 'AW-123456789', scope: 'LANDING_PAGES', enabled: true });
  });
});

describe('without the edit permission', () => {
  it('shows the pixels read-only: no add form, no actions, scope not changeable', async () => {
    can.edit = false;
    render(<TrackingPixelsSection />);
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(screen.queryByText('أضف')).toBeNull();
    expect(screen.queryByText('تعطيل')).toBeNull();
    for (const s of screen.getAllByLabelText('أين يعمل')) expect((s as HTMLSelectElement).disabled).toBe(true);
  });
});
